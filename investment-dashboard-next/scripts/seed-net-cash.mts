/**
 * 🏔 ネットキャッシュ比率の初回シード (ローカル実行)
 *
 *   npx tsx scripts/seed-net-cash.mts
 *
 * 1. BQ cavka.net_cash テーブル作成 (無ければ。date パーティション)
 * 2. 全上場銘柄の年次BS (流動資産/投資有価証券/負債/純利益) を Yahoo timeseries から取得
 * 3. ③の meta/market_cap_latest と合流して NC比率・実質PER を計算
 * 4. 当日パーティションへロード + Firestore meta/net_cash_screener (NC比率0.25以上) を保存
 * 以後は週次 cron (/api/cron/net-cash, 土曜朝) が同じことをやる。
 */

import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BigQuery } from "@google-cloud/bigquery";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { fetchBalanceSheet, computeNetCash, type NetCashRow } from "../src/lib/net-cash";

const BQ_KEY = "C:/Users/matsunaga/Documents/key/booking-data-388605@appspot.gserviceaccount.com/booking-data-388605-ec9e7af2c0e1.json";
const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
const TABLE = "net_cash";

let raw = readFileSync("./.env.local", "utf-8").match(/FIREBASE_SERVICE_ACCOUNT_KEY=(.+)/)![1].trim();
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1);
initializeApp({ credential: cert(JSON.parse(raw)) });
const fsdb = getFirestore();
const bq = new BigQuery({ projectId: BQ_PROJECT, keyFilename: BQ_KEY });

// ── 1. テーブル (冪等) ──
const dataset = bq.dataset(BQ_DATASET);
const [exists] = await dataset.table(TABLE).exists();
if (!exists) {
  await dataset.createTable(TABLE, {
    schema: [
      { name: "date", type: "DATE", mode: "REQUIRED" },
      { name: "ticker", type: "STRING", mode: "REQUIRED" },
      { name: "asOfDate", type: "DATE" },
      { name: "currentAssets", type: "FLOAT64" },
      { name: "investSecurities", type: "FLOAT64" },
      { name: "totalLiabilities", type: "FLOAT64" },
      { name: "netIncome", type: "FLOAT64" },
      { name: "market_cap", type: "FLOAT64" },
      { name: "nc", type: "FLOAT64" },
      { name: "nc_ratio", type: "FLOAT64" },
      { name: "real_per", type: "FLOAT64" },
    ],
    timePartitioning: { type: "DAY", field: "date" },
  });
  console.log(`✅ テーブル作成: ${BQ_DATASET}.${TABLE}`);
}

// ── 2. ユニバース + ③の時価総額 ──
const EXCLUDE_NAME = /投信|ＥＴＦ|ETF|上場|インデックス|指数|レバレッジ|インバース|ブル|ベア|ダブル|ｉＦ|ＮＦ|iシェア|MAXIS|純金|プラチナ|銀|原油|ガス|穀物|外債|米国債|リート|ETN/i;
const masterDoc = await fsdb.collection("meta").doc("jpStockMaster").get();
const master: { ticker: string; name: string }[] = masterDoc.data()?.stocks ?? [];
const nameOf = new Map(master.map((s) => [s.ticker, s.name]));
const mcapDoc = await fsdb.collection("meta").doc("market_cap_latest").get();
const caps: Record<string, number> = mcapDoc.data()?.caps ?? {}; // 億円
if (Object.keys(caps).length < 1000) throw new Error("market_cap_latest が未整備。先に seed-market-cap を実行");
// 時価総額が取れている銘柄だけ対象 (NC比率の分母が無いと意味がない)
const tickers = master
  .filter((s) => /^\d{3,4}[0-9A-Z]?$/.test(s.ticker) && !EXCLUDE_NAME.test(s.name) && caps[s.ticker] != null)
  .map((s) => s.ticker);
console.log(`対象: ${tickers.length} 銘柄 (時価総額あり)`);

const jst = new Date(Date.now() + 9 * 3600 * 1000);
const date = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;

// ── 3. 取得 + 計算 ──
const rows: NetCashRow[] = [];
let failed = 0;
const CONCURRENCY = 8;
const t0 = Date.now();
for (let i = 0; i < tickers.length; i += CONCURRENCY) {
  const batch = tickers.slice(i, i + CONCURRENCY);
  const results = await Promise.all(batch.map((t) => fetchBalanceSheet(t)));
  for (let k = 0; k < batch.length; k++) {
    const bs = results[k];
    if (!bs) { failed++; continue; }
    rows.push(computeNetCash(bs, caps[batch[k]] * 1e8, date));
  }
  await new Promise((r) => setTimeout(r, 120));
  if ((i / CONCURRENCY) % 25 === 0) {
    process.stdout.write(`\r  ${i + batch.length}/${tickers.length} (ok=${rows.length} fail=${failed}) ${Math.round((Date.now() - t0) / 1000)}s`);
  }
}
console.log(`\n取得完了: ok=${rows.length} fail=${failed}`);
if (rows.length < 1000) throw new Error("取得数が少なすぎる。中断 (再実行可)");

// ── 4. BQ ロード ──
const tmp = join(tmpdir(), `net_cash_${date}.ndjson`);
writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n"));
await dataset.table(`${TABLE}$${date.replace(/-/g, "")}`).load(tmp, {
  sourceFormat: "NEWLINE_DELIMITED_JSON",
  writeDisposition: "WRITE_TRUNCATE",
});
unlinkSync(tmp);
console.log(`✅ BQ ロード: ${rows.length}行 → ${TABLE}$${date.replace(/-/g, "")}`);

// ── 5. Firestore スクリーナー (NC比率 0.25 以上のみ) ──
const screener = rows
  .filter((r) => r.nc_ratio != null && r.nc_ratio >= 0.25)
  .sort((a, b) => (b.nc_ratio ?? 0) - (a.nc_ratio ?? 0))
  .map((r) => ({
    ticker: r.ticker,
    name: nameOf.get(r.ticker) ?? r.ticker,
    ncRatio: r.nc_ratio,
    realPer: r.real_per,
    marketCapOku: Math.round((r.market_cap ?? 0) / 1e8 * 10) / 10,
    ncOku: Math.round((r.nc ?? 0) / 1e8 * 10) / 10,
    netIncomeOku: r.netIncome != null ? Math.round(r.netIncome / 1e8 * 10) / 10 : null,
    asOfDate: r.asOfDate,
  }));
await fsdb.collection("meta").doc("net_cash_screener").set({
  date,
  entries: screener,
  count: screener.length,
  universe: rows.length,
  updatedAt: new Date().toISOString(),
});
console.log(`✅ meta/net_cash_screener: ${screener.length}銘柄 (NC比率>=0.25) / ユニバース ${rows.length}`);
console.log("  上位:", screener.slice(0, 5).map((s) => `${s.ticker} ${s.name} NC比率${s.ncRatio}`).join(" | "));
