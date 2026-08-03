/**
 * 🔭 テーマの「明日の兆候」採掘 (2年 × 全テーマ)
 *
 *   npx tsx scripts/mine-theme-precursors.mts
 *
 * 問い: 今日の引け後に見える情報だけで、「明日どのテーマが市場を上回るか」を
 *       事前に見分けられるか。(場中に追いかけるのは遅い、と59日検証で判明したため)
 *
 * 執行の現実性:
 *   シグナルは D 日の引け後 + その夜の米国市場までで確定 → D+1 の【寄りで買う】
 *   成果は D+1 の【寄り→引け (openToClosePct)】で測る。前日終値基準にしない。
 *
 * 統計の規律 (パターン工場と同じ):
 *   ・統計単位は「営業日」。同じ日の25テーマは独立でないため、日ごとに平均してから t 検定
 *   ・地合い交絡を消すため、全銘柄 (売買代金1億以上) の同日平均を引いた【超過】で測る
 *   ・統制群 = その日の全テーマ平均。「条件の価値 = 条件付き超過 − 全テーマ超過」
 *   ・仮説は事前宣言のみ (後から探すと必ず自分を騙す)。多重検定を考慮し |t|>=3 を採用線、
 *     2<=|t|<3 は「探索中」として断定しない
 */

import { readFileSync } from "fs";
import { BigQuery } from "@google-cloud/bigquery";
import { ALL_SECTORS } from "../src/lib/jp-themes";

const BQ_KEY = "C:/Users/matsunaga/Documents/key/booking-data-388605@appspot.gserviceaccount.com/booking-data-388605-ec9e7af2c0e1.json";
const bq = new BigQuery({ projectId: "booking-data-388605", keyFilename: BQ_KEY });
const YF = { "User-Agent": "Mozilla/5.0" };

const tickers = Array.from(new Set(ALL_SECTORS.flatMap((s) => s.tickers)));
const dstr = (v: { value: string } | string) => (typeof v === "string" ? v : v.value);

