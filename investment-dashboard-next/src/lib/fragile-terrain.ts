/**
 * 脆弱地形スコア (Fragile Terrain) — 「この銘柄は今、暴落しやすい地形に立っているか」を
 * 買う前に測る純関数。キオクシア検証の教訓: -15%を予言するのは無理でも、
 * 「-15%が日常の地形にいる」は買う時点の数字で全部言えた。予知でなく地形の認識。
 *
 * 材料 (すべて日足から計算可能):
 *  ・ボラティリティ (ATR%) — 普段どれだけ荒く動くか
 *  ・急変頻度 — 直近20日で ±7%超の日が何割あったか
 *  ・最大の一撃 — 直近20日の最悪の1日下落
 *  ・直近高値からのドローダウン — 天井から何%落ちているか (祭りの後か)
 *  ・過熱 (移動平均からの乖離) — 買われ過ぎの垂直上げか
 *  ・信用倍率 (任意) — 逃げ場のない買い方の積み上がり
 *
 * 出力は Commentary (温度計インフラ) + 0..100 のリスクスコア。
 * 投資助言ではない。地形の説明。
 */

import {
  type Commentary,
  type CommentaryLine,
  C_GOOD,
  C_NEUTRAL,
  C_WARN,
  C_UP,
} from "./commentary";

export interface TerrainBar {
  high: number;
  low: number;
  close: number;
}

export interface TerrainInput {
  price: number;
  /** 日足 (古い順)。最低30本推奨 */
  bars: TerrainBar[];
  /** 移動平均 (乖離判定用)。無ければ内部で25日SMAを計算 */
  sma?: number | null;
  /** 信用倍率 (任意) */
  marginRatio?: number | null;
}

export type TerrainTier = "stable" | "choppy" | "volatile" | "fragile";

export interface TerrainResult {
  score: number;          // 0..100 (高いほど脆弱)
  tier: TerrainTier;
  commentary: Commentary;
}

/**
 * 地形の素材。日足から計算しても、daily_features の既存列から渡してもよい。
 * これを唯一の採点入力にすることで、銘柄ページ・buyplan・全銘柄日次バッチで
 * 完全に同じスコアが出る (二重実装による食い違いを防ぐ)。
 */
export interface TerrainMetrics {
  atrPct: number | null;            // ATR14 / 株価 %
  bigDayRate: number | null;        // 直近20日で |騰落| >= 7% の割合 0..1
  worstDrop20: number | null;       // 直近20日の最悪の1日 %
  drawdownFromHigh: number | null;  // 直近60日高値からの下落 %
  extensionPct: number | null;      // 25日移動平均からの乖離 %
  marginRatio?: number | null;      // 信用倍率 (任意)
}

/** 地形メトリクス → 0..100 のスコアと tier (採点の唯一の実装) */
export function scoreTerrainMetrics(m: TerrainMetrics): { score: number; tier: TerrainTier } {
  let score = 0;
  if (m.atrPct != null) score += Math.min(35, Math.max(0, (m.atrPct - 2) * 5));
  if (m.bigDayRate != null) score += Math.min(30, m.bigDayRate * 100);
  if (m.worstDrop20 != null && m.worstDrop20 <= -10) {
    score += Math.min(15, (Math.abs(m.worstDrop20) - 5) * 1.5);
  }
  if (m.drawdownFromHigh != null && m.drawdownFromHigh <= -15) {
    score += Math.min(12, (Math.abs(m.drawdownFromHigh) - 10) * 0.6);
  }
  if (m.extensionPct != null && m.extensionPct >= 20) {
    score += Math.min(12, (m.extensionPct - 15) * 0.5);
  }
  if (m.marginRatio != null && m.marginRatio >= 10) {
    score += Math.min(8, (m.marginRatio - 8) * 0.5);
  }
  score = Math.round(Math.min(100, score));
  const tier: TerrainTier =
    score >= 65 ? "fragile" : score >= 45 ? "volatile" : score >= 25 ? "choppy" : "stable";
  return { score, tier };
}

/** 日足から地形メトリクスを計算 */
export function computeTerrainMetrics(input: TerrainInput): TerrainMetrics | null {
  const { price, bars } = input;
  if (!price || bars.length < 20) return null;

  const changes: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].close > 0) changes.push((bars[i].close / bars[i - 1].close - 1) * 100);
  }
  const last20 = changes.slice(-20);

  const high60 = Math.max(...bars.slice(-60).map((b) => b.high));
  let sma = input.sma ?? null;
  if (sma == null && bars.length >= 25) {
    sma = bars.slice(-25).reduce((s, b) => s + b.close, 0) / 25;
  }

  return {
    atrPct: atr14Pct(bars, price),
    bigDayRate: last20.length >= 10 ? last20.filter((c) => Math.abs(c) >= 7).length / last20.length : null,
    worstDrop20: last20.length ? Math.min(...last20) : null,
    drawdownFromHigh: high60 > 0 ? (price / high60 - 1) * 100 : null,
    extensionPct: sma && sma > 0 ? (price / sma - 1) * 100 : null,
    marginRatio: input.marginRatio ?? null,
  };
}

