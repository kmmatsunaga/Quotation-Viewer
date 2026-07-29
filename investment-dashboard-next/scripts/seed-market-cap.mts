/**
 * 🏗 時価総額基盤の初回シード (ローカル実行)
 *
 *   npx tsx scripts/seed-market-cap.mts
 *
 * 1. BQ cavka.market_cap テーブルを作成 (無ければ。date 日付パーティション)
 * 2. 全上場銘柄 (ETF等除外) の時価総額・発行済株式数を Yahoo から取得
 * 3. 当日パーティションへロード + Firestore meta/market_cap_latest を保存
 * 以後は週次 cron (/api/cron/market-cap, 土曜朝) が同じことをやる。
 */

import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BigQuery } from "@google-cloud/bigquery";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { fetchMarketCapRow, toCapsMap, type MarketCapRow } from "../src/lib/market-cap";

const BQ_KEY = "C:/Users/matsunaga/Documents/key/booking-data-388605@appspot.gserviceaccount.com/booking-data-388605-ec9e7af2c0e1.json";
const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
const TABLE = "market_cap";

let raw = readFileSync("./.env.local", "utf-8").match(/FIREBASE_SERVICE_ACCOUNT_KEY=(.+)/)![1].trim();
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1);
initializeApp({ credential: cert(JSON.parse(raw)) });
const fsdb = getFirestore();
const bq = new BigQuery({ projectId: BQ_PROJECT, keyFilename: BQ_KEY });

// ── 1. テーブル作成 (冪等) ──
const dataset = bq.dataset(BQ_DATASET);
const [exists] = await dataset.table(TABLE).exists();
if (!exists) {
  await dataset.createTable(TABLE, {
    schema: [
      { name: "date", type: "DATE", mode: "REQUIRED" },
      { name: "ticker", type: "STRING", mode: "REQUIRED" },
      { name: "market_cap", type: "FLOAT64" },
      { name: "shares_outstanding", type: "FLOAT64" },
      { name: "close", type: "FLOAT64" },
    ],
    timePartitioning: { type: "DAY", field: "date" },
  });
  console.log(`✅ テーブル作成: ${BQ_DATASET}.${TABLE}`);
} else {
  console.log(`テーブルは既存: ${BQ_DATASET}.${TABLE}`);
}

// ── 2. ユニバース (daily-features backfill と同じ) ──
const EXCLUDE_NAME = /投信|ＥＴＦ|ETF|上場|インデックス|指数|レバレッジ|インバース|ブル|ベア|ダブル|ｉＦ|ＮＦ|iシェア|MAXIS|純金|プラチナ|銀|原油|ガス|穀物|外債|米国債|リート|ETN/i;
const masterDoc = await fsdb.collection("meta").doc("jpStockMaster").get();
const master: { ticker: string; name: string }[] = masterDoc.data()?.stocks ?? [];
const tickers = master
  .filter((s) => /^\d{3,4}[0-9A-Z]?$/.test(s.ticker) && !EXCLUDE_NAME.test(s.name))
  .map((s) => s.ticker);
console.log(`ユニバース: マスタ ${master.length} → ETF等除外後 ${tickers.length} 銘柄`);

const jst = new Date(Date.now() + 9 * 3600 * 1000);
const date = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;

// ── 3. 取得 ──
const rows: MarketCapRow[] = [];
let failed = 0;
const CONCURRENCY = 12;
const t0 = Date.now();
for (let i = 0; i < tickers.length; i += CONCURRENCY) {
  const batch = tickers.slice(i, i + CONCURRENCY);
  const results = await Promise.all(batch.map((t) => fetchMarketCapRow(t, date)));
  for (const r of results) (r ? rows.push(r) : failed++);
  if ((i / CONCURRENCY) % 20 === 0) {
    process.stdout.write(`\r  ${i + batch.length}/${tickers.length} (ok=${rows.length} fail=${failed}) ${Math.round((Date.now() - t0) / 1000)}s`);
  }
}
console.log(`\n取得完了: ok=${rows.length} fail=${failed}`);
if (rows.length < 1000) throw new Error("取得数が少なすぎる — Yahoo 側の失敗の可能性。中断");

// ── 4. BQ ロード (当日パーティション WRITE_TRUNCATE) ──
const tmp = join(tmpdir(), `market_cap_${date}.ndjson`);
writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n"));
await dataset.table(`${TABLE}$${date.replace(/-/g, "")}`).load(tmp, {
  sourceFormat: "NEWLINE_DELIMITED_JSON",
  writeDisposition: "WRITE_TRUNCATE",
});
unlinkSync(tmp);
console.log(`✅ BQ ロード: ${rows.length}行 → ${TABLE}$${date.replace(/-/g, "")}`);

// ── 5. Firestore 最新値 ──
const caps = toCapsMap(rows);
await fsdb.collection("meta").doc("market_cap_latest").set({
  date,
  caps,
  count: rows.length,
  updatedAt: new Date().toISOString(),
});
console.log(`✅ meta/market_cap_latest: ${Object.keys(caps).length}銘柄`);

// サニティ: 大型・小型の例
const sorted = rows.filter((r) => r.market_cap != null).sort((a, b) => b.market_cap! - a.market_cap!);
console.log("  最大:", sorted.slice(0, 3).map((r) => `${r.ticker}=${(r.market_cap! / 1e12).toFixed(1)}兆`).join(" "));
console.log("  最小:", sorted.slice(-3).map((r) => `${r.ticker}=${(r.market_cap! / 1e8).toFixed(1)}億`).join(" "));
