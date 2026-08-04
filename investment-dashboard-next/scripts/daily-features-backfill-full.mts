/**
 * パターン工場 — 日次特徴量の【全上場銘柄】2年バックフィル (ローカル実行専用)
 *
 *   npx tsx scripts/daily-features-backfill-full.mts
 *
 * 旧 backfill (242銘柄) の拡張版。急騰ハンターのため、立花マスタの全上場銘柄
 * (~4,400) から ETF/ETN/投信を除外した ~3,800 銘柄をカバーする。
 * 急騰は小型・低位株の世界で起きるので、そこにデータが無いと前兆は採掘できない。
 *
 * - メモリ対策: 行を配列に貯めず NDJSON ファイルへ逐次書き出し
 * - セクター相対はセクターマスタにある銘柄のみ (他は null)
 * - BQ cavka.daily_features へ WRITE_TRUNCATE (冪等・全置換)
 */

import { createWriteStream, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BigQuery } from "@google-cloud/bigquery";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getSectorsForTicker } from "../src/lib/jp-themes";
import {
  computeDailyFeatures,
  fillRelativeFeatures,
  yahooChartToBars,
  type DailyFeatureRow,
} from "../src/lib/daily-features";

const RANGE = process.argv[2] ?? "5y";
const BQ_KEY = "C:/Users/matsunaga/Documents/key/booking-data-388605@appspot.gserviceaccount.com/booking-data-388605-ec9e7af2c0e1.json";
const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
const TABLE = "daily_features";

// ETF/ETN/投信/REIT指数系の除外 (個別株の急騰前兆を汚すため)
const EXCLUDE_NAME = /投信|ＥＴＦ|ETF|上場|インデックス|指数|レバレッジ|インバース|ブル|ベア|ダブル|ｉＦ|ＮＦ|iシェア|MAXIS|純金|プラチナ|銀|原油|ガス|穀物|外債|米国債|リート|ETN/i;

// ── Firestore から全銘柄マスタ ──
let raw = readFileSync("./.env.local", "utf-8").match(/FIREBASE_SERVICE_ACCOUNT_KEY=(.+)/)![1].trim();
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1);
initializeApp({ credential: cert(JSON.parse(raw)) });
const fsdb = getFirestore();
const masterDoc = await fsdb.collection("meta").doc("jpStockMaster").get();
const master: { ticker: string; name: string }[] = masterDoc.data()?.stocks ?? [];
const tickers = master
  .filter((s) => /^\d{3,4}[0-9A-Z]?$/.test(s.ticker) && !EXCLUDE_NAME.test(s.name))
  .map((s) => s.ticker);
console.log(`ユニバース: マスタ ${master.length} → ETF等除外後 ${tickers.length} 銘柄`);

