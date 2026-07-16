/**
 * FRED API (Federal Reserve Economic Data, St. Louis Fed) ヘルパー
 *
 * 認証: FRED_API_KEY 環境変数 (無料登録、40文字)
 *
 * Cavka が使う主要シリーズID:
 *   インフレ:     CPIAUCSL, CPILFESL, PCEPI, PCEPILFE
 *   雇用:         UNRATE, PAYEMS, ICSA (失業保険申請)
 *   金利:         FEDFUNDS (Fed Funds Rate), DGS10, DGS3MO, DGS2
 *   利回り曲線:   T10Y3M (10y-3m), T10Y2Y (10y-2y)  ← 逆イールドは景気後退の最強先行指標
 *   為替:         DEXJPUS (USD/JPY)
 *   景気判定:     USREC (NBER recession 1/0), SAHMREALTIME (Sahm Rule)
 *   生産活動:     INDPRO (鉱工業生産), PMI 系
 *   消費:         RSAFS (小売)
 *
 * API レート制限: 120 req/分。キャッシュ推奨。
 */

const FRED_BASE = "https://api.stlouisfed.org/fred";

export interface FredObservation {
  date: string;       // YYYY-MM-DD
  value: number | null;  // "." の場合は欠損 → null
}

export interface FredSeriesResult {
  seriesId: string;
  units: string | null;
  frequency: string | null;
  observations: FredObservation[];
  latest: FredObservation | null;
}

/**
 * 1シリーズの観測値を取得 (新しい順、デフォルト50件)
 */
