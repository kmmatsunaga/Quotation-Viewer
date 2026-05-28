"use client";

import { useEffect, useState } from "react";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

type FactorGrade = "A+" | "A" | "B+" | "B" | "C" | "D" | "F";

interface FactorScore {
  raw: number;
  grade: FactorGrade;
  reasons: string[];
}

interface FutureScoreData {
  ticker: string;
  name: string;
  price: number | null;
  factors: {
    value: FactorScore;
    growth: FactorScore;
    profitability: FactorScore;
    momentum: FactorScore;
    epsRevisions: FactorScore;
  };
  overall: {
    raw: number;
    rawUncapped: number;
    grade: FactorGrade;
    verdict: "buy" | "neutral" | "avoid";
    label: string;
    summary: string;
  };
  flags: {
    valueTrap: boolean;
    valueTrapReason: string | null;
    growthEmerging: boolean;
    growthEmergingReason: string | null;
    overhyped: boolean;
    overhypedReason: string | null;
    qualityGrowthRevoked: boolean;
    cappedBy: string | null;
  };
  analyst?: {
    targetMeanPrice: number | null;
    upsidePct: number | null;
    numberOfAnalysts: number | null;
    recommendationKey: string | null;
    recommendationMean: number | null;
    netRevisions30d: number | null;
  } | null;
  sentiment?: {
    finalScore: number;
    label: "very_positive" | "positive" | "neutral" | "negative" | "very_negative";
    articleCount: number;
    avgSentiment: number;
    diffusionCoef: number;
    computedAt: string;
    stale: boolean;
  } | null;
  disclosures?: {
    score: number;
    eventCount: number;
    hasCriticalNegative: boolean;
    latestUpRevision: { date: string; headline: string } | null;
    latestDownRevision: { date: string; headline: string } | null;
    counts: Record<string, number>;
    events: { newsId: string; date: string; type: string; headline: string; impact: string; weight: number }[];
  } | null;
  coverage: {
    available: string[];
    missing: string[];
    confidence: number;
    hasAnalystData: boolean;
    hasSentimentData: boolean;
    hasDisclosureData: boolean;
  };
}

const DISCLOSURE_LABEL: Record<string, string> = {
  earnings_revision_up: "📈 上方修正",
  earnings_revision_down: "📉 下方修正",
  dividend_up: "💴 増配",
  dividend_down: "💸 減配",
  buyback: "🔄 自社株買い",
  split: "🪓 株式分割",
  alliance: "🤝 業務提携",
  ma_acquirer: "🏢 M&A",
  ma_target: "💎 被買収",
  scandal: "🚨 不祥事",
  lawsuit: "⚖ 訴訟",
  other: "その他",
};

const FACTOR_LABELS: Record<string, string> = {
  value: "割安度",
  growth: "成長性",
  profitability: "収益力",
  momentum: "値動き",
  epsRevisions: "業績修正",
};

function gradeColor(grade: FactorGrade): string {
  switch (grade) {
    case "A+":
    case "A":
      return "#00f0ff";        // シアン (強)
    case "B+":
    case "B":
      return "#7fffd4";        // アクアグリーン
    case "C":
      return "#facc15";        // 黄
    case "D":
      return "#fb923c";        // オレンジ
    case "F":
      return "#ef4444";        // 赤
  }
}

function verdictBg(verdict: string, valueTrap: boolean): string {
  if (valueTrap) return "rgba(239,68,68,0.12)";
  if (verdict === "buy") return "rgba(0,240,255,0.10)";
  if (verdict === "avoid") return "rgba(251,146,60,0.10)";
  return "rgba(250,204,21,0.08)";
}

function verdictBorder(verdict: string, valueTrap: boolean): string {
  if (valueTrap) return "rgba(239,68,68,0.6)";
  if (verdict === "buy") return "var(--color-accent)";
  if (verdict === "avoid") return "rgba(251,146,60,0.6)";
  return "rgba(250,204,21,0.6)";
}

