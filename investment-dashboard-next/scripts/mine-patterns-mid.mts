/**
 * パターン工場【中長期版】— 5/20/60営業日先の型を採掘 (ローカル実行専用)
 *
 *   npx tsx scripts/mine-patterns-mid.mts
 *
 * デイトレ版 (mine-patterns.mts) との違い:
 *   - 目的変数: fwd5dPct / fwd20dPct / fwd60dPct (N営業日先の終値リターン)
 *   - 【重要】重複補正: 保有期間が重なる隣接日のサンプルは独立でない
 *     (20日保有なら隣の日と19/20が同じ値動き)。z は実効サンプル数 n/horizon で計算する。
 *     これを怠ると z が √horizon 倍に化けて、偶然の型を大量に「発見」してしまう。
 *   - 保存先: cavka.pattern_candidates_mid (target / horizon_days 列つき)
 *
 * 関門 (デイトレ版と同思想・重複補正済み):
 *   G1: nEff (= n/horizon) >= 30
 *   G2: 期間前半/後半の両方でベースラインと同方向
 *   G3: |z_eff| >= 3.0
 *   G4: 四半期安定性 (判定可能四半期の7割以上で同方向、逆方向1つまで、最低3四半期)
 *   ファミリー集約 + 論理的含意ペアの排除
 *
 * 述語リストはデイトレ版と同一 (スクリプト独立性のため意図的に複製)。
 */

import { BigQuery } from "@google-cloud/bigquery";
import { Readable } from "stream";

const BQ_KEY = "C:/Users/matsunaga/Documents/key/booking-data-388605@appspot.gserviceaccount.com/booking-data-388605-ec9e7af2c0e1.json";
const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
const SRC = `\`${BQ_PROJECT}.${BQ_DATASET}.daily_features_labeled\``;
const SPLIT = "2025-08-25";

const TARGETS: { col: string; horizon: number; label: string }[] = [
  { col: "fwd5dPct", horizon: 5, label: "5営業日後" },
  { col: "fwd20dPct", horizon: 20, label: "20営業日後 (約1ヶ月)" },
  { col: "fwd60dPct", horizon: 60, label: "60営業日後 (約3ヶ月)" },
];

const G1_MIN_NEFF = 30;
const G3_MIN_Z = 3.0;
const G4_MIN_QUARTERS = 3;
const G4_MIN_OK_RATIO = 0.7;
const G4_MAX_MISS = 1;

const bq = new BigQuery({ projectId: BQ_PROJECT, keyFilename: BQ_KEY });

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
  { key: "vol3", label: "出来高3倍超", sql: "volumeRatio >= 3" },
  { key: "vol2", label: "出来高2倍超", sql: "volumeRatio >= 2" },
  { key: "vol15", label: "出来高1.5倍超", sql: "volumeRatio >= 1.5" },
  { key: "st3u", label: "3連騰以上", sql: "streak >= 3" },
  { key: "st3d", label: "3連落以上", sql: "streak <= -3" },
  { key: "hi60", label: "60日高値更新", sql: "isHigh60 = TRUE" },
  { key: "lo60", label: "60日安値更新", sql: "isLow60 = TRUE" },
  { key: "hi20", label: "20日高値更新", sql: "isHigh20 = TRUE" },
  { key: "lo20", label: "20日安値更新", sql: "isLow20 = TRUE" },
  { key: "close_hi", label: "高値引け(0.9+)", sql: "rangePosClose >= 0.9" },
  { key: "close_lo", label: "安値引け(0.1-)", sql: "rangePosClose <= 0.1" },
  { key: "rsi_os", label: "RSI30未満(売られすぎ)", sql: "rsi14 < 30" },
  { key: "rsi_ob", label: "RSI70超(買われすぎ)", sql: "rsi14 > 70" },
  { key: "vsnk2", label: "日経比+2%超(独歩高)", sql: "vsNikkeiPct >= 2" },
  { key: "vsnk_2", label: "日経比-2%超(独歩安)", sql: "vsNikkeiPct <= -2" },
  { key: "vssec2", label: "セクター比+2%超", sql: "vsSectorPct >= 2" },
  { key: "vssec_2", label: "セクター比-2%超", sql: "vsSectorPct <= -2" },
  { key: "atr_hi", label: "ATR3%超(高ボラ)", sql: "atrPct14 >= 3" },
  { key: "nk_up", label: "日経+1%超(地合い良)", sql: "nikkeiChangePct >= 1" },
  { key: "nk_dn", label: "日経-1%超(地合い悪)", sql: "nikkeiChangePct <= -1" },
  // 中長期らしい状態系 (トレンド・水準)
  { key: "ret20_up", label: "20日リターン+10%超", sql: "ret20dPct >= 10" },
  { key: "ret20_dn", label: "20日リターン-10%超", sql: "ret20dPct <= -10" },
  { key: "rsi_mid_hi", label: "RSI55-70(上昇基調)", sql: "rsi14 >= 55 AND rsi14 <= 70" },
  { key: "rsi_mid_lo", label: "RSI30-45(下落基調)", sql: "rsi14 >= 30 AND rsi14 <= 45" },
];
const pmap = new Map(P.map((p) => [p.key, p]));

