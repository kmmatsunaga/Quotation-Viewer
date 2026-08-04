/**
 * カレンダータイム検定の較正テスト (合成データ)
 *
 * A. 帰無 (効果ゼロ・密集発火): 偽陽性率が名目通りか。p<0.1 が ~10% なら較正OK
 * B. 効果注入 (+0.35%/日): 検出できるか (検出力)
 * C. ドリフト混入 (+0.08%/日 を全日に): β が汚染されないか (業種の恒常アルファ耐性)
 * D. 単一エピソード集中: topEpisodeShare ゲートが効くか
 */
import { buildActiveMask, calendarTimeTest, seededRng, GATES_V2 } from "../src/lib/hypothesis-lab-v2";

const T = 1163; // 実データと同じ営業日数

/** AR(1) ノイズ (φ=0.2, σ=1.2%) — 日次業種超過のリアルな粗さ */
function makeSeries(rng: () => number, drift = 0, effectMask?: Uint8Array, effect = 0): number[] {
  const y: number[] = [];
  let prev = 0;
  for (let i = 0; i < T; i++) {
    const z = Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());
    const e = 0.2 * prev + 1.2 * z;
    prev = e;
    y.push(e + drift + (effectMask && effectMask[i] ? effect : 0));
  }
  return y;
}

/** 密集発火: クラスタ3つ (各8連続日) + 単発10回 — VIX急騰の実構造を模す */
function makeFires(rng: () => number): number[] {
  const fires: number[] = [];
  const starts = [150, 500, 900];
  for (const s of starts) for (let i = 0; i < 8; i++) fires.push(s + i);
  for (let i = 0; i < 10; i++) fires.push(50 + Math.floor(rng() * (T - 100)));
  return Array.from(new Set(fires)).sort((a, b) => a - b);
}

const H = 10, LAG = 1, SIMS = 200, B = 500;

// ── A. 帰無較正 ──
let fp10 = 0, fp01 = 0, candidates = 0;
for (let s = 0; s < SIMS; s++) {
  const rng = seededRng(`null-${s}`);
  const fires = makeFires(rng);
  const mask = buildActiveMask(T, fires, LAG, H);
  const y = makeSeries(rng);
  const r = calendarTimeTest(`null-${s}`, y, mask, H, { placeboB: B });
  if (r.pPlacebo != null && r.pPlacebo < 0.1) fp10++;
  if (r.pPlacebo != null && r.pPlacebo <= 0.01) fp01++;
  if (r.verdict === "candidate") candidates++;
}
console.log(`A. 帰無較正 (${SIMS}回): p<0.10 率 = ${(fp10 / SIMS * 100).toFixed(1)}% (名目10%) / p<=0.01 率 = ${(fp01 / SIMS * 100).toFixed(1)}% (名目1%) / 候補誤昇格 = ${candidates}件`);

// ── B. 検出力 ──
let detected = 0, adopt = 0;
for (let s = 0; s < SIMS; s++) {
  const rng = seededRng(`eff-${s}`);
  const fires = makeFires(rng);
  const mask = buildActiveMask(T, fires, LAG, H);
  const y = makeSeries(rng, 0, mask, 0.35);
  const r = calendarTimeTest(`eff-${s}`, y, mask, H, { placeboB: B });
  if (r.pPlacebo != null && r.pPlacebo <= 0.05) detected++;
  if (r.verdict === "candidate") adopt++;
}
console.log(`B. 検出力 (+0.35%/日, ${SIMS}回): p<=0.05 検出 = ${(detected / SIMS * 100).toFixed(0)}% / 候補昇格 = ${(adopt / SIMS * 100).toFixed(0)}%`);

// ── C. ドリフト耐性 ──
let biased = 0;
let betaSum = 0;
for (let s = 0; s < 100; s++) {
  const rng = seededRng(`drift-${s}`);
  const fires = makeFires(rng);
  const mask = buildActiveMask(T, fires, LAG, H);
  const y = makeSeries(rng, 0.08); // 全日 +0.08% の恒常アルファ
  const r = calendarTimeTest(`drift-${s}`, y, mask, H, { placeboB: B });
  betaSum += r.betaDaily ?? 0;
  if (r.pPlacebo != null && r.pPlacebo <= 0.01) biased++;
}
console.log(`C. ドリフト耐性 (100回): 平均β = ${(betaSum / 100).toFixed(4)}%/日 (ゼロが正解) / p<=0.01 誤検出 = ${biased}件`);

// ── D. 単一エピソード集中 ──
{
  const rng = seededRng("single-ep");
  const fires: number[] = [];
  for (let i = 0; i < 8; i++) fires.push(400 + i);       // 大クラスタ1つ
  for (const s of [100, 200, 700, 800, 950, 1050]) fires.push(s); // 弱い単発
  const mask = buildActiveMask(T, fires, LAG, H);
  const y = makeSeries(rng);
  // 大クラスタ期間だけに強い効果 (= 1つの危機だけで持っている法則)
  for (let d = 401; d < 401 + 17; d++) y[d] += 1.5;
  const r = calendarTimeTest("single-ep", y, mask, H, { placeboB: 2000 });
  console.log(`D. 単一エピソード集中: verdict=${r.verdict} topShare=${r.topEpisodeShare} p=${r.pPlacebo}`);
  console.log(`   → ${r.reason}`);
}
process.exit(0);
