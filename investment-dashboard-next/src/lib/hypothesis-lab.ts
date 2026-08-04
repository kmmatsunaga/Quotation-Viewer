/**
 * 🔬 仮説ラボ — 検定ハーネスの統計核 (純関数)
 *
 * 背景 (2026-08-04 ユーザー):
 *   「45回検定して全部作れなかった。でも、それであきらめるのですか?
 *    もっと過去のデータの相関を分析し、何かの数字の揺れが起きたら
 *    こういう株価が揺れる傾向がある、という発見を期待している。
 *    毎週20パターン調べるルーティンを作ってほしい」
 *
 * 設計の要点:
 *  ・毎週20件を【コードを書かずに】回すため、仮説を "仕様(JSON)" として記述する
 *  ・年1000件も検定すれば、偶然 |t|>=2 は数十件出る。だから関門を厳しくする:
 *      G1 サンプル: 発火日 >= 30日
 *      G2 統計:    日クラスタ t 検定で |t| >= 3.0 (市場超過ベース)
 *      G3 分割検証: 前半で発見 → 後半でも同符号かつ |t| >= 1.5
 *      G4 前向き:  上記通過後、4週間のライブ監視で符号維持 → ようやく「昇格」
 *  ・棄却も必ず記録する。「掘って何も無かった場所の地図」が資産になる
 *
 * 統計単位は営業日 (同じ日の多銘柄・多業種は独立でないため)。
 */

export type Verdict = "rejected" | "exploring" | "candidate" | "promoted" | "insufficient";

export interface HypothesisSpec {
  id: string;                 // 一意ID (例: "sox_lag3_semi")
  title: string;              // 人が読む説明
  family: string;             // 供給源 (macro_lag / sector_driver / internals / calendar / kiyohara / external)
  source?: string;            // 出所 (記事・書籍・自分の思いつき)
  /** 条件: この日に「揺れ」が起きたと判定する式 */
  trigger: string;            // 例: "sox >= 2.0" (ハーネスが提供する変数名で書く)
  /** 対象: どの銘柄群を見るか */
  target: string;             // 例: "industry:Semiconductor" / "all" / "ticker:7203"
  /** ラグ: 揺れの何営業日後から */
  lagDays: number;
  /** 保有期間: 何営業日ぶん測るか */
  horizonDays: number;
  /**
   * 発火の間引き日数。連続した発火日は保有窓がほぼ完全に重なるため、
   * そのまま数えると「n=30」でも実質的な独立エピソードは数個しかない
   * (2026-08-04 初回実行で発覚)。既定は horizonDays = 窓が重ならない間隔。
   */
  cooldownDays?: number;
  createdAt: string;
}

export interface DayObservation {
  date: string;               // 発火した営業日
  excessPct: number;          // 対象群の市場超過リターン (%)
}

export interface TestResult {
  id: string;
  nDays: number;
  meanExcess: number | null;
  medianExcess: number | null;
  t: number | null;
  winRate: number | null;
  /** 分割検証: 前半 / 後半 */
  firstHalf: { n: number; mean: number | null; t: number | null } | null;
  secondHalf: { n: number; mean: number | null; t: number | null } | null;
  verdict: Verdict;
  reason: string;
}

export const GATES = {
  MIN_DAYS: 30,        // G1 標本
  T_ADOPT: 3.0,        // G2 統計的有意
  T_CONFIRM: 1.5,      // G3 分割検証 (後半は緩めるが符号一致は必須)
  T_EXPLORING: 2.0,    // これ未満は問答無用で棄却
  /**
   * G0 効果量: 平均超過がこれ未満なら、t が幾ら大きくても棄却する。
   * 2026-08-04 に「超過 -0.048% なのに t=-5.3」で候補入りする事例が出たため追加。
   * 極めて小さいが一貫した測定残差は、統計的に有意でも取引の役には立たない。
   * 売買コスト (往復で概ね0.2-0.3%) を下回るものを拾っても意味がない。
   */
  MIN_EFFECT_PCT: 0.5,
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function tStat(xs: number[]): number | null {
  const n = xs.length;
  if (n < 5) return null;
  const m = mean(xs)!;
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1));
  return sd > 0 ? m / (sd / Math.sqrt(n)) : null;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 観測列 → 判定。
 * 分割検証は「時系列の前半で見つけたものが後半でも生きているか」を見る。
 * 過去全体で一発 t 検定するより、はるかに偽発見に強い。
 */
