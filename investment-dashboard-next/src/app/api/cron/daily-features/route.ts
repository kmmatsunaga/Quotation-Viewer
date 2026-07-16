import { NextRequest, NextResponse } from "next/server";
import { BigQuery } from "@google-cloud/bigquery";
import { NIKKEI225 } from "@/lib/nikkei225";
import { STOCK_LIST } from "@/lib/stock-list";
import { getCachedJpStocks } from "@/lib/jp-stocks-cache";
import { getSectorsForTicker } from "@/lib/jp-themes";
import {
  computeDailyFeatures,
  fillRelativeFeatures,
  yahooChartToBars,
  type DailyFeatureRow,
} from "@/lib/daily-features";
import { Readable } from "stream";

/**
 * GET /api/cron/daily-features — パターン工場 Layer 1: 当日の特徴量を BQ に追記
 *
 * 毎晩 (JST 17:00 目標) 全 JP 銘柄の当日分を計算し、
 * cavka.daily_features の当日パーティションに WRITE_TRUNCATE ロード (冪等)。
 * 過去分はローカルの scripts/daily-features-backfill.mts で投入済み。
 *
 * ?date=YYYY-MM-DD 指定で過去日の再計算 (休日はスキップ)。?dry=1 は保存なし。
 */

const CRON_SECRET = process.env.CRON_SECRET;
const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
const TABLE = "daily_features";
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

async function fetchBars(symbol: string) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store" });
    if (!res.ok) return [];
    return yahooChartToBars(await res.json());
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const authHeader = req.headers.get("authorization");
  if (!dry && CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const targetDate = req.nextUrl.searchParams.get("date") ?? jstToday();
  const startedAt = Date.now();

  // ── ユニバース: 全上場銘柄 (ETF/ETN/投信除外)。急騰ハンターは小型株の世界が主戦場 ──
  const EXCLUDE_NAME = /投信|ＥＴＦ|ETF|上場|インデックス|指数|レバレッジ|インバース|ブル|ベア|ダブル|ｉＦ|ＮＦ|iシェア|MAXIS|純金|プラチナ|銀|原油|ガス|穀物|外債|米国債|リート|ETN/i;
  const universe = new Map<string, string>();
  try {
    for (const s of await getCachedJpStocks()) {
      if (/^\d{3,4}[0-9A-Z]?$/.test(s.ticker) && !EXCLUDE_NAME.test(s.name)) universe.set(s.ticker, s.name);
    }
  } catch {}
  // マスタ取得失敗時のフォールバック (最低限コア銘柄は更新する)
  for (const s of NIKKEI225) universe.set(s.ticker, s.name);
  for (const s of STOCK_LIST) if (s.market === "JP") universe.set(s.ticker, s.name);
  const tickers = Array.from(universe.keys());

  // ── 日経平均 (地合い) ──
  const nikkeiBars = await fetchBars("^N225");
  const nikkeiByDate = new Map<string, number>();
  for (let i = 1; i < nikkeiBars.length; i++) {
    const prev = nikkeiBars[i - 1].close;
    if (prev > 0) nikkeiByDate.set(nikkeiBars[i].date, ((nikkeiBars[i].close - prev) / prev) * 100);
  }
  // 対象日に日経のバーが無い = 休場日 → スキップ
  if (!nikkeiByDate.has(targetDate)) {
    return NextResponse.json({ ok: true, date: targetDate, skipped: "休場日 (日経バーなし)" });
  }

  // ── 全銘柄: 当日行のみ計算 ──
  const rows: DailyFeatureRow[] = [];
  let fetched = 0;
  const CONCURRENCY = 14;
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (t) => {
        const bars = await fetchBars(`${t}.T`);
        fetched++;
        if (bars.length === 0) return [];
        // 対象日のバーが末尾に来るよう切り詰め (再計算対応)
        const idx = bars.findIndex((b) => b.date === targetDate);
        if (idx === -1) return [];
        const sector = getSectorsForTicker(t)[0]?.id ?? null;
        return computeDailyFeatures(t, sector, bars.slice(0, idx + 1), { onlyLastDay: true });
      }),
    );
    for (const r of results) rows.push(...r);
  }

  fillRelativeFeatures(rows, nikkeiByDate);
  const dayRows = rows.filter((r) => r.date === targetDate);

  if (dayRows.length === 0) {
    return NextResponse.json({ ok: true, date: targetDate, skipped: "対象日の行ゼロ", fetched });
  }

  if (!dry) {
    // 当日パーティションへ WRITE_TRUNCATE (冪等)
    const bq = getBq();
    const partition = targetDate.replace(/-/g, "");
    const ndjson = dayRows.map((r) => JSON.stringify(r)).join("\n");
    await new Promise<void>((resolve, reject) => {
      const writeStream = bq
        .dataset(BQ_DATASET)
        .table(`${TABLE}$${partition}`)
        .createWriteStream({
          sourceFormat: "NEWLINE_DELIMITED_JSON",
          writeDisposition: "WRITE_TRUNCATE",
        });
      writeStream.on("job", () => {});
      writeStream.on("complete", () => resolve());
      writeStream.on("error", (e: Error) => reject(e));
      Readable.from([ndjson]).pipe(writeStream);
    });
  }

  return NextResponse.json({
    ok: true,
    date: targetDate,
    rows: dayRows.length,
    fetched,
    dry,
    elapsedMs: Date.now() - startedAt,
  });
}
