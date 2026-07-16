import { NextRequest, NextResponse } from "next/server";
import { yfQuoteSummary } from "@/lib/yahoo-finance";
import { computeMomentumScore, type MomentumScoreInput } from "@/lib/momentum-score";

/**
 * GET /api/stocks/momentum-score?ticker=7203
 *
 * モメンタム・グロース・スクリーニング (主役株候補) の単一銘柄スコア。
 *
 * 入力源:
 *   - Yahoo quoteSummary: financialData, defaultKeyStatistics, summaryDetail,
 *     earningsHistory, earningsTrend, incomeStatementHistoryQuarterly
 *   - Yahoo chart API: 1年分の日足 (MA50/200, 52週高値, 流動性)
 *
 * 出力: サブスコア分解 + 合成 final_score + 除外理由
 */

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker")?.trim();
  if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });

  const isJP = /^\d{3,4}[A-Z]?$/.test(ticker);
  const yfTicker = isJP ? `${ticker}.T` : ticker;
  const startedAt = Date.now();

  try {
    // 1. quoteSummary 一括取得
    const summary = await yfQuoteSummary(
      yfTicker,
      "financialData,defaultKeyStatistics,summaryDetail,earningsHistory,earningsTrend,incomeStatementHistoryQuarterly,quoteType"
    );
    if (!summary) {
      return NextResponse.json({ ok: false, ticker, error: "quoteSummary 取得失敗" }, { status: 502 });
    }

    // 2. チャート (1年分) を取得
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      yfTicker
    )}?range=1y&interval=1d`;
    const chartRes = await fetch(chartUrl, { headers: YF_HEADERS, next: { revalidate: 3600 } });
    let closes: (number | null)[] = [];
    let volumes: (number | null)[] = [];
    if (chartRes.ok) {
      const cj = await chartRes.json();
      const r = cj.chart?.result?.[0];
      // Yahoo は古い順で返す → 新しい順に並び替え
      const rawCloses = (r?.indicators?.quote?.[0]?.close ?? []) as (number | null)[];
      const rawVolumes = (r?.indicators?.quote?.[0]?.volume ?? []) as (number | null)[];
      closes = [...rawCloses].reverse();
      volumes = [...rawVolumes].reverse();
    }

    // 3. テクニカル派生指標
    const validCloses = closes.filter((c): c is number => c !== null);
    const ma = (arr: number[], n: number, offset = 0): number | null => {
      const slice = arr.slice(offset, offset + n);
      if (slice.length < n) return null;
      return slice.reduce((a, b) => a + b, 0) / n;
    };
    const ma50 = ma(validCloses, 50);
    const ma200 = ma(validCloses, 200);
    const ma200_20dAgo = ma(validCloses, 200, 20);
    const high52w = validCloses.length > 0 ? Math.max(...validCloses) : null;
    // 12M リターン (新しい順なので 最初 vs 末尾)
    const return12m =
      validCloses.length >= 200 && validCloses[validCloses.length - 1] > 0
        ? validCloses[0] / validCloses[validCloses.length - 1] - 1
        : null;
    // 12M中の最大ドローダウン (高値からの最大下落率)
    const maxDrawdown12m = (() => {
      if (validCloses.length < 20) return null;
      let peak = validCloses[validCloses.length - 1];
      let maxDd = 0;
      // 古い順に走査して、各時点の peak と current の比較で最大DD
      for (let i = validCloses.length - 1; i >= 0; i--) {
        const c = validCloses[i];
        if (c > peak) peak = c;
        const dd = (peak - c) / peak;
        if (dd > maxDd) maxDd = dd;
      }
      return maxDd;
    })();
    // 上場後経過四半期 (Yahoo quoteType.firstTradeDateEpochUtc から計算)
    const qt = (summary.quoteType ?? {}) as Record<string, unknown>;
    const firstTradeMs = typeof qt.firstTradeDateEpochUtc === "number" ? qt.firstTradeDateEpochUtc * 1000 : null;
    const quartersListed =
      firstTradeMs !== null
        ? Math.floor((Date.now() - firstTradeMs) / (90 * 24 * 3600 * 1000))
        : null;
    // 出来高×終値の概算 (円ベース近似、外貨建ては小規模化される傾向あるが許容)
    const turnover20d = (() => {
      const pairs: number[] = [];
      for (let i = 0; i < Math.min(20, closes.length, volumes.length); i++) {
        const c = closes[i];
        const v = volumes[i];
        if (c !== null && v !== null) pairs.push(c * v);
      }
      if (pairs.length === 0) return null;
      return pairs.reduce((a, b) => a + b, 0) / pairs.length;
    })();

    // 4. スコア計算
    const input: MomentumScoreInput = {
      ticker,
      financialData: summary.financialData as Record<string, unknown>,
      defaultKeyStatistics: summary.defaultKeyStatistics as Record<string, unknown>,
      summaryDetail: summary.summaryDetail as Record<string, unknown>,
      earningsHistory: summary.earningsHistory as Record<string, unknown>,
      earningsTrend: summary.earningsTrend as Record<string, unknown>,
      incomeStatementHistoryQuarterly: summary.incomeStatementHistoryQuarterly as Record<string, unknown>,
      quoteType: summary.quoteType as Record<string, unknown>,
      closes,
      volumes,
      high52w,
      ma50,
      ma200,
      ma200_20dAgo,
      turnover20d,
      return12m,
      maxDrawdown12m,
      quartersListed,
      // megacap / overcovered ゲート用
      marketCap: (() => {
        const sd = summary.summaryDetail as Record<string, unknown> | undefined;
        const ks = summary.defaultKeyStatistics as Record<string, unknown> | undefined;
        const pick = (v: unknown): number | null => {
          if (v && typeof v === "object" && "raw" in (v as Record<string, unknown>)) return (v as { raw: number }).raw;
          if (typeof v === "number") return v;
          return null;
        };
        return pick(sd?.marketCap) ?? pick(ks?.marketCap);
      })(),
      market: isJP ? "JP" : "US",
      numberOfAnalysts: (() => {
        const fd = summary.financialData as Record<string, unknown> | undefined;
        const v = fd?.numberOfAnalystOpinions;
        if (v && typeof v === "object" && "raw" in (v as Record<string, unknown>)) return (v as { raw: number }).raw;
        if (typeof v === "number") return v;
        return null;
      })(),
      // rs6mPercentile は未実装 (TOPIX/SPX との相対計算が別途必要、Phase 2 で追加)
      rs6mPercentile: null,
    };

    const result = computeMomentumScore(input);

    // 銘柄名取得
    const sp = (summary.summaryProfile ?? {}) as Record<string, unknown>;
    const name = (qt.longName ?? qt.shortName ?? sp.longName ?? ticker) as string;

    return NextResponse.json({
      ok: true,
      name,
      market: isJP ? "JP" : "US",
      ...result,
      meta: {
        ma50, ma200, ma200_20dAgo, high52w, turnover20d,
        return12m, maxDrawdown12m, quartersListed,
        latestClose: closes[0] ?? null,
        chartBars: validCloses.length,
      },
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, ticker, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
