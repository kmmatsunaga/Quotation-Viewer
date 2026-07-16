import { NextRequest, NextResponse } from "next/server";
import { evaluateInsights, type InsightInput } from "@/lib/insights-engine";

/**
 * GET /api/stocks/insights?ticker=7203
 *
 * 指定銘柄について短期/中期/長期のインサイトを返す。
 * 内部で複数APIを並列叩いてデータ収集 → ルールエンジンで判定。
 *
 * 認証: なし (Cavkaログイン済みのユーザーが画面から呼ぶ前提)
 */

async function safeJson<T = unknown>(url: string, headers?: Record<string, string>): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Cavka-Insights/1.0", ...headers } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker")?.trim();
  if (!ticker) {
    return NextResponse.json({ error: "ticker required" }, { status: 400 });
  }

  const host = req.headers.get("host") ?? "localhost:3001";
  const proto = host.includes("localhost") ? "http" : "https";
  const origin = `${proto}://${host}`;
  const apiKey = process.env.MCP_API_KEY;
  const authHeader = apiKey ? { "x-api-key": apiKey } : undefined;
  const isJP = /^\d{3,4}[A-Z]?$/.test(ticker);

  // 並列取得
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [detail, fundRes, patternRes, anomalyRes, quotesRes, marginRes, earningsRes, earningsPatternRes] = await Promise.all([
    safeJson<any>(`${origin}/api/stock/${encodeURIComponent(ticker)}?range=6mo&interval=1d`),
    safeJson<any>(`${origin}/api/stocks/fundamentals?tickers=${ticker}`),
    safeJson<any>(`${origin}/api/stocks/patterns?tickers=${ticker}`),
    safeJson<any>(`${origin}/api/stocks/volume-anomaly?tickers=${ticker}`),
    isJP && authHeader ? safeJson<any>(`${origin}/api/tachibana/quotes?tickers=${ticker}`, authHeader) : Promise.resolve(null),
    isJP && authHeader ? safeJson<any>(`${origin}/api/tachibana/margin?tickers=${ticker}`, authHeader) : Promise.resolve(null),
    safeJson<any>(`${origin}/api/stocks/earnings?tickers=${ticker}`),
    safeJson<any>(`${origin}/api/stocks/earnings-pattern?ticker=${ticker}`),
  ]);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // 6か月レンジ位置
  let priceContext = null;
  if (detail?.candles && detail.candles.length > 0) {
    const candles = detail.candles as Array<{ high: number; low: number }>;
    const high6m = Math.max(...candles.map((c) => c.high));
    const low6m = Math.min(...candles.map((c) => c.low));
    const cur = detail.price as number;
    const range = high6m - low6m;
    priceContext = {
      high6m,
      low6m,
      positionInRange: range > 0 ? Math.round(((cur - low6m) / range) * 100) : 50,
    };
  }

  const fundamentals = fundRes?.fundamentals?.[ticker] ?? null;
  const patternData = patternRes?.patterns?.[ticker]?.patterns ?? null;
  const anomaly = anomalyRes?.anomalies?.[0] ?? null;
  const quote = quotesRes?.quotes?.[0] ?? null;
  const marginData = marginRes?.data?.[ticker] ?? null;
  const earnings = earningsRes?.earnings?.[ticker] ?? null;

  // 決算までの日数
  let daysUntilEarnings: number | null = null;
  if (earnings?.nextEarningsDate) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(earnings.nextEarningsDate);
    target.setHours(0, 0, 0, 0);
    daysUntilEarnings = Math.floor((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  }

  // 板情報サマリ
  let orderBook = null;
  if (quote?.bids && quote?.asks) {
    const bidVolume = (quote.bids as Array<{ quantity: number | null }>).reduce((s, b) => s + (b.quantity ?? 0), 0);
    const askVolume = (quote.asks as Array<{ quantity: number | null }>).reduce((s, a) => s + (a.quantity ?? 0), 0);
    orderBook = { bidVolume, askVolume };
  }

  const input: InsightInput = {
    ticker,
    currentPrice: detail?.price,
    changePct: detail?.changePct,
    prevClose: detail?.prevClose,
    indicators: detail?.indicators,
    priceContext,
    fundamentals,
    patterns: patternData,
    orderBook,
    margin: marginData?.margin
      ? {
          ratioTotal: marginData.margin.ratioTotal,
          longChangeTotal: marginData.margin.longChangeTotal,
          shortChangeTotal: marginData.margin.shortChangeTotal,
          longTotal: marginData.margin.longTotal,
          shortTotal: marginData.margin.shortTotal,
        }
      : null,
    negativeInterest: marginData?.hibu?.rate ?? null,
    volumeRatio: anomaly?.volumeRatio ?? null,
    daysUntilEarnings,
    lastEarningsSurprise: earnings?.lastEarningsSurprise ?? null,
    earningsPattern: earningsPatternRes?.stats
      ? {
          avgPre7d: earningsPatternRes.stats.avgPre7d,
          avgPre3d: earningsPatternRes.stats.avgPre3d,
          avgPost1d: earningsPatternRes.stats.avgPost1d,
          avgPost3d: earningsPatternRes.stats.avgPost3d,
          winRatePre7d: earningsPatternRes.stats.winRatePre7d,
          sampleSize: earningsPatternRes.stats.sampleSize,
          bestSellTiming: earningsPatternRes.insights?.bestSellTiming ?? null,
          bestBuyTiming: earningsPatternRes.insights?.bestBuyTiming ?? null,
        }
      : null,
  };

  const insights = evaluateInsights(input);
  return NextResponse.json({
    ...insights,
    name: detail?.name ?? fundamentals?.name ?? ticker,
    currentPrice: detail?.price ?? null,
    fetchedAt: new Date().toISOString(),
  });
}
