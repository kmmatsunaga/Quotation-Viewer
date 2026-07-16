"use client";

/**
 * /briefing — ☀ 今日の変化
 *
 * 「開いて10秒で今日見るべきものが分かる」画面。
 * 前日から変わったものだけを表示する。変化がなければ「変化なし」と堂々と言う。
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface Transition {
  driver: string;
  direction: string;
  emoji: string;
  message: string;
}

interface VerdictChange {
  ticker: string;
  name?: string;
  tf: "short" | "mid" | "long";
  from: string;
  to: string;
  conviction: number;
}

interface Mover {
  ticker: string;
  name: string;
  market: string;
  overallFrom: number;
  overallTo: number;
  delta: number;
}

interface DaytradeCandidate {
  ticker: string;
  name: string;
  weight: number;
  reasons: string[];
  hint: "long" | "short" | "both";
  consistency: number;                      // 材料の方向一貫性 0-100
  boardCheck: "agree" | "conflict" | null;  // 今朝の気配との整合
  lastPrice: number | null;
}

interface BriefingResp {
  ok: boolean;
  generatedAtIso: string;
  hasAnything: boolean;
  macro: { transitions: Transition[]; dates: { today: string; prev: string } | null };
  verdicts: { changes: VerdictChange[]; dates: { today: string; prev: string } | null };
  movers: { up: Mover[]; down: Mover[]; dates: { today: string; prev: string } | null };
  error?: string;
}

const TF_LABEL: Record<string, string> = { short: "短期", mid: "中期", long: "長期" };

const STANCE: Record<string, { label: string; color: string }> = {
  strong_bull: { label: "強気", color: "#ff3b6b" },
  bull: { label: "やや強気", color: "#ff7a9c" },
  neutral: { label: "中立", color: "#facc15" },
  bear: { label: "やや弱気", color: "#5ce1ff" },
  strong_bear: { label: "弱気", color: "#00d9ff" },
  contested: { label: "⚡対立", color: "#a78bfa" },
};

function fmtDate(d?: string): string {
  if (!d || d.length !== 8) return "—";
  return `${d.slice(4, 6)}/${d.slice(6, 8)}`;
}

const LS_WARROOM_WATCHLIST = "cavka_warroom_watchlist";

/** JST の時間帯コンテキスト: 玄関の顔を変える */
type DayContext = "morning" | "market" | "evening" | "weekend";
function dayContext(): DayContext {
  const now = new Date();
  const jst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60 * 1000);
  const day = jst.getDay();
  if (day === 0 || day === 6) return "weekend";
  const mins = jst.getHours() * 60 + jst.getMinutes();
  if (mins >= 8 * 60 + 55 && mins <= 15 * 60 + 35) return "market";
  if (mins < 8 * 60 + 55) return "morning";
  return "evening";
}