// ── 1. テーマ構成銘柄の2年分 ──
console.log(`BQ取得中: ${tickers.length}銘柄 × 2年…`);
const [rows] = await bq.query({
  query: `
    SELECT FORMAT_DATE('%Y-%m-%d', date) d, ticker, dayChangePct, openToClosePct, gapPct,
           volumeRatio, turnover, streak, rangePosClose, ret5dPct
    FROM \`booking-data-388605.cavka.daily_features\`
    WHERE ticker IN UNNEST(@t) AND dayChangePct IS NOT NULL
    ORDER BY d`,
  params: { t: tickers },
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

// ── 2. 市場ベースライン (売買代金1億以上の全銘柄の寄→引 平均) ──
const [mktRows] = await bq.query(`
  SELECT FORMAT_DATE('%Y-%m-%d', date) d, AVG(openToClosePct) mkt, COUNT(*) n
  FROM \`booking-data-388605.cavka.daily_features\`
  WHERE turnover >= 1e8 AND openToClosePct IS NOT NULL
  GROUP BY d HAVING n >= 300 ORDER BY d`);
const mkt = new Map<string, number>();
for (const r of mktRows as R[]) mkt.set(dstr(r.d), Number(r.mkt));
console.log(`  市場ベースライン: ${mkt.size}営業日`);

// ── 3. 夜の海外市場 (D日の夜 = 米国のD日終値。D+1の寄り前に判明している) ──
async function fetchDaily(symbol: string): Promise<Map<string, number>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`;
  const res = await fetch(url, { headers: YF });
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0];
  const out = new Map<string, number>();
  let prev: number | null = null;
  for (let i = 0; i < ts.length; i++) {
    const c = q?.close?.[i];
    if (typeof c !== "number" || !isFinite(c)) continue;
    const d = new Date(ts[i] * 1000);
    const key = d.toISOString().slice(0, 10);
    if (prev != null && prev > 0) out.set(key, ((c - prev) / prev) * 100);
    prev = c;
  }
  return out;
}
console.log("海外指標を取得中 (SOX / USDJPY)…");
const sox = await fetchDaily("^SOX");
const usdjpy = await fetchDaily("JPY=X");
console.log(`  SOX ${sox.size}日 / USDJPY ${usdjpy.size}日`);

// ── 4. テーマ×日 のパネルを作る ──
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
interface Panel {
  d: string; theme: string;
  ret: number;            // 当日のテーマ平均騰落%
  breadth: number;        // 上昇銘柄比率 0-1
  rangePos: number | null;// 引けの位置 (1=高値引け)
  turnRatio: number | null;// 売買代金 / 直近20日平均
  streakUp: number;       // テーマの連騰日数 (テーマ平均騰落>0が続いた日数)
  eventCount: number;     // |gap|>=5% & 出来高3倍 の銘柄数 (材料発生の代理)
  dispersion: number | null; // メンバーの5日リターンのばらつき (出遅れの残存)
  rank: number;           // その日のテーマ順位 (1=最強)
  nextExcess: number | null; // 翌日の寄→引 − 市場平均
}
const dates = Array.from(byDate.keys()).sort().filter((d) => mkt.has(d));
const turnHist = new Map<string, number[]>();   // theme → 直近の売買代金
const streakMap = new Map<string, number>();    // theme → 連騰日数
const panels: Panel[] = [];

for (let i = 0; i < dates.length; i++) {
  const d = dates[i], next = dates[i + 1] ?? null;
  const cur = byDate.get(d)!;
  const nextRows = next ? byDate.get(next) : null;
  const mktNext = next ? mkt.get(next) ?? null : null;
  const todays: Panel[] = [];

  for (const sec of ALL_SECTORS) {
    const ms = sec.tickers.map((t) => cur.get(t)).filter(Boolean) as R[];
    if (ms.length < 3) continue;
    const chs = ms.map((m) => Number(m.dayChangePct)).filter((v) => isFinite(v));
    if (chs.length < 3) continue;
    const ret = mean(chs)!;

    // 連騰日数
    const prevStreak = streakMap.get(sec.name) ?? 0;
    const streakUp = ret > 0 ? (prevStreak > 0 ? prevStreak + 1 : 1) : 0;
    streakMap.set(sec.name, streakUp);

    // 売買代金の膨らみ
    const turn = ms.map((m) => Number(m.turnover ?? 0)).reduce((a, b) => a + b, 0);
    const hist = turnHist.get(sec.name) ?? [];
    const turnRatio = hist.length >= 10 ? turn / mean(hist)! : null;
    hist.push(turn); if (hist.length > 20) hist.shift();
    turnHist.set(sec.name, hist);

    const r5 = ms.map((m) => Number(m.ret5dPct)).filter((v) => isFinite(v));
    const m5 = mean(r5);
    const dispersion = r5.length >= 3 && m5 != null
      ? Math.sqrt(r5.reduce((s, v) => s + (v - m5) ** 2, 0) / r5.length) : null;

    // 翌日の寄→引 超過
    let nextExcess: number | null = null;
    if (nextRows && mktNext != null) {
      const o2c = sec.tickers.map((t) => nextRows.get(t)).filter(Boolean)
        .map((m: R) => Number(m.openToClosePct)).filter((v) => isFinite(v));
      if (o2c.length >= 3) nextExcess = mean(o2c)! - mktNext;
    }

    todays.push({
      d, theme: sec.name, ret,
      breadth: chs.filter((v) => v > 0).length / chs.length,
      rangePos: mean(ms.map((m) => Number(m.rangePosClose)).filter((v) => isFinite(v))),
      turnRatio, streakUp,
      eventCount: ms.filter((m) => Math.abs(Number(m.gapPct ?? 0)) >= 5 && Number(m.volumeRatio ?? 0) >= 3).length,
      dispersion, rank: 0, nextExcess,
    });
  }
  todays.sort((a, b) => b.ret - a.ret).forEach((p, k) => (p.rank = k + 1));
  panels.push(...todays);
}
const usable = panels.filter((p) => p.nextExcess != null);
console.log(`パネル: ${panels.length}テーマ日 (翌日評価可能 ${usable.length})\n`);

// ── 5. 検定 ──
function tStat(xs: number[]): number | null {
  const n = xs.length; if (n < 5) return null;
  const m = mean(xs)!;
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1));
  return sd > 0 ? m / (sd / Math.sqrt(n)) : null;
}
/** 条件を満たすテーマの翌日超過を、日クラスタで検定。統制群=その日の全テーマ平均 */
function test(label: string, cond: (p: Panel) => boolean) {
  const byDay = new Map<string, { hit: number[]; all: number[] }>();
  for (const p of usable) {
    if (!byDay.has(p.d)) byDay.set(p.d, { hit: [], all: [] });
    const b = byDay.get(p.d)!;
    b.all.push(p.nextExcess!);
    if (cond(p)) b.hit.push(p.nextExcess!);
  }
  const condSeries: number[] = [], edgeSeries: number[] = [];
  let nCases = 0;
  for (const [, b] of byDay) {
    if (b.hit.length === 0) continue;
    nCases += b.hit.length;
    const h = mean(b.hit)!, a = mean(b.all)!;
    condSeries.push(h); edgeSeries.push(h - a);
  }
  const days = condSeries.length;
  if (days < 20) { console.log(`${label.padEnd(38)} 日数不足 (${days}日)`); return; }
  const cm = mean(condSeries)!, em = mean(edgeSeries)!;
  const ct = tStat(condSeries), et = tStat(edgeSeries);
  const verdict = et != null && Math.abs(et) >= 3 ? (et > 0 ? "◎採用線" : "◎逆に有意") : et != null && Math.abs(et) >= 2 ? "△探索中" : "－";
  console.log(
    `${label.padEnd(38)} ${String(days).padStart(3)}日 ${String(nCases).padStart(5)}件  ` +
    `超過${(cm >= 0 ? "+" : "") + cm.toFixed(3)}% (t=${ct?.toFixed(2).padStart(5)})  ` +
    `統制群比${(em >= 0 ? "+" : "") + em.toFixed(3)}% (t=${et?.toFixed(2).padStart(5)})  ${verdict}`,
  );
}

console.log("━━━ 事前宣言した仮説の検定 (翌日の寄→引、市場超過、日クラスタ) ━━━");
console.log("条件                                    日数   件数   条件付き超過        統制群との差        判定");

console.log("\n【基準】");
test("H0 その日の1位テーマ → 翌日", (p) => p.rank === 1);
test("H0b その日の最下位テーマ → 翌日", (p) => p.rank >= 24);

console.log("\n【H1 夜の海外市場】");
const semiThemes = new Set(ALL_SECTORS.filter((s) => s.macroDrivers.includes("semi_cycle_up")).map((s) => s.name));
const yenThemes = new Set(ALL_SECTORS.filter((s) => s.macroDrivers.includes("fx_weak_yen")).map((s) => s.name));
test("H1a 半導体系 × 前夜SOX +1.5%以上", (p) => semiThemes.has(p.theme) && (sox.get(p.d) ?? 0) >= 1.5);
test("H1b 半導体系 × 前夜SOX -1.5%以下", (p) => semiThemes.has(p.theme) && (sox.get(p.d) ?? 0) <= -1.5);
test("H1c 円安系 × 前夜USDJPY +0.5%以上", (p) => yenThemes.has(p.theme) && (usdjpy.get(p.d) ?? 0) >= 0.5);

console.log("\n【H2 連騰日数 (息切れか初動か)】");
test("H2a 上昇テーマ 連騰1日目 (初動)", (p) => p.streakUp === 1);
test("H2b 上昇テーマ 連騰3日以上 (既走)", (p) => p.streakUp >= 3);

console.log("\n【H3 breadth (全面高か1銘柄牽引か)】");
test("H3a 上位5位以内 × breadth 80%以上", (p) => p.rank <= 5 && p.breadth >= 0.8);
test("H3b 上位5位以内 × breadth 50%未満", (p) => p.rank <= 5 && p.breadth < 0.5);

console.log("\n【H4 資金流入 (売買代金の膨らみ)】");
test("H4a 上位5位以内 × 売買代金1.5倍以上", (p) => p.rank <= 5 && (p.turnRatio ?? 0) >= 1.5);

console.log("\n【H5 材料発生 (ギャップ5%+出来高3倍の銘柄)】");
test("H5a テーマ内に材料銘柄1本以上", (p) => p.eventCount >= 1);

console.log("\n【H6 出遅れの残存 (ばらつき)】");
const disp = usable.map((p) => p.dispersion).filter((v): v is number => v != null).sort((a, b) => a - b);
const dHi = disp[Math.floor(disp.length * 0.75)];
test(`H6a 上位5位以内 × ばらつき大 (>${dHi?.toFixed(1)})`, (p) => p.rank <= 5 && (p.dispersion ?? 0) > dHi);

console.log("\n【H7 引けの強さ】");
test("H7a 上位5位以内 × 高値引け (位置0.7+)", (p) => p.rank <= 5 && (p.rangePos ?? 0) >= 0.7);
test("H7b 最下位5位以内 × 安値引け (位置0.3-)", (p) => p.rank >= 21 && (p.rangePos ?? 1) <= 0.3);

console.log("\n(注) |t|>=3 を採用線、2<=|t|<3 は探索中。13検定を回しているため偶然の混入に注意。");
