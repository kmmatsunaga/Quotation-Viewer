import { NextResponse } from "next/server";

/**
 * GET /api/market/indices
 *
 * 日経平均 / TOPIX / S&P500 / NASDAQ の主要指数データを返す。
 * Yahoo Finance v8 chart API から直接取得。
 */

const YF_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

const INDICES = [
  { yf: "^N225", name: "日経平均", display: "日経平均" },
  { yf: "^TOPX", name: "TOPIX", display: "TOPIX" },
  { yf: "^GSPC", name: "S&P 500", display: "S&P 500" },
  { yf: "^IXIC", name: "NASDAQ", display: "NASDAQ" },
];

export interface IndexCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface IndexData {
  name: string;
  value: number;
  change: number;
  change_pct: number;
  chart_data: number[];  // 簡易スパークライン
  candles: IndexCandle[];
}

export async function GET() {
  try {
    const results = await Promise.allSettled(
      INDICES.map(async (idx) => {
        // 1日分の5分足
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
          idx.yf
        )}?range=1d&interval=5m`;
        const res = await fetch(url, {
          headers: YF_HEADERS,
          next: { revalidate: 60 },
        });
        if (!res.ok) return null;
        const json = await res.json();
        const result = json.chart?.result?.[0];
        if (!result) return null;

        const meta = result.meta;
        const timestamps: number[] = result.timestamp ?? [];
        const quote = result.indicators?.quote?.[0] ?? {};
        const closes = (quote.close ?? []) as (number | null)[];

        // 有効なclose値だけ
        const validCloses = closes
          .map((c, i) => (c != null ? { c, i } : null))
          .filter((x) => x !== null) as { c: number; i: number }[];

        if (validCloses.length === 0) return null;

        const lastClose = validCloses[validCloses.length - 1].c;
        const value = meta.regularMarketPrice ?? lastClose;
        const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? value;
        const change = value - prevClose;
        const change_pct = prevClose ? (change / prevClose) * 100 : 0;

        // スパークライン用 (最大20点に間引き)
        const step = Math.max(1, Math.floor(validCloses.length / 20));
        const sparkline = validCloses
          .filter((_, i) => i % step === 0)
          .map((x) => x.c);

        // チャート用キャンドル
        const candles: IndexCandle[] = [];
        for (let i = 0; i < timestamps.length; i++) {
          const o = quote.open?.[i];
          const h = quote.high?.[i];
          const l = quote.low?.[i];
          const c = quote.close?.[i];
          if (o == null || h == null || l == null || c == null) continue;
          candles.push({
            time: new Date(timestamps[i] * 1000).toISOString(),
            open: o,
            high: h,
            low: l,
            close: c,
          });
        }

        return {
          name: idx.display,
          value: Math.round(value * 100) / 100,
          change: Math.round(change * 100) / 100,
          change_pct: Math.round(change_pct * 100) / 100,
          chart_data: sparkline,
          candles,
          // ホームページが期待しているエイリアス
          price: Math.round(value * 100) / 100,
          chart: candles,
        } satisfies IndexData & { price: number; chart: typeof candles };
      })
    );

    const indices = results
      .filter((r): r is PromiseFulfilledResult<IndexData & { price: number; chart: IndexCandle[] }> =>
        r.status === "fulfilled" && r.value !== null)
      .map((r) => r.value);

    return NextResponse.json(indices);
  } catch (err) {
    console.error("Indices fetch error:", err);
    return NextResponse.json([], { status: 500 });
  }
}
