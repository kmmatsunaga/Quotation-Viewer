import { NextRequest, NextResponse } from "next/server";
import { yfQuoteSummary } from "@/lib/yahoo-finance";

/**
 * GET /api/stocks/next-earnings?tickers=7203,AAPL
 *
 * 次回決算予定日だけを軽量バッチで返す (calendarEvents モジュールのみ)。
 * お気に入りカードの「🗓決算接近」バッジ用。最大 30 銘柄、6時間キャッシュ。
 */

export const maxDuration = 30;

const tsToDate = (ts: number | null | undefined): string | null =>
  ts && typeof ts === "number" ? new Date(ts * 1000).toISOString().slice(0, 10) : null;

export async function GET(req: NextRequest) {
  const tickers = (req.nextUrl.searchParams.get("tickers") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 30);
  if (tickers.length === 0) {
    return NextResponse.json({ ok: false, error: "tickers required" }, { status: 400 });
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const results = await Promise.all(
    tickers.map(async (ticker) => {
      const isJP = /^\d{3,4}[A-Z]?$/.test(ticker);
      const yfTicker = isJP ? `${ticker}.T` : ticker;
      try {
        const summary = await yfQuoteSummary(yfTicker, "calendarEvents");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const arr = ((summary?.calendarEvents as any)?.earnings?.earningsDate ?? []) as Array<{ raw?: number } | number>;
        const ts = arr.length > 0 ? (typeof arr[0] === "number" ? arr[0] : arr[0].raw ?? null) : null;
        const date = tsToDate(ts);
        const daysToNext = date
          ? Math.round((new Date(date).getTime() - new Date(todayIso).getTime()) / (24 * 3600 * 1000))
          : null;
        return [ticker, { date, daysToNext }] as const;
      } catch {
        return [ticker, { date: null, daysToNext: null }] as const;
      }
    })
  );

  return NextResponse.json({ ok: true, earnings: Object.fromEntries(results) });
}
