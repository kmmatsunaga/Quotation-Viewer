import { NextRequest, NextResponse } from "next/server";
import { NIKKEI225 } from "@/lib/nikkei225";
import { STOCK_LIST } from "@/lib/stock-list";
import { evaluateUltraShort, type IntradayInput, type UltraShortInsight } from "@/lib/intraday-signals";

/**
 * GET /api/intraday/scan
 *
 * 日経225 + 米国主要銘柄を Yahoo Finance bulk API で取得し、
 * 超短期シグナル (リバウンド候補/反落警戒/ニュース反応) で評価・ランキング。
 *
 * Yahoo v7 quote は1リクエストで100銘柄程度OK。225銘柄を2バッチで処理。
 *
 * クエリ:
 *   universe=nikkei225 (デフォルト) | nikkei225_us
 *   minScore=40        — このスコア以上の銘柄のみ返す (デフォルト40)
 *
 * 認証不要 (個別の詳細は /api/intraday/analyze で取得)
 *
 * パフォーマンス: 約 3-8秒
 */

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json,text/plain,*/*",
};

interface YfQuote {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketChangePercent?: number;
  regularMarketOpen?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  regularMarketPreviousClose?: number;
  averageDailyVolume10Day?: number;
  averageDailyVolume3Month?: number;
}

/**
 * Yahoo v8 chart (range=1d) を 1銘柄ずつ並列で叩いて bulk 風に取得。
 * v7 quote bulk API は Unauthorized で使えなくなったため。
 */
