/**
 * 🔭 テーマの「明日の兆候」採掘 v2 — 全銘柄・細粒度の業種で再検証
 *
 *   npx tsx scripts/mine-theme-precursors-v2.mts
 *
 * v1 との違い (v1は13仮説すべて棄却されたが、検証自体に欠陥があった):
 *   ① 分類: 手作りテーマ25分類・139銘柄 → Yahoo業種 約150分類・1,900銘柄
 *      (v1では今日の主役キオクシア・ディスコが半導体に入っていなかった)
 *   ② 粒度: 「半導体」ひと括り → 「Semiconductors (チップ)」と
 *      「Semiconductor Equipment (製造装置)」が別分類
 *   ③ 期間: 翌日だけ → 翌日 / 3日先 / 5日先
 *
 * 統計の規律は v1 と同一 (日クラスタ・市場超過・統制群・事前宣言)。
 * 執行: D日の引け後+その夜の米国市場で判断 → D+1 の寄りで買う → N日後の引けで測る
 */

import { BigQuery } from "@google-cloud/bigquery";

const BQ_KEY = "C:/Users/matsunaga/Documents/key/booking-data-388605@appspot.gserviceaccount.com/booking-data-388605-ec9e7af2c0e1.json";
const bq = new BigQuery({ projectId: "booking-data-388605", keyFilename: BQ_KEY });
const YF = { "User-Agent": "Mozilla/5.0" };
const dstr = (v: { value: string } | string) => (typeof v === "string" ? v : v.value);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const MIN_MEMBERS = 4; // 業種として集計する最低銘柄数

// ── 業種マップ ──
const [indRows] = await bq.query(`SELECT ticker, industry FROM \`booking-data-388605.cavka.stock_industry\` WHERE industry IS NOT NULL`);
const industryOf = new Map<string, string>();
for (const r of indRows as { ticker: string; industry: string }[]) industryOf.set(r.ticker, r.industry);
const industries = Array.from(new Set(industryOf.values()));
console.log(`業種マップ: ${industryOf.size}銘柄 / ${industries.length}業種`);

