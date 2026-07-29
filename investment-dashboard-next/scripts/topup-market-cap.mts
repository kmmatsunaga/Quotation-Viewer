/**
 * 🏗 時価総額シードの追補 (レート制限で欠けた銘柄だけを低速で再取得)
 *
 *   npx tsx scripts/topup-market-cap.mts
 *
 * BQ の当日パーティションに既にある銘柄を除き、残りを低い並列度+リトライで取得。
 * 当日パーティションへ WRITE_APPEND、Firestore caps はマージ。何度でも再実行可。
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

const jst = new Date(Date.now() + 9 * 3600 * 1000);
const date = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;

// 既取得の銘柄
const [got] = await bq.query(`SELECT ticker FROM \`${BQ_PROJECT}.${BQ_DATASET}.${TABLE}\` WHERE date = '${date}'`);
const have = new Set((got as { ticker: string }[]).map((r) => r.ticker));

// ユニバース
const EXCLUDE_NAME = /投信|ＥＴＦ|ETF|上場|インデックス|指数|レバレッジ|インバース|ブル|ベア|ダブル|ｉＦ|ＮＦ|iシェア|MAXIS|純金|プラチナ|銀|原油|ガス|穀物|外債|米国債|リート|ETN/i;
const masterDoc = await fsdb.collection("meta").doc("jpStockMaster").get();
const master: { ticker: string; name: string }[] = masterDoc.data()?.stocks ?? [];
const missing = master
  .filter((s) => /^\d{3,4}[0-9A-Z]?$/.test(s.ticker) && !EXCLUDE_NAME.test(s.name) && !have.has(s.ticker))
  .map((s) => s.ticker);
console.log(`既取得 ${have.size} / 不足 ${missing.length} 銘柄を低速再取得 (並列4)`);
if (missing.length === 0) { console.log("不足なし。終了"); process.exit(0); }

const rows: MarketCapRow[] = [];
let failed = 0;
const CONCURRENCY = 4;
const t0 = Date.now();
for (let i = 0; i < missing.length; i += CONCURRENCY) {
  const batch = missing.slice(i, i + CONCURRENCY);
  const results = await Promise.all(batch.map((t) => fetchMarketCapRow(t, date)));
  for (const r of results) (r ? rows.push(r) : failed++);
  await new Promise((r) => setTimeout(r, 250)); // レート制限予防
  if ((i / CONCURRENCY) % 25 === 0) {
    process.stdout.write(`\r  ${i + batch.length}/${missing.length} (ok=${rows.length} fail=${failed}) ${Math.round((Date.now() - t0) / 1000)}s`);
  }
}
console.log(`\n追補取得: ok=${rows.length} fail=${failed}`);

if (rows.length > 0) {
  const tmp = join(tmpdir(), `market_cap_topup_${date}.ndjson`);
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n"));
  await bq.dataset(BQ_DATASET).table(`${TABLE}$${date.replace(/-/g, "")}`).load(tmp, {
    sourceFormat: "NEWLINE_DELIMITED_JSON",
    writeDisposition: "WRITE_APPEND",
  });
  unlinkSync(tmp);
  console.log(`✅ BQ 追記: ${rows.length}行`);

  // Firestore caps マージ
  const docRef = fsdb.collection("meta").doc("market_cap_latest");
  const cur = (await docRef.get()).data() ?? {};
  const caps = { ...(cur.caps ?? {}), ...toCapsMap(rows) };
  await docRef.set({
    date,
    caps,
    count: Object.keys(caps).length,
    updatedAt: new Date().toISOString(),
  });
  console.log(`✅ meta/market_cap_latest: ${Object.keys(caps).length}銘柄`);
}
