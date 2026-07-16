"use client";

/**
 * 🔬 今日の動きの理由 — なぜ動いたかエンジン (Phase 1) の表示パネル
 *
 * 当日リターンの3層分解 (地合い / セクター / 個別) + 証拠 + Gemini 説明文。
 * 誠実の原則: 個別要因が小さい時は「連動しただけ」と表示する。
 */

import { useEffect, useState } from "react";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };
const UP = "var(--color-up)";
const DOWN = "var(--color-down)";

interface WhyResp {
  ok?: boolean;
  error?: string;
  date: string;
  todayRetPct: number;
  nikkeiPct: number;
  beta: number;
  breakdown: { market: number; sector: number; individual: number };
  sector: string | null;
  sectorAvgPct: number | null;
  volumeRatio: number | null;
  dominant: "market" | "sector" | "individual" | "noise";
  narrative: string | null;
  evidenceDetail: { kind: string; label: string; detail: string; impact?: string }[];
}

const DOMINANT_META = {
  market: { label: "地合い連動", emoji: "🌊", desc: "日経平均への連動が主因。銘柄固有の話ではない" },
  sector: { label: "セクター連動", emoji: "🏭", desc: "業種全体の動きが主因。銘柄固有の話ではない" },
  individual: { label: "個別要因", emoji: "🎯", desc: "この銘柄固有の何かが動かした" },
  noise: { label: "小動き (特段の材料なし)", emoji: "😴", desc: "どの要因も小さい平常日。無理に理由を探さないのが正解" },
};

export default function WhyMovedPanel({ ticker }: { ticker: string }) {
  const [data, setData] = useState<WhyResp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    fetch(`/api/stocks/why?ticker=${ticker}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) { setData(j); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ticker]);

  if (loading) {
    return (
      <div className="p-4 border" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
        <div className="text-[13px] text-[var(--color-text-secondary)]">🔬 今日の動きを分解中…</div>
      </div>
    );
  }
  if (!data?.ok) return null; // データ不足時は静かに消える (米国株など)

  const meta = DOMINANT_META[data.dominant];
  const parts = [
    { key: "market", label: `🌊 地合い (日経${data.nikkeiPct >= 0 ? "+" : ""}${data.nikkeiPct}% × β${data.beta})`, v: data.breakdown.market },
    { key: "sector", label: `🏭 セクター${data.sector ? ` (${data.sector})` : ""}`, v: data.breakdown.sector },
    { key: "individual", label: "🎯 個別要因", v: data.breakdown.individual },
  ];
  const maxAbs = Math.max(0.5, ...parts.map((p) => Math.abs(p.v)));

  return (
    <div className="p-4 border space-y-3" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-[16px] font-bold text-[var(--color-text)]">🔬 今日の動きの理由</h3>
        <span className="text-[12px]" style={MONO}>
          <span className="font-black text-[15px]" style={{ color: data.todayRetPct >= 0 ? UP : DOWN }}>
            {data.todayRetPct >= 0 ? "+" : ""}{data.todayRetPct}%
          </span>
          <span className="text-[var(--color-text-secondary)] ml-1.5">({data.date.slice(5)})</span>
        </span>
      </div>

      {/* 主因バッジ */}
      <div className="text-[13px] px-2.5 py-1.5 border-l-4 leading-relaxed" style={{
        borderColor: data.dominant === "individual" ? "var(--color-accent)" : "var(--color-border)",
        background: data.dominant === "individual" ? "rgba(0,240,255,0.06)" : "rgba(255,255,255,0.02)",
        color: "var(--color-text)",
      }}>
        <strong>{meta.emoji} 主因: {meta.label}</strong>
        <span className="text-[var(--color-text-secondary)] ml-2 text-[12px]">{meta.desc}</span>
      </div>

      {/* 3層分解バー */}
      <div className="space-y-1.5">
        {parts.map((p) => {
          const w = Math.min(100, (Math.abs(p.v) / maxAbs) * 100);
          const color = p.v >= 0 ? UP : DOWN;
          return (
            <div key={p.key} className="flex items-center gap-2">
              <span className="text-[11px] text-[var(--color-text-secondary)] w-[190px] shrink-0 truncate">{p.label}</span>
              <div className="flex-1 h-4 relative" style={{ background: "rgba(255,255,255,0.04)" }}>
                <div className="absolute top-0 h-4" style={{ width: `${w}%`, background: `${color}55`, borderRight: `2px solid ${color}` }} />
              </div>
              <span className="text-[12px] font-bold w-[62px] text-right shrink-0" style={{ ...MONO, color }}>
                {p.v >= 0 ? "+" : ""}{p.v}%
              </span>
            </div>
          );
        })}
      </div>

      {/* 説明文 */}
      {data.narrative && (
        <p className="text-[13px] text-[var(--color-text)] leading-relaxed pt-1 border-t border-[var(--color-border)]">
          {data.narrative}
        </p>
      )}

      {/* 証拠 */}
      {data.evidenceDetail.length > 0 && (
        <div className="space-y-1">
          {data.evidenceDetail.slice(0, 5).map((e, i) => (
            <div key={i} className="text-[11px] flex items-start gap-1.5 leading-relaxed">
              <span className="shrink-0 px-1 border text-[10px]" style={{
                ...MONO,
                borderColor: e.impact === "positive" ? "rgba(255,59,107,0.4)" : e.impact === "negative" ? "rgba(0,217,255,0.4)" : "var(--color-border)",
                color: e.impact === "positive" ? UP : e.impact === "negative" ? DOWN : "var(--color-text-secondary)",
              }}>{e.label}</span>
              <span className="text-[var(--color-text-secondary)]">{e.detail}</span>
            </div>
          ))}
        </div>
      )}

      <p className="text-[10px] text-[var(--color-text-secondary)] opacity-60 leading-relaxed">
        ※ β分解による推定。個別要因が±1%未満の日は「特段の材料なし」が正直な答えです (相場の大半はノイズ)。
      </p>
    </div>
  );
}
