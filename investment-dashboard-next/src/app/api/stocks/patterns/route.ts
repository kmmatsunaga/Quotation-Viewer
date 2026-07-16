import { NextRequest, NextResponse } from "next/server";
import {
  detectPattern,
  toWeeklyCandles,
  toMonthlyCandles,
  getPatternTransitions,
  evaluateTransitionProximity,
  extractFeatures,
  type Candle,
} from "@/lib/chart-patterns";

const YF_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

/**
 * GET /api/stocks/patterns?tickers=7203,AAPL,4062
 *
 * 複数銘柄のチャートパターンを判定して返す。
 * 各銘柄について日足・週足・月足のパターンを返す。
 * 内部で Yahoo Finance から 2年分の日足データを取得し、
 * 週足・月足に集約してパターンを判定する。
 */
export async function GET(req: NextRequest) {
  const tickersParam = req.nextUrl.searchParams.get("tickers") ?? "";
  const tickers = tickersParam
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (tickers.length === 0) {
    return NextResponse.json({ patterns: {} });
  }

  // Limit to 20 tickers per request
  const limitedTickers = tickers.slice(0, 20);

  try {
    const results = await Promise.allSettled(
      limitedTickers.map(async (ticker) => {
        const isJP = /^\d{3,4}[A-Z]?$/.test(ticker);
        const yfTicker = isJP ? `${ticker}.T` : ticker;

        // Fetch 2 years of daily data (enough for monthly MA75)
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
          yfTicker
        )}?range=2y&interval=1d&includePrePost=false`;

        const res = await fetch(url, {
          headers: YF_HEADERS,
          next: { revalidate: 300 }, // cache for 5 minutes
        });

        if (!res.ok) return { ticker, patterns: null };

        const json = await res.json();
        const result = json.chart?.result?.[0];
        if (!result) return { ticker, patterns: null };

        const timestamps: number[] = result.timestamp ?? [];
        const quote = result.indicators?.quote?.[0] ?? {};
        const meta = result.meta;

        // Build candle array
        const dailyCandles: Candle[] = [];
        for (let i = 0; i < timestamps.length; i++) {
          const o = quote.open?.[i];
          const h = quote.high?.[i];
          const l = quote.low?.[i];
          const c = quote.close?.[i];
          const v = quote.volume?.[i];
          if (o == null || h == null || l == null || c == null) continue;
          dailyCandles.push({
            time: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
            open: Math.round(o * 100) / 100,
            high: Math.round(h * 100) / 100,
            low: Math.round(l * 100) / 100,
            close: Math.round(c * 100) / 100,
            volume: v ?? 0,
          });
        }

        // Deduplicate by time
        const seen = new Map<string, Candle>();
        for (const c of dailyCandles) {
          seen.set(c.time as string, c);
        }
        const uniqueDaily = Array.from(seen.values());

        // Detect patterns per timeframe
        const weeklyCandles = toWeeklyCandles(uniqueDaily);
        const monthlyCandles = toMonthlyCandles(uniqueDaily);

        const daily = detectPattern(uniqueDaily, "daily");
        const weekly = detectPattern(weeklyCandles, "weekly");
        const monthly = detectPattern(monthlyCandles, "monthly");

        // Compute transitions for the top daily pattern
        let transitions = null;
        if (daily.length > 0) {
          const topId = daily[0].pattern.id;
          const dailyFeatures = extractFeatures(uniqueDaily);
          const rawTransitions = getPatternTransitions(topId);
          if (dailyFeatures && rawTransitions.length > 0) {
            transitions = rawTransitions.map((t) => ({
              ...t,
              proximity: evaluateTransitionProximity(dailyFeatures, t),
            }));
          }
        }

        return {
          ticker,
          name: meta?.shortName ?? meta?.longName ?? ticker,
          patterns: {
            daily: daily.map(simplify),
            weekly: weekly.map(simplify),
            monthly: monthly.map(simplify),
          },
          transitions,
        };
      })
    );

    const patterns: Record<string, unknown> = {};
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        patterns[r.value.ticker] = {
          name: r.value.name,
          patterns: r.value.patterns,
          transitions: r.value.transitions,
        };
      }
    }

    return NextResponse.json({ patterns });
  } catch (err) {
    console.error("Pattern detection error:", err);
    return NextResponse.json(
      { patterns: {}, error: "Failed to detect patterns" },
      { status: 500 }
    );
  }
}

/**
 * Simplify DetectedPattern for JSON response (remove heavy features).
 */
function simplify(d: {
  pattern: { id: string; label: string; labelEn: string; description: string; signal: string; strength: number; direction: string; phase: string };
  confidence: number;
  features: { maValues: unknown; maSlopes: unknown; maOrder: string; roc5: number; roc20: number; close: number };
  timeframe: string;
}) {
  return {
    id: d.pattern.id,
    label: d.pattern.label,
    labelEn: d.pattern.labelEn,
    description: d.pattern.description,
    signal: d.pattern.signal,
    strength: d.pattern.strength,
    direction: d.pattern.direction,
    phase: d.pattern.phase,
    confidence: d.confidence,
    timeframe: d.timeframe,
    summary: {
      maOrder: d.features.maOrder,
      maSlopes: d.features.maSlopes,
      roc5: d.features.roc5,
      roc20: d.features.roc20,
      close: d.features.close,
    },
  };
}
