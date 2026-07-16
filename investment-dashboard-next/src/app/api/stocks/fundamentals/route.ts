import { NextRequest, NextResponse } from "next/server";
import { yfQuoteSummary } from "@/lib/yahoo-finance";
import { getCachedJpStocks } from "@/lib/jp-stocks-cache";
import { NIKKEI225 } from "@/lib/nikkei225";
import { SP500 } from "@/lib/sp500";
import { STOCK_LIST } from "@/lib/stock-list";

// 銘柄名ルックアップ (モジュールロード時に1回構築)
const LOCAL_NAME_MAP = new Map<string, string>([
  ...NIKKEI225.map((s) => [s.ticker, s.name] as const),
  ...SP500.map((s) => [s.ticker, s.name] as const),
  ...STOCK_LIST.map((s) => [s.ticker, s.name] as const),
]);

/**
 * GET /api/stocks/fundamentals?tickers=7203,4502,AAPL
 *
 * Yahoo Finance quoteSummary から主要ファンダメンタル指標を取得。
 * 1リクエスト1銘柄なので、最大20銘柄/リクエストに制限。
 */

export interface FundamentalData {
  ticker: string;
  name: string;
  market: string;
  price: number;
  marketCap: number;

  // ① 割安度（バリュエーション）
  trailingPE: number | null;
  forwardPE: number | null;
  pbr: number | null;           // priceToBook
  pegRatio: number | null;
  evToEbitda: number | null;

  // ② 稼ぐ力（収益性）
  roe: number | null;           // returnOnEquity (%)
  roa: number | null;
  operatingMargin: number | null; // (%)
  profitMargin: number | null;    // (%)

  // ③ 財務健全性
  debtToEquity: number | null;
  currentRatio: number | null;
  totalCash: number | null;
  totalDebt: number | null;
  netCash: number | null;       // totalCash - totalDebt

  // ④ 成長性
  revenueGrowth: number | null; // (%)
  earningsGrowth: number | null; // (%)
  epsTrailing: number | null;
  epsForward: number | null;
  freeCashFlow: number | null;

  // ⑤ 株主還元
  dividendYield: number | null; // (%)
  payoutRatio: number | null;   // (%)
  dividendRate: number | null;

  // セクター
  sector: string;
  industry: string;
}

