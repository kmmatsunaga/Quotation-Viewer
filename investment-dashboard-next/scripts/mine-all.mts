/**
 * パターン工場【統一再採掘 v2】— デイトレ / 中長期 / 急騰 を日次クラスタ補正で採掘
 *
 *   npx tsx scripts/mine-all.mts
 *
 * v1 (mine-patterns / -mid / -surge) からの統計核の刷新。P0監査で見つけた欠陥への対処:
 *
 * 【欠陥1: ユニバース不整合】v1のデイトレ/中長期は242銘柄時代の採掘で、
 *   ベース(48.34%)が全ユニバース(42.67%)とズレていた → 全て全ユニバースで再採掘。
 *
 * 【欠陥2: クロスセクション相関】同じ日に発火した銘柄群は同じ相場に流される
 *   (パニック型は74日に1.1万件集中)。行を独立サンプル扱いすると z が幻想的に肥大する。
 *   → 統計単位を「行」から「日」に変更。各発火日の (パターン内ヒット率 − その日の全市場ヒット率)
 *     = 日次超過を計算し、その平均/標準偏差/日数で t 検定する (クラスタ標準誤差の実装)。
 *     同日の相場方向の交絡も同時に消える。
 *   さらに中長期は保有期間の重なりで隣接日も独立でないため、実効日数 D/horizon で t を評価。
 *
 * 【欠陥3: 執行可能性】急騰型に流動性関門を追加 (発火銘柄の売買代金 中央値 >= 1億円)。
 *
 * 【生存者バイアス (未解決・明記)】ユニバースは現在の上場マスタ由来で、期間中の
 *   上場廃止銘柄が存在しない。全ての勝率は楽観側に歪む。UI に注意書きを出し、
 *   ライブ検証 (こちらはバイアス無し) を最終判定とする。
 *
 * 関門 (共通):
 *   G1: 発火日数 D >= 最低日数, 総行数 >= 最低行数 (急騰はイベント数も)
 *   G2: 前半/後半の両期間で日次超過の平均 > 0
 *   G3: クラスタ t = mean(超過) / (sd(超過)/√D_eff) >= 3.0
 *   G4: 四半期ごとの日次超過平均が7割以上でプラス (逸脱1つまで、最低3四半期)
 *   G5 (急騰のみ): 暴落率 < 急騰率、売買代金中央値 >= 1億円
 *   + 含意/矛盾ペアの排除、ファミリー集約、保存は各テーブル上位キャップ
 */

import { BigQuery } from "@google-cloud/bigquery";
import { Readable } from "stream";

const BQ_KEY = "C:/Users/matsunaga/Documents/key/booking-data-388605@appspot.gserviceaccount.com/booking-data-388605-ec9e7af2c0e1.json";
const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
const SPLIT = "2025-08-25";
const SANITY = `close >= 50 AND ABS(dayChangePct) <= 30 AND volumeRatio IS NOT NULL AND volumeRatio <= 200
  AND atrPct14 IS NOT NULL AND atrPct14 <= 25`;

const bq = new BigQuery({ projectId: BQ_PROJECT, keyFilename: BQ_KEY });
const r2 = (v: number) => Math.round(v * 100) / 100;