async function fetchBars(symbol: string) {
  // 期間は引数で変更可: npx tsx scripts/daily-features-backfill-full.mts 5y
  // 2026-08-04 に 2y→5y へ延長。仮説ラボで稀少イベント (VIX急騰・洗い流し・金利急変) が
  // 独立30エピソードに届かず13件が判定不能だったため、標本を増やすのが最優先だった。
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${RANGE}&interval=1d`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.status === 429) { await new Promise((r) => setTimeout(r, 3000 * (attempt + 1))); continue; }
      if (!res.ok) return [];
      return yahooChartToBars(await res.json());
    } catch { await new Promise((r) => setTimeout(r, 800)); }
  }
  return [];
}

// ── 1. 日経平均 (地合い) ──
const nikkeiBars = await fetchBars("^N225");
const nikkeiByDate = new Map<string, number>();
for (let i = 1; i < nikkeiBars.length; i++) {
  const prev = nikkeiBars[i - 1].close;
  if (prev > 0) nikkeiByDate.set(nikkeiBars[i].date, ((nikkeiBars[i].close - prev) / prev) * 100);
}
console.log(`日経平均: ${nikkeiByDate.size} 日分`);

// ── 2. 全銘柄: セクター無し銘柄は即書き出し、有り銘柄はバッファ (セクター平均算出用) ──
const tmpFile = join(tmpdir(), `daily_features_full_${Date.now()}.ndjson`);
const out = createWriteStream(tmpFile, { encoding: "utf-8" });
const sectorRows: DailyFeatureRow[] = [];
let written = 0, done = 0, empty = 0;
const CONCURRENCY = 12;

const writeRows = (rows: DailyFeatureRow[]) => {
  if (rows.length === 0) return;
  out.write(rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  written += rows.length;
};

for (let i = 0; i < tickers.length; i += CONCURRENCY) {
  const batch = tickers.slice(i, i + CONCURRENCY);
  const results = await Promise.all(
    batch.map(async (t) => {
      const bars = await fetchBars(`${t}.T`);
      if (bars.length === 0) return { t, rows: [] as DailyFeatureRow[], sector: null as string | null };
      const sector = getSectorsForTicker(t)[0]?.id ?? null;
      return { t, rows: computeDailyFeatures(t, sector, bars), sector };
    }),
  );
  for (const r of results) {
    if (r.rows.length === 0) { empty++; continue; }
    if (r.sector) {
      sectorRows.push(...r.rows); // セクター相対は後でまとめて
    } else {
      fillRelativeFeatures(r.rows, nikkeiByDate); // 日経相対のみ即埋め
      writeRows(r.rows);
    }
  }
  done += batch.length;
  if (done % 240 === 0 || done >= tickers.length) {
    console.log(`  ${done}/${tickers.length} 銘柄 (書出 ${written} 行 / セクター待ち ${sectorRows.length} / データ無 ${empty})`);
  }
  await new Promise((r) => setTimeout(r, 120));
}

// セクター持ち銘柄: 相対を埋めて書き出し
fillRelativeFeatures(sectorRows, nikkeiByDate);
writeRows(sectorRows);
await new Promise<void>((res) => out.end(res));
console.log(`書き出し完了: ${written} 行`);

// ── 3. BQ ロード (WRITE_TRUNCATE) ──
const bq = new BigQuery({ projectId: BQ_PROJECT, keyFilename: BQ_KEY });
const [job] = await bq.dataset(BQ_DATASET).table(TABLE).load(tmpFile, {
  sourceFormat: "NEWLINE_DELIMITED_JSON",
  writeDisposition: "WRITE_TRUNCATE",
  createDisposition: "CREATE_IF_NEEDED",
  schema: {
    fields: [
      { name: "date", type: "DATE" },
      { name: "ticker", type: "STRING" },
      { name: "sector", type: "STRING" },
      { name: "close", type: "FLOAT" },
      { name: "dayChangePct", type: "FLOAT" },
      { name: "gapPct", type: "FLOAT" },
      { name: "openToClosePct", type: "FLOAT" },
      { name: "rangePosClose", type: "FLOAT" },
      { name: "rangePct", type: "FLOAT" },
      { name: "volumeRatio", type: "FLOAT" },
      { name: "turnover", type: "FLOAT" },
      { name: "streak", type: "INTEGER" },
      { name: "isHigh20", type: "BOOLEAN" },
      { name: "isLow20", type: "BOOLEAN" },
      { name: "isHigh60", type: "BOOLEAN" },
      { name: "isLow60", type: "BOOLEAN" },
      { name: "ret5dPct", type: "FLOAT" },
      { name: "ret20dPct", type: "FLOAT" },
      { name: "rsi14", type: "FLOAT" },
      { name: "atrPct14", type: "FLOAT" },
      // 2026-08-04: 後から DailyFeatureRow に追加された列。ここに書き忘れると
      // 全取得のあと BQ ロードだけが "No such field" で落ちる (実際に踏んだ)
      { name: "terrainScore", type: "FLOAT" },
      { name: "nikkeiChangePct", type: "FLOAT" },
      { name: "vsNikkeiPct", type: "FLOAT" },
      { name: "sectorChangePct", type: "FLOAT" },
      { name: "vsSectorPct", type: "FLOAT" },
    ],
  },
  timePartitioning: { type: "DAY", field: "date" },
});
unlinkSync(tmpFile);
console.log(`BQ ロード完了: job ${job.id}`);
const [chk] = await bq.query({ query: `SELECT COUNT(*) n, COUNT(DISTINCT ticker) tk, MIN(date) mn, MAX(date) mx FROM \`${BQ_PROJECT}.${BQ_DATASET}.${TABLE}\`` });
console.log("検収:", JSON.stringify(chk[0]));
process.exit(0);