async function fetchYahooChart(symbol: string): Promise<YfQuote | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=false`;
    const res = await fetch(url, { headers: YF_HEADERS, next: { revalidate: 20 } });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta ?? {};
    const quotes = (result.indicators?.quote?.[0] ?? {}) as Record<string, (number | null)[]>;
    const opens = (quotes.open ?? []).filter((v) => v !== null) as number[];
    const highs = (quotes.high ?? []).filter((v) => v !== null) as number[];
    const lows = (quotes.low ?? []).filter((v) => v !== null) as number[];
    const vols = (quotes.volume ?? []).filter((v) => v !== null) as number[];
    const open = opens[0] ?? meta.regularMarketOpen ?? null;
    const high = highs.length > 0 ? Math.max(...highs) : meta.regularMarketDayHigh ?? null;
    const low = lows.length > 0 ? Math.min(...lows) : meta.regularMarketDayLow ?? null;
    const volume = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) : meta.regularMarketVolume ?? null;
    const price = meta.regularMarketPrice ?? null;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const changePct = price && prevClose ? ((price - prevClose) / prevClose) * 100 : undefined;

    return {
      symbol,
      regularMarketPrice: price ?? undefined,
      regularMarketChangePercent: changePct,
      regularMarketOpen: open ?? undefined,
      regularMarketDayHigh: high ?? undefined,
      regularMarketDayLow: low ?? undefined,
      regularMarketVolume: volume ?? undefined,
      regularMarketPreviousClose: prevClose ?? undefined,
      // 平均出来高は meta から取れる場合があるが range=1d だと無いので無視
    };
  } catch {
    return null;
  }
}

async function fetchYahooBulk(symbols: string[]): Promise<YfQuote[]> {
  // 並列で叩く (Yahoo IP レート対策で 10並列まで)
  const PARALLEL = 10;
  const all: YfQuote[] = [];
  for (let i = 0; i < symbols.length; i += PARALLEL) {
    const batch = symbols.slice(i, i + PARALLEL);
    const results = await Promise.all(batch.map(fetchYahooChart));
    for (const r of results) {
      if (r) all.push(r);
    }
  }
  return all;
}

export async function GET(req: NextRequest) {
  const universe = req.nextUrl.searchParams.get("universe") ?? "nikkei225_us";
  const minScore = Number(req.nextUrl.searchParams.get("minScore") ?? "40");
  const startedAt = Date.now();

  // ユニバース構築
  const jpEntries = NIKKEI225.map((s) => ({
    ticker: s.ticker,
    name: s.name,
    market: "JP" as const,
    yfSymbol: `${s.ticker}.T`,
  }));
  const usEntries = STOCK_LIST.filter((s) => s.market === "US").map((s) => ({
    ticker: s.ticker,
    name: s.name,
    market: "US" as const,
    yfSymbol: s.ticker,
  }));
  const includeUS = universe === "nikkei225_us";
  const targets = includeUS ? [...jpEntries, ...usEntries] : jpEntries;

  // Yahoo bulk 取得
  const symbols = targets.map((t) => t.yfSymbol);
  const quotes = await fetchYahooBulk(symbols);
  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));

  // 市場平均変化率 (JP/US 別)
  const jpQuotes = quotes.filter((q) => q.symbol.endsWith(".T"));
  const usQuotes = quotes.filter((q) => !q.symbol.endsWith(".T"));
  const jpMarketCh = average(jpQuotes.map((q) => q.regularMarketChangePercent ?? null));
  const usMarketCh = average(usQuotes.map((q) => q.regularMarketChangePercent ?? null));

  // 評価
  const results: (UltraShortInsight & { name: string; market: "JP" | "US"; price: number | null; volume: number | null; changePct: number | null })[] = [];
  for (const t of targets) {
    const q = quoteMap.get(t.yfSymbol);
    if (!q) continue;
    const marketCh = t.market === "JP" ? jpMarketCh : usMarketCh;
    const avgVol = q.averageDailyVolume10Day ?? q.averageDailyVolume3Month ?? null;
    const input: IntradayInput = {
      ticker: t.ticker,
      currentPrice: q.regularMarketPrice ?? null,
      prevClose: q.regularMarketPreviousClose ?? null,
      open: q.regularMarketOpen ?? null,
      dayHigh: q.regularMarketDayHigh ?? null,
      dayLow: q.regularMarketDayLow ?? null,
      changePct: q.regularMarketChangePercent ?? null,
      vwap: null,             // Yahoo bulk では取れない (B2 で立花から取得)
      volume: q.regularMarketVolume ?? null,
      avgVolume20d: avgVol,
      bidVolume: null,        // 同上
      askVolume: null,
      sector: null,
      sectorChangePct: null,
      marketChangePct: marketCh,
      hasRecentNews: undefined,  // 未取得 (B2 で詳細時にチェック)
    };
    const insight = evaluateUltraShort(input);
    // 興味ある銘柄だけ拾う
    if (
      insight.reboundScore >= minScore ||
      insight.plungeScore >= minScore ||
      insight.newsReactionScore >= minScore
    ) {
      results.push({
        ...insight,
        name: t.name,
        market: t.market,
        price: q.regularMarketPrice ?? null,
        volume: q.regularMarketVolume ?? null,
        changePct: q.regularMarketChangePercent ?? null,
      });
    }
  }

  // カテゴリ別に整理
  const rebounds = results
    .filter((r) => r.overallSignal === "buy_rebound")
    .sort((a, b) => b.reboundScore - a.reboundScore);
  const overheats = results
    .filter((r) => r.overallSignal === "sell_overheat")
    .sort((a, b) => b.plungeScore - a.plungeScore);
  const newsActive = results
    .filter((r) => r.overallSignal === "hold_news_active")
    .sort((a, b) => b.newsReactionScore - a.newsReactionScore);
  const others = results
    .filter((r) => !["buy_rebound", "sell_overheat", "hold_news_active"].includes(r.overallSignal))
    .sort((a, b) => b.overallScore - a.overallScore);

  return NextResponse.json({
    ok: true,
    universe,
    computedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    marketAvg: { jp: jpMarketCh, us: usMarketCh },
    counts: {
      total: targets.length,
      processed: quotes.length,
      rebounds: rebounds.length,
      overheats: overheats.length,
      newsActive: newsActive.length,
      others: others.length,
    },
    rebounds,
    overheats,
    newsActive,
    others,
  });
}

function average(arr: (number | null)[]): number | null {
  const filtered = arr.filter((n): n is number => n !== null && Number.isFinite(n));
  if (filtered.length === 0) return null;
  return filtered.reduce((a, b) => a + b, 0) / filtered.length;
}