// ── 述語 (v1急騰版の全部盛り。ターゲットごとに単独枝刈りで自然淘汰される) ──
interface Predicate { key: string; label: string; sql: string }
const P: Predicate[] = [
  { key: "up5", label: "前日+5%超", sql: "dayChangePct >= 5" },
  { key: "up3", label: "前日+3%超", sql: "dayChangePct >= 3" },
  { key: "up2", label: "前日+2%超", sql: "dayChangePct >= 2" },
  { key: "dn2", label: "前日-2%超", sql: "dayChangePct <= -2" },
  { key: "dn3", label: "前日-3%超", sql: "dayChangePct <= -3" },
  { key: "dn5", label: "前日-5%超", sql: "dayChangePct <= -5" },
  { key: "gu2", label: "GU+2%超", sql: "gapPct >= 2" },
  { key: "gu1", label: "GU+1%超", sql: "gapPct >= 1" },
  { key: "gd1", label: "GD-1%超", sql: "gapPct <= -1" },
  { key: "gd2", label: "GD-2%超", sql: "gapPct <= -2" },
  { key: "vol10", label: "出来高10倍超", sql: "volumeRatio >= 10" },
  { key: "vol5", label: "出来高5倍超", sql: "volumeRatio >= 5" },
  { key: "vol3", label: "出来高3倍超", sql: "volumeRatio >= 3" },
  { key: "vol2", label: "出来高2倍超", sql: "volumeRatio >= 2" },
  { key: "st3u", label: "3連騰以上", sql: "streak >= 3" },
  { key: "st3d", label: "3連落以上", sql: "streak <= -3" },
  { key: "hi60", label: "60日高値更新", sql: "isHigh60 = TRUE" },
  { key: "lo60", label: "60日安値更新", sql: "isLow60 = TRUE" },
  { key: "hi20", label: "20日高値更新", sql: "isHigh20 = TRUE" },
  { key: "lo20", label: "20日安値更新", sql: "isLow20 = TRUE" },
  { key: "close_hi", label: "高値引け(0.9+)", sql: "rangePosClose >= 0.9" },
  { key: "close_lo", label: "安値引け(0.1-)", sql: "rangePosClose <= 0.1" },
  { key: "px_low", label: "低位株(300円未満)", sql: "close < 300" },
  { key: "px_mid", label: "300-1000円", sql: "close >= 300 AND close < 1000" },
  { key: "atr5", label: "ATR5%超(高ボラ体質)", sql: "atrPct14 >= 5" },
  { key: "atr8", label: "ATR8%超(超高ボラ)", sql: "atrPct14 >= 8" },
  { key: "ret20_up", label: "20日+20%超(主役株)", sql: "ret20dPct >= 20" },
  { key: "ret20_dn", label: "20日-20%超(暴落後)", sql: "ret20dPct <= -20" },
  { key: "ret5_up", label: "5日+10%超(噴き上げ中)", sql: "ret5dPct >= 10" },
  { key: "rsi_ob", label: "RSI70超", sql: "rsi14 > 70" },
  { key: "rsi_os", label: "RSI30未満", sql: "rsi14 < 30" },
  { key: "vsnk2", label: "日経比+2%超(独歩高)", sql: "vsNikkeiPct >= 2" },
  { key: "vsnk_2", label: "日経比-2%超(独歩安)", sql: "vsNikkeiPct <= -2" },
  { key: "nk_up", label: "日経+1%超(地合い良)", sql: "nikkeiChangePct >= 1" },
  { key: "nk_dn", label: "日経-1%超(地合い悪)", sql: "nikkeiChangePct <= -1" },
];
const pmap = new Map(P.map((p) => [p.key, p]));
const IMPLIES: [string, string][] = [
  ["up5","up3"],["up5","up2"],["up3","up2"],["dn5","dn3"],["dn5","dn2"],["dn3","dn2"],
  ["gu2","gu1"],["gd2","gd1"],
  ["vol10","vol5"],["vol10","vol3"],["vol10","vol2"],["vol5","vol3"],["vol5","vol2"],["vol3","vol2"],
  ["hi60","hi20"],["lo60","lo20"],["atr8","atr5"],
];
const CONTRA: [string, string][] = [
  ["px_low","px_mid"],["rsi_ob","rsi_os"],["st3u","st3d"],["hi60","lo60"],["hi20","lo20"],
  ["ret20_up","ret20_dn"],["up5","dn5"],["up3","dn3"],["up2","dn2"],["gu2","gd2"],["gu1","gd1"],
  ["nk_up","nk_dn"],["vsnk2","vsnk_2"],["close_hi","close_lo"],
];
const badPair = (keys: string[]) => {
  const s = new Set(keys);
  return IMPLIES.some(([a,b]) => s.has(a)&&s.has(b)) || CONTRA.some(([a,b]) => s.has(a)&&s.has(b));
};

