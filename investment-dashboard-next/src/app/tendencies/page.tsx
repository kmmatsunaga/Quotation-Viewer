"use client";

/**
 * /tendencies — 🔍 デイトレ傾向 (法則発見エンジン)
 *
 * 「必勝の鉄則」は無い。あるのは、データが示す傾向と、その賞味期限だけ。
 * 効かない仮説は「効かない」と表示する — それもまた武器。
 */

import { useEffect, useState } from "react";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface HypoLine { label: string; value: string; strength?: number }
interface Hypothesis { id: string; title: string; lines: HypoLine[]; verdict: string }
interface Report {
  ok: boolean;
  cached?: boolean;
  universe: number;
  dayCount: number;
  hypotheses: Hypothesis[];
  note: string;
  computedAtIso: string;
  error?: string;
}

function verdictColor(v: string): string {
  if (v.startsWith("✅")) return "#22c55e";
  if (v.startsWith("❌")) return "#ef4444";
  if (v.startsWith("⚠")) return "#fbbf24";
  if (v.startsWith("❓")) return "var(--color-text-secondary)";
  return "#facc15";
}

export default function TendenciesPage() {
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = (fresh = false) => {
    if (fresh) setRefreshing(true);
    else setLoading(true);
    fetch(`/api/tendencies${fresh ? "?fresh=1" : ""}`)
      .then((r) => r.json())
      .then((j: Report) => setData(j))
      .finally(() => { setLoading(false); setRefreshing(false); });
  };

  useEffect(() => { load(); }, []);

  if (loading) {
    return (
      <div className="text-center py-20 text-sm text-[var(--color-text)]" style={MONO}>
        🔍 直近60日 × 50銘柄の5分足を分析中... (初回は1〜2分かかります)
      </div>
    );
  }
  if (!data?.ok) {
    return <div className="text-center py-20 text-sm text-red-400" style={MONO}>⚠ {data?.error ?? "取得失敗"}</div>;
  }

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">🔍 デイトレ傾向 — 法則発見エンジン</h1>
          <p className="text-[14px] text-[var(--color-text-secondary)] mt-1.5 leading-relaxed">
            日経225主要{data.universe}銘柄 × 直近60日の5分足で、古典仮説を検証した結果。
            銘柄日ベース n={data.dayCount.toLocaleString()}。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
            計算: {new Date(data.computedAtIso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            {data.cached ? " (キャッシュ)" : ""}
          </span>
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="px-3 py-1.5 text-xs disabled:opacity-50"
            style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)", ...MONO }}
          >
            {refreshing ? "再計算中..." : "🔄 再計算"}
          </button>
        </div>
      </div>

      {data.hypotheses.map((h) => (
        <div key={h.id} className="p-4 border space-y-3" style={{ borderColor: `${verdictColor(h.verdict)}55`, background: "var(--bg-card)" }}>
          <div className="text-sm font-bold text-[var(--color-text)]" style={MONO}>{h.title}</div>
          <div className="space-y-1.5">
            {h.lines.map((l, i) => (
              <div key={i} className="flex items-center justify-between gap-3 flex-wrap" style={MONO}>
                <span className="text-xs text-[var(--color-text-secondary)] w-32 shrink-0">{l.label}</span>
                <span className="text-sm font-bold text-[var(--color-text)] flex-1">{l.value}</span>
                {l.strength !== undefined && (
                  <span className="text-xs" style={{ color: l.strength >= 0.9 ? "#ef4444" : l.strength >= 0.6 ? "#fbbf24" : "var(--color-text-secondary)" }}>
                    {"█".repeat(Math.max(1, Math.round(l.strength * 8)))}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="text-sm font-bold p-2 border-l-4" style={{ ...MONO, color: verdictColor(h.verdict), borderColor: verdictColor(h.verdict), background: `${verdictColor(h.verdict)}0d` }}>
            {h.verdict}
          </div>
        </div>
      ))}

      <div className="text-[10px] text-[var(--color-text-secondary)] opacity-70 leading-relaxed" style={MONO}>
        ⚠ {data.note}<br />
        ※ 傾向は過去の集計であって予言ではない。市場が変われば消える。だからこのページは毎日再計算できる。<br />
        ※ 次フェーズ: ウォールームの板圧・VWAP観測を蓄積し、「Cavka にしか検証できない仮説」を増やしていく。
      </div>
    </div>
  );
}
