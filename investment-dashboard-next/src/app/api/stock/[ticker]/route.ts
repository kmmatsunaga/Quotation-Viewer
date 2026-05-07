import { NextRequest, NextResponse } from "next/server";

const YF_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

/**
 * GET /api/stock/[ticker]?range=6mo&interval=1d
 *
 * Yahoo Finance v8 chart API をプロキシして
 * 株価 + OHLCV チャートデータを返す。
 * 将来的に立花証券 API に差し替え可能。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker: rawTicker } = await params;
  const range = req.nextUrl.searchParams.get("range") ?? "6mo";
  const interval = req.nextUrl.searchParams.get("interval") ?? "1d";

  // 日本株は .T サフィックスが必要
  const isJP = /^\d{4}$/.test(rawTicker);
  const yfTicker = isJP ? `${rawTicker}.T` : rawTicker;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      yfTicker
    )}?range=${range}&interval=${interval}&includePrePost=false&lang=ja`;

    const res = await fetch(url, {
      headers: YF_HEADERS,
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: "Failed to fetch stock data" },
        { status: res.status }
      );
    }

    const json = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) {
      return NextResponse.json(
        { error: "No data found" },
        { status: 404 }
      );
    }

    const meta = result.meta;
    const timestamps = result.timestamp ?? [];
    const quote = result.indicators?.quote?.[0] ?? {};

    // 現在価格
    const price = meta.regularMarketPrice ?? 0;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
    const change = price - prevClose;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;

    // OHLCVデータ
    const candles = timestamps
      .map((t: number, i: number) => {
        const o = quote.open?.[i];
        const h = quote.high?.[i];
        const l = quote.low?.[i];
        const c = quote.close?.[i];
        const v = quote.volume?.[i];
        if (o == null || h == null || l == null || c == null) return null;
        return {
          time: new Date(t * 1000).toISOString().slice(0, 10),
          open: Math.round(o * 100) / 100,
          high: Math.round(h * 100) / 100,
          low: Math.round(l * 100) / 100,
          close: Math.round(c * 100) / 100,
          volume: v ?? 0,
        };
      })
      .filter(Boolean);

    // 重複日付を除去（最後の値を採用）
    const seen = new Map();
    for (const c of candles) {
      seen.set(c.time, c);
    }
    const uniqueCandles = Array.from(seen.values());

    // テクニカル指標を計算
    const closes = uniqueCandles.map(
      (c: { close: number }) => c.close
    );
    const indicators = calcIndicators(closes);

    return NextResponse.json({
      ticker: rawTicker,
      name: meta.shortName ?? meta.longName ?? rawTicker,
      currency: meta.currency ?? (isJP ? "JPY" : "USD"),
      exchange: meta.exchangeName ?? "",
      price,
      prevClose,
      change: Math.round(change * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
      dayHigh: meta.regularMarketDayHigh ?? null,
      dayLow: meta.regularMarketDayLow ?? null,
      volume: meta.regularMarketVolume ?? null,
      marketCap: null,
      candles: uniqueCandles,
      indicators,
    });
  } catch (err) {
    console.error("Stock API error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// =============================================
// テクニカル指標の計算
// =============================================
function calcIndicators(closes: number[]) {
  const n = closes.length;
  if (n < 20)
    return {
      rsi: null,
      macd: null,
      signal: null,
      sma20: null,
      sma50: null,
      sma200: null,
      bbUpper: null,
      bbLower: null,
    };

  // SMA
  const sma = (data: number[], period: number) => {
    if (data.length < period) return null;
    const slice = data.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  };

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);

  // RSI (14)
  let gains = 0,
    losses = 0;
  const period = 14;
  for (let i = n - period; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi = Math.round((100 - 100 / (1 + rs)) * 10) / 10;

  // EMA helper
  const ema = (data: number[], emaPeriod: number) => {
    const k = 2 / (emaPeriod + 1);
    let val = data[0];
    for (let i = 1; i < data.length; i++) {
      val = data[i] * k + val * (1 - k);
    }
    return val;
  };

  // MACD (12, 26, 9)
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdVal = Math.round((ema12 - ema26) * 100) / 100;

  // MACD signal line (9-period EMA of MACD line)
  // Simplified: compute MACD over last ~35 bars
  const macdLine: number[] = [];
  for (let i = 26; i < n; i++) {
    const e12 = ema(closes.slice(0, i + 1), 12);
    const e26 = ema(closes.slice(0, i + 1), 26);
    macdLine.push(e12 - e26);
  }
  const signalVal =
    macdLine.length >= 9
      ? Math.round(ema(macdLine, 9) * 100) / 100
      : null;

  // Bollinger Bands (20)
  let bbUpper = null,
    bbLower = null;
  if (sma20 && n >= 20) {
    const slice20 = closes.slice(-20);
    const std = Math.sqrt(
      slice20.reduce((sum, v) => sum + (v - sma20) ** 2, 0) / 20
    );
    bbUpper = Math.round((sma20 + 2 * std) * 100) / 100;
    bbLower = Math.round((sma20 - 2 * std) * 100) / 100;
  }

  return {
    rsi,
    macd: macdVal,
    signal: signalVal,
    sma20: sma20 ? Math.round(sma20 * 100) / 100 : null,
    sma50: sma50 ? Math.round(sma50 * 100) / 100 : null,
    sma200: sma200 ? Math.round(sma200 * 100) / 100 : null,
    bbUpper,
    bbLower,
  };
}
