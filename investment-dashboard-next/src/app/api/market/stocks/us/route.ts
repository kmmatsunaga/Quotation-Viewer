import { NextRequest, NextResponse } from "next/server";

const US_TOP_STOCKS = [
  { code: "AAPL", name: "Apple" },
  { code: "MSFT", name: "Microsoft" },
  { code: "NVDA", name: "NVIDIA" },
  { code: "GOOGL", name: "Alphabet" },
  { code: "AMZN", name: "Amazon" },
  { code: "META", name: "Meta" },
  { code: "TSLA", name: "Tesla" },
];

export async function GET(req: NextRequest) {
  try {
    const tickers = US_TOP_STOCKS.map((s) => s.code).join(",");
    const host = req.headers.get("host") ?? "localhost:3000";
    const proto = host.includes("localhost") ? "http" : "https";
    const origin = `${proto}://${host}`;
    const res = await fetch(`${origin}/api/stocks/prices?tickers=${tickers}`, {
      next: { revalidate: 60 },
    });
    const data = await res.json();
    const prices = data.prices ?? {};
    const result = US_TOP_STOCKS.map((s) => {
      const p = prices[s.code];
      return {
        code: s.code,
        name: s.name,
        price: p?.price ?? 0,
        change: p?.change ?? 0,
        change_pct: p?.changePct ?? 0,
      };
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error("US stocks error:", err);
    return NextResponse.json([], { status: 500 });
  }
}