const IMPLIES: [string, string][] = [
  ["up5", "up3"], ["up5", "up2"], ["up3", "up2"],
  ["dn5", "dn3"], ["dn5", "dn2"], ["dn3", "dn2"],
  ["gu2", "gu1"], ["gd2", "gd1"],
  ["vol3", "vol2"], ["vol3", "vol15"], ["vol2", "vol15"],
  ["hi60", "hi20"], ["lo60", "lo20"],
];
function hasImpliedPair(keys: string[]): boolean {
  const s = new Set(keys);
  return IMPLIES.some(([a, b]) => s.has(a) && s.has(b));
}

/** 重複補正付き z: 実効サンプル数 nEff = n / horizon */
function zScoreEff(w: number, n: number, p0: number, horizon: number): number {
  const nEff = n / horizon;
  if (nEff <= 0) return 0;
  const p = w / n;
  const se = Math.sqrt((p0 * (1 - p0)) / nEff);
  return se > 0 ? (p - p0) / se : 0;
}

interface EvalRow {
  pid: string; n: number; w: number; avg: number; med: number;
  n1: number; w1: number; n2: number; w2: number;
}

async function evaluate(combos: string[][], target: string): Promise<Map<string, EvalRow & { keys: string[] }>> {
  const results = new Map<string, EvalRow & { keys: string[] }>();
  const BATCH = 120;
  for (let i = 0; i < combos.length; i += BATCH) {
    const batch = combos.slice(i, i + BATCH);
    const subqueries = batch.map((keys) => {
      const pid = keys.join("+");
      const where = keys.map((k) => pmap.get(k)!.sql).join(" AND ");
      return `SELECT '${pid}' AS pid,
        COUNT(*) AS n, COUNTIF(${target}>0) AS w,
        ROUND(AVG(${target}),3) AS avg,
        ROUND(APPROX_QUANTILES(${target},100)[OFFSET(50)],3) AS med,
        COUNTIF(date < DATE '${SPLIT}') AS n1,
        COUNTIF(${target}>0 AND date < DATE '${SPLIT}') AS w1,
        COUNTIF(date >= DATE '${SPLIT}') AS n2,
        COUNTIF(${target}>0 AND date >= DATE '${SPLIT}') AS w2
      FROM ${SRC} WHERE ${target} IS NOT NULL AND ${where}`;
    });
    const [rows] = await bq.query({ query: subqueries.join("\nUNION ALL\n") });
    for (const r of rows as EvalRow[]) results.set(r.pid, { ...r, keys: r.pid.split("+") });
    process.stdout.write(`\r  評価 ${Math.min(i + BATCH, combos.length)}/${combos.length}`);
  }
  process.stdout.write("\n");
  return results;
}

interface Winner {
  pid: string; keys: string[]; labels: string[]; direction: "long" | "short";
  n: number; winPct: number; avg: number; med: number; z: number;
  win1: number; win2: number; edge: number;
  target: string; horizon: number;
}

