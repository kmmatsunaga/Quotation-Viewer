"use client";

/**
 * Cavka Master Score Panel
 *
 * 銘柄詳細ページの「ヒーロー」スコア表示。Future Score (5因子+アナリスト+
 * 感情+開示の集大成) を主軸に、短/中/長期スコアと主要フラグを併記。
 *
 * 目的: ユーザが銘柄を開いた瞬間に「Cavka はこの銘柄を何点と評価しているか」
 *       が大きな数字で見え、その下に最重要の根拠を凝縮して見せる。
 *
 * 既存の IntegratedScorePanel (テクニカルのみの旧版) を置き換える役割。
 */

import { useEffect, useState } from "react";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

type FactorGrade = "A+" | "A" | "B+" | "B" | "C" | "D" | "F";

interface FactorScore {
  raw: number;
  grade: FactorGrade;
}

interface FutureScoreResp {
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
    netRevisions30d: number | null;
  } | null;
  sentiment?: {
    finalScore: number;
    label: string;
    articleCount: number;
    stale: boolean;
  } | null;
  disclosures?: {
    eventCount: number;
    hasCriticalNegative: boolean;
    counts: Record<string, number>;
  } | null;
}

interface InsightsResp {
  ticker: string;
  short: { score: number; action: string };
  mid: { score: number; action: string };
  long: { score: number; action: string };
  suggestedScenario?: {
    entry: number | null;
    target: number | null;
    stopLoss: number | null;
    riskRewardRatio: number | null;
  } | null;
}

function gradeColor(grade: FactorGrade | undefined): string {
  if (!grade) return "var(--color-text-secondary)";
  if (grade === "A+" || grade === "A") return "#22c55e";
  if (grade === "B+" || grade === "B") return "#7fffd4";
  if (grade === "C") return "#facc15";
  if (grade === "D") return "#fb923c";
  return "#ef4444";
}

function scoreColor(score: number): string {
  if (score >= 75) return "#22c55e";
  if (score >= 60) return "#7fffd4";
  if (score >= 45) return "#facc15";
  if (score >= 30) return "#fb923c";
  return "#ef4444";
}

function timeframeLabel(score: number): string {
  if (score >= 75) return "強気";
  if (score >= 60) return "やや強気";
  if (score >= 45) return "中立";
  if (score >= 30) return "やや弱気";
  return "弱気";
}