function atr14Pct(bars: TerrainBar[], price: number): number | null {
  if (bars.length < 15 || price <= 0) return null;
  let sum = 0;
  const recent = bars.slice(-15);
  for (let i = 1; i < recent.length; i++) {
    const b = recent[i], p = recent[i - 1];
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    sum += tr;
  }
  return (sum / 14 / price) * 100;
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

/** tier の表示メタ (バッジ・パネル共通)。短ラベルはリスト内バッジ用 */
export const TIER_META: Record<
  TerrainTier,
  { label: string; short: string; emoji: string; color: string; stance: string }
> = {
  fragile: {
    label: "極めて脆弱", short: "脆弱", emoji: "🚨", color: C_UP,
    stance: "暴落しやすい地形に立っている。買うなら「明日-15%やっても耐えられる株数か」を先に決める。この地形では損切りを浅く置くとノイズで刈られ、深く置くと大怪我する。",
  },
  volatile: {
    label: "高ボラ地形", short: "高ボラ", emoji: "⚠", color: C_WARN,
    stance: "値動きが荒い地形。同じ枚数でも普通の株より2〜3倍振られる前提で、ポジションは小さめに。",
  },
  choppy: {
    label: "やや荒い", short: "やや荒", emoji: "〜", color: C_NEUTRAL,
    stance: "そこそこ動くが、極端ではない。普通の損切り幅で対応できる範囲。",
  },
  stable: {
    label: "安定地形", short: "安定", emoji: "🌳", color: C_GOOD,
    stance: "値動きは落ち着いている。急落サインが出たら、それは本物の事件である可能性が高い。",
  },
};

// ────────────────────────────────────────────
// ポートフォリオ地形サマリ: 「資産の◯%が脆弱地形の上に乗っているか」
// ────────────────────────────────────────────
export interface HoldingTerrain {
  ticker: string;
  name: string;
  value: number;          // 時価評価額 (加重の重み)
  score: number | null;   // null = データ不足で評価不能
  tier: TerrainTier | null;
}

export interface PortfolioTerrainSummary {
  totalValue: number;
  evaluatedValue: number;              // 地形を評価できた分の時価
  /** tier ごとの時価シェア (%) */
  shares: Record<TerrainTier, number>;
  /** 時価加重の平均地形スコア */
  weightedScore: number | null;
  /** 脆弱+高ボラ の時価シェア (%) — 見出しに使う */
  riskyShare: number;
  headline: string;
  tone: "pos" | "neutral" | "warn";
  /** 荒い順の内訳 (脆弱・高ボラのみ) */
  hotspots: HoldingTerrain[];
}

export function summarizePortfolioTerrain(holdings: HoldingTerrain[]): PortfolioTerrainSummary {
  const totalValue = holdings.reduce((s, h) => s + h.value, 0);
  const evaluated = holdings.filter((h) => h.tier != null && h.score != null);
  const evaluatedValue = evaluated.reduce((s, h) => s + h.value, 0);

  const shares: Record<TerrainTier, number> = { fragile: 0, volatile: 0, choppy: 0, stable: 0 };
  let wSum = 0;
  for (const h of evaluated) {
    shares[h.tier!] += h.value;
    wSum += h.value * h.score!;
  }
  const base = evaluatedValue > 0 ? evaluatedValue : 1;
  (Object.keys(shares) as TerrainTier[]).forEach((k) => {
    shares[k] = Math.round((shares[k] / base) * 1000) / 10;
  });
  const weightedScore = evaluatedValue > 0 ? Math.round((wSum / evaluatedValue)) : null;
  const riskyShare = Math.round((shares.fragile + shares.volatile) * 10) / 10;

  let headline: string;
  let tone: PortfolioTerrainSummary["tone"];
  if (shares.fragile >= 30) {
    tone = "warn";
    headline = `資産の ${shares.fragile}% が🚨脆弱地形の上。1銘柄の急落で全体が大きく振られる構成です。`;
  } else if (riskyShare >= 40) {
    tone = "warn";
    headline = `資産の ${riskyShare}% が荒い地形 (脆弱+高ボラ)。値動きの激しいポートフォリオです。`;
  } else if (riskyShare >= 15) {
    tone = "neutral";
    headline = `資産の ${riskyShare}% が荒い地形。大半は落ち着いていますが、一部にボラの高い銘柄があります。`;
  } else {
    tone = "pos";
    headline = `資産の ${Math.round((shares.stable + shares.choppy) * 10) / 10}% が穏やかな地形。地に足のついた構成です。`;
  }

  const hotspots = evaluated
    .filter((h) => h.tier === "fragile" || h.tier === "volatile")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return { totalValue, evaluatedValue, shares, weightedScore, riskyShare, headline, tone, hotspots };
}

export function assessTerrain(input: TerrainInput): TerrainResult | null {
  const { price, bars } = input;
  const metrics = computeTerrainMetrics(input);
  if (!metrics) return null;

  const { atrPct, worstDrop20, drawdownFromHigh, extensionPct } = metrics;
  const bigDayRate = metrics.bigDayRate ?? 0;
  const worstDrop = worstDrop20 ?? 0;
  const drawdown = drawdownFromHigh ?? 0;
  const extension = extensionPct;
  const high60 = Math.max(...bars.slice(-60).map((b) => b.high));

  // 採点は共有関数に一本化 (銘柄ページ/buyplan/全銘柄バッチで同一スコア)
  const { score, tier } = scoreTerrainMetrics(metrics);

  const lines: CommentaryLine[] = [];
  const terms: string[] = ["ATR"];

  // 1. ボラティリティ (ATR%)
  if (atrPct != null) {
    if (atrPct >= 6) {
      lines.push({ icon: "🌪", tone: "warn", text: `1日の平均値幅 (ATR) が株価の ${atrPct.toFixed(1)}% = 極めて荒い。普段から±${atrPct.toFixed(0)}%動くので、-15%が「特別な事件」ではなく日常の範囲。` });
    } else if (atrPct >= 3.5) {
      lines.push({ icon: "〜", tone: "neutral", text: `1日の平均値幅 (ATR) が ${atrPct.toFixed(1)}% = やや荒い。値動きは大きめ。` });
    } else {
      lines.push({ icon: "◦", tone: "pos", text: `1日の平均値幅 (ATR) が ${atrPct.toFixed(1)}% = 落ち着いている。` });
    }
  }

  // 2. 急変頻度
  if (metrics.bigDayRate != null) {
    if (bigDayRate >= 0.25) {
      lines.push({ icon: "🎲", tone: "warn", text: `直近20営業日のうち ${Math.round(bigDayRate * 20)}日 が ±7%超の急変。1週間に1〜2回は大きく飛ぶ「宝くじ地形」。` });
      terms.push("ノイズ幅");
    } else if (bigDayRate >= 0.1) {
      lines.push({ icon: "◦", tone: "neutral", text: `直近20営業日で ${Math.round(bigDayRate * 20)}日 が ±7%超。時々大きく動く。` });
    }
  }

  // 3. 最大の一撃
  if (worstDrop <= -10) {
    lines.push({ icon: "💥", tone: "warn", text: `直近20日の最悪の1日は ${pct(worstDrop)}。一撃で大きく削られた実績あり。` });
  }

  // 4. 天井からのドローダウン
  if (drawdown <= -15) {
    lines.push({ icon: "📉", tone: "warn", text: `直近高値 (¥${Math.round(high60).toLocaleString()}) から ${pct(drawdown)} 下落済み。祭りの後で崩れが進行中の可能性。` });
  }

  // 5. 過熱 (移動平均乖離)
  if (extension != null && extension >= 20) {
    lines.push({ icon: "🔥", tone: "warn", text: `25日移動平均から ${pct(extension)} 上に乖離 = 買われ過ぎの垂直上げ。反動 (急落) が出やすい位置。` });
    terms.push("移動平均線");
  }

  // 6. 信用倍率 (任意)
  if (input.marginRatio != null && input.marginRatio >= 10) {
    lines.push({ icon: "🏦", tone: "warn", text: `信用倍率 ${input.marginRatio.toFixed(1)}倍 = 買い方が逃げ場なく積み上がっている。下げ出すと投げが投げを呼ぶ。` });
    terms.push("信用倍率", "買残");
  }

  // ── ティア別の見出しとスタンス ──
  const meta = TIER_META[tier];
  const temp: Commentary["temp"] = { label: `${meta.label} (リスク${score})`, emoji: meta.emoji, color: meta.color };
  const stance = meta.stance;

  if (lines.length === 0) {
    lines.push({ icon: "◦", tone: "pos", text: "特筆すべき脆弱性は見当たらない。" });
  }

  const caveat =
    "地形は「起きやすさ」であって予言ではない。安定地形でも事件は起きるし、脆弱地形でも上がることはある。要は「どれだけ振られる前提で枚数と損切りを決めるか」の材料。売買の推奨ではありません。";

  return { score, tier, commentary: { temp, stance, lines, terms, caveat } };
}
