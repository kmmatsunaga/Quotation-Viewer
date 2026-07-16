/**
 * パターン工場 Phase 1 — 日次特徴量の 2年バックフィル (ローカル実行専用)
 *
 *   npx tsx scripts/daily-features-backfill.mts           # 全銘柄 2年分
 *   npx tsx scripts/daily-features-backfill.mts --limit 5 # 動作確認用
 *
 * - Yahoo v8 chart (range=2y, interval=1d) を全 JP 銘柄分取得 (並列8, 250ms間隔)
 * - 特徴量計算は src/lib/daily-features.ts (cron と同一ロジック)
 * - BQ cavka.daily_features へ WRITE_TRUNCATE ロード (冪等)
 */

import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BigQuery } from "@google-cloud/bigquery";
import { NIKKEI225 } from "../src/lib/nikkei225";
import { STOCK_LIST } from "../src/lib/stock-list";
import { getSectorsForTicker } from "../src/lib/jp-themes";
import {
  computeDailyFeatures,
  fillRelativeFeatures,
  yahooChartToBars,
  type DailyFeatureRow,
} from "../src/lib/daily-features";

const BQ_KEY = "C:/Users/matsunaga/Documents/key/booking-data-388605@appspot.gserviceaccount.com/booking-data-388605-ec9e7af2c0e1.json";
const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
const TABLE = "daily_features";

const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

// ── ユニバース: NIKKEI225 ∪ STOCK_LIST(JP) ──
const universe = new Map<string, string>(); // ticker -> name
for (const s of NIKKEI225) universe.set(s.ticker, s.name);
for (const s of STOCK_LIST) if (s.market === "JP") universe.set(s.ticker, s.name);
const tickers = Array.from(universe.keys()).slice(0, LIMIT === Infinity ? undefined : LIMIT);
console.log(`ユニバース: ${tickers.length} 銘柄`);

async function fetchBars(symbol: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return [];
      return yahooChartToBars(await res.json());
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
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

// ── 2. 全銘柄の特徴量 ──
const allRows: DailyFeatureRow[] = [];
let done = 0;
const CONCURRENCY = 8;
for (let i = 0; i < tickers.length; i += CONCURRENCY) {
  const batch = tickers.slice(i, i + CONCURRENCY);
  const results = await Promise.all(
    batch.map(async (t) => {
      const bars = await fetchBars(`${t}.T`);
      const sector = getSectorsForTicker(t)[0]?.id ?? null;
      return computeDailyFeatures(t, sector, bars);
    }),
  );
  for (const rows of results) allRows.push(...rows);
  done += batch.length;
  if (done % 40 === 0 || done === tickers.length) {
    console.log(`  ${done}/${tickers.length} 銘柄 (${allRows.length} 行)`);
  }
  await new Promise((r) => setTimeout(r, 250));
}

// ── 3. 相対特徴量 (地合い・セクター) ──
fillRelativeFeatures(allRows, nikkeiByDate);
console.log(`特徴量: ${allRows.length} 行 (銘柄×日)`);

// ── 4. BQ ロード (WRITE_TRUNCATE 全置換、冪等) ──
const bq = new BigQuery({ projectId: BQ_PROJECT, keyFilename: BQ_KEY });
const ndjson = allRows.map((r) => JSON.stringify(r)).join("\n");
const tmpFile = join(tmpdir(), `daily_features_${Date.now()}.ndjson`);
writeFileSync(tmpFile, ndjson);

const [job] = await bq
  .dataset(BQ_DATASET)
  .table(TABLE)
  .load(tmpFile, {
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

// 確認クエリ
const [rows] = await bq.query({
  query: `SELECT COUNT(*) AS n, COUNT(DISTINCT ticker) AS tickers, MIN(date) AS first, MAX(date) AS last FROM \`${BQ_PROJECT}.${BQ_DATASET}.${TABLE}\``,
});
console.log("検収:", JSON.stringify(rows[0]));