export default function FutureScorePanel({ ticker }: { ticker: string }) {
  const [data, setData] = useState<FutureScoreData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/stocks/future-score/${encodeURIComponent(ticker)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json: FutureScoreData) => {
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  if (loading) {
    return (
      <div className="p-4 border" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
        <div className="text-xs text-[var(--color-text-secondary)]" style={MONO}>
          // FUTURE_SCORE.LOADING ...
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4 border" style={{ borderColor: "rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.05)" }}>
        <div className="text-xs text-red-400" style={MONO}>
          // FUTURE_SCORE.ERROR: {error ?? "no data"}
        </div>
      </div>
    );
  }

  const { factors, overall, flags, coverage, analyst, sentiment, disclosures } = data;
  const bg = verdictBg(overall.verdict, flags.valueTrap);
  const border = verdictBorder(overall.verdict, flags.valueTrap);

  return (
    <div
      className="p-5 border"
      style={{
        background: bg,
        borderColor: border,
        boxShadow: `0 0 18px ${border}`,
      }}
    >
      {/* ヘッダー */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--color-text-secondary)]" style={MONO}>
            // FUTURE_SCORE.v1
          </div>
          <div className="text-xl font-bold mt-1" style={{ color: border }}>
            {overall.label}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-[var(--color-text-secondary)]" style={MONO}>SCORE</div>
          <div className="text-3xl font-black" style={{ ...MONO, color: border }}>
            {overall.raw}
            {overall.raw !== overall.rawUncapped && (
              <span className="text-sm text-[var(--color-text-secondary)] ml-1">
                ({overall.rawUncapped}→{overall.raw})
              </span>
            )}
          </div>
          <div className="text-xs" style={{ ...MONO, color: border }}>
            grade {overall.grade}
          </div>
        </div>
      </div>

      {/* Phase 2: アナリストコンセンサス情報バー */}
      {analyst && (analyst.targetMeanPrice || analyst.netRevisions30d !== null) && (
        <div
          className="mb-3 p-3 border grid grid-cols-2 sm:grid-cols-4 gap-3"
          style={{ ...MONO, borderColor: "var(--color-border)", background: "rgba(0,0,0,0.25)" }}
        >
          {analyst.targetMeanPrice !== null && (
            <div>
              <div className="text-[9px] uppercase text-[var(--color-text-secondary)]">目標株価</div>
              <div className="text-base font-bold text-[var(--color-text)]">
                {analyst.targetMeanPrice.toLocaleString()}
              </div>
              {analyst.upsidePct !== null && (
                <div
                  className="text-xs"
                  style={{ color: analyst.upsidePct > 0 ? "#7fffd4" : "#fb923c" }}
                >
                  {analyst.upsidePct > 0 ? "+" : ""}{analyst.upsidePct.toFixed(1)}% 余地
                </div>
              )}
            </div>
          )}
          {analyst.numberOfAnalysts !== null && (
            <div>
              <div className="text-[9px] uppercase text-[var(--color-text-secondary)]">アナリスト数</div>
              <div className="text-base font-bold text-[var(--color-text)]">{analyst.numberOfAnalysts}人</div>
              {analyst.recommendationKey && (
                <div className="text-[10px] text-[var(--color-text-secondary)] uppercase">{analyst.recommendationKey}</div>
              )}
            </div>
          )}
          {analyst.recommendationMean !== null && (
            <div>
              <div className="text-[9px] uppercase text-[var(--color-text-secondary)]">コンセンサス</div>
              <div
                className="text-base font-bold"
                style={{ color: analyst.recommendationMean <= 2.3 ? "#7fffd4" : analyst.recommendationMean >= 3.5 ? "#fb923c" : "#facc15" }}
              >
                {analyst.recommendationMean.toFixed(2)}
              </div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">1.0=強買 / 5.0=強売</div>
            </div>
          )}
          {analyst.netRevisions30d !== null && (
            <div>
              <div className="text-[9px] uppercase text-[var(--color-text-secondary)]">EPSリビジョン30d</div>
              <div
                className="text-base font-bold"
                style={{ color: analyst.netRevisions30d > 0 ? "#7fffd4" : analyst.netRevisions30d < 0 ? "#fb923c" : "#facc15" }}
              >
                {analyst.netRevisions30d > 0 ? "+" : ""}{analyst.netRevisions30d}件
              </div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">上方-下方</div>
            </div>
          )}
        </div>
      )}

      {/* Phase 3a: 適時開示イベント */}
      {disclosures && disclosures.eventCount > 0 && (
        <div
          className="mb-3 p-3 border"
          style={{
            ...MONO,
            borderColor:
              disclosures.hasCriticalNegative
                ? "rgba(239,68,68,0.6)"
                : disclosures.score >= 30
                ? "rgba(127,255,212,0.5)"
                : disclosures.score <= -30
                ? "rgba(251,146,60,0.5)"
                : "var(--color-border)",
            background:
              disclosures.hasCriticalNegative
                ? "rgba(239,68,68,0.10)"
                : disclosures.score >= 30
                ? "rgba(127,255,212,0.08)"
                : disclosures.score <= -30
                ? "rgba(251,146,60,0.08)"
                : "rgba(0,0,0,0.25)",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] uppercase text-[var(--color-text-secondary)]">
              📰 適時開示イベント (直近30日)
            </div>
            <div
              className="text-base font-black"
              style={{
                color:
                  disclosures.hasCriticalNegative ? "#ef4444"
                  : disclosures.score >= 30 ? "#7fffd4"
                  : disclosures.score <= -30 ? "#fb923c"
                  : "#facc15",
              }}
            >
              {disclosures.score > 0 ? "+" : ""}{disclosures.score}
            </div>
          </div>
          {/* イベントバッジ */}
          <div className="flex flex-wrap gap-1.5 mb-2">
            {Object.entries(disclosures.counts)
              .filter(([, n]) => n > 0)
              .map(([type, n]) => (
                <span
                  key={type}
                  className="text-[11px] px-2 py-0.5 border"
                  style={{
                    borderColor:
                      type === "scandal" || type === "lawsuit" || type === "earnings_revision_down" || type === "dividend_down"
                        ? "rgba(239,68,68,0.5)"
                        : "rgba(127,255,212,0.4)",
                    background:
                      type === "scandal" || type === "lawsuit" || type === "earnings_revision_down" || type === "dividend_down"
                        ? "rgba(239,68,68,0.08)"
                        : "rgba(127,255,212,0.05)",
                    color:
                      type === "scandal" || type === "lawsuit" || type === "earnings_revision_down" || type === "dividend_down"
                        ? "#ef4444"
                        : "#7fffd4",
                  }}
                >
                  {DISCLOSURE_LABEL[type] ?? type} {n > 1 ? `×${n}` : ""}
                </span>
              ))}
          </div>
          {/* 直近の重要イベント1〜3件 */}
          {disclosures.events.length > 0 && (
            <div className="text-[10px] text-[var(--color-text-secondary)] space-y-0.5 mt-2 pt-2 border-t border-[var(--color-border)]">
              {disclosures.events
                .sort((a, b) => b.date.localeCompare(a.date))
                .slice(0, 3)
                .map((e) => (
                  <div key={e.newsId} className="truncate">
                    <span className="text-[var(--color-text)]">[{e.date.slice(4, 6)}/{e.date.slice(6, 8)}]</span> {e.headline}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {/* Phase 4: ニュース感情バー */}
      {sentiment && sentiment.articleCount > 0 && (
        <div
          className="mb-3 p-3 border"
          style={{
            ...MONO,
            borderColor:
              sentiment.label === "very_positive" || sentiment.label === "positive"
                ? "rgba(127,255,212,0.5)"
                : sentiment.label === "very_negative" || sentiment.label === "negative"
                ? "rgba(251,146,60,0.5)"
                : "var(--color-border)",
            background:
              sentiment.label === "very_positive" || sentiment.label === "positive"
                ? "rgba(127,255,212,0.08)"
                : sentiment.label === "very_negative" || sentiment.label === "negative"
                ? "rgba(251,146,60,0.08)"
                : "rgba(0,0,0,0.25)",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] uppercase text-[var(--color-text-secondary)]">
              📰 ニュース感情 (Gemini)
            </div>
            <div className="text-[10px] text-[var(--color-text-secondary)]">
              {sentiment.articleCount}件 / 直近14日 {sentiment.stale && " · 🕒 stale"}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-2xl font-black" style={{
              color:
                sentiment.finalScore >= 15 ? "#7fffd4"
                : sentiment.finalScore <= -15 ? "#fb923c"
                : "#facc15"
            }}>
              {sentiment.finalScore > 0 ? "+" : ""}{sentiment.finalScore}
            </div>
            <div className="text-xs text-[var(--color-text-secondary)] flex-1">
              <div>平均感情 {sentiment.avgSentiment > 0 ? "+" : ""}{sentiment.avgSentiment.toFixed(2)} × 拡散係数 {sentiment.diffusionCoef.toFixed(2)}</div>
              <div className="uppercase font-bold mt-1" style={{
                color:
                  sentiment.label === "very_positive" ? "#7fffd4"
                  : sentiment.label === "positive" ? "#7fffd4"
                  : sentiment.label === "negative" ? "#fb923c"
                  : sentiment.label === "very_negative" ? "#ef4444"
                  : "#facc15"
              }}>
                {sentiment.label.replace("_", " ")}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Phase 2: 過熱警告 */}
      {flags.overhyped && flags.overhypedReason && (
        <div
          className="mb-3 p-3 border text-sm"
          style={{ ...MONO, borderColor: "rgba(251,146,60,0.6)", background: "rgba(251,146,60,0.10)", color: "#fb923c" }}
        >
          <div className="font-bold mb-1">🔥 過熱気味 (反落リスク)</div>
          <div className="text-xs leading-relaxed">{flags.overhypedReason}</div>
        </div>
      )}

      {/* Phase 2: クオリティグロース例外取消 */}
      {flags.qualityGrowthRevoked && (
        <div
          className="mb-3 p-2 border text-[11px]"
          style={{ ...MONO, borderColor: "rgba(250,204,21,0.4)", background: "rgba(250,204,21,0.05)", color: "#facc15" }}
        >
          ⚠ Forward PEG {">"} 3 または過熱状態を検出 → クオリティ・グロース例外を取消し、通常の最弱因子キャップを適用。
        </div>
      )}

      {/* バリュートラップ警告 */}
      {flags.valueTrap && flags.valueTrapReason && (
        <div
          className="mb-3 p-3 border border-red-500/50 bg-red-500/10 text-sm text-red-200"
          style={MONO}
        >
          <div className="font-bold mb-1">🚨 バリュートラップ警告</div>
          <div className="text-xs leading-relaxed">{flags.valueTrapReason}</div>
        </div>
      )}

      {/* グロース早期発見 */}
      {flags.growthEmerging && !flags.valueTrap && flags.growthEmergingReason && (
        <div
          className="mb-3 p-3 border text-sm"
          style={{ ...MONO, borderColor: "rgba(127,255,212,0.5)", background: "rgba(127,255,212,0.08)", color: "#7fffd4" }}
        >
          <div className="font-bold mb-1">🌱 グロース早期発見</div>
          <div className="text-xs leading-relaxed">{flags.growthEmergingReason}</div>
        </div>
      )}

      {/* 5因子グレード */}
      <div className="grid grid-cols-5 gap-2 mb-3">
        {(Object.keys(factors) as (keyof typeof factors)[]).map((key) => {
          const f = factors[key];
          const color = gradeColor(f.grade);
          const isExpanded = expanded === key;
          return (
            <button
              key={key}
              onClick={() => setExpanded(isExpanded ? null : key)}
              className="border p-2 text-left transition-all hover:scale-[1.02]"
              style={{
                borderColor: color,
                background: isExpanded ? `${color}22` : `${color}10`,
                boxShadow: isExpanded ? `0 0 12px ${color}` : "none",
              }}
            >
              <div className="text-[9px] uppercase text-[var(--color-text-secondary)]" style={MONO}>
                {FACTOR_LABELS[key as string]}
              </div>
              <div className="text-2xl font-black mt-1" style={{ ...MONO, color }}>
                {f.grade}
              </div>
              <div className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
                {f.raw}/100
              </div>
            </button>
          );
        })}
      </div>

      {/* 展開時: 因子の理由 */}
      {expanded && (
        <div
          className="mb-3 p-3 border text-xs"
          style={{ ...MONO, borderColor: "var(--color-border)", background: "rgba(0,0,0,0.3)" }}
        >
          <div className="text-[10px] uppercase text-[var(--color-text-secondary)] mb-2">
            // {FACTOR_LABELS[expanded]} 内訳
          </div>
          <ul className="space-y-1">
            {factors[expanded as keyof typeof factors].reasons.map((r, i) => (
              <li key={i} className="text-[var(--color-text)]">
                ▸ {r}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* メタ情報 */}
      <div className="flex items-center justify-between text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
        <div>
          {flags.cappedBy && (
            <span className="mr-3">
              ⚠ 最弱因子 [{FACTOR_LABELS[flags.cappedBy]}] により減点
            </span>
          )}
        </div>
        <div>
          DATA {coverage.confidence}% ({coverage.available.length}/5){coverage.missing.length > 0 && ` · missing: ${coverage.missing.map(m => FACTOR_LABELS[m] ?? m).join(",")}`}
        </div>
      </div>
    </div>
  );
}
