/**
 * 将来性スコアエンジン (Phase 1: バリュートラップ警告)
 *
 * Seeking Alpha 方式の 5 因子グレードモデル + 最弱因子キャップ:
 *   Value / Growth / Profitability / Momentum / EPS Revisions
 *
 * 「数値的に優れているのに株価が上がらない」銘柄を検出するのが目的。
 *   → 1つでも D 以下の因子があれば総合を Neutral に強制ダウン (バリュートラップ回避)
 *   → 逆に Growth + Momentum が両方 A 以上なら「グロース早期発見」フラグ
 *
 * Phase 1 の制約:
 *   - アナリスト目標株価, EPS リビジョン, ニュース感情はまだ未取り込み
 *   - 代替として既存の fundamentals + technical データで因子を構成
 *   - Phase 2 (Yahoo) で本物の EPS Revisions 因子に差し替え予定
 *
 * 既存の InsightInput をそのまま入力に使えるよう設計。
 */
import type { InsightInput } from "./insights-engine";
import type { AnalystData } from "./analyst-data";
import type { SentimentScore } from "./news-sentiment";
import type { DisclosureSummary } from "./disclosure-events";

export type FactorGrade = "A+" | "A" | "B+" | "B" | "C" | "D" | "F";

export interface FactorScore {
  raw: number;            // 0-100 (内部スコア)
  grade: FactorGrade;
  reasons: string[];      // この評価に至った材料 (人間向け説明)
}

export interface FutureScoreResult {
  ticker: string;
  // 5 因子 (Seeking Alpha 方式)
  factors: {
    value: FactorScore;            // バリュエーション (PER/PBR/配当/Upside)
    growth: FactorScore;           // 売上・利益成長 (実績 + 予想)
    profitability: FactorScore;    // ROE・営業利益率
    momentum: FactorScore;         // 値動きモメンタム (ROC20, SMAスタンス)
    epsRevisions: FactorScore;     // 業績修正 (Phase 2: 本物のアナリスト修正)
  };
  // 総合判定
  overall: {
    raw: number;              // 0-100 (最弱因子キャップ適用後)
    rawUncapped: number;      // キャップ前の素点 (参考)
    grade: FactorGrade;
    verdict: "buy" | "neutral" | "avoid";
    label: string;            // "強気" / "中立" / "回避" 等
    summary: string;          // 1〜2文の総括
  };
  // 警告 / シグナル
  flags: {
    valueTrap: boolean;
    valueTrapReason: string | null;
    growthEmerging: boolean;
    growthEmergingReason: string | null;
    overhyped: boolean;                 // Phase 2: 目標株価より大幅高 = 過熱
    overhypedReason: string | null;
    qualityGrowthRevoked: boolean;      // Phase 2: ハイPER過剰でクオリティグロース例外取消
    cappedBy: string | null;            // キャップ要因の因子名 ("growth" など)
  };
  // アナリスト情報 (Phase 2 追加)
  analyst?: {
    targetMeanPrice: number | null;
    upsidePct: number | null;
    numberOfAnalysts: number | null;
    recommendationKey: string | null;
    recommendationMean: number | null;
    netRevisions30d: number | null;
  } | null;
  // ニュース感情 (Phase 4 追加)
  sentiment?: {
    finalScore: number;             // -100 〜 +100
    label: SentimentScore["label"];
    articleCount: number;
    avgSentiment: number;
    diffusionCoef: number;
    computedAt: string;
    stale: boolean;
  } | null;
  // 適時開示イベント (Phase 3a 追加)
  disclosures?: {
    score: number;                  // -100 〜 +100
    eventCount: number;
    hasCriticalNegative: boolean;
    latestUpRevision: DisclosureSummary["latestUpRevision"];
    latestDownRevision: DisclosureSummary["latestDownRevision"];
    counts: DisclosureSummary["counts"];
    events: DisclosureSummary["events"];
  } | null;
  // データ充足度 (どの因子が計算できなかったか)
  coverage: {
    available: string[];      // 計算できた因子
    missing: string[];        // データ不足で計算できなかった因子
    confidence: number;       // 0-100 (5因子中いくつ揃ったか)
    hasAnalystData: boolean;  // Phase 2: アナリストデータの有無
    hasSentimentData: boolean; // Phase 4: ニュース感情データの有無
    hasDisclosureData: boolean; // Phase 3a: 適時開示データの有無
  };
}

// Phase 4 で受け取るセンチメント入力 (Firestore キャッシュから持ってくる想定)
export interface SentimentInput {
  finalScore: number;
  label: SentimentScore["label"];
  articleCount: number;
  avgSentiment: number;
  diffusionCoef: number;
  computedAt: string;
  stale?: boolean;
}

// Phase 3a で受け取る適時開示入力
export type DisclosureInput = DisclosureSummary;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ヘルパー: スコア(0-100)をグレードに変換
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function toGrade(score: number): FactorGrade {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 70) return "B+";
  if (score >= 60) return "B";
  if (score >= 45) return "C";
  if (score >= 30) return "D";
  return "F";
}

