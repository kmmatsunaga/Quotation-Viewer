/**
 * パターン工場 Phase 2 — 採掘エンジン + 統計関門 (ローカル実行専用)
 *
 *   npx tsx scripts/mine-patterns.mts
 *
 * 手順:
 *   1. cavka.daily_features_labeled (翌日リターン付き) を対象に
 *   2. 約30個の述語 (特徴量を閾値で離散化した条件) を定義
 *   3. 単独評価 → 兆しのある述語を選抜 (アプリオリ枝刈り)
 *   4. 選抜述語のペア・トリプルを総当たり評価 (BQ で一括集計)
 *   5. 3つの統計関門を通過したものを cavka.pattern_candidates へ保存
 *
 * 関門:
 *   G1: n >= 50 (最小サンプル)
 *   G2: 期間前半/後半の両方でベースラインと同方向 (時代を超えて再現)
 *   G3: |z| >= 2.0 (ベースライン比の二項検定で有意)
 *
 * 目的変数は nextO2C (翌日の寄り→引け%)。デイトレの「前夜に候補選定 → 翌朝寄り in → 引け out」を想定。
 */

import { BigQuery } from "@google-cloud/bigquery";

const BQ_KEY = "C:/Users/matsunaga/Documents/key/booking-data-388605@appspot.gserviceaccount.com/booking-data-388605-ec9e7af2c0e1.json";
const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
const SRC = `\`${BQ_PROJECT}.${BQ_DATASET}.daily_features_labeled\``;
const SPLIT = "2025-08-25";     // 期間前半/後半の分割点 (データ中央)

const G1_MIN_N = 50;
// 2026-07-13 精度監査で強化: z>=2 は試行 ~2,600 通りに対し偶然でも ~118 件通る (ほぼ無関門)。
// z>=3 なら偶然の期待混入は ~7 件。さらに G4 (四半期安定性) で時期依存の型を落とす。
const G3_MIN_Z = 3.0;
const G4_MIN_QUARTERS = 3;      // 判定可能な四半期 (n>=10) の最低数
const G4_MIN_OK_RATIO = 0.7;    // エッジ同方向の四半期割合
const G4_MAX_MISS = 1;          // 逆方向を許す四半期数

// 論理的含意 (左が成立すれば右も必ず/ほぼ成立)。両方を含む組合せは冗長なので生成しない
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

const bq = new BigQuery({ projectId: BQ_PROJECT, keyFilename: BQ_KEY });