export default function BriefingPage() {
  const router = useRouter();
  const [data, setData] = useState<BriefingResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [longCands, setLongCands] = useState<DaytradeCandidate[]>([]);
  const [shortCands, setShortCands] = useState<DaytradeCandidate[]>([]);
  const [boardChecked, setBoardChecked] = useState(false);
  const [showShorts, setShowShorts] = useState(false);
  const [warroomTickers, setWarroomTickers] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/briefing")
      .then((r) => r.json())
      .then((j: BriefingResp) => { setData(j); setLoading(false); })
      .catch(() => setLoading(false));
    // デイトレ候補 (別枠で非同期に)
    fetch("/api/daytrade-candidates")
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok) return;
        setLongCands(j.longs ?? []);
        setShortCands(j.shorts ?? []);
        setBoardChecked(!!j.boardChecked);
      })
      .catch(() => {});
    // ウォールーム監視リストの現状
    try {
      const saved = JSON.parse(localStorage.getItem(LS_WARROOM_WATCHLIST) ?? "[]");
      if (Array.isArray(saved)) setWarroomTickers(new Set(saved));
    } catch {}
  }, []);

  const sendToWarroom = (tickers: string[]) => {
    try {
      const saved: string[] = JSON.parse(localStorage.getItem(LS_WARROOM_WATCHLIST) ?? "[]");
      const merged = Array.from(new Set([...saved, ...tickers]));
      localStorage.setItem(LS_WARROOM_WATCHLIST, JSON.stringify(merged));
      setWarroomTickers(new Set(merged));
    } catch {}
  };

  if (loading) {
    return <div className="text-center py-20 text-[15px] text-[var(--color-text-secondary)]">☀ 変化を確認中...</div>;
  }
  if (!data?.ok) {
    return <div className="text-center py-20 text-sm text-red-400" style={MONO}>⚠ {data?.error ?? "取得失敗"}</div>;
  }

  const ctx = dayContext();

  return (
    <div className="space-y-6 max-w-4xl">
      {/* ヘッダ */}
      <div>
        <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">
          ☀ 今日の変化
        </h1>
        <p className="text-[14px] text-[var(--color-text-secondary)] mt-1.5 leading-relaxed">
          前日から変わったものだけ。変化がなければ、それも一つの情報。
        </p>
      </div>

      {/* 時間帯コンテキスト: 玄関はいま何をすべきかを知っている */}
      {ctx === "market" && (
        <button
          onClick={() => router.push("/warroom")}
          className="w-full p-4 border text-left flex items-center gap-4 hover:brightness-110 transition-all"
          style={{ borderColor: "rgba(0,240,255,0.5)", background: "rgba(0,240,255,0.06)", boxShadow: "0 0 18px rgba(0,240,255,0.15)" }}
        >
          <span className="text-3xl">⚔</span>
          <span>
            <span className="block text-[17px] font-bold text-[var(--color-accent)]">場中です — ウォールームへ</span>
            <span className="block text-[13px] text-[var(--color-text-secondary)] mt-1 leading-relaxed">板圧・VWAP・日足形状を15秒間隔で監視。作戦会議はここまで、ここからは戦闘。</span>
          </span>
          <span className="ml-auto text-xl text-[var(--color-accent)]">→</span>
        </button>
      )}
      {ctx === "evening" && (
        <button
          onClick={() => router.push("/journal")}
          className="w-full p-4 border text-left flex items-center gap-4 hover:brightness-110 transition-all"
          style={{ borderColor: "rgba(255,43,214,0.4)", background: "rgba(255,43,214,0.05)" }}
        >
          <span className="text-3xl">📓</span>
          <span>
            <span className="block text-[17px] font-bold text-[var(--color-accent-2)]">引け後です — 今日の記録を</span>
            <span className="block text-[13px] text-[var(--color-text-secondary)] mt-1 leading-relaxed">今日のトレードをジャーナルへ。根拠タグを付けるのは記憶が新しい今が一番正確。</span>
          </span>
          <span className="ml-auto text-xl text-[var(--color-accent-2)]">→</span>
        </button>
      )}
      {ctx === "weekend" && (
        <button
          onClick={() => router.push("/accuracy")}
          className="w-full p-4 border text-left flex items-center gap-4 hover:brightness-110 transition-all"
          style={{ borderColor: "rgba(167,139,250,0.4)", background: "rgba(167,139,250,0.05)" }}
        >
          <span className="text-3xl">🎯</span>
          <span>
            <span className="block text-[17px] font-bold" style={{ color: "#a78bfa" }}>週末です — 答え合わせの時間</span>
            <span className="block text-[13px] text-[var(--color-text-secondary)] mt-1 leading-relaxed">Cavka の的中率と、ジャーナルの自分の成績を見返す。来週の作戦はそれから。</span>
          </span>
          <span className="ml-auto text-xl" style={{ color: "#a78bfa" }}>→</span>
        </button>
      )}

      {!data.hasAnything && (
        <div className="p-6 border text-center" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
          <div className="text-4xl mb-2">😌</div>
          <div className="text-[15px] text-[var(--color-text)] leading-relaxed">
            前日から大きな変化はありません。<br />
            <span className="text-[13px] text-[var(--color-text-secondary)]">マクロ遷移なし・評決の変化なし・スコア急変なし。平常運転の日です。</span>
          </div>
        </div>
      )}

      {/* 1. マクロ遷移 */}
      {data.macro.transitions.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[17px] font-bold text-[var(--color-text)]">
            🌍 マクロ遷移 <span className="text-[12px] text-[var(--color-text-secondary)] font-normal" style={MONO}>({fmtDate(data.macro.dates?.prev)} → {fmtDate(data.macro.dates?.today)})</span>
          </h2>
          {data.macro.transitions.map((t, i) => (
            <button
              key={i}
              onClick={() => router.push("/macro-watch")}
              className="w-full text-left p-3 border flex items-start gap-3 hover:brightness-110 transition-all"
              style={{ borderColor: "rgba(167,139,250,0.4)", background: "rgba(167,139,250,0.06)" }}
            >
              <span className="text-2xl">{t.emoji}</span>
              <span className="text-[14px] text-[var(--color-text)] leading-relaxed">{t.message}</span>
            </button>
          ))}
        </section>
      )}

      {/* 2. 評決の変化 */}
      {data.verdicts.changes.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[17px] font-bold text-[var(--color-text)]">
            ⚖ 評決が変わった銘柄 <span className="text-[12px] opacity-60 font-normal">(保有 + お気に入り)</span>
          </h2>
          <div className="space-y-1.5">
            {data.verdicts.changes.map((c, i) => {
              const from = STANCE[c.from] ?? { label: c.from, color: "var(--color-text)" };
              const to = STANCE[c.to] ?? { label: c.to, color: "var(--color-text)" };
              const isContested = c.to === "contested";
              const worsened = ["bear", "strong_bear"].includes(c.to);
              return (
                <button
                  key={i}
                  data-ticker={c.ticker}
                  onClick={() => router.push(`/stock/${c.ticker}`)}
                  className="w-full text-left p-3 border flex items-center gap-3 flex-wrap hover:brightness-110 transition-all"
                  style={{
                    borderColor: isContested ? "rgba(167,139,250,0.5)" : worsened ? "rgba(239,68,68,0.4)" : "rgba(34,197,94,0.35)",
                    background: isContested ? "rgba(167,139,250,0.06)" : worsened ? "rgba(239,68,68,0.05)" : "rgba(34,197,94,0.04)",
                  }}
                >
                  <span className="flex flex-col leading-tight min-w-0">
                    {c.name && c.name !== c.ticker && (
                      <span className="text-sm font-bold text-[var(--color-text)] truncate max-w-[150px]">{c.name}</span>
                    )}
                    <span className="text-[10px] text-[var(--color-accent)]" style={MONO}>{c.ticker}</span>
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 border border-[var(--color-border)] text-[var(--color-text-secondary)]" style={MONO}>
                    {TF_LABEL[c.tf]}
                  </span>
                  <span className="text-sm" style={MONO}>
                    <span style={{ color: from.color }}>{from.label}</span>
                    <span className="text-[var(--color-text-secondary)] mx-2">→</span>
                    <span className="font-bold" style={{ color: to.color }}>{to.label}</span>
                  </span>
                  <span className="text-[10px] text-[var(--color-text-secondary)] ml-auto" style={MONO}>
                    確信 {c.conviction}%
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* 2.5. 今日のデイトレ候補 (v2: 買い/売り分離 + 一貫性 + 気配照合) */}
      {(longCands.length > 0 || shortCands.length > 0) && (
        <section className="space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-[17px] font-bold text-[var(--color-text)]">
              ⚔ 今日のデイトレ候補
              <span className="hidden sm:inline text-[12px] opacity-60 font-normal ml-1.5">
                (スコア急変 × セクター熱 × 前日出来高/足形{boardChecked ? " × 今朝の気配" : ""})
              </span>
            </h2>
            <div className="flex gap-2">
              <button
                onClick={() => sendToWarroom(longCands.map((c) => c.ticker))}
                className="px-3 py-1 text-xs"
                style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)", ...MONO }}
              >
                買い候補をウォールームへ
              </button>
              <button
                onClick={() => router.push("/warroom")}
                className="px-3 py-1 text-xs"
                style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", ...MONO }}
              >
                ⚔ 開く
              </button>
            </div>
          </div>

          {/* 🟢 買い候補 (主戦場) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {longCands.map((c) => (
              <CandidateCard key={c.ticker} c={c} inWarroom={warroomTickers.has(c.ticker)}
                onSend={() => sendToWarroom([c.ticker])} onOpen={() => router.push(`/stock/${c.ticker}`)} />
            ))}
          </div>

          {/* 🔴 売り候補 (空売り向け、折りたたみ) */}
          {shortCands.length > 0 && (
            <div>
              <button onClick={() => setShowShorts(!showShorts)} className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]" style={MONO}>
                {showShorts ? "▼" : "▶"} 🔴 売り (空売り) 候補 {shortCands.length}件 — 信用取引をやる時だけ
              </button>
              {showShorts && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
                  {shortCands.map((c) => (
                    <CandidateCard key={c.ticker} c={c} inWarroom={warroomTickers.has(c.ticker)}
                      onSend={() => sendToWarroom([c.ticker])} onOpen={() => router.push(`/stock/${c.ticker}`)} />
                  ))}
                </div>
              )}
            </div>
          )}

          <p className="text-[9px] text-[var(--color-text-secondary)] opacity-60" style={MONO}>
            ※ 候補 = 監視する価値がある銘柄であって買い推奨ではない。一貫性 = 材料の方向がどれだけ揃っているか (低い = 矛盾あり、監視のみ)。
            {boardChecked && " ✓/⚠ = 今朝の板気配との整合。"}判断は場中の板とVWAPで。
          </p>
        </section>
      )}

      {/* 3. スコア急変 */}
      {(data.movers.up.length > 0 || data.movers.down.length > 0) && (
        <section className="space-y-2">
          <h2 className="text-[17px] font-bold text-[var(--color-text)]">
            📊 スコア急変 <span className="text-[12px] opacity-60 font-normal">(全銘柄、変化±8pt以上)</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <MoverList title="⬆ 急上昇" movers={data.movers.up} color="#22c55e" onClick={(t) => router.push(`/stock/${t}`)} />
            <MoverList title="⬇ 急降下" movers={data.movers.down} color="#ef4444" onClick={(t) => router.push(`/stock/${t}`)} />
          </div>
        </section>
      )}

      {/* フッタ */}
      <div className="text-[11px] text-[var(--color-text-secondary)] opacity-70 leading-relaxed">
        生成: {new Date(data.generatedAtIso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} ·
        マクロは毎朝 JST 07:00、評決は JST 01:30、スコアは JST 01:00 に更新
      </div>
    </div>
  );
}

