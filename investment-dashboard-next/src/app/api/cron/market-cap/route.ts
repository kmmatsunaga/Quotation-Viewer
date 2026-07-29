import { NextRequest, NextResponse } from "next/server";
import { BigQuery } from "@google-cloud/bigquery";
import { Readable } from "stream";
import { NIKKEI225 } from "@/lib/nikkei225";
import { STOCK_LIST } from "@/lib/stock-list";
import { getCachedJpStocks } from "@/lib/jp-stocks-cache";
import { getAdminDb } from "@/lib/firebase-admin";
import { fetchMarketCapRow, toCapsMap, type MarketCapRow } from "@/lib/market-cap";

/**
 * GET /api/cron/market-cap — 🏗 時価総額基盤: 週次スナップショット (土曜 JST 6:00)
 *
 * 全上場銘柄 (ETF等除外) の時価総額・発行済株式数を Yahoo から取得し、
 * BQ cavka.market_cap の当日パーティションに WRITE_TRUNCATE (冪等)。
 * 最新値は Firestore meta/market_cap_latest にも保存 (クライアント/回転率計算用)。
 *
 * ?date=YYYY-MM-DD で日付上書き。?dry=1 は保存なし。?limit=N はテスト用。
 */

const CRON_SECRET = process.env.CRON_SECRET;
const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
const TABLE = "market_cap";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function getBq(): BigQuery {
  const raw = process.env.BQ_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("BQ_SERVICE_ACCOUNT_JSON is not set");
  return new BigQuery({ projectId: BQ_PROJECT, credentials: JSON.parse(raw) });
}

function jstToday(): string {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
}

export async function GET(req: NextRequest) {
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const authHeader = req.headers.get("authorization");
  if (!dry && CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const date = req.nextUrl.searchParams.get("date") ?? jstToday();
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 0);
  const startedAt = Date.now();

  // ── ユニバース (daily-features と同じ基準) ──
  const EXCLUDE_NAME = /投信|ＥＴＦ|ETF|上場|インデックス|指数|レバレッジ|インバース|ブル|ベア|ダブル|ｉＦ|ＮＦ|iシェア|MAXIS|純金|プラチナ|銀|原油|ガス|穀物|外債|米国債|リート|ETN/i;
  const universe = new Map<string, string>();
  try {
    for (const s of await getCachedJpStocks()) {
      if (/^\d{3,4}[0-9A-Z]?$/.test(s.ticker) && !EXCLUDE_NAME.test(s.name)) universe.set(s.ticker, s.name);
    }
  } catch {}
  for (const s of NIKKEI225) universe.set(s.ticker, s.name);
  for (const s of STOCK_LIST) if (s.market === "JP") universe.set(s.ticker, s.name);
  let tickers = Array.from(universe.keys());
  if (limit > 0) tickers = tickers.slice(0, limit);

  // ── 取得 ──
  const rows: MarketCapRow[] = [];
  let failed = 0;
  const CONCURRENCY = 12;
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((t) => fetchMarketCapRow(t, date)));
    for (const r of results) {
      if (r) rows.push(r);
      else failed++;
    }
  }

  if (rows.length === 0) {
    return NextResponse.json({ ok: false, date, error: "取得ゼロ", failed });
  }

  if (!dry) {
    // BQ 当日パーティションへ WRITE_TRUNCATE (冪等)
    const bq = getBq();
    const partition = date.replace(/-/g, "");
    const ndjson = rows.map((r) => JSON.stringify(r)).join("\n");
    await new Promise<void>((resolve, reject) => {
      const ws = bq
        .dataset(BQ_DATASET)
        .table(`${TABLE}$${partition}`)
        .createWriteStream({ sourceFormat: "NEWLINE_DELIMITED_JSON", writeDisposition: "WRITE_TRUNCATE" });
      ws.on("job", () => {});
      ws.on("complete", () => resolve());
      ws.on("error", (e: Error) => reject(e));
      Readable.from([ndjson]).pipe(ws);
    });

    // Firestore 最新値 (時価総額のみ、億円単位で軽量化)
    await getAdminDb().collection("meta").doc("market_cap_latest").set({
      date,
      caps: toCapsMap(rows),
      count: rows.length,
      updatedAt: new Date().toISOString(),
    });
  }

  return NextResponse.json({
    ok: true,
    date,
    rows: rows.length,
    failed,
    dry,
    elapsedMs: Date.now() - startedAt,
  });
}
