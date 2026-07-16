/**
 * Chart Pattern Recognition Engine
 * iSpeed-style 25-pattern classification using MA5/MA25/MA75
 *
 * Grid: 5 directions × 5 phases
 *   Direction: 上昇 / やや上昇 / 横ばい / やや下降 / 下降
 *   Phase:     初期 / 中期 / 後期 / 転換初期 / 転換中期
 */

// ─── Types ───────────────────────────────────────────────────────

export type PatternDirection =
  | "strong_up"    // 上昇
  | "mild_up"      // やや上昇
  | "sideways"     // 横ばい
  | "mild_down"    // やや下降
  | "strong_down"; // 下降

export type PatternPhase =
  | "early"          // 初期
  | "mid"            // 中期
  | "late"           // 後期
  | "reversal_early" // 転換初期
  | "reversal_mid";  // 転換中期

export interface PatternInfo {
  id: string;
  direction: PatternDirection;
  phase: PatternPhase;
  label: string;        // Japanese name
  labelEn: string;      // English name
  description: string;  // Short description
  signal: "buy" | "sell" | "neutral" | "watch";
  strength: 1 | 2 | 3 | 4 | 5; // 1=weak, 5=strong
}

export interface MAValues {
  ma5: number;
  ma25: number;
  ma75: number;
}

export interface MASlopes {
  ma5Slope: number;   // normalized slope (% change per bar)
  ma25Slope: number;
  ma75Slope: number;
}

export interface PatternFeatures {
  maValues: MAValues;
  maSlopes: MASlopes;
  maOrder: "bull" | "bear" | "mixed"; // MA5 > MA25 > MA75 = bull
  priceVsMa5: number;   // price deviation from MA5 (%)
  priceVsMa25: number;  // price deviation from MA25 (%)
  priceVsMa75: number;  // price deviation from MA75 (%)
  roc5: number;         // 5-day rate of change (%)
  roc20: number;        // 20-day rate of change (%)
  ma5CrossMa25: "golden" | "dead" | "none"; // recent cross
  ma25CrossMa75: "golden" | "dead" | "none";
  maSpread: number;     // spread between MA5 and MA75 (%)
  maSpreading: boolean; // MAs are diverging
  maConverging: boolean; // MAs are converging
  higherHighs: boolean;
  lowerLows: boolean;
  volatility: number;   // recent volatility
  close: number;
}

export interface DetectedPattern {
  pattern: PatternInfo;
  confidence: number;   // 0-100
  features: PatternFeatures;
  timeframe: string;    // "daily" | "weekly" | "monthly"
}

