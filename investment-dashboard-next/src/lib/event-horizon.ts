/**
 * 📅 イベント地平線 — 「確定した未来」を先に知る
 *
 * ユーザーの要望 (2026-08-04):
 *   「当ててほしいわけではない。大きな流れの中でそれを読む力が欲しい」
 *
 * 予測できないものは予測しない。代わりに【もう決まっている未来】を並べる。
 * 日程は FRED の公式リリースカレンダーから取得する (推測で日付を書かない)。
 * 各イベントには「過去に実際どれだけ動いたか」の実測分布だけを添える。
 * 確率は出さない — 出せるだけの根拠がないため。
 */

export interface MacroEvent {
  date: string;          // JST基準の影響日 (米国発表は翌営業日に効くため+1日する)
  releaseDate: string;   // 現地の発表日
  name: string;          // 「米CPI」など
  releaseId: number;
  daysAhead: number;
}

export interface ReactionStats {
  name: string;
  samples: number;         // 過去何回ぶんか
  meanAbsMovePct: number;  // 日経の平均変動幅 (絶対値)
  maxUpPct: number;
  maxDownPct: number;
  upRate: number;          // 上昇した割合 %
  note: string;
}

export interface EarningsEvent {
  ticker: string;
  name: string;
  date: string;
  daysAhead: number;
  held: boolean;           // 保有しているか
}

export interface EventHorizon {
  generatedAt: string;
  windowDays: number;
  macro: (MacroEvent & { reaction: ReactionStats | null })[];
  earnings: EarningsEvent[];
  note: string;
}

/**
 * FRED のリリースID → 日本語名。ID はリリース一覧APIで実在を確認済み。
 *
 * ⚠ FOMC (id=101 "FOMC Press Release") は【意図的に外している】。
 *   会合日程ではなく日次データの配信フィードで、年363回の"リリース日"を返すため
 *   カレンダーとして使うと「毎日FOMC」という嘘になる (2026-08-04 実測で発覚)。
 *   FOMC/日銀の会合日程は FRED から取得できないので、検証可能な出所が
 *   見つかるまで載せない。推測で日付を書かないための判断。
 */
export const WATCHED_RELEASES: { id: number; label: string }[] = [
  { id: 10, label: "米CPI (消費者物価)" },
  { id: 50, label: "米雇用統計" },
  { id: 46, label: "米PPI (生産者物価)" },
  { id: 53, label: "米GDP" },
];

/**
 * 安全弁: 年30回を超える"リリース"は定期イベントではなく連続配信フィードとみなし除外する。
 * FOMC の件と同じ事故 (毎日イベントが立つ) を、リスト追加時に自動で防ぐ。
 */
export const MAX_RELEASES_PER_YEAR = 30;

export function looksLikeCalendarEvent(datesInWindow: number, windowDays: number): boolean {
  if (windowDays <= 0) return true;
  const perYear = (datesInWindow / windowDays) * 365;
  return perYear <= MAX_RELEASES_PER_YEAR;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 過去の発表日リスト × 日経の日次変動 → 実測の反応分布。
 * 米国の発表は日本時間の翌営業日に効くため、発表日の「次の営業日」を見る。
 */
export function computeReaction(
  label: string,
  pastReleaseDates: string[],
  nikkeiByDate: Map<string, number>,
  tradingDays: string[],
): ReactionStats | null {
  const moves: number[] = [];
  for (const rd of pastReleaseDates) {
    // 発表日より後の最初の営業日
    const next = tradingDays.find((d) => d > rd);
    if (!next) continue;
    const v = nikkeiByDate.get(next);
    if (v != null && isFinite(v)) moves.push(v);
  }
  if (moves.length < 5) return null;
  const abs = moves.map(Math.abs);
  return {
    name: label,
    samples: moves.length,
    meanAbsMovePct: r2(mean(abs)),
    maxUpPct: r2(Math.max(...moves)),
    maxDownPct: r2(Math.min(...moves)),
    upRate: Math.round((moves.filter((v) => v > 0).length / moves.length) * 1000) / 10,
    note: `過去${moves.length}回の翌営業日、日経は平均 ±${r2(mean(abs))}% 動いた (最大 +${r2(Math.max(...moves))}% / ${r2(Math.min(...moves))}%、上昇 ${Math.round((moves.filter((v) => v > 0).length / moves.length) * 100)}%)`,
  };
}

/** 日付文字列の差 (日) */
export function daysBetween(from: string, to: string): number {
  return Math.round((new Date(to + "T00:00:00Z").getTime() - new Date(from + "T00:00:00Z").getTime()) / 86400000);
}

/** 米国発表日 → 日本で効く日 (翌日) */
export function toJstImpactDate(releaseDate: string): string {
  const d = new Date(releaseDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
