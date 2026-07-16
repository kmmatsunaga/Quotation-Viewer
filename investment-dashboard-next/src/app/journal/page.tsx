"use client";

/**
 * /journal — 📓 トレードジャーナル
 *
 * 「Cavka の予測」は 🎯的中率 で検証する。
 * 「自分のトレード」はここで検証する。
 *
 *   - 勝率 / PF / 平均損益 / 保有時間
 *   - 根拠タグ別の勝率 (どの根拠で入った時に勝てているか)
 *   - 時間帯別の勝率 (何時のエントリーが得意か)
 *
 * 入口: 手動クイック入力 (v1) → CSV / 約定メール自動取込 (次フェーズ)
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import {
  getTrades,
  addTrade,
  closeTrade,
  updateTrade,
  deleteTrade,
  computeTradePnl,
  TRADE_REASON_TAGS,
  type Trade,
} from "@/lib/firestore";
import { NIKKEI225 } from "@/lib/nikkei225";
import { STOCK_LIST } from "@/lib/stock-list";
import { syncRakutenMail } from "@/lib/rakuten-sync";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };
const NAME_MAP = new Map<string, string>([
  ...NIKKEI225.map((s) => [s.ticker, s.name] as const),
  ...STOCK_LIST.map((s) => [s.ticker, s.name] as const),
]);

const UP = "var(--color-up)";
const DOWN = "var(--color-down)";

function nowLocalIso(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function fmtDuration(entryAt: string, exitAt: string): string {
  const ms = new Date(exitAt).getTime() - new Date(entryAt).getTime();
  if (ms < 0) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}分`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}時間${mins % 60 ? `${mins % 60}分` : ""}`;
  return `${Math.floor(mins / (60 * 24))}日`;
}

function entryHourSlot(entryAt: string): string {
  const h = new Date(entryAt).getHours();
  const m = new Date(entryAt).getMinutes();
  const t = h + m / 60;
  if (t < 9) return "寄付前";
  if (t < 10) return "9時台";
  if (t < 11) return "10時台";
  if (t < 12.5) return "11時-昼";
  if (t < 14) return "後場前半";
  if (t < 15.6) return "後場後半";
  return "場外";
}

export default function JournalPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [openPrices, setOpenPrices] = useState<Record<string, { price: number }>>({});
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closePrice, setClosePrice] = useState("");
  const [tagEditId, setTagEditId] = useState<string | null>(null);

  // フォーム
  const [form, setForm] = useState({
    ticker: "",
    side: "long" as "long" | "short",
    qty: "100",
    entryPrice: "",
    entryAt: nowLocalIso(),
    exitPrice: "",
    exitAt: "",
    tags: [] as string[],
    memo: "",
  });
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      setTrades(await getTrades(user.uid));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  // ── 楽天約定メール自動取込 ──
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [autoSynced, setAutoSynced] = useState(false);

  const syncMail = useCallback(async (silent = false) => {
    if (!user || syncing) return;
    setSyncing(true);
    if (!silent) setSyncMsg("メールを確認中…");
    try {
      const r = await syncRakutenMail(user);
      if (!r.ok) {
        setSyncMsg(r.message);
        return;
      }
      if (r.changed > 0) {
        setSyncMsg(r.message);
        await load();
      } else {
        setSyncMsg(silent ? null : r.message);
      }
    } finally {
      setSyncing(false);
    }
  }, [user, syncing, load]);

  // 初回ロード後に一度だけ自動同期 (差分のみ)
  useEffect(() => {
    if (user && !loading && !autoSynced) {
      setAutoSynced(true);
      syncMail(true);
    }
  }, [user, loading, autoSynced, syncMail]);

  // オープンポジションの現在値
  const openTrades = trades.filter((t) => t.status === "open");
  useEffect(() => {
    if (openTrades.length === 0) return;
    const tickers = Array.from(new Set(openTrades.map((t) => t.ticker))).join(",");
    fetch(`/api/stocks/prices?tickers=${tickers}`)
      .then((r) => r.json())
      .then((d) => setOpenPrices(d.prices ?? {}))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTrades.map((t) => t.ticker).join(",")]);

  const submit = async () => {
    if (!user) return;
    const ticker = form.ticker.trim().toUpperCase();
    const entryPrice = Number(form.entryPrice);
    const qty = Number(form.qty);
    if (!ticker || !entryPrice || !qty) return;
    setSubmitting(true);
    try {
      const hasExit = form.exitPrice && form.exitAt;
      const base = {
        ticker,
        name: NAME_MAP.get(ticker) ?? ticker,
        market: /^\d{3,4}[A-Z]?$/.test(ticker) ? "JP" : "US",
        side: form.side,
        qty,
        entryPrice,
        entryAt: new Date(form.entryAt).toISOString(),
        reasonTags: form.tags,
        memo: form.memo,
        source: "manual" as const,
      };
      if (hasExit) {
        const exitPrice = Number(form.exitPrice);
        const { pnl, pnlPct } = computeTradePnl(base, exitPrice);
        await addTrade(user.uid, {
          ...base,
          exitPrice,
          exitAt: new Date(form.exitAt).toISOString(),
          status: "closed",
          pnl,
          pnlPct,
        });
      } else {
        await addTrade(user.uid, { ...base, exitPrice: null, exitAt: null, status: "open", pnl: null, pnlPct: null });
      }
      setForm({ ticker: "", side: "long", qty: "100", entryPrice: "", entryAt: nowLocalIso(), exitPrice: "", exitAt: "", tags: [], memo: "" });
      setShowForm(false);
      await load();
    } finally {
      setSubmitting(false);
    }
  };

  const doClose = async (t: Trade) => {
    if (!user || !closePrice) return;
    await closeTrade(user.uid, t, Number(closePrice), new Date().toISOString());
    setClosingId(null);
    setClosePrice("");
    await load();
  };

  const toggleTag = async (t: Trade, tag: string) => {
    if (!user) return;
    const tags = t.reasonTags.includes(tag) ? t.reasonTags.filter((x) => x !== tag) : [...t.reasonTags, tag];
    await updateTrade(user.uid, t.id!, { reasonTags: tags });
    setTrades((prev) => prev.map((x) => (x.id === t.id ? { ...x, reasonTags: tags } : x)));
  };

  // ── 統計 ──
  const closed = trades.filter((t) => t.status === "closed" && t.pnl !== null);
  const stats = useMemo(() => {
    if (closed.length === 0) return null;
    const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
    const losses = closed.filter((t) => (t.pnl ?? 0) < 0);
    const grossWin = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
    const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    // タグ別
    const byTag = new Map<string, { n: number; wins: number; sumPct: number }>();
    for (const t of closed) {
      for (const tag of t.reasonTags.length > 0 ? t.reasonTags : ["(タグなし)"]) {
        const a = byTag.get(tag) ?? { n: 0, wins: 0, sumPct: 0 };
        a.n++;
        if ((t.pnl ?? 0) > 0) a.wins++;
        a.sumPct += t.pnlPct ?? 0;
        byTag.set(tag, a);
      }
    }
    // 時間帯別
    const bySlot = new Map<string, { n: number; wins: number; sumPnl: number }>();
    for (const t of closed) {
      const slot = entryHourSlot(t.entryAt);
      const a = bySlot.get(slot) ?? { n: 0, wins: 0, sumPnl: 0 };
      a.n++;
      if ((t.pnl ?? 0) > 0) a.wins++;
      a.sumPnl += t.pnl ?? 0;
      bySlot.set(slot, a);
    }
    return {
      n: closed.length,
      winRate: (wins.length / closed.length) * 100,
      totalPnl,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      avgPnl: totalPnl / closed.length,
      byTag: Array.from(byTag.entries()).map(([tag, a]) => ({ tag, ...a, winRate: (a.wins / a.n) * 100, avgPct: a.sumPct / a.n })).sort((a, b) => b.n - a.n),
      bySlot: Array.from(bySlot.entries()).map(([slot, a]) => ({ slot, ...a, winRate: (a.wins / a.n) * 100 })),
    };
  }, [closed]);

  if (loading) {
    return <div className="text-center py-20 text-sm text-[var(--color-text)]" style={MONO}>📓 読み込み中...</div>;
  }

  return (
    <div className="space-y-5">
      {/* ヘッダ */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">📓 トレードジャーナル</h1>
          <p className="text-[14px] text-[var(--color-text-secondary)] mt-1.5 leading-relaxed">
            自分のトレードの答え合わせ。どの根拠・どの時間帯で勝てているか。
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => syncMail(false)}
            disabled={syncing}
            className="px-4 py-2 text-sm min-h-[44px] disabled:opacity-50"
            style={{ border: "1px solid var(--color-up)", color: "var(--color-up)", background: "transparent", ...MONO }}
            title="楽天証券の約定メールから自動取込"
          >
            {syncing ? "同期中…" : "✉ 約定を同期"}
          </button>
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-4 py-2 text-sm min-h-[44px]"
            style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)", background: showForm ? "rgba(0,240,255,0.08)" : "transparent", ...MONO }}
          >
            {showForm ? "キャンセル" : "+ 記録する"}
          </button>
        </div>
      </div>

      {syncMsg && (
        <div className="text-xs px-3 py-2" style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", background: "var(--bg-card)", ...MONO }}>
          {syncMsg}
        </div>
      )}

      {/* クイック入力 */}
      {showForm && (
        <div className="p-4 border space-y-3" style={{ borderColor: "var(--color-accent)", background: "rgba(0,240,255,0.04)" }}>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <label className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
              銘柄コード
              <input value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value })} placeholder="7203"
                className="w-full mt-1 bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-1.5 text-sm text-[var(--color-text)]" style={MONO} />
            </label>
            <label className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
              売買
              <div className="flex gap-1 mt-1">
                {(["long", "short"] as const).map((s) => (
                  <button key={s} onClick={() => setForm({ ...form, side: s })}
                    className="flex-1 py-1.5 text-xs"
                    style={{ ...MONO, border: `1px solid ${form.side === s ? (s === "long" ? UP : DOWN) : "var(--color-border)"}`, color: form.side === s ? (s === "long" ? UP : DOWN) : "var(--color-text-secondary)" }}>
                    {s === "long" ? "買い" : "空売り"}
                  </button>
                ))}
              </div>
            </label>
            <label className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
              数量
              <input type="number" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })}
                className="w-full mt-1 bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-1.5 text-sm text-[var(--color-text)]" style={MONO} />
            </label>
            <label className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
              エントリー価格
              <input type="number" value={form.entryPrice} onChange={(e) => setForm({ ...form, entryPrice: e.target.value })} placeholder="2830"
                className="w-full mt-1 bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-1.5 text-sm text-[var(--color-text)]" style={MONO} />
            </label>
            <label className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
              エントリー日時
              <input type="datetime-local" value={form.entryAt} onChange={(e) => setForm({ ...form, entryAt: e.target.value })}
                className="w-full mt-1 bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-1.5 text-sm text-[var(--color-text)]" style={{ ...MONO, colorScheme: "dark" }} />
            </label>
          </div>

          {/* 決済済みなら記入 (空ならオープンポジションとして記録) */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <label className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
              イグジット価格 (任意)
              <input type="number" value={form.exitPrice} onChange={(e) => setForm({ ...form, exitPrice: e.target.value })} placeholder="未決済なら空"
                className="w-full mt-1 bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-1.5 text-sm text-[var(--color-text)]" style={MONO} />
            </label>
            <label className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
              イグジット日時 (任意)
              <input type="datetime-local" value={form.exitAt} onChange={(e) => setForm({ ...form, exitAt: e.target.value })}
                className="w-full mt-1 bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-1.5 text-sm text-[var(--color-text)]" style={{ ...MONO, colorScheme: "dark" }} />
            </label>
            <label className="col-span-2 md:col-span-3 text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
              メモ
              <input value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} placeholder="状況、感情、反省..."
                className="w-full mt-1 bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-1.5 text-sm text-[var(--color-text)]" style={MONO} />
            </label>
          </div>

          {/* 根拠タグ */}
          <div>
            <div className="text-[10px] text-[var(--color-text-secondary)] mb-1" style={MONO}>エントリー根拠 (複数可) — ここが後で宝になる</div>
            <div className="flex flex-wrap gap-1.5">
              {TRADE_REASON_TAGS.map((tag) => (
                <button key={tag}
                  onClick={() => setForm({ ...form, tags: form.tags.includes(tag) ? form.tags.filter((t) => t !== tag) : [...form.tags, tag] })}
                  className="px-2 py-1 text-xs"
                  style={{ ...MONO, border: `1px solid ${form.tags.includes(tag) ? "var(--color-accent)" : "var(--color-border)"}`, color: form.tags.includes(tag) ? "var(--color-accent)" : "var(--color-text-secondary)", background: form.tags.includes(tag) ? "rgba(0,240,255,0.08)" : "transparent" }}>
                  {tag}
                </button>
              ))}
            </div>
          </div>

          <button onClick={submit} disabled={submitting || !form.ticker || !form.entryPrice}
            className="px-6 py-2 text-sm font-bold disabled:opacity-40"
            style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)", background: "rgba(0,240,255,0.1)", ...MONO }}>
            {submitting ? "..." : "記録"}
          </button>
        </div>
      )}

      {/* ── 成績サマリ ── */}
      {stats ? (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <StatCard label="トレード数" value={`${stats.n}`} />
          <StatCard label="勝率" value={`${stats.winRate.toFixed(1)}%`} color={stats.winRate >= 50 ? UP : DOWN} />
          <StatCard label="総損益" value={`${stats.totalPnl >= 0 ? "+" : ""}¥${stats.totalPnl.toLocaleString()}`} color={stats.totalPnl >= 0 ? UP : DOWN} />
          <StatCard label="PF (利益÷損失)" value={stats.profitFactor !== null ? stats.profitFactor.toFixed(2) : "∞"} color={stats.profitFactor === null || stats.profitFactor >= 1.5 ? UP : stats.profitFactor >= 1 ? "var(--color-text)" : DOWN} />
          <StatCard label="平均損益" value={`${stats.avgPnl >= 0 ? "+" : ""}¥${Math.round(stats.avgPnl).toLocaleString()}`} color={stats.avgPnl >= 0 ? UP : DOWN} />
        </div>
      ) : (
        <div className="p-4 border text-xs text-[var(--color-text-secondary)]" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)", ...MONO }}>
          📭 決済済みトレードがまだありません。「+ 記録する」から始めるか、次フェーズの CSV/約定メール取込を待ってください。
          過去のトレードを何件か手で入れるだけでも、タグ別勝率は動き始めます。
        </div>
      )}

      {/* ── タグ別 × 時間帯別 ── */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="p-4 border space-y-1.5" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
            <div className="text-xs font-bold text-[var(--color-text)] mb-2" style={MONO}>🏷 根拠タグ別の成績 — あなたの勝ちパターン</div>
            {stats.byTag.map((t) => (
              <div key={t.tag} className="flex items-center justify-between" style={MONO}>
                <span className="text-xs text-[var(--color-text)]">{t.tag} <span className="opacity-50">×{t.n}</span></span>
                <span className="flex items-baseline gap-3">
                  <span className="text-lg font-black" style={{ color: t.winRate >= 55 ? UP : t.winRate < 45 ? DOWN : "var(--color-text)" }}>
                    {t.winRate.toFixed(0)}%
                  </span>
                  <span className="text-[10px] text-[var(--color-text-secondary)]">平均 {t.avgPct >= 0 ? "+" : ""}{t.avgPct.toFixed(2)}%</span>
                </span>
              </div>
            ))}
          </div>
          <div className="p-4 border space-y-1.5" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
            <div className="text-xs font-bold text-[var(--color-text)] mb-2" style={MONO}>🕐 時間帯別の成績 — あなたの得意な時間</div>
            {["寄付前", "9時台", "10時台", "11時-昼", "後場前半", "後場後半", "場外"].map((slot) => {
              const s = stats.bySlot.find((x) => x.slot === slot);
              if (!s) return null;
              return (
                <div key={slot} className="flex items-center justify-between" style={MONO}>
                  <span className="text-xs text-[var(--color-text)]">{slot} <span className="opacity-50">×{s.n}</span></span>
                  <span className="flex items-baseline gap-3">
                    <span className="text-lg font-black" style={{ color: s.winRate >= 55 ? UP : s.winRate < 45 ? DOWN : "var(--color-text)" }}>
                      {s.winRate.toFixed(0)}%
                    </span>
                    <span className="text-[10px] text-[var(--color-text-secondary)]">{s.sumPnl >= 0 ? "+" : ""}¥{s.sumPnl.toLocaleString()}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── オープンポジション ── */}
      {openTrades.length > 0 && (
        <div className="space-y-1.5">
          <h2 className="text-[17px] font-bold text-[var(--color-text)]">🔥 オープンポジション ({openTrades.length})</h2>
          {openTrades.map((t) => {
            const cur = openPrices[t.ticker]?.price ?? null;
            const live = cur !== null ? computeTradePnl(t, cur) : null;
            return (
              <div key={t.id} className="p-3 border flex items-center gap-3 flex-wrap" style={{ borderColor: "rgba(0,240,255,0.35)", background: "rgba(0,240,255,0.04)" }}>
                <button onClick={() => router.push(`/stock/${t.ticker}`)} className="text-sm font-bold text-[var(--color-accent)]" style={MONO}>{t.ticker}</button>
                <span className="text-xs text-[var(--color-text)]">{t.name}</span>
                <span className="text-[10px] px-1.5 py-0.5" style={{ ...MONO, border: `1px solid ${t.side === "long" ? UP : DOWN}`, color: t.side === "long" ? UP : DOWN }}>
                  {t.side === "long" ? "買い" : "空売り"} {t.qty}株
                </span>
                <span className="text-xs" style={MONO}>IN ¥{t.entryPrice.toLocaleString()}</span>
                {live && (
                  <span className="text-base font-black" style={{ ...MONO, color: live.pnl >= 0 ? UP : DOWN }}>
                    {live.pnl >= 0 ? "+" : ""}¥{live.pnl.toLocaleString()} ({live.pnlPct >= 0 ? "+" : ""}{live.pnlPct}%)
                  </span>
                )}
                <span className="ml-auto flex items-center gap-2">
                  {closingId === t.id ? (
                    <>
                      <input type="number" value={closePrice} onChange={(e) => setClosePrice(e.target.value)} placeholder="決済価格" autoFocus
                        className="w-24 bg-[var(--bg-input)] border border-[var(--color-accent)] px-2 py-1 text-xs text-[var(--color-text)]" style={MONO} />
                      <button onClick={() => doClose(t)} className="px-2 py-1 text-xs" style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)", ...MONO }}>確定</button>
                      <button onClick={() => setClosingId(null)} className="text-xs text-[var(--color-text-secondary)]">✕</button>
                    </>
                  ) : (
                    <button onClick={() => { setClosingId(t.id!); setClosePrice(cur !== null ? String(cur) : ""); }}
                      className="px-3 py-1 text-xs" style={{ border: "1px solid var(--color-accent-2)", color: "var(--color-accent-2)", ...MONO }}>
                      決済を記録
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* ── 決済済みトレード一覧 ── */}
      {closed.length > 0 && (
        <div className="space-y-1.5">
          <h2 className="text-[17px] font-bold text-[var(--color-text)]">✅ 決済済み ({closed.length})</h2>
          {closed.map((t) => (
            <div key={t.id} className="p-3 border space-y-1.5" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
              <div className="flex items-center gap-3 flex-wrap" style={MONO}>
                <span className="text-[10px] text-[var(--color-text-secondary)]">{t.entryAt.slice(0, 10)}</span>
                <button onClick={() => router.push(`/stock/${t.ticker}`)} className="text-sm font-bold text-[var(--color-accent)]">{t.ticker}</button>
                <span className="text-xs text-[var(--color-text)]">{t.name}</span>
                <span className="text-[10px] px-1.5 py-0.5" style={{ border: `1px solid ${t.side === "long" ? UP : DOWN}`, color: t.side === "long" ? UP : DOWN }}>
                  {t.side === "long" ? "買" : "売"} {t.qty}
                </span>
                <span className="text-xs text-[var(--color-text-secondary)]">
                  ¥{t.entryPrice.toLocaleString()} → ¥{t.exitPrice?.toLocaleString()}
                  {t.exitAt && <span className="ml-1.5 opacity-60">({fmtDuration(t.entryAt, t.exitAt)})</span>}
                </span>
                <span className="text-lg font-black ml-auto" style={{ color: (t.pnl ?? 0) >= 0 ? UP : DOWN }}>
                  {(t.pnl ?? 0) >= 0 ? "+" : ""}¥{(t.pnl ?? 0).toLocaleString()}
                  <span className="text-xs ml-1.5">({(t.pnlPct ?? 0) >= 0 ? "+" : ""}{t.pnlPct}%)</span>
                </span>
                <button onClick={() => user && deleteTrade(user.uid, t.id!).then(load)} className="text-[var(--color-text-secondary)] hover:text-red-400 text-xs" title="削除">✕</button>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {(tagEditId === t.id ? [...TRADE_REASON_TAGS] : t.reasonTags).map((tag) => (
                  <button key={tag} onClick={() => tagEditId === t.id && toggleTag(t, tag)}
                    className="text-[9px] px-1.5 py-0.5"
                    style={{
                      ...MONO,
                      border: `1px solid ${t.reasonTags.includes(tag) ? "rgba(0,240,255,0.45)" : "var(--color-border)"}`,
                      color: t.reasonTags.includes(tag) ? "var(--color-accent)" : "var(--color-text-secondary)",
                      opacity: tagEditId === t.id && !t.reasonTags.includes(tag) ? 0.5 : 1,
                      cursor: tagEditId === t.id ? "pointer" : "default",
                    }}>
                    {tag}
                  </button>
                ))}
                <button onClick={() => setTagEditId(tagEditId === t.id ? null : t.id!)}
                  className="text-[9px] px-1.5 py-0.5 text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]" style={MONO}>
                  {tagEditId === t.id ? "完了" : "＋タグ"}
                </button>
                {t.memo && <span className="text-[10px] text-[var(--color-text-secondary)] italic ml-2">{t.memo}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="text-[10px] text-[var(--color-text-secondary)] opacity-60 leading-relaxed" style={MONO}>
        ※ 損益は手数料抜きの概算。<br />
        ※ 勝率よりも PF (総利益÷総損失) と平均損益を重視。勝率40%でも PF 1.5 なら勝てるトレーダー。<br />
        ※ 次フェーズ: 楽天CSV取込 → 約定メール自動取込 (定時 + ページを開くたび差分同期)。
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="p-3 border text-center" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
      <div className="text-[9px] text-[var(--color-text-secondary)] uppercase tracking-wider" style={MONO}>{label}</div>
      <div className="text-xl font-black mt-1" style={{ ...MONO, color: color ?? "var(--color-text)" }}>{value}</div>
    </div>
  );
}
