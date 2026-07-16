"use client";

/**
 * /warroom — ⚔ 場中ウォールーム
 *
 * デイトレ中の戦闘画面。今日トレードする銘柄だけを絞って:
 *   - 現在値 / 板圧 / VWAP乖離 / 値位置 / 成行偏り → 場中評決
 *   - 15秒自動更新 (場が閉まっている時間は自動停止)
 *   - デスクトップ通知: 急変 / 板圧反転 / VWAPクロス / 新高値・新安値
 *
 * ブラウザを開いている間だけ動く設計 (Vercel は場中プッシュ不可のため)。
 * 板情報は立花 API = 日本株のみ。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { NIKKEI225 } from "@/lib/nikkei225";
import { STOCK_LIST } from "@/lib/stock-list";
import { addTrade, computeTradePnl, TRADE_REASON_TAGS } from "@/lib/firestore";
import { syncRakutenMail } from "@/lib/rakuten-sync";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };
const LS_WATCHLIST = "cavka_warroom_watchlist";
const LS_POSITIONS = "cavka_warroom_positions";
const LS_PINNED = "cavka_warroom_pinned";       // 日次リセットで残す固定銘柄
const LS_LAST_RESET = "cavka_warroom_last_reset"; // 最終リセット日 (JST YYYY-MM-DD)

/** JST の当日キー (リセット判定用) */
function jstDayKey(): string {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
}
const POLL_MS = 15_000;
const NEAR_PCT = 0.3;  // ライン接近警告のしきい (%)

const NAME_MAP = new Map<string, string>([
  ...NIKKEI225.map((s) => [s.ticker, s.name] as const),
  ...STOCK_LIST.filter((s) => s.market === "JP").map((s) => [s.ticker, s.name] as const),
]);

/** 建玉 (1 ticker 1 ポジション、デイトレ簡略化) */
interface Position {
  ticker: string;
  side: "long" | "short";
  qty: number;
  entryPrice: number;
  entryAt: string;          // ISO
  stopLoss: number | null;
  takeProfit: number | null;
  source?: "manual" | "mail";  // mail = 楽天約定メールから自動投入 (損切り/利確は未設定で残す)
}

/** long は entry→上が利、short は entry→下が利 */
function posPnl(p: Position, price: number): { pnl: number; pnlPct: number } {
  const diff = p.side === "long" ? price - p.entryPrice : p.entryPrice - price;
  return {
    pnl: Math.round(diff * p.qty),
    pnlPct: p.entryPrice > 0 ? Math.round((diff / p.entryPrice) * 10000) / 100 : 0,
  };
}

interface IntradaySignal {
  id: string;
  label: string;
  direction: 1 | 0 | -1;
  detail: string;
  weight: number;
}

interface Entry {
  ticker: string;
  price: number | null;
  priceTime: string | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  vwap: number | null;
  volume: number | null;
  turnover: number | null;
  boardRatio: number | null;
  vwapDev: number | null;
  rangePos: number | null;
  gapPct: number | null;
  marketOrderRatio: number | null;
  stance: "bull" | "bear" | "neutral" | "contested";
  score: number;
  signals: IntradaySignal[];
}

/* 色言語 (日本式に統一):
   上昇・買い = 赤ピンク UP / 下落・売り = シアン DOWN / 純赤 = 危険専用 (損切り・警告) */
const UP = "var(--color-up)";      // #ff3b6b 系
const DOWN = "var(--color-down)";  // #00d9ff 系
const DANGER = "#ef4444";

const STANCE_META: Record<Entry["stance"], { label: string; color: string; emoji: string }> = {
  bull: { label: "買い圧優勢", color: "#ff3b6b", emoji: "🔺" },
  bear: { label: "売り圧優勢", color: "#00d9ff", emoji: "🔻" },
  neutral: { label: "拮抗", color: "#facc15", emoji: "🟡" },
  contested: { label: "シグナル対立", color: "#a78bfa", emoji: "⚡" },
};

const HISTORY_LEN = 12; // 直近12回 = 約3分 (15秒 poll)

/**
 * 判断帯: 「買っていい / 待て / 触るな」を1行で言い切る。
 * スタンスの安定度 (直近履歴の一貫性) + VWAP乖離 + 値位置 から翻訳する。
 * 一瞬の🟢に飛びつかないための、実戦から生まれた翻訳レイヤー。
 */
type Advice = "go" | "wait_unstable" | "wait_overheated" | "wait_early" | "avoid";
interface Verdict {
  advice: Advice;
  label: string;
  color: string;
  streak: number;      // 同方向の連続回数
  stability: number;   // 0-100 直近の一貫性
  sample: number;      // 履歴数
}

/** JST 分。寄り直後ゲート判定用 */
function jstMins(): number {
  const now = new Date();
  const jst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60 * 1000);
  return jst.getHours() * 60 + jst.getMinutes();
}

function computeVerdict(e: Entry, hist: Entry["stance"][]): Verdict {
  const sample = hist.length;

  // ── 寄り直後ゲート: 9:05 までは何が出ていても「観察」で固定 ──
  // 寄り前気配は見せ玉込みで当てにならず、寄り直後は板が最も荒れる。
  // 実戦 (2026-07-07 JAL戦) の教訓: この時間の🟢に飛びつくと寄り天を食らう。
  const mins = jstMins();
  if (mins >= 8 * 60 && mins < 9 * 60 + 5) {
    let streak0 = 0;
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i] === e.stance) streak0++;
      else break;
    }
    const stability0 = sample > 0 ? Math.round((hist.filter((s) => s === e.stance).length / sample) * 100) : 0;
    return {
      advice: "wait_early",
      label: mins < 9 * 60 ? "⏳ 寄り前気配 — 参考値 (当てにしない)" : "⏳ 寄り直後 — 9:05まで観察",
      color: "#94a3b8",
      streak: streak0,
      stability: stability0,
      sample,
    };
  }
  // 連続回数 (末尾から同じスタンスが何回続くか)
  let streak = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i] === e.stance) streak++;
    else break;
  }
  // 安定度: 直近履歴で現スタンスが占める割合
  const stability = sample > 0 ? Math.round((hist.filter((s) => s === e.stance).length / sample) * 100) : 0;

  const strong = e.stance === "bull";
  const bad = e.stance === "bear";
  const contested = e.stance === "contested";

  // 触るな: 売り圧 or 対立
  if (bad) return { advice: "avoid", label: "🚫 手を出すな (売り圧)", color: "#00d9ff", streak, stability, sample };
  if (contested) return { advice: "avoid", label: "🚫 見送り (シグナル対立)", color: "#a78bfa", streak, stability, sample };

  // 買い方向だが... サンプル不足 or 不安定 → 待て
  if (sample < 4) return { advice: "wait_early", label: "👀 様子見 (データ集計中)", color: "#94a3b8", streak, stability, sample };
  if (strong && (streak < 3 || stability < 60)) {
    return { advice: "wait_unstable", label: `⚡ 不安定・まだ待て (🔺${streak}回・安定${stability}%)`, color: "#fbbf24", streak, stability, sample };
  }
  // 買い方向で安定 → 過熱チェック
  if (strong) {
    if (e.vwapDev !== null && e.vwapDev >= 1.5) {
      return { advice: "wait_overheated", label: `⚠ 過熱・飛びつき注意 (VWAP +${e.vwapDev.toFixed(1)}%)`, color: "#fb923c", streak, stability, sample };
    }
    // 理想: 安定した🟢 + VWAPほどよく上
    const pos = e.rangePos !== null ? Math.round(e.rangePos * 100) : null;
    const detail = [
      e.vwapDev !== null ? `VWAP ${e.vwapDev >= 0 ? "+" : ""}${e.vwapDev.toFixed(1)}%` : null,
      pos !== null ? `値位置${pos}%` : null,
      `🔺${streak}連`,
    ].filter(Boolean).join("・");
    return { advice: "go", label: `✅ 買い妙味 (${detail})`, color: "#ff3b6b", streak, stability, sample };
  }
  // neutral 安定
  return { advice: "wait_early", label: `🟡 方向待ち (拮抗が継続)`, color: "#facc15", streak, stability, sample };
}