async function mineTarget(target: string, horizon: number, label: string): Promise<Winner[]> {
  console.log(`\n━━━ ${label} (${target}, 重複補正 nEff=n/${horizon}) ━━━`);
  const [[base]] = await bq.query({
    query: `SELECT ROUND(COUNTIF(${target}>0)/COUNT(*),4) AS p0 FROM ${SRC} WHERE ${target} IS NOT NULL`,
  });
  const p0 = base.p0 as number;
  console.log(`ベースライン (${label}に上昇): ${(p0 * 100).toFixed(2)}%`);

  // 単独 → 枝刈り
  const singles = await evaluate(P.map((p) => [p.key]), target);
  const promising: string[] = [];
  for (const [, r] of singles) {
    const z = zScoreEff(r.w, r.n, p0, horizon);
    if (Math.abs(z) >= 1.0 && r.n / horizon >= 20) promising.push(r.keys[0]);
  }
  console.log(`  兆しのある単独述語: ${promising.length}/${P.length}`);

  const combos: string[][] = [];
  for (let i = 0; i < promising.length; i++) {
    for (let j = i + 1; j < promising.length; j++) {
      const pair = [promising[i], promising[j]];
      if (!hasImpliedPair(pair)) combos.push(pair);
      for (let k = j + 1; k < promising.length; k++) {
        const triple = [promising[i], promising[j], promising[k]];
        if (!hasImpliedPair(triple)) combos.push(triple);
      }
    }
  }
  const allCombos = [...P.map((p) => [p.key]), ...combos];
  const evalAll = await evaluate(allCombos, target);

  // 関門
  const winners: Winner[] = [];
  for (const [, r] of evalAll) {
    if (r.n / horizon < G1_MIN_NEFF) continue;                    // G1 (重複補正)
    if (r.n1 / horizon < 8 || r.n2 / horizon < 8) continue;       // 各期間の実効サンプル
    const z = zScoreEff(r.w, r.n, p0, horizon);
    if (Math.abs(z) < G3_MIN_Z) continue;                         // G3 (重複補正)
    const win = r.w / r.n, win1 = r.w1 / r.n1, win2 = r.w2 / r.n2;
    const dir: "long" | "short" = win >= p0 ? "long" : "short";
    const sameDir = dir === "long" ? win1 > p0 && win2 > p0 : win1 < p0 && win2 < p0;
    if (!sameDir) continue;                                       // G2
    winners.push({
      pid: r.pid, keys: r.keys, labels: r.keys.map((k) => pmap.get(k)!.label),
      direction: dir, n: r.n, winPct: Math.round(win * 1000) / 10,
      avg: r.avg, med: r.med, z: Math.round(z * 100) / 100,
      win1: Math.round(win1 * 1000) / 10, win2: Math.round(win2 * 1000) / 10,
      edge: Math.round((win - p0) * 1000) / 10,
      target, horizon,
    });
  }
  console.log(`  関門通過 (G1-G3): ${winners.length}`);

  // ファミリー集約
  const score = (w: Winner) => Math.abs(w.edge) * Math.sqrt(w.n / horizon);
  winners.sort((a, b) => score(b) - score(a));
  const kept: Winner[] = [];
  for (const w of winners) {
    const wset = new Set(w.keys);
    const redundant = kept.some((k) => {
      if (k.direction !== w.direction) return false;
      const kset = new Set(k.keys);
      const [small, big] = wset.size <= kset.size ? [wset, kset] : [kset, wset];
      for (const x of small) if (!big.has(x)) return false;
      return true;
    });
    if (!redundant) kept.push(w);
  }
  console.log(`  ファミリー集約後: ${kept.length}`);

  // G4: 四半期安定性
  const qBase = new Map<string, number>();
  {
    const [qb] = await bq.query({
      query: `SELECT FORMAT_DATE('%Y-Q%Q', date) q, COUNTIF(${target}>0)/COUNT(*) w
        FROM ${SRC} WHERE ${target} IS NOT NULL GROUP BY q`,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of qb as any[]) qBase.set(r.q, r.w);
  }
  const qStats = new Map<number, { q: string; n: number; w: number }[]>();
  if (kept.length > 0) {
    const subs = kept.map((w, i) => {
      const where = w.keys.map((k) => pmap.get(k)!.sql).join(" AND ");
      return `SELECT ${i} idx, FORMAT_DATE('%Y-Q%Q', date) q, COUNT(*) n, COUNTIF(${target}>0)/COUNT(*) w
        FROM ${SRC} WHERE ${target} IS NOT NULL AND ${where} GROUP BY q`;
    });
    const B = 40;
    for (let i = 0; i < subs.length; i += B) {
      const [rows] = await bq.query({ query: subs.slice(i, i + B).join("\nUNION ALL\n") });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const r of rows as any[]) {
        (qStats.get(r.idx) ?? qStats.set(r.idx, []).get(r.idx)!).push({ q: r.q, n: r.n, w: r.w });
      }
    }
  }
  const final = kept.filter((w, i) => {
    const qs = (qStats.get(i) ?? []).filter((x) => x.n / horizon >= 3 && qBase.has(x.q));
    if (qs.length < G4_MIN_QUARTERS) return false;
    const ok = qs.filter((x) => {
      const e = w.direction === "long" ? x.w - qBase.get(x.q)! : qBase.get(x.q)! - x.w;
      return e > 0;
    }).length;
    return ok / qs.length >= G4_MIN_OK_RATIO && qs.length - ok <= G4_MAX_MISS;
  });
  console.log(`  G4 (四半期安定性) 通過: ${final.length}`);
  for (const w of final.slice(0, 8)) {
    console.log(
      `  [${w.direction === "long" ? "🟢買" : "🔴売"}] ${w.labels.join(" & ")}` +
      ` → 勝率${w.winPct}% edge${w.edge >= 0 ? "+" : ""}${w.edge}pt z=${w.z} 平均${w.avg >= 0 ? "+" : ""}${w.avg}% (n=${w.n}/実効${Math.round(w.n / horizon)})`,
    );
  }
  return final;
}