// ── 述語定義: ラベル + SQL 条件片 (すべて "特徴量 IS NOT NULL AND ..." で NULL 安全に) ──
interface Predicate { key: string; label: string; sql: string }
const P: Predicate[] = [
  // 当日騰落
  { key: "up5", label: "前日+5%超", sql: "dayChangePct >= 5" },
  { key: "up3", label: "前日+3%超", sql: "dayChangePct >= 3" },
  { key: "up2", label: "前日+2%超", sql: "dayChangePct >= 2" },
  { key: "dn2", label: "前日-2%超", sql: "dayChangePct <= -2" },
  { key: "dn3", label: "前日-3%超", sql: "dayChangePct <= -3" },
  { key: "dn5", label: "前日-5%超", sql: "dayChangePct <= -5" },
  // ギャップ
  { key: "gu2", label: "GU+2%超", sql: "gapPct >= 2" },
  { key: "gu1", label: "GU+1%超", sql: "gapPct >= 1" },
  { key: "gd1", label: "GD-1%超", sql: "gapPct <= -1" },
  { key: "gd2", label: "GD-2%超", sql: "gapPct <= -2" },
  // 出来高
  { key: "vol3", label: "出来高3倍超", sql: "volumeRatio >= 3" },
  { key: "vol2", label: "出来高2倍超", sql: "volumeRatio >= 2" },
  { key: "vol15", label: "出来高1.5倍超", sql: "volumeRatio >= 1.5" },
  // 連続性
  { key: "st3u", label: "3連騰以上", sql: "streak >= 3" },
  { key: "st3d", label: "3連落以上", sql: "streak <= -3" },
  // 高安更新
  { key: "hi60", label: "60日高値更新", sql: "isHigh60 = TRUE" },
  { key: "lo60", label: "60日安値更新", sql: "isLow60 = TRUE" },
  { key: "hi20", label: "20日高値更新", sql: "isHigh20 = TRUE" },
  { key: "lo20", label: "20日安値更新", sql: "isLow20 = TRUE" },
  // 値位置
  { key: "close_hi", label: "高値引け(0.9+)", sql: "rangePosClose >= 0.9" },
  { key: "close_lo", label: "安値引け(0.1-)", sql: "rangePosClose <= 0.1" },
  // RSI
  { key: "rsi_os", label: "RSI30未満(売られすぎ)", sql: "rsi14 < 30" },
  { key: "rsi_ob", label: "RSI70超(買われすぎ)", sql: "rsi14 > 70" },
  // 相対
  { key: "vsnk2", label: "日経比+2%超(独歩高)", sql: "vsNikkeiPct >= 2" },
  { key: "vsnk_2", label: "日経比-2%超(独歩安)", sql: "vsNikkeiPct <= -2" },
  { key: "vssec2", label: "セクター比+2%超", sql: "vsSectorPct >= 2" },
  { key: "vssec_2", label: "セクター比-2%超", sql: "vsSectorPct <= -2" },
  // ボラ
  { key: "atr_hi", label: "ATR3%超(高ボラ)", sql: "atrPct14 >= 3" },
  // 地合い
  { key: "nk_up", label: "日経+1%超(地合い良)", sql: "nikkeiChangePct >= 1" },
  { key: "nk_dn", label: "日経-1%超(地合い悪)", sql: "nikkeiChangePct <= -1" },
];

const pmap = new Map(P.map((p) => [p.key, p]));

interface EvalRow {
  pid: string; n: number; w: number; avg: number; med: number;
  n1: number; w1: number; n2: number; w2: number;
}

/** 述語キー配列の組を BQ で一括評価 (UNION ALL, バッチ) */
async function evaluate(combos: string[][], baseline: number): Promise<Map<string, EvalRow & { keys: string[] }>> {
  const results = new Map<string, EvalRow & { keys: string[] }>();
  const BATCH = 120;
  for (let i = 0; i < combos.length; i += BATCH) {
    const batch = combos.slice(i, i + BATCH);
    const subqueries = batch.map((keys) => {
      const pid = keys.join("+");
      const where = keys.map((k) => pmap.get(k)!.sql).join(" AND ");
      return `SELECT '${pid}' AS pid,
        COUNT(*) AS n, COUNTIF(nextO2C>0) AS w,
        ROUND(AVG(nextO2C),3) AS avg,
        ROUND(APPROX_QUANTILES(nextO2C,100)[OFFSET(50)],3) AS med,
        COUNTIF(date < DATE '${SPLIT}') AS n1,
        COUNTIF(nextO2C>0 AND date < DATE '${SPLIT}') AS w1,
        COUNTIF(date >= DATE '${SPLIT}') AS n2,
        COUNTIF(nextO2C>0 AND date >= DATE '${SPLIT}') AS w2
      FROM ${SRC} WHERE nextO2C IS NOT NULL AND ${where}`;
    });
    const [rows] = await bq.query({ query: subqueries.join("\nUNION ALL\n") });
    for (const r of rows as EvalRow[]) {
      results.set(r.pid, { ...r, keys: r.pid.split("+") });
    }
    process.stdout.write(`\r  評価 ${Math.min(i + BATCH, combos.length)}/${combos.length}`);
  }
  process.stdout.write("\n");
  return results;
}

/** 二項検定の z 値 (ベースライン p0 に対する勝率 p の乖離) */
function zScore(w: number, n: number, p0: number): number {
  if (n === 0) return 0;
  const p = w / n;
  const se = Math.sqrt((p0 * (1 - p0)) / n);
  return se > 0 ? (p - p0) / se : 0;
}