function gradeRank(grade: FactorGrade): number {
  // 大きいほど良い
  const map: Record<FactorGrade, number> = { "A+": 6, A: 5, "B+": 4, B: 3, C: 2, D: 1, F: 0 };
  return map[grade];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Value: PER / PBR / 配当利回り
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function scoreValue(d: InsightInput, a?: AnalystData | null): FactorScore | null {
  const f = d.fundamentals;
  if (!f) return null;

  const reasons: string[] = [];
  let score = 50; // 中立スタート
  let hasAny = false;

  // PER
  if (f.trailingPE !== null && f.trailingPE !== undefined && f.trailingPE > 0) {
    hasAny = true;
    if (f.trailingPE < 8) { score += 25; reasons.push(`PER ${f.trailingPE.toFixed(1)} (大幅割安)`); }
    else if (f.trailingPE < 12) { score += 18; reasons.push(`PER ${f.trailingPE.toFixed(1)} (割安)`); }
    else if (f.trailingPE < 18) { score += 8; reasons.push(`PER ${f.trailingPE.toFixed(1)} (標準)`); }
    else if (f.trailingPE < 25) { score -= 5; reasons.push(`PER ${f.trailingPE.toFixed(1)} (やや割高)`); }
    else if (f.trailingPE < 40) { score -= 15; reasons.push(`PER ${f.trailingPE.toFixed(1)} (割高)`); }
    else { score -= 25; reasons.push(`PER ${f.trailingPE.toFixed(1)} (極端に割高)`); }
  }

  // PBR
  if (f.pbr !== null && f.pbr !== undefined && f.pbr > 0) {
    hasAny = true;
    if (f.pbr < 0.7) { score += 18; reasons.push(`PBR ${f.pbr.toFixed(2)} (解散価値以下)`); }
    else if (f.pbr < 1.0) { score += 12; reasons.push(`PBR ${f.pbr.toFixed(2)} (解散価値付近)`); }
    else if (f.pbr < 1.5) { score += 5; reasons.push(`PBR ${f.pbr.toFixed(2)} (割安寄り)`); }
    else if (f.pbr < 3) { /* 中立 */ }
    else if (f.pbr < 5) { score -= 8; reasons.push(`PBR ${f.pbr.toFixed(2)} (やや割高)`); }
    else { score -= 15; reasons.push(`PBR ${f.pbr.toFixed(2)} (高水準)`); }
  }

  // 配当利回り (Value 寄与 / 持続性は別軸)
  if (f.dividendYield !== null && f.dividendYield !== undefined && f.dividendYield > 0) {
    hasAny = true;
    if (f.dividendYield >= 5) { score += 12; reasons.push(`配当 ${f.dividendYield.toFixed(2)}% (高配当)`); }
    else if (f.dividendYield >= 3) { score += 6; reasons.push(`配当 ${f.dividendYield.toFixed(2)}%`); }
    else if (f.dividendYield >= 1.5) { score += 2; }
  }

  // Phase 2: アナリスト目標株価との乖離 (Upside%)
  // 「割高に見えても、アナリスト目標が現値より上なら市場が将来性を織り込んでいる」
  // 逆に「割安に見えても、アナリスト目標が現値より下ならコンセンサスでは売り」
  if (a?.upsidePct !== null && a?.upsidePct !== undefined) {
    hasAny = true;
    const u = a.upsidePct;
    if (u >= 30) { score += 20; reasons.push(`目標株価より +${u.toFixed(0)}% (大幅上振れ期待)`); }
    else if (u >= 15) { score += 12; reasons.push(`目標株価より +${u.toFixed(0)}% 余地`); }
    else if (u >= 5) { score += 5; reasons.push(`目標株価まで +${u.toFixed(0)}% 余地`); }
    else if (u >= -5) { /* ほぼ目標通り */ }
    else if (u >= -15) { score -= 10; reasons.push(`現値が目標を ${(-u).toFixed(0)}% 上回る (織込済)`); }
    else { score -= 20; reasons.push(`現値が目標を ${(-u).toFixed(0)}% 上回る (過熱気味)`); }
  }

  if (!hasAny) return null;

  score = Math.max(0, Math.min(100, score));
  return { raw: score, grade: toGrade(score), reasons };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Growth: 売上・利益成長率
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function scoreGrowth(d: InsightInput, a?: AnalystData | null): FactorScore | null {
  const f = d.fundamentals;
  if (!f) return null;

  const reasons: string[] = [];
  let score = 50;
  let hasAny = false;

  // 利益成長 (より重視)
  if (f.earningsGrowth !== null && f.earningsGrowth !== undefined) {
    hasAny = true;
    const g = f.earningsGrowth;
    if (g >= 30) { score += 30; reasons.push(`利益成長 +${g.toFixed(1)}% (急成長)`); }
    else if (g >= 15) { score += 20; reasons.push(`利益成長 +${g.toFixed(1)}% (高成長)`); }
    else if (g >= 5) { score += 10; reasons.push(`利益成長 +${g.toFixed(1)}% (安定成長)`); }
    else if (g >= 0) { score -= 5; reasons.push(`利益成長 +${g.toFixed(1)}% (停滞)`); }
    else if (g >= -10) { score -= 18; reasons.push(`利益成長 ${g.toFixed(1)}% (減益)`); }
    else { score -= 30; reasons.push(`利益成長 ${g.toFixed(1)}% (大幅減益)`); }
  }

  // 売上成長
  if (f.revenueGrowth !== null && f.revenueGrowth !== undefined) {
    hasAny = true;
    const g = f.revenueGrowth;
    if (g >= 20) { score += 18; reasons.push(`売上成長 +${g.toFixed(1)}%`); }
    else if (g >= 10) { score += 10; reasons.push(`売上成長 +${g.toFixed(1)}%`); }
    else if (g >= 3) { score += 3; }
    else if (g >= 0) { score -= 3; reasons.push(`売上成長 +${g.toFixed(1)}% (鈍化)`); }
    else { score -= 15; reasons.push(`売上成長 ${g.toFixed(1)}% (減収)`); }
  }

  // Phase 2: 来期 EPS 予想成長率 (Yahoo earningsTrend +1y)
  // → 直近実績ベースの "Growth" に「将来の伸び」を上乗せ / 抑制
  if (a?.epsGrowthForecast.nextYear !== null && a?.epsGrowthForecast.nextYear !== undefined) {
    hasAny = true;
    const g = a.epsGrowthForecast.nextYear;
    if (g >= 25) { score += 15; reasons.push(`来期EPS予想 +${g.toFixed(1)}% (高成長予想)`); }
    else if (g >= 10) { score += 8; reasons.push(`来期EPS予想 +${g.toFixed(1)}%`); }
    else if (g >= 0) { /* 中立 */ }
    else if (g >= -15) { score -= 10; reasons.push(`来期EPS予想 ${g.toFixed(1)}% (減益予想)`); }
    else { score -= 20; reasons.push(`来期EPS予想 ${g.toFixed(1)}% (大幅減益予想)`); }
  }
  // 今期予想売上成長
  if (a?.revenueGrowthForecast !== null && a?.revenueGrowthForecast !== undefined) {
    hasAny = true;
    const g = a.revenueGrowthForecast;
    if (g >= 20) { score += 8; reasons.push(`今期売上予想 +${g.toFixed(1)}%`); }
    else if (g >= 5) { score += 3; }
    else if (g < 0) { score -= 8; reasons.push(`今期売上予想 ${g.toFixed(1)}% (減収予想)`); }
  }

  if (!hasAny) return null;

  score = Math.max(0, Math.min(100, score));
  return { raw: score, grade: toGrade(score), reasons };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Profitability: ROE / 営業利益率 / 純利益率
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function scoreProfitability(d: InsightInput): FactorScore | null {
  const f = d.fundamentals;
  if (!f) return null;

  const reasons: string[] = [];
  let score = 50;
  let hasAny = false;

  // ROE (最重要)
  if (f.roe !== null && f.roe !== undefined) {
    hasAny = true;
    const r = f.roe;
    if (r >= 20) { score += 30; reasons.push(`ROE ${r.toFixed(1)}% (卓越)`); }
    else if (r >= 12) { score += 20; reasons.push(`ROE ${r.toFixed(1)}% (健全)`); }
    else if (r >= 7) { score += 8; reasons.push(`ROE ${r.toFixed(1)}% (標準)`); }
    else if (r >= 3) { score -= 8; reasons.push(`ROE ${r.toFixed(1)}% (低水準)`); }
    else if (r >= 0) { score -= 18; reasons.push(`ROE ${r.toFixed(1)}% (極低)`); }
    else { score -= 35; reasons.push(`ROE ${r.toFixed(1)}% (赤字)`); }
  }

  // 営業利益率
  if (f.operatingMargin !== null && f.operatingMargin !== undefined) {
    hasAny = true;
    const m = f.operatingMargin;
    if (m >= 20) { score += 15; reasons.push(`営業利益率 ${m.toFixed(1)}%`); }
    else if (m >= 10) { score += 8; reasons.push(`営業利益率 ${m.toFixed(1)}%`); }
    else if (m >= 3) { /* 標準 */ }
    else if (m >= 0) { score -= 8; reasons.push(`営業利益率 ${m.toFixed(1)}% (薄利)`); }
    else { score -= 18; reasons.push(`営業利益率 ${m.toFixed(1)}% (赤字)`); }
  }

  // 純利益率
  if (f.profitMargin !== null && f.profitMargin !== undefined) {
    hasAny = true;
    const m = f.profitMargin;
    if (m >= 15) { score += 8; }
    else if (m < 0) { score -= 10; reasons.push(`純利益率 ${m.toFixed(1)}% (最終赤字)`); }
  }

  if (!hasAny) return null;

  score = Math.max(0, Math.min(100, score));
  return { raw: score, grade: toGrade(score), reasons };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Momentum: ROC20 / SMA50・SMA200 のスタンス / レンジ位置
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function scoreMomentum(d: InsightInput): FactorScore | null {
  const reasons: string[] = [];
  let score = 50;
  let hasAny = false;

  // ROC20 (20日変化率)
  const roc20 = d.patterns?.daily?.[0]?.summary?.roc20;
  if (roc20 !== null && roc20 !== undefined) {
    hasAny = true;
    if (roc20 >= 15) { score += 25; reasons.push(`20日変化 +${roc20.toFixed(1)}% (強い上昇)`); }
    else if (roc20 >= 5) { score += 12; reasons.push(`20日変化 +${roc20.toFixed(1)}%`); }
    else if (roc20 >= -5) { score -= 3; reasons.push(`20日変化 ${roc20.toFixed(1)}% (横ばい)`); }
    else if (roc20 >= -15) { score -= 15; reasons.push(`20日変化 ${roc20.toFixed(1)}% (下落)`); }
    else { score -= 25; reasons.push(`20日変化 ${roc20.toFixed(1)}% (急落)`); }
  }

  // SMA50 vs 価格 (中期トレンド)
  const price = d.currentPrice;
  const sma50 = d.indicators?.sma50;
  if (price && sma50) {
    hasAny = true;
    const diff = ((price - sma50) / sma50) * 100;
    if (diff >= 8) { score += 12; reasons.push(`SMA50比 +${diff.toFixed(1)}% (中期強気)`); }
    else if (diff >= 2) { score += 6; }
    else if (diff >= -2) { /* 中立 */ }
    else if (diff >= -8) { score -= 6; reasons.push(`SMA50比 ${diff.toFixed(1)}%`); }
    else { score -= 15; reasons.push(`SMA50比 ${diff.toFixed(1)}% (中期弱気)`); }
  }

  // ゴールデン/デッドクロス状態
  const sma200 = d.indicators?.sma200;
  if (sma50 && sma200) {
    hasAny = true;
    const diff = ((sma50 - sma200) / sma200) * 100;
    if (diff >= 3) { score += 10; reasons.push(`ゴールデンクロス維持`); }
    else if (diff <= -3) { score -= 12; reasons.push(`デッドクロス継続`); }
  }

  // 6mレンジ位置 (高すぎず低すぎず動意がある方が良い)
  if (d.priceContext) {
    hasAny = true;
    const pos = d.priceContext.positionInRange;
    if (pos >= 80) { score += 3; reasons.push(`6m高値圏 ${pos}%`); }
    else if (pos <= 15) { score -= 8; reasons.push(`6m安値圏 ${pos}% (低迷)`); }
  }

  if (!hasAny) return null;

  score = Math.max(0, Math.min(100, score));
  return { raw: score, grade: toGrade(score), reasons };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EPS Revisions (Phase 2 本実装)
//   入力: アナリストの直近30日 / 7日の EPS 予想 上方修正・下方修正 件数
//   学術的に最も予測力が高い因子 (Mill Street Research 等)
//   日本株はカバレッジ薄なので、データ無ければ Phase 1 代替に fallback
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function scoreEpsRevisions(d: InsightInput, a?: AnalystData | null): FactorScore | null {
  const reasons: string[] = [];
  let score = 50;
  let hasAny = false;

  // ── Phase 2: 本物の EPS リビジョン ──
  if (a) {
    const r = a.epsRevisions;
    const total30 = r.upLast30Days + r.downLast30Days;
    if (total30 > 0) {
      hasAny = true;
      const netRatio = (r.upLast30Days - r.downLast30Days) / total30; // -1.0 〜 +1.0
      // ネット比率 + 絶対件数で評価
      if (netRatio >= 0.6 && r.upLast30Days >= 3) {
        score += 30; reasons.push(`アナリスト上方修正 ${r.upLast30Days}件 vs 下方 ${r.downLast30Days}件 (強気)`);
      } else if (netRatio >= 0.3 && r.upLast30Days >= 2) {
        score += 18; reasons.push(`アナリスト上方修正 ${r.upLast30Days}件 vs 下方 ${r.downLast30Days}件`);
      } else if (netRatio <= -0.6 && r.downLast30Days >= 3) {
        score -= 30; reasons.push(`アナリスト下方修正 ${r.downLast30Days}件 vs 上方 ${r.upLast30Days}件 (弱気)`);
      } else if (netRatio <= -0.3) {
        score -= 18; reasons.push(`アナリスト下方修正 ${r.downLast30Days}件 vs 上方 ${r.upLast30Days}件`);
      } else {
        reasons.push(`アナリスト修正 上${r.upLast30Days}/下${r.downLast30Days}件 (拮抗)`);
      }
      // 直近7日が顕著なら加点 (足元の勢い)
      const total7 = r.upLast7Days + r.downLast7Days;
      if (total7 >= 2) {
        const net7 = (r.upLast7Days - r.downLast7Days) / total7;
        if (net7 >= 0.5) { score += 5; reasons.push(`直近7日も上方優勢 (+${r.upLast7Days}/-${r.downLast7Days})`); }
        else if (net7 <= -0.5) { score -= 5; reasons.push(`直近7日も下方優勢`); }
      }
    }

    // アナリスト推奨数の変化 (Buy が増えているか減っているか)
    if (a.recommendationDeltaBuy !== null) {
      hasAny = true;
      const d_ = a.recommendationDeltaBuy;
      if (d_ >= 2) { score += 8; reasons.push(`過去3ヶ月でBuy推奨が ${d_}件増加`); }
      else if (d_ <= -2) { score -= 8; reasons.push(`過去3ヶ月でBuy推奨が ${Math.abs(d_)}件減少`); }
    }

    // recommendationMean (1.0=Strong Buy, 5.0=Strong Sell)
    if (a.recommendationMean !== null) {
      hasAny = true;
      const rm = a.recommendationMean;
      if (rm <= 1.8) { score += 12; reasons.push(`コンセンサス ${rm.toFixed(1)} = Strong Buy 圏`); }
      else if (rm <= 2.3) { score += 6; reasons.push(`コンセンサス ${rm.toFixed(1)} = Buy 圏`); }
      else if (rm >= 3.5) { score -= 12; reasons.push(`コンセンサス ${rm.toFixed(1)} = Hold〜Sell`); }
    }

    if (hasAny) {
      score = Math.max(0, Math.min(100, score));
      return { raw: score, grade: toGrade(score), reasons };
    }
  }

  // ── Phase 1 代替版 (アナリストデータ無し時のフォールバック) ──
  // 日本株は Yahoo データ薄なのでここに落ちることが多い
  const surprise = d.lastEarningsSurprise;
  if (surprise !== null && surprise !== undefined) {
    hasAny = true;
    if (surprise >= 15) { score += 25; reasons.push(`前回決算 +${surprise.toFixed(1)}% サプライズ`); }
    else if (surprise >= 5) { score += 12; reasons.push(`前回決算 +${surprise.toFixed(1)}% 上振れ`); }
    else if (surprise >= -5) { /* 中立 */ }
    else if (surprise >= -15) { score -= 15; reasons.push(`前回決算 ${surprise.toFixed(1)}% 下振れ`); }
    else { score -= 25; reasons.push(`前回決算 ${surprise.toFixed(1)}% 大幅未達`); }
  }
  const eg = d.fundamentals?.earningsGrowth;
  const price = d.currentPrice;
  const sma200 = d.indicators?.sma200;
  if (eg !== null && eg !== undefined && price && sma200) {
    hasAny = true;
    const trendUp = price > sma200;
    if (eg > 10 && trendUp) { score += 10; reasons.push(`増益 + 株価SMA200上 = 織込済`); }
    else if (eg > 10 && !trendUp) { score += 15; reasons.push(`増益 + SMA200下 = 見直し余地`); }
    else if (eg < -10 && trendUp) { score -= 18; reasons.push(`減益 + 株価高位 = 失望リスク`); }
    else if (eg < -10 && !trendUp) { score -= 8; reasons.push(`減益 + 株価低位 = 織込済`); }
  }

  if (!hasAny) return null;
  score = Math.max(0, Math.min(100, score));
  reasons.unshift("※アナリスト予想未取得のため代替指標で評価 (日本株は Phase 3 で四季報補完予定)");
  return { raw: score, grade: toGrade(score), reasons };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// バリュートラップ検出
//   「数値良い (Value高い) のに上がらない (Growth/Momentum 弱い)」
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function detectValueTrap(factors: FutureScoreResult["factors"]): { trap: boolean; reason: string | null } {
  const v = factors.value;
  const g = factors.growth;
  const m = factors.momentum;
  const p = factors.profitability;

  // 必要因子が揃っているか
  if (!v || !g || !m) return { trap: false, reason: null };

  const valueHigh = gradeRank(v.grade) >= gradeRank("B+");      // 割安
  const growthWeak = gradeRank(g.grade) <= gradeRank("D");      // 成長弱い (D 以下)
  const momentumWeak = gradeRank(m.grade) <= gradeRank("D");    // 値動き弱い
  const profitWeak = p ? gradeRank(p.grade) <= gradeRank("C") : false;

  if (valueHigh && growthWeak && momentumWeak) {
    return {
      trap: true,
      reason: `割安 (Value: ${v.grade}) だが成長 ${g.grade} / モメンタム ${m.grade} が弱い。市場が織り込んでいない構造的問題の可能性。${profitWeak ? "収益力も低下傾向。" : ""}`,
    };
  }

  // 弱いトラップ (収益力悪化 + 割安)
  if (valueHigh && profitWeak && growthWeak) {
    return {
      trap: true,
      reason: `割安 (Value: ${v.grade}) かつ収益力 ${p?.grade ?? "?"} ・成長 ${g.grade} が弱い。「安いが買えない」典型パターン。`,
    };
  }

  return { trap: false, reason: null };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// グロース早期発見
//   Growth + Momentum が両方 A 以上、Profit も健全
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function detectGrowthEmerging(factors: FutureScoreResult["factors"]): { emerging: boolean; reason: string | null } {
  const g = factors.growth;
  const m = factors.momentum;
  const p = factors.profitability;

  if (!g || !m) return { emerging: false, reason: null };

  const growthStrong = gradeRank(g.grade) >= gradeRank("A");
  const momentumStrong = gradeRank(m.grade) >= gradeRank("B+");
  const profitOk = p ? gradeRank(p.grade) >= gradeRank("B") : true;

  if (growthStrong && momentumStrong && profitOk) {
    return {
      emerging: true,
      reason: `成長 ${g.grade} + モメンタム ${m.grade}${p ? ` + 収益力 ${p.grade}` : ""}。市場が将来性を評価し始めた段階の可能性。`,
    };
  }
  return { emerging: false, reason: null };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 最弱因子キャップ
//   1つでも D 以下があれば総合を Neutral (50) にキャップ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/**
 * 過熱検出 (overhyped)
 *   現在価格がアナリスト目標株価を 15% 以上上回る = 織り込み済 or バブル
 *   高 PER で Growth 高くてもブレーキをかける
 */
function detectOverhyped(a?: AnalystData | null): { overhyped: boolean; reason: string | null } {
  if (!a || a.upsidePct === null || a.numberOfAnalysts === null) {
    return { overhyped: false, reason: null };
  }
  if (a.numberOfAnalysts < 3) return { overhyped: false, reason: null }; // サンプル少なすぎ
  if (a.upsidePct <= -15) {
    return {
      overhyped: true,
      reason: `現値がアナリスト目標株価 (${a.targetMeanPrice?.toLocaleString() ?? "?"}) を ${(-a.upsidePct).toFixed(0)}% 上回る (${a.numberOfAnalysts}人平均)。過熱気味で短期反落リスク。`,
    };
  }
  return { overhyped: false, reason: null };
}

/**
 * クオリティグロース例外の取り消し条件
 *   Forward PEG > 3 (Growth に対して PER が高すぎる)
 *   OR 過熱検出 = true
 *   → AAPL/NVDA 救済の例外を、明らかにバブル状態の銘柄では取り消す
 */
function shouldRevokeQualityGrowthException(d: InsightInput, a?: AnalystData | null, overhyped?: boolean): boolean {
  // 過熱はほぼ確定で取消だが、アナリスト目標が高ければ猶予あり
  if (overhyped) {
    // 例外: net revisions が圧倒的に強気 (+30件以上) なら取消しない
    if (a && a.netRevisions30d >= 30) return false;
    return true;
  }
  const fpe = d.fundamentals?.forwardPE;
  const growth = a?.epsGrowthForecast?.nextYear ?? d.fundamentals?.earningsGrowth;
  if (fpe !== null && fpe !== undefined && fpe > 0 && growth !== null && growth !== undefined && growth > 0) {
    const peg = fpe / growth;
    if (peg > 3) {
      // 例外: EPS リビジョンが極めて強気 (net +30件以上 or 上方率80%以上) なら取消しない
      // AAPL のように PER 高くてもアナリストが上方修正連打している銘柄を救う
      if (a) {
        if (a.netRevisions30d >= 30) return false;
        const total = a.epsRevisions.upLast30Days + a.epsRevisions.downLast30Days;
        if (total >= 5 && a.epsRevisions.upLast30Days / total >= 0.8) return false;
      }
      return true;
    }
  }
  return false;
}

function applyWeakestFactorCap(
  factors: FutureScoreResult["factors"],
  rawAvg: number,
  revokeException: boolean = false
): { capped: number; cappedBy: string | null; qualityGrowthRevoked: boolean } {
  const entries = Object.entries(factors).filter(([, v]) => v !== null) as [string, FactorScore][];
  let weakest: { name: string; rank: number; grade: FactorGrade } | null = null;
  for (const [name, fs] of entries) {
    const rank = gradeRank(fs.grade);
    if (weakest === null || rank < weakest.rank) {
      weakest = { name, rank, grade: fs.grade };
    }
  }
  if (!weakest) return { capped: rawAvg, cappedBy: null, qualityGrowthRevoked: false };

  // ─ クオリティ・グロース例外 ─────────────────
  // 「Value が F でも、Growth と Profitability が両方 A 以上ならキャップ免除」
  //   AAPL/NVDA のような銘柄が一律「中立」になるのを防ぐ。
  //   ただし Phase 2: revokeException=true (Forward PEG > 3 or 過熱検出) なら例外取消
  const isQualityGrowth =
    gradeRank(factors.growth.grade) >= gradeRank("A") &&
    gradeRank(factors.profitability.grade) >= gradeRank("A");
  const useException = isQualityGrowth && !revokeException;

  // D 以下 (rank <= 1) ならキャップ ─ ただしクオリティグロース例外あり
  if (weakest.rank <= 1) {
    if (weakest.name === "value" && useException) {
      // 例外: Value F でも Growth/Profit が両方 A 以上なら通常進行
      const others = entries.filter(([n]) => n !== "value");
      let secondWeakest: { name: string; rank: number; grade: FactorGrade } | null = null;
      for (const [name, fs] of others) {
        const rank = gradeRank(fs.grade);
        if (secondWeakest === null || rank < secondWeakest.rank) {
          secondWeakest = { name, rank, grade: fs.grade };
        }
      }
      if (secondWeakest && secondWeakest.rank <= 1) {
        return { capped: Math.min(rawAvg, 50), cappedBy: secondWeakest.name, qualityGrowthRevoked: false };
      }
      if (secondWeakest && secondWeakest.rank === 2) {
        return { capped: Math.min(rawAvg, 75), cappedBy: rawAvg > 75 ? secondWeakest.name : null, qualityGrowthRevoked: false };
      }
      return { capped: rawAvg, cappedBy: null, qualityGrowthRevoked: false };
    }
    // 例外取消の場合は理由を返す
    return { capped: Math.min(rawAvg, 50), cappedBy: weakest.name, qualityGrowthRevoked: isQualityGrowth && revokeException };
  }
  if (weakest.rank === 2) {
    return { capped: Math.min(rawAvg, 65), cappedBy: rawAvg > 65 ? weakest.name : null, qualityGrowthRevoked: false };
  }
  return { capped: rawAvg, cappedBy: null, qualityGrowthRevoked: false };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// メイン関数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function evaluateFutureScore(
  d: InsightInput,
  a?: AnalystData | null,
  sentiment?: SentimentInput | null,
  disclosures?: DisclosureInput | null
): FutureScoreResult {
  // null を返す scoring 関数を Placeholder で受け止め
  const placeholder = (): FactorScore => ({
    raw: 50,
    grade: "C",
    reasons: ["データ不足のため評価不能 (中立扱い)"],
  });

  const valueRaw = scoreValue(d, a);
  const growthRaw = scoreGrowth(d, a);
  const profitRaw = scoreProfitability(d);
  const momentumRaw = scoreMomentum(d);
  const epsRaw = scoreEpsRevisions(d, a);

  const factors = {
    value: valueRaw ?? placeholder(),
    growth: growthRaw ?? placeholder(),
    profitability: profitRaw ?? placeholder(),
    momentum: momentumRaw ?? placeholder(),
    epsRevisions: epsRaw ?? placeholder(),
  };

  // データ充足度
  const availability = {
    value: valueRaw !== null,
    growth: growthRaw !== null,
    profitability: profitRaw !== null,
    momentum: momentumRaw !== null,
    epsRevisions: epsRaw !== null,
  };
  const available = Object.entries(availability).filter(([, v]) => v).map(([k]) => k);
  const missing = Object.entries(availability).filter(([, v]) => !v).map(([k]) => k);
  const confidence = Math.round((available.length / 5) * 100);

  // 素点平均 (利用可能因子のみ)
  const usableScores = [valueRaw, growthRaw, profitRaw, momentumRaw, epsRaw].filter(
    (s): s is FactorScore => s !== null
  );
  const rawUncapped = usableScores.length > 0
    ? Math.round(usableScores.reduce((a, b) => a + b.raw, 0) / usableScores.length)
    : 50;

  // 過熱検出 (Phase 2: アナリスト目標株価との比較)
  const overhyped = detectOverhyped(a);

  // 最弱因子キャップ (Phase 2: 例外取消ロジック対応)
  const revokeException = shouldRevokeQualityGrowthException(d, a, overhyped.overhyped);
  const { capped, cappedBy, qualityGrowthRevoked } = applyWeakestFactorCap(factors, rawUncapped, revokeException);

  // 過熱状態なら追加で 10pt 引く (キャップ後)
  let finalScore = overhyped.overhyped ? Math.max(0, capped - 10) : capped;

  // Phase 4: ニュース感情を反映 (古いキャッシュは効果を減衰)
  if (sentiment && sentiment.articleCount > 0) {
    const decay = sentiment.stale ? 0.5 : 1.0;
    // finalScore (-100..+100 とほぼ独立な次元) を 0-100 スケールに引き込む
    // 最大 ±15pt 振れ幅
    const delta = Math.round((sentiment.finalScore / 100) * 15 * decay);
    finalScore = Math.max(0, Math.min(100, finalScore + delta));
  }

  // Phase 3a: 適時開示イベントを反映 (より強い影響、±20pt)
  if (disclosures && disclosures.events.length > 0) {
    const delta = Math.round((disclosures.score / 100) * 20);
    finalScore = Math.max(0, Math.min(100, finalScore + delta));
    // 不祥事/訴訟がある場合は強制ペナルティ
    if (disclosures.hasCriticalNegative) {
      finalScore = Math.max(0, finalScore - 15);
    }
  }

  // バリュートラップ / グロース早期発見
  const trap = detectValueTrap(factors);
  const emerging = detectGrowthEmerging(factors);

  // 総合判定
  let verdict: "buy" | "neutral" | "avoid";
  let label: string;
  // Phase 3a: 不祥事/訴訟は最優先で警告
  if (disclosures?.hasCriticalNegative) {
    verdict = "avoid";
    label = "🚨 重大開示警告 (不祥事/訴訟)";
  } else if (trap.trap) {
    verdict = "avoid";
    label = "🚨 バリュートラップ警告";
  } else if (overhyped.overhyped && finalScore < 60) {
    verdict = "avoid";
    label = "🔥 過熱気味 (反落リスク)";
  } else if (disclosures?.latestDownRevision && !disclosures?.latestUpRevision) {
    // 下方修正があり上方修正がない → 注意
    if (finalScore < 55) {
      verdict = "avoid";
      label = "🟠 下方修正後 - 慎重判断";
    } else if (finalScore >= 75) {
      verdict = "buy";
      label = "🟢 将来性 強気";
    } else {
      verdict = "neutral";
      label = "🟡 将来性 中立";
    }
  } else if (disclosures?.latestUpRevision && finalScore >= 60) {
    verdict = "buy";
    label = "🚀 上方修正 + 強気";
  } else if (finalScore >= 75) {
    verdict = "buy";
    label = "🟢 将来性 強気";
  } else if (finalScore >= 60) {
    verdict = "buy";
    label = emerging.emerging ? "🌱 グロース早期発見" : "🟢 将来性 やや強気";
  } else if (finalScore >= 45) {
    verdict = "neutral";
    label = "🟡 将来性 中立";
  } else if (finalScore >= 30) {
    verdict = "avoid";
    label = "🟠 将来性 やや弱気";
  } else {
    verdict = "avoid";
    label = "🔴 将来性 弱気";
  }

  // サマリー文
  const factorSummary = Object.entries(factors)
    .map(([k, v]) => `${k}:${v.grade}`)
    .join(" / ");
  let summary = `${label} (素点${rawUncapped} → ${finalScore}). ${factorSummary}.`;
  if (cappedBy) summary += ` 最弱因子 [${cappedBy}] により減点。`;
  if (qualityGrowthRevoked) summary += ` 高 PEG/過熱によりクオリティグロース例外を取消。`;
  if (overhyped.overhyped) summary += ` ${overhyped.reason}`;
  if (trap.trap) summary += ` ${trap.reason}`;
  if (emerging.emerging) summary += ` ${emerging.reason}`;

  return {
    ticker: d.ticker,
    factors,
    overall: {
      raw: finalScore,
      rawUncapped,
      grade: toGrade(finalScore),
      verdict,
      label,
      summary,
    },
    flags: {
      valueTrap: trap.trap,
      valueTrapReason: trap.reason,
      growthEmerging: emerging.emerging,
      growthEmergingReason: emerging.reason,
      overhyped: overhyped.overhyped,
      overhypedReason: overhyped.reason,
      qualityGrowthRevoked,
      cappedBy,
    },
    analyst: a
      ? {
          targetMeanPrice: a.targetMeanPrice,
          upsidePct: a.upsidePct,
          numberOfAnalysts: a.numberOfAnalysts,
          recommendationKey: a.recommendationKey,
          recommendationMean: a.recommendationMean,
          netRevisions30d: a.netRevisions30d,
        }
      : null,
    sentiment: sentiment
      ? {
          finalScore: sentiment.finalScore,
          label: sentiment.label,
          articleCount: sentiment.articleCount,
          avgSentiment: sentiment.avgSentiment,
          diffusionCoef: sentiment.diffusionCoef,
          computedAt: sentiment.computedAt,
          stale: sentiment.stale ?? false,
        }
      : null,
    disclosures: disclosures
      ? {
          score: disclosures.score,
          eventCount: disclosures.events.length,
          hasCriticalNegative: disclosures.hasCriticalNegative,
          latestUpRevision: disclosures.latestUpRevision,
          latestDownRevision: disclosures.latestDownRevision,
          counts: disclosures.counts,
          events: disclosures.events,
        }
      : null,
    coverage: {
      available,
      missing,
      confidence,
      hasAnalystData: a !== null && a !== undefined,
      hasSentimentData: sentiment !== null && sentiment !== undefined && sentiment.articleCount > 0,
      hasDisclosureData: disclosures !== null && disclosures !== undefined && disclosures.events.length > 0,
    },
  };
}
