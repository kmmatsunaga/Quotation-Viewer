/**
 * 🔬 週次仮説ラボ — 実行ハーネス
 *
 *   npx tsx scripts/hypothesis-lab.mts week-01.json
 *
 * 仮説を「仕様(JSON)」で書くだけで、毎週20件をコードなしで検定する装置。
 * 結果は BQ `cavka.hypothesis_ledger` に永久記録される (棄却も必ず残す)。
 * 「掘って何も無かった場所の地図」を作ることが、この仕組みの半分の価値。
 *
 * 仕様の書き方 (1件):
 *   {
 *     "id": "sox_up2_semi_lag1",
 *     "title": "前夜SOXが+2%以上 → 半導体業種の翌日",
 *     "family": "macro_lag",
 *     "trigger": "sox >= 2.0",        // 使える変数は下の VARIABLES 参照
 *     "target": "industry:Semiconductor",  // industry:部分一致 / all / ticker:7203
 *     "lagDays": 1,                    // 発火日の何営業日後から
 *     "horizonDays": 1                 // 何営業日ぶん保有するか
 *   }
 *
 * 使える変数 (trigger の中で):
 *   sox, nasdaq, sp500, usdjpy, wti, copper, vix, ust10   … 前夜(米国D日)の変動%
 *   nikkei                                                 … 当日の日経変動%
 *   low60, high60                                          … 当日のbreadth (%)
 *   dow5, sox5, usdjpy5                                    … 直近5営業日の累積変動%
 *   dayOfWeek (1=月..5=金), dayOfMonth, isMonthEnd(0/1)
 */

import { readFileSync, writeFileSync } from "fs";
import { BigQuery } from "@google-cloud/bigquery";
import { evaluate, summarizeWeek, type HypothesisSpec, type DayObservation, type TestResult } from "../src/lib/hypothesis-lab";

const BQ_KEY = "C:/Users/matsunaga/Documents/key/booking-data-388605@appspot.gserviceaccount.com/booking-data-388605-ec9e7af2c0e1.json";
const BQ_PROJECT = "booking-data-388605";
const DATASET = "cavka";
const TABLE = "hypothesis_ledger";
const bq = new BigQuery({ projectId: BQ_PROJECT, keyFilename: BQ_KEY });
const YF = { "User-Agent": "Mozilla/5.0" };
const dstr = (v: { value: string } | string) => (typeof v === "string" ? v : v.value);

// ── 台帳テーブル (冪等) ──
const ds = bq.dataset(DATASET);
const [exists] = await ds.table(TABLE).exists();
if (!exists) {
  await ds.createTable(TABLE, {
    schema: [
      { name: "tested_at", type: "TIMESTAMP", mode: "REQUIRED" },
      { name: "id", type: "STRING", mode: "REQUIRED" },
      { name: "title", type: "STRING" },
      { name: "family", type: "STRING" },
      { name: "source", type: "STRING" },
      { name: "trigger", type: "STRING" },
      { name: "target", type: "STRING" },
      { name: "lag_days", type: "INT64" },
      { name: "horizon_days", type: "INT64" },
      { name: "n_days", type: "INT64" },
      { name: "mean_excess", type: "FLOAT64" },
      { name: "median_excess", type: "FLOAT64" },
      { name: "t_stat", type: "FLOAT64" },
      { name: "win_rate", type: "FLOAT64" },
      { name: "first_half_mean", type: "FLOAT64" },
      { name: "first_half_t", type: "FLOAT64" },
      { name: "second_half_mean", type: "FLOAT64" },
      { name: "second_half_t", type: "FLOAT64" },
      { name: "verdict", type: "STRING" },
      { name: "reason", type: "STRING" },
    ],
  });
  console.log(`✅ 台帳テーブル作成: ${DATASET}.${TABLE}`);
}