async function main() {
  // ベースライン
  const [[base]] = await bq.query({
    query: `SELECT ROUND(COUNTIF(nextO2C>0)/COUNT(*),4) AS p0 FROM ${SRC} WHERE nextO2C IS NOT NULL`,
  });
  const p0 = base.p0 as number;
  console.log(`ベースライン (翌日O2C>0): ${(p0 * 100).toFixed(2)}%\n`);

  // ── Step 1: 単独評価 → 枝刈り ──
  console.log("【Step 1】単独述語の評価");
  const singles = await evaluate(P.map((p) => [p.key]), p0);
  const promising: string[] = [];
  for (const [, r] of singles) {
    const z = zScore(r.w, r.n, p0);
    // 兆し (|z|>=1.0) かつ サンプル十分 (n>=100) を組合せ展開の種にする
    if (Math.abs(z) >= 1.0 && r.n >= 100) promising.push(r.keys[0]);
  }
  console.log(`  兆しのある単独述語: ${promising.length}/${P.length} → ${promising.join(", ")}\n`);

  // ── Step 2: ペア + トリプル生成 (枝刈り済み述語のみ、論理的含意ペアは冗長なので生成しない) ──
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
  console.log(`【Step 2】組合せ生成: ペア+トリプル = ${combos.length} 通り (含意冗長は除外済み)`);

  // 単独も候補プールに含める
  const allCombos = [...P.map((p) => [p.key]), ...combos];
  const evalAll = await evaluate(allCombos, p0);

  // ── Step 3: 統計関門 ──
  console.log("\n【Step 3】統計関門");
  interface Winner {
    pid: string; keys: string[]; labels: string[]; direction: "long" | "short";
    n: number; winPct: number; avg: number; med: number; z: number;
    win1: number; win2: number; edge: number;
  }
  const winners: Winner[] = [];
  for (const [, r] of evalAll) {
    if (r.n < G1_MIN_N) continue;                                  // G1
    if (r.n1 < 15 || r.n2 < 15) continue;                          // 各期間最低サンプル
    const z = zScore(r.w, r.n, p0);
    if (Math.abs(z) < G3_MIN_Z) continue;                          // G3
    const win = r.w / r.n, win1 = r.w1 / r.n1, win2 = r.w2 / r.n2;
    const dir: "long" | "short" = win >= p0 ? "long" : "short";
    // G2: 前半・後半ともベースラインと同方向
    const sameDir = dir === "long" ? win1 > p0 && win2 > p0 : win1 < p0 && win2 < p0;
    if (!sameDir) continue;
    winners.push({
      pid: r.pid, keys: r.keys, labels: r.keys.map((k) => pmap.get(k)!.label),
      direction: dir, n: r.n, winPct: Math.round(win * 1000) / 10,
      avg: r.avg, med: r.med, z: Math.round(z * 100) / 100,
      win1: Math.round(win1 * 1000) / 10, win2: Math.round(win2 * 1000) / 10,
      edge: Math.round((win - p0) * 1000) / 10,
    });
  }
  console.log(`  関門通過: ${winners.length} パターン (冗長排除前)`);

  // ── ファミリー集約: 述語集合が入れ子関係 (部分集合/上位集合) の組は冗長。
  //    ロバストネススコア edge×√n が高い代表だけを残し、亜種を落とす。 ──
  const score = (w: Winner) => Math.abs(w.edge) * Math.sqrt(w.n);
  winners.sort((a, b) => score(b) - score(a));
  const kept: Winner[] = [];
  for (const w of winners) {
    const wset = new Set(w.keys);
    const redundant = kept.some((k) => {
      if (k.direction !== w.direction) return false;
      const kset = new Set(k.keys);
      const [small, big] = wset.size <= kset.size ? [wset, kset] : [kset, wset];
      for (const x of small) if (!big.has(x)) return false; // 入れ子でない = 別ファミリー
      return true; // 一方が他方の部分集合 = 同一ファミリーの亜種
    });
    if (!redundant) kept.push(w);
  }
  console.log(`  ファミリー集約後: ${kept.length} パターン`);

  // ── G4: 四半期安定性 (時期依存の型を落とす) ──
  // 各四半期 (n>=10) でベースライン比のエッジが同方向か。
  // 7割以上 & 逆方向は1四半期まで & 判定可能四半期3つ以上。
  const qBase = new Map<string, number>();
  {
    const [qbRows] = await bq.query({
      query: `SELECT FORMAT_DATE('%Y-Q%Q', date) q, COUNTIF(nextO2C>0)/COUNT(*) w
        FROM ${SRC} WHERE nextO2C IS NOT NULL GROUP BY q`,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of qbRows as any[]) qBase.set(r.q, r.w);
  }
  const qStats = new Map<number, { q: string; n: number; w: number }[]>();
  {
    const subs = kept.map((w, i) => {
      const where = w.keys.map((k) => pmap.get(k)!.sql).join(" AND ");
      return `SELECT ${i} idx, FORMAT_DATE('%Y-Q%Q', date) q, COUNT(*) n, COUNTIF(nextO2C>0)/COUNT(*) w
        FROM ${SRC} WHERE nextO2C IS NOT NULL AND ${where} GROUP BY q`;
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
  const finalWinners = kept.filter((w, i) => {
    const qs = (qStats.get(i) ?? []).filter((x) => x.n >= 10 && qBase.has(x.q));
    if (qs.length < G4_MIN_QUARTERS) return false;
    const ok = qs.filter((x) => {
      const e = w.direction === "long" ? x.w - qBase.get(x.q)! : qBase.get(x.q)! - x.w;
      return e > 0;
    }).length;
    return ok / qs.length >= G4_MIN_OK_RATIO && qs.length - ok <= G4_MAX_MISS;
  });
  console.log(`  G4 (四半期安定性) 通過: ${finalWinners.length} パターン\n`);

  console.log("=== 集約後 全パターン (ロバストネス順) ===");
  for (const w of finalWinners.slice(0, 30)) {
    console.log(
      `[${w.direction === "long" ? "🟢買" : "🔴売"}] ${w.labels.join(" & ")}` +
      `\n     n=${w.n} 勝率${w.winPct}% (前${w.win1}/後${w.win2}) edge${w.edge >= 0 ? "+" : ""}${w.edge}pt z=${w.z} 平均${w.avg >= 0 ? "+" : ""}${w.avg}%`,
    );
  }

  // ── Step 4: pattern_candidates へ保存 ──
  const nowIso = new Date().toISOString();
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const discoveredDate = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
  const rows = finalWinners.map((w) => ({
    pattern_id: w.pid,
    predicates: w.keys,
    labels: w.labels,
    sql_where: w.keys.map((k) => pmap.get(k)!.sql).join(" AND "),
    direction: w.direction,
    target: "nextO2C",
    n: w.n, win_pct: w.winPct, avg_ret: w.avg, med_ret: w.med,
    win_first: w.win1, win_second: w.win2, edge: w.edge, z_score: w.z,
    baseline_pct: Math.round(p0 * 1000) / 10,
    status: "incubating",           // 発見直後は検証中。ライブ実績で昇格/退場
    discovered_date: discoveredDate, // この日以降が out-of-sample のライブ検証窓
    live_n: null, live_days: null, live_win_pct: null, live_avg_ret: null, last_fired_date: null,
    discovered_at: nowIso,
    updated_at: nowIso,
  }));

  await bq.dataset(BQ_DATASET).table("pattern_candidates").delete({ ignoreNotFound: true } as never).catch(() => {});
  const { Readable } = await import("stream");
  await new Promise<void>((resolve, reject) => {
    const ws = bq.dataset(BQ_DATASET).table("pattern_candidates").createWriteStream({
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
          { name: "n", type: "INTEGER" },
          { name: "win_pct", type: "FLOAT" },
          { name: "avg_ret", type: "FLOAT" },
          { name: "med_ret", type: "FLOAT" },
          { name: "win_first", type: "FLOAT" },
          { name: "win_second", type: "FLOAT" },
          { name: "edge", type: "FLOAT" },
          { name: "z_score", type: "FLOAT" },
          { name: "baseline_pct", type: "FLOAT" },
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
  console.log(`\npattern_candidates に ${rows.length} 件保存 (status=incubating, discovered=${discoveredDate})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