/** JST の場中判定 (平日 08:55〜15:35) */
function isMarketHours(): boolean {
  const now = new Date();
  const jst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60 * 1000);
  const day = jst.getDay();
  if (day === 0 || day === 6) return false;
  const mins = jst.getHours() * 60 + jst.getMinutes();
  return mins >= 8 * 60 + 55 && mins <= 15 * 60 + 35;
}

function beep(freq = 880, dur = 0.15, vol = 0.08) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.value = vol;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  } catch {}
}

/** ライン到達などクリティカルな警報: 低音を3連打 */
function alarm() {
  beep(440, 0.18, 0.12);
  setTimeout(() => beep(440, 0.18, 0.12), 220);
  setTimeout(() => beep(440, 0.25, 0.12), 440);
}

function notify(title: string, body: string, critical = false) {
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification(title, { body, icon: "/favicon.ico", requireInteraction: critical });
  }
  if (critical) alarm();
  else beep();
}

export default function WarroomPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [forceRun, setForceRun] = useState(false);   // 場外でも動かす
  const [alertsOn, setAlertsOn] = useState(false);
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [pinned, setPinned] = useState<string[]>([]);
  const prevRef = useRef<Map<string, Entry>>(new Map());
  // ライン警報の多重発火防止 (ticker → 発火済みイベント集合)
  const firedRef = useRef<Map<string, Set<string>>>(new Map());
  // スタンス履歴 (ticker → 直近スタンス列)。安定度・連続回数の計算用
  const [stanceHist, setStanceHist] = useState<Record<string, Entry["stance"][]>>({});
  // 当日1分足ミニチャート (Yahoo、2分ごと更新 — 形を見る用。数字は立花が正)
  const [charts, setCharts] = useState<Record<string, number[]>>({});
  const marketOpen = isMarketHours();
  const running = (marketOpen || forceRun) && watchlist.length > 0;

  // 初回ロード: watchlist + 建玉 + 固定 を読み、日付が変わっていたら日次リセット。
  // リセットで残すのは「固定した銘柄」と「建玉がある銘柄」のみ (保有中の見失いを防ぐ)。
  useEffect(() => {
    try {
      const savedW: string[] = (() => { try { const a = JSON.parse(localStorage.getItem(LS_WATCHLIST) ?? "[]"); return Array.isArray(a) ? a.filter((t) => typeof t === "string") : []; } catch { return []; } })();
      const savedPos: Record<string, Position> = (() => { try { const o = JSON.parse(localStorage.getItem(LS_POSITIONS) ?? "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; } })();
      const savedPin: string[] = (() => { try { const a = JSON.parse(localStorage.getItem(LS_PINNED) ?? "[]"); return Array.isArray(a) ? a.filter((t) => typeof t === "string") : []; } catch { return []; } })();
      setPositions(savedPos);
      setPinned(savedPin);

      const today = jstDayKey();
      const lastReset = localStorage.getItem(LS_LAST_RESET);
      if (lastReset !== today) {
        // 日次リセット: 固定 ∪ 建玉あり だけ残す
        const keep = new Set<string>([...savedPin, ...Object.keys(savedPos)]);
        const next = savedW.filter((t) => keep.has(t));
        setWatchlist(next);
        try {
          localStorage.setItem(LS_WATCHLIST, JSON.stringify(next));
          localStorage.setItem(LS_LAST_RESET, today);
        } catch {}
      } else {
        setWatchlist(savedW);
      }
    } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem(LS_WATCHLIST, JSON.stringify(watchlist)); } catch {}
  }, [watchlist]);
  useEffect(() => {
    try { localStorage.setItem(LS_POSITIONS, JSON.stringify(positions)); } catch {}
  }, [positions]);
  useEffect(() => {
    try { localStorage.setItem(LS_PINNED, JSON.stringify(pinned)); } catch {}
  }, [pinned]);

  const togglePin = (t: string) =>
    setPinned((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const savePosition = (p: Position) => {
    setPositions((prev) => ({ ...prev, [p.ticker]: p }));
    firedRef.current.delete(p.ticker); // ライン変更で警報リセット
  };
  const clearPosition = (ticker: string) => {
    setPositions((prev) => { const n = { ...prev }; delete n[ticker]; return n; });
    firedRef.current.delete(ticker);
  };

  // ── 楽天約定メール → 建玉に自動投入 ──
  // 買った瞬間の建値・数量・side を自動で入れる (損切り/利確は手で足す)。
  // 定期実行 (場中5分ごと) + ページ開時 + 手動ボタン。
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const syncMail = useCallback(async (silent = false) => {
    if (!user || syncing) return;
    setSyncing(true);
    if (!silent) setSyncMsg("約定メールを確認中…");
    try {
      const r = await syncRakutenMail(user);
      if (!r.ok) { setSyncMsg(r.message); return; }

      // メール正味保有を建玉にマージ (現物=long)。既存の損切り/利確は温存。
      const mailTickers = new Set(r.holdings.map((h) => h.ticker));
      let added = 0;
      let removed = 0;
      setPositions((prev) => {
        const next = { ...prev };
        for (const h of r.holdings) {
          const ex = next[h.ticker];
          if (ex) {
            // 建値・数量を更新、損切り/利確・source は温存
            next[h.ticker] = {
              ...ex, side: "long", qty: h.shares, entryPrice: h.avgCost,
              source: ex.source ?? "mail",
            };
          } else {
            next[h.ticker] = {
              ticker: h.ticker, side: "long", qty: h.shares, entryPrice: h.avgCost,
              entryAt: `${h.lastDate}T09:00:00+09:00`, stopLoss: null, takeProfit: null,
              source: "mail",
            };
            added++;
          }
        }
        // メール由来で売り切った建玉は自動で外す (手動建玉は触らない)
        for (const t of Object.keys(next)) {
          if (next[t].source === "mail" && !mailTickers.has(t)) { delete next[t]; removed++; }
        }
        return next;
      });

      // 建玉のある銘柄を監視リストに追加 (未登録だとカードが出ない)
      if (r.holdings.length > 0) {
        setWatchlist((prev) => {
          const set = new Set(prev);
          for (const h of r.holdings) set.add(h.ticker);
          return Array.from(set);
        });
      }

      if (added > 0 || removed > 0) {
        setSyncMsg(`建玉を自動更新 (新規${added}${removed ? ` / 決済${removed}` : ""}) — 損切り/利確を設定してください`);
      } else if (!silent) {
        setSyncMsg(r.holdings.length > 0 ? "保有はすべて反映済みです" : "反映する保有はありません");
      } else {
        setSyncMsg(null);
      }
    } finally {
      setSyncing(false);
    }
  }, [user, syncing]);

  // ページ開時に一度 + 場中は5分ごとに自動同期
  const autoSyncedRef = useRef(false);
  useEffect(() => {
    if (!user) return;
    if (!autoSyncedRef.current) { autoSyncedRef.current = true; syncMail(true); }
    if (!marketOpen && !forceRun) return;
    const id = setInterval(() => syncMail(true), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [user, marketOpen, forceRun, syncMail]);

  // 決済してジャーナルに記録 (Firestore)。タグはその場で付ける (後回しは忘れる)
  const closeToJournal = async (p: Position, exitPrice: number, tags: string[] = []) => {
    if (user) {
      const { pnl, pnlPct } = computeTradePnl(p, exitPrice);
      try {
        await addTrade(user.uid, {
          ticker: p.ticker,
          name: NAME_MAP.get(p.ticker) ?? p.ticker,
          market: "JP",
          side: p.side,
          qty: p.qty,
          entryPrice: p.entryPrice,
          entryAt: p.entryAt,
          exitPrice,
          exitAt: new Date().toISOString(),
          status: "closed",
          pnl,
          pnlPct,
          reasonTags: tags,
          memo: "ウォールームから決済",
          source: "manual",
        });
      } catch (e) {
        console.error("journal write failed", e);
      }
    }
    clearPosition(p.ticker);
  };

  // ── 銘柄追加: コード or 企業名、サジェスト付き ──
  const [suggestions, setSuggestions] = useState<{ ticker: string; name: string }[]>([]);
  const searchTimer = useRef<number | null>(null);

  const addTickerDirect = (t: string) => {
    if (!/^\d{3,4}[A-Z]?$/.test(t)) { setError("日本株の証券コードを入力してください (板情報は日本株のみ)"); return; }
    if (!watchlist.includes(t)) setWatchlist((prev) => [...prev, t]);
    setInput("");
    setSuggestions([]);
    setError(null);
  };

  const addTicker = () => {
    const t = input.trim().toUpperCase();
    // コード直打ちならそのまま、名前入力ならサジェスト先頭を採用
    if (/^\d{3,4}[A-Z]?$/.test(t)) addTickerDirect(t);
    else if (suggestions.length > 0) addTickerDirect(suggestions[0].ticker);
    else setError("証券コードか企業名で検索してください");
  };

  // 入力のたびに: ①ローカルマスタで即時マッチ ②APIで補完 (300msデバウンス)
  const onInputChange = (v: string) => {
    setInput(v);
    setError(null);
    const q = v.trim();
    if (q.length === 0) { setSuggestions([]); return; }

    // ① ローカル (日経225 + 主要銘柄): 瞬時
    const qUpper = q.toUpperCase();
    const local: { ticker: string; name: string }[] = [];
    for (const [ticker, name] of NAME_MAP) {
      if (ticker.startsWith(qUpper) || name.includes(q)) {
        local.push({ ticker, name });
        if (local.length >= 8) break;
      }
    }
    setSuggestions(local);

    // ② API (立花全銘柄マスタ): 補完。ローカルで十分ヒットしてたらスキップ
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    if (local.length >= 5 || q.length < 2) return;
    searchTimer.current = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/stocks/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) return;
        const data = await res.json();
        const results = (Array.isArray(data) ? data : data.results ?? []) as { ticker: string; name: string; market?: string }[];
        const jp = results.filter((r) => /^\d{3,4}[A-Z]?$/.test(r.ticker));
        setSuggestions((prev) => {
          const seen = new Set(prev.map((p) => p.ticker));
          return [...prev, ...jp.filter((r) => !seen.has(r.ticker))].slice(0, 8);
        });
      } catch {}
    }, 300) as unknown as number;
  };

  const fetchData = useCallback(async () => {
    if (watchlist.length === 0) return;
    try {
      const { auth } = await import("@/lib/firebase");
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      const res = await fetch(`/api/warroom?tickers=${watchlist.join(",")}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!json.ok) { setError(json.error ?? "取得失敗"); return; }
      const newEntries = json.entries as Entry[];

      // ── アラート判定 (前回 poll との差分) ──
      if (alertsOn) {
        for (const e of newEntries) {
          const prev = prevRef.current.get(e.ticker);
          if (!prev) continue;
          const name = NAME_MAP.get(e.ticker) ?? e.ticker;
          // 急変: 1回のpollで ±0.8% 以上
          if (e.changePct !== null && prev.changePct !== null && Math.abs(e.changePct - prev.changePct) >= 0.8) {
            const d = e.changePct - prev.changePct;
            notify(`⚡ ${e.ticker} ${name} 急変`, `${d > 0 ? "+" : ""}${d.toFixed(2)}% (15秒間) → 現在 ${e.changePct.toFixed(2)}%`);
          }
          // 板圧反転
          if (e.boardRatio !== null && prev.boardRatio !== null) {
            if (prev.boardRatio < 1.5 && e.boardRatio >= 1.5) notify(`🔺 ${e.ticker} ${name} 板圧が買い優勢に`, `買い/売り = ${e.boardRatio.toFixed(2)}`);
            if (prev.boardRatio > 0.67 && e.boardRatio <= 0.67) notify(`🔻 ${e.ticker} ${name} 板圧が売り優勢に`, `買い/売り = ${e.boardRatio.toFixed(2)}`);
          }
          // VWAP クロス
          if (e.vwapDev !== null && prev.vwapDev !== null) {
            if (prev.vwapDev < 0 && e.vwapDev >= 0) notify(`🔺 ${e.ticker} ${name} VWAP 上抜け`, `現在 VWAP +${e.vwapDev.toFixed(2)}%`);
            if (prev.vwapDev > 0 && e.vwapDev <= 0) notify(`🔻 ${e.ticker} ${name} VWAP 割れ`, `現在 VWAP ${e.vwapDev.toFixed(2)}%`);
          }
          // 新高値 / 新安値
          if (e.high !== null && prev.high !== null && e.high > prev.high) notify(`📈 ${e.ticker} ${name} 本日高値更新`, `¥${e.high.toLocaleString()}`);
          if (e.low !== null && prev.low !== null && e.low < prev.low) notify(`📉 ${e.ticker} ${name} 本日安値更新`, `¥${e.low.toLocaleString()}`);
        }

        // ── 建玉ライン警報 (損切り/利確) ──
        for (const e of newEntries) {
          const p = positions[e.ticker];
          if (!p || e.price === null) continue;
          const name = NAME_MAP.get(e.ticker) ?? e.ticker;
          const fired = firedRef.current.get(e.ticker) ?? new Set<string>();
          const price = e.price;
          const near = (line: number) => Math.abs(price / line - 1) * 100 <= NEAR_PCT;
          const fire = (key: string, run: () => void) => { if (!fired.has(key)) { fired.add(key); run(); } };

          // 損切りライン
          if (p.stopLoss !== null) {
            const hit = p.side === "long" ? price <= p.stopLoss : price >= p.stopLoss;
            if (hit) fire("stop_hit", () => notify(`🚨 ${e.ticker} ${name} 損切りライン到達`, `¥${price.toLocaleString()} — ルール通り切りますか?`, true));
            else if (near(p.stopLoss)) fire("stop_near", () => notify(`⚠ ${e.ticker} ${name} 損切りライン接近`, `現在 ¥${price.toLocaleString()} / ライン ¥${p.stopLoss!.toLocaleString()}`));
          }
          // 利確ライン
          if (p.takeProfit !== null) {
            const hit = p.side === "long" ? price >= p.takeProfit : price <= p.takeProfit;
            if (hit) fire("target_hit", () => notify(`🎯 ${e.ticker} ${name} 利確ライン到達`, `¥${price.toLocaleString()} — 利を確定しますか?`, true));
            else if (near(p.takeProfit)) fire("target_near", () => notify(`✨ ${e.ticker} ${name} 利確ライン接近`, `現在 ¥${price.toLocaleString()} / ライン ¥${p.takeProfit!.toLocaleString()}`));
          }
          firedRef.current.set(e.ticker, fired);
        }
      }
      prevRef.current = new Map(newEntries.map((e) => [e.ticker, e]));
      // スタンス履歴を更新 (直近 HISTORY_LEN 件)
      setStanceHist((prev) => {
        const next = { ...prev };
        for (const e of newEntries) {
          const arr = [...(next[e.ticker] ?? []), e.stance];
          next[e.ticker] = arr.slice(-HISTORY_LEN);
        }
        return next;
      });
      setEntries(newEntries);
      setLastUpdate(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [watchlist, alertsOn, positions]);

  // polling
  useEffect(() => {
    if (!running) return;
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [running, fetchData]);

  // ミニチャート取得 (2分ごと。板ポーリングとは別系統)
  useEffect(() => {
    if (watchlist.length === 0) { setCharts({}); return; }
    const load = () =>
      fetch(`/api/stocks/sparkline?tickers=${watchlist.join(",")}&tf=1m`)
        .then((r) => r.json())
        .then((j) => {
          const next: Record<string, number[]> = {};
          for (const [t, e] of Object.entries((j.entries ?? {}) as Record<string, { closes: number[] }>)) {
            next[t] = e.closes ?? [];
          }
          setCharts(next);
        })
        .catch(() => {});
    load();
    if (!running) return;
    const id = setInterval(load, 120_000);
    return () => clearInterval(id);
  }, [watchlist, running]);

  const requestNotify = async () => {
    if (typeof Notification === "undefined") return;
    const perm = await Notification.requestPermission();
    if (perm === "granted") { setAlertsOn(true); beep(); }
  };

  const sorted = useMemo(
    () => [...entries].sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0)),
    [entries]
  );

  return (
    <div className="space-y-4">
      {/* ヘッダ */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">⚔ 場中ウォールーム</h1>
          <p className="text-[14px] text-[var(--color-text-secondary)] mt-1.5 leading-relaxed">
            今日の監視銘柄だけを 15 秒間隔で追う戦闘画面 (日本株・板情報ベース)
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap" style={MONO}>
          <span className="text-xs" style={{ color: marketOpen ? "#ff3b6b" : "var(--color-text-secondary)" }}>
            {marketOpen ? "🟢 場中" : "⚪ 場外"}
          </span>
          {!marketOpen && (
            <button onClick={() => setForceRun(!forceRun)} className="px-2 py-1 text-[10px]" style={{ border: "1px solid var(--color-border)", color: forceRun ? "var(--color-accent)" : "var(--color-text-secondary)" }}>
              {forceRun ? "場外更新: ON" : "場外でも更新する"}
            </button>
          )}
          {alertsOn ? (
            <span className="text-xs text-[#ff3b6b]">🔔 通知ON</span>
          ) : (
            <button onClick={requestNotify} className="px-2.5 py-1 text-xs" style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)" }}>
              🔔 デスクトップ通知を有効化
            </button>
          )}
          <button onClick={() => syncMail(false)} disabled={syncing} className="px-2.5 py-1 text-xs disabled:opacity-50" style={{ border: "1px solid var(--color-up)", color: "var(--color-up)" }} title="楽天の約定メールから建玉を自動投入 (場中は5分ごとに自動)">
            {syncing ? "同期中…" : "✉ 約定を同期"}
          </button>
          {lastUpdate && <span className="text-[10px] text-[var(--color-text-secondary)]">更新 {lastUpdate.toLocaleTimeString("ja-JP")}</span>}
        </div>
      </div>

      {syncMsg && (
        <div className="text-xs px-3 py-2" style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", background: "var(--bg-card)", ...MONO }}>
          {syncMsg}
        </div>
      )}

      {/* watchlist 管理 */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <input
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addTicker();
              if (e.key === "Escape") setSuggestions([]);
            }}
            placeholder="コード or 企業名 (例: 7203, トヨタ)"
            className="bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text)] w-60 focus:border-[var(--color-accent)] focus:outline-none"
            style={MONO}
          />
          {/* サジェスト */}
          {suggestions.length > 0 && (
            <div
              className="absolute top-full left-0 mt-1 w-72 z-30 border max-h-64 overflow-y-auto"
              style={{ background: "var(--bg-card)", borderColor: "var(--color-accent)", boxShadow: "0 4px 20px rgba(0,0,0,0.6)" }}
            >
              {suggestions.map((s, i) => (
                <button
                  key={s.ticker}
                  onClick={() => addTickerDirect(s.ticker)}
                  className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-[rgba(0,240,255,0.08)] transition-colors"
                  style={{ ...MONO, borderBottom: "1px solid var(--color-border)" }}
                >
                  <span className="font-bold text-[var(--color-accent)] w-12 shrink-0">{s.ticker}</span>
                  <span className="text-[var(--color-text)] truncate">{s.name}</span>
                  {watchlist.includes(s.ticker) && <span className="ml-auto text-[9px] text-[var(--color-text-secondary)]">✓監視中</span>}
                  {i === 0 && !watchlist.includes(s.ticker) && <span className="ml-auto text-[9px] text-[var(--color-text-secondary)]">Enter</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={addTicker} className="px-3 py-1.5 text-sm" style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)", ...MONO }}>
          + 追加
        </button>
        {watchlist.map((t) => {
          const isPinned = pinned.includes(t);
          const hasPos = positions[t] !== undefined;
          return (
            <span key={t} className="flex items-center gap-1 px-2 py-1 text-xs border text-[var(--color-text)]" style={{ ...MONO, borderColor: isPinned ? "var(--color-accent)" : "var(--color-border)", background: isPinned ? "rgba(0,240,255,0.06)" : "transparent" }}>
              <button
                onClick={() => togglePin(t)}
                title={isPinned ? "固定を解除 (翌日リセットで消える)" : "固定する (翌日以降も残す)"}
                className="leading-none"
                style={{ color: isPinned ? "var(--color-accent)" : "var(--color-text-secondary)", opacity: isPinned ? 1 : 0.5 }}
              >
                {isPinned ? "📌" : "📍"}
              </button>
              {t} {NAME_MAP.get(t) ?? ""}
              {hasPos && <span className="text-[9px] text-[var(--color-up)]" title="建玉あり (リセットでも残る)">建</span>}
              <button onClick={() => setWatchlist(watchlist.filter((x) => x !== t))} className="text-[var(--color-text-secondary)] hover:text-red-400 ml-1">×</button>
            </span>
          );
        })}
      </div>

      <p className="text-[10px] text-[var(--color-text-secondary)] opacity-70 -mt-2" style={MONO}>
        📌 = 固定 (翌日も残す) / 建 = 建玉あり (自動で残る) / それ以外は日付が変わると自動でリセット
      </p>

      {/* 初見ガイド: 今日の流れ (迷子防止。実戦3回の「どこにあるの?」から生まれた) */}
      <div className="flex items-center gap-2 flex-wrap px-3 py-2 border text-[10px]" style={{ borderColor: "var(--color-border)", background: "rgba(255,255,255,0.02)", color: "var(--color-text-secondary)", ...MONO }}>
        <span className="font-bold text-[var(--color-text)]">今日の流れ:</span>
        <span>① 寄り前に 🔔通知ON</span><span className="opacity-40">→</span>
        <span>② 9:05 まで観察 (判断帯が ⏳ の間は動かない)</span><span className="opacity-40">→</span>
        <span>③ ✅買い妙味 が出たら小ロット</span><span className="opacity-40">→</span>
        <span>④ 買ったら即「＋建玉を登録」(損切りライン必須)</span><span className="opacity-40">→</span>
        <span>⑤ 警報に従う → 決済時にタグ付け</span>
      </div>

      {error && <div className="p-2 border border-red-500/40 text-xs text-red-400" style={MONO}>⚠ {error}</div>}

      {watchlist.length === 0 && (
        <div className="p-8 border text-center text-sm text-[var(--color-text-secondary)]" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)", ...MONO }}>
          今日トレードする銘柄を追加してください。<br />
          <span className="text-[10px] opacity-70">追加した銘柄はこのブラウザに保存されます。板情報を使うため日本株のみ対応。</span>
        </div>
      )}

      {/* 戦闘カード */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {sorted.map((e) => (
          <BattleCard
            key={e.ticker}
            e={e}
            verdict={computeVerdict(e, stanceHist[e.ticker] ?? [])}
            chart={charts[e.ticker] ?? []}
            position={positions[e.ticker] ?? null}
            onOpen={() => router.push(`/stock/${e.ticker}`)}
            onSavePosition={savePosition}
            onClearPosition={() => clearPosition(e.ticker)}
            onCloseToJournal={closeToJournal}
          />
        ))}
      </div>

      <div className="text-[10px] text-[var(--color-text-secondary)] opacity-60 leading-relaxed" style={MONO}>
        ※ カード上部の帯 = 「買っていい / 待て / 触るな」の判断。板圧・VWAP・値位置に加え、直近3分のスタンス安定度で翻訳。一瞬の🟢に飛びつかないための装置。<br />
        ※ 「🟢3連・安定80%」= 3回連続で買い優勢が続き、直近の8割が買い優勢だった状態。チカチカしてる間は「⚡不安定・まだ待て」と出る。<br />
        ※ 板圧 = 買い板10段合計 ÷ 売り板10段合計。1.5以上で買い優勢、0.67以下で売り優勢と判定。<br />
        ※ 通知はこのタブを開いている間だけ動きます (急変・板圧反転・VWAPクロス・高安値更新・建玉ライン)。<br />
        ※ 🚨損切りライン到達 / 🎯利確ライン到達 は低音3連打で強く鳴ります。感情でブレる前に、機械にルールを突きつけさせる装置です。<br />
        ※ 建玉と損益はこのブラウザに保存。決済すると 📓ジャーナル に自動記録されます。
      </div>
    </div>
  );
}

function BattleCard({
  e,
  verdict,
  chart,
  position,
  onOpen,
  onSavePosition,
  onClearPosition,
  onCloseToJournal,
}: {
  e: Entry;
  verdict: Verdict;
  chart: number[];
  position: Position | null;
  onOpen: () => void;
  onSavePosition: (p: Position) => void;
  onClearPosition: () => void;
  onCloseToJournal: (p: Position, exitPrice: number) => void;
}) {
  const meta = STANCE_META[e.stance];
  const chgColor = (e.changePct ?? 0) > 0 ? "#ff3b6b" : (e.changePct ?? 0) < 0 ? "#00d9ff" : "var(--color-text)";
  const name = NAME_MAP.get(e.ticker) ?? "";
  const [editing, setEditing] = useState(false);
  const live = position && e.price !== null ? posPnl(position, e.price) : null;

  return (
    <div
      data-ticker={e.ticker}
      className="p-4 border space-y-3 transition-all"
      style={{ borderColor: position ? "rgba(0,240,255,0.5)" : `${meta.color}66`, background: `${meta.color}0a` }}
    >
      {/* 銘柄 + スタンス */}
      <div className="flex items-start justify-between gap-2">
        <button onClick={onOpen} className="text-left hover:brightness-125">
          <span className="text-base font-bold text-[var(--color-accent)]" style={MONO}>{e.ticker}</span>
          <span className="text-xs text-[var(--color-text)] ml-2">{name}</span>
        </button>
        <span className="text-sm font-black" style={{ color: meta.color, ...MONO }}>
          {meta.emoji} {meta.label}
        </span>
      </div>

      {/* 判断帯: 買っていい/待て/触るな を一言で (実戦の翻訳レイヤー) */}
      <div
        className="px-3 py-2 rounded text-center font-black"
        style={{
          background: `${verdict.color}1a`,
          border: `1.5px solid ${verdict.color}`,
          color: verdict.color,
          fontSize: verdict.advice === "go" ? "15px" : "13px",
          ...MONO,
          boxShadow: verdict.advice === "go" ? `0 0 14px ${verdict.color}40` : undefined,
        }}
      >
        {verdict.label}
      </div>

      {/* 価格 (主役) */}
      <div className="flex items-baseline gap-3" style={MONO}>
        <span className="text-4xl font-black leading-none text-[var(--color-text)]">
          {e.price !== null ? `¥${e.price.toLocaleString()}` : "—"}
        </span>
        <span className="text-xl font-bold" style={{ color: chgColor }}>
          {e.changePct !== null ? `${e.changePct > 0 ? "+" : ""}${e.changePct.toFixed(2)}%` : ""}
        </span>
        <span className="text-[10px] text-[var(--color-text-secondary)]">{e.priceTime ?? ""}</span>
      </div>

      {/* 当日1分足ミニチャート (形を見る用) */}
      {chart.length >= 5 && <IntradayMiniChart closes={chart} vwap={e.vwap} />}

      {/* 建玉パネル */}
      {position ? (
        <PositionPanel
          p={position}
          price={e.price}
          live={live}
          onEdit={() => setEditing(true)}
          onClear={onClearPosition}
          onClose={onCloseToJournal}
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="w-full py-1.5 text-xs border border-dashed"
          style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)", ...MONO }}
        >
          ＋ 建玉を登録 (損切り/利確ライン)
        </button>
      )}

      {editing && (
        <PositionEditor
          ticker={e.ticker}
          existing={position}
          currentPrice={e.price}
          chart={chart}
          onSave={(p) => { onSavePosition(p); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      )}

      {/* 主要メトリクス */}
      <div className="grid grid-cols-3 gap-2 text-center" style={MONO}>
        <Metric label="板圧 (買/売)" value={e.boardRatio !== null ? `${e.boardRatio.toFixed(2)}` : "—"}
          color={e.boardRatio === null ? undefined : e.boardRatio >= 1.5 ? "#ff3b6b" : e.boardRatio <= 0.67 ? "#00d9ff" : undefined} />
        <Metric label="VWAP乖離" value={e.vwapDev !== null ? `${e.vwapDev > 0 ? "+" : ""}${e.vwapDev.toFixed(2)}%` : "—"}
          color={e.vwapDev === null ? undefined : e.vwapDev >= 0.3 ? "#ff3b6b" : e.vwapDev <= -0.3 ? "#00d9ff" : undefined} />
        <Metric label="値位置" value={e.rangePos !== null ? `${Math.round(e.rangePos * 100)}%` : "—"}
          color={e.rangePos === null ? undefined : e.rangePos >= 0.8 ? "#ff3b6b" : e.rangePos <= 0.2 ? "#00d9ff" : undefined} />
      </div>

      {/* シグナル詳細 */}
      <div className="space-y-0.5">
        {e.signals.map((s) => (
          <div key={s.id} className="text-[10px] flex items-center gap-1.5" style={MONO}>
            <span style={{ color: s.direction === 1 ? "#ff3b6b" : s.direction === -1 ? "#00d9ff" : "#facc15" }}>
              {s.direction === 1 ? "▲" : s.direction === -1 ? "▼" : "─"}
            </span>
            <span className="text-[var(--color-text)]">{s.label}: {s.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 建玉表示: ライブ損益 + 損切り/利確ラインゲージ */
function PositionPanel({
  p, price, live, onEdit, onClear, onClose,
}: {
  p: Position;
  price: number | null;
  live: { pnl: number; pnlPct: number } | null;
  onEdit: () => void;
  onClear: () => void;
  onClose: (p: Position, exitPrice: number, tags: string[]) => void;
}) {
  const pnlColor = live ? (live.pnl >= 0 ? "#ff3b6b" : "#00d9ff") : "var(--color-text)";
  // 決済フロー: 押した瞬間にタグ選択を出す (鉄は熱いうちに記録)
  const [closing, setClosing] = useState(false);
  const [selTags, setSelTags] = useState<string[]>([]);
  // ゲージ: 損切り〜利確の範囲で現在値の位置
  const gauge = (() => {
    if (price === null || p.stopLoss === null || p.takeProfit === null) return null;
    const lo = Math.min(p.stopLoss, p.takeProfit);
    const hi = Math.max(p.stopLoss, p.takeProfit);
    if (hi <= lo) return null;
    const pos = Math.max(0, Math.min(1, (price - lo) / (hi - lo)));
    const entryPos = Math.max(0, Math.min(1, (p.entryPrice - lo) / (hi - lo)));
    const stopAtLeft = p.side === "long"; // long は損切りが下(左)
    return { pos, entryPos, stopAtLeft };
  })();

  return (
    <div className="p-2.5 border space-y-2" style={{ borderColor: "rgba(0,240,255,0.35)", background: "rgba(0,240,255,0.05)" }}>
      <div className="flex items-center justify-between" style={MONO}>
        <span className="text-[10px]" style={{ color: p.side === "long" ? "#ff3b6b" : "#00d9ff" }}>
          {p.side === "long" ? "買い建" : "売り建"} {p.qty}株 @¥{p.entryPrice.toLocaleString()}
        </span>
        {live && (
          <span className="text-lg font-black" style={{ color: pnlColor }}>
            {live.pnl >= 0 ? "+" : ""}¥{live.pnl.toLocaleString()}
            <span className="text-xs ml-1">({live.pnlPct >= 0 ? "+" : ""}{live.pnlPct}%)</span>
          </span>
        )}
      </div>

      {/* ラインゲージ */}
      {gauge && (
        <div className="relative h-5" style={{ ...MONO }}>
          <div className="absolute inset-x-0 top-2 h-0.5" style={{ background: "linear-gradient(90deg, #ef4444, #facc15, #ff3b6b)" , opacity: 0.5 }} />
          {/* エントリー */}
          <div className="absolute top-0.5 w-px h-4 bg-[var(--color-text-secondary)]" style={{ left: `${gauge.entryPos * 100}%` }} />
          {/* 現在値 */}
          <div className="absolute top-0 w-1.5 h-1.5 rounded-full -ml-0.5" style={{ left: `${gauge.pos * 100}%`, background: "#00f0ff", boxShadow: "0 0 6px #00f0ff", top: "5px" }} />
          <span className="absolute left-0 top-3.5 text-[8px]" style={{ color: "#ef4444" }}>{gauge.stopAtLeft ? `損 ¥${p.stopLoss!.toLocaleString()}` : `利 ¥${p.takeProfit!.toLocaleString()}`}</span>
          <span className="absolute right-0 top-3.5 text-[8px]" style={{ color: "#ff3b6b" }}>{gauge.stopAtLeft ? `利 ¥${p.takeProfit!.toLocaleString()}` : `損 ¥${p.stopLoss!.toLocaleString()}`}</span>
        </div>
      )}

      {/* ライン数値 (ゲージが出せない時のフォールバック含め常時表示) */}
      <div className="flex items-center gap-3 text-[10px]" style={MONO}>
        <span style={{ color: "#ef4444" }}>損切 {p.stopLoss !== null ? `¥${p.stopLoss.toLocaleString()}` : "—"}</span>
        <span style={{ color: "#ff3b6b" }}>利確 {p.takeProfit !== null ? `¥${p.takeProfit.toLocaleString()}` : "—"}</span>
      </div>

      {!closing ? (
        <div className="flex items-center gap-1.5">
          <button onClick={() => setClosing(true)} disabled={price === null}
            className="flex-1 py-1 text-[10px] disabled:opacity-40" style={{ border: "1px solid var(--color-accent-2)", color: "var(--color-accent-2)", ...MONO }}>
            決済 → 📓記録
          </button>
          <button onClick={onEdit} className="px-2 py-1 text-[10px]" style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", ...MONO }}>編集</button>
          <button onClick={onClear} className="px-2 py-1 text-[10px] text-[var(--color-text-secondary)] hover:text-red-400" title="建玉を消す">✕</button>
        </div>
      ) : (
        /* 決済確定前: エントリー根拠をその場で2タップ (後回しは忘れるので) */
        <div className="space-y-1.5 p-2 border" style={{ borderColor: "rgba(255,43,214,0.4)", background: "rgba(255,43,214,0.05)" }}>
          <div className="text-[9px] text-[var(--color-text-secondary)]" style={MONO}>
            何を根拠に入ったトレードでしたか? (複数可・正直に)
          </div>
          <div className="flex flex-wrap gap-1">
            {TRADE_REASON_TAGS.map((tag) => (
              <button key={tag}
                onClick={() => setSelTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])}
                className="px-1.5 py-0.5 text-[9px]"
                style={{ ...MONO, border: `1px solid ${selTags.includes(tag) ? "var(--color-accent)" : "var(--color-border)"}`, color: selTags.includes(tag) ? "var(--color-accent)" : "var(--color-text-secondary)", background: selTags.includes(tag) ? "rgba(0,240,255,0.08)" : "transparent" }}>
                {tag}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => { if (price !== null) { onClose(p, price, selTags); setClosing(false); setSelTags([]); } }}
              disabled={price === null}
              className="flex-1 py-1 text-[10px] font-bold disabled:opacity-40"
              style={{ border: "1px solid var(--color-accent-2)", color: "var(--color-accent-2)", background: "rgba(255,43,214,0.1)", ...MONO }}>
              {selTags.length > 0 ? `決済を確定 (タグ${selTags.length}個)` : "タグなしで決済"}
            </button>
            <button onClick={() => { setClosing(false); setSelTags([]); }} className="px-2 py-1 text-[10px] text-[var(--color-text-secondary)]">戻る</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 当日1分足からノイズ幅を推定: 5分窓の振れ幅 (max-min) の中央値。
 * 「普通にしていてもこれだけ動く」幅。損切りラインがこれより近いとノイズで刈られる。
 */
/** 値幅表示用: 1円未満は小数1桁、それ以上は整数 */
function fmtW(v: number): string {
  return v < 10 ? (Math.round(v * 10) / 10).toLocaleString() : Math.round(v).toLocaleString();
}

function estimateNoiseWidth(closes: number[]): number | null {
  if (closes.length < 15) return null;
  const swings: number[] = [];
  for (let i = 5; i <= closes.length; i++) {
    const win = closes.slice(i - 5, i);
    swings.push(Math.max(...win) - Math.min(...win));
  }
  swings.sort((a, b) => a - b);
  const mid = Math.floor(swings.length / 2);
  const med = swings.length % 2 ? swings[mid] : (swings[mid - 1] + swings[mid]) / 2;
  return med > 0 ? med : null;
}

/** 建玉登録/編集フォーム */
function PositionEditor({
  ticker, existing, currentPrice, chart, onSave, onCancel,
}: {
  ticker: string;
  existing: Position | null;
  currentPrice: number | null;
  chart: number[];
  onSave: (p: Position) => void;
  onCancel: () => void;
}) {
  const [side, setSide] = useState<"long" | "short">(existing?.side ?? "long");
  const [qty, setQty] = useState(String(existing?.qty ?? 100));
  const [entry, setEntry] = useState(String(existing?.entryPrice ?? currentPrice ?? ""));
  const [stop, setStop] = useState(existing?.stopLoss !== null && existing?.stopLoss !== undefined ? String(existing.stopLoss) : "");
  const [target, setTarget] = useState(existing?.takeProfit !== null && existing?.takeProfit !== undefined ? String(existing.takeProfit) : "");

  // ── 損切り幅サニティチェック (2026-07-07 JAL戦の教訓: ノイズ幅より狭い損切りは刈られる) ──
  const noise = useMemo(() => estimateNoiseWidth(chart), [chart]);
  const stopSanity = useMemo(() => {
    const entryPrice = Number(entry);
    const stopPrice = Number(stop);
    if (!entryPrice || !stopPrice || noise === null) return null;
    const width = side === "long" ? entryPrice - stopPrice : stopPrice - entryPrice;
    if (width <= 0) return { level: "invalid" as const, width, noise };
    const ratio = width / noise;
    if (ratio < 1) return { level: "danger" as const, width, noise };
    if (ratio < 1.5) return { level: "warn" as const, width, noise };
    return { level: "ok" as const, width, noise };
  }, [entry, stop, side, noise]);

  const save = () => {
    const entryPrice = Number(entry);
    const q = Number(qty);
    if (!entryPrice || !q) return;
    onSave({
      ticker,
      side,
      qty: q,
      entryPrice,
      entryAt: existing?.entryAt ?? new Date().toISOString(),
      stopLoss: stop ? Number(stop) : null,
      takeProfit: target ? Number(target) : null,
    });
  };

  const inp = "w-full mt-0.5 bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)]";
  return (
    <div className="p-2.5 border space-y-2" style={{ borderColor: "var(--color-accent)", background: "rgba(0,240,255,0.06)" }}>
      <div className="grid grid-cols-3 gap-1.5">
        <label className="text-[9px] text-[var(--color-text-secondary)]" style={MONO}>
          売買
          <div className="flex gap-0.5 mt-0.5">
            {(["long", "short"] as const).map((s) => (
              <button key={s} onClick={() => setSide(s)} className="flex-1 py-1 text-[10px]"
                style={{ ...MONO, border: `1px solid ${side === s ? (s === "long" ? "#ff3b6b" : "#ef4444") : "var(--color-border)"}`, color: side === s ? (s === "long" ? "#ff3b6b" : "#ef4444") : "var(--color-text-secondary)" }}>
                {s === "long" ? "買" : "売"}
              </button>
            ))}
          </div>
        </label>
        <label className="text-[9px] text-[var(--color-text-secondary)]" style={MONO}>数量
          <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} className={inp} style={MONO} />
        </label>
        <label className="text-[9px] text-[var(--color-text-secondary)]" style={MONO}>建値
          <input type="number" value={entry} onChange={(e) => setEntry(e.target.value)} className={inp} style={MONO} />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <label className="text-[9px]" style={{ color: "#ef4444", ...MONO }}>損切りライン
          <input type="number" value={stop} onChange={(e) => setStop(e.target.value)} placeholder="任意" className={inp} style={MONO} />
        </label>
        <label className="text-[9px]" style={{ color: "#ff3b6b", ...MONO }}>利確ライン
          <input type="number" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="任意" className={inp} style={MONO} />
        </label>
      </div>

      {/* 損切り幅サニティチェック */}
      {stopSanity && (
        <div
          className="text-[10px] p-1.5 border-l-2 leading-relaxed"
          style={{
            ...MONO,
            borderColor: stopSanity.level === "ok" ? "#4ade80" : stopSanity.level === "warn" ? "#facc15" : "#ef4444",
            background: stopSanity.level === "ok" ? "rgba(74,222,128,0.06)" : stopSanity.level === "warn" ? "rgba(250,204,21,0.06)" : "rgba(239,68,68,0.08)",
            color: "var(--color-text)",
          }}
        >
          {stopSanity.level === "invalid" ? (
            <>⚠ 損切りラインが建値の{side === "long" ? "上" : "下"}にあります (買い建は建値より下に置く)</>
          ) : stopSanity.level === "danger" ? (
            <>🚨 損切り幅 ¥{fmtW(stopSanity.width)} &lt; ノイズ幅 ¥{fmtW(stopSanity.noise)} (5分振れ幅の中央値) — <strong>普通の揺れで刈られます</strong>。目安: ¥{fmtW(stopSanity.noise * 1.5)} 以上</>
          ) : stopSanity.level === "warn" ? (
            <>⚠ 損切り幅 ¥{fmtW(stopSanity.width)} はノイズ幅 ¥{fmtW(stopSanity.noise)} の1.5倍未満 — やや刈られやすい</>
          ) : (
            <>✓ 損切り幅 ¥{fmtW(stopSanity.width)} / ノイズ幅 ¥{fmtW(stopSanity.noise)} — ノイズ耐性あり</>
          )}
        </div>
      )}
      {stop && noise === null && (
        <div className="text-[9px] opacity-60" style={MONO}>※ 1分足データ不足でノイズ幅を推定できません (寄り直後など)</div>
      )}

      <div className="flex gap-1.5">
        <button onClick={save} className="flex-1 py-1 text-xs font-bold" style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)", background: "rgba(0,240,255,0.1)", ...MONO }}>保存</button>
        <button onClick={onCancel} className="px-3 py-1 text-xs text-[var(--color-text-secondary)]" style={MONO}>×</button>
      </div>
    </div>
  );
}

/** 当日1分足ミニチャート: 寄り値の基準線 + VWAP線 + 現在位置。色は日本式 (上=ピンク/下=シアン) */
function IntradayMiniChart({ closes, vwap }: { closes: number[]; vwap: number | null }) {
  const W = 260, H = 48, PAD = 3;
  const all = vwap !== null ? [...closes, vwap] : closes;
  const min = Math.min(...all), max = Math.max(...all);
  const span = max - min || 1;
  const y = (v: number) => PAD + (H - PAD * 2) * (1 - (v - min) / span);
  const stepX = (W - PAD * 2) / (closes.length - 1);
  const pts = closes.map((c, i) => `${(PAD + i * stepX).toFixed(1)},${y(c).toFixed(1)}`);
  const up = closes[closes.length - 1] >= closes[0];
  const stroke = up ? "#ff3b6b" : "#00d9ff";
  const openY = y(closes[0]);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[48px]" preserveAspectRatio="none">
        {/* 寄り値の基準線 */}
        <line x1={PAD} y1={openY} x2={W - PAD} y2={openY} stroke="rgba(255,255,255,0.15)" strokeDasharray="3,3" strokeWidth="1" />
        {/* VWAP 線 */}
        {vwap !== null && (
          <line x1={PAD} y1={y(vwap)} x2={W - PAD} y2={y(vwap)} stroke="rgba(250,204,21,0.5)" strokeDasharray="2,4" strokeWidth="1" />
        )}
        <polyline points={pts.join(" ")} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" />
        <circle cx={PAD + (closes.length - 1) * stepX} cy={y(closes[closes.length - 1])} r="2.2" fill={stroke} />
      </svg>
      <div className="flex justify-between text-[8px] text-[var(--color-text-secondary)] opacity-70" style={MONO}>
        <span>当日1分足 (Yahoo・約15分遅延)</span>
        <span>--- 寄り値 / <span style={{ color: "rgba(250,204,21,0.8)" }}>- - VWAP</span></span>
      </div>
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="p-2 border" style={{ borderColor: "var(--color-border)", background: "rgba(0,0,0,0.25)" }}>
      <div className="text-[9px] text-[var(--color-text-secondary)]">{label}</div>
      <div className="text-lg font-black mt-0.5" style={{ color: color ?? "var(--color-text)" }}>{value}</div>
    </div>
  );
}