export default function MasterScorePanel({ ticker }: { ticker: string }) {
  const [future, setFuture] = useState<FutureScoreResp | null>(null);
  const [insights, setInsights] = useState<InsightsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.allSettled([
      fetch(`/api/stocks/future-score/${encodeURIComponent(ticker)}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/stocks/insights?ticker=${encodeURIComponent(ticker)}`).then((r) => (r.ok ? r.json() : null)),
    ]).then(([f, i]) => {
      if (cancelled) return;
      if (f.status === "fulfilled" && f.value) setFuture(f.value as FutureScoreResp);
      if (i.status === "fulfilled" && i.value) setInsights(i.value as InsightsResp);
      if (
        (f.status === "rejected" || !f.value) &&
        (i.status === "rejected" || !i.value)
      ) {
        setError("評価データを取得できませんでした");
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  if (loading) {
    return (
      <div className="p-5 border" style={{ borderColor: "var(--color-accent)", background: "rgba(0,240,255,0.04)" }}>
        <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--color-text-secondary)]" style={MONO}>
          // CAVKA_MASTER_SCORE.LOADING ...
        </div>
      </div>
    );
  }

  if (error || (!future && !insights)) {
    return (
      <div className="p-5 border" style={{ borderColor: "rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.05)" }}>
        <div className="text-xs text-red-400" style={MONO}>// CAVKA_MASTER_SCORE.ERROR: {error}</div>
      </div>
    );
  }

  // ヒーロースコア: Future Score の overall を優先、無ければ insights の中期スコア
  const masterScore = future?.overall.raw ?? insights?.mid.score ?? 50;
  const masterLabel = future?.overall.label ?? insights?.mid.action ?? "—";
  const masterGrade = future?.overall.grade;
  const verdict = future?.overall.verdict ?? "neutral";
  const color = scoreColor(masterScore);

  return (
    <div
      className="p-5 border space-y-4"
      style={{
        borderColor: color,
        background: `linear-gradient(180deg, ${color}10 0%, rgba(0,0,0,0.1) 100%)`,
        boxShadow: `0 0 24px ${color}30, inset 0 0 0 1px ${color}20`,
      }}
    >
      {/* ━━ ヒーロー: 大きな数字 + ラベル ━━ */}
      <div className="flex items-end gap-5 flex-wrap">
        <div className="flex items-baseline gap-3">
          <div
            className="text-6xl font-black leading-none"
            style={{ color, textShadow: `0 0 28px ${color}60`, ...MONO }}
          >
            {masterScore}
          </div>
          <div className="text-sm text-[var(--color-text-secondary)]" style={MONO}>/ 100</div>
          {masterGrade && (
            <div
              className="text-2xl font-black ml-2"
              style={{ color: gradeColor(masterGrade), ...MONO }}
            >
              {masterGrade}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-[200px]">
          <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--color-text-secondary)]" style={MONO}>
            // CAVKA_MASTER_SCORE
          </div>
          <div className="text-xl font-bold mt-1" style={{ color }}>
            {masterLabel}
          </div>
          {future?.overall.rawUncapped !== undefined && future.overall.rawUncapped !== masterScore && (
            <div className="text-[10px] text-[var(--color-text-secondary)] mt-1" style={MONO}>
              素点 {future.overall.rawUncapped} → 最弱因子キャップ後 {masterScore}
              {future.flags.cappedBy && <span> · 抑制因子: {future.flags.cappedBy}</span>}
            </div>
          )}
        </div>
      </div>

      {/* プログレスバー */}
      <div className="h-2 bg-[var(--bg-input)] overflow-hidden rounded-full">
        <div
          className="h-full transition-all duration-1000 rounded-full"
          style={{ width: `${masterScore}%`, background: `linear-gradient(90deg, var(--color-accent), ${color})`, boxShadow: `0 0 8px ${color}80` }}
        />
      </div>

      {/* ━━ 時間軸別スコア (短/中/長) ━━ */}
      {insights && (
        <div className="grid grid-cols-3 gap-2">
          <TimeframeStat label="🔥 短期" desc="1〜4週" score={insights.short.score} />
          <TimeframeStat label="📈 中期" desc="1〜6か月" score={insights.mid.score} />
          <TimeframeStat label="🏛 長期" desc="1年以上" score={insights.long.score} />
        </div>
      )}

      {/* ━━ 5因子グレード ━━ */}
      {future && (
        <div className="grid grid-cols-5 gap-1.5">
          <FactorBadge label="割安度" grade={future.factors.value.grade} score={future.factors.value.raw} />
          <FactorBadge label="成長性" grade={future.factors.growth.grade} score={future.factors.growth.raw} />
          <FactorBadge label="収益力" grade={future.factors.profitability.grade} score={future.factors.profitability.raw} />
          <FactorBadge label="値動き" grade={future.factors.momentum.grade} score={future.factors.momentum.raw} />
          <FactorBadge label="業績修正" grade={future.factors.epsRevisions.grade} score={future.factors.epsRevisions.raw} />
        </div>
      )}

      {/* ━━ フラグ / 警告 ━━ */}
      {future && (() => {
        const badges: { icon: string; text: string; color: string; bg: string; title?: string }[] = [];
        if (future.flags.valueTrap) badges.push({ icon: "🚨", text: "バリュートラップ", color: "#ef4444", bg: "rgba(239,68,68,0.15)", title: future.flags.valueTrapReason ?? undefined });
        if (future.flags.growthEmerging) badges.push({ icon: "🌱", text: "グロース早期発見", color: "#7fffd4", bg: "rgba(127,255,212,0.15)", title: future.flags.growthEmergingReason ?? undefined });
        if (future.flags.overhyped) badges.push({ icon: "🔥", text: "過熱気味", color: "#fb923c", bg: "rgba(251,146,60,0.15)", title: future.flags.overhypedReason ?? undefined });
        if (future.disclosures?.hasCriticalNegative) badges.push({ icon: "🚨", text: "重大開示警告", color: "#ef4444", bg: "rgba(239,68,68,0.15)" });
        if (future.sentiment && future.sentiment.articleCount > 0) {
          const s = future.sentiment.finalScore;
          if (s >= 15) badges.push({ icon: "📰", text: `ニュース感情 +${s}`, color: "#7fffd4", bg: "rgba(127,255,212,0.10)" });
          else if (s <= -15) badges.push({ icon: "📰", text: `ニュース感情 ${s}`, color: "#fb923c", bg: "rgba(251,146,60,0.10)" });
        }
        if (future.disclosures && future.disclosures.eventCount > 0 && !future.disclosures.hasCriticalNegative) {
          const upCount = (future.disclosures.counts.earnings_revision_up ?? 0) + (future.disclosures.counts.buyback ?? 0) + (future.disclosures.counts.dividend_up ?? 0);
          const downCount = (future.disclosures.counts.earnings_revision_down ?? 0) + (future.disclosures.counts.dividend_down ?? 0);
          if (upCount > 0) badges.push({ icon: "📈", text: `好材料 ×${upCount}`, color: "#7fffd4", bg: "rgba(127,255,212,0.10)" });
          if (downCount > 0) badges.push({ icon: "📉", text: `悪材料 ×${downCount}`, color: "#fb923c", bg: "rgba(251,146,60,0.10)" });
        }
        if (badges.length === 0) return null;
        return (
          <div className="flex flex-wrap gap-1.5">
            {badges.map((b, i) => (
              <span
                key={i}
                title={b.title}
                className="text-[11px] px-2 py-1 border"
                style={{ borderColor: b.color, background: b.bg, color: b.color, ...MONO }}
              >
                {b.icon} {b.text}
              </span>
            ))}
          </div>
        );
      })()}

      {/* ━━ アナリスト要約 (有る時のみ、コンパクト1行) ━━ */}
      {future?.analyst && (future.analyst.targetMeanPrice || future.analyst.netRevisions30d !== null) && (
        <div
          className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] pt-3 border-t border-[var(--color-border)]"
          style={MONO}
        >
          <span className="text-[var(--color-text-secondary)]">アナリスト{future.analyst.numberOfAnalysts ? `(${future.analyst.numberOfAnalysts}人)` : ""}:</span>
          {future.analyst.targetMeanPrice !== null && (
            <span className="text-[var(--color-text)]">
              目標 {future.analyst.targetMeanPrice.toLocaleString()}
              {future.analyst.upsidePct !== null && (
                <span style={{ color: future.analyst.upsidePct > 0 ? "#7fffd4" : "#fb923c", marginLeft: 6 }}>
                  ({future.analyst.upsidePct > 0 ? "+" : ""}{future.analyst.upsidePct.toFixed(1)}%)
                </span>
              )}
            </span>
          )}
          {future.analyst.recommendationKey && (
            <span className="text-[var(--color-text)]">推奨 {future.analyst.recommendationKey}</span>
          )}
          {future.analyst.netRevisions30d !== null && (
            <span style={{ color: future.analyst.netRevisions30d > 0 ? "#7fffd4" : future.analyst.netRevisions30d < 0 ? "#fb923c" : "var(--color-text-secondary)" }}>
              Net Revisions 30d: {future.analyst.netRevisions30d > 0 ? "+" : ""}{future.analyst.netRevisions30d}
            </span>
          )}
        </div>
      )}

      {/* ━━ 推奨シナリオ (短い1行) ━━ */}
      {insights?.suggestedScenario?.entry && (
        <div className="text-[11px] text-[var(--color-text-secondary)] pt-2 border-t border-[var(--color-border)]" style={MONO}>
          💡 推奨シナリオ: エントリー ¥{insights.suggestedScenario.entry.toLocaleString()}
          {insights.suggestedScenario.target && ` / 目標 ¥${insights.suggestedScenario.target.toLocaleString()}`}
          {insights.suggestedScenario.stopLoss && ` / 損切 ¥${insights.suggestedScenario.stopLoss.toLocaleString()}`}
          {insights.suggestedScenario.riskRewardRatio && ` / RR ${insights.suggestedScenario.riskRewardRatio}`}
        </div>
      )}
    </div>
  );
}

