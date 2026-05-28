/**
 * アナリスト・将来予想データ取得 (Yahoo Finance v10)
 *
 * Phase 2 で取り込む将来性データ:
 *   - financialData         : 目標株価コンセンサス, recommendationKey
 *   - recommendationTrend   : Buy/Hold/Sell の集計 (過去4ヶ月)
 *   - earningsTrend         : EPS予想と上方/下方修正カウント
 *
 * 日本株は (.T サフィックス) Yahoo のカバレッジが薄いため null だらけになることが多い。
 *   → そのケースでも future-score 側はフェイルセーフに動く設計。
 *   → Phase 3 で四季報・IFIS で補完予定。
 */
import { yfQuoteSummary } from "./yahoo-finance";

export interface AnalystData {
  // 目標株価コンセンサス
  targetMeanPrice: number | null;
  targetHighPrice: number | null;
  targetLowPrice: number | null;
  numberOfAnalysts: number | null;
  recommendationMean: number | null;   // 1.0=Strong Buy 〜 5.0=Strong Sell
  recommendationKey: string | null;     // "buy" | "hold" | "underperform" 等

  // 現在価格との比較
  currentPrice: number | null;
  upsidePct: number | null;             // (target - current) / current * 100
  forwardPE: number | null;

  // アナリスト推奨数 (recommendationTrend の最新期 = 0m)
  recommendationCounts: {
    strongBuy: number;
    buy: number;
    hold: number;
    sell: number;
    strongSell: number;
  } | null;

  // 過去4ヶ月の推奨数の変化 (今月のbuy系合計 - 3ヶ月前のbuy系合計)
  recommendationDeltaBuy: number | null;

  // EPS 予想 (current quarter / next quarter / current year / next year)
  epsEstimate: {
    currentQuarter: number | null;
    nextQuarter: number | null;
    currentYear: number | null;
    nextYear: number | null;
  };

  // EPS 成長率予想 (Yahoo の growth フィールド: 前年比 %)
  epsGrowthForecast: {
    currentQuarter: number | null;     // 当四半期予想成長率
    currentYear: number | null;        // 今期予想成長率
    nextYear: number | null;           // 来期予想成長率
  };

  // EPS リビジョン (アナリストが直近で予想を上方/下方修正した件数)
  // 当期 + 来期の合計を集計
  epsRevisions: {
    upLast7Days: number;
    upLast30Days: number;
    downLast7Days: number;
    downLast30Days: number;
  };

  // 計算: ネット上方修正数 (up - down)
  netRevisions30d: number;

  // 売上予想成長率 (今期)
  revenueGrowthForecast: number | null;
}

type YfNumeric = { raw?: number | null } | number | null | undefined;
type YfStr = string | null | undefined;

function n(v: YfNumeric): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && "raw" in v && typeof v.raw === "number") {
    return Number.isFinite(v.raw) ? v.raw : null;
  }
  return null;
}
function s(v: YfStr): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * アナリスト系データを取得して正規化。
 * 日本株はデータ薄。null 多くなる。
 */
