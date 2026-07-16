import { NextRequest, NextResponse } from "next/server";

const JP_TOP_STOCKS = [
  { code: "7203", name: "トヨタ自動車" },
  { code: "6758", name: "ソニーG" },
  { code: "6861", name: "キーエンス" },
  { code: "8306", name: "三菱UFJ" },
  { code: "9984", name: "ソフトバンクG" },
  { code: "9432", name: "NTT" },
  { code: "6098", name: "リクルートHD" },
];

export async function GET(req: NextRequest) {
  try {
    const tickers = JP_TOP_STOCKS.map((s) => s.code).join(",");
    const host = req.headers.get("host") ?? "localhost:3000";
    const proto = host.includes("localhost") ? "http" : "https";
    const origin = `${proto}://${host}`;
    const res = await fetch(`${origin}/api/stocks/prices?tickers=${tickers}`, {
      next: { revalidate: 60 },
    });
    const data = await res.json();
    const prices = data.prices ?? {};
    const result = JP_TOP_STOCKS.map((s) => {
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
    console.error("JP stocks error:", err);
    return NextResponse.json([], { status: 500 });
  }
}
