/**
 * 🔬 週次仮説ラボ — 実行ハーネス v2 (カレンダータイム法)
 *
 *   npx tsx scripts/hypothesis-lab.mts scripts/hypotheses/week-YYYY-MM-DD.json [--dry]
 *
 * 仮説を「仕様(JSON)」で書くだけで、毎週20件をコードなしで検定する装置。
 * 結果は BQ `cavka.hypothesis_ledger` に棄却も含めて永久記録する。
 * 「掘って何も無かった場所の地図」を作ることが、この仕組みの半分の価値。
 *
 * v2 (2026-08-04): イベント単位の窓リターンをやめ、カレンダータイム法へ。
 *   β = mean(日次超過 | シグナル有効日) − mean(| 非有効日)
 *   保有窓の重なりが構造的に消え、全発火を捨てずに使える。
 *   検定は循環シフト・プラセボ + NW-t の合議制 (src/lib/hypothesis-lab-v2.ts)。
 *
 * 仕様の書き方 (1件):
 *   {
 *     "id": "vix10_semi_d10",
 *     "title": "VIX +10%以上急騰 → 半導体の10日",
 *     "family": "internals",
 *     "trigger": "vix >= 10.0",
 *     "target": "industry:Semiconductor",   // industry:部分一致 / ticker:7203 / index:nikkei
 *     "lagDays": 1,
 *     "horizonDays": 10
 *   }
 *
 * 使える変数 (trigger の中で):
 *   sox, nasdaq, sp500, usdjpy, wti, copper, vix, ust10   … 前夜(米国)の変動%
 *   nikkei                                                 … 当日の日経変動%
 *   low60, high60                                          … 当日のbreadth (%)
 *   dow5, sox5, usdjpy5                                    … 直近5営業日の累積変動%
 *   dayOfWeek (0=日..6=土), dayOfMonth, isMonthEnd(0/1)
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BigQuery } from "@google-cloud/bigquery";
import type { HypothesisSpec } from "../src/lib/hypothesis-lab";
import { buildActiveMask, calendarTimeTest, type CalendarTestResult } from "../src/lib/hypothesis-lab-v2";

const BQ_KEY = "C:/Users/matsunaga/Documents/key/booking-data-388605@appspot.gserviceaccount.com/booking-data-388605-ec9e7af2c0e1.json";
const BQ_PROJECT = "booking-data-388605";
const DATASET = "cavka";
const TABLE = "hypothesis_ledger";
const bq = new BigQuery({ projectId: BQ_PROJECT, keyFilename: BQ_KEY });
const YF = { "User-Agent": "Mozilla/5.0" };
const dstr = (v: { value: string } | string) => (typeof v === "string" ? v : v.value);

const DRY = process.argv.includes("--dry");
const specFile = process.argv[2];
if (!specFile) { console.error("使い方: npx tsx scripts/hypothesis-lab.mts <仕様JSON> [--dry]"); process.exit(1); }

// ── 台帳テーブル (冪等) ──
const ds = bq.dataset(DATASET);
const [exists] = await ds.table(TABLE).exists();
if (!exists) {
  await ds.createTable(TABLE, {
    schema: [
      { name: "tested_at", type: "TIMESTAMP", mode: "REQUIRED" },
      { name: "id", type: "STRING", mode: "REQUIRED" },
      { name: "title", type: "STRING" }, { name: "family", type: "STRING" }, { name: "source", type: "STRING" },
      { name: "trigger", type: "STRING" }, { name: "target", type: "STRING" },
      { name: "lag_days", type: "INT64" }, { name: "horizon_days", type: "INT64" },
      { name: "verdict", type: "STRING" }, { name: "reason", type: "STRING" },
      { name: "method", type: "STRING" },
      { name: "beta_daily", type: "FLOAT64" }, { name: "beta_window", type: "FLOAT64" },
      { name: "p_placebo", type: "FLOAT64" }, { name: "t_nw", type: "FLOAT64" },
      { name: "n_active_days", type: "INT64" }, { name: "n_inactive_days", type: "INT64" },
      { name: "n_episodes", type: "INT64" }, { name: "top_episode_share", type: "FLOAT64" },
      { name: "first_half_beta", type: "FLOAT64" }, { name: "second_half_beta", type: "FLOAT64" },
    ],
  });
  console.log(`✅ 台帳テーブル作成: ${DATASET}.${TABLE}`);
} else {
  // v1 で作った台帳に v2 の列を足す (冪等)
  const cols = [
    "method STRING", "beta_daily FLOAT64", "beta_window FLOAT64", "p_placebo FLOAT64", "t_nw FLOAT64",
    "n_active_days INT64", "n_inactive_days INT64", "n_episodes INT64", "top_episode_share FLOAT64",
    "first_half_beta FLOAT64", "second_half_beta FLOAT64",
  ];
  for (const c of cols) {
    try { await bq.query(`ALTER TABLE \`${BQ_PROJECT}.${DATASET}.${TABLE}\` ADD COLUMN IF NOT EXISTS ${c}`); } catch { /* 既存 */ }
  }
}