// ── 外部指標 (前夜の米国市場など) ──
async function fetchDaily(symbol: string): Promise<Map<string, number>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`;
  const out = new Map<string, number>();
  try {
    const res = await fetch(url, { headers: YF });
    const j = await res.json();
    const r = j?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const q = r?.indicators?.quote?.[0];
    let prev: number | null = null;
    for (let i = 0; i < ts.length; i++) {
      const c = q?.close?.[i];
      if (typeof c !== "number" || !isFinite(c)) continue;
      const key = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      if (prev != null && prev > 0) out.set(key, ((c - prev) / prev) * 100);
      prev = c;
    }
  } catch { /* 取得できない指標は undefined のまま */ }
  return out;
}

console.log("外部指標を取得中…");
const EXT: Record<string, Map<string, number>> = {
  sox: await fetchDaily("^SOX"),
  nasdaq: await fetchDaily("^IXIC"),
  sp500: await fetchDaily("^GSPC"),
  usdjpy: await fetchDaily("JPY=X"),
  wti: await fetchDaily("CL=F"),
  copper: await fetchDaily("HG=F"),
  vix: await fetchDaily("^VIX"),
  ust10: await fetchDaily("^TNX"),
};
console.log(Object.entries(EXT).map(([k, v]) => `${k}:${v.size}`).join(" "));

// ── 業種マップ ──
const [indRows] = await bq.query(`SELECT ticker, industry FROM \`${BQ_PROJECT}.${DATASET}.stock_industry\` WHERE industry IS NOT NULL`);
const industryOf = new Map<string, string>();
for (const r of indRows as { ticker: string; industry: string }[]) industryOf.set(r.ticker, r.industry);

