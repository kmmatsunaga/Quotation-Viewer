import { NextRequest, NextResponse } from "next/server";

const YF_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

/**
 * GET /api/stocks/prices?tickers=7203,AAPL,4062
 *
 * 複数銘柄の現在価格をバッチ取得。
 * 加えて USDJPY 為替レートも返す。
 */
export async function GET(req: NextRequest) {
  const tickersParam = req.nextUrl.searchParams.get("tickers") ?? "";
  const tickers = tickersParam
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (tickers.length === 0) {
    return NextResponse.json({ prices: {}, usdJpy: null });
  }

  // Yahoo Finance用のティッカーに変換
  const yfTickers = tickers.map((t) => {
    const isJP = /^\d{4}$/.test(t);
    return { original: t, yf: isJP ? `${t}.T` : t, isJP };
  });

  // USDJPY も含めて全部取得
  const allYfTickers = [
    ...yfTickers.map((t) => t.yf),
    "USDJPY=X",
  ];

  try {
    // 並列でリクエスト（Yahoo Finance v8 chart API, range=1d で最新価格取得）
    const results = await Promise.allSettled(
      allYfTickers.map(async (yfTicker) => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
          yfTicker
        )}?range=1d&interval=1d&includePrePost=false`;
        const res = await fetch(url, {
          headers: YF_HEADERS,
          next: { revalidate: 30 },
        });
        if (!res.ok) return null;
        const json = await res.json();
        const meta = json.chart?.result?.[0]?.meta;
        if (!meta) return null;
        return {
          yfTicker,
          price: meta.regularMarketPrice ?? 0,
          prevClose: meta.chartPreviousClose ?? meta.previousClose ?? 0,
          currency: meta.currency ?? "JPY",
        };
      })
    );

    // 結果をマッピング
    const prices: Record<
      string,
      { price: number; prevClose: number; change: number; changePct: number; currency: string }
    > = {};

    let usdJpy: number | null = null;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status !== "fulfilled" || !result.value) continue;

      const { yfTicker, price, prevClose, currency } = result.value;

      if (yfTicker === "USDJPY=X") {
        usdJpy = price;
        continue;
      }

      // 元のティッカーを探す
      const mapping = yfTickers.find((t) => t.yf === yfTicker);
      if (!mapping) continue;

      const change = price - prevClose;
      const changePct = prevClose ? (change / prevClose) * 100 : 0;

      prices[mapping.original] = {
        price: Math.round(price * 100) / 100,
        prevClose: Math.round(prevClose * 100) / 100,
        change: Math.round(change * 100) / 100,
        changePct: Math.round(changePct * 100) / 100,
        currency,
      };
    }

    return NextResponse.json({ prices, usdJpy });
  } catch (err) {
    console.error("Batch price fetch error:", err);
    return NextResponse.json(
      { prices: {}, usdJpy: null, error: "Failed to fetch prices" },
      { status: 500 }
    );
  }
}
