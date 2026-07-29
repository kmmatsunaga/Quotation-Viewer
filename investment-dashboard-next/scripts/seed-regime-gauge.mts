/**
 * 🌊 レジーム測定器の履歴シード (ローカル1回実行)
 *
 *   npx tsx scripts/seed-regime-gauge.mts
 *
 * BQ cavka.daily_features から直近~130営業日の breadth (60日安値割合など) を
 * 日次で集計し、Firestore meta/regime_gauge に書き込む。
 * 以後は daily-features cron が毎晩1日分ずつ追記する。
 */

import { readFileSync } from "fs";
import { BigQuery } from "@google-cloud/bigquery";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { RegimePoint } from "../src/lib/regime-gauge";

const BQ_KEY = "C:/Users/matsunaga/Documents/key/booking-data-388605@appspot.gserviceaccount.com/booking-data-388605-ec9e7af2c0e1.json";
const BQ_PROJECT = "booking-data-388605";

let raw = readFileSync("./.env.local", "utf-8").match(/FIREBASE_SERVICE_ACCOUNT_KEY=(.+)/)![1].trim();
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1);
initializeApp({ credential: cert(JSON.parse(raw)) });
const fsdb = getFirestore();

const bq = new BigQuery({ projectId: BQ_PROJECT, keyFilename: BQ_KEY });

// cron の computeGaugeFromRows と同じ定義: 流動銘柄 (売買代金1億以上)、300銘柄未満の日は除外
const q = `
  SELECT FORMAT_DATE('%Y-%m-%d', date) AS d,
    COUNT(*) AS n,
    ROUND(COUNTIF(isLow60) / COUNT(*) * 100, 1) AS low60Pct,
    ROUND(COUNTIF(isLow20) / COUNT(*) * 100, 1) AS low20Pct,
    ROUND(COUNTIF(isHigh60) / COUNT(*) * 100, 1) AS high60Pct
  FROM \`${BQ_PROJECT}.cavka.daily_features\`
  WHERE turnover >= 1e8
    AND date >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 220 DAY)
  GROUP BY d
  HAVING n >= 300
  ORDER BY d
`;

const [rows] = await bq.query(q);
type Row = { d: string; n: number; low60Pct: number; low20Pct: number; high60Pct: number };
const days = (rows as Row[]).slice(-130);
if (days.length === 0) throw new Error("BQ から集計結果ゼロ");

const last = days[days.length - 1];
const history: RegimePoint[] = days.map((r) => ({ date: r.d, low60Pct: r.low60Pct }));

await fsdb.collection("meta").doc("regime_gauge").set({
  date: last.d,
  n: last.n,
  low60Pct: last.low60Pct,
  low20Pct: last.low20Pct,
  high60Pct: last.high60Pct,
  history,
  updatedAt: new Date().toISOString(),
});

console.log(`✅ meta/regime_gauge をシード: ${days.length}営業日 (${days[0].d} 〜 ${last.d})`);
console.log(`   最新: low60=${last.low60Pct}% low20=${last.low20Pct}% high60=${last.high60Pct}% n=${last.n}`);
const peak = history.reduce((a, b) => (b.low60Pct > a.low60Pct ? b : a));
console.log(`   期間内ピーク: ${peak.date} low60=${peak.low60Pct}%`);
