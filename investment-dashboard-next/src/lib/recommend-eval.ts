/**
 * おすすめv2 答え合わせループ — 統計の核 (純関数)
 *
 * 「短期/中期/長期の選定ロジックは、偶然より上手いのか」に反証可能な形で答える。
 * 素直に作ると必ず自分を騙すので、4つの罠を構造で潰してある:
 *
 *  罠1 実行可能性: おすすめは朝生成 → 買えるのは当日の寄り。前日終値基準だと
 *      「買えない値段の利益」が混入する (モメンタム系はギャップアップしやすい)。
 *      → 評価は必ず「推薦日の始値 → N営業日後の終値」。
 *
 *  罠2 地合い: 上げ相場では何を選んでも上がる。
 *      → 同一期間の指数 (JP=日経/US=S&P500) を引いた「超過リターン」が主指標。
 *        的中の定義は「上がった」ではなく「市場に勝った」。
 *
 *  罠3 選択バイアス: 市場対比だけでは「関門を通れば何でも良かった」を否定できない。
 *      → 生成時に保存した統制群 (同じ関門・ランダム選抜) と比較する。
 *        ロジックの価値 = pick超過 − 統制群超過。
 *
 *  罠4 クロスセクション相関 (パターン工場で踏んだ): 同じ日の8銘柄は独立でない
 *      (同じ地合いを共有)。銘柄単位で数えると有意性が幻になる。
 *      → 統計単位は「日」。日ごとに平均超過を出してから日次系列で t 検定。
 *
 * 評価窓は時間軸に忠実 (短期+5 / 中期+20 / 長期+60 営業日)。焦って仮採点しない。
 */

export type Horizon = "short" | "mid" | "long" | "kiyohara";

/** 全トラック (kiyohara = 清原式NCエンジン。既存🏔長期とのレース用の並走トラック) */
export const HORIZONS: Horizon[] = ["short", "mid", "long", "kiyohara"];

/** 時間軸ごとの評価窓 (営業日)。kiyohara は long と同じ土俵 (60日) で競わせる */
export const EVAL_WINDOW: Record<Horizon, number> = { short: 5, mid: 20, long: 60, kiyohara: 60 };

/** 判定を出すのに最低限必要な「評価済み営業日数」(1銘柄でなく1日が1サンプル) */
export const MIN_EVAL_DAYS = 10;

export interface EvalItem {
  ticker: string;
  /** 推薦日の始値 → 満期日の終値 (%) */
  retPct: number | null;
  /** 同期間の指数リターン (%) */
  benchPct: number | null;
  /** 超過 = retPct - benchPct */
  excessPct: number | null;
}

