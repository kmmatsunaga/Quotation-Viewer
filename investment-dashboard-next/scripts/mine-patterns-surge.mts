/**
 * パターン工場【急騰ハンター】— 翌日+8%急騰の前兆を採掘 (ローカル実行専用)
 *
 *   npx tsx scripts/mine-patterns-surge.mts
 *
 * 目的変数: nextC2C >= +8% (翌日の引け→翌引け急騰)。ベース率 ~1% の稀少イベント。
 *
 * 稀少イベント採掘の統計設計 (ここを外すと「まぐれの前兆」を量産する):
 *   G0 サニティ: 終値>=50円 / |騰落|<=30% / 出来高倍率<=200 / ATR<=25% / |nextC2C|<=100
 *       — 分割未調整などの汚染行を入口で排除 (探索でATR平均363%の汚染を確認済み)
 *   G1 イベント数: n>=300 かつ 急騰>=15件 (前半>=5件・後半>=5件)
 *       — 稀少イベントは n でなくイベント数で最低保証
 *   G2 両期間リフト: 前半・後半とも急騰率がその期間のベース率を超過
 *   G3 比率z検定: z>=3.0
 *   G4 四半期安定: n>=100 の四半期の7割以上でリフト (逸脱1つまで、最低3四半期)
 *   G5 非対称性: 暴落率(nextC2C<=-8%) < 急騰率
 *       — 「上にも下にも飛ぶだけの高ボラ」を前兆と誤認しないガード
 *   + 含意排除 / ファミリー集約 (既存と同じ)
 *
 * 誠実の原則: 最良の前兆でも急騰率は数%。これは「急騰を当てる装置」ではなく
 * 「候補プールを急騰しやすい地形に寄せるバイアス」である。crash率を常時併記する。
 */

import { BigQuery } from "@google-cloud/bigquery";
import { Readable } from "stream";

const BQ_KEY = "C:/Users/matsunaga/Documents/key/booking-data-388605@appspot.gserviceaccount.com/booking-data-388605-ec9e7af2c0e1.json";
const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
const SPLIT = "2025-08-25";

const SURGE = 8;    // 急騰しきい (%)
const CRASH = -8;   // 暴落しきい (%)
const SANITY = `close >= 50 AND ABS(dayChangePct) <= 30 AND volumeRatio IS NOT NULL AND volumeRatio <= 200
  AND atrPct14 IS NOT NULL AND atrPct14 <= 25 AND nextC2C IS NOT NULL AND ABS(nextC2C) <= 100`;
const SRC = `(SELECT * FROM \`${BQ_PROJECT}.${BQ_DATASET}.daily_features_labeled\` WHERE ${SANITY})`;

const bq = new BigQuery({ projectId: BQ_PROJECT, keyFilename: BQ_KEY });

interface Predicate { key: string; label: string; sql: string }
const P: Predicate[] = [
  // 値動き
  { key: "up5", label: "前日+5%超", sql: "dayChangePct >= 5" },
  { key: "up3", label: "前日+3%超", sql: "dayChangePct >= 3" },
  { key: "dn5", label: "前日-5%超", sql: "dayChangePct <= -5" },
  { key: "gu2", label: "GU+2%超", sql: "gapPct >= 2" },
  { key: "gd2", label: "GD-2%超", sql: "gapPct <= -2" },
  // 出来高 (急騰の主戦場なので刻む)
  { key: "vol10", label: "出来高10倍超", sql: "volumeRatio >= 10" },
  { key: "vol5", label: "出来高5倍超", sql: "volumeRatio >= 5" },
  { key: "vol3", label: "出来高3倍超", sql: "volumeRatio >= 3" },
  { key: "vol2", label: "出来高2倍超", sql: "volumeRatio >= 2" },
  // 継続・位置
  { key: "st3u", label: "3連騰以上", sql: "streak >= 3" },
  { key: "st3d", label: "3連落以上", sql: "streak <= -3" },
  { key: "hi60", label: "60日高値更新", sql: "isHigh60 = TRUE" },
  { key: "lo60", label: "60日安値更新", sql: "isLow60 = TRUE" },
  { key: "hi20", label: "20日高値更新", sql: "isHigh20 = TRUE" },
  { key: "close_hi", label: "高値引け(0.9+)", sql: "rangePosClose >= 0.9" },
  { key: "close_lo", label: "安値引け(0.1-)", sql: "rangePosClose <= 0.1" },
  // 水準・体質 (低位・高ボラ = 急騰の地形)
  { key: "px_low", label: "低位株(300円未満)", sql: "close < 300" },
  { key: "px_mid", label: "300-1000円", sql: "close >= 300 AND close < 1000" },
  { key: "atr5", label: "ATR5%超(高ボラ体質)", sql: "atrPct14 >= 5" },
  { key: "atr8", label: "ATR8%超(超高ボラ)", sql: "atrPct14 >= 8" },
  // トレンド
  { key: "ret20_up", label: "20日+20%超(主役株)", sql: "ret20dPct >= 20" },
  { key: "ret20_dn", label: "20日-20%超(暴落後)", sql: "ret20dPct <= -20" },
  { key: "ret5_up", label: "5日+10%超(噴き上げ中)", sql: "ret5dPct >= 10" },
  { key: "rsi_ob", label: "RSI70超", sql: "rsi14 > 70" },
  { key: "rsi_os", label: "RSI30未満", sql: "rsi14 < 30" },
];
const pmap = new Map(P.map((p) => [p.key, p]));