export async function fetchFredSeries(
  seriesId: string,
  limit: number = 50
): Promise<FredSeriesResult | null> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error("FRED_API_KEY is not set");

  const url = `${FRED_BASE}/series/observations?series_id=${encodeURIComponent(seriesId)}&api_key=${apiKey}&file_type=json&limit=${limit}&sort_order=desc`;
  try {
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) {
      console.error(`FRED ${seriesId} HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    if (json.error_message) {
      console.warn(`FRED ${seriesId}: ${json.error_message}`);
      return null;
    }
    const obs: FredObservation[] = (json.observations ?? []).map((o: { date: string; value: string }) => ({
      date: o.date,
      value: o.value === "." ? null : Number(o.value),
    })).filter((o: FredObservation) => o.value === null || Number.isFinite(o.value));

    // 最新観測 (null除く)
    const latest = obs.find((o) => o.value !== null) ?? null;

    return {
      seriesId,
      units: json.units ?? null,
      frequency: json.frequency ?? null,
      observations: obs,
      latest,
    };
  } catch (err) {
    console.error(`FRED fetch error for ${seriesId}:`, err);
    return null;
  }
}

/**
 * 複数シリーズを並列取得 (デフォルト5並列、レート制限を考慮)
 */
export async function fetchFredSeriesBulk(
  seriesIds: string[],
  limitPerSeries: number = 50,
  parallel: number = 5
): Promise<Record<string, FredSeriesResult | null>> {
  const result: Record<string, FredSeriesResult | null> = {};
  for (let i = 0; i < seriesIds.length; i += parallel) {
    const batch = seriesIds.slice(i, i + parallel);
    const batchResults = await Promise.all(batch.map((id) => fetchFredSeries(id, limitPerSeries)));
    for (let j = 0; j < batch.length; j++) {
      result[batch[j]] = batchResults[j];
    }
  }
  return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 派生指標の計算ヘルパー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** N ヶ月前との変化率 (%) */
export function percentChangeFromMonthsAgo(
  observations: FredObservation[],
  months: number
): number | null {
  if (observations.length < months + 1) return null;
  const latest = observations.find((o) => o.value !== null);
  const past = observations.slice(months).find((o) => o.value !== null);
  if (!latest || !past || latest.value === null || past.value === null || past.value === 0) return null;
  return ((latest.value - past.value) / Math.abs(past.value)) * 100;
}

/** 前年同月比 (12ヶ月前と比較、YoY) */
export function yearOverYear(observations: FredObservation[]): number | null {
  return percentChangeFromMonthsAgo(observations, 12);
}

/** 直近 N 観測の平均値 */
export function recentAverage(observations: FredObservation[], n: number): number | null {
  const valid = observations.filter((o) => o.value !== null).slice(0, n);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + (b.value ?? 0), 0) / valid.length;
}

/** 値が前回から何 bp 変動したか (利回りなど) */
export function changeInBps(observations: FredObservation[], idx1: number, idx2: number): number | null {
  if (observations.length <= Math.max(idx1, idx2)) return null;
  const v1 = observations[idx1]?.value;
  const v2 = observations[idx2]?.value;
  if (v1 === null || v2 === null || v1 === undefined || v2 === undefined) return null;
  return Math.round((v1 - v2) * 100);  // % → bps
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// マクロ予兆: FRB 政策方向の推定 (簡易モデル)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface FedPolicyOutlook {
  currentRate: number | null;        // 現在の Fed Funds Rate
  recentChangeBps: number | null;    // 直近の変化 (bps)
  cpiYoY: number | null;             // CPI 前年同月比 (%)
  coreCpiYoY: number | null;         // Core CPI 前年同月比
  unemploymentRate: number | null;
  unemploymentTrend: "improving" | "stable" | "worsening" | null;
  // 推定確率 (簡易モデル、市場織込みではない)
  probRateCut: number;               // 0-100
  probRateHold: number;
  probRateHike: number;
  rationale: string[];               // 根拠
}

export function estimateFedPolicyOutlook(
  fedFunds: FredSeriesResult | null,
  cpi: FredSeriesResult | null,
  coreCpi: FredSeriesResult | null,
  unrate: FredSeriesResult | null
): FedPolicyOutlook {
  const rationale: string[] = [];
  let scoreCut = 33, scoreHold = 34, scoreHike = 33; // base equal

  const currentRate = fedFunds?.latest?.value ?? null;
  // 直近変化 (月次)
  const recentChange = fedFunds ? changeInBps(fedFunds.observations, 0, 3) : null;

  const cpiYoY = cpi ? yearOverYear(cpi.observations) : null;
  const coreCpiYoY = coreCpi ? yearOverYear(coreCpi.observations) : null;
  const unemploymentRate = unrate?.latest?.value ?? null;

  // 失業率トレンド (3ヶ月前と比較)
  let unTrend: FedPolicyOutlook["unemploymentTrend"] = null;
  if (unrate && unrate.observations.length >= 4) {
    const now = unrate.latest?.value ?? null;
    const past = unrate.observations.slice(3).find((o) => o.value !== null)?.value ?? null;
    if (now !== null && past !== null) {
      const diff = now - past;
      if (diff <= -0.2) unTrend = "improving";
      else if (diff >= 0.3) unTrend = "worsening";
      else unTrend = "stable";
    }
  }

  // ロジック (FRB のデュアルマンデートを単純化):
  //   - インフレ高 (CPI YoY > 3%) → 利上げ圧力
  //   - インフレ低 (CPI YoY < 2%) → 利下げ圧力
  //   - 失業率上昇 → 利下げ圧力
  //   - 失業率低下 (安定) → 利上げ余地
  if (coreCpiYoY !== null) {
    if (coreCpiYoY >= 3.5) {
      scoreHike += 15; scoreCut -= 10;
      rationale.push(`Core CPI 前年比 +${coreCpiYoY.toFixed(1)}% (FRB 目標 2% 大幅超 → 利上げ圧力)`);
    } else if (coreCpiYoY >= 2.5) {
      scoreHike += 5;
      rationale.push(`Core CPI 前年比 +${coreCpiYoY.toFixed(1)}% (目標やや上 → 利下げ慎重)`);
    } else if (coreCpiYoY < 2.0) {
      scoreCut += 15; scoreHike -= 10;
      rationale.push(`Core CPI 前年比 +${coreCpiYoY.toFixed(1)}% (目標下 → 利下げ余地)`);
    } else {
      rationale.push(`Core CPI 前年比 +${coreCpiYoY.toFixed(1)}% (目標近辺)`);
    }
  }
  if (unTrend === "worsening" && unemploymentRate !== null) {
    scoreCut += 20; scoreHike -= 15;
    rationale.push(`失業率 ${unemploymentRate.toFixed(1)}% 悪化トレンド → 利下げ圧力強い`);
  } else if (unTrend === "improving" && unemploymentRate !== null && unemploymentRate <= 4) {
    scoreHike += 5;
    rationale.push(`失業率 ${unemploymentRate.toFixed(1)}% 改善 → 経済堅調、利下げ急がず`);
  } else if (unemploymentRate !== null) {
    rationale.push(`失業率 ${unemploymentRate.toFixed(1)}% (安定)`);
  }

  // 直近の方向感
  if (recentChange !== null) {
    if (recentChange <= -25) {
      scoreCut += 10;
      rationale.push(`直近3ヶ月で ${Math.abs(recentChange)} bps 利下げ済 → 緩和トレンド継続観測`);
    } else if (recentChange >= 25) {
      scoreHike += 10;
      rationale.push(`直近3ヶ月で ${recentChange} bps 利上げ済 → 引き締めトレンド継続`);
    }
  }

  // 正規化 (合計 100)
  const total = scoreCut + scoreHold + scoreHike;
  return {
    currentRate,
    recentChangeBps: recentChange,
    cpiYoY,
    coreCpiYoY,
    unemploymentRate,
    unemploymentTrend: unTrend,
    probRateCut: Math.round((scoreCut / total) * 100),
    probRateHold: Math.round((scoreHold / total) * 100),
    probRateHike: Math.round((scoreHike / total) * 100),
    rationale,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BOJ 政策方向の推定 (簡易モデル、Fed と類似アプローチ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface BojPolicyOutlook {
  currentRate: number | null;          // 短期金利 (3M Interbank, BOJ ターゲット代理)
  recentChangeBps: number | null;      // 直近12ヶ月の bps 変化
  cpiYoY: number | null;               // 日本CPI YoY (%)
  unemploymentRate: number | null;     // 日本失業率
  jgb10y: number | null;               // 10年JGB利回り
  jgb10yChange3m: number | null;       // 10Y JGB 直近3ヶ月の bps 変化
  usdJpy: number | null;               // USD/JPY (円安は利上げ圧力)
  // Cavka 簡易モデル
  probRateCut: number;
  probRateHold: number;
  probRateHike: number;
  rationale: string[];
}

export function estimateBojPolicyOutlook(
  callRate: FredSeriesResult | null,
  jpnCpi: FredSeriesResult | null,
  jpnUnrate: FredSeriesResult | null,
  jgb10y: FredSeriesResult | null,
  usdJpy: number | null
): BojPolicyOutlook {
  const rationale: string[] = [];
  let scoreCut = 20, scoreHold = 50, scoreHike = 30; // base: BOJ は基本「据置」寄り

  const currentRate = callRate?.latest?.value ?? null;
  // BOJ は動きが遅いので 12ヶ月変化を見る
  const recentChange = callRate ? changeInBps(callRate.observations, 0, 12) : null;
  const cpiYoY = jpnCpi ? yearOverYear(jpnCpi.observations) : null;
  const unemploymentRate = jpnUnrate?.latest?.value ?? null;
  const jgb10yVal = jgb10y?.latest?.value ?? null;
  const jgb10yChg = jgb10y ? changeInBps(jgb10y.observations, 0, 3) : null;

  // インフレ判定 (BOJ ターゲット 2%)
  if (cpiYoY !== null) {
    if (cpiYoY >= 3.0) {
      scoreHike += 25; scoreCut -= 15; scoreHold -= 10;
      rationale.push(`日本CPI YoY +${cpiYoY.toFixed(1)}% (BOJ目標2%大幅超 → 利上げ圧力)`);
    } else if (cpiYoY >= 2.0) {
      scoreHike += 10; scoreHold -= 5;
      rationale.push(`日本CPI YoY +${cpiYoY.toFixed(1)}% (目標達成、持続性確認段階 → 段階的利上げ余地)`);
    } else if (cpiYoY >= 1.0) {
      rationale.push(`日本CPI YoY +${cpiYoY.toFixed(1)}% (目標下回り → 据置寄り)`);
    } else {
      scoreCut += 15; scoreHike -= 10;
      rationale.push(`日本CPI YoY +${cpiYoY.toFixed(1)}% (デフレリスク → 緩和方向)`);
    }
  }

  // 円安は BOJ への利上げ圧力 (輸入インフレ + 政治的圧力)
  if (usdJpy !== null) {
    if (usdJpy >= 155) {
      scoreHike += 15; scoreCut -= 5;
      rationale.push(`USD/JPY ${usdJpy.toFixed(1)} (円安進行 → 利上げで円防衛圧力)`);
    } else if (usdJpy >= 150) {
      scoreHike += 5;
      rationale.push(`USD/JPY ${usdJpy.toFixed(1)} (円安方向、利上げ余地観察)`);
    } else if (usdJpy <= 140) {
      scoreHike -= 5; scoreCut += 5;
      rationale.push(`USD/JPY ${usdJpy.toFixed(1)} (円高方向 → 利上げ動機薄)`);
    }
  }

  // 失業率 (上昇は緩和方向、ただし日本は構造的に低い)
  if (unemploymentRate !== null) {
    if (unemploymentRate >= 3.0) {
      scoreCut += 10; scoreHike -= 5;
      rationale.push(`日本失業率 ${unemploymentRate.toFixed(1)}% (上昇傾向、緩和圧力)`);
    } else if (unemploymentRate <= 2.5) {
      rationale.push(`日本失業率 ${unemploymentRate.toFixed(1)}% (歴史的低水準、利上げ余地)`);
    }
  }

  // 10Y JGB の急上昇 = 市場が利上げを織込みに行ってる
  if (jgb10yChg !== null && jgb10yChg >= 20) {
    scoreHike += 10;
    rationale.push(`10年JGB 直近3M +${jgb10yChg}bps (市場が利上げ織込み中)`);
  } else if (jgb10yChg !== null && jgb10yChg <= -20) {
    scoreCut += 5;
    rationale.push(`10年JGB 直近3M ${jgb10yChg}bps (利回り低下、緩和観測)`);
  }

  // 直近の方向感 (12ヶ月)
  if (recentChange !== null && recentChange >= 25) {
    scoreHike += 5;
    rationale.push(`過去12ヶ月で +${recentChange}bps 利上げ済 → 正常化トレンド継続観測`);
  }

  // 正規化
  scoreCut = Math.max(scoreCut, 1);
  scoreHold = Math.max(scoreHold, 1);
  scoreHike = Math.max(scoreHike, 1);
  const total = scoreCut + scoreHold + scoreHike;

  return {
    currentRate,
    recentChangeBps: recentChange,
    cpiYoY,
    unemploymentRate,
    jgb10y: jgb10yVal,
    jgb10yChange3m: jgb10yChg,
    usdJpy,
    probRateCut: Math.round((scoreCut / total) * 100),
    probRateHold: Math.round((scoreHold / total) * 100),
    probRateHike: Math.round((scoreHike / total) * 100),
    rationale,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 景気後退確率 (Yield Curve + Sahm Rule)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface RecessionOutlook {
  yieldCurveT10Y3M: number | null;   // 10y - 3m スプレッド (%)
  yieldCurveT10Y2Y: number | null;   // 10y - 2y スプレッド
  isInverted: boolean;                // 逆イールド検出
  monthsSinceInversion: number | null; // 逆イールド継続月数
  unemploymentRise: number | null;    // 直近 12ヶ月の失業率最低からの上昇 (Sahm Rule の素材)
  sahmRuleTriggered: boolean;         // Sahm Rule (失業率3ヶ月平均 - 過去12ヶ月最低 >= 0.5)
  // 統合確率 (Cavka 独自の簡易モデル)
  probRecession12m: number;           // 12ヶ月以内のリセッション確率
  signals: string[];
}

export function estimateRecessionOutlook(
  t10y3m: FredSeriesResult | null,
  t10y2y: FredSeriesResult | null,
  unrate: FredSeriesResult | null
): RecessionOutlook {
  const signals: string[] = [];
  let score = 10; // base 10% (常にゼロではない)

  const yc3m = t10y3m?.latest?.value ?? null;
  const yc2y = t10y2y?.latest?.value ?? null;
  const isInverted = (yc3m !== null && yc3m < 0) || (yc2y !== null && yc2y < 0);

  // 逆イールドの継続月数を計算 (T10Y3M ベース)
  let monthsSinceInversion: number | null = null;
  if (t10y3m && t10y3m.observations.length > 0) {
    // 直近で連続して負の値が何ヶ月続いているか
    let m = 0;
    for (const o of t10y3m.observations) {
      if (o.value !== null && o.value < 0) m++;
      else break;
    }
    monthsSinceInversion = m > 0 ? m : null;
  }

  if (isInverted) {
    if (monthsSinceInversion !== null && monthsSinceInversion >= 6) {
      score += 40;
      signals.push(`逆イールド (10y-3m: ${yc3m?.toFixed(2)}%) が ${monthsSinceInversion}ヶ月継続 → 強い景気後退シグナル`);
    } else {
      score += 25;
      signals.push(`逆イールド (10y-3m: ${yc3m?.toFixed(2)}%) 発生中 → 景気後退兆候`);
    }
  } else if (yc3m !== null && yc3m < 0.3) {
    score += 10;
    signals.push(`イールド曲線フラット化 (10y-3m: ${yc3m.toFixed(2)}%) → 経済成長鈍化兆候`);
  }

  // Sahm Rule: 3ヶ月平均失業率 - 過去12ヶ月の最低 >= 0.5
  let sahmTriggered = false;
  let unemploymentRise: number | null = null;
  if (unrate && unrate.observations.length >= 12) {
    const validObs = unrate.observations.filter((o) => o.value !== null);
    const recent3 = validObs.slice(0, 3).map((o) => o.value as number);
    const recent3Avg = recent3.reduce((a, b) => a + b, 0) / recent3.length;
    const past12 = validObs.slice(0, 12).map((o) => o.value as number);
    const minPast = Math.min(...past12);
    unemploymentRise = recent3Avg - minPast;
    if (unemploymentRise >= 0.5) {
      sahmTriggered = true;
      score += 35;
      signals.push(`Sahm Rule 発動 (失業率 +${unemploymentRise.toFixed(2)}pt) → 景気後退入り高確率`);
    } else if (unemploymentRise >= 0.3) {
      score += 10;
      signals.push(`失業率上昇 +${unemploymentRise.toFixed(2)}pt → Sahm Rule 接近中`);
    }
  }

  return {
    yieldCurveT10Y3M: yc3m,
    yieldCurveT10Y2Y: yc2y,
    isInverted,
    monthsSinceInversion,
    unemploymentRise,
    sahmRuleTriggered: sahmTriggered,
    probRecession12m: Math.min(95, Math.max(5, score)),
    signals,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// USD/JPY 為替の状況
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface FxOutlook {
  usdJpy: number | null;
  changeFrom30d: number | null;       // 30日前比 (%)
  near155: boolean;                   // 介入閾値接近
  signals: string[];
}

export function estimateFxOutlook(fx: FredSeriesResult | null): FxOutlook {
  const signals: string[] = [];
  const latest = fx?.latest?.value ?? null;
  const change30d = fx ? percentChangeFromMonthsAgo(fx.observations, 1) : null;
  const near155 = latest !== null && latest >= 152;
  if (near155) {
    signals.push(`USD/JPY ${latest?.toFixed(1)} - 介入閾値 (155) 接近、円安一服の可能性`);
  }
  if (change30d !== null) {
    if (change30d >= 2) signals.push(`過去30日で円安進行 +${change30d.toFixed(1)}% → 輸出株追い風継続`);
    else if (change30d <= -2) signals.push(`過去30日で円高進行 ${change30d.toFixed(1)}% → 輸出株注意`);
  }
  return { usdJpy: latest, changeFrom30d: change30d, near155, signals };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 原油動向 (WTI + Brent)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface OilOutlook {
  wti: number | null;             // WTI 現在価格 ($/bbl)
  brent: number | null;
  wtiChange30d: number | null;    // 30日前比 (%)
  wtiChange90d: number | null;
  spread: number | null;          // Brent - WTI スプレッド
  direction: "up" | "down" | "sideways";
  highPrice: boolean;             // $80 超え = 高水準
  lowPrice: boolean;              // $60 下回り = 低水準
  signals: string[];
}

export function estimateOilOutlook(
  wti: FredSeriesResult | null,
  brent: FredSeriesResult | null
): OilOutlook {
  const signals: string[] = [];
  const wtiPrice = wti?.latest?.value ?? null;
  const brentPrice = brent?.latest?.value ?? null;
  const wtiChange30d = wti ? percentChangeFromMonthsAgo(wti.observations, 1) : null;
  const wtiChange90d = wti ? percentChangeFromMonthsAgo(wti.observations, 3) : null;
  const spread = wtiPrice !== null && brentPrice !== null ? brentPrice - wtiPrice : null;

  let direction: OilOutlook["direction"] = "sideways";
  if (wtiChange30d !== null) {
    if (wtiChange30d >= 5) direction = "up";
    else if (wtiChange30d <= -5) direction = "down";
  }

  const highPrice = wtiPrice !== null && wtiPrice >= 80;
  const lowPrice = wtiPrice !== null && wtiPrice <= 60;

  if (highPrice) {
    signals.push(`WTI $${wtiPrice?.toFixed(1)} - 高水準 → エネルギー株/総合商社追い風、運輸・電力・化学にコスト圧`);
  }
  if (lowPrice) {
    signals.push(`WTI $${wtiPrice?.toFixed(1)} - 低水準 → エネルギー株逆風、運輸・電力・化学にメリット`);
  }
  if (wtiChange30d !== null && Math.abs(wtiChange30d) >= 5) {
    const sign = wtiChange30d > 0 ? "+" : "";
    signals.push(`過去30日で${sign}${wtiChange30d.toFixed(1)}% 変動 → 関連株のトレンド注視`);
  }
  if (spread !== null && spread >= 5) {
    signals.push(`Brent-WTI スプレッド $${spread.toFixed(1)} → 米産原油の優位性、米シェール関連株に追い風`);
  }
  if (wtiChange90d !== null && wtiChange90d >= 15) {
    signals.push(`過去90日で +${wtiChange90d.toFixed(1)}% 上昇 → インフレ再燃懸念、FRBの利下げ慎重化要因`);
  } else if (wtiChange90d !== null && wtiChange90d <= -15) {
    signals.push(`過去90日で ${wtiChange90d.toFixed(1)}% 下落 → 物価安定要因、利下げを後押し`);
  }

  return {
    wti: wtiPrice,
    brent: brentPrice,
    wtiChange30d,
    wtiChange90d,
    spread,
    direction,
    highPrice,
    lowPrice,
    signals,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 半導体サイクル (FRED 生産・PPI + Yahoo SMH ETF)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface SemiCycleOutlook {
  productionIndex: number | null;       // IPG3344S 半導体製造業 生産指数
  productionYoY: number | null;         // 前年同月比 (%)
  ppi: number | null;                   // PCU3344133441 半導体 PPI
  ppiYoY: number | null;
  smhPrice: number | null;              // VanEck Semiconductor ETF 価格 (USD)
  smhChange3m: number | null;           // 3ヶ月前比 (%)
  smhChange1y: number | null;           // 1年前比 (%)
  cycleStage: "boom" | "expansion" | "peak" | "contraction" | "trough" | "neutral";
  cycleScore: number;                   // -100 〜 +100
  signals: string[];
}

/**
 * Yahoo の SMH ETF 月足を取得 (FRED の月次データと粒度合わせる)
 */
export async function fetchSmhMonthly(): Promise<{ price: number | null; change3m: number | null; change1y: number | null } | null> {
  try {
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/SMH?range=1y&interval=1mo";
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const r = json.chart?.result?.[0];
    if (!r) return null;
    const closes = (r.indicators?.quote?.[0]?.close ?? []).filter((c: number | null): c is number => c !== null);
    const price = r.meta?.regularMarketPrice ?? null;
    if (price === null || closes.length < 2) return { price, change3m: null, change1y: null };
    const oldest = closes[0];
    const threeAgo = closes.length >= 4 ? closes[closes.length - 4] : null;
    const change1y = oldest > 0 ? ((price - oldest) / oldest) * 100 : null;
    const change3m = threeAgo !== null && threeAgo > 0 ? ((price - threeAgo) / threeAgo) * 100 : null;
    return { price, change3m, change1y };
  } catch {
    return null;
  }
}

export function estimateSemiCycleOutlook(
  production: FredSeriesResult | null,
  ppi: FredSeriesResult | null,
  smh: { price: number | null; change3m: number | null; change1y: number | null } | null
): SemiCycleOutlook {
  const signals: string[] = [];
  let score = 0;

  const productionIndex = production?.latest?.value ?? null;
  const productionYoY = production ? yearOverYear(production.observations) : null;
  const ppiValue = ppi?.latest?.value ?? null;
  const ppiYoY = ppi ? yearOverYear(ppi.observations) : null;
  const smhPrice = smh?.price ?? null;
  const smhChange3m = smh?.change3m ?? null;
  const smhChange1y = smh?.change1y ?? null;

  // SMH モメンタム (最重要、市場の織込みを反映)
  if (smhChange1y !== null) {
    if (smhChange1y >= 50) {
      score += 50;
      signals.push(`SMH ETF 過去1年で +${smhChange1y.toFixed(0)}% → 強いブル相場`);
    } else if (smhChange1y >= 20) {
      score += 30;
      signals.push(`SMH ETF 過去1年で +${smhChange1y.toFixed(0)}% → 拡大期`);
    } else if (smhChange1y >= 0) {
      score += 10;
      signals.push(`SMH ETF 過去1年で +${smhChange1y.toFixed(0)}% (緩やか)`);
    } else if (smhChange1y >= -20) {
      score -= 20;
      signals.push(`SMH ETF 過去1年で ${smhChange1y.toFixed(0)}% → 調整局面`);
    } else {
      score -= 40;
      signals.push(`SMH ETF 過去1年で ${smhChange1y.toFixed(0)}% → 弱気相場`);
    }
  }
  if (smhChange3m !== null) {
    if (smhChange3m >= 10) {
      score += 15;
      signals.push(`SMH ETF 直近3ヶ月 +${smhChange3m.toFixed(1)}% (上昇加速)`);
    } else if (smhChange3m <= -10) {
      score -= 15;
      signals.push(`SMH ETF 直近3ヶ月 ${smhChange3m.toFixed(1)}% (下落加速)`);
    }
  }

  // 生産指数 (実体経済の動き、遅行指標)
  if (productionYoY !== null) {
    if (productionYoY >= 15) {
      score += 20;
      signals.push(`半導体生産 前年比 +${productionYoY.toFixed(1)}% → 実需活況`);
    } else if (productionYoY >= 5) {
      score += 10;
      signals.push(`半導体生産 前年比 +${productionYoY.toFixed(1)}%`);
    } else if (productionYoY < 0) {
      score -= 15;
      signals.push(`半導体生産 前年比 ${productionYoY.toFixed(1)}% → 実需弱含み`);
    }
  }
  // PPI (価格の動向)
  if (ppiYoY !== null) {
    if (ppiYoY >= 5) {
      score += 5;
      signals.push(`半導体PPI 前年比 +${ppiYoY.toFixed(1)}% → 価格上昇トレンド`);
    } else if (ppiYoY <= -10) {
      score -= 5;
      signals.push(`半導体PPI 前年比 ${ppiYoY.toFixed(1)}% → 値下げ圧力`);
    }
  }

  // クリップ
  score = Math.max(-100, Math.min(100, score));

  // ステージ判定
  let cycleStage: SemiCycleOutlook["cycleStage"];
  if (score >= 60) cycleStage = "boom";
  else if (score >= 25) cycleStage = "expansion";
  else if (score >= -10) cycleStage = "neutral";
  else if (score >= -40) cycleStage = "contraction";
  else cycleStage = "trough";

  // Peak 検出: 過去 SMH 大幅上昇 + 直近モメンタム鈍化
  if (smhChange1y !== null && smhChange1y >= 50 && smhChange3m !== null && smhChange3m < 5) {
    cycleStage = "peak";
    signals.push(`⚠ Peak 兆候: 1年で大幅上昇後、足元で減速`);
    score -= 10;
  }

  return {
    productionIndex,
    productionYoY,
    ppi: ppiValue,
    ppiYoY,
    smhPrice,
    smhChange3m,
    smhChange1y,
    cycleStage,
    cycleScore: score,
    signals,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 中国景気 (商品価格を中国デマンド代理として利用)
//   - 銅 (PCOPPUSDM): 中国が世界消費の50%超 → 中国景気のバロメーター "Dr. Copper"
//   - 鉄鉱石 (PIORECRUSDM): 中国が世界輸入の70%超 → 中国建設・粗鋼の代理
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface ChinaOutlook {
  copper: number | null;             // $/MT
  copperChange3m: number | null;     // 3か月前比 (%)
  ironOre: number | null;            // index
  ironOreChange3m: number | null;
  // 中国景気代理スコア (-100 弱気 ～ +100 強気)
  demandScore: number;
  demandLabel: "expansion" | "neutral" | "contraction";
  signals: string[];
}

export function estimateChinaOutlook(
  copper: FredSeriesResult | null,
  ironOre: FredSeriesResult | null
): ChinaOutlook {
  const signals: string[] = [];
  const copperPrice = copper?.latest?.value ?? null;
  const copper3m = copper ? percentChangeFromMonthsAgo(copper.observations, 3) : null;
  const ironOrePrice = ironOre?.latest?.value ?? null;
  const ironOre3m = ironOre ? percentChangeFromMonthsAgo(ironOre.observations, 3) : null;

  let score = 0;
  if (copper3m !== null) {
    if (copper3m >= 10) {
      score += 40;
      signals.push(`銅価格 +${copper3m.toFixed(1)}% (3M) → 中国製造業の需要旺盛 (Dr. Copper)`);
    } else if (copper3m >= 5) {
      score += 20;
      signals.push(`銅価格 +${copper3m.toFixed(1)}% → 中国需要回復兆候`);
    } else if (copper3m <= -10) {
      score -= 40;
      signals.push(`銅価格 ${copper3m.toFixed(1)}% → 中国製造業の減速、商社・機械に逆風`);
    } else if (copper3m <= -5) {
      score -= 20;
      signals.push(`銅価格 ${copper3m.toFixed(1)}% → 中国需要鈍化兆候`);
    }
  }
  if (ironOre3m !== null) {
    if (ironOre3m >= 10) {
      score += 30;
      signals.push(`鉄鉱石 +${ironOre3m.toFixed(1)}% → 中国建設・粗鋼回復、鉄鋼・海運に追い風`);
    } else if (ironOre3m <= -10) {
      score -= 30;
      signals.push(`鉄鉱石 ${ironOre3m.toFixed(1)}% → 中国不動産・粗鋼弱含み、海運・鉄鋼に逆風`);
    }
  }

  // -100 〜 +100 にクリップ
  score = Math.max(-100, Math.min(100, score));
  let label: ChinaOutlook["demandLabel"];
  if (score >= 30) label = "expansion";
  else if (score <= -30) label = "contraction";
  else label = "neutral";

  return {
    copper: copperPrice,
    copperChange3m: copper3m,
    ironOre: ironOrePrice,
    ironOreChange3m: ironOre3m,
    demandScore: score,
    demandLabel: label,
    signals,
  };
}