export function evaluate(spec: HypothesisSpec, obs: DayObservation[]): TestResult {
  const sorted = [...obs].sort((a, b) => a.date.localeCompare(b.date));
  const xs = sorted.map((o) => o.excessPct).filter((v) => isFinite(v));
  const nDays = xs.length;

  const base = {
    id: spec.id, nDays,
    meanExcess: mean(xs) != null ? r3(mean(xs)!) : null,
    medianExcess: median(xs) != null ? r3(median(xs)!) : null,
    t: tStat(xs) != null ? r2(tStat(xs)!) : null,
    winRate: nDays ? Math.round((xs.filter((v) => v > 0).length / nDays) * 1000) / 10 : null,
    firstHalf: null as TestResult["firstHalf"],
    secondHalf: null as TestResult["secondHalf"],
  };

  if (nDays < GATES.MIN_DAYS) {
    return { ...base, verdict: "insufficient", reason: `発火日が ${nDays}日 (最低 ${GATES.MIN_DAYS}日必要)。まだ何も言えません` };
  }

  const half = Math.floor(nDays / 2);
  const a = xs.slice(0, half), b = xs.slice(half);
  const ta = tStat(a), tb = tStat(b);
  const firstHalf = { n: a.length, mean: mean(a) != null ? r3(mean(a)!) : null, t: ta != null ? r2(ta) : null };
  const secondHalf = { n: b.length, mean: mean(b) != null ? r3(mean(b)!) : null, t: tb != null ? r2(tb) : null };
  const withHalves = { ...base, firstHalf, secondHalf };

  const t = base.t;
  // G0: 効果量が小さすぎるものは、t に関係なく棄却 (統計的有意 ≠ 使える)
  if (base.meanExcess != null && Math.abs(base.meanExcess) < GATES.MIN_EFFECT_PCT) {
    return {
      ...withHalves, verdict: "rejected",
      reason: `平均超過 ${base.meanExcess}% は小さすぎる (最低 ${GATES.MIN_EFFECT_PCT}%)。t=${t ?? "—"} でも売買コストに埋もれる`,
    };
  }
  if (t == null || Math.abs(t) < GATES.T_EXPLORING) {
    return { ...withHalves, verdict: "rejected", reason: `全期間 t=${t ?? "—"} — 優位性なし。この仮説は掘っても何も出ません` };
  }
  if (Math.abs(t) < GATES.T_ADOPT) {
    return { ...withHalves, verdict: "exploring", reason: `全期間 t=${t} — 気配はあるが採用線 (|t|>=${GATES.T_ADOPT}) に届かず。多重検定を考えると偶然の範囲` };
  }
  // 分割検証
  const sameSign = firstHalf.mean != null && secondHalf.mean != null && Math.sign(firstHalf.mean) === Math.sign(secondHalf.mean);
  const confirmed = sameSign && tb != null && Math.abs(tb) >= GATES.T_CONFIRM;
  if (!confirmed) {
    return {
      ...withHalves, verdict: "exploring",
      reason: `全期間 t=${t} は強いが、分割検証で確認できず (前半 ${firstHalf.mean} / 後半 ${secondHalf.mean}, 後半 t=${secondHalf.t}) — 期間依存の可能性`,
    };
  }
  return {
    ...withHalves, verdict: "candidate",
    reason: `全期間 t=${t}、分割検証も通過 (前半 ${firstHalf.mean} / 後半 ${secondHalf.mean})。4週間の前向き監視へ`,
  };
}

/** 週次レポート用の集計 */
export function summarizeWeek(results: TestResult[]): {
  total: number; rejected: number; exploring: number; candidate: number; insufficient: number; headline: string;
} {
  const c = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  const rejected = c("rejected"), exploring = c("exploring"), candidate = c("candidate"), insufficient = c("insufficient");
  const headline =
    candidate > 0
      ? `候補 ${candidate}件を発見 (前向き監視へ)`
      : exploring > 0
        ? `採用ゼロ。探索中 ${exploring}件を継続監視`
        : `全 ${results.length}件を棄却。掘った場所の地図が ${results.length}件ぶん増えました`;
  return { total: results.length, rejected, exploring, candidate, insufficient, headline };
}
