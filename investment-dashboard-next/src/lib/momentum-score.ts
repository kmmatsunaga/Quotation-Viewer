/**
 * モメンタム・グロース・スクリーニングモデル (momentum_growth_v1)
 *
 * 設計仕様: docs/momentum_growth_model.md
 * パラメータ: src/lib/momentum-params.ts
 *
 * MD §7 計算順序:
 *   ① universe抽出 (呼び出し側)
 *   ② 除外ゲート ← 先に通す
 *   ③ P1〜T のサブスコア計算
 *   ④ 合成・ソート (呼び出し側)
 *
 * 重み (= MD §1):
 *   P1 Growth Acceleration  30
 *   P2 Estimate Momentum    25 (TDnetガイダンス無のため cons改定+サプライズで再配分)
 *   P3 Margin Expansion     20
 *   P4 Pricing Power        10
 *   T  Technical Confirm    15
 */

import { DEFAULT_PARAMS, type MomentumParams } from "./momentum-params";

const raw = (obj: Record<string, unknown> | undefined, key: string): number | null => {
  if (!obj) return null;
  const v = obj[key];
  if (v && typeof v === "object" && "raw" in (v as Record<string, unknown>)) {
    return (v as { raw: number }).raw;
  }
  if (typeof v === "number") return v;
  return null;
};

const clip = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

export interface MomentumScoreInput {
  ticker: string;
  // Yahoo quoteSummary modules (raw)
  financialData?: Record<string, unknown>;
  defaultKeyStatistics?: Record<string, unknown>;
  summaryDetail?: Record<string, unknown>;
  earningsHistory?: Record<string, unknown>;
  earningsTrend?: Record<string, unknown>;
  incomeStatementHistoryQuarterly?: Record<string, unknown>;
  quoteType?: Record<string, unknown>;
  // Chart-derived (closes は新しい順)
  closes?: (number | null)[];
  volumes?: (number | null)[];
  high52w?: number | null;
  ma50?: number | null;
  ma200?: number | null;
  ma200_20dAgo?: number | null;
  turnover20d?: number | null;
  rs6mPercentile?: number | null;
  // 12M リターン (no_base_gate 用)
  return12m?: number | null;
  // 12M 中の最大ドローダウン (= ベース判定用)
  maxDrawdown12m?: number | null;
  // 上場後経過四半期数 (IPO直後判定)
  quartersListed?: number | null;
  // 未発見フォーカス用 (MD 範囲外)
  marketCap?: number | null;       // 報告通貨ベース (JPY for JP, USD for US)
  market?: "JP" | "US";
  numberOfAnalysts?: number | null;
}

export interface MomentumScoreResult {
  ticker: string;
  finalScore: number;              // 0-100 (除外時 -1)
  passes: boolean;
  excludeReason: string | null;
  // サブスコア
  p1Growth: number;
  p2Estimate: number;
  p3Margin: number;
  p4Pricing: number;
  tTechnical: number;
  softPenalty: number;             // PEG soft 減点 (X とは別、final から減算済)
  flags: string[];                 // 警告 (除外には至らないが注意)
  diagnostics: {
    // P1
    revYoyQ0: number | null;
    revYoyQ1: number | null;
    revAccel: number | null;
    epsYoyQ0: number | null;
    accelStreak: boolean;
    // P2
    consEpsRev: number | null;
    surpriseStreak: number;
    // P3
    opMargin: number | null;
    opMarginYoy: number | null;
    opLeverage: number | null;
    // P4
    grossMargin: number | null;
    roe: number | null;
    // T
    aboveMa200: boolean;
    ma200SlopeUp: boolean;
    near52wHigh: boolean;
    // X
    extFromMa200: number | null;
    return12m: number | null;
    maxDrawdown12m: number | null;
    pegRatio: number | null;
    quartersListed: number | null;
    marketCap: number | null;
    numberOfAnalysts: number | null;
  };
}