export async function fetchAnalystData(ticker: string): Promise<AnalystData | null> {
  const isJP = /^\d{3,4}[A-Z]?$/.test(ticker);
  const yfTicker = isJP ? `${ticker}.T` : ticker;

  const modules = "financialData,recommendationTrend,earningsTrend,price";
  const result = await yfQuoteSummary(yfTicker, modules);
  if (!result) return null;

  const fd = (result.financialData ?? {}) as Record<string, YfNumeric | YfStr>;
  const rt = (result.recommendationTrend ?? {}) as { trend?: Record<string, unknown>[] };
  const et = (result.earningsTrend ?? {}) as { trend?: Record<string, unknown>[] };
  const pr = (result.price ?? {}) as Record<string, YfNumeric>;

  const currentPrice = n(fd.currentPrice as YfNumeric) ?? n(pr.regularMarketPrice);
  const targetMean = n(fd.targetMeanPrice as YfNumeric);
  const upsidePct =
    currentPrice && targetMean && currentPrice > 0
      ? Math.round(((targetMean - currentPrice) / currentPrice) * 100 * 10) / 10
      : null;

  // recommendationTrend: 配列で [0m, -1m, -2m, -3m]
  const trends = Array.isArray(rt.trend) ? rt.trend : [];
  const latestTrend = trends[0];
  const oldestTrend = trends[trends.length - 1];

  let recommendationCounts: AnalystData["recommendationCounts"] = null;
  let recommendationDeltaBuy: number | null = null;
  if (latestTrend) {
    const sb = (latestTrend.strongBuy as number) ?? 0;
    const b = (latestTrend.buy as number) ?? 0;
    const h = (latestTrend.hold as number) ?? 0;
    const s_ = (latestTrend.sell as number) ?? 0;
    const ssell = (latestTrend.strongSell as number) ?? 0;
    recommendationCounts = { strongBuy: sb, buy: b, hold: h, sell: s_, strongSell: ssell };
    if (oldestTrend && latestTrend !== oldestTrend) {
      const oldBuy = ((oldestTrend.strongBuy as number) ?? 0) + ((oldestTrend.buy as number) ?? 0);
      const newBuy = sb + b;
      recommendationDeltaBuy = newBuy - oldBuy;
    }
  }

  // earningsTrend: period が "0q", "+1q", "0y", "+1y"
  const trendByPeriod: Record<string, Record<string, unknown>> = {};
  if (Array.isArray(et.trend)) {
    for (const t of et.trend) {
      const period = (t.period as string) ?? "";
      if (period) trendByPeriod[period] = t;
    }
  }
  const extractEstimate = (period: string): number | null => {
    const t = trendByPeriod[period];
    if (!t) return null;
    const ee = t.earningsEstimate as Record<string, YfNumeric> | undefined;
    return ee ? n(ee.avg) : null;
  };
  const extractGrowth = (period: string): number | null => {
    const t = trendByPeriod[period];
    if (!t) return null;
    const g = n(t.growth as YfNumeric);
    return g !== null ? Math.round(g * 100 * 10) / 10 : null; // 0.156 → 15.6%
  };
  const extractRevenueGrowth = (period: string): number | null => {
    const t = trendByPeriod[period];
    if (!t) return null;
    const re = t.revenueEstimate as Record<string, YfNumeric> | undefined;
    return re ? n(re.growth) !== null ? Math.round((n(re.growth) as number) * 100 * 10) / 10 : null : null;
  };

  // EPS revisions は当期+来期を合算
  let upLast7Days = 0,
    upLast30Days = 0,
    downLast7Days = 0,
    downLast30Days = 0;
  for (const period of ["0q", "+1q", "0y", "+1y"]) {
    const t = trendByPeriod[period];
    if (!t) continue;
    const er = t.epsRevisions as Record<string, YfNumeric> | undefined;
    if (!er) continue;
    upLast7Days += n(er.upLast7days) ?? 0;
    upLast30Days += n(er.upLast30days) ?? 0;
    downLast7Days += n(er.downLast7days) ?? 0;
    downLast30Days += n(er.downLast30days) ?? 0;
  }

  return {
    targetMeanPrice: targetMean,
    targetHighPrice: n(fd.targetHighPrice as YfNumeric),
    targetLowPrice: n(fd.targetLowPrice as YfNumeric),
    numberOfAnalysts: n(fd.numberOfAnalystOpinions as YfNumeric),
    recommendationMean: n(fd.recommendationMean as YfNumeric),
    recommendationKey: s(fd.recommendationKey as YfStr),

    currentPrice,
    upsidePct,
    forwardPE: null, // financialData にはなく defaultKeyStatistics 側、fundamentals 側で取得済

    recommendationCounts,
    recommendationDeltaBuy,

    epsEstimate: {
      currentQuarter: extractEstimate("0q"),
      nextQuarter: extractEstimate("+1q"),
      currentYear: extractEstimate("0y"),
      nextYear: extractEstimate("+1y"),
    },
    epsGrowthForecast: {
      currentQuarter: extractGrowth("0q"),
      currentYear: extractGrowth("0y"),
      nextYear: extractGrowth("+1y"),
    },
    epsRevisions: {
      upLast7Days,
      upLast30Days,
      downLast7Days,
      downLast30Days,
    },
    netRevisions30d: upLast30Days - downLast30Days,
    revenueGrowthForecast: extractRevenueGrowth("0y"),
  };
}