/** 1推薦日 × 1時間軸の評価結果 */
export interface DayEval {
  date: string;              // 推薦日 YYYY-MM-DD
  horizon: Horizon;
  maturedOn: string;         // 満期日 YYYY-MM-DD
  picks: EvalItem[];
  controls: EvalItem[];
  /** pick の平均超過 (この日の1サンプル) */
  pickExcess: number | null;
  /** 統制群の平均超過 */
  controlExcess: number | null;
  /** ロジックの価値 = pickExcess - controlExcess */
  edge: number | null;
  /** 市場に勝った pick の割合 */
  winRate: number | null;
  /** 評価不能だった銘柄数 (上場廃止・データ欠損。生存者バイアスの正直な記録) */
  unevaluable: number;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** 1日分の評価を組み立てる (罠2/3: 超過と統制群の差をここで確定) */
export function buildDayEval(
  date: string,
  horizon: Horizon,
  maturedOn: string,
  picks: EvalItem[],
  controls: EvalItem[],
): DayEval {
  const pv = picks.map((p) => p.excessPct).filter((v): v is number => v != null);
  const cv = controls.map((c) => c.excessPct).filter((v): v is number => v != null);
  const pickExcess = mean(pv);
  const controlExcess = mean(cv);
  return {
    date, horizon, maturedOn, picks, controls,
    pickExcess,
    controlExcess,
    edge: pickExcess != null && controlExcess != null ? pickExcess - controlExcess : null,
    winRate: pv.length ? pv.filter((v) => v > 0).length / pv.length : null,
    unevaluable: picks.filter((p) => p.excessPct == null).length,
  };
}

export interface HorizonSummary {
  horizon: Horizon;
  /** 統計単位: 評価済みの営業日数 (銘柄数ではない — 罠4) */
  evaluatedDays: number;
  /** まだ満期が来ていない推薦日の数 */
  maturingDays: number;
  meanPickExcess: number | null;
  medianPickExcess: number | null;
  meanControlExcess: number | null;
  /** ロジックの価値 (順位付けの寄与) */
  meanEdge: number | null;
  /** 日次系列の t 値 (edge が 0 と言えるか) */
  edgeT: number | null;
  /** 関門の価値 (統制群が市場に勝っているか) の t 値 */
  gateT: number | null;
  /** pick が市場に勝った割合 (銘柄ベース。参考値) */
  winRate: number | null;
  /** 判定を出してよいか (評価済み日数が足りているか) */
  ready: boolean;
  verdict: "logic_works" | "gate_only" | "no_edge" | "pending";
  message: string;
}

/** 1標本 t 検定 (帰無仮説: 平均 = 0) */
function tStat(xs: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const m = xs.reduce((s, v) => s + v, 0) / n;
  const varSum = xs.reduce((s, v) => s + (v - m) ** 2, 0);
  const sd = Math.sqrt(varSum / (n - 1));
  if (!(sd > 0)) return null;
  return m / (sd / Math.sqrt(n));
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** 日次系列 → 時間軸サマリ (罠4: 日が1サンプル) */
export function summarize(horizon: Horizon, days: DayEval[], maturingDays: number): HorizonSummary {
  const edges = days.map((d) => d.edge).filter((v): v is number => v != null);
  const pickEx = days.map((d) => d.pickExcess).filter((v): v is number => v != null);
  const ctrlEx = days.map((d) => d.controlExcess).filter((v): v is number => v != null);

  const allPickWins = days.flatMap((d) => d.picks.map((p) => p.excessPct)).filter((v): v is number => v != null);
  const winRate = allPickWins.length ? allPickWins.filter((v) => v > 0).length / allPickWins.length : null;

  const edgeT = tStat(edges);
  const gateT = tStat(ctrlEx);
  const evaluatedDays = days.length;
  const ready = evaluatedDays >= MIN_EVAL_DAYS;

  const meanEdge = pickEx.length && ctrlEx.length ? mean(edges) : null;

  let verdict: HorizonSummary["verdict"] = "pending";
  let message: string;
  if (!ready) {
    verdict = "pending";
    const need = MIN_EVAL_DAYS - evaluatedDays;
    message = `評価済み ${evaluatedDays}営業日 (熟成中 ${maturingDays}日)。判定にはあと ${need}日ぶん必要 — まだ何も言えません。`;
  } else if (meanEdge != null && meanEdge > 0 && edgeT != null && edgeT >= 2) {
    verdict = "logic_works";
    message = `順位付けに価値あり: 統制群より平均 ${r2(meanEdge)}% 上回る (t=${r2(edgeT)}, ${evaluatedDays}営業日)。`;
  } else if (gateT != null && gateT >= 2 && mean(ctrlEx) != null && mean(ctrlEx)! > 0) {
    verdict = "gate_only";
    message = `関門には価値があるが、順位付けは効いていない (統制群と互角)。上位を選ぶ意味が今のところ無い。`;
  } else {
    verdict = "no_edge";
    message = `市場・統制群に対する優位が確認できない (${evaluatedDays}営業日)。ロジックの作り直しを検討。`;
  }

  return {
    horizon,
    evaluatedDays,
    maturingDays,
    meanPickExcess: mean(pickEx) != null ? r2(mean(pickEx)!) : null,
    medianPickExcess: median(pickEx) != null ? r2(median(pickEx)!) : null,
    meanControlExcess: mean(ctrlEx) != null ? r2(mean(ctrlEx)!) : null,
    meanEdge: meanEdge != null ? r2(meanEdge) : null,
    edgeT: edgeT != null ? r2(edgeT) : null,
    gateT: gateT != null ? r2(gateT) : null,
    winRate: winRate != null ? Math.round(winRate * 1000) / 10 : null,
    ready,
    verdict,
    message,
  };
}