export async function GET(req: NextRequest) {
  const tickersParam = req.nextUrl.searchParams.get("tickers") ?? "";
  const tickers = tickersParam
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 20); // 最大20

  if (tickers.length === 0) {
    return NextResponse.json({ fundamentals: {} });
  }

  // 日本株がある場合は社名キャッシュを取得 (1回だけ Firestore 読み込み)
  const hasJP = tickers.some((t) => /^\d{3,4}[A-Z]?$/.test(t));
  let jpNameMap = new Map<string, string>();
  if (hasJP) {
    try {
      const jpStocks = await getCachedJpStocks();
      jpNameMap = new Map(jpStocks.map((s) => [s.ticker, s.name]));
    } catch {
      // fallback: ローカルリスト
    }
  }

  try {
    const results = await Promise.allSettled(
      tickers.map(async (ticker) => {
        const isJP = /^\d{3,4}[A-Z]?$/.test(ticker);
        const yfTicker = isJP ? `${ticker}.T` : ticker;

        const result = await yfQuoteSummary(
          yfTicker,
          "defaultKeyStatistics,financialData,summaryDetail,summaryProfile,quoteType"
        );
        if (!result) return null;

        const ks = (result.defaultKeyStatistics ?? {}) as Record<string, unknown>;
        const fd = (result.financialData ?? {}) as Record<string, unknown>;
        const sd = (result.summaryDetail ?? {}) as Record<string, unknown>;
        const sp = (result.summaryProfile ?? {}) as Record<string, unknown>;
        const qt = (result.quoteType ?? {}) as Record<string, unknown>;

        // Helper to extract raw value from Yahoo's format { raw: number, fmt: string }
        const raw = (obj: Record<string, unknown> | undefined, key: string): number | null => {
          if (!obj) return null;
          const v = obj[key];
          if (v && typeof v === "object" && "raw" in (v as Record<string, unknown>)) {
            return (v as { raw: number }).raw;
          }
          if (typeof v === "number") return v;
          return null;
        };

        const totalCash = raw(fd, "totalCash");
        const totalDebt = raw(fd, "totalDebt");
        const roe = raw(fd, "returnOnEquity");
        const operatingMargin = raw(fd, "operatingMargins");
        const profitMargin = raw(fd, "profitMargins");
        const revenueGrowth = raw(fd, "revenueGrowth");
        const earningsGrowth = raw(fd, "earningsGrowth");

        // 名前の優先順位:
        //   日本株: 立花マスタ日本語名 > ローカルマスタ (NIKKEI225) > Yahoo > ticker
        //   米国株: ローカルマスタ (SP500/STOCK_LIST) > Yahoo > ticker
        const jpName = isJP ? jpNameMap.get(ticker) : null;
        const localName = LOCAL_NAME_MAP.get(ticker);
        const yfName = (qt.longName ?? qt.shortName ?? sp.longName ?? null) as string | null;
        const name = jpName ?? localName ?? yfName ?? ticker;

        const data: FundamentalData = {
          ticker,
          name,
          market: isJP ? "JP" : "US",
          price: raw(fd, "currentPrice") ?? 0,
          marketCap: raw(sd, "marketCap") ?? 0,

          // ① バリュエーション
          trailingPE: raw(sd, "trailingPE"),
          forwardPE: raw(sd, "forwardPE") ?? raw(ks, "forwardPE"),
          pbr: raw(sd, "priceToBook") ?? raw(ks, "priceToBook"),
          pegRatio: raw(ks, "pegRatio"),
          evToEbitda: raw(ks, "enterpriseToEbitda"),

          // ② 収益性
          roe: roe !== null ? roe * 100 : null,
          roa: raw(fd, "returnOnAssets") !== null ? (raw(fd, "returnOnAssets")! * 100) : null,
          operatingMargin: operatingMargin !== null ? operatingMargin * 100 : null,
          profitMargin: profitMargin !== null ? profitMargin * 100 : null,

          // ③ 財務健全性
          debtToEquity: raw(fd, "debtToEquity"),
          currentRatio: raw(fd, "currentRatio"),
          totalCash,
          totalDebt,
          netCash: totalCash !== null && totalDebt !== null ? totalCash - totalDebt : null,

          // ④ 成長性
          revenueGrowth: revenueGrowth !== null ? revenueGrowth * 100 : null,
          earningsGrowth: earningsGrowth !== null ? earningsGrowth * 100 : null,
          epsTrailing: raw(ks, "trailingEps"),
          epsForward: raw(ks, "forwardEps"),
          freeCashFlow: raw(fd, "freeCashflow"),

          // ⑤ 株主還元
          dividendYield: raw(sd, "dividendYield") !== null ? (raw(sd, "dividendYield")! * 100) : null,
          payoutRatio: raw(sd, "payoutRatio") !== null ? (raw(sd, "payoutRatio")! * 100) : null,
          dividendRate: raw(sd, "dividendRate"),

          // セクター
          sector: (sp.sector ?? "") as string,
          industry: (sp.industry ?? "") as string,
        };

        return data;
      })
    );

    const fundamentals: Record<string, FundamentalData> = {};
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        fundamentals[r.value.ticker] = r.value;
      }
    }

    return NextResponse.json({ fundamentals });
  } catch (err) {
    console.error("Fundamentals fetch error:", err);
    return NextResponse.json(
      { fundamentals: {}, error: "Failed to fetch fundamentals" },
      { status: 500 }
    );
  }
}
