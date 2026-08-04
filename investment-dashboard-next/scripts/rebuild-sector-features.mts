/**
 * 🏭 daily_features のセクター相対を、全銘柄業種マップで作り直す
 *
 *   npx tsx scripts/rebuild-sector-features.mts [--dry]
 *
 * 背景 (2026-08-04):
 *   sector 列は jp-themes (25分類・139銘柄) 由来で、実測カバー率は
 *   4,070銘柄中 128銘柄 = 3.1%、vsSectorPct は 430万行中 14.5万行 = 3.4% しかなかった。
 *   つまりパターン工場の「セクター相対」述語は、ほぼ全銘柄で NULL のまま働いていない。
 *
 *   2026-08-04 に構築した stock_industry (1,846銘柄 / 130業種) に差し替える。
 *   Yahoo 由来のため「Semiconductors」と「Semiconductor Equipment & Materials」が
 *   別分類になるなど、粒度も25分類より細かい。
 *
 * Yahoo から再取得せず BQ 内で再計算するので数秒で終わる。
 * 実行前に daily_features_backup_sector を作成する。
 */

import { BigQuery } from "@google-cloud/bigquery";

const BQ_KEY = "C:/Users/matsunaga/Documents/key/booking-data-388605@appspot.gserviceaccount.com/booking-data-388605-ec9e7af2c0e1.json";
const P = "booking-data-388605";
const D = "cavka";
const bq = new BigQuery({ projectId: P, keyFilename: BQ_KEY });
const DRY = process.argv.includes("--dry");

const before = async () => {
  const [r] = await bq.query(`
    SELECT COUNT(*) n, COUNTIF(vsSectorPct IS NOT NULL) has_vssec,
           COUNT(DISTINCT IF(sector IS NOT NULL, ticker, NULL)) tk, COUNT(DISTINCT sector) sec
    FROM \`${P}.${D}.daily_features\``);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (r as any[])[0];
};

console.log("変更前:", JSON.stringify(await before()));
if (DRY) { console.log("(--dry: 変更しません)"); process.exit(0); }

// ── バックアップ ──
await bq.query(`CREATE OR REPLACE TABLE \`${P}.${D}.daily_features_backup_sector\` AS SELECT * FROM \`${P}.${D}.daily_features\``);
console.log("✅ バックアップ: daily_features_backup_sector");

// ── 再構築 ──
// 業種平均は「その日その業種に4銘柄以上」ある場合だけ計算する (少数だと平均が暴れるため)
await bq.query(`
  CREATE OR REPLACE TABLE \`${P}.${D}.daily_features\`
  PARTITION BY date AS
  SELECT
    df.* EXCEPT(sector, sectorChangePct, vsSectorPct),
    si.industry AS sector,
    ROUND(m.mean_chg, 2) AS sectorChangePct,
    IF(m.mean_chg IS NULL OR df.dayChangePct IS NULL, NULL,
       ROUND(df.dayChangePct - m.mean_chg, 2)) AS vsSectorPct
  FROM \`${P}.${D}.daily_features\` df
  LEFT JOIN \`${P}.${D}.stock_industry\` si USING (ticker)
  LEFT JOIN (
    SELECT d2.date, s2.industry, AVG(d2.dayChangePct) AS mean_chg, COUNT(*) AS n
    FROM \`${P}.${D}.daily_features\` d2
    JOIN \`${P}.${D}.stock_industry\` s2 USING (ticker)
    WHERE d2.dayChangePct IS NOT NULL AND s2.industry IS NOT NULL
    GROUP BY d2.date, s2.industry
    HAVING n >= 4
  ) m ON m.date = df.date AND m.industry = si.industry
`);
console.log("✅ セクター相対を再計算しました");

console.log("変更後:", JSON.stringify(await before()));

// サニティ: 同一業種の平均は自分自身を含むので、業種内の vsSectorPct 平均はほぼ0になるはず
const [chk] = await bq.query(`
  SELECT sector, COUNT(*) n, ROUND(AVG(vsSectorPct), 4) avg_vs, ROUND(STDDEV(vsSectorPct), 2) sd
  FROM \`${P}.${D}.daily_features\`
  WHERE sector IS NOT NULL AND vsSectorPct IS NOT NULL
  GROUP BY sector ORDER BY n DESC LIMIT 5`);
console.log("\nサニティ (業種内の平均超過は≒0が正解):");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
for (const r of chk as any[]) console.log(`  ${String(r.sector).padEnd(40)} n=${r.n} 平均${r.avg_vs} σ=${r.sd}`);
process.exit(0);