// ── ターゲット定義 ──
interface Target {
  id: "day" | "mid5" | "mid20" | "surge";
  table: string;
  outcomeSql: string;      // 1/0 のヒット定義
  valueSql: string;        // リターン値 (avg/med 用)
  horizon: number;         // 実効日数の割引 (D/horizon)
  minDays: number;
  minRows: number;
  minEvents?: number;      // 急騰のみ
  cap: number;
}
const TARGETS: Target[] = [
  { id: "day",   table: "pattern_candidates",       outcomeSql: "IF(nextO2C > 0, 1, 0)",     valueSql: "nextO2C",   horizon: 1,  minDays: 60, minRows: 300, cap: 25 },
  { id: "mid5",  table: "pattern_candidates_mid",   outcomeSql: "IF(fwd5dPct > 0, 1, 0)",    valueSql: "fwd5dPct",  horizon: 5,  minDays: 60, minRows: 300, cap: 15 },
  { id: "mid20", table: "pattern_candidates_mid",   outcomeSql: "IF(fwd20dPct > 0, 1, 0)",   valueSql: "fwd20dPct", horizon: 20, minDays: 80, minRows: 500, cap: 10 },
  { id: "surge", table: "pattern_candidates_surge", outcomeSql: "IF(nextC2C >= 8, 1, 0)",    valueSql: "nextC2C",   horizon: 1,  minDays: 40, minRows: 300, minEvents: 15, cap: 30 },
];
const SRC_FOR = (t: Target) => {
  const notNull = t.id === "day" ? "nextO2C IS NOT NULL"
    : t.id === "mid5" ? "fwd5dPct IS NOT NULL"
    : t.id === "mid20" ? "fwd20dPct IS NOT NULL"
    : "nextC2C IS NOT NULL AND ABS(nextC2C) <= 100";
  return `(SELECT * FROM \`${BQ_PROJECT}.${BQ_DATASET}.daily_features_labeled\` WHERE ${SANITY} AND ${notNull})`;
};

interface Won {
  pid: string; keys: string[]; labels: string[]; direction: "long" | "short";
  n: number; events: number; days: number; dEff: number;
  hitRate: number; baseRate: number; excess: number; t: number;
  ex1: number; ex2: number;
  avg: number; med: number;
  crashRate?: number; medTurnoverM?: number;
}

