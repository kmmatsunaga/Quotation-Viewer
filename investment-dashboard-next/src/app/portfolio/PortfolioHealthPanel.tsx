"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

type FactorGrade = "A+" | "A" | "B+" | "B" | "C" | "D" | "F";

interface FactorScore {
  grade: FactorGrade;
  raw: number;
}

interface FutureScoreResp {
  ticker: string;
  name: string;
  factors: {
    value: FactorScore;
    growth: FactorScore;
    profitability: FactorScore;
    momentum: FactorScore;
    epsRevisions: FactorScore;
  };
  overall: { raw: number; grade: FactorGrade; verdict: string; label: string };
  flags: {
    valueTrap: boolean;
    growthEmerging: boolean;
    overhyped: boolean;
    cappedBy: string | null;
  };
  analyst?: { targetMeanPrice: number | null; upsidePct: number | null; netRevisions30d: number | null } | null;
  disclosures?: { score: number; eventCount: number; hasCriticalNegative: boolean } | null;
  sentiment?: { finalScore: number; label: string; articleCount: number } | null;
}

interface Props {
  tickers: string[];           // ユニーク銘柄リスト
  tickerNames: Record<string, string>;  // ticker -> 日本語名
  totalValueByTicker: Record<string, number>;  // ticker -> 評価額 (JPY)
}

function gradeColor(grade: FactorGrade | undefined): string {
  if (!grade) return "var(--color-text-secondary)";
  if (grade === "A+" || grade === "A") return "#22c55e";
  if (grade === "B+" || grade === "B") return "#7fffd4";
  if (grade === "C") return "#facc15";
  if (grade === "D") return "#fb923c";
  return "#ef4444";
}

