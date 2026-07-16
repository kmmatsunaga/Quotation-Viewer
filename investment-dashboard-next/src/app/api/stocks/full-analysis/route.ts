import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/stocks/full-analysis?ticker=7203
 * Header: x-api-key: <MCP_API_KEY>
 *
 * 指定銘柄について「買うべき・買わないべき」の判断に必要な
 * 全情報をまとめて返す。MCPの analyze_stock ツールから呼ばれる。
 *
 * 内部で以下を並列取得:
 *   - 株価・テクニカル指標 (/api/stock/[ticker])
 *   - ファンダメンタル (/api/stocks/fundamentals)
 *   - チャートパターン (/api/stocks/patterns)
 *   - ユーザーのコンテキスト (保有・シナリオ・お気に入り) (/api/portfolio)
 */

const API_KEY = process.env.MCP_API_KEY;
const BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "http://localhost:3001";

async function safeJson(url: string, headers: Record<string, string> = {}) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Cavka-FullAnalysis/1.0", ...headers },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  if (!API_KEY) {
    return NextResponse.json({ error: "MCP_API_KEY not set" }, { status: 500 });
  }
  if (req.headers.get("x-api-key") !== API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ticker = req.nextUrl.searchParams.get("ticker")?.trim();
  if (!ticker) {
    return NextResponse.json({ error: "ticker required" }, { status: 400 });
  }

  // host を req から取得（dev/prodどちらでも動くように）
  const host = req.headers.get("host") ?? "localhost:3001";
  const proto = host.includes("localhost") ? "http" : "https";
  const origin = `${proto}://${host}`;

  const authHeader = { "x-api-key": API_KEY };

  // 並列取得
  const [detail, fundRes, patternRes, portfolio] = await Promise.all([
    safeJson(`${origin}/api/stock/${encodeURIComponent(ticker)}?range=6mo&interval=1d`),
    safeJson(`${origin}/api/stocks/fundamentals?tickers=${encodeURIComponent(ticker)}`),
    safeJson(`${origin}/api/stocks/patterns?tickers=${encodeURIComponent(ticker)}`),
    safeJson(`${origin}/api/portfolio?email=make.some.noise6984@gmail.com&section=all`, authHeader),
  ]);

  // ファンダメンタル抽出
  const fundamentals = fundRes?.fundamentals?.[ticker] ?? null;

  // パターン抽出
  const patternData = patternRes?.patterns?.[ticker] ?? null;

  // 保有 / お気に入り / シナリオ コンテキスト
  const holdings = portfolio?.holdings ?? [];
  const watchlist = portfolio?.watchlist ?? [];
  const scenarios = portfolio?.scenarios ?? [];

  const ownsThisStock = holdings.find(
    (h: Record<string, unknown>) => h.ticker === ticker
  );
  const inWatchlist = watchlist.some(
    (w: Record<string, unknown>) => w.ticker === ticker
  );
  const existingScenarios = scenarios.filter(
    (s: Record<string, unknown>) => s.ticker === ticker
  );

  // セクター集中度（ファンダ取れた場合のみ）
  let sectorConcentration = null;
  if (fundamentals?.sector && holdings.length > 0) {
    // 各保有銘柄のセクター情報も必要だが、簡易版として銘柄数ベースで返す
    sectorConcentration = {
      thisSector: fundamentals.sector,
      totalHoldings: holdings.length,
    };
  }

  // チャートの直近のサマリ（過去6か月の高値・安値・現在位置）
  let priceContext = null;
  if (detail?.candles && detail.candles.length > 0) {
    const candles = detail.candles as Array<{ high: number; low: number; close: number }>;
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const high6m = Math.max(...highs);
    const low6m = Math.min(...lows);
    const currentPrice = detail.price;
    const range = high6m - low6m;
    const positionInRange = range > 0 ? ((currentPrice - low6m) / range) * 100 : 50;
    priceContext = {
      high6m,
      low6m,
      currentPrice,
      positionInRange: Math.round(positionInRange),  // 0=底, 100=天井
      fromHigh: ((currentPrice - high6m) / high6m) * 100,
      fromLow: ((currentPrice - low6m) / low6m) * 100,
    };
  }

  return NextResponse.json({
    ticker,
    name: detail?.name ?? fundamentals?.name ?? ticker,
    fetchedAt: new Date().toISOString(),

    // 価格・テクニカル
    price: detail ? {
      current: detail.price,
      change: detail.change,
      changePct: detail.changePct,
      dayHigh: detail.dayHigh,
      dayLow: detail.dayLow,
      volume: detail.volume,
      currency: detail.currency,
    } : null,

    indicators: detail?.indicators ?? null,
    priceContext,

    // ファンダメンタル
    fundamentals,

    // チャートパターン
    patterns: patternData?.patterns ?? null,
    patternTransitions: patternData?.transitions ?? null,

    // ユーザーコンテキスト
    userContext: {
      ownsThisStock: ownsThisStock ?? null,
      inWatchlist,
      existingScenarios,
      totalHoldingsCount: holdings.length,
      sectorConcentration,
    },
  });
}
