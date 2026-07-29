/**
 * 🌊 レジーム測定器 — 「市場の何%が60日安値か」(breadth washout) で
 * 暴落の深さを"予測でなく測定"する。清原達郎『わが投資術』の
 * 「暴落はレジーム級のボーナス」を実装に翻訳したもの。
 *
 * 実測の根拠 (daily_features 2年×全銘柄, 2026-07-28 検証):
 *   洗い流しが深いほど、その後のリターンが単調に大きい
 *   ・2025-04-03 low60=36.9% → 60日後 +11.5%
 *   ・2025-04-04 low60=53.0% → 60日後 +15.5%
 *   ・2025-04-07 low60=74.6% → 60日後 +25.6% (関税ショックの底)
 *   ・2026-03-23 low60=30.0% → 60日後 +7.6%
 *   ・ベースライン全日平均: 60日後 +5.3%
 *   ※ 2年で実質2〜3エピソードの「標本の観察」。統計的確定ではない。
 *
 * 思想: 底を予測しない。「今どれだけ洗い流されたか」は今この瞬間に測れる。
 * 弾 (現金) は測定では作れない — 平時の政策でしか作れない (war chest)。
 */

export interface RegimePoint {
  date: string;     // YYYY-MM-DD
  low60Pct: number; // 流動銘柄のうち60日安値の割合 %
}

export interface RegimeGaugeDoc {
  date: string;
  n: number;          // 対象銘柄数 (売買代金1億以上)
  low60Pct: number;   // 60日安値の割合 % (洗い流しの深さ)
  low20Pct: number;   // 20日安値の割合 % (浅い下げ圧力)
  high60Pct: number;  // 60日高値の割合 % (過熱側)
  history: RegimePoint[]; // 直近~130営業日 (スパークライン用)
  updatedAt: string;
}

export type RegimeLevel = "historic" | "regime" | "washing" | "soft" | "calm";

export function regimeLevel(low60Pct: number): RegimeLevel {
  if (low60Pct >= 60) return "historic";
  if (low60Pct >= 40) return "regime";
  if (low60Pct >= 25) return "washing";
  if (low60Pct >= 12) return "soft";
  return "calm";
}

export const REGIME_META: Record<
  RegimeLevel,
  { label: string; emoji: string; color: string; note: string; warChest: string | null }
> = {
  historic: {
    label: "歴史的な洗い流し",
    emoji: "🎁",
    color: "#22c55e",
    note: "市場の6割超が60日安値。実測では2025-04-07 (74.6%) の60日後は+25.6% (ベースライン+5.3%)。数年に一度の水準。",
    warChest: "弾薬 (待機現金) の全量投入を検討する水準。ただし分割で。",
  },
  regime: {
    label: "レジーム級の洗い流し",
    emoji: "🎁",
    color: "#4ade80",
    note: "市場の4割超が60日安値。実測では53%の日の60日後は+15.5%。清原の言う「数年に一度のボーナス」圏。",
    warChest: "弾薬の1/2の投入を検討する水準。",
  },
  washing: {
    label: "洗い流し進行中",
    emoji: "⚠",
    color: "#facc15",
    note: "市場の1/4超が60日安値。実測では30〜37%の日の60日後は+7〜11%。さらに深くなる余地も。",
    warChest: "弾薬の1/3までを検討。深掘りに備えて残す。",
  },
  soft: {
    label: "下げ圧力あり",
    emoji: "〜",
    color: "#94a3b8",
    note: "60日安値が1割超。通常の調整の範囲。",
    warChest: null,
  },
  calm: {
    label: "平常",
    emoji: "🌤",
    color: "#64748b",
    note: "洗い流しは起きていない。",
    warChest: null,
  },
};

/** 全銘柄の日次特徴量からゲージ1日分を計算 (daily-features cron / シードで共用) */
export function computeGaugeFromRows(
  rows: { isLow60: boolean; isLow20: boolean; isHigh60: boolean; turnover: number | null }[],
): { n: number; low60Pct: number; low20Pct: number; high60Pct: number } | null {
  const liquid = rows.filter((r) => (r.turnover ?? 0) >= 1e8);
  if (liquid.length < 300) return null; // 休日・データ欠損は測らない
  const pct = (f: (r: (typeof liquid)[number]) => boolean) =>
    Math.round((liquid.filter(f).length / liquid.length) * 1000) / 10;
  return {
    n: liquid.length,
    low60Pct: pct((r) => r.isLow60),
    low20Pct: pct((r) => r.isLow20),
    high60Pct: pct((r) => r.isHigh60),
  };
}