const IMPLIES: [string, string][] = [
  ["vol10", "vol5"], ["vol10", "vol3"], ["vol10", "vol2"],
  ["vol5", "vol3"], ["vol5", "vol2"], ["vol3", "vol2"],
  ["up5", "up3"], ["atr8", "atr5"], ["hi60", "hi20"],
];
function hasImpliedPair(keys: string[]): boolean {
  const s = new Set(keys);
  return IMPLIES.some(([a, b]) => s.has(a) && s.has(b));
}
// 矛盾ペア (同時成立が希薄で無意味な組) も生成しない
const CONTRA: [string, string][] = [
  ["px_low", "px_mid"], ["rsi_ob", "rsi_os"], ["st3u", "st3d"],
  ["hi60", "lo60"], ["ret20_up", "ret20_dn"], ["up5", "dn5"], ["gu2", "gd2"],
];
function hasContraPair(keys: string[]): boolean {
  const s = new Set(keys);
  return CONTRA.some(([a, b]) => s.has(a) && s.has(b));
}

/** 比率の z 検定 (パターン率 vs ベース率) */
function zProp(k: number, n: number, p0: number): number {
  if (n === 0) return 0;
  const p = k / n;
  const se = Math.sqrt((p0 * (1 - p0)) / n);
  return se > 0 ? (p - p0) / se : 0;
}
const r2 = (v: number) => Math.round(v * 100) / 100;

interface EvalRow {
  pid: string; n: number; s: number; c: number;       // n, 急騰数, 暴落数
  avg: number; med: number;
  n1: number; s1: number; n2: number; s2: number;     // 前半/後半
}

async function evaluate(combos: string[][]): Promise<Map<string, EvalRow & { keys: string[] }>> {
  const results = new Map<string, EvalRow & { keys: string[] }>();
  const BATCH = 100;
  for (let i = 0; i < combos.length; i += BATCH) {
    const subq = combos.slice(i, i + BATCH).map((keys) => {
      const pid = keys.join("+");
      const where = keys.map((k) => pmap.get(k)!.sql).join(" AND ");
      return `SELECT '${pid}' pid, COUNT(*) n,
        COUNTIF(nextC2C >= ${SURGE}) s, COUNTIF(nextC2C <= ${CRASH}) c,
        ROUND(AVG(nextC2C),3) avg, ROUND(APPROX_QUANTILES(nextC2C,100)[OFFSET(50)],3) med,
        COUNTIF(date < DATE '${SPLIT}') n1, COUNTIF(nextC2C >= ${SURGE} AND date < DATE '${SPLIT}') s1,
        COUNTIF(date >= DATE '${SPLIT}') n2, COUNTIF(nextC2C >= ${SURGE} AND date >= DATE '${SPLIT}') s2
      FROM ${SRC} WHERE ${where}`;
    });
    const [rows] = await bq.query({ query: subq.join("\nUNION ALL\n") });
    for (const r of rows as EvalRow[]) results.set(r.pid, { ...r, keys: r.pid.split("+") });
    process.stdout.write(`\r  評価 ${Math.min(i + BATCH, combos.length)}/${combos.length}`);
  }
  process.stdout.write("\n");
  return results;
}

