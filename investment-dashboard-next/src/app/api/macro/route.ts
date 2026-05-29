import { NextResponse } from "next/server";

/**
 * GET /api/macro
 *
 * マクロ指標 (為替/金利/コモディティ/恐怖指数/主要指数) を 1 ハンドラで取得。
 * Yahoo v8 chart を並列叩き。
 */

const YF_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json,text/plain,*/*",
};

interface MacroItem {
  key: string;
  label: string;
  category: "fx" | "rate" | "commodity" | "fear" | "index";
  unit: string;
  symbol: string;
  price: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  ts: number | null;
}

const MACRO_LIST: { key: string; label: string; category: MacroItem["category"]; unit: string; symbol: string }[] = [
  // FX
  { key: "usdjpy", label: "USD/JPY", category: "fx", unit: "¥/$", symbol: "JPY=X" },
  { key: "eurjpy", label: "EUR/JPY", category: "fx", unit: "¥/€", symbol: "EURJPY=X" },
  { key: "eurusd", label: "EUR/USD", category: "fx", unit: "$/€", symbol: "EURUSD=X" },
  { key: "gbpjpy", label: "GBP/JPY", category: "fx", unit: "¥/£", symbol: "GBPJPY=X" },
  // 金利
  { key: "us10y", label: "US 10Y 利回り", category: "rate", unit: "%", symbol: "^TNX" },
  { key: "us30y", label: "US 30Y 利回り", category: "rate", unit: "%", symbol: "^TYX" },
  { key: "us2y", label: "US 2Y 利回り", category: "rate", unit: "%", symbol: "^IRX" },
  // コモディティ
  { key: "wti", label: "WTI 原油", category: "commodity", unit: "$/bbl", symbol: "CL=F" },
  { key: "gold", label: "金 (Gold)", category: "commodity", unit: "$/oz", symbol: "GC=F" },
  { key: "silver", label: "銀 (Silver)", category: "commodity", unit: "$/oz", symbol: "SI=F" },
  { key: "copper", label: "銅 (Copper)", category: "commodity", unit: "$/lb", symbol: "HG=F" },
  // 恐怖指数
  { key: "vix", label: "VIX (恐怖指数)", category: "fear", unit: "", symbol: "^VIX" },
  // 主要指数
  { key: "nikkei", label: "日経平均", category: "index", unit: "", symbol: "^N225" },
  { key: "topix", label: "TOPIX", category: "index", unit: "", symbol: "1306.T" },
  { key: "sp500", label: "S&P 500", category: "index", unit: "", symbol: "^GSPC" },
  { key: "nasdaq", label: "NASDAQ", category: "index", unit: "", symbol: "^IXIC" },
  { key: "dow", label: "NYダウ", category: "index", unit: "", symbol: "^DJI" },
];

async function fetchYahooChart(symbol: string): Promise<{ price: number | null; prev: number | null; ts: number | null }> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    const res = await fetch(url, { headers: YF_HEADERS, next: { revalidate: 60 } });
    if (!res.ok) return { price: null, prev: null, ts: null };
    const json = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) return { price: null, prev: null, ts: null };
    const meta = result.meta ?? {};
    return {
      price: meta.regularMarketPrice ?? null,
      prev: meta.chartPreviousClose ?? meta.previousClose ?? null,
      ts: meta.regularMarketTime ?? null,
    };
  } catch {
    return { price: null, prev: null, ts: null };
  }
}

export async function GET() {
  // 並列取得
  const results = await Promise.all(
    MACRO_LIST.map(async (m) => {
      const yf = await fetchYahooChart(m.symbol);
      const change = yf.price !== null && yf.prev !== null ? yf.price - yf.prev : null;
      const changePct = yf.price !== null && yf.prev !== null && yf.prev !== 0
        ? ((yf.price - yf.prev) / yf.prev) * 100
        : null;
      const item: MacroItem = {
        ...m,
        price: yf.price,
        prevClose: yf.prev,
        change: change !== null ? Math.round(change * 1000) / 1000 : null,
        changePct: changePct !== null ? Math.round(changePct * 100) / 100 : null,
        ts: yf.ts,
      };
      return item;
    })
  );

  // カテゴリ別に整理
  const byCategory: Record<string, MacroItem[]> = {};
  for (const item of results) {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item);
  }

  return NextResponse.json({
    ok: true,
    computedAt: new Date().toISOString(),
    categories: byCategory,
    all: results,
  });
}
