/**
 * 🔬 仮説ラボ v2 — カレンダータイム法 (2026-08-04, Fable設計)
 *
 * 動機: 保有窓の重なりを cooldown で間引くと独立窓数に算術上限がある
 * (4.7年で60日窓は最大19)。稀少イベント×長期窓は原理的に MIN_DAYS=30 に届かない。
 *
 * 解法: イベント単位の窓リターンをやめ、
 *   β = mean(日次超過 | シグナル有効日) − mean(日次超過 | それ以外の日)
 * で測る。同じ日を二度数えることが構造的に不可能になり、全発火を捨てずに使える。
 * A=0 の日が統制群になるため、業種固有のドリフトも自動で差し引かれる。
 *
 * 検定:
 *   一次 = 循環シフト・プラセボ (発火パターンだけを時間軸上で回転。リターン系列は
 *          一切触らないので、自己相関もイベント密集構造もそのまま帰無分布に保存される)
 *   補助 = Newey-West 付き回帰 t (日次系列なので素直に効く)
 *
 * 正直な限界: 独立した危機の数は増やせない。episodes (連続有効期間の塊の数) を
 * 明示ゲートにし、topEpisodeShare で「1つの危機だけで持っている法則」を弾く。
 * 洗い流し25%系 (実質2-3エピソード) はこの方法でも「不足」が正しい答え。
 */

import type { Verdict } from "./hypothesis-lab";

export interface CalendarTestResult {
  nActive: number;
  nInactive: number;
  episodes: number;
  betaDaily: number | null;      // %/日
  betaWindowPct: number | null;  // × horizon (窓相当の効果量。G0 ゲート用)
  tNW: number | null;
  pPlacebo: number | null;
  topEpisodeShare: number | null; // 最大エピソードの証拠寄与率 0..1
  firstHalf: { beta: number | null; nActive: number };
  secondHalf: { beta: number | null; nActive: number };
  verdict: Verdict;
  reason: string;
}

export const GATES_V2 = {
  MIN_ACTIVE_DAYS: 30,
  MIN_EPISODES: 5,        // これ未満は判定不能 (実質数回のマクロ経験)
  EPISODES_ADOPT: 8,      // 候補に必要な独立機会数
  P_ADOPT: 0.01,
  P_REJECT: 0.10,
  MIN_EFFECT_PCT: 0.5,    // 窓相当 (betaDaily × horizon)
  /**
   * 有効日が全体に占める割合の上限。
   * 2026-08-11 の反証枠で発覚: 「月曜 → 5日」は有効1033/1163日 = 89% となり
   * 対照群がほぼ消える。比較が成立しないまま p=0.028 が出ていた。
   * 高頻度・周期的なトリガーはこの設計では測れない (循環シフトも周期パターンだと
   * 実質的に少数の異なる配置しか作れず、帰無分布が信用できない)。
   */
  MAX_ACTIVE_FRACTION: 0.5,
  MAX_TOP_EPISODE: 0.6,   // 1エピソードが証拠の6割超なら昇格不可
  T_NW_ADOPT: 2.5,        // 合議制: プラセボと NW-t の両方が支持して初めて候補
  PLACEBO_B: 2000,
};

/** 発火index列 → 有効日マスク (lag 日後から horizon 日間) */
export function buildActiveMask(T: number, fireIdx: number[], lag: number, horizon: number): Uint8Array {
  const mask = new Uint8Array(T);
  for (const f of fireIdx) {
    const s = f + lag;
    const e = Math.min(T - 1, f + lag + horizon - 1);
    for (let d = Math.max(0, s); d <= e; d++) mask[d] = 1;
  }
  return mask;
}

/** 連続した有効期間の塊の数 */
export function countEpisodes(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 1 && (i === 0 || mask[i - 1] === 0)) n++;
  }
  return n;
}