// ── 日次データ (全流動銘柄) ──
console.log("日次データを取得中…");
const [rows] = await bq.query(`
  SELECT FORMAT_DATE('%Y-%m-%d', date) d, ticker, dayChangePct, openToClosePct, close, nikkeiChangePct
  FROM \`${BQ_PROJECT}.${DATASET}.daily_features\`
  WHERE turnover >= 5e7 AND dayChangePct IS NOT NULL
  ORDER BY d`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = any;
const byDate = new Map<string, Map<string, R>>();
const nikkeiOf = new Map<string, number>();
for (const r of rows as R[]) {
  const d = dstr(r.d);
  if (!byDate.has(d)) byDate.set(d, new Map());
  byDate.get(d)!.set(r.ticker, r);
  if (r.nikkeiChangePct != null && !nikkeiOf.has(d)) nikkeiOf.set(d, Number(r.nikkeiChangePct));
}
const dates = Array.from(byDate.keys()).sort();
console.log(`  ${dates.length}営業日 / ${(rows as R[]).length}行`);

// breadth (当日の60日高値・安値割合) は regime_gauge 相当を daily_features から再計算
const [bRows] = await bq.query(`
  SELECT FORMAT_DATE('%Y-%m-%d', date) d,
    ROUND(COUNTIF(isLow60)/COUNT(*)*100,2) low60, ROUND(COUNTIF(isHigh60)/COUNT(*)*100,2) high60
  FROM \`${BQ_PROJECT}.${DATASET}.daily_features\`
  WHERE turnover >= 1e8 GROUP BY d HAVING COUNT(*) >= 300`);
const breadth = new Map<string, { low60: number; high60: number }>();
for (const r of bRows as R[]) breadth.set(dstr(r.d), { low60: Number(r.low60), high60: Number(r.high60) });

// 市場ベースライン (対象群と同じ手続きで計算する超過の基準)
const marketDayRet = new Map<string, number>();
for (const d of dates) {
  const vals: number[] = [];
  for (const [, r] of byDate.get(d)!) { const v = Number(r.dayChangePct); if (isFinite(v)) vals.push(v); }
  if (vals.length >= 300) marketDayRet.set(d, vals.reduce((a, b) => a + b, 0) / vals.length);
}

/** trigger 式で使える変数を、その営業日について組み立てる */
function varsFor(d: string, idx: number): Record<string, number> {
  const prevUs = dates[idx - 1] ?? d; // 前夜の米国市場 = 日本のD日の前営業日(米国日付)
  const cum = (m: Map<string, number>, n: number) => {
    let s = 0;
    for (let k = Math.max(0, idx - n + 1); k <= idx; k++) s += m.get(dates[k]) ?? 0;
    return s;
  };
  const dt = new Date(d + "T00:00:00Z");
  const b = breadth.get(d);
  return {
    sox: EXT.sox.get(prevUs) ?? EXT.sox.get(d) ?? 0,
    nasdaq: EXT.nasdaq.get(prevUs) ?? 0,
    sp500: EXT.sp500.get(prevUs) ?? 0,
    usdjpy: EXT.usdjpy.get(d) ?? 0,
    wti: EXT.wti.get(prevUs) ?? 0,
    copper: EXT.copper.get(prevUs) ?? 0,
    vix: EXT.vix.get(prevUs) ?? 0,
    ust10: EXT.ust10.get(prevUs) ?? 0,
    nikkei: nikkeiOf.get(d) ?? 0,
    low60: b?.low60 ?? 0,
    high60: b?.high60 ?? 0,
    sox5: cum(EXT.sox, 5),
    dow5: cum(EXT.sp500, 5),
    usdjpy5: cum(EXT.usdjpy, 5),
    dayOfWeek: dt.getUTCDay(),
    dayOfMonth: dt.getUTCDate(),
    isMonthEnd: dt.getUTCDate() >= 25 ? 1 : 0,
  };
}

/** target 指定 → その日の対象ticker一覧 */
function targetTickers(target: string, d: string): string[] {
  const day = byDate.get(d);
  if (!day) return [];
  if (target === "all") return Array.from(day.keys());
  if (target.startsWith("ticker:")) return [target.slice(7)];
  if (target.startsWith("industry:")) {
    const pat = target.slice(9).toLowerCase();
    return Array.from(day.keys()).filter((t) => (industryOf.get(t) ?? "").toLowerCase().includes(pat));
  }
  return [];
}

/** 発火日 idx → lag後から horizon 日ぶんの対象群の市場超過 */
function observe(spec: HypothesisSpec, idx: number): number | null {
  const start = idx + spec.lagDays;
  const end = start + spec.horizonDays - 1;
  if (start >= dates.length || end >= dates.length) return null;
  const tickers = targetTickers(spec.target, dates[idx]);
  if (tickers.length < 3) return null;

  const rets: number[] = [];
  for (const t of tickers) {
    let cum = 1;
    let ok = true;
    for (let k = start; k <= end; k++) {
      const r = byDate.get(dates[k])?.get(t);
      if (!r) { ok = false; break; }
      cum *= 1 + Number(r.dayChangePct) / 100;
    }
    if (ok) rets.push((cum - 1) * 100);
  }
  if (rets.length < 3) return null;

  let mkt = 1;
  for (let k = start; k <= end; k++) {
    const m = marketDayRet.get(dates[k]);
    if (m == null) return null;
    mkt *= 1 + m / 100;
  }
  return rets.reduce((a, b) => a + b, 0) / rets.length - (mkt - 1) * 100;
}

/** trigger 式の評価 (安全な限定パーサ: 変数 演算子 数値 の連言のみ) */
function matches(trigger: string, v: Record<string, number>): boolean {
  return trigger.split("&&").every((clause) => {
    const m = clause.trim().match(/^([a-zA-Z][a-zA-Z0-9]*)\s*(>=|<=|>|<|==)\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) throw new Error(`trigger を解釈できません: "${clause.trim()}"`);
    const [, name, op, numStr] = m;
    if (!(name in v)) throw new Error(`未知の変数: ${name}`);
    const x = v[name], y = Number(numStr);
    return op === ">=" ? x >= y : op === "<=" ? x <= y : op === ">" ? x > y : op === "<" ? x < y : x === y;
  });
}

// ── 実行 ──
const DRY = process.argv.includes("--dry");
const specFile = process.argv[2];
if (!specFile) { console.error("使い方: npx tsx scripts/hypothesis-lab.mts <仕様JSON>"); process.exit(1); }
const specs = JSON.parse(readFileSync(specFile, "utf-8")) as HypothesisSpec[];
console.log(`\n仮説 ${specs.length}件を検定します\n`);

const results: TestResult[] = [];
const ledgerRows: Record<string, unknown>[] = [];
const testedAt = new Date().toISOString();

for (const spec of specs) {
  let obs: DayObservation[] = [];
  let err: string | null = null;
  let rawHits = 0;
  // 保有窓が重ならないよう発火を間引く (重複窓は独立サンプルではない)
  const cooldown = spec.cooldownDays ?? spec.horizonDays;
  let lastFire = -Infinity;
  try {
    for (let i = 0; i < dates.length; i++) {
      const v = varsFor(dates[i], i);
      if (!matches(spec.trigger, v)) continue;
      rawHits++;
      if (i - lastFire < cooldown) continue;   // 前の窓とかぶるのでスキップ
      const ex = observe(spec, i);
      if (ex != null && isFinite(ex)) { obs.push({ date: dates[i], excessPct: ex }); lastFire = i; }
    }
  } catch (e) { err = (e as Error).message; obs = []; }

  const res = err
    ? { id: spec.id, nDays: 0, meanExcess: null, medianExcess: null, t: null, winRate: null, firstHalf: null, secondHalf: null, verdict: "insufficient" as const, reason: `仕様エラー: ${err}` }
    : evaluate(spec, obs);
  results.push(res);

  const mark = res.verdict === "candidate" ? "◎" : res.verdict === "exploring" ? "△" : res.verdict === "insufficient" ? "…" : "×";
  const overlap = rawHits > res.nDays ? ` (発火${rawHits}日→独立${res.nDays})` : "";
  console.log(`${mark} ${spec.id.padEnd(28)} ${String(res.nDays).padStart(4)}日 t=${String(res.t ?? "—").padStart(6)} 超過${String(res.meanExcess ?? "—").padStart(8)}%${overlap}  ${spec.title}`);
  if (res.verdict !== "rejected") console.log(`    └ ${res.reason}`);

  ledgerRows.push({
    tested_at: testedAt, id: spec.id, title: spec.title, family: spec.family, source: spec.source ?? null,
    trigger: spec.trigger, target: spec.target, lag_days: spec.lagDays, horizon_days: spec.horizonDays,
    n_days: res.nDays, mean_excess: res.meanExcess, median_excess: res.medianExcess,
    t_stat: res.t, win_rate: res.winRate,
    first_half_mean: res.firstHalf?.mean ?? null, first_half_t: res.firstHalf?.t ?? null,
    second_half_mean: res.secondHalf?.mean ?? null, second_half_t: res.secondHalf?.t ?? null,
    verdict: res.verdict, reason: res.reason,
  });
}

// ── 台帳へ記録 (棄却も必ず残す) ──
if (!DRY) await ds.table(TABLE).insert(ledgerRows);
else console.log("(--dry: 台帳には記録していません)");
const sum = summarizeWeek(results);
console.log(`\n━━━ 今週の結果 ━━━`);
console.log(`  検定 ${sum.total}件 → 棄却 ${sum.rejected} / 探索中 ${sum.exploring} / 候補 ${sum.candidate} / サンプル不足 ${sum.insufficient}`);
console.log(`  ${sum.headline}`);
console.log(`  台帳 ${DATASET}.${TABLE} に ${ledgerRows.length}件を記録しました`);

// Markdown ログも出す (人が読み返す用)
const md = [
  `## ${testedAt.slice(0, 10)} — 検定${sum.total}件 (棄却${sum.rejected}/探索中${sum.exploring}/候補${sum.candidate})`,
  "",
  "| 判定 | ID | 内容 | 発火日数 | t値 | 平均超過 |",
  "|---|---|---|---|---|---|",
  ...results.map((r, i) => {
    const s = specs[i];
    const mark = r.verdict === "candidate" ? "◎候補" : r.verdict === "exploring" ? "△探索中" : r.verdict === "insufficient" ? "…不足" : "×棄却";
    return `| ${mark} | \`${s.id}\` | ${s.title} | ${r.nDays} | ${r.t ?? "—"} | ${r.meanExcess ?? "—"}% |`;
  }),
  "",
].join("\n");
writeFileSync(`docs/HYPOTHESIS_LOG_${testedAt.slice(0, 10)}.md`, md, "utf-8");
console.log(`  docs/HYPOTHESIS_LOG_${testedAt.slice(0, 10)}.md を出力しました`);