function CandidateCard({ c, inWarroom, onSend, onOpen }: {
  c: DaytradeCandidate;
  inWarroom: boolean;
  onSend: () => void;
  onOpen: () => void;
}) {
  const isLong = c.hint === "long";
  const hintColor = isLong ? "var(--color-up)" : c.hint === "short" ? "var(--color-down)" : "#facc15";
  const lowConsistency = c.consistency < 60;
  const border =
    c.boardCheck === "conflict" || lowConsistency
      ? "rgba(251,191,36,0.5)"
      : c.boardCheck === "agree"
      ? `${isLong ? "rgba(255,59,107,0.45)" : "rgba(0,217,255,0.45)"}`
      : "var(--color-border)";
  return (
    <div data-ticker={c.ticker} className="p-3 border space-y-1.5" style={{ borderColor: border, background: "var(--bg-card)" }}>
      {/* 銘柄名を主役に (1行占有) */}
      <button onClick={onOpen} className="flex items-baseline gap-2 w-full text-left min-w-0">
        <span className="text-sm font-bold text-[var(--color-text)] truncate">{c.name || c.ticker}</span>
        <span className="text-[10px] text-[var(--color-accent)] shrink-0" style={MONO}>{c.ticker}</span>
      </button>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[9px] px-1.5 py-0.5" style={{ ...MONO, border: `1px solid ${hintColor}`, color: hintColor }}>
          {isLong ? "🟢 買い" : c.hint === "short" ? "🔴 空売り" : "🟡 両にらみ"}
        </span>
        {/* 一貫性: 材料がどれだけ同じ方向を向いているか */}
        <span
          className="text-[9px] px-1.5 py-0.5"
          title="材料の方向一貫性。低い = 強気と弱気の材料が混在"
          style={{ ...MONO, border: "1px solid var(--color-border)", color: lowConsistency ? "#fbbf24" : "var(--color-text-secondary)" }}
        >
          一貫{c.consistency}%{lowConsistency ? "⚠" : ""}
        </span>
        {c.boardCheck === "agree" && (
          <span className="text-[9px] px-1.5 py-0.5 font-bold" style={{ ...MONO, background: "rgba(34,197,94,0.12)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.4)" }}>
            ✓ 気配一致
          </span>
        )}
        {c.boardCheck === "conflict" && (
          <span className="text-[9px] px-1.5 py-0.5 font-bold" style={{ ...MONO, background: "rgba(251,191,36,0.12)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.5)" }}>
            ⚠ 気配は逆
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>注目度 {c.weight}</span>
          <button
            onClick={onSend}
            disabled={inWarroom}
            className="px-2 py-0.5 text-[10px] disabled:opacity-40"
            style={{ ...MONO, border: `1px solid ${inWarroom ? "var(--color-border)" : "var(--color-accent)"}`, color: inWarroom ? "var(--color-text-secondary)" : "var(--color-accent)" }}
          >
            {inWarroom ? "✓ 監視中" : "⚔ 送る"}
          </button>
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {c.reasons.map((r, i) => (
          <span key={i} className="text-[11px] px-2 py-1" style={{ background: r.startsWith("⚠") ? "rgba(251,191,36,0.08)" : "rgba(0,240,255,0.06)", color: r.startsWith("⚠") ? "#fbbf24" : "var(--color-text)", border: `1px solid ${r.startsWith("⚠") ? "rgba(251,191,36,0.3)" : "rgba(0,240,255,0.2)"}` }}>
            {r}
          </span>
        ))}
      </div>
    </div>
  );
}

function MoverList({ title, movers, color, onClick }: {
  title: string;
  movers: Mover[];
  color: string;
  onClick: (ticker: string) => void;
}) {
  if (movers.length === 0) return null;
  return (
    <div className="p-3 border space-y-1.5" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
      <div className="text-[15px] font-bold" style={{ color }}>{title}</div>
      {movers.map((m) => (
        <button
          key={m.ticker}
          data-ticker={m.ticker}
          onClick={() => onClick(m.ticker)}
          className="w-full text-left flex items-center gap-2 py-2 min-h-[44px] hover:brightness-125 transition-all"
        >
          <span className="text-[9px] px-1 py-0.5" style={{ background: m.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)", color: m.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)", ...MONO }}>
            {m.market}
          </span>
          <span className="text-[13px] text-[var(--color-text)] truncate flex-1 min-w-0">{m.name || m.ticker}</span>
          <span className="text-[11px] text-[var(--color-accent)]" style={MONO}>{m.ticker}</span>
          <span className="text-xs ml-1" style={MONO}>
            {m.overallFrom} → <strong>{m.overallTo}</strong>
            <span className="ml-1.5 font-black" style={{ color }}>
              {m.delta > 0 ? "+" : ""}{m.delta}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