/** 再現性のための決定的乱数 (mulberry32)。仮説IDから種を作る */
export function seededRng(seedStr: string): () => number {
  let h = 1779033703;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** OLS (定数 + ダミー) の β と Newey-West t。密配列を渡すこと */
function olsNW(y: number[], a: number[], lagL: number): { beta: number; t: number | null } {
  const n = y.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0;
  const x = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    x[i] = a[i] - ma;
    sxx += x[i] * x[i];
    sxy += x[i] * (y[i] - my);
  }
  if (sxx <= 0) return { beta: 0, t: null };
  const beta = sxy / sxx;
  const alpha = my - beta * ma;
  const e = new Array<number>(n);
  for (let i = 0; i < n; i++) e[i] = y[i] - alpha - beta * a[i];
  let S = 0;
  for (let j = -lagL; j <= lagL; j++) {
    const w = 1 - Math.abs(j) / (lagL + 1);
    let g = 0;
    for (let i = Math.max(0, j); i < n + Math.min(0, j); i++) g += x[i] * e[i] * x[i - j] * e[i - j];
    S += w * g;
  }
  const varB = S / (sxx * sxx);
  return { beta, t: varB > 0 ? beta / Math.sqrt(varB) : null };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * カレンダータイム検定の本体。
 * @param y    日次系列 (業種平均超過 or 指数リターン)。null = データの無い日
 * @param mask 有効日マスク (buildActiveMask で作る)
 */
export function calendarTimeTest(
  id: string,
  y: (number | null)[],
  mask: Uint8Array,
  horizon: number,
  opts?: { placeboB?: number },
): CalendarTestResult {
  const T = y.length;
  const yv: number[] = [], av: number[] = [], idx: number[] = [];
  for (let i = 0; i < T; i++) {
    const v = y[i];
    if (v != null && isFinite(v)) { yv.push(v); av.push(mask[i]); idx.push(i); }
  }
  const nActive = av.reduce((s, v) => s + v, 0);
  const nInactive = yv.length - nActive;
  const episodes = countEpisodes(mask);

  const base = {
    nActive, nInactive, episodes,
    betaDaily: null as number | null, betaWindowPct: null as number | null,
    tNW: null as number | null, pPlacebo: null as number | null,
    topEpisodeShare: null as number | null,
    firstHalf: { beta: null as number | null, nActive: 0 },
    secondHalf: { beta: null as number | null, nActive: 0 },
  };

  if (nActive < GATES_V2.MIN_ACTIVE_DAYS || episodes < GATES_V2.MIN_EPISODES || nInactive < 60) {
    return {
      ...base, verdict: "insufficient",
      reason: `有効${nActive}日 / エピソード${episodes}個 (最低 ${GATES_V2.MIN_ACTIVE_DAYS}日・${GATES_V2.MIN_EPISODES}個)。独立した機会が足りません`,
    };
  }
  const activeFrac = nActive / (nActive + nInactive);
  if (activeFrac > GATES_V2.MAX_ACTIVE_FRACTION) {
    return {
      ...base, verdict: "insufficient",
      reason: `有効日が全体の ${Math.round(activeFrac * 100)}% を占め、対照群が小さすぎます (上限 ${Math.round(GATES_V2.MAX_ACTIVE_FRACTION * 100)}%)。条件を厳しくするか保有期間を短くしてください`,
    };
  }

  let sA = 0, cA = 0, sI = 0, cI = 0;
  for (let i = 0; i < yv.length; i++) {
    if (av[i] === 1) { sA += yv[i]; cA++; } else { sI += yv[i]; cI++; }
  }
  const mI = sI / cI;
  const betaDaily = sA / cA - mI;
  const betaWindowPct = betaDaily * horizon;

  const lagL = Math.max(5, Math.min(10, horizon));
  const { t: tNW } = olsNW(yv, av, lagL);

  // エピソード寄与 (証拠が1つの危機に集中していないか)。密配列上の連続判定は元indexで行う
  const contrib: number[] = [];
  let cur = 0, hasAny = false;
  for (let i = 0; i < yv.length; i++) {
    if (av[i] === 1) {
      cur += yv[i] - mI;
      hasAny = true;
      const isLast = i === yv.length - 1;
      const nextActive = !isLast && av[i + 1] === 1 && idx[i + 1] === idx[i] + 1;
      if (isLast || !nextActive) { contrib.push(cur); cur = 0; hasAny = false; }
    }
  }
  if (hasAny) contrib.push(cur);
  const absSum = contrib.reduce((s, v) => s + Math.abs(v), 0);
  const topEpisodeShare = absSum > 0 ? Math.max(...contrib.map(Math.abs)) / absSum : null;

  // 分割検証 (暦の前半/後半)
  const halfAt = Math.floor(yv.length / 2);
  const halfBeta = (from: number, to: number) => {
    let sa = 0, ca = 0, si = 0, ci = 0;
    for (let i = from; i < to; i++) {
      if (av[i] === 1) { sa += yv[i]; ca++; } else { si += yv[i]; ci++; }
    }
    return { beta: ca >= 10 && ci >= 20 ? sa / ca - si / ci : null, nActive: ca };
  };
  const firstHalf = halfBeta(0, halfAt);
  const secondHalf = halfBeta(halfAt, yv.length);

  // 循環シフト・プラセボ
  const B = opts?.placeboB ?? GATES_V2.PLACEBO_B;
  const rng = seededRng(id);
  const minShift = horizon;
  const maxShift = yv.length - horizon;
  let ge = 0, valid = 0;
  for (let b = 0; b < B; b++) {
    const k = minShift + Math.floor(rng() * Math.max(1, maxShift - minShift));
    let sa = 0, ca = 0, si = 0, ci = 0;
    for (let i = 0; i < yv.length; i++) {
      const j = (i + k) % yv.length;
      if (av[j] === 1) { sa += yv[i]; ca++; } else { si += yv[i]; ci++; }
    }
    if (ca === 0 || ci === 0) continue;
    valid++;
    if (Math.abs(sa / ca - si / ci) >= Math.abs(betaDaily)) ge++;
  }
  const pPlacebo = (1 + ge) / (valid + 1);

  const out = {
    ...base,
    betaDaily: r3(betaDaily), betaWindowPct: r3(betaWindowPct),
    tNW: tNW != null ? Math.round(tNW * 100) / 100 : null,
    pPlacebo: Math.round(pPlacebo * 10000) / 10000,
    topEpisodeShare: topEpisodeShare != null ? r3(topEpisodeShare) : null,
    firstHalf: { beta: firstHalf.beta != null ? r3(firstHalf.beta) : null, nActive: firstHalf.nActive },
    secondHalf: { beta: secondHalf.beta != null ? r3(secondHalf.beta) : null, nActive: secondHalf.nActive },
  };

  // ── 判定 ──
  if (Math.abs(betaWindowPct) < GATES_V2.MIN_EFFECT_PCT) {
    return { ...out, verdict: "rejected", reason: `窓相当の効果 ${out.betaWindowPct}% は小さすぎる (最低 ${GATES_V2.MIN_EFFECT_PCT}%)。売買コストに埋もれます` };
  }
  if (out.pPlacebo! > GATES_V2.P_REJECT) {
    return { ...out, verdict: "rejected", reason: `プラセボ p=${out.pPlacebo} — 発火タイミングを無作為にしても同程度の差が出ます` };
  }
  const sameSign =
    out.firstHalf.beta != null && out.secondHalf.beta != null &&
    Math.sign(out.firstHalf.beta) === Math.sign(out.secondHalf.beta) &&
    Math.sign(out.firstHalf.beta) === Math.sign(betaDaily);
  if (out.pPlacebo! <= GATES_V2.P_ADOPT) {
    if (!sameSign) {
      return { ...out, verdict: "exploring", reason: `p=${out.pPlacebo} は強いが分割検証で符号が揃わない (前半 ${out.firstHalf.beta} / 後半 ${out.secondHalf.beta}) — 期間依存の疑い` };
    }
    if (episodes < GATES_V2.EPISODES_ADOPT) {
      return { ...out, verdict: "exploring", reason: `p=${out.pPlacebo} だがエピソード ${episodes}個 (<${GATES_V2.EPISODES_ADOPT}) — 独立機会がまだ少ない` };
    }
    if (out.topEpisodeShare != null && out.topEpisodeShare > GATES_V2.MAX_TOP_EPISODE) {
      return { ...out, verdict: "exploring", reason: `p=${out.pPlacebo} だが証拠の ${Math.round(out.topEpisodeShare * 100)}% が単一エピソード由来 — 1つの危機に依存` };
    }
    // 合議制: 独立性の異なる2つの検定 (プラセボ + NW-t) が両方支持して初めて候補。
    // 帰無較正で「プラセボ単独だと 200回中3回」誤昇格したため追加 (2026-08-04)
    if (out.tNW == null || Math.abs(out.tNW) < GATES_V2.T_NW_ADOPT) {
      return { ...out, verdict: "exploring", reason: `プラセボ p=${out.pPlacebo} は支持だが NW-t=${out.tNW ?? "—"} が弱い (要 |t|>=${GATES_V2.T_NW_ADOPT}) — 合議不成立` };
    }
    return { ...out, verdict: "candidate", reason: `β=${out.betaDaily}%/日 (窓相当 ${out.betaWindowPct}%)、プラセボ p=${out.pPlacebo}、${episodes}エピソード、分割検証も同符号。4週間の前向き監視へ` };
  }
  return { ...out, verdict: "exploring", reason: `プラセボ p=${out.pPlacebo} — 気配はあるが採用線 (${GATES_V2.P_ADOPT}) に届かず` };
}
