import { NextRequest, NextResponse } from "next/server";
import { yfQuoteSummary } from "@/lib/yahoo-finance";

/**
 * GET /api/stocks/earnings?tickers=7203,4502,AAPL
 *
 * Yahoo Finance quoteSummary の calendarEvents + earnings モジュールから
 * 直近の決算日・配当日・予想EPS等を取得する。
 *
 * 最大20銘柄まで。レスポンスはティッカーをキーとするマップ。
 */

export interface EarningsInfo {
  ticker: string;
  name: string;
  nextEarningsDate: string | null;         // YYYY-MM-DD
  nextEarningsDateRange: [string, string] | null; // 範囲指定の場合
  earningsAverage: number | null;
  earningsLow: number | null;
  earningsHigh: number | null;
  revenueAverage: number | null;
  exDividendDate: string | null;
  dividendDate: string | null;
  lastEarningsActual: number | null;
  lastEarningsEstimate: number | null;
  lastEarningsSurprise: number | null;     // %
  fiscalYearEnd: string | null;            // 決算月 (例: "3月")
  currency: string;
}

function tsToDateString(ts: number | undefined | null): string | null {
  if (!ts || typeof ts !== "number") return null;
  // 秒単位のUNIX timestamp
  const d = new Date(ts * 1000);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function raw(
  obj: Record<string, unknown> | undefined,
  key: string
): number | null {
  if (!obj) return null;
  const v = obj[key];
  if (v && typeof v === "object" && "raw" in (v as Record<string, unknown>)) {
    return (v as { raw: number }).raw;
  }
  if (typeof v === "number") return v;
  return null;
}

export async function GET(req: NextRequest) {
  const tickersParam = req.nextUrl.searchParams.get("tickers") ?? "";
  const tickers = tickersParam
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 20);

  if (tickers.length === 0) {
    return NextResponse.json({ earnings: {} });
  }

  try {
    const results = await Promise.allSettled(
      tickers.map(async (ticker) => {
        const isJP = /^\d{3,4}[A-Z]?$/.test(ticker);
        const yfTicker = isJP ? `${ticker}.T` : ticker;

        const result = await yfQuoteSummary(
          yfTicker,
          "calendarEvents,earnings,earningsHistory,summaryDetail,price"
        );
        if (!result) return null;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cal = (result.calendarEvents ?? {}) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const earnings = (result.earnings ?? {}) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const earningsHistory = (result.earningsHistory ?? {}) as any;
        const sd = (result.summaryDetail ?? {}) as Record<string, unknown>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const price = (result.price ?? {}) as any;

        // calendarEvents.earnings.earningsDate は配列 [start, end?]
        const earningsDateRaw = cal.earnings?.earningsDate ?? [];
        const earningsDates: number[] = Array.isArray(earningsDateRaw)
          ? earningsDateRaw
              .map((d: Record<string, unknown>) => (d?.raw as number) ?? 0)
              .filter((n: number) => n > 0)
          : [];

        const earningsAverage = raw(cal.earnings, "earningsAverage");
        const earningsLow = raw(cal.earnings, "earningsLow");
        const earningsHigh = raw(cal.earnings, "earningsHigh");
        const revenueAverage = raw(cal.earnings, "revenueAverage");

        const exDividendDate = tsToDateString(raw(cal, "exDividendDate") ?? raw(sd, "exDividendDate"));
        const dividendDate = tsToDateString(raw(cal, "dividendDate") ?? raw(sd, "dividendDate"));

        // 直近の決算結果
        const histArr = earningsHistory.history ?? [];
        const lastQuarter = Array.isArray(histArr) && histArr.length > 0 ? histArr[histArr.length - 1] : null;
        const lastEarningsActual = lastQuarter ? raw(lastQuarter, "epsActual") : null;
        const lastEarningsEstimate = lastQuarter ? raw(lastQuarter, "epsEstimate") : null;
        const lastEarningsSurprise = lastQuarter ? raw(lastQuarter, "surprisePercent") : null;

        // 決算月
        const fiscalYearEndRaw = earnings.financialsChart?.yearly;
        // earnings.earnings の earningsDate.fmt が "FY 2026 (Mar 31, 2026)" のような形式の場合
        let fiscalYearEnd: string | null = null;
        const eDateFmt = earnings.earningsChart?.earningsDate?.[0]?.fmt;
        if (typeof eDateFmt === "string") {
          fiscalYearEnd = eDateFmt;
        } else if (fiscalYearEndRaw && Array.isArray(fiscalYearEndRaw) && fiscalYearEndRaw.length > 0) {
          fiscalYearEnd = fiscalYearEndRaw[0]?.date ?? null;
        }

        const data: EarningsInfo = {
          ticker,
          name: (price.shortName ?? price.longName ?? ticker) as string,
          nextEarningsDate: earningsDates.length > 0 ? tsToDateString(earningsDates[0]) : null,
          nextEarningsDateRange:
            earningsDates.length >= 2
              ? [tsToDateString(earningsDates[0])!, tsToDateString(earningsDates[1])!]
              : null,
          earningsAverage,
          earningsLow,
          earningsHigh,
          revenueAverage,
          exDividendDate,
          dividendDate,
          lastEarningsActual,
          lastEarningsEstimate,
          lastEarningsSurprise: lastEarningsSurprise !== null ? lastEarningsSurprise * 100 : null,
          fiscalYearEnd,
          currency: (price.currency ?? "JPY") as string,
        };
        return data;
      })
    );

    const earnings: Record<string, EarningsInfo> = {};
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        earnings[r.value.ticker] = r.value;
      }
    }

    return NextResponse.json({ earnings });
  } catch (err) {
    console.error("Earnings fetch error:", err);
    return NextResponse.json(
      { earnings: {}, error: "Failed to fetch earnings" },
      { status: 500 }
    );
  }
}
