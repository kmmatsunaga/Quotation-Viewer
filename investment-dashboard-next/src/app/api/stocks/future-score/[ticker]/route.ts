import { NextRequest, NextResponse } from "next/server";
import { evaluateFutureScore, type SentimentInput, type DisclosureInput } from "@/lib/future-score";
import { fetchAnalystData } from "@/lib/analyst-data";
import { getAdminDb } from "@/lib/firebase-admin";
import type { InsightInput } from "@/lib/insights-engine";

const SENTIMENT_STALE_HOURS = 36;

/**
 * sentiment_{ticker} レコードから sentiment + disclosures をまとめて取得
 * (両者は同じ Firestore ドキュメントに保存されている)
 */
async function fetchSentimentAndDisclosures(ticker: string): Promise<{ sentiment: SentimentInput | null; disclosures: DisclosureInput | null }> {
  try {
    const db = getAdminDb();
    const snap = await db.collection("meta").doc(`sentiment_${ticker}`).get();
    if (!snap.exists) return { sentiment: null, disclosures: null };
    const data = snap.data();
    if (!data) return { sentiment: null, disclosures: null };
    const computedAt =
      data.computedAt?.toDate?.()?.toISOString?.() ?? data.computedAtIso ?? null;
    if (!computedAt) return { sentiment: null, disclosures: null };
    const stale = Date.now() - new Date(computedAt).getTime() > SENTIMENT_STALE_HOURS * 3600 * 1000;
    const sentiment: SentimentInput = {
      finalScore: data.finalScore ?? 0,
      label: data.label ?? "neutral",
      articleCount: data.articleCount ?? 0,
      avgSentiment: data.avgSentiment ?? 0,
      diffusionCoef: data.diffusionCoef ?? 0,
      computedAt,
      stale,
    };
    const disclosures: DisclosureInput | null = data.disclosures ?? null;
    return { sentiment, disclosures };
  } catch {
    return { sentiment: null, disclosures: null };
  }
}

/**
 * GET /api/stocks/future-score/[ticker]
 *
 * Phase 1: 5因子グレード + 最弱因子キャップ + バリュートラップ警告
 *
 * 内部で /api/stock/[ticker] (チャート+テクニカル) と
 * /api/stocks/fundamentals (ファンダ) を並列取得し、
 * InsightInput を構築して evaluateFutureScore() に渡す。
 *
 * Phase 2 以降で Yahoo の earningsTrend / recommendationTrend を追加予定。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker: rawTicker } = await params;
  const ticker = rawTicker.trim();
  if (!ticker) {
    return NextResponse.json({ error: "ticker is required" }, { status: 400 });
  }

  // ベース URL (内部 fetch 用)
  const host = req.headers.get("host") ?? "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const base = `${proto}://${host}`;

  try {
    // 並列取得 (Phase 2 + Phase 3a + Phase 4: アナリスト + センチメント + 適時開示)
    const [stockRes, fundRes, analystResult, cacheResult] = await Promise.allSettled([
      fetch(`${base}/api/stock/${encodeURIComponent(ticker)}?range=6mo&interval=1d`, {
        next: { revalidate: 60 },
      }),
      fetch(`${base}/api/stocks/fundamentals?tickers=${encodeURIComponent(ticker)}`, {
        next: { revalidate: 600 },
      }),
      fetchAnalystData(ticker),
      fetchSentimentAndDisclosures(ticker),
    ]);

    type StockResp = {
      ticker?: string;
      name?: string;
      price?: number;
      prevClose?: number;
      change?: number;
      changePct?: number;
      candles?: { time: string | number; open: number; high: number; low: number; close: number; volume: number }[];
      indicators?: InsightInput["indicators"];
    };
    type FundResp = {
      fundamentals?: Record<string, {
        trailingPE: number | null;
        forwardPE: number | null;
        pbr: number | null;
        pegRatio: number | null;
        roe: number | null;
        operatingMargin: number | null;
        profitMargin: number | null;
        debtToEquity: number | null;
        revenueGrowth: number | null;
        earningsGrowth: number | null;
        dividendYield: number | null;
        payoutRatio: number | null;
        netCash: number | null;
        sector: string | null;
      }>;
    };

    let stockData: StockResp | null = null;
    let fundData: FundResp | null = null;
    const analyst = analystResult.status === "fulfilled" ? analystResult.value : null;
    const cache = cacheResult.status === "fulfilled" ? cacheResult.value : { sentiment: null, disclosures: null };
    const sentiment = cache.sentiment;
    const disclosures = cache.disclosures;

    if (stockRes.status === "fulfilled" && stockRes.value.ok) {
      stockData = await stockRes.value.json();
    }
    if (fundRes.status === "fulfilled" && fundRes.value.ok) {
      fundData = await fundRes.value.json();
    }

    // 6mレンジ位置と ROC20 を candles から計算
    let priceContext: InsightInput["priceContext"] = null;
    let roc20: number | null = null;
    if (stockData?.candles && stockData.candles.length >= 21) {
      const closes = stockData.candles.map((c) => c.close);
      const high6m = Math.max(...closes);
      const low6m = Math.min(...closes);
      const current = closes[closes.length - 1];
      const positionInRange = high6m === low6m ? 50 : Math.round(((current - low6m) / (high6m - low6m)) * 100);
      priceContext = { high6m, low6m, positionInRange };
      const past20 = closes[closes.length - 21];
      if (past20 > 0) roc20 = Math.round(((current - past20) / past20) * 100 * 10) / 10;
    }

    // ファンダを抜き出す
    const fundKey = Object.keys(fundData?.fundamentals ?? {})[0];
    const f = fundKey ? fundData!.fundamentals![fundKey] : null;

    const input: InsightInput = {
      ticker,
      currentPrice: stockData?.price ?? null,
      changePct: stockData?.changePct ?? null,
      prevClose: stockData?.prevClose ?? null,
      indicators: stockData?.indicators ?? null,
      priceContext,
      fundamentals: f
        ? {
            trailingPE: f.trailingPE,
            forwardPE: f.forwardPE,
            pbr: f.pbr,
            pegRatio: f.pegRatio,
            roe: f.roe,
            operatingMargin: f.operatingMargin,
            profitMargin: f.profitMargin,
            debtToEquity: f.debtToEquity,
            revenueGrowth: f.revenueGrowth,
            earningsGrowth: f.earningsGrowth,
            dividendYield: f.dividendYield,
            payoutRatio: f.payoutRatio,
            netCash: f.netCash,
            sector: f.sector,
          }
        : null,
      // ROC20 を patterns.daily に差し込む (insights-engine と同じ参照路を future-score も使うため)
      patterns: roc20 !== null
        ? { daily: [{ label: "", signal: "", confidence: 0, direction: "", strength: 0, summary: { roc20 } }] }
        : null,
    };

    const result = evaluateFutureScore(input, analyst, sentiment, disclosures);

    const { ticker: _omit, ...resultBody } = result;
    void _omit;
    return NextResponse.json({
      ticker,
      name: stockData?.name ?? ticker,
      price: stockData?.price ?? null,
      ...resultBody,
      _meta: {
        dataSources: {
          stock: stockRes.status === "fulfilled" && stockRes.value.ok,
          fundamentals: fundRes.status === "fulfilled" && fundRes.value.ok,
          analyst: analyst !== null,
          sentiment: sentiment !== null,
          disclosures: disclosures !== null,
        },
        phase: "3a+4",
      },
    });
  } catch (err) {
    console.error("future-score error:", err);
    return NextResponse.json(
      { error: "internal error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
