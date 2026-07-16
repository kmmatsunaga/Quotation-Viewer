#!/usr/bin/env node
/**
 * Firestore の既存日次履歴を BigQuery (cavka データセット) へ一括バックフィル。
 *
 * ローカル実行専用:
 *   node scripts/bq-backfill.mjs
 *
 * - Firestore 認証: .env.local の FIREBASE_SERVICE_ACCOUNT_KEY
 * - BQ 認証: ローカルのサービスアカウントキーファイル
 * - 各日付パーティションへ WRITE_TRUNCATE ロード (冪等、何度実行してもOK)
 */

import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { BigQuery } from "@google-cloud/bigquery";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BQ_KEY = "C:/Users/matsunaga/Documents/key/booking-data-388605@appspot.gserviceaccount.com/booking-data-388605-ec9e7af2c0e1.json";
const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";

// ── .env.local から Firebase 認証を取る ──
const envText = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
const m = envText.match(/^FIREBASE_SERVICE_ACCOUNT_KEY=(.*)$/m);
if (!m) { console.error("FIREBASE_SERVICE_ACCOUNT_KEY not found in .env.local"); process.exit(1); }
let raw = m[1].trim();
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1);
const fbCreds = JSON.parse(raw);

initializeApp({ credential: cert(fbCreds), projectId: fbCreds.project_id });
const db = getFirestore();
const bq = new BigQuery({ projectId: BQ_PROJECT, keyFilename: BQ_KEY });

const toDateStr = (key) => `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;

async function loadPartition(table, dateKey, rows) {
  if (rows.length === 0) return 0;
  const tmp = join(tmpdir(), `bqbf_${table}_${dateKey}.ndjson`);
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n"), "utf8");
  try {
    const [job] = await bq.dataset(BQ_DATASET).table(`${table}$${dateKey}`).load(tmp, {
      sourceFormat: "NEWLINE_DELIMITED_JSON",
      writeDisposition: "WRITE_TRUNCATE",
    });
    const errs = job.status?.errors;
    if (errs?.length) throw new Error(JSON.stringify(errs.slice(0, 2)));
    return rows.length;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

// ── meta コレクションの全 doc ID を列挙 (中身は読まない) ──
const refs = await db.collection("meta").listDocuments();
const ids = refs.map((r) => r.id);
console.log(`meta docs: ${ids.length}`);

const jobs = [
  { prefix: /^score_rankings_(\d{8})$/, table: "score_rankings_daily", map: (data, date) =>
      (data.entries ?? []).map((e) => ({ date, ticker: e.ticker, name: e.name ?? null, market: e.market ?? null, price: e.price ?? null, short: e.short ?? null, mid: e.mid ?? null, long: e.long ?? null, overall: e.overall ?? null })) },
  { prefix: /^verdict_history_(\d{8})$/, table: "verdict_history_daily", map: (data, date) =>
      (data.entries ?? []).map((e) => ({ date, ticker: e.ticker, price: e.price ?? null,
        short_stance: e.short?.stance ?? null, short_direction: e.short?.direction ?? null, short_conviction: e.short?.conviction ?? null,
        mid_stance: e.mid?.stance ?? null, mid_direction: e.mid?.direction ?? null, mid_conviction: e.mid?.conviction ?? null,
        long_stance: e.long?.stance ?? null, long_direction: e.long?.direction ?? null, long_conviction: e.long?.conviction ?? null })) },
  { prefix: /^verdict_eval_(\d{8})$/, table: "verdict_evals_daily", map: (data, date) =>
      (data.verdictEvals ?? []).map((e) => ({ date, tf: e.tf, ticker: e.ticker, past_date: e.pastDate ? toDateStr(e.pastDate) : null, stance: e.stance ?? null, conviction: e.conviction ?? null, ret: e.ret ?? null, hit: e.hit ?? null })) },
  { prefix: /^macro_fred_watch_history_(\d{8})$/, table: "macro_daily", map: (data, date) => {
      const payload = JSON.parse(JSON.stringify(data, (k, v) => (k === "cachedAt" || k === "savedAtIso" ? undefined : v)));
      return [{ date, payload: JSON.stringify(payload) }];
    } },
];

let totalRows = 0, totalParts = 0;
for (const job of jobs) {
  const matched = ids.map((id) => ({ id, m: id.match(job.prefix) })).filter((x) => x.m);
  console.log(`\n${job.table}: ${matched.length} 日分`);
  for (const { id, m: mm } of matched) {
    const dateKey = mm[1];
    const snap = await db.collection("meta").doc(id).get();
    const rows = job.map(snap.data() ?? {}, toDateStr(dateKey));
    const n = await loadPartition(job.table, dateKey, rows);
    totalRows += n; totalParts++;
    console.log(`  ${dateKey}: ${n} rows`);
  }
}
console.log(`\nDONE: ${totalParts} partitions, ${totalRows} rows`);
process.exit(0);