function TimeframeStat({ label, desc, score }: { label: string; desc: string; score: number }) {
  const color = scoreColor(score);
  return (
    <div
      className="p-2 border"
      style={{ borderColor: `${color}55`, background: `${color}08` }}
    >
      <div className="text-[10px] uppercase text-[var(--color-text-secondary)]" style={MONO}>
        {label} <span className="text-[8px]">{desc}</span>
      </div>
      <div className="flex items-baseline gap-1.5 mt-0.5">
        <div className="text-2xl font-black" style={{ color, ...MONO }}>
          {score}
        </div>
        <div className="text-[10px]" style={{ color, ...MONO }}>
          {timeframeLabel(score)}
        </div>
      </div>
    </div>
  );
}

function FactorBadge({ label, grade, score }: { label: string; grade: FactorGrade; score: number }) {
  const color = gradeColor(grade);
  return (
    <div
      className="p-1.5 border text-center"
      style={{ borderColor: `${color}55`, background: `${color}10` }}
    >
      <div className="text-[8px] uppercase text-[var(--color-text-secondary)]" style={MONO}>{label}</div>
      <div className="text-lg font-black" style={{ color, ...MONO }}>{grade}</div>
      <div className="text-[8px] text-[var(--color-text-secondary)]" style={MONO}>{score}</div>
    </div>
  );
}
