"use client";

/**
 * Cavka Master Score Panel
 *
 * 「結局買いか?」の総合判断スコア。複数の独立した分析を統合し、
 * 1 つの数字 + アクション推奨に集約する。
 *
 * 入力データソース:
 *   - Future Score (5因子+アナリスト+感情+開示)  [30% weight]
 *   - 短期テクニカル insight                       [10%]
 *   - 中期テクニカル insight                       [20%]
 *   - 長期テクニカル insight                       [15%]
 *   - 日足チャートパターン                        [10%]
 *   - 週足チャートパターン                        [15%]
 *
 * ペナルティ (重大警告):
 *   - バリュートラップ検出  → スコアを最大 50 に制限
 *   - 重大開示 (不祥事/訴訟) → スコアを最大 30 に制限
 *   - 過熱気味              → -10pt
 *
 * 追加調整:
 *   - ニュース感情 (-5 〜 +5pt)
 *   - 業績修正方向          (+3 / -5pt)
 */

import { useEffect, useMemo, useState } from "react";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

type FactorGrade = "A+" | "A" | "B+" | "B" | "C" | "D" | "F";
type Horizon = "short" | "mid" | "long";

interface FactorScore {
  raw: number;
  grade: FactorGrade;
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
    qualityGrowthRevoked: boolean;
  };
  analyst?: { targetMeanPrice: number | null; upsidePct: number | null; numberOfAnalysts: number | null; recommendationKey: string | null; netRevisions30d: number | null; } | null;
  sentiment?: { finalScore: number; label: string; articleCount: number; stale: boolean; } | null;
  disclosures?: { eventCount: number; hasCriticalNegative: boolean; counts: Record<string, number>; } | null;
}

interface InsightsResp {
  ticker: string;
  short: { score: number; action: string };
  mid: { score: number; action: string };
  long: { score: number; action: string };
  suggestedScenario?: { entry: number | null; target: number | null; stopLoss: number | null; riskRewardRatio: number | null; } | null;
}

interface PatternItem {
  signal: "buy" | "sell" | "watch";
  strength: number;       // 1-5
  confidence: number;     // 0-100
  label: string;
  direction: string;
}

interface PatternsResp {
  patterns: Record<string, {
    name: string;
    patterns: {
      daily?: PatternItem[];
      weekly?: PatternItem[];
      monthly?: PatternItem[];
    };
  }>;
}

// ───────────────────────────────────────────────────
// Score calculation
// ───────────────────────────────────────────────────

function patternToScore(p: PatternItem | null | undefined): number | null {
  if (!p) return null;
  const base = p.signal === "buy" ? 70 : p.signal === "sell" ? 30 : 50;
  // strength 1-5 で ±10pt、confidence で実効化
  const adj = ((p.strength - 3) * 5) * (p.confidence / 100);
  return Math.max(0, Math.min(100, Math.round(base + adj)));
}

interface MasterInput {
  future: FutureScoreResp | null;
  insights: InsightsResp | null;
  daily: PatternItem | null;
  weekly: PatternItem | null;
}

interface Component {
  key: string;
  label: string;
  emoji: string;
  score: number;
  weight: number;
  note?: string;
}

interface MasterResult {
  score: number;
  scoreUncapped: number;
  grade: FactorGrade;
  verdict: "strong_buy" | "buy" | "hold" | "avoid" | "strong_avoid";
  label: string;
  components: Component[];
  adjustments: { reason: string; delta: number }[];
  caps: { reason: string; appliedCap: number }[];
  warnings: { icon: string; text: string; color: string }[];
  positives: { icon: string; text: string; color: string }[];
  bestHorizon: Horizon | null;
  bestHorizonScore: number;
}

function gradeFromScore(n: number): FactorGrade {
  if (n >= 90) return "A+";
  if (n >= 80) return "A";
  if (n >= 70) return "B+";
  if (n >= 60) return "B";
  if (n >= 45) return "C";
  if (n >= 30) return "D";
  return "F";
}