// ── 日次特徴量 (対象銘柄のみ) ──
console.log("BQ取得中…");
const [rows] = await bq.query({
  query: `
    SELECT FORMAT_DATE('%Y-%m-%d', date) d, ticker, dayChangePct, openToClosePct, close, gapPct,
           volumeRatio, turnover, rangePosClose, ret5dPct
    FROM \`booking-data-388605.cavka.daily_features\`
    WHERE ticker IN UNNEST(@t) AND dayChangePct IS NOT NULL
    ORDER BY d`,
  params: { t: Array.from(industryOf.keys()) },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = any;
const byDate = new Map<string, Map<string, R>>();
for (const r of rows as R[]) {
  const d = dstr(r.d);
  if (!byDate.has(d)) byDate.set(d, new Map());
  byDate.get(d)!.set(r.ticker, r);
}
console.log(`  ${(rows as R[]).length}行 / ${byDate.size}営業日`);

// ── 市場ベースライン (N日先の寄→引 累積) ──
const [mktRows] = await bq.query(`
  SELECT FORMAT_DATE('%Y-%m-%d', date) d, AVG(openToClosePct) o2c, AVG(dayChangePct) c2c, COUNT(*) n
  FROM \`booking-data-388605.cavka.daily_features\`
  WHERE turnover >= 1e8 AND openToClosePct IS NOT NULL
  GROUP BY d HAVING n >= 300 ORDER BY d`);
const mktO2C = new Map<string, number>(), mktC2C = new Map<string, number>();
for (const r of mktRows as R[]) { mktO2C.set(dstr(r.d), Number(r.o2c)); mktC2C.set(dstr(r.d), Number(r.c2c)); }

// ── 夜の海外市場 ──
async function fetchDaily(symbol: string): Promise<Map<string, number>> {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`, { headers: YF });
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0];
  const out = new Map<string, number>();
  let prev: number | null = null;
  for (let i = 0; i < ts.length; i++) {
    const c = q?.close?.[i];
    if (typeof c !== "number" || !isFinite(c)) continue;
    const key = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    if (prev != null && prev > 0) out.set(key, ((c - prev) / prev) * 100);
    prev = c;
  }
  return out;
}
const sox = await fetchDaily("^SOX");
const usdjpy = await fetchDaily("JPY=X");
console.log(`海外: SOX ${sox.size}日 / USDJPY ${usdjpy.size}日`);

// ── パネル ──
interface Panel {
  d: string; ind: string; n: number;
  ret: number; breadth: number; rangePos: number | null; turnRatio: number | null;
  streakUp: number; eventCount: number; dispersion: number | null; rank: number; nInd: number;
  fwd: Record<number, number | null>; // 1/3/5日先の超過 (翌日寄り → N日後引け)
}
const dates = Array.from(byDate.keys()).sort().filter((d) => mktO2C.has(d));
const turnHist = new Map<string, number[]>();
const streakMap = new Map<string, number>();
const panels: Panel[] = [];
const HORIZONS = [1, 3, 5];

for (let i = 0; i < dates.length; i++) {
  const d = dates[i];
  const cur = byDate.get(d)!;
  const todays: Panel[] = [];
  // 業種ごとにメンバーを集める
  const members = new Map<string, R[]>();
  for (const [tk, r] of cur) {
    const ind = industryOf.get(tk);
    if (!ind) continue;
    if (!members.has(ind)) members.set(ind, []);
    members.get(ind)!.push(r);
  }

  for (const [ind, ms] of members) {
    const chs = ms.map((m) => Number(m.dayChangePct)).filter((v) => isFinite(v));
    if (chs.length < MIN_MEMBERS) continue;
    const ret = mean(chs)!;
    const prevStreak = streakMap.get(ind) ?? 0;
    const streakUp = ret > 0 ? (prevStreak > 0 ? prevStreak + 1 : 1) : 0;
    streakMap.set(ind, streakUp);

    const turn = ms.reduce((a, m) => a + Number(m.turnover ?? 0), 0);
    const hist = turnHist.get(ind) ?? [];
    const turnRatio = hist.length >= 10 ? turn / mean(hist)! : null;
    hist.push(turn); if (hist.length > 20) hist.shift();
    turnHist.set(ind, hist);

    const r5 = ms.map((m) => Number(m.ret5dPct)).filter((v) => isFinite(v));
    const m5 = mean(r5);
    const dispersion = r5.length >= 3 && m5 != null ? Math.sqrt(r5.reduce((s, v) => s + (v - m5) ** 2, 0) / r5.length) : null;

    // N日先: 翌日の寄り → N日後の引け。市場も同じ手続きで引く
    const tickersOf = ms.map((m) => m.ticker as string);
    const fwd: Record<number, number | null> = {};
    for (const h of HORIZONS) {
      const dNext = dates[i + 1], dEnd = dates[i + h];
      if (!dNext || !dEnd) { fwd[h] = null; continue; }
      const per: number[] = [];
      for (const tk of tickersOf) {
        const rn = byDate.get(dNext)?.get(tk), re = byDate.get(dEnd)?.get(tk);
        if (!rn || !re) continue;
        // 翌日の寄値 = 翌日終値 / (1 + o2c/100) から逆算
        const cn = Number(rn.close), o2c = Number(rn.openToClosePct);
        if (!isFinite(cn) || !isFinite(o2c)) continue;
        const open = cn / (1 + o2c / 100);
        const ce = Number(re.close);
        if (!(open > 0) || !isFinite(ce)) continue;
        per.push(((ce - open) / open) * 100);
      }
      if (per.length < MIN_MEMBERS) { fwd[h] = null; continue; }
      // 市場側: 翌日寄り→N日後引け = 翌日o2c + 以降の c2c の累積
      let mk = mktO2C.get(dNext) ?? null;
      for (let k = 2; k <= h; k++) {
        const dk = dates[i + k];
        const v = dk ? mktC2C.get(dk) ?? null : null;
        if (v == null || mk == null) { mk = null; break; }
        mk += v;
      }
      fwd[h] = mk == null ? null : mean(per)! - mk;
    }

    todays.push({
      d, ind, n: ms.length, ret,
      breadth: chs.filter((v) => v > 0).length / chs.length,
      rangePos: mean(ms.map((m) => Number(m.rangePosClose)).filter((v) => isFinite(v))),
      turnRatio, streakUp,
      eventCount: ms.filter((m) => Math.abs(Number(m.gapPct ?? 0)) >= 5 && Number(m.volumeRatio ?? 0) >= 3).length,
      dispersion, rank: 0, nInd: members.size, fwd,
    });
  }
  todays.sort((a, b) => b.ret - a.ret).forEach((p, k) => (p.rank = k + 1));
  panels.push(...todays);
}
console.log(`パネル: ${panels.length}業種日 (1日あたり平均 ${(panels.length / dates.length).toFixed(0)}業種)\n`);

function tStat(xs: number[]): number | null {
  const n = xs.length; if (n < 5) return null;
  const m = mean(xs)!;
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1));
  return sd > 0 ? m / (sd / Math.sqrt(n)) : null;
}
function test(label: string, cond: (p: Panel) => boolean, h = 1) {
  const usable = panels.filter((p) => p.fwd[h] != null);
  const byDay = new Map<string, { hit: number[]; all: number[] }>();
  for (const p of usable) {
    if (!byDay.has(p.d)) byDay.set(p.d, { hit: [], all: [] });
    const b = byDay.get(p.d)!;
    b.all.push(p.fwd[h]!);
    if (cond(p)) b.hit.push(p.fwd[h]!);
  }
  const cs: number[] = [], es: number[] = [];
  let nCases = 0;
  for (const [, b] of byDay) {
    if (!b.hit.length) continue;
    nCases += b.hit.length;
    cs.push(mean(b.hit)!); es.push(mean(b.hit)! - mean(b.all)!);
  }
  if (cs.length < 20) { console.log(`${label.padEnd(40)} 日数不足`); return; }
  const et = tStat(es), ct = tStat(cs);
  const v = et != null && Math.abs(et) >= 3 ? (et > 0 ? "◎採用" : "◎逆に有意") : et != null && Math.abs(et) >= 2 ? "△探索中" : "－";
  const f = (x: number | null) => (x == null ? "  -  " : `${x >= 0 ? "+" : ""}${x.toFixed(3)}%`).padStart(8);
  console.log(`${label.padEnd(40)} ${String(cs.length).padStart(3)}日 ${String(nCases).padStart(5)}件 ${f(mean(cs))}(t=${ct?.toFixed(2).padStart(5)}) 統制群比${f(mean(es))}(t=${et?.toFixed(2).padStart(5)}) ${v}`);
}

const SEMI = (p: Panel) => p.ind.includes("Semiconductor");
for (const h of HORIZONS) {
  console.log(`\n━━━━━━ ${h}日先 (翌日寄り → ${h}日後引け、市場超過) ━━━━━━`);
  test(`H0 1位業種`, (p) => p.rank === 1, h);
  test(`H0b 上位3業種`, (p) => p.rank <= 3, h);
  test(`H0c 最下位業種`, (p) => p.rank >= p.nInd, h);
  test(`H1a 半導体系 × 前夜SOX +1.5%以上`, (p) => SEMI(p) && (sox.get(p.d) ?? 0) >= 1.5, h);
  test(`H1b 半導体系 × 前夜SOX -1.5%以下`, (p) => SEMI(p) && (sox.get(p.d) ?? 0) <= -1.5, h);
  test(`H1c 全業種 × 前夜SOX +2%以上`, (p) => (sox.get(p.d) ?? 0) >= 2, h);
  test(`H2a 上位3位 × 連騰1日目 (初動)`, (p) => p.rank <= 3 && p.streakUp === 1, h);
  test(`H2b 上位3位 × 連騰3日以上 (既走)`, (p) => p.rank <= 3 && p.streakUp >= 3, h);
  test(`H3a 上位5位 × breadth 80%以上`, (p) => p.rank <= 5 && p.breadth >= 0.8, h);
  test(`H4a 上位5位 × 売買代金1.5倍以上`, (p) => p.rank <= 5 && (p.turnRatio ?? 0) >= 1.5, h);
  test(`H4b 上位5位 × 代金2倍 × breadth70%+`, (p) => p.rank <= 5 && (p.turnRatio ?? 0) >= 2 && p.breadth >= 0.7, h);
  test(`H5a 材料銘柄2本以上`, (p) => p.eventCount >= 2, h);
  test(`H6a 上位5位 × ばらつき大 (出遅れ残)`, (p) => p.rank <= 5 && (p.dispersion ?? 0) > 4, h);
  test(`H7a 上位5位 × 高値引け`, (p) => p.rank <= 5 && (p.rangePos ?? 0) >= 0.7, h);
  test(`H7b 下位5位 × 安値引け`, (p) => p.rank >= p.nInd - 4 && (p.rangePos ?? 1) <= 0.3, h);
}
console.log(`\n(注) |t|>=3 を採用線。${HORIZONS.length}期間×15検定=45検定のため偶然の混入に注意。`);
