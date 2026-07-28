import { NextRequest, NextResponse } from "next/server";
import { BigQuery } from "@google-cloud/bigquery";
import { tachibanaLogin, tachibanaLogout, getMarketQuotes } from "@/lib/tachibana";
import { resolveUidByEmail, collectUserTickers } from "@/lib/firebase-admin";
import { assess, fetchAvgVolume } from "@/lib/warroom-assess";
import { getCronOrigin } from "@/lib/cron-origin";

/**
 * GET /api/cron/warroom-snapshot
 *
 * 場中観測の常時記録 (デイトレ法則発見 Phase B):
 *   Cloud Scheduler (booking-data-388605) が平日場中に5分間隔で叩く。
 *   お気に入り + 保有 + 当日デイトレ候補 の板圧・VWAP乖離・成行偏り・評決を
 *   BQ cavka.warroom_ticks へストリーミング記録。
 *
 *   板圧と成行偏りは Yahoo に存在しない — ブラウザを開いていなくても
 *   蓄積される「Cavka にしか検証できないデータ」になる。
 *
 * 認証: Authorization: Bearer ${WARROOM_CRON_KEY} (専用キー、CRON_SECRET も可)
 * 冪等: insertId = ticker_分単位時刻 でリトライ重複を排除
 */

const FALLBACK_EMAIL = "make.some.noise6984@gmail.com";
export const maxDuration = 60;

const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
const BQ_TABLE = "warroom_ticks";

/** JST 場中判定。昼休み (11:32-12:28) はスキップ */
function marketPhase(): "open" | "lunch" | "closed" {
  const now = new Date();
  const jst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60 * 1000);
  const day = jst.getDay();
  if (day === 0 || day === 6) return "closed";
  const mins = jst.getHours() * 60 + jst.getMinutes();
  if (mins < 9 * 60 || mins > 15 * 60 + 32) return "closed";
  if (mins > 11 * 60 + 32 && mins < 12 * 60 + 28) return "lunch";
  return "open";
}

function jstDateStr(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const key = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const ok =
    (process.env.WARROOM_CRON_KEY && key === process.env.WARROOM_CRON_KEY) ||
    (process.env.CRON_SECRET && key === process.env.CRON_SECRET);
  if (!ok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const phase = marketPhase();
  const force = req.nextUrl.searchParams.get("force") === "1"; // 場外テスト用
  if (phase !== "open" && !force) {
    return NextResponse.json({ ok: true, skipped: true, reason: phase });
  }

  const startedAt = Date.now();

  try {
    // ── ユニバース: お気に入り + 保有 + 当日デイトレ候補 ──
    const tickerSet = new Set<string>();
    const emails = (process.env.CAVKA_CRON_EMAILS ?? FALLBACK_EMAIL).split(",").map((e) => e.trim()).filter(Boolean);
    for (const email of emails) {
      const uid = await resolveUidByEmail(email);
      if (!uid) continue;
      for (const t of await collectUserTickers(uid)) {
        if (/^\d{3,4}[A-Z]?$/.test(t)) tickerSet.add(t); // 日本株のみ
      }
    }
    try {
      const origin = getCronOrigin(req);
      const res = await fetch(`${origin}/api/daytrade-candidates`, { next: { revalidate: 3600 } });
      if (res.ok) {
        const j = await res.json();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const c of (j.candidates ?? []) as any[]) {
          if (/^\d{3,4}[A-Z]?$/.test(c.ticker)) tickerSet.add(c.ticker);
        }
      }
    } catch {}
    const tickers = Array.from(tickerSet).slice(0, 40);
    if (tickers.length === 0) {
      return NextResponse.json({ ok: true, skipped: true, reason: "no tickers" });
    }

    // ── 立花で板取得 → 評決計算 ──
    let session = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let quotes: any[] = [];
    try {
      session = await tachibanaLogin();
      const [q, avgVols] = await Promise.all([
        getMarketQuotes(session, tickers),
        Promise.all(tickers.map((t) => fetchAvgVolume(t))),
      ]);
      const avgVolMap = new Map(tickers.map((t, i) => [t, avgVols[i]]));
      quotes = q.map((quote) => assess(quote, avgVolMap.get(quote.ticker) ?? null));
    } finally {
      if (session) await tachibanaLogout(session).catch(() => {});
    }

    // ── BQ ストリーミング挿入 (insertId で冪等) ──
    const credentials = JSON.parse(process.env.BQ_SERVICE_ACCOUNT_JSON ?? "{}");
    const bq = new BigQuery({ projectId: BQ_PROJECT, credentials });
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16); // 分単位
    const date = jstDateStr();

    const rows = quotes
      .filter((e) => e.price !== null && e.priceTime !== null) // 休日・無データはスキップ
      .map((e) => ({
        insertId: `${e.ticker}_${minuteKey}`,
        json: {
          date,
          ts: now.toISOString(),
          ticker: e.ticker,
          price: e.price,
          change_pct: e.changePct,
          board_ratio: e.boardRatio,
          vwap_dev: e.vwapDev,
          range_pos: e.rangePos,
          gap_pct: e.gapPct,
          market_order_ratio: e.marketOrderRatio,
          stance: e.stance,
          score: e.score,
          over_qty: e.overQty,     // 板10段より上の潜在売り (「OVERが減らないブレイクはダマシ」検証用)
          under_qty: e.underQty,
          volume: e.volume,
          turnover: e.turnover,
          high: e.high,
          low: e.low,
          open: e.open,
          vwap: e.vwap,
        },
      }));

    if (rows.length > 0) {
      await bq.dataset(BQ_DATASET).table(BQ_TABLE).insert(rows, { raw: true });
    }

    return NextResponse.json({
      ok: true,
      tickers: tickers.length,
      recorded: rows.length,
      phase,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    // 立花セッション競合等は次の5分でリカバーするので 200 で返す (Scheduler のリトライ抑制)
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - startedAt,
    });
  }
}
