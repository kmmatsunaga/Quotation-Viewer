import { NextRequest, NextResponse } from "next/server";
import { BigQuery } from "@google-cloud/bigquery";
import { Readable } from "stream";
import { getCachedJpStocks } from "@/lib/jp-stocks-cache";
import { getAdminDb } from "@/lib/firebase-admin";
import { fetchBalanceSheet, computeNetCash, type NetCashRow } from "@/lib/net-cash";

/**
 * GET /api/cron/net-cash — 🏔 ネットキャッシュ比率の週次更新 (土曜 JST 8:00)
 *
 * ③時価総額基盤 (meta/market_cap_latest, 土曜6:00更新) の後に走り、
 * 全銘柄の年次BSから 清原式NC比率・実質PER を計算して
 * BQ cavka.net_cash + Firestore meta/net_cash_screener を更新する。
 *
 * ?dry=1 保存なし。?limit=N テスト用。
 */

const CRON_SECRET = process.env.CRON_SECRET;
const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
const TABLE = "net_cash";
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
  const db = getAdminDb();

  // ── ③の時価総額 (分母) — 無ければ計算不能 ──
  const mcapDoc = await db.collection("meta").doc("market_cap_latest").get();
  const caps: Record<string, number> = mcapDoc.data()?.caps ?? {}; // 億円
  if (Object.keys(caps).length < 1000) {
    return NextResponse.json({ ok: false, error: "market_cap_latest 未整備 (先に /api/cron/market-cap)" }, { status: 500 });
  }

  // ── ユニバース: 時価総額が取れている銘柄 ──
  const EXCLUDE_NAME = /投信|ＥＴＦ|ETF|上場|インデックス|指数|レバレッジ|インバース|ブル|ベア|ダブル|ｉＦ|ＮＦ|iシェア|MAXIS|純金|プラチナ|銀|原油|ガス|穀物|外債|米国債|リート|ETN/i;
  const nameOf = new Map<string, string>();
  try {
    for (const s of await getCachedJpStocks()) {
      if (/^\d{3,4}[0-9A-Z]?$/.test(s.ticker) && !EXCLUDE_NAME.test(s.name)) nameOf.set(s.ticker, s.name);
    }
  } catch {}
  let tickers = Array.from(nameOf.keys()).filter((t) => caps[t] != null);
  if (limit > 0) tickers = tickers.slice(0, limit);

  // ── 取得 + 計算 ──
  const rows: NetCashRow[] = [];
  let failed = 0;
  const CONCURRENCY = 10;
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((t) => fetchBalanceSheet(t)));
    for (let k = 0; k < batch.length; k++) {
      const bs = results[k];
      if (!bs) { failed++; continue; }
      rows.push(computeNetCash(bs, caps[batch[k]] * 1e8, date));
    }
  }

  if (rows.length < 500) {
    return NextResponse.json({ ok: false, date, error: `取得数不足 (${rows.length})`, failed });
  }

  if (!dry) {
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
    await db.collection("meta").doc("net_cash_screener").set({
      date,
      entries: screener,
      count: screener.length,
      universe: rows.length,
      updatedAt: new Date().toISOString(),
    });
  }

  return NextResponse.json({ ok: true, date, rows: rows.length, failed, dry, elapsedMs: Date.now() - startedAt });
}