function verdictAndLabel(n: number, hasCriticalNeg: boolean, hasValueTrap: boolean): { verdict: MasterResult["verdict"]; label: string } {
  if (hasCriticalNeg) return { verdict: "strong_avoid", label: "🚨 重大開示 → 触らず" };
  if (hasValueTrap) return { verdict: "avoid", label: "🪤 バリュートラップ → 警戒" };
  if (n >= 75) return { verdict: "strong_buy", label: "🟢 強気 - 積極エントリー検討" };
  if (n >= 60) return { verdict: "buy", label: "🟢 やや買い - 押し目で検討" };
  if (n >= 45) return { verdict: "hold", label: "🟡 様子見 - 方向性待ち" };
  if (n >= 30) return { verdict: "avoid", label: "🟠 やや弱気 - 利食い検討" };
  return { verdict: "strong_avoid", label: "🔴 弱気 - 新規買い不向き" };
}

function computeMasterScore(input: MasterInput): MasterResult {
  const components: Component[] = [];

  // Future Score (一番太い重み: 5因子+アナリスト+感情+開示まで全部入り)
  if (input.future) {
    components.push({
      key: "future",
      label: "ファンダ + 将来性",
      emoji: "🔮",
      score: input.future.overall.raw,
      weight: 3.0,
      note: input.future.overall.label,
    });
  }
  // Insights 時間軸別
  if (input.insights) {
    components.push({ key: "short", label: "短期テクニカル", emoji: "🔥", score: input.insights.short.score, weight: 1.0 });
    components.push({ key: "mid", label: "中期テクニカル", emoji: "📈", score: input.insights.mid.score, weight: 2.0 });
    components.push({ key: "long", label: "長期テクニカル", emoji: "🏛", score: input.insights.long.score, weight: 1.5 });
  }
  // チャートパターン
  const dailyS = patternToScore(input.daily);
  if (dailyS !== null && input.daily) {
    components.push({
      key: "daily",
      label: "日足パターン",
      emoji: "📐",
      score: dailyS,
      weight: 1.0,
      note: `${input.daily.label} (信頼度 ${input.daily.confidence}%)`,
    });
  }
  const weeklyS = patternToScore(input.weekly);
  if (weeklyS !== null && input.weekly) {
    components.push({
      key: "weekly",
      label: "週足パターン",
      emoji: "📐",
      score: weeklyS,
      weight: 1.5,
      note: `${input.weekly.label} (信頼度 ${input.weekly.confidence}%)`,
    });
  }

  // 加重平均
  let weightedSum = 0;
  let totalWeight = 0;
  for (const c of components) {
    weightedSum += c.score * c.weight;
    totalWeight += c.weight;
  }
  let score = totalWeight > 0 ? weightedSum / totalWeight : 50;
  const scorePreCapped = score;

  // 調整 (微補正): ニュース感情、業績修正
  const adjustments: MasterResult["adjustments"] = [];
  const s = input.future?.sentiment;
  if (s && s.articleCount > 0) {
    const delta = Math.round((s.finalScore / 100) * 5);
    if (delta !== 0) {
      score += delta;
      adjustments.push({ reason: `ニュース感情 ${s.finalScore > 0 ? "+" : ""}${s.finalScore} (${s.articleCount}件)`, delta });
    }
  }
  const disc = input.future?.disclosures;
  if (disc) {
    const upCount = (disc.counts.earnings_revision_up ?? 0) + (disc.counts.buyback ?? 0) + (disc.counts.dividend_up ?? 0);
    const downCount = (disc.counts.earnings_revision_down ?? 0) + (disc.counts.dividend_down ?? 0);
    if (upCount > 0) {
      const delta = Math.min(5, upCount * 2);
      score += delta;
      adjustments.push({ reason: `好材料開示 ×${upCount} (上方修正/自社株/増配)`, delta });
    }
    if (downCount > 0) {
      const delta = -Math.min(8, downCount * 3);
      score += delta;
      adjustments.push({ reason: `悪材料開示 ×${downCount} (下方修正/減配)`, delta });
    }
  }

  // キャップ・ペナルティ (重大警告)
  const caps: MasterResult["caps"] = [];
  if (input.future?.flags.valueTrap) {
    if (score > 50) caps.push({ reason: "バリュートラップ警告", appliedCap: 50 });
    score = Math.min(score, 50);
  }
  if (input.future?.disclosures?.hasCriticalNegative) {
    if (score > 30) caps.push({ reason: "重大開示警告 (不祥事/訴訟)", appliedCap: 30 });
    score = Math.min(score, 30);
  }
  if (input.future?.flags.overhyped) {
    score -= 10;
    adjustments.push({ reason: "過熱気味 (目標株価超過)", delta: -10 });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = gradeFromScore(score);
  const hasCN = input.future?.disclosures?.hasCriticalNegative ?? false;
  const hasVT = input.future?.flags.valueTrap ?? false;
  const { verdict, label } = verdictAndLabel(score, hasCN, hasVT);

  // 最適時間軸 (insights のうち最も高いもの)
  let bestHorizon: Horizon | null = null;
  let bestHorizonScore = 0;
  if (input.insights) {
    const horizons: { h: Horizon; v: number }[] = [
      { h: "short", v: input.insights.short.score },
      { h: "mid", v: input.insights.mid.score },
      { h: "long", v: input.insights.long.score },
    ];
    horizons.sort((a, b) => b.v - a.v);
    bestHorizon = horizons[0].h;
    bestHorizonScore = horizons[0].v;
  }

  // 警告 / ポジティブシグナル
  const warnings: MasterResult["warnings"] = [];
  const positives: MasterResult["positives"] = [];
  if (input.future) {
    if (input.future.flags.valueTrap) warnings.push({ icon: "🪤", text: "バリュートラップ警告", color: "#ef4444" });
    if (input.future.flags.overhyped) warnings.push({ icon: "🔥", text: "過熱気味 (目標株価超過)", color: "#fb923c" });
    if (input.future.disclosures?.hasCriticalNegative) warnings.push({ icon: "🚨", text: "重大開示 (不祥事/訴訟)", color: "#ef4444" });
    if (input.future.flags.qualityGrowthRevoked) warnings.push({ icon: "⚠", text: "高PEG により例外取消", color: "#fb923c" });
    if (input.future.flags.growthEmerging) positives.push({ icon: "🌱", text: "グロース早期発見", color: "#7fffd4" });
    if (s && s.finalScore >= 15) positives.push({ icon: "📰", text: `ニュース感情 +${s.finalScore}`, color: "#7fffd4" });
    if (s && s.finalScore <= -15) warnings.push({ icon: "📰", text: `ニュース感情 ${s.finalScore}`, color: "#fb923c" });
    if (disc) {
      const upCount = (disc.counts.earnings_revision_up ?? 0);
      const downCount = (disc.counts.earnings_revision_down ?? 0);
      if (upCount > 0) positives.push({ icon: "📈", text: `上方修正 ×${upCount}`, color: "#7fffd4" });
      if (downCount > 0) warnings.push({ icon: "📉", text: `下方修正 ×${downCount}`, color: "#fb923c" });
    }
  }

  return {
    score,
    scoreUncapped: Math.round(scorePreCapped),
    grade,
    verdict,
    label,
    components,
    adjustments,
    caps,
    warnings,
    positives,
    bestHorizon,
    bestHorizonScore,
  };
}

// ───────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────

function gradeColor(grade: FactorGrade): string {
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

function actionRecommendation(r: MasterResult, insights: InsightsResp | null): string {
  if (r.verdict === "strong_avoid") return "新規エントリー見送り。既保有なら段階的に利食い/損切を検討。";
  if (r.verdict === "avoid") {
    if (r.warnings.some((w) => w.text.includes("バリュートラップ"))) {
      return "数値は割安に見えるが市場が織り込んでいない構造的問題の可能性。新規買いは避ける。";
    }
    return "売り材料が優勢。新規エントリーは時期尚早。";
  }
  if (r.verdict === "hold") return "シグナルが拮抗。明確なきっかけを待つのが賢明。";

  // buy / strong_buy
  const horizonLabel = r.bestHorizon === "short" ? "短期 (1〜4週)" : r.bestHorizon === "mid" ? "中期 (1〜6か月)" : "長期 (1年以上)";
  const scen = insights?.suggestedScenario;
  let line = `${horizonLabel}狙いが有望 (該当軸スコア ${r.bestHorizonScore})。`;
  if (r.verdict === "strong_buy") line += "段階的なエントリーを検討。";
  else line += "押し目を狙ったエントリーを検討。";
  if (scen?.entry) {
    line += ` 推奨エントリー ¥${scen.entry.toLocaleString()}`;
    if (scen.target) line += ` / 目標 ¥${scen.target.toLocaleString()}`;
    if (scen.stopLoss) line += ` / 損切 ¥${scen.stopLoss.toLocaleString()}`;
  }
  return line;
}

// ───────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────

export default function MasterScorePanel({ ticker }: { ticker: string }) {
  const [future, setFuture] = useState<FutureScoreResp | null>(null);
  const [insights, setInsights] = useState<InsightsResp | null>(null);
  const [patterns, setPatterns] = useState<{ daily: PatternItem | null; weekly: PatternItem | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.allSettled([
      fetch(`/api/stocks/future-score/${encodeURIComponent(ticker)}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/stocks/insights?ticker=${encodeURIComponent(ticker)}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/stocks/patterns?tickers=${encodeURIComponent(ticker)}`).then((r) => (r.ok ? r.json() : null)),
    ]).then(([f, i, p]) => {
      if (cancelled) return;
      if (f.status === "fulfilled" && f.value) setFuture(f.value as FutureScoreResp);
      if (i.status === "fulfilled" && i.value) setInsights(i.value as InsightsResp);
      if (p.status === "fulfilled" && p.value) {
        const pp = (p.value as PatternsResp).patterns?.[ticker]?.patterns;
        setPatterns({
          daily: pp?.daily?.[0] ?? null,
          weekly: pp?.weekly?.[0] ?? null,
        });
      }
      const anyOk = [f, i, p].some((r) => r.status === "fulfilled" && r.value);
      if (!anyOk) setError("評価データを取得できませんでした");
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  const master = useMemo<MasterResult | null>(() => {
    if (!future && !insights && !patterns) return null;
    return computeMasterScore({
      future,
      insights,
      daily: patterns?.daily ?? null,
      weekly: patterns?.weekly ?? null,
    });
  }, [future, insights, patterns]);

  if (loading) {
    return (
      <div className="p-5 border" style={{ borderColor: "var(--color-accent)", background: "rgba(0,240,255,0.04)" }}>
        <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--color-text-secondary)]" style={MONO}>
          // CAVKA_MASTER_SCORE.LOADING ...
        </div>
      </div>
    );
  }

  if (error || !master) {
    return (
      <div className="p-5 border" style={{ borderColor: "rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.05)" }}>
        <div className="text-xs text-red-400" style={MONO}>// CAVKA_MASTER_SCORE.ERROR: {error}</div>
      </div>
    );
  }

  const color = scoreColor(master.score);
  const actionLine = actionRecommendation(master, insights);

  return (
    <div
      className="p-5 border space-y-4"
      style={{
        borderColor: color,
        background: `linear-gradient(180deg, ${color}10 0%, rgba(0,0,0,0.1) 100%)`,
        boxShadow: `0 0 24px ${color}30, inset 0 0 0 1px ${color}20`,
      }}
    >
      {/* ━━ ヒーロー ━━ */}
      <div className="flex items-end gap-5 flex-wrap">
        <div className="flex items-baseline gap-3">
          <div className="text-6xl font-black leading-none" style={{ color, textShadow: `0 0 28px ${color}60`, ...MONO }}>
            {master.score}
          </div>
          <div className="text-sm text-[var(--color-text-secondary)]" style={MONO}>/ 100</div>
          <div className="text-2xl font-black ml-2" style={{ color: gradeColor(master.grade), ...MONO }}>
            {master.grade}
          </div>
        </div>
        <div className="flex-1 min-w-[200px]">
          <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--color-text-secondary)]" style={MONO}>
            // CAVKA_MASTER_SCORE
          </div>
          <div className="text-xl font-bold mt-1" style={{ color }}>
            {master.label}
          </div>
          <div className="text-[10px] text-[var(--color-text-secondary)] mt-1" style={MONO}>
            {master.components.length} ソース統合 (Future+短中長+パターン)
            {master.scoreUncapped !== master.score && ` · 補正前 ${master.scoreUncapped} → 最終 ${master.score}`}
          </div>
        </div>
      </div>

      {/* プログレスバー */}
      <div className="h-2 bg-[var(--bg-input)] overflow-hidden rounded-full">
        <div className="h-full transition-all duration-1000 rounded-full" style={{ width: `${master.score}%`, background: `linear-gradient(90deg, var(--color-accent), ${color})`, boxShadow: `0 0 8px ${color}80` }} />
      </div>

      {/* ━━ アクション推奨 ━━ */}
      <div className="p-3 border" style={{ borderColor: `${color}55`, background: `${color}10` }}>
        <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--color-text-secondary)] mb-1" style={MONO}>
          💡 アクション推奨
        </div>
        <div className="text-sm" style={{ color: "var(--color-text)", ...MONO }}>
          {actionLine}
        </div>
      </div>

      {/* ━━ 内訳 (構成データ) ━━ */}
      <div>
        <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--color-text-secondary)] mb-2" style={MONO}>
          📊 構成内訳 (加重平均)
        </div>
        <div className="space-y-1.5">
          {master.components.map((c) => {
            const cColor = scoreColor(c.score);
            const pct = (c.weight / master.components.reduce((a, b) => a + b.weight, 0)) * 100;
            return (
              <div key={c.key} className="flex items-center gap-3 text-xs" style={MONO}>
                <span className="w-32 text-[var(--color-text-secondary)] shrink-0">
                  {c.emoji} {c.label}
                </span>
                <span className="font-black w-10 text-right" style={{ color: cColor }}>
                  {c.score}
                </span>
                <span className="text-[10px] text-[var(--color-text-secondary)] w-12 shrink-0">
                  w{c.weight.toFixed(1)} ({pct.toFixed(0)}%)
                </span>
                <div className="flex-1 h-1.5 bg-[var(--bg-input)] overflow-hidden rounded-full">
                  <div className="h-full" style={{ width: `${c.score}%`, background: cColor }} />
                </div>
                {c.note && (
                  <span className="text-[10px] text-[var(--color-text-secondary)] truncate max-w-[260px]">
                    {c.note}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 調整 / キャップの理由 */}
      {(master.adjustments.length > 0 || master.caps.length > 0) && (
        <div className="text-[10px] text-[var(--color-text-secondary)] space-y-0.5" style={MONO}>
          {master.adjustments.map((a, i) => (
            <div key={`adj-${i}`} style={{ color: a.delta > 0 ? "#7fffd4" : "#fb923c" }}>
              ▸ {a.reason}: {a.delta > 0 ? "+" : ""}{a.delta}pt
            </div>
          ))}
          {master.caps.map((c, i) => (
            <div key={`cap-${i}`} style={{ color: "#ef4444" }}>
              ▸ {c.reason}: 最大 {c.appliedCap} に制限
            </div>
          ))}
        </div>
      )}

      {/* ━━ 警告/ポジティブシグナル バッジ ━━ */}
      {(master.warnings.length > 0 || master.positives.length > 0) && (
        <div className="flex flex-wrap gap-1.5 pt-2 border-t border-[var(--color-border)]">
          {master.warnings.map((b, i) => (
            <span key={`w-${i}`} className="text-[11px] px-2 py-1 border" style={{ borderColor: b.color, background: `${b.color}15`, color: b.color, ...MONO }}>
              {b.icon} {b.text}
            </span>
          ))}
          {master.positives.map((b, i) => (
            <span key={`p-${i}`} className="text-[11px] px-2 py-1 border" style={{ borderColor: b.color, background: `${b.color}15`, color: b.color, ...MONO }}>
              {b.icon} {b.text}
            </span>
          ))}
        </div>
      )}

      {/* ━━ アナリスト要約 (コンパクト) ━━ */}
      {future?.analyst && (future.analyst.targetMeanPrice || future.analyst.netRevisions30d !== null) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] pt-2 border-t border-[var(--color-border)]" style={MONO}>
          <span className="text-[var(--color-text-secondary)]">📊 アナリスト{future.analyst.numberOfAnalysts ? `(${future.analyst.numberOfAnalysts}人)` : ""}:</span>
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
    </div>
  );
}