async function main() {
  // ベース率 (全体 + 前半/後半)
  const [[base]] = await bq.query({
    query: `SELECT COUNT(*) n, COUNTIF(nextC2C>=${SURGE})/COUNT(*) p0,
      COUNTIF(nextC2C>=${SURGE} AND date < DATE '${SPLIT}')/NULLIF(COUNTIF(date < DATE '${SPLIT}'),0) p1,
      COUNTIF(nextC2C>=${SURGE} AND date >= DATE '${SPLIT}')/NULLIF(COUNTIF(date >= DATE '${SPLIT}'),0) p2
    FROM ${SRC}`,
  });
  const p0 = base.p0 as number, p1 = base.p1 as number, p2 = base.p2 as number;
  console.log(`サニティ後ベース: n=${base.n} 急騰率=${(p0 * 100).toFixed(2)}% (前半${(p1 * 100).toFixed(2)}/後半${(p2 * 100).toFixed(2)})`);

  // 単独 → 枝刈り (z>=1.5 & 急騰10件以上)
  const singles = await evaluate(P.map((p) => [p.key]));
  const promising: string[] = [];
  for (const [, r] of singles) {
    if (r.s >= 10 && zProp(r.s, r.n, p0) >= 1.5) promising.push(r.keys[0]);
  }
  console.log(`兆しのある単独述語: ${promising.length}/${P.length} → ${promising.join(", ")}`);

  const combos: string[][] = [];
  for (let i = 0; i < promising.length; i++)
    for (let j = i + 1; j < promising.length; j++) {
      const pair = [promising[i], promising[j]];
      if (!hasImpliedPair(pair) && !hasContraPair(pair)) combos.push(pair);
      for (let k = j + 1; k < promising.length; k++) {
        const tri = [promising[i], promising[j], promising[k]];
        if (!hasImpliedPair(tri) && !hasContraPair(tri)) combos.push(tri);
      }
    }
  console.log(`組合せ: ${combos.length} 通り`);
  const evalAll = await evaluate([...P.map((p) => [p.key]), ...combos]);

  // ── 関門 ──
  interface Winner {
    pid: string; keys: string[]; labels: string[];
    n: number; surges: number; surgeRate: number; crashRate: number;
    lift: number; z: number; avg: number; med: number;
    rate1: number; rate2: number;
  }
  const winners: Winner[] = [];
  for (const [, r] of evalAll) {
    if (r.n < 300 || r.s < 15 || r.s1 < 5 || r.s2 < 5) continue;         // G1
    const rate = r.s / r.n, rate1 = r.s1 / r.n1, rate2 = r.s2 / r.n2;
    if (!(rate1 > p1 && rate2 > p2)) continue;                           // G2
    const z = zProp(r.s, r.n, p0);
    if (z < 3.0) continue;                                               // G3
    const crashRate = r.c / r.n;
    if (crashRate >= rate) continue;                                     // G5 (非対称性)
    winners.push({
      pid: r.pid, keys: r.keys, labels: r.keys.map((k) => pmap.get(k)!.label),
      n: r.n, surges: r.s, surgeRate: r2(rate * 100), crashRate: r2(crashRate * 100),
      lift: r2(rate / p0), z: r2(z), avg: r.avg, med: r.med,
      rate1: r2(rate1 * 100), rate2: r2(rate2 * 100),
    });
  }
  console.log(`関門 G1-G3,G5 通過: ${winners.length}`);

  // ファミリー集約 (リフト×√急騰数 で代表選出)
  winners.sort((a, b) => b.lift * Math.sqrt(b.surges) - a.lift * Math.sqrt(a.surges));
  const kept: Winner[] = [];
  for (const w of winners) {
    const ws = new Set(w.keys);
    const dup = kept.some((k) => {
      const ks = new Set(k.keys);
      const [sm, bg] = ws.size <= ks.size ? [ws, ks] : [ks, ws];
      for (const x of sm) if (!bg.has(x)) return false;
      return true;
    });
    if (!dup) kept.push(w);
  }
  console.log(`ファミリー集約後: ${kept.length}`);

  // G4: 四半期安定
  const qb = new Map<string, number>();
  {
    const [rows] = await bq.query({
      query: `SELECT FORMAT_DATE('%Y-Q%Q', date) q, COUNTIF(nextC2C>=${SURGE})/COUNT(*) p FROM ${SRC} GROUP BY q`,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of rows as any[]) qb.set(r.q, r.p);
  }
  const qs = new Map<number, { q: string; n: number; p: number }[]>();
  if (kept.length > 0) {
    const subs = kept.map((w, i) => {
      const where = w.keys.map((k) => pmap.get(k)!.sql).join(" AND ");
      return `SELECT ${i} idx, FORMAT_DATE('%Y-Q%Q', date) q, COUNT(*) n, COUNTIF(nextC2C>=${SURGE})/COUNT(*) p
        FROM ${SRC} WHERE ${where} GROUP BY q`;
    });
    for (let i = 0; i < subs.length; i += 40) {
      const [rows] = await bq.query({ query: subs.slice(i, i + 40).join("\nUNION ALL\n") });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const r of rows as any[]) (qs.get(r.idx) ?? qs.set(r.idx, []).get(r.idx)!).push(r);
    }
  }
  let finals = kept.filter((w, i) => {
    const rows = (qs.get(i) ?? []).filter((x) => x.n >= 100 && qb.has(x.q));
    if (rows.length < 3) return false;
    const ok = rows.filter((x) => x.p > qb.get(x.q)!).length;
    return ok / rows.length >= 0.7 && rows.length - ok <= 1;
  });
  console.log(`G4 (四半期安定) 通過: ${finals.length}`);
  // 全銘柄ユニバースでは z が巨大化し大量通過するため、運用上の上限を設ける
  // (ライブ検証・UI・候補バイアスで扱える数に。ランクはロバストネス順を維持)
  const CAP = 50;
  if (finals.length > CAP) {
    finals = finals.slice(0, CAP);
    console.log(`上位 ${CAP} に制限 (ロバストネス = lift×√急騰数 順)`);
  }
  console.log("");
  for (const w of finals) {
    console.log(`🚀 ${w.labels.join(" & ")}`);
    console.log(`   急騰率 ${w.surgeRate}% (ベース比${w.lift}x) / 暴落率 ${w.crashRate}% / n=${w.n} 急騰${w.surges}件 z=${w.z} 前${w.rate1}%/後${w.rate2}% 翌日中央値${w.med >= 0 ? "+" : ""}${w.med}%`);
  }

  // 保存
  const nowIso = new Date().toISOString();
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const disc = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
  const rows = finals.map((w) => ({
    pattern_id: `surge:${w.pid}`,
    predicates: w.keys, labels: w.labels,
    sql_where: w.keys.map((k) => pmap.get(k)!.sql).join(" AND "),
    n: w.n, surges: w.surges,
    surge_rate: w.surgeRate, crash_rate: w.crashRate, base_rate: r2(p0 * 100),
    lift: w.lift, z_score: w.z, avg_ret: w.avg, med_ret: w.med,
    rate_first: w.rate1, rate_second: w.rate2,
    status: "incubating", discovered_date: disc,
    live_n: null, live_days: null, live_surges: null, live_rate: null,
    discovered_at: nowIso, updated_at: nowIso,
  }));
  await new Promise<void>((resolve, reject) => {
    const ws = bq.dataset(BQ_DATASET).table("pattern_candidates_surge").createWriteStream({
      sourceFormat: "NEWLINE_DELIMITED_JSON",
      writeDisposition: "WRITE_TRUNCATE",
      createDisposition: "CREATE_IF_NEEDED",
      schema: {
        fields: [
          { name: "pattern_id", type: "STRING" },
          { name: "predicates", type: "STRING", mode: "REPEATED" },
          { name: "labels", type: "STRING", mode: "REPEATED" },
          { name: "sql_where", type: "STRING" },
          { name: "n", type: "INTEGER" },
          { name: "surges", type: "INTEGER" },
          { name: "surge_rate", type: "FLOAT" },
          { name: "crash_rate", type: "FLOAT" },
          { name: "base_rate", type: "FLOAT" },
          { name: "lift", type: "FLOAT" },
          { name: "z_score", type: "FLOAT" },
          { name: "avg_ret", type: "FLOAT" },
          { name: "med_ret", type: "FLOAT" },
          { name: "rate_first", type: "FLOAT" },
          { name: "rate_second", type: "FLOAT" },
          { name: "status", type: "STRING" },
          { name: "discovered_date", type: "DATE" },
          { name: "live_n", type: "INTEGER" },
          { name: "live_days", type: "INTEGER" },
          { name: "live_surges", type: "INTEGER" },
          { name: "live_rate", type: "FLOAT" },
          { name: "discovered_at", type: "TIMESTAMP" },
          { name: "updated_at", type: "TIMESTAMP" },
        ],
      },
    });
    ws.on("complete", () => resolve());
    ws.on("error", reject);
    Readable.from([rows.map((r) => JSON.stringify(r)).join("\n")]).pipe(ws);
  });
  console.log(`\npattern_candidates_surge に ${rows.length} 件保存 (status=incubating, discovered=${disc})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