export interface Candle {
  time: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Pattern Definitions (25 patterns) ───────────────────────────

export const PATTERNS: PatternInfo[] = [
  // === 上昇 (Strong Up) ===
  {
    id: "SU_EARLY", direction: "strong_up", phase: "early",
    label: "上昇初期", labelEn: "Early Uptrend",
    description: "MA5がMA25をゴールデンクロス。MA75は横ばい〜上向き。上昇トレンドの始まり",
    signal: "buy", strength: 5,
  },
  {
    id: "SU_MID", direction: "strong_up", phase: "mid",
    label: "上昇中期", labelEn: "Mid Uptrend",
    description: "MA5>MA25>MA75で全て上向き。パーフェクトオーダー。強い上昇継続",
    signal: "buy", strength: 4,
  },
  {
    id: "SU_LATE", direction: "strong_up", phase: "late",
    label: "上昇後期", labelEn: "Late Uptrend",
    description: "MA5>MA25>MA75だがMA5の傾きが緩やかに。移動平均線の乖離が縮小傾向",
    signal: "watch", strength: 3,
  },
  {
    id: "SU_REV1", direction: "strong_up", phase: "reversal_early",
    label: "上昇→転換初期", labelEn: "Uptrend Reversal Start",
    description: "MA5が横ばい〜下向きに。MA25/MA75はまだ上向き。天井形成の兆し",
    signal: "watch", strength: 3,
  },
  {
    id: "SU_REV2", direction: "strong_up", phase: "reversal_mid",
    label: "上昇→転換中期", labelEn: "Uptrend Reversal",
    description: "MA5がMA25をデッドクロス。MA75はまだ上向き。トレンド転換の確認",
    signal: "sell", strength: 4,
  },

  // === やや上昇 (Mild Up) ===
  {
    id: "MU_EARLY", direction: "mild_up", phase: "early",
    label: "やや上昇初期", labelEn: "Early Mild Uptrend",
    description: "MA5が上向きでMA25を上抜け。MA75は横ばい。緩やかな回復の始まり",
    signal: "buy", strength: 3,
  },
  {
    id: "MU_MID", direction: "mild_up", phase: "mid",
    label: "やや上昇中期", labelEn: "Mid Mild Uptrend",
    description: "MA5>MA25で緩やかに上昇。MA75が追いつき始める。安定した上昇",
    signal: "buy", strength: 3,
  },
  {
    id: "MU_LATE", direction: "mild_up", phase: "late",
    label: "やや上昇後期", labelEn: "Late Mild Uptrend",
    description: "3本のMAが接近し上向き。方向感が薄れてきている",
    signal: "neutral", strength: 2,
  },
  {
    id: "MU_REV1", direction: "mild_up", phase: "reversal_early",
    label: "やや上昇→転換初期", labelEn: "Mild Up Reversal Start",
    description: "MA5がフラット化。MA間のスプレッドが縮小。勢い失速",
    signal: "watch", strength: 2,
  },
  {
    id: "MU_REV2", direction: "mild_up", phase: "reversal_mid",
    label: "やや上昇→転換中期", labelEn: "Mild Up Reversal",
    description: "MA5がMA25を下回り始める。上昇トレンドの終了示唆",
    signal: "sell", strength: 3,
  },

  // === 横ばい (Sideways) ===
  {
    id: "SW_EARLY", direction: "sideways", phase: "early",
    label: "横ばい初期", labelEn: "Early Sideways",
    description: "MA5/MA25/MA75が収束し始めている。方向感のない展開の入口",
    signal: "neutral", strength: 1,
  },
  {
    id: "SW_MID", direction: "sideways", phase: "mid",
    label: "横ばい中期", labelEn: "Mid Sideways",
    description: "3本のMAがほぼ同水準で横ばい。レンジ相場の継続",
    signal: "neutral", strength: 1,
  },
  {
    id: "SW_LATE", direction: "sideways", phase: "late",
    label: "横ばい後期", labelEn: "Late Sideways",
    description: "長期横ばいからMAが動き始める兆候。ブレイクアウトの準備段階",
    signal: "watch", strength: 2,
  },
  {
    id: "SW_REV1", direction: "sideways", phase: "reversal_early",
    label: "横ばい→上放れ初期", labelEn: "Breakout Start (Up)",
    description: "MA5が上に動き始め、MA25/MA75から乖離。上方ブレイクの兆候",
    signal: "buy", strength: 4,
  },
  {
    id: "SW_REV2", direction: "sideways", phase: "reversal_mid",
    label: "横ばい→下放れ初期", labelEn: "Breakdown Start (Down)",
    description: "MA5が下に動き始め、MA25/MA75から乖離。下方ブレイクの兆候",
    signal: "sell", strength: 4,
  },

  // === やや下降 (Mild Down) ===
  {
    id: "MD_EARLY", direction: "mild_down", phase: "early",
    label: "やや下降初期", labelEn: "Early Mild Downtrend",
    description: "MA5がMA25を下抜け。MA75は横ばい。緩やかな下落の始まり",
    signal: "sell", strength: 3,
  },
  {
    id: "MD_MID", direction: "mild_down", phase: "mid",
    label: "やや下降中期", labelEn: "Mid Mild Downtrend",
    description: "MA5<MA25で緩やかに下降。MA75も下向きに転換中",
    signal: "sell", strength: 3,
  },
  {
    id: "MD_LATE", direction: "mild_down", phase: "late",
    label: "やや下降後期", labelEn: "Late Mild Downtrend",
    description: "3本のMAが接近し下向き。下落の勢いが弱まっている",
    signal: "watch", strength: 2,
  },
  {
    id: "MD_REV1", direction: "mild_down", phase: "reversal_early",
    label: "やや下降→転換初期", labelEn: "Mild Down Reversal Start",
    description: "MA5がフラット化〜上向きに。底打ちの兆し",
    signal: "watch", strength: 3,
  },
  {
    id: "MD_REV2", direction: "mild_down", phase: "reversal_mid",
    label: "やや下降→転換中期", labelEn: "Mild Down Reversal",
    description: "MA5がMA25を上抜け。下降トレンドからの反転示唆",
    signal: "buy", strength: 4,
  },

  // === 下降 (Strong Down) ===
  {
    id: "SD_EARLY", direction: "strong_down", phase: "early",
    label: "下降初期", labelEn: "Early Downtrend",
    description: "MA5がMA25をデッドクロス。MA75は横ばい〜下向き。下降トレンドの始まり",
    signal: "sell", strength: 5,
  },
  {
    id: "SD_MID", direction: "strong_down", phase: "mid",
    label: "下降中期", labelEn: "Mid Downtrend",
    description: "MA5<MA25<MA75で全て下向き。逆パーフェクトオーダー。強い下落継続",
    signal: "sell", strength: 4,
  },
  {
    id: "SD_LATE", direction: "strong_down", phase: "late",
    label: "下降後期", labelEn: "Late Downtrend",
    description: "MA5<MA25<MA75だがMA5の傾きが緩やかに。セリングクライマックスの可能性",
    signal: "watch", strength: 3,
  },
  {
    id: "SD_REV1", direction: "strong_down", phase: "reversal_early",
    label: "下降→転換初期", labelEn: "Downtrend Reversal Start",
    description: "MA5が横ばい〜上向きに。MA25/MA75はまだ下向き。底打ちの兆し",
    signal: "watch", strength: 3,
  },
  {
    id: "SD_REV2", direction: "strong_down", phase: "reversal_mid",
    label: "下降→転換中期", labelEn: "Downtrend Reversal",
    description: "MA5がMA25をゴールデンクロス。MA75はまだ下向き。トレンド転換の確認",
    signal: "buy", strength: 5,
  },
];

// ─── Utility: SMA Calculation ────────────────────────────────────

function calcSMA(closes: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += closes[j];
    }
    result.push(Math.round((sum / period) * 100) / 100);
  }
  return result;
}

/**
 * Compute MA slope as average % change per bar over `lookback` bars.
 * Returns 0 if insufficient data.
 */
function calcSlope(
  maValues: (number | null)[],
  idx: number,
  lookback: number = 5
): number {
  const end = idx;
  const start = idx - lookback;
  if (start < 0) return 0;
  const v0 = maValues[start];
  const v1 = maValues[end];
  if (v0 == null || v1 == null || v0 === 0) return 0;
  return ((v1 - v0) / v0) * 100; // total % change over lookback
}

/**
 * Detect recent cross between two MA series within `window` bars of `idx`.
 * Returns "golden" if fast crosses above slow, "dead" if below, "none" otherwise.
 */
function detectCross(
  fast: (number | null)[],
  slow: (number | null)[],
  idx: number,
  window: number = 5
): "golden" | "dead" | "none" {
  for (let i = Math.max(1, idx - window + 1); i <= idx; i++) {
    const prevFast = fast[i - 1];
    const prevSlow = slow[i - 1];
    const curFast = fast[i];
    const curSlow = slow[i];
    if (
      prevFast != null &&
      prevSlow != null &&
      curFast != null &&
      curSlow != null
    ) {
      if (prevFast <= prevSlow && curFast > curSlow) return "golden";
      if (prevFast >= prevSlow && curFast < curSlow) return "dead";
    }
  }
  return "none";
}