// ── 外部指標 ──
async function fetchDaily(symbol: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1d`, { headers: YF });
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
  } catch { /* 取れない指標は空のまま */ }
  return out;
}

console.log("外部指標を取得中…");
const EXT: Record<string, Map<string, number>> = {
  sox: await fetchDaily("^SOX"), nasdaq: await fetchDaily("^IXIC"), sp500: await fetchDaily("^GSPC"),
  usdjpy: await fetchDaily("JPY=X"), wti: await fetchDaily("CL=F"), copper: await fetchDaily("HG=F"),
  vix: await fetchDaily("^VIX"), ust10: await fetchDaily("^TNX"),
};
console.log(Object.entries(EXT).map(([k, v]) => `${k}:${v.size}`).join(" "));

// ── 業種マップ ──
const [indRows] = await bq.query(`SELECT ticker, industry FROM \`${BQ_PROJECT}.${DATASET}.stock_industry\` WHERE industry IS NOT NULL`);
const industryOf = new Map<string, string>();
for (const r of indRows as { ticker: string; industry: string }[]) industryOf.set(r.ticker, r.industry);

// ── 日次データ ──
console.log("日次データを取得中…");
const [rows] = await bq.query(`
  SELECT FORMAT_DATE('%Y-%m-%d', date) d, ticker, dayChangePct, nikkeiChangePct
  FROM \`${BQ_PROJECT}.${DATASET}.daily_features\`
  WHERE turnover >= 5e7 AND dayChangePct IS NOT NULL
  ORDER BY d`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = any;
const byDate = new Map<string, Map<string, number>>();
const nikkeiOf = new Map<string, number>();
for (const r of rows as R[]) {
  const d = dstr(r.d);
  if (!byDate.has(d)) byDate.set(d, new Map());
  byDate.get(d)!.set(r.ticker, Number(r.dayChangePct));
  if (r.nikkeiChangePct != null && !nikkeiOf.has(d)) nikkeiOf.set(d, Number(r.nikkeiChangePct));
}
const dates = Array.from(byDate.keys()).sort();
const T = dates.length;
console.log(`  ${T}営業日 / ${(rows as R[]).length}行`);

// breadth (20日/60日の両方)
const [bRows] = await bq.query(`
  SELECT FORMAT_DATE('%Y-%m-%d', date) d,
    ROUND(COUNTIF(isLow60)/COUNT(*)*100,2) low60, ROUND(COUNTIF(isHigh60)/COUNT(*)*100,2) high60,
    ROUND(COUNTIF(isLow20)/COUNT(*)*100,2) low20, ROUND(COUNTIF(isHigh20)/COUNT(*)*100,2) high20
  FROM \`${BQ_PROJECT}.${DATASET}.daily_features\`
  WHERE turnover >= 1e8 GROUP BY d HAVING COUNT(*) >= 300`);
const breadth = new Map<string, { low60: number; high60: number; low20: number; high20: number }>();
for (const r of bRows as R[]) {
  breadth.set(dstr(r.d), { low60: Number(r.low60), high60: Number(r.high60), low20: Number(r.low20), high20: Number(r.high20) });
}

// 日経の水準系 (200日線乖離)。Yahoo から終値を取り直す
const nkClose = new Map<string, number>();
try {
  const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EN225?range=5y&interval=1d", { headers: YF });
  const j = await res.json();
  const rr = j?.chart?.result?.[0];
  const ts: number[] = rr?.timestamp ?? [];
  const cl = rr?.indicators?.quote?.[0]?.close ?? [];
  for (let i = 0; i < ts.length; i++) {
    const c = cl[i];
    if (typeof c === "number" && isFinite(c)) {
      nkClose.set(new Date(ts[i] * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10), c);
    }
  }
} catch { /* 取れなければ nk200 は 0 */ }
const nkSeq = dates.map((d) => nkClose.get(d) ?? null);
/** 日経の200日線からの乖離% (データ不足なら 0) */
function nk200At(idx: number): number {
  if (idx < 200) return 0;
  let s = 0, c = 0;
  for (let k = idx - 199; k <= idx; k++) { const v = nkSeq[k]; if (v != null) { s += v; c++; } }
  const cur = nkSeq[idx];
  if (cur == null || c < 150) return 0;
  const ma = s / c;
  return ((cur - ma) / ma) * 100;
}

/** 業種の日次平均騰落 (市場減算なし) — 業種の位置・相対強さ用 */
const industryMembers = new Map<string, string[]>();
for (const [t, ind] of industryOf) {
  if (!industryMembers.has(ind)) industryMembers.set(ind, []);
  industryMembers.get(ind)!.push(t);
}
function industryDayMean(pat: string, idx: number): number | null {
  const day = byDate.get(dates[idx]);
  if (!day) return null;
  const vals: number[] = [];
  for (const [ind, members] of industryMembers) {
    if (!ind.toLowerCase().includes(pat)) continue;
    for (const t of members) { const v = day.get(t); if (v != null) vals.push(v); }
  }
  return vals.length >= 4 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
/** 業種の累積指数 (等ウェイト) を作り、60日レンジ内の位置 0-100 を返す */
function buildIndustryIndex(pat: string): (number | null)[] {
  const out: (number | null)[] = [];
  let cum = 100;
  for (let i = 0; i < T; i++) {
    const m = industryDayMean(pat, i);
    if (m == null) { out.push(null); continue; }
    cum *= 1 + m / 100;
    out.push(cum);
  }
  return out;
}
const semiIdx = buildIndustryIndex("semiconductor");
const autoIdx = buildIndustryIndex("auto manufacturers");
function rangePos(series: (number | null)[], idx: number, look = 60): number {
  if (idx < look) return 50;
  const win: number[] = [];
  for (let k = idx - look + 1; k <= idx; k++) { const v = series[k]; if (v != null) win.push(v); }
  const cur = series[idx];
  if (cur == null || win.length < look * 0.7) return 50;
  const lo = Math.min(...win), hi = Math.max(...win);
  return hi > lo ? ((cur - lo) / (hi - lo)) * 100 : 50;
}

// 市場の日次平均 (等ウェイト全銘柄) — 業種/銘柄の超過を出す基準
const marketDay: (number | null)[] = dates.map((d) => {
  const m = byDate.get(d)!;
  if (m.size < 300) return null;
  let s = 0;
  for (const v of m.values()) s += v;
  return s / m.size;
});

/** trigger 式で使える変数 */
function varsFor(idx: number): Record<string, number> {
  const d = dates[idx];
  const prevUs = dates[idx - 1] ?? d;
  const cum = (m: Map<string, number>, n: number) => {
    let s = 0;
    for (let k = Math.max(0, idx - n + 1); k <= idx; k++) s += m.get(dates[k]) ?? 0;
    return s;
  };
  const dt = new Date(d + "T00:00:00Z");
  const b = breadth.get(d);
  return {
    sox: EXT.sox.get(prevUs) ?? EXT.sox.get(d) ?? 0,
    nasdaq: EXT.nasdaq.get(prevUs) ?? 0, sp500: EXT.sp500.get(prevUs) ?? 0,
    usdjpy: EXT.usdjpy.get(d) ?? 0, wti: EXT.wti.get(prevUs) ?? 0,
    copper: EXT.copper.get(prevUs) ?? 0, vix: EXT.vix.get(prevUs) ?? 0, ust10: EXT.ust10.get(prevUs) ?? 0,
    nikkei: nikkeiOf.get(d) ?? 0,
    low60: b?.low60 ?? 0, high60: b?.high60 ?? 0,
    low20: b?.low20 ?? 0, high20: b?.high20 ?? 0,
    sox5: cum(EXT.sox, 5), dow5: cum(EXT.sp500, 5), usdjpy5: cum(EXT.usdjpy, 5),
    // 日経の200日線乖離% と その前営業日の値 (上抜け/下抜けの検出用)
    nk200: nk200At(idx), nk200prev: idx > 0 ? nk200At(idx - 1) : 0,
    // 業種の60日レンジ内位置 (0=底, 100=天井)
    semiPos: rangePos(semiIdx, idx), autoPos: rangePos(autoIdx, idx),
    // 半導体の当日の対市場相対 (7/31型「独走」の検出用)
    semiRel: (() => {
      const m = industryDayMean("semiconductor", idx);
      const mk = marketDay[idx];
      return m != null && mk != null ? m - mk : 0;
    })(),
    dayOfWeek: dt.getUTCDay(), dayOfMonth: dt.getUTCDate(), isMonthEnd: dt.getUTCDate() >= 25 ? 1 : 0,
    // SQ週 = 第2金曜を含む週 (月〜金)。第2金曜は 8〜14日の金曜
    isSqWeek: (() => {
      const dow = dt.getUTCDay(), dom = dt.getUTCDate();
      const offsetToFri = 5 - dow;               // その週の金曜の日付
      const friDom = dom + offsetToFri;
      return dow >= 1 && dow <= 5 && friDom >= 8 && friDom <= 14 ? 1 : 0;
    })(),
  };
}

/** trigger 式の評価 (変数 演算子 数値 の連言のみ) */
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

/**
 * target → 日次系列 Y[d]。
 *  industry:X / ticker:X … 市場平均を引いた超過 (統制済み)
 *  index:nikkei          … 日経の日次リターンそのもの (市場減算なし)
 *
 * v2 では A=0 の日が統制群として働くため、業種固有の恒常アルファは
 * β の計算過程で自動的に相殺される (較正テストCで確認済み)。
 */
function buildSeries(target: string): { y: (number | null)[]; note: string } | null {
  if (target === "index:nikkei") {
    return { y: dates.map((d) => nikkeiOf.get(d) ?? null), note: "日経の日次リターン" };
  }
  if (target === "all") return null; // 市場 vs 市場は超過が定義上ゼロ
  if (target.startsWith("ticker:")) {
    const t = target.slice(7);
    return {
      y: dates.map((d, i) => {
        const v = byDate.get(d)?.get(t);
        const m = marketDay[i];
        return v == null || m == null ? null : v - m;
      }),
      note: `${t} の市場超過`,
    };
  }
  if (target.startsWith("industry:")) {
    const pat = target.slice(9).toLowerCase();
    const members = Array.from(industryOf.entries()).filter(([, ind]) => ind.toLowerCase().includes(pat)).map(([t]) => t);
    if (members.length < 4) return null;
    return {
      y: dates.map((d, i) => {
        const day = byDate.get(d)!;
        const vals: number[] = [];
        for (const t of members) { const v = day.get(t); if (v != null) vals.push(v); }
        const m = marketDay[i];
        if (vals.length < 4 || m == null) return null;
        return vals.reduce((a, b) => a + b, 0) / vals.length - m;
      }),
      note: `${members.length}銘柄の平均市場超過`,
    };
  }
  return null;
}

// ── 実行 ──
const specs = JSON.parse(readFileSync(specFile, "utf-8")) as HypothesisSpec[];
console.log(`\n仮説 ${specs.length}件を検定します (カレンダータイム法)\n`);

const testedAt = new Date().toISOString();
const ledgerRows: Record<string, unknown>[] = [];
const results: { spec: HypothesisSpec; res: CalendarTestResult | null; err?: string }[] = [];

for (const spec of specs) {
  const series = buildSeries(spec.target);
  if (!series) {
    const err = spec.target === "all"
      ? "target=all は市場自身との比較になり超過が定義上ゼロ。industry: / ticker: / index:nikkei を使ってください"
      : `target を解釈できません: ${spec.target}`;
    console.log(`× ${spec.id.padEnd(26)} 仕様エラー: ${err}`);
    results.push({ spec, res: null, err });
    ledgerRows.push({
      tested_at: testedAt, id: spec.id, title: spec.title, family: spec.family, source: spec.source ?? null,
      trigger: spec.trigger, target: spec.target, lag_days: spec.lagDays, horizon_days: spec.horizonDays,
      verdict: "insufficient", reason: err, method: "calendar_time_v2",
    });
    continue;
  }

  let fires: number[] = [];
  let err: string | null = null;
  try {
    for (let i = 0; i < T; i++) if (matches(spec.trigger, varsFor(i))) fires.push(i);
  } catch (e) { err = (e as Error).message; fires = []; }

  if (err) {
    console.log(`× ${spec.id.padEnd(26)} 仕様エラー: ${err}`);
    results.push({ spec, res: null, err });
    ledgerRows.push({
      tested_at: testedAt, id: spec.id, title: spec.title, family: spec.family, source: spec.source ?? null,
      trigger: spec.trigger, target: spec.target, lag_days: spec.lagDays, horizon_days: spec.horizonDays,
      verdict: "insufficient", reason: `仕様エラー: ${err}`, method: "calendar_time_v2",
    });
    continue;
  }

  const mask = buildActiveMask(T, fires, spec.lagDays, spec.horizonDays);
  const res = calendarTimeTest(spec.id, series.y, mask, spec.horizonDays);
  results.push({ spec, res });

  const mark = res.verdict === "candidate" ? "◎" : res.verdict === "exploring" ? "△" : res.verdict === "insufficient" ? "…" : "×";
  console.log(
    `${mark} ${spec.id.padEnd(26)} 発火${String(fires.length).padStart(3)}日 有効${String(res.nActive).padStart(3)}日 ` +
    `${String(res.episodes).padStart(2)}ep β=${String(res.betaDaily ?? "—").padStart(6)}%/日 (窓${String(res.betaWindowPct ?? "—").padStart(6)}%) ` +
    `p=${String(res.pPlacebo ?? "—").padStart(6)} t=${String(res.tNW ?? "—").padStart(5)}  ${spec.title}`,
  );
  if (res.verdict !== "rejected") console.log(`    └ ${res.reason}`);

  ledgerRows.push({
    tested_at: testedAt, id: spec.id, title: spec.title, family: spec.family, source: spec.source ?? null,
    trigger: spec.trigger, target: spec.target, lag_days: spec.lagDays, horizon_days: spec.horizonDays,
    verdict: res.verdict, reason: res.reason, method: "calendar_time_v2",
    beta_daily: res.betaDaily, beta_window: res.betaWindowPct,
    p_placebo: res.pPlacebo, t_nw: res.tNW,
    n_active_days: res.nActive, n_inactive_days: res.nInactive,
    n_episodes: res.episodes, top_episode_share: res.topEpisodeShare,
    first_half_beta: res.firstHalf.beta, second_half_beta: res.secondHalf.beta,
  });
}

// ── 台帳 ──
// ストリーミング insert はテーブル作成/スキーマ変更の直後だと伝播前で
// "no such field" になる (2026-08-04 に2回踏んだ)。ロードジョブなら起きない。
if (!DRY) {
  const tmp = join(tmpdir(), `hyp_ledger_${Date.now()}.ndjson`);
  writeFileSync(tmp, ledgerRows.map((r) => JSON.stringify(r)).join("\n"), "utf-8");
  await ds.table(TABLE).load(tmp, { sourceFormat: "NEWLINE_DELIMITED_JSON", writeDisposition: "WRITE_APPEND" });
  unlinkSync(tmp);
  console.log(`  台帳 ${DATASET}.${TABLE} に ${ledgerRows.length}件を記録しました`);
} else {
  console.log("\n(--dry: 台帳には記録していません)");
}

const c = (v: string) => results.filter((r) => (r.res?.verdict ?? "insufficient") === v).length;
console.log(`\n━━━ 今週の結果 ━━━`);
console.log(`  検定 ${results.length}件 → 棄却 ${c("rejected")} / 探索中 ${c("exploring")} / 候補 ${c("candidate")} / 不足 ${c("insufficient")}`);
console.log(c("candidate") > 0
  ? `  候補 ${c("candidate")}件を発見 (4週間の前向き監視へ)`
  : `  採用ゼロ。掘った場所の地図が ${results.length}件ぶん増えました`);

// Markdown ログ
mkdirSync("docs", { recursive: true });
const md = [
  `## ${testedAt.slice(0, 10)} — 検定${results.length}件 (カレンダータイム法)`,
  `棄却${c("rejected")} / 探索中${c("exploring")} / 候補${c("candidate")} / 不足${c("insufficient")}`, "",
  "| 判定 | ID | 内容 | 有効日 | ep | β/日 | 窓% | p | NW-t |",
  "|---|---|---|---|---|---|---|---|---|",
  ...results.map(({ spec, res }) => {
    const v = res?.verdict ?? "insufficient";
    const mark = v === "candidate" ? "◎候補" : v === "exploring" ? "△探索中" : v === "insufficient" ? "…不足" : "×棄却";
    return `| ${mark} | \`${spec.id}\` | ${spec.title} | ${res?.nActive ?? "—"} | ${res?.episodes ?? "—"} | ${res?.betaDaily ?? "—"} | ${res?.betaWindowPct ?? "—"} | ${res?.pPlacebo ?? "—"} | ${res?.tNW ?? "—"} |`;
  }), "",
].join("\n");
writeFileSync(`docs/HYPOTHESIS_LOG_${testedAt.slice(0, 10)}.md`, md, "utf-8");
console.log(`  docs/HYPOTHESIS_LOG_${testedAt.slice(0, 10)}.md を出力しました`);