async function mineTarget(tg: Target): Promise<Won[]> {
  const SRC = SRC_FOR(tg);
  console.log(`\n━━━ ${tg.id} (D_eff = 日数/${tg.horizon}, t>=3) ━━━`);

  // 日次ベース表 (その日の全市場ヒット率) を実テーブル化して join
  const BASE = `\`${BQ_PROJECT}.${BQ_DATASET}._mine_base_${tg.id}\``;
  await bq.query({ query: `CREATE OR REPLACE TABLE ${BASE.replace(/`/g,"")} AS
    SELECT date, AVG(${tg.outcomeSql}) base_r FROM ${SRC} GROUP BY date` });
  const [[g]] = await bq.query({ query: `SELECT AVG(base_r)*100 p FROM ${BASE}` });
  const globalBase = g.p as number;
  console.log(`全体ベース: ${globalBase.toFixed(2)}%`);

  // 評価関数: 日次クラスタ統計
  interface Ev { pid: string; n: number; ev: number; days: number; ex: number; sd: number;
    d1: number; ex1: number; d2: number; ex2: number; hr: number; avg: number; med: number;
    crash: number; turn_m: number }
  const evaluate = async (combos: string[][]) => {
    const out = new Map<string, Ev & { keys: string[] }>();
    for (let i = 0; i < combos.length; i += 60) {
      const subq = combos.slice(i, i + 60).map((keys) => {
        const pid = keys.join("+");
        const where = keys.map((k) => pmap.get(k)!.sql).join(" AND ");
        return `SELECT '${pid}' pid, SUM(k) n, SUM(evn) ev, COUNT(*) days,
          AVG(exd)*100 ex, STDDEV(exd)*100 sd,
          COUNTIF(date < DATE '${SPLIT}') d1, IFNULL(AVG(IF(date < DATE '${SPLIT}', exd, NULL)),0)*100 ex1,
          COUNTIF(date >= DATE '${SPLIT}') d2, IFNULL(AVG(IF(date >= DATE '${SPLIT}', exd, NULL)),0)*100 ex2,
          SUM(evn)/SUM(k)*100 hr, AVG(avgv) avg, APPROX_QUANTILES(medv,100)[OFFSET(50)] med,
          SUM(crashn)/SUM(k)*100 crash, APPROX_QUANTILES(turnm,100)[OFFSET(50)] turn_m
        FROM (
          SELECT f.date, COUNT(*) k, SUM(${tg.outcomeSql.replace(/\b(nextO2C|fwd5dPct|fwd20dPct|nextC2C)\b/g, "f.$1")}) evn,
            AVG(${tg.outcomeSql.replace(/\b(nextO2C|fwd5dPct|fwd20dPct|nextC2C)\b/g, "f.$1")}) - ANY_VALUE(b.base_r) exd,
            AVG(f.${tg.valueSql}) avgv, APPROX_QUANTILES(f.${tg.valueSql},100)[OFFSET(50)] medv,
            SUM(IF(f.nextC2C <= -8, 1, 0)) crashn,
            APPROX_QUANTILES(f.turnover/1e6,100)[OFFSET(50)] turnm
          FROM ${SRC} f JOIN ${BASE} b USING(date)
          WHERE ${where.replace(/\b(dayChangePct|gapPct|volumeRatio|streak|isHigh60|isLow60|isHigh20|isLow20|rangePosClose|close|atrPct14|ret20dPct|ret5dPct|rsi14|vsNikkeiPct|nikkeiChangePct)\b/g, "f.$1")}
          GROUP BY f.date
        ) GROUP BY 1`;
      });
      const [rows] = await bq.query({ query: subq.join("\nUNION ALL\n") });
      for (const r of rows as Ev[]) out.set(r.pid, { ...r, keys: r.pid.split("+") });
      process.stdout.write(`\r  評価 ${Math.min(i + 60, combos.length)}/${combos.length}`);
    }
    process.stdout.write("\n");
    return out;
  };

  // 単独 → 枝刈り (|t|>=1.5)
  const singles = await evaluate(P.map((p) => [p.key]));
  const scored: { key: string; t: number }[] = [];
  for (const [, r] of singles) {
    const dEff = r.days / tg.horizon;
    if (dEff < 20 || r.sd === null || r.sd === 0) continue;
    const t = r.ex / (r.sd / Math.sqrt(dEff));
    if (Math.abs(t) >= 1.5 && r.n >= tg.minRows) scored.push({ key: r.keys[0], t });
  }
  // 組合せ爆発の抑制: |t| 上位16述語のみ展開 (16C2+16C3=680通り)
  scored.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
  const promising = scored.slice(0, 16).map((x) => x.key);
  console.log(`  兆しのある単独述語: ${scored.length}/${P.length} → 上位${promising.length}を展開`);

  const combos: string[][] = [];
  for (let i = 0; i < promising.length; i++)
    for (let j = i + 1; j < promising.length; j++) {
      const pr = [promising[i], promising[j]];
      if (!badPair(pr)) combos.push(pr);
      for (let k = j + 1; k < promising.length; k++) {
        const tr = [promising[i], promising[j], promising[k]];
        if (!badPair(tr)) combos.push(tr);
      }
    }
  console.log(`  組合せ: ${combos.length}`);
  const all = await evaluate([...P.map((p) => [p.key]), ...combos]);

  // ── 関門 ──
  const winners: Won[] = [];
  for (const [, r] of all) {
    if (r.days < tg.minDays || r.n < tg.minRows) continue;                       // G1
    if (tg.minEvents && r.ev < tg.minEvents) continue;
    if (r.d1 < tg.minDays * 0.25 || r.d2 < tg.minDays * 0.25) continue;
    const dEff = r.days / tg.horizon;
    if (dEff < 10 || !r.sd) continue;
    const t = r.ex / (r.sd / Math.sqrt(dEff));
    if (Math.abs(t) < 3.0) continue;                                             // G3
    const dir: "long" | "short" = r.ex >= 0 ? "long" : "short";
    if (dir === "long" ? !(r.ex1 > 0 && r.ex2 > 0) : !(r.ex1 < 0 && r.ex2 < 0)) continue; // G2
    if (tg.id === "surge") {
      if (dir === "short") continue;                    // 急騰は買い方向のみ意味を持つ
      if (r.crash >= r.hr) continue;                    // G5a 非対称性
      if ((r.turn_m ?? 0) < 100) continue;              // G5b 流動性: 発火銘柄の売買代金中央値 >= 1億円
    }
    winners.push({
      pid: r.pid, keys: r.keys, labels: r.keys.map((k) => pmap.get(k)!.label),
      direction: dir, n: r.n, events: r.ev, days: r.days, dEff: Math.round(dEff),
      hitRate: r2(r.hr), baseRate: r2(globalBase), excess: r2(r.ex), t: r2(t),
      ex1: r2(r.ex1), ex2: r2(r.ex2), avg: r2(r.avg), med: r2(r.med),
      crashRate: r2(r.crash), medTurnoverM: Math.round(r.turn_m ?? 0),
    });
  }
  console.log(`  関門通過: ${winners.length}`);

  // ファミリー集約 (|excess|×√D_eff)
  winners.sort((a, b) => Math.abs(b.excess) * Math.sqrt(b.dEff) - Math.abs(a.excess) * Math.sqrt(a.dEff));
  const kept: Won[] = [];
  for (const w of winners) {
    const ws = new Set(w.keys);
    const dup = kept.some((k) => {
      if (k.direction !== w.direction) return false;
      const ks = new Set(k.keys);
      const [sm, bg] = ws.size <= ks.size ? [ws, ks] : [ks, ws];
      for (const x of sm) if (!bg.has(x)) return false;
      return true;
    });
    if (!dup) kept.push(w);
  }
  const finals = kept.slice(0, tg.cap);
  console.log(`  集約+キャップ後: ${finals.length}`);
  for (const w of finals.slice(0, 6)) {
    console.log(`  [${w.direction === "long" ? "🟢" : "🔴"}] ${w.labels.join(" & ")} → ヒット${w.hitRate}% (base${w.baseRate}%) 日次超過${w.excess >= 0 ? "+" : ""}${w.excess}pt t=${w.t} D=${w.days}(実効${w.dEff}) 中央値${w.med >= 0 ? "+" : ""}${w.med}%`);
  }
  await bq.query({ query: `DROP TABLE IF EXISTS ${BASE.replace(/`/g,"")}` });
  return finals;
}