async function main() {
  const all: Winner[] = [];
  for (const t of TARGETS) all.push(...await mineTarget(t.col, t.horizon, t.label));

  const nowIso = new Date().toISOString();
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const discoveredDate = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
  const rows = all.map((w) => ({
    pattern_id: `${w.target}:${w.pid}`,
    predicates: w.keys,
    labels: w.labels,
    sql_where: w.keys.map((k) => pmap.get(k)!.sql).join(" AND "),
    direction: w.direction,
    target: w.target,
    horizon_days: w.horizon,
    n: w.n, n_eff: Math.round(w.n / w.horizon),
    win_pct: w.winPct, avg_ret: w.avg, med_ret: w.med,
    win_first: w.win1, win_second: w.win2, edge: w.edge, z_score: w.z,
    status: "incubating",
    discovered_date: discoveredDate,
    live_n: null, live_days: null, live_win_pct: null, live_avg_ret: null, last_fired_date: null,
    discovered_at: nowIso,
    updated_at: nowIso,
  }));

  await new Promise<void>((resolve, reject) => {
    const ws = bq.dataset(BQ_DATASET).table("pattern_candidates_mid").createWriteStream({
      sourceFormat: "NEWLINE_DELIMITED_JSON",
      writeDisposition: "WRITE_TRUNCATE",
      createDisposition: "CREATE_IF_NEEDED",
      schema: {
        fields: [
          { name: "pattern_id", type: "STRING" },
          { name: "predicates", type: "STRING", mode: "REPEATED" },
          { name: "labels", type: "STRING", mode: "REPEATED" },
          { name: "sql_where", type: "STRING" },
          { name: "direction", type: "STRING" },
          { name: "target", type: "STRING" },
          { name: "horizon_days", type: "INTEGER" },
          { name: "n", type: "INTEGER" },
          { name: "n_eff", type: "INTEGER" },
          { name: "win_pct", type: "FLOAT" },
          { name: "avg_ret", type: "FLOAT" },
          { name: "med_ret", type: "FLOAT" },
          { name: "win_first", type: "FLOAT" },
          { name: "win_second", type: "FLOAT" },
          { name: "edge", type: "FLOAT" },
          { name: "z_score", type: "FLOAT" },
          { name: "status", type: "STRING" },
          { name: "discovered_date", type: "DATE" },
          { name: "live_n", type: "INTEGER" },
          { name: "live_days", type: "INTEGER" },
          { name: "live_win_pct", type: "FLOAT" },
          { name: "live_avg_ret", type: "FLOAT" },
          { name: "last_fired_date", type: "DATE" },
          { name: "discovered_at", type: "TIMESTAMP" },
          { name: "updated_at", type: "TIMESTAMP" },
        ],
      },
    });
    ws.on("complete", () => resolve());
    ws.on("error", reject);
    Readable.from([rows.map((r) => JSON.stringify(r)).join("\n")]).pipe(ws);
  });
  console.log(`\npattern_candidates_mid に ${rows.length} 件保存 (status=incubating, discovered=${discoveredDate})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