export default function PortfolioHealthPanel({ tickers, tickerNames, totalValueByTicker }: Props) {
  const router = useRouter();
  const [scores, setScores] = useState<Record<string, FutureScoreResp>>({});
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  useEffect(() => {
    if (tickers.length === 0) return;
    let cancelled = false;
    setLoading(true);
    setProgress({ done: 0, total: tickers.length });

    // 5並列で取得
    (async () => {
      const result: Record<string, FutureScoreResp> = {};
      const BATCH = 5;
      for (let i = 0; i < tickers.length; i += BATCH) {
        if (cancelled) return;
        const batch = tickers.slice(i, i + BATCH);
        const results = await Promise.all(
          batch.map((t) =>
            fetch(`/api/stocks/future-score/${encodeURIComponent(t)}`)
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
          )
        );
        for (let j = 0; j < batch.length; j++) {
          if (results[j]) result[batch[j]] = results[j];
        }
        setProgress({ done: Math.min(i + BATCH, tickers.length), total: tickers.length });
        setScores({ ...result });
      }
      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [tickers]);

  const summary = useMemo(() => {
    const scoreList = Object.values(scores);
    if (scoreList.length === 0) return null;

    const totalValue = Object.values(totalValueByTicker).reduce((a, b) => a + b, 0);

    // 評価額加重平均スコア
    let weightedSum = 0;
    let totalW = 0;
    for (const s of scoreList) {
      const w = totalValueByTicker[s.ticker] ?? 0;
      if (w > 0) {
        weightedSum += s.overall.raw * w;
        totalW += w;
      }
    }
    const weightedAvg = totalW > 0 ? weightedSum / totalW : 0;

    const simpleAvg = scoreList.reduce((a, b) => a + b.overall.raw, 0) / scoreList.length;

    const valueTraps = scoreList.filter((s) => s.flags.valueTrap);
    const overhyped = scoreList.filter((s) => s.flags.overhyped);
    const growthEmerging = scoreList.filter((s) => s.flags.growthEmerging);
    const criticalDisclosures = scoreList.filter((s) => s.disclosures?.hasCriticalNegative);
    const negativeSentiment = scoreList.filter((s) => s.sentiment && s.sentiment.finalScore <= -15);

    // バケツ分布
    const buckets = {
      excellent: scoreList.filter((s) => s.overall.raw >= 75).length,
      good: scoreList.filter((s) => s.overall.raw >= 60 && s.overall.raw < 75).length,
      neutral: scoreList.filter((s) => s.overall.raw >= 45 && s.overall.raw < 60).length,
      weak: scoreList.filter((s) => s.overall.raw < 45).length,
    };

    return {
      totalValue,
      simpleAvg: Math.round(simpleAvg),
      weightedAvg: Math.round(weightedAvg),
      buckets,
      valueTraps,
      overhyped,
      growthEmerging,
      criticalDisclosures,
      negativeSentiment,
    };
  }, [scores, totalValueByTicker]);

  if (tickers.length === 0) return null;

  const sorted = Object.values(scores).sort((a, b) => {
    const av = totalValueByTicker[a.ticker] ?? 0;
    const bv = totalValueByTicker[b.ticker] ?? 0;
    return bv - av;
  });

  return (
    <div
      className="p-4 border space-y-3"
      style={{ ...MONO, borderColor: "var(--color-accent)", background: "rgba(0,240,255,0.04)" }}
    >
      {/* ヘッダ */}
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--color-text-secondary)]">
            // PORTFOLIO_HEALTH
          </div>
          <div className="text-sm font-bold text-[var(--color-accent)] mt-1">
            🔮 保有銘柄の将来性ヘルス
          </div>
        </div>
        <div className="text-[10px] text-[var(--color-text-secondary)]">
          {loading ? `分析中 ${progress.done}/${progress.total}` : `${Object.keys(scores).length} 銘柄分析済`}
        </div>
      </div>

      {/* サマリ */}
      {summary && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <Stat label="評価額加重スコア" value={`${summary.weightedAvg}/100`} color={summary.weightedAvg >= 60 ? "#22c55e" : summary.weightedAvg >= 45 ? "#facc15" : "#fb923c"} />
            <Stat label="単純平均スコア" value={`${summary.simpleAvg}/100`} color="#7fffd4" />
            <Stat label="🟢 強気銘柄" value={`${summary.buckets.excellent + summary.buckets.good}`} color="#22c55e" />
            <Stat label="🟠 弱気銘柄" value={`${summary.buckets.weak}`} color="#fb923c" />
          </div>

          {/* 警告セクション */}
          {(summary.valueTraps.length > 0 ||
            summary.overhyped.length > 0 ||
            summary.criticalDisclosures.length > 0 ||
            summary.negativeSentiment.length > 0) && (
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase text-[var(--color-text-secondary)]">⚠ 警告</div>
              {summary.criticalDisclosures.length > 0 && (
                <WarningRow
                  icon="🚨"
                  color="#ef4444"
                  label="重大開示 (不祥事/訴訟)"
                  items={summary.criticalDisclosures.map((s) => `${s.ticker} ${s.name}`)}
                />
              )}
              {summary.valueTraps.length > 0 && (
                <WarningRow
                  icon="🚨"
                  color="#ef4444"
                  label="バリュートラップ"
                  items={summary.valueTraps.map((s) => `${s.ticker} ${s.name}`)}
                />
              )}
              {summary.overhyped.length > 0 && (
                <WarningRow
                  icon="🔥"
                  color="#fb923c"
                  label="過熱気味 (目標株価超過)"
                  items={summary.overhyped.map((s) => `${s.ticker} ${s.name}`)}
                />
              )}
              {summary.negativeSentiment.length > 0 && (
                <WarningRow
                  icon="📰"
                  color="#fb923c"
                  label="ネガティブニュース感情"
                  items={summary.negativeSentiment.map((s) => `${s.ticker} ${s.name}`)}
                />
              )}
            </div>
          )}

          {/* グロース早期発見 */}
          {summary.growthEmerging.length > 0 && (
            <div className="space-y-1.5">
              <WarningRow
                icon="🌱"
                color="#7fffd4"
                label="グロース早期発見"
                items={summary.growthEmerging.map((s) => `${s.ticker} ${s.name}`)}
              />
            </div>
          )}
        </>
      )}

      {/* 銘柄テーブル */}
      {sorted.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] mt-2">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-[var(--color-text-secondary)] text-[10px] uppercase">
                <th className="text-left py-1.5 pr-2">銘柄</th>
                <th className="text-center px-1">総合</th>
                <th className="text-center px-1">V</th>
                <th className="text-center px-1">G</th>
                <th className="text-center px-1">P</th>
                <th className="text-center px-1">M</th>
                <th className="text-center px-1">E</th>
                <th className="text-right pl-2">フラグ</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr
                  key={s.ticker}
                  className="border-b border-[var(--color-border)]/30 hover:bg-[var(--color-accent)]/5 cursor-pointer"
                  onClick={() => router.push(`/stock/${s.ticker}`)}
                >
                  <td className="py-1.5 pr-2">
                    <span className="text-[var(--color-accent)] font-bold">{s.ticker}</span>
                    <span className="text-[var(--color-text)] ml-1">{tickerNames[s.ticker] ?? s.name}</span>
                  </td>
                  <td className="text-center px-1">
                    <span style={{ color: gradeColor(s.overall.grade), fontWeight: "bold" }}>
                      {s.overall.raw}
                    </span>
                  </td>
                  <td className="text-center px-1" style={{ color: gradeColor(s.factors.value.grade) }}>
                    {s.factors.value.grade}
                  </td>
                  <td className="text-center px-1" style={{ color: gradeColor(s.factors.growth.grade) }}>
                    {s.factors.growth.grade}
                  </td>
                  <td className="text-center px-1" style={{ color: gradeColor(s.factors.profitability.grade) }}>
                    {s.factors.profitability.grade}
                  </td>
                  <td className="text-center px-1" style={{ color: gradeColor(s.factors.momentum.grade) }}>
                    {s.factors.momentum.grade}
                  </td>
                  <td className="text-center px-1" style={{ color: gradeColor(s.factors.epsRevisions.grade) }}>
                    {s.factors.epsRevisions.grade}
                  </td>
                  <td className="text-right pl-2 text-[10px]">
                    {s.flags.valueTrap && <span title="バリュートラップ">🚨</span>}
                    {s.flags.overhyped && <span title="過熱気味">🔥</span>}
                    {s.flags.growthEmerging && <span title="グロース早期発見">🌱</span>}
                    {s.disclosures?.hasCriticalNegative && <span title="重大開示">⚠</span>}
                    {s.sentiment && s.sentiment.finalScore <= -15 && <span title="ネガ感情">📰⬇</span>}
                    {s.sentiment && s.sentiment.finalScore >= 15 && <span title="ポジ感情">📰⬆</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: "rgba(0,0,0,0.3)", padding: "8px 10px" }}>
      <div className="text-[9px] uppercase text-[var(--color-text-secondary)]">{label}</div>
      <div className="text-base font-bold" style={{ color, ...MONO }}>
        {value}
      </div>
    </div>
  );
}

function WarningRow({ icon, color, label, items }: { icon: string; color: string; label: string; items: string[] }) {
  return (
    <div className="flex items-start gap-2 text-[11px]" style={{ color }}>
      <span className="shrink-0">{icon}</span>
      <span className="font-bold shrink-0">{label}:</span>
      <span className="text-[var(--color-text)]">{items.join(", ")}</span>
    </div>
  );
}