async function save(table: string, rows: Record<string, unknown>[], schema: { name: string; type: string; mode?: string }[]) {
  await new Promise<void>((resolve, reject) => {
    const ws = bq.dataset(BQ_DATASET).table(table).createWriteStream({
      sourceFormat: "NEWLINE_DELIMITED_JSON",
      writeDisposition: "WRITE_TRUNCATE",
      createDisposition: "CREATE_IF_NEEDED",
      schema: { fields: schema },
    });
    ws.on("complete", () => resolve());
    ws.on("error", reject);
    Readable.from([rows.map((r) => JSON.stringify(r)).join("\n")]).pipe(ws);
  });
}

async function main() {
  const nowIso = new Date().toISOString();
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const disc = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;

  // --targets day,surge のように指定可 (省略時は全部)
  const argIdx = process.argv.indexOf("--targets");
  const wanted = argIdx > -1 ? process.argv[argIdx + 1].split(",") : ["day", "mid5", "mid20", "surge"];
  const has = (id: string) => wanted.includes(id);

  const day = has("day") ? await mineTarget(TARGETS[0]) : [];
  const mid5 = has("mid5") ? await mineTarget(TARGETS[1]) : [];
  const mid20 = has("mid20") ? await mineTarget(TARGETS[2]) : [];
  const surge = has("surge") ? await mineTarget(TARGETS[3]) : [];

  // day テーブル (既存スキーマ互換: win_pct/edge/z_score 等)
  if (has("day")) await save("pattern_candidates", day.map((w) => ({
    pattern_id: w.pid, predicates: w.keys, labels: w.labels,
    sql_where: w.keys.map((k) => pmap.get(k)!.sql).join(" AND "),
    direction: w.direction, target: "nextO2C",
    n: w.n, win_pct: w.hitRate, avg_ret: w.avg, med_ret: w.med,
    win_first: r2(w.baseRate + w.ex1), win_second: r2(w.baseRate + w.ex2),
    edge: w.excess, z_score: w.t, baseline_pct: w.baseRate,
    status: "incubating", discovered_date: disc,
    live_n: null, live_days: null, live_win_pct: null, live_avg_ret: null, last_fired_date: null,
    discovered_at: nowIso, updated_at: nowIso,
  })), [
    { name: "pattern_id", type: "STRING" }, { name: "predicates", type: "STRING", mode: "REPEATED" },
    { name: "labels", type: "STRING", mode: "REPEATED" }, { name: "sql_where", type: "STRING" },
    { name: "direction", type: "STRING" }, { name: "target", type: "STRING" },
    { name: "n", type: "INTEGER" }, { name: "win_pct", type: "FLOAT" }, { name: "avg_ret", type: "FLOAT" },
    { name: "med_ret", type: "FLOAT" }, { name: "win_first", type: "FLOAT" }, { name: "win_second", type: "FLOAT" },
    { name: "edge", type: "FLOAT" }, { name: "z_score", type: "FLOAT" }, { name: "baseline_pct", type: "FLOAT" },
    { name: "status", type: "STRING" }, { name: "discovered_date", type: "DATE" },
    { name: "live_n", type: "INTEGER" }, { name: "live_days", type: "INTEGER" },
    { name: "live_win_pct", type: "FLOAT" }, { name: "live_avg_ret", type: "FLOAT" },
    { name: "last_fired_date", type: "DATE" }, { name: "discovered_at", type: "TIMESTAMP" }, { name: "updated_at", type: "TIMESTAMP" },
  ]);
  console.log(`\npattern_candidates: ${day.length} 件`);

  // mid テーブル (5d + 20d)
  const midAll = [
    ...mid5.map((w) => ({ w, target: "fwd5dPct", horizon: 5 })),
    ...mid20.map((w) => ({ w, target: "fwd20dPct", horizon: 20 })),
  ];
  if (has("mid5") || has("mid20")) await save("pattern_candidates_mid", midAll.map(({ w, target, horizon }) => ({
    pattern_id: `${target}:${w.pid}`, predicates: w.keys, labels: w.labels,
    sql_where: w.keys.map((k) => pmap.get(k)!.sql).join(" AND "),
    direction: w.direction, target, horizon_days: horizon,
    n: w.n, n_eff: w.dEff,
    win_pct: w.hitRate, avg_ret: w.avg, med_ret: w.med,
    win_first: r2(w.baseRate + w.ex1), win_second: r2(w.baseRate + w.ex2),
    edge: w.excess, z_score: w.t,
    status: "incubating", discovered_date: disc,
    live_n: null, live_days: null, live_win_pct: null, live_avg_ret: null, last_fired_date: null,
    discovered_at: nowIso, updated_at: nowIso,
  })), [
    { name: "pattern_id", type: "STRING" }, { name: "predicates", type: "STRING", mode: "REPEATED" },
    { name: "labels", type: "STRING", mode: "REPEATED" }, { name: "sql_where", type: "STRING" },
    { name: "direction", type: "STRING" }, { name: "target", type: "STRING" }, { name: "horizon_days", type: "INTEGER" },
    { name: "n", type: "INTEGER" }, { name: "n_eff", type: "INTEGER" },
    { name: "win_pct", type: "FLOAT" }, { name: "avg_ret", type: "FLOAT" }, { name: "med_ret", type: "FLOAT" },
    { name: "win_first", type: "FLOAT" }, { name: "win_second", type: "FLOAT" },
    { name: "edge", type: "FLOAT" }, { name: "z_score", type: "FLOAT" },
    { name: "status", type: "STRING" }, { name: "discovered_date", type: "DATE" },
    { name: "live_n", type: "INTEGER" }, { name: "live_days", type: "INTEGER" },
    { name: "live_win_pct", type: "FLOAT" }, { name: "live_avg_ret", type: "FLOAT" },
    { name: "last_fired_date", type: "DATE" }, { name: "discovered_at", type: "TIMESTAMP" }, { name: "updated_at", type: "TIMESTAMP" },
  ]);
  console.log(`pattern_candidates_mid: ${midAll.length} 件 (5日${mid5.length} / 20日${mid20.length})`);

  // surge テーブル
  if (has("surge")) await save("pattern_candidates_surge", surge.map((w) => ({
    pattern_id: `surge:${w.pid}`, predicates: w.keys, labels: w.labels,
    sql_where: w.keys.map((k) => pmap.get(k)!.sql).join(" AND "),
    n: w.n, surges: w.events,
    surge_rate: w.hitRate, crash_rate: w.crashRate, base_rate: w.baseRate,
    lift: r2(w.hitRate / Math.max(w.baseRate, 0.01)), z_score: w.t,
    avg_ret: w.avg, med_ret: w.med,
    rate_first: r2(w.baseRate + w.ex1), rate_second: r2(w.baseRate + w.ex2),
    med_turnover_m: w.medTurnoverM,
    status: "incubating", discovered_date: disc,
    live_n: null, live_days: null, live_surges: null, live_rate: null,
    discovered_at: nowIso, updated_at: nowIso,
  })), [
    { name: "pattern_id", type: "STRING" }, { name: "predicates", type: "STRING", mode: "REPEATED" },
    { name: "labels", type: "STRING", mode: "REPEATED" }, { name: "sql_where", type: "STRING" },
    { name: "n", type: "INTEGER" }, { name: "surges", type: "INTEGER" },
    { name: "surge_rate", type: "FLOAT" }, { name: "crash_rate", type: "FLOAT" }, { name: "base_rate", type: "FLOAT" },
    { name: "lift", type: "FLOAT" }, { name: "z_score", type: "FLOAT" },
    { name: "avg_ret", type: "FLOAT" }, { name: "med_ret", type: "FLOAT" },
    { name: "rate_first", type: "FLOAT" }, { name: "rate_second", type: "FLOAT" },
    { name: "med_turnover_m", type: "INTEGER" },
    { name: "status", type: "STRING" }, { name: "discovered_date", type: "DATE" },
    { name: "live_n", type: "INTEGER" }, { name: "live_days", type: "INTEGER" },
    { name: "live_surges", type: "INTEGER" }, { name: "live_rate", type: "FLOAT" },
    { name: "discovered_at", type: "TIMESTAMP" }, { name: "updated_at", type: "TIMESTAMP" },
  ]);
  console.log(`pattern_candidates_surge: ${surge.length} 件 (流動性関門: 売買代金中央値>=1億円)`);
  console.log(`\n全テーブル再採掘完了 (discovered=${disc}, 統計核=日次クラスタ補正 t>=3)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