export function computeMomentumScore(
  input: MomentumScoreInput,
  params: MomentumParams = DEFAULT_PARAMS
): MomentumScoreResult {
  const P = params;
  const diag: MomentumScoreResult["diagnostics"] = {
    revYoyQ0: null, revYoyQ1: null, revAccel: null, epsYoyQ0: null, accelStreak: false,
    consEpsRev: null, surpriseStreak: 0,
    opMargin: null, opMarginYoy: null, opLeverage: null,
    grossMargin: null, roe: null,
    aboveMa200: false, ma200SlopeUp: false, near52wHigh: false,
    extFromMa200: null,
    return12m: input.return12m ?? null,
    maxDrawdown12m: input.maxDrawdown12m ?? null,
    pegRatio: null,
    quartersListed: input.quartersListed ?? null,
    marketCap: input.marketCap ?? null,
    numberOfAnalysts: input.numberOfAnalysts ?? null,
  };
  const flags: string[] = [];

  // 生データの事前抽出 (除外ゲートとサブスコア両方で使う)
  const revGrowthYoy = raw(input.financialData, "revenueGrowth");
  const earningsGrowthYoy = raw(input.financialData, "earningsGrowth");
  const opMargin = raw(input.financialData, "operatingMargins");
  const grossMargin = raw(input.financialData, "grossMargins");
  const roe = raw(input.financialData, "returnOnEquity");
  const pegRatio = raw(input.defaultKeyStatistics, "pegRatio");

  diag.revYoyQ0 = revGrowthYoy;
  diag.epsYoyQ0 = earningsGrowthYoy;
  diag.opMargin = opMargin;
  diag.grossMargin = grossMargin;
  diag.roe = roe;
  diag.pegRatio = pegRatio;

  // 四半期 IS (Yahoo は通常 trailing 4Q)
  const quarters = ((input.incomeStatementHistoryQuarterly?.incomeStatementHistory ?? []) as Array<Record<string, unknown>>) || [];
  const revs = quarters.map((q) => raw(q, "totalRevenue")).filter((v): v is number => v !== null);

  // 加速度 (Q0 vs Q-1 の前期比、YoY 四半期データ無い時の代替)
  let revAccel: number | null = null;
  if (revs.length >= 2 && revs[1] > 0) {
    revAccel = (revs[0] - revs[1]) / revs[1];
  }
  diag.revAccel = revAccel;
  diag.revYoyQ1 = revs.length >= 4 && revs[3] > 0 ? (revs[1] - revs[3]) / revs[3] : null;
  diag.accelStreak = diag.revYoyQ0 !== null && diag.revYoyQ1 !== null && diag.revYoyQ0 > diag.revYoyQ1;

  // 営業利益率 YoY (Q0 vs Q-3)
  let opMarginYoy: number | null = null;
  if (quarters.length >= 4) {
    const op0 = raw(quarters[0], "operatingIncome");
    const rev0 = raw(quarters[0], "totalRevenue");
    const op3 = raw(quarters[3], "operatingIncome");
    const rev3 = raw(quarters[3], "totalRevenue");
    if (op0 !== null && rev0 && op3 !== null && rev3) {
      opMarginYoy = op0 / rev0 - op3 / rev3;
    }
  }
  diag.opMarginYoy = opMarginYoy;

  let opLeverage: number | null = null;
  if (earningsGrowthYoy !== null && revGrowthYoy !== null) {
    opLeverage = earningsGrowthYoy - revGrowthYoy;
  }
  diag.opLeverage = opLeverage;

  // コンセンサスEPS改定率
  const trends = ((input.earningsTrend?.trend ?? []) as Array<Record<string, unknown>>) || [];
  const currentYear = trends.find((t) => t.period === "0y") ?? trends.find((t) => t.period === "+1y");
  let consEpsRev: number | null = null;
  if (currentYear) {
    const est = currentYear.earningsEstimate as Record<string, unknown> | undefined;
    const currAvg = raw(est, "avg");
    const ago90 = raw(est, "90daysAgo");
    if (currAvg !== null && ago90 !== null && Math.abs(ago90) > 0.0001) {
      consEpsRev = (currAvg - ago90) / Math.abs(ago90);
    }
  }
  diag.consEpsRev = consEpsRev;

  // サプライズ連続
  const history = ((input.earningsHistory?.history ?? []) as Array<Record<string, unknown>>) || [];
  const sortedHist = [...history].sort(
    (a, b) => (raw(b, "quarter") ?? 0) - (raw(a, "quarter") ?? 0)
  );
  let streak = 0;
  for (const h of sortedHist) {
    const sp = raw(h, "surprisePercent");
    if (sp !== null && sp > 0) streak++;
    else break;
  }
  diag.surpriseStreak = streak;

  // テクニカル
  const close = input.closes?.[0] ?? null;
  const aboveMa200 = close !== null && input.ma200 !== null && input.ma200 !== undefined && close > input.ma200;
  const ma200SlopeUp =
    input.ma200 !== null && input.ma200 !== undefined &&
    input.ma200_20dAgo !== null && input.ma200_20dAgo !== undefined &&
    input.ma200 > input.ma200_20dAgo;
  const stage2 = aboveMa200 && ma200SlopeUp;
  const near52w = close !== null && input.high52w !== null && input.high52w !== undefined && close >= 0.85 * input.high52w;
  const extFromMa200 = close !== null && input.ma200 ? close / input.ma200 - 1 : null;

  diag.aboveMa200 = aboveMa200;
  diag.ma200SlopeUp = ma200SlopeUp;
  diag.near52wHigh = near52w;
  diag.extFromMa200 = extFromMa200;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ② 除外ゲート (MD §3) — サブスコア計算より先
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  let passes = true;
  let excludeReason: string | null = null;

  // liquidity_gate
  if (input.turnover20d !== null && input.turnover20d !== undefined && input.turnover20d < P.thresholds.MIN_TURNOVER) {
    passes = false; excludeReason = `liquidity_gate: 20日平均出来高 ¥${Math.round(input.turnover20d / 1_000_000)}M < ¥${P.thresholds.MIN_TURNOVER / 1_000_000}M`;
  }

  // megacap_gate (Cavka 独自): 「テンバガー余地なし」の超大型株を除外
  if (passes && input.marketCap !== null && input.marketCap !== undefined && input.market) {
    const cap = input.market === "JP" ? P.thresholds.MAX_MARKET_CAP_JPY : P.thresholds.MAX_MARKET_CAP_USD;
    if (input.marketCap > cap) {
      passes = false;
      const fmt = input.market === "JP"
        ? `¥${(input.marketCap / 1e12).toFixed(1)}兆`
        : `$${(input.marketCap / 1e9).toFixed(0)}B`;
      const capFmt = input.market === "JP" ? `¥${cap / 1e12}兆` : `$${cap / 1e9}B`;
      excludeReason = `megacap_gate: 時価総額 ${fmt} > ${capFmt} (テンバガー余地なし)`;
    }
  }

  // overcovered_gate (Cavka 独自): アナリストカバレッジが多すぎる = 市場に発見済み
  if (
    passes &&
    input.numberOfAnalysts !== null && input.numberOfAnalysts !== undefined &&
    input.numberOfAnalysts > P.thresholds.MAX_ANALYSTS
  ) {
    passes = false;
    excludeReason = `overcovered_gate: アナリスト ${input.numberOfAnalysts}人 > ${P.thresholds.MAX_ANALYSTS}人 (発見済み)`;
  }

  // runup_gate (Cavka 独自): 12M リターンが上限超え = 「もう主役」
  if (
    passes &&
    input.return12m !== null && input.return12m !== undefined &&
    input.return12m > P.thresholds.MAX_RETURN_12M
  ) {
    passes = false;
    excludeReason = `runup_gate: 12M +${Math.round(input.return12m * 100)}% > +${P.thresholds.MAX_RETURN_12M * 100}% (もう走り切った)`;
  }

  // parabolic_gate
  if (passes && extFromMa200 !== null && extFromMa200 > P.thresholds.MAX_EXT) {
    passes = false; excludeReason = `parabolic_gate: 200日線から +${Math.round(extFromMa200 * 100)}% > +${P.thresholds.MAX_EXT * 100}%`;
  }

  // no_base_gate: 12M リターンが BIG_RUNUP_12M を超え、かつ 12M中の最大DDが NO_BASE_DRAWDOWN未満 (=ベースなし)
  // ただし IPO直後 (quartersListed < MIN_QUARTERS_LISTED) は除外しない (MD §7-3)
  const ipoRecent = input.quartersListed !== null && input.quartersListed !== undefined && input.quartersListed < P.thresholds.MIN_QUARTERS_LISTED;
  if (
    passes &&
    !ipoRecent &&
    input.return12m !== null && input.return12m !== undefined && input.return12m > P.thresholds.BIG_RUNUP_12M &&
    input.maxDrawdown12m !== null && input.maxDrawdown12m !== undefined && input.maxDrawdown12m < P.thresholds.NO_BASE_DRAWDOWN
  ) {
    passes = false;
    excludeReason = `no_base_gate: 12Mで +${Math.round(input.return12m * 100)}%、最大DD ${Math.round(input.maxDrawdown12m * 100)}% (ベース無き急騰)`;
  }

  // guidance_cut_gate (TDnet無のため cons_eps_rev で代替)
  if (passes && consEpsRev !== null && consEpsRev <= P.thresholds.GUIDANCE_CUT_THRESHOLD) {
    passes = false;
    excludeReason = `guidance_cut_gate: コンセンサス改定 ${(consEpsRev * 100).toFixed(1)}% (= 下方修正)`;
  }

  // margin_break_gate: 増収だが op_margin_yoy < -3pt
  if (passes && revGrowthYoy !== null && revGrowthYoy > 0 && opMarginYoy !== null && opMarginYoy < -0.03) {
    passes = false;
    excludeReason = `margin_break_gate: 増収 +${(revGrowthYoy * 100).toFixed(1)}% だが営業利益率 ${(opMarginYoy * 100).toFixed(1)}pt悪化`;
  }

  // one_off_gate: Yahoo に特別損益分離が無いため当面未実装 (flag のみ)
  // (将来: EDINET 四半期報告書から特別利益を取得して判定)

  // 警告フラグ (除外には至らない)
  if (passes && extFromMa200 !== null && extFromMa200 > P.thresholds.MAX_EXT * 0.7) {
    flags.push(`extended: 200日線から +${Math.round(extFromMa200 * 100)}% (パラボリック寸前)`);
  }
  if (passes && near52w) {
    flags.push(`near_52w_high: 52週高値から -${Math.round((1 - (close! / input.high52w!)) * 100)}%`);
  }

  // 早期 return — 除外されたらサブスコア計算しない (MD §7-1 効率化)
  if (!passes) {
    return {
      ticker: input.ticker,
      finalScore: -1,
      passes: false,
      excludeReason,
      p1Growth: 0, p2Estimate: 0, p3Margin: 0, p4Pricing: 0, tTechnical: 0,
      softPenalty: 0,
      flags,
      diagnostics: diag,
    };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ③ サブスコア計算 (MD §2、formulas は原文ママ)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // P1: Growth Acceleration (MD §2.P1)
  let p1 = 0;
  p1 += 10 * clip((revGrowthYoy ?? 0) / P.thresholds.REV_GROWTH_FULL, 0, 1);
  if (revAccel !== null) {
    p1 += 10 * clip(revAccel / P.thresholds.ACCEL_FULL, 0, 1);
  }
  if (diag.accelStreak) p1 += 10;
  // 売上先行・利益置き去り罠
  if (earningsGrowthYoy !== null && earningsGrowthYoy <= 0) {
    p1 *= 0.5;
  }
  p1 = clip(p1, 0, P.weights.p1_growth);

  // P2: Estimate Momentum (再配分: cons + surprise)
  let p2 = 0;
  if (consEpsRev !== null) {
    p2 += P.p2_redistribution.cons_eps_rev * clip(consEpsRev / P.thresholds.CONS_REV_FULL, 0, 1);
  }
  p2 += P.p2_redistribution.surprise_streak * clip(streak / 3, 0, 1);
  // ガイダンス代理の下方修正ペナルティ (cons_eps_rev で代替)
  if (consEpsRev !== null && consEpsRev <= P.thresholds.GUIDANCE_CUT_THRESHOLD) {
    p2 -= P.p2_redistribution.guidance_down_penalty;
  }
  p2 = clip(p2, 0, P.weights.p2_estimate);

  // P3: Margin Expansion
  let p3 = 0;
  if (opMarginYoy !== null) p3 += 8 * clip(opMarginYoy / P.thresholds.OP_MARGIN_FULL, 0, 1);
  if (opLeverage !== null) p3 += 7 * clip(opLeverage / 0.15, 0, 1);
  // 粗利率 yoy は Yahoo に直接無し、代替で粗利率水準を5pt再配分
  if (grossMargin !== null) p3 += 5 * clip(grossMargin / P.thresholds.GM_LEVEL_FULL, 0, 1);
  p3 = clip(p3, 0, P.weights.p3_margin);

  // P4: Pricing Power
  let p4 = 0;
  if (grossMargin !== null) p4 += 4 * clip(grossMargin / P.thresholds.GM_LEVEL_FULL, 0, 1);
  if (roe !== null) p4 += 3 * clip(roe / 0.15, 0, 1);
  // theme_tag は未実装 → 残り3pt欠損 (将来テーマ辞書実装時に追加)
  p4 = clip(p4, 0, P.weights.p4_pricing);

  // T: Technical Confirmation
  let t = 0;
  if (stage2) t += 6;
  if (input.rs6mPercentile !== null && input.rs6mPercentile !== undefined) {
    t += 5 * clip(input.rs6mPercentile, 0, 1);
  }
  if (near52w) t += 2;
  // vol_ratio_50 未実装、当面 2pt 欠損
  t = clip(t, 0, P.weights.t_technical);

  // ④ 合成 + soft penalty (MD §3 valuation_sanity soft)
  let softPenalty = 0;
  if (P.exclusion.use_peg_soft && pegRatio !== null && pegRatio > P.thresholds.MAX_PEG) {
    softPenalty = P.exclusion.peg_soft_penalty;
    flags.push(`PEG soft: ${pegRatio.toFixed(2)} > ${P.thresholds.MAX_PEG} (−${softPenalty}pt)`);
  }

  const rawScore = p1 + p2 + p3 + p4 + t;
  const finalScore = Math.max(0, Math.round(rawScore - softPenalty));

  return {
    ticker: input.ticker,
    finalScore,
    passes: true,
    excludeReason: null,
    p1Growth: Math.round(p1 * 10) / 10,
    p2Estimate: Math.round(p2 * 10) / 10,
    p3Margin: Math.round(p3 * 10) / 10,
    p4Pricing: Math.round(p4 * 10) / 10,
    tTechnical: Math.round(t * 10) / 10,
    softPenalty,
    flags,
    diagnostics: diag,
  };
}