// ─── Feature Extraction ──────────────────────────────────────────

export function extractFeatures(
  candles: Candle[],
  idx?: number
): PatternFeatures | null {
  if (candles.length < 80) return null; // need enough data for MA75+

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const i = idx ?? closes.length - 1;

  const ma5Arr = calcSMA(closes, 5);
  const ma25Arr = calcSMA(closes, 25);
  const ma75Arr = calcSMA(closes, 75);

  const ma5 = ma5Arr[i];
  const ma25 = ma25Arr[i];
  const ma75 = ma75Arr[i];

  if (ma5 == null || ma25 == null || ma75 == null) return null;

  const close = closes[i];

  // MA slopes
  const slopeLookback = 5;
  const ma5Slope = calcSlope(ma5Arr, i, slopeLookback);
  const ma25Slope = calcSlope(ma25Arr, i, slopeLookback);
  const ma75Slope = calcSlope(ma75Arr, i, slopeLookback);

  // MA ordering
  let maOrder: "bull" | "bear" | "mixed" = "mixed";
  if (ma5 > ma25 && ma25 > ma75) maOrder = "bull";
  else if (ma5 < ma25 && ma25 < ma75) maOrder = "bear";

  // Price vs MAs
  const priceVsMa5 = ((close - ma5) / ma5) * 100;
  const priceVsMa25 = ((close - ma25) / ma25) * 100;
  const priceVsMa75 = ((close - ma75) / ma75) * 100;

  // ROC
  const roc5 = i >= 5 ? ((close - closes[i - 5]) / closes[i - 5]) * 100 : 0;
  const roc20 =
    i >= 20 ? ((close - closes[i - 20]) / closes[i - 20]) * 100 : 0;

  // Cross detection
  const ma5CrossMa25 = detectCross(ma5Arr, ma25Arr, i, 5);
  const ma25CrossMa75 = detectCross(ma25Arr, ma75Arr, i, 10);

  // MA spread (distance between MA5 and MA75 as % of MA75)
  const maSpread = ((ma5 - ma75) / ma75) * 100;

  // Spreading/converging: compare current spread to spread 5 bars ago
  const prevMa5 = ma5Arr[i - 5];
  const prevMa75 = ma75Arr[i - 5];
  let maSpreading = false;
  let maConverging = false;
  if (prevMa5 != null && prevMa75 != null && prevMa75 !== 0) {
    const prevSpread = ((prevMa5 - prevMa75) / prevMa75) * 100;
    const spreadDelta = Math.abs(maSpread) - Math.abs(prevSpread);
    maSpreading = spreadDelta > 0.1;
    maConverging = spreadDelta < -0.1;
  }

  // Higher highs / lower lows (last 10 bars)
  let higherHighs = true;
  let lowerLows = true;
  const lookback = Math.min(10, i);
  for (let j = i - lookback + 1; j <= i; j++) {
    if (j < 1) continue;
    if (highs[j] <= highs[j - 1]) higherHighs = false;
    if (lows[j] >= lows[j - 1]) lowerLows = false;
  }

  // Volatility: average true range over 14 bars, as % of close
  let atrSum = 0;
  const atrPeriod = Math.min(14, i);
  for (let j = i - atrPeriod + 1; j <= i; j++) {
    if (j < 1) continue;
    const tr = Math.max(
      highs[j] - lows[j],
      Math.abs(highs[j] - closes[j - 1]),
      Math.abs(lows[j] - closes[j - 1])
    );
    atrSum += tr;
  }
  const volatility = atrPeriod > 0 ? (atrSum / atrPeriod / close) * 100 : 0;

  return {
    maValues: { ma5, ma25, ma75 },
    maSlopes: {
      ma5Slope: round2(ma5Slope),
      ma25Slope: round2(ma25Slope),
      ma75Slope: round2(ma75Slope),
    },
    maOrder,
    priceVsMa5: round2(priceVsMa5),
    priceVsMa25: round2(priceVsMa25),
    priceVsMa75: round2(priceVsMa75),
    roc5: round2(roc5),
    roc20: round2(roc20),
    ma5CrossMa25,
    ma25CrossMa75,
    maSpread: round2(maSpread),
    maSpreading,
    maConverging,
    higherHighs,
    lowerLows,
    volatility: round2(volatility),
    close,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Slope Thresholds ────────────────────────────────────────────

const SLOPE = {
  STRONG_UP: 1.5,   // >1.5% over 5 bars = steep uptrend
  MILD_UP: 0.3,     // 0.3-1.5% = gentle uptrend
  FLAT: 0.3,        // |slope| < 0.3% = flat
  MILD_DOWN: -0.3,
  STRONG_DOWN: -1.5,
};

const SPREAD_TIGHT = 1.0;  // MA5-MA75 < 1% = MAs are close together

// ─── Pattern Scoring ─────────────────────────────────────────────

interface PatternScore {
  pattern: PatternInfo;
  score: number;
}

function scorePattern(f: PatternFeatures, p: PatternInfo): number {
  let score = 0;

  switch (p.id) {
    // ======== 上昇 (Strong Up) ========
    case "SU_EARLY":
      if (f.ma5CrossMa25 === "golden") score += 35;
      if (f.maSlopes.ma5Slope > SLOPE.STRONG_UP) score += 20;
      else if (f.maSlopes.ma5Slope > SLOPE.MILD_UP) score += 10;
      if (f.maSlopes.ma75Slope >= -SLOPE.FLAT) score += 10;
      if (f.priceVsMa25 > 0) score += 10;
      if (f.roc5 > 1) score += 10;
      if (f.maOrder === "bear") score -= 15; // shouldn't be in bear order
      break;

    case "SU_MID":
      if (f.maOrder === "bull") score += 30;
      if (f.maSlopes.ma5Slope > SLOPE.MILD_UP) score += 15;
      if (f.maSlopes.ma25Slope > SLOPE.MILD_UP) score += 15;
      if (f.maSlopes.ma75Slope > 0) score += 10;
      if (f.maSpreading) score += 10;
      if (f.roc20 > 3) score += 10;
      break;

    case "SU_LATE":
      if (f.maOrder === "bull") score += 25;
      if (f.maSlopes.ma5Slope > 0 && f.maSlopes.ma5Slope < SLOPE.STRONG_UP) score += 15;
      if (f.maSlopes.ma25Slope > SLOPE.MILD_UP) score += 10;
      if (f.maConverging) score += 15;
      if (f.priceVsMa75 > 5) score += 10; // extended from MA75
      break;

    case "SU_REV1":
      if (f.maOrder === "bull" || f.maSlopes.ma25Slope > 0) score += 15;
      if (Math.abs(f.maSlopes.ma5Slope) < SLOPE.FLAT) score += 20; // MA5 flattening
      if (f.maSlopes.ma5Slope < f.maSlopes.ma25Slope) score += 15; // MA5 slower than MA25
      if (f.maConverging) score += 15;
      if (f.priceVsMa5 < 0) score += 10; // price below MA5
      break;

    case "SU_REV2":
      if (f.ma5CrossMa25 === "dead") score += 35;
      if (f.maSlopes.ma75Slope > 0) score += 15; // MA75 still up
      if (f.maSlopes.ma5Slope < 0) score += 10;
      if (f.priceVsMa25 < 0) score += 10;
      if (f.roc5 < 0) score += 10;
      break;

    // ======== やや上昇 (Mild Up) ========
    case "MU_EARLY":
      if (f.ma5CrossMa25 === "golden") score += 25;
      if (f.maSlopes.ma5Slope > SLOPE.MILD_UP && f.maSlopes.ma5Slope <= SLOPE.STRONG_UP) score += 20;
      if (Math.abs(f.maSlopes.ma75Slope) < SLOPE.FLAT) score += 15;
      if (f.priceVsMa25 > 0 && f.priceVsMa25 < 3) score += 10;
      break;

    case "MU_MID":
      if (f.maValues.ma5 > f.maValues.ma25) score += 20;
      if (f.maSlopes.ma5Slope > 0 && f.maSlopes.ma5Slope <= SLOPE.STRONG_UP) score += 15;
      if (f.maSlopes.ma25Slope > 0 && f.maSlopes.ma25Slope <= SLOPE.STRONG_UP) score += 15;
      if (f.maSlopes.ma75Slope >= -SLOPE.FLAT) score += 10;
      if (!f.maSpreading && !f.maConverging) score += 10; // stable spread
      break;

    case "MU_LATE":
      if (Math.abs(f.maSpread) < SPREAD_TIGHT * 2) score += 20;
      if (f.maSlopes.ma5Slope > 0 && f.maSlopes.ma25Slope > 0 && f.maSlopes.ma75Slope > 0) score += 15;
      if (f.maConverging) score += 15;
      if (f.volatility < 2) score += 10; // low vol
      break;

    case "MU_REV1":
      if (Math.abs(f.maSlopes.ma5Slope) < SLOPE.FLAT) score += 25;
      if (f.maConverging) score += 20;
      if (f.maValues.ma5 >= f.maValues.ma25) score += 10;
      if (f.roc5 < 0.3 && f.roc5 > -0.3) score += 10; // momentum fading
      break;

    case "MU_REV2":
      if (f.ma5CrossMa25 === "dead") score += 30;
      if (f.maSlopes.ma5Slope < 0) score += 15;
      if (f.maSlopes.ma25Slope > 0) score += 10; // MA25 still up but MA5 crossed below
      if (f.roc5 < -0.5) score += 10;
      break;

    // ======== 横ばい (Sideways) ========
    case "SW_EARLY":
      if (Math.abs(f.maSpread) < SPREAD_TIGHT * 1.5) score += 20;
      if (f.maConverging) score += 20;
      if (Math.abs(f.maSlopes.ma5Slope) < SLOPE.FLAT * 2) score += 10;
      if (Math.abs(f.maSlopes.ma25Slope) < SLOPE.FLAT * 2) score += 10;
      break;

    case "SW_MID":
      if (Math.abs(f.maSpread) < SPREAD_TIGHT) score += 25;
      if (Math.abs(f.maSlopes.ma5Slope) < SLOPE.FLAT) score += 15;
      if (Math.abs(f.maSlopes.ma25Slope) < SLOPE.FLAT) score += 15;
      if (Math.abs(f.maSlopes.ma75Slope) < SLOPE.FLAT) score += 15;
      break;

    case "SW_LATE":
      if (Math.abs(f.maSpread) < SPREAD_TIGHT) score += 15;
      if (
        Math.abs(f.maSlopes.ma5Slope) > SLOPE.FLAT &&
        Math.abs(f.maSlopes.ma25Slope) < SLOPE.FLAT
      )
        score += 25; // MA5 starting to move while MA25/75 flat
      if (f.volatility > 1.5) score += 10; // vol picking up
      break;

    case "SW_REV1": // Breakout up
      if (f.maSlopes.ma5Slope > SLOPE.MILD_UP) score += 25;
      if (Math.abs(f.maSlopes.ma25Slope) < SLOPE.FLAT) score += 10;
      if (f.priceVsMa5 > 0) score += 10;
      if (f.priceVsMa75 > 0) score += 10;
      if (f.roc5 > 1) score += 15;
      // was recently sideways
      if (Math.abs(f.maSlopes.ma75Slope) < SLOPE.FLAT * 2) score += 10;
      break;

    case "SW_REV2": // Breakdown down
      if (f.maSlopes.ma5Slope < SLOPE.MILD_DOWN) score += 25;
      if (Math.abs(f.maSlopes.ma25Slope) < SLOPE.FLAT) score += 10;
      if (f.priceVsMa5 < 0) score += 10;
      if (f.priceVsMa75 < 0) score += 10;
      if (f.roc5 < -1) score += 15;
      if (Math.abs(f.maSlopes.ma75Slope) < SLOPE.FLAT * 2) score += 10;
      break;

    // ======== やや下降 (Mild Down) ========
    case "MD_EARLY":
      if (f.ma5CrossMa25 === "dead") score += 25;
      if (f.maSlopes.ma5Slope < SLOPE.MILD_DOWN && f.maSlopes.ma5Slope >= SLOPE.STRONG_DOWN) score += 20;
      if (Math.abs(f.maSlopes.ma75Slope) < SLOPE.FLAT) score += 15;
      if (f.priceVsMa25 < 0) score += 10;
      break;

    case "MD_MID":
      if (f.maValues.ma5 < f.maValues.ma25) score += 20;
      if (f.maSlopes.ma5Slope < 0 && f.maSlopes.ma5Slope >= SLOPE.STRONG_DOWN) score += 15;
      if (f.maSlopes.ma25Slope < 0) score += 15;
      if (f.maSlopes.ma75Slope < 0) score += 10;
      break;

    case "MD_LATE":
      if (Math.abs(f.maSpread) < SPREAD_TIGHT * 2 && f.maSpread < 0) score += 20;
      if (f.maSlopes.ma5Slope < 0 && f.maSlopes.ma5Slope > SLOPE.STRONG_DOWN) score += 15;
      if (f.maConverging) score += 15;
      if (f.volatility < 2) score += 10;
      break;

    case "MD_REV1":
      if (Math.abs(f.maSlopes.ma5Slope) < SLOPE.FLAT || f.maSlopes.ma5Slope > 0) score += 25;
      if (f.maSlopes.ma25Slope < 0) score += 10;
      if (f.maValues.ma5 < f.maValues.ma25) score += 10;
      if (f.roc5 > 0) score += 15;
      break;

    case "MD_REV2":
      if (f.ma5CrossMa25 === "golden") score += 30;
      if (f.maSlopes.ma5Slope > 0) score += 15;
      if (f.maSlopes.ma25Slope < 0) score += 10; // MA25 still down
      if (f.roc5 > 0.5) score += 10;
      break;

    // ======== 下降 (Strong Down) ========
    case "SD_EARLY":
      if (f.ma5CrossMa25 === "dead") score += 35;
      if (f.maSlopes.ma5Slope < SLOPE.STRONG_DOWN) score += 20;
      if (f.maSlopes.ma75Slope <= SLOPE.FLAT) score += 10;
      if (f.roc5 < -2) score += 10;
      break;

    case "SD_MID":
      if (f.maOrder === "bear") score += 30;
      if (f.maSlopes.ma5Slope < SLOPE.MILD_DOWN) score += 15;
      if (f.maSlopes.ma25Slope < SLOPE.MILD_DOWN) score += 15;
      if (f.maSlopes.ma75Slope < 0) score += 10;
      if (f.maSpreading) score += 10;
      break;

    case "SD_LATE":
      if (f.maOrder === "bear") score += 25;
      if (f.maSlopes.ma5Slope < 0 && f.maSlopes.ma5Slope > SLOPE.STRONG_DOWN) score += 15;
      if (f.maSlopes.ma25Slope < SLOPE.MILD_DOWN) score += 10;
      if (f.maConverging) score += 15;
      if (f.priceVsMa75 < -5) score += 10;
      break;

    case "SD_REV1":
      if (f.maOrder === "bear" || f.maSlopes.ma25Slope < 0) score += 15;
      if (Math.abs(f.maSlopes.ma5Slope) < SLOPE.FLAT || f.maSlopes.ma5Slope > 0) score += 20;
      if (f.maConverging) score += 15;
      if (f.priceVsMa5 > 0) score += 10;
      if (f.roc5 > 0) score += 10;
      break;

    case "SD_REV2":
      if (f.ma5CrossMa25 === "golden") score += 35;
      if (f.maSlopes.ma75Slope < 0) score += 15;
      if (f.maSlopes.ma5Slope > 0) score += 10;
      if (f.priceVsMa25 > 0) score += 10;
      if (f.roc5 > 1) score += 10;
      break;
  }

  return Math.max(0, Math.min(100, score));
}

// ─── Main Detection ──────────────────────────────────────────────

/**
 * Detect the best-matching pattern from candle data.
 * Returns top N matches sorted by confidence.
 */
export function detectPattern(
  candles: Candle[],
  timeframe: string = "daily",
  topN: number = 3
): DetectedPattern[] {
  const features = extractFeatures(candles);
  if (!features) return [];

  const scored: PatternScore[] = PATTERNS.map((p) => ({
    pattern: p,
    score: scorePattern(features, p),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topN).map((s) => ({
    pattern: s.pattern,
    confidence: s.score,
    features,
    timeframe,
  }));
}

/**
 * Detect patterns for multiple timeframes at once.
 */
export function detectPatternMultiTimeframe(
  dailyCandles: Candle[],
  weeklyCandles: Candle[],
  monthlyCandles: Candle[]
): Record<string, DetectedPattern[]> {
  const result: Record<string, DetectedPattern[]> = {};

  if (dailyCandles.length >= 80) {
    result.daily = detectPattern(dailyCandles, "daily");
  }
  if (weeklyCandles.length >= 80) {
    result.weekly = detectPattern(weeklyCandles, "weekly");
  }
  if (monthlyCandles.length >= 80) {
    result.monthly = detectPattern(monthlyCandles, "monthly");
  }

  return result;
}

/**
 * Convert daily candles to weekly candles.
 */
export function toWeeklyCandles(dailyCandles: Candle[]): Candle[] {
  if (dailyCandles.length === 0) return [];

  const weeks: Candle[] = [];
  let current: Candle | null = null;

  for (const c of dailyCandles) {
    const dateStr = typeof c.time === "string" ? c.time : new Date(c.time * 1000).toISOString().slice(0, 10);
    const date = new Date(dateStr);
    const dayOfWeek = date.getDay();

    // Start new week on Monday (or first available day)
    if (!current || dayOfWeek === 1 || (dayOfWeek === 0 && current)) {
      if (current) weeks.push(current);
      current = { ...c, time: dateStr };
    } else if (current) {
      current.high = Math.max(current.high, c.high);
      current.low = Math.min(current.low, c.low);
      current.close = c.close;
      current.volume += c.volume;
    }
  }
  if (current) weeks.push(current);

  return weeks;
}

/**
 * Convert daily candles to monthly candles.
 */
export function toMonthlyCandles(dailyCandles: Candle[]): Candle[] {
  if (dailyCandles.length === 0) return [];

  const months: Candle[] = [];
  let current: Candle | null = null;
  let currentMonth = "";

  for (const c of dailyCandles) {
    const dateStr = typeof c.time === "string" ? c.time : new Date(c.time * 1000).toISOString().slice(0, 10);
    const month = dateStr.slice(0, 7); // YYYY-MM

    if (month !== currentMonth) {
      if (current) months.push(current);
      current = { ...c, time: dateStr };
      currentMonth = month;
    } else if (current) {
      current.high = Math.max(current.high, c.high);
      current.low = Math.min(current.low, c.low);
      current.close = c.close;
      current.volume += c.volume;
    }
  }
  if (current) months.push(current);

  return months;
}

// ─── Pattern Grid Helper ─────────────────────────────────────────

const DIRECTION_ORDER: PatternDirection[] = [
  "strong_up", "mild_up", "sideways", "mild_down", "strong_down",
];
const PHASE_ORDER: PatternPhase[] = [
  "early", "mid", "late", "reversal_early", "reversal_mid",
];

export const DIRECTION_LABELS: Record<PatternDirection, string> = {
  strong_up: "上昇",
  mild_up: "やや上昇",
  sideways: "横ばい",
  mild_down: "やや下降",
  strong_down: "下降",
};

export const PHASE_LABELS: Record<PatternPhase, string> = {
  early: "初期",
  mid: "中期",
  late: "後期",
  reversal_early: "転換初期",
  reversal_mid: "転換中期",
};

// ─── Pattern Transition Predictions ──────────────────────────────

export interface PatternTransition {
  fromId: string;
  toId: string;
  toLabel: string;
  signal: "buy" | "sell" | "neutral" | "watch";
  triggerConditions: string[];  // human-readable conditions
  triggerKeys: string[];        // machine-checkable key metrics
  probability: "high" | "medium" | "low";
}

/**
 * Get predicted next patterns and their trigger conditions
 * for a given current pattern.
 */
export function getPatternTransitions(currentId: string): PatternTransition[] {
  const transitions: Record<string, PatternTransition[]> = {
    // === 上昇系 ===
    SU_EARLY: [
      {
        fromId: "SU_EARLY", toId: "SU_MID", toLabel: "上昇中期",
        signal: "buy",
        triggerConditions: ["MA25もMA75を上抜け（パーフェクトオーダー完成）", "MA5/MA25/MA75が全て上向き"],
        triggerKeys: ["maOrder=bull", "ma25Slope>0.3"],
        probability: "high",
      },
      {
        fromId: "SU_EARLY", toId: "MU_REV1", toLabel: "やや上昇→転換初期",
        signal: "watch",
        triggerConditions: ["MA5の傾きが鈍化し横ばいに", "出来高が減少"],
        triggerKeys: ["ma5Slope<0.3", "maConverging"],
        probability: "medium",
      },
    ],
    SU_MID: [
      {
        fromId: "SU_MID", toId: "SU_LATE", toLabel: "上昇後期",
        signal: "watch",
        triggerConditions: ["MA5の上昇角度が緩やかに", "MA間の乖離が縮小し始める"],
        triggerKeys: ["ma5Slope declining", "maConverging"],
        probability: "high",
      },
      {
        fromId: "SU_MID", toId: "SU_REV1", toLabel: "上昇→転換初期",
        signal: "watch",
        triggerConditions: ["MA5が横ばいに転換", "価格がMA5を下回る"],
        triggerKeys: ["ma5Slope<0.3", "priceVsMa5<0"],
        probability: "medium",
      },
    ],
    SU_LATE: [
      {
        fromId: "SU_LATE", toId: "SU_REV1", toLabel: "上昇→転換初期",
        signal: "sell",
        triggerConditions: ["MA5がフラット〜下向きに転換", "価格がMA5を明確に下回る"],
        triggerKeys: ["ma5Slope<0", "priceVsMa5<-1"],
        probability: "high",
      },
      {
        fromId: "SU_LATE", toId: "SU_MID", toLabel: "上昇中期（再加速）",
        signal: "buy",
        triggerConditions: ["新高値更新で出来高増加", "MA5の傾きが再び急上昇"],
        triggerKeys: ["ma5Slope>1.5", "higherHighs"],
        probability: "low",
      },
    ],
    SU_REV1: [
      {
        fromId: "SU_REV1", toId: "SU_REV2", toLabel: "上昇→転換中期",
        signal: "sell",
        triggerConditions: ["MA5がMA25をデッドクロス", "価格がMA25を下回る"],
        triggerKeys: ["ma5CrossMa25=dead", "priceVsMa25<0"],
        probability: "high",
      },
      {
        fromId: "SU_REV1", toId: "SU_MID", toLabel: "上昇中期（押し目完了）",
        signal: "buy",
        triggerConditions: ["MA5が再び上昇に転換", "価格がMA5を上回り反発"],
        triggerKeys: ["ma5Slope>0.5", "priceVsMa5>0"],
        probability: "medium",
      },
    ],
    SU_REV2: [
      {
        fromId: "SU_REV2", toId: "MD_EARLY", toLabel: "やや下降初期",
        signal: "sell",
        triggerConditions: ["MA25も下向きに転換", "価格がMA75を下回る"],
        triggerKeys: ["ma25Slope<0", "priceVsMa75<0"],
        probability: "high",
      },
      {
        fromId: "SU_REV2", toId: "SW_EARLY", toLabel: "横ばい初期",
        signal: "neutral",
        triggerConditions: ["MA5/MA25/MA75が収束", "ボラティリティが低下"],
        triggerKeys: ["maSpread<1", "volatility<1.5"],
        probability: "medium",
      },
    ],

    // === 横ばい系 ===
    SW_MID: [
      {
        fromId: "SW_MID", toId: "SW_REV1", toLabel: "横ばい→上放れ初期",
        signal: "buy",
        triggerConditions: ["MA5が急上昇でMA25/MA75から上方乖離", "出来高を伴った陽線で上放れ"],
        triggerKeys: ["ma5Slope>0.5", "roc5>1"],
        probability: "medium",
      },
      {
        fromId: "SW_MID", toId: "SW_REV2", toLabel: "横ばい→下放れ初期",
        signal: "sell",
        triggerConditions: ["MA5が急下降でMA25/MA75から下方乖離", "出来高を伴った陰線で下放れ"],
        triggerKeys: ["ma5Slope<-0.5", "roc5<-1"],
        probability: "medium",
      },
    ],
    SW_LATE: [
      {
        fromId: "SW_LATE", toId: "SW_REV1", toLabel: "横ばい→上放れ初期",
        signal: "buy",
        triggerConditions: ["価格がレンジ上限を突破", "MA5が明確に上向きに"],
        triggerKeys: ["ma5Slope>0.5", "priceVsMa75>1"],
        probability: "medium",
      },
      {
        fromId: "SW_LATE", toId: "SW_REV2", toLabel: "横ばい→下放れ初期",
        signal: "sell",
        triggerConditions: ["価格がレンジ下限を割る", "MA5が明確に下向きに"],
        triggerKeys: ["ma5Slope<-0.5", "priceVsMa75<-1"],
        probability: "medium",
      },
    ],
    SW_REV1: [
      {
        fromId: "SW_REV1", toId: "SU_EARLY", toLabel: "上昇初期",
        signal: "buy",
        triggerConditions: ["MA5がMA25をゴールデンクロス", "出来高増加で上昇が本格化"],
        triggerKeys: ["ma5CrossMa25=golden", "roc5>2"],
        probability: "high",
      },
    ],
    SW_REV2: [
      {
        fromId: "SW_REV2", toId: "SD_EARLY", toLabel: "下降初期",
        signal: "sell",
        triggerConditions: ["MA5がMA25をデッドクロス", "出来高増加で下落が本格化"],
        triggerKeys: ["ma5CrossMa25=dead", "roc5<-2"],
        probability: "high",
      },
    ],

    // === 下降系 ===
    SD_EARLY: [
      {
        fromId: "SD_EARLY", toId: "SD_MID", toLabel: "下降中期",
        signal: "sell",
        triggerConditions: ["MA5<MA25<MA75の逆パーフェクトオーダー完成", "全MAが下向き"],
        triggerKeys: ["maOrder=bear", "ma25Slope<-0.3"],
        probability: "high",
      },
    ],
    SD_MID: [
      {
        fromId: "SD_MID", toId: "SD_LATE", toLabel: "下降後期",
        signal: "watch",
        triggerConditions: ["MA5の下落角度が緩やかに", "MA間の乖離が縮小"],
        triggerKeys: ["ma5Slope flattening", "maConverging"],
        probability: "high",
      },
      {
        fromId: "SD_MID", toId: "SD_REV1", toLabel: "下降→転換初期",
        signal: "watch",
        triggerConditions: ["MA5が横ばい〜上向きに転換", "価格がMA5を上回る"],
        triggerKeys: ["ma5Slope>0", "priceVsMa5>0"],
        probability: "medium",
      },
    ],
    SD_LATE: [
      {
        fromId: "SD_LATE", toId: "SD_REV1", toLabel: "下降→転換初期",
        signal: "buy",
        triggerConditions: ["MA5がフラット〜上向きに転換", "セリングクライマックス後の反発"],
        triggerKeys: ["ma5Slope>0", "roc5>0"],
        probability: "high",
      },
    ],
    SD_REV1: [
      {
        fromId: "SD_REV1", toId: "SD_REV2", toLabel: "下降→転換中期",
        signal: "buy",
        triggerConditions: ["MA5がMA25をゴールデンクロス！", "価格がMA25を上回る"],
        triggerKeys: ["ma5CrossMa25=golden", "priceVsMa25>0"],
        probability: "high",
      },
      {
        fromId: "SD_REV1", toId: "SD_MID", toLabel: "下降中期（戻り失敗）",
        signal: "sell",
        triggerConditions: ["MA5が再び下向きに", "価格がMA5を下回り再下落"],
        triggerKeys: ["ma5Slope<-0.3", "priceVsMa5<0"],
        probability: "medium",
      },
    ],
    SD_REV2: [
      {
        fromId: "SD_REV2", toId: "SU_EARLY", toLabel: "上昇初期（トレンド転換確定）",
        signal: "buy",
        triggerConditions: ["MA25も上向きに転換", "MA75が横ばいに"],
        triggerKeys: ["ma25Slope>0", "ma75Slope>-0.3"],
        probability: "high",
      },
      {
        fromId: "SD_REV2", toId: "SW_EARLY", toLabel: "横ばい初期",
        signal: "neutral",
        triggerConditions: ["3本のMAが収束", "方向感が失われる"],
        triggerKeys: ["maSpread<1", "volatility<1.5"],
        probability: "medium",
      },
    ],

    // === やや上昇系 ===
    MU_MID: [
      {
        fromId: "MU_MID", toId: "SU_MID", toLabel: "上昇中期（加速）",
        signal: "buy",
        triggerConditions: ["MA5の傾きが急上昇", "出来高増加で上昇加速"],
        triggerKeys: ["ma5Slope>1.5", "roc5>3"],
        probability: "medium",
      },
      {
        fromId: "MU_MID", toId: "MU_LATE", toLabel: "やや上昇後期",
        signal: "neutral",
        triggerConditions: ["3本のMAが接近", "上昇の勢いが弱まる"],
        triggerKeys: ["maConverging", "ma5Slope declining"],
        probability: "high",
      },
    ],

    // === やや下降系 ===
    MD_MID: [
      {
        fromId: "MD_MID", toId: "SD_MID", toLabel: "下降中期（加速）",
        signal: "sell",
        triggerConditions: ["MA5の傾きが急下降", "出来高増加で下落加速"],
        triggerKeys: ["ma5Slope<-1.5", "roc5<-3"],
        probability: "medium",
      },
      {
        fromId: "MD_MID", toId: "MD_REV1", toLabel: "やや下降→転換初期",
        signal: "watch",
        triggerConditions: ["MA5がフラット化", "下落モメンタムの減速"],
        triggerKeys: ["ma5Slope>-0.3", "roc5>0"],
        probability: "high",
      },
    ],
    MD_REV1: [
      {
        fromId: "MD_REV1", toId: "MD_REV2", toLabel: "やや下降→転換中期",
        signal: "buy",
        triggerConditions: ["MA5がMA25をゴールデンクロス", "反転の確認"],
        triggerKeys: ["ma5CrossMa25=golden", "priceVsMa25>0"],
        probability: "high",
      },
    ],
    MD_REV2: [
      {
        fromId: "MD_REV2", toId: "MU_EARLY", toLabel: "やや上昇初期",
        signal: "buy",
        triggerConditions: ["MA25も上向きに", "上昇トレンドの確立"],
        triggerKeys: ["ma25Slope>0", "maOrder approaching bull"],
        probability: "high",
      },
    ],
  };

  return transitions[currentId] ?? [];
}

/**
 * Evaluate how close we are to each predicted transition.
 * Returns 0-100 proximity score for each transition.
 */
export function evaluateTransitionProximity(
  features: PatternFeatures,
  transition: PatternTransition
): number {
  let score = 0;
  let checks = 0;

  for (const key of transition.triggerKeys) {
    checks++;
    if (key.includes("maOrder=bull") && features.maOrder === "bull") score++;
    else if (key.includes("maOrder=bear") && features.maOrder === "bear") score++;
    else if (key.includes("ma5CrossMa25=golden") && features.ma5CrossMa25 === "golden") score++;
    else if (key.includes("ma5CrossMa25=dead") && features.ma5CrossMa25 === "dead") score++;
    else if (key.includes("maConverging") && features.maConverging) score++;
    else if (key.includes("ma5Slope>") && features.maSlopes.ma5Slope > parseThreshold(key)) score++;
    else if (key.includes("ma5Slope<") && features.maSlopes.ma5Slope < parseThreshold(key)) score++;
    else if (key.includes("ma25Slope>") && features.maSlopes.ma25Slope > parseThreshold(key)) score++;
    else if (key.includes("ma25Slope<") && features.maSlopes.ma25Slope < parseThreshold(key)) score++;
    else if (key.includes("priceVsMa5>") && features.priceVsMa5 > parseThreshold(key)) score++;
    else if (key.includes("priceVsMa5<") && features.priceVsMa5 < parseThreshold(key)) score++;
    else if (key.includes("priceVsMa25>") && features.priceVsMa25 > parseThreshold(key)) score++;
    else if (key.includes("priceVsMa25<") && features.priceVsMa25 < parseThreshold(key)) score++;
    else if (key.includes("priceVsMa75<") && features.priceVsMa75 < parseThreshold(key)) score++;
    else if (key.includes("priceVsMa75>") && features.priceVsMa75 > parseThreshold(key)) score++;
    else if (key.includes("roc5>") && features.roc5 > parseThreshold(key)) score++;
    else if (key.includes("roc5<") && features.roc5 < parseThreshold(key)) score++;
    else if (key.includes("maSpread<") && Math.abs(features.maSpread) < parseThreshold(key)) score++;
    else if (key.includes("volatility<") && features.volatility < parseThreshold(key)) score++;
    else if (key.includes("higherHighs") && features.higherHighs) score++;
    // Fuzzy matches for descriptive keys
    else if (key.includes("flattening") || key.includes("declining")) {
      // approximate check
      score += 0.5;
    }
  }

  return checks > 0 ? Math.round((score / checks) * 100) : 0;
}

function parseThreshold(key: string): number {
  const match = key.match(/[<>]=?([-\d.]+)/);
  return match ? parseFloat(match[1]) : 0;
}

/**
 * Get pattern by grid position (row, col).
 */
export function getPatternByGrid(row: number, col: number): PatternInfo | undefined {
  const dir = DIRECTION_ORDER[row];
  const phase = PHASE_ORDER[col];
  if (!dir || !phase) return undefined;
  return PATTERNS.find((p) => p.direction === dir && p.phase === phase);
}

/**
 * Build 5×5 pattern grid (direction × phase) for display.
 */
export function buildPatternGrid(): (PatternInfo | undefined)[][] {
  return DIRECTION_ORDER.map((_, row) =>
    PHASE_ORDER.map((_, col) => getPatternByGrid(row, col))
  );
}
