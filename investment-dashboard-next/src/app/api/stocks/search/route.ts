import { NextRequest, NextResponse } from "next/server";

/**
 * Yahoo Finance の検索 API をプロキシ
 * GET /api/stocks/search?q=イビデン
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) {
    return NextResponse.json([]);
  }

  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
      q
    )}&lang=ja&region=JP&quotesCount=10&newsCount=0&listsCount=0&enableFuzzyQuery=false&quotesQueryId=tss_match_phrase_query`;

    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      next: { revalidate: 300 }, // 5分キャッシュ
    });

    if (!res.ok) {
      console.error("Yahoo Finance search failed:", res.status);
      return NextResponse.json([]);
    }

    const data = await res.json();
    const quotes = (data.quotes ?? [])
      .filter(
        (q: Record<string, unknown>) =>
          q.quoteType === "EQUITY" || q.quoteType === "ETF"
      )
      .map((q: Record<string, unknown>) => {
        const symbol = String(q.symbol ?? "");
        const isJP = symbol.endsWith(".T");
        return {
          ticker: isJP ? symbol.replace(".T", "") : symbol,
          name: String(q.shortname ?? q.longname ?? symbol),
          market: isJP ? "JP" : "US",
          exchange: String(q.exchange ?? ""),
          type: String(q.quoteType ?? ""),
        };
      });

    return NextResponse.json(quotes);
  } catch (err) {
    console.error("Stock search error:", err);
    return NextResponse.json([]);
  }
}
