import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase-admin";
import { tachibanaLogin, tachibanaLogout, getMarketQuotes } from "@/lib/tachibana";
import { getCachedJpStocks } from "@/lib/jp-stocks-cache";
import { evaluateUltraShort, type IntradayInput, type UltraShortInsight } from "@/lib/intraday-signals";

const ALLOWED_EMAILS = ["make.some.noise6984@gmail.com"];

/**
 * GET /api/intraday/scan-jp-all
 *
 * 立花全マスタ (~4456 銘柄) を bulk getMarketQuotes (120銘柄/req) でスキャンし、
 * VWAP・板情報込みで超短期シグナルを評価する高精度版スキャン。
 *
 * 試算: 38 batches × ~0.5s + login/logout = ~25-30秒
 * Vercel maxDuration=60 で対応 (Hobby plan の制約内)。
 *
 * 認証: x-api-key (MCP) または Bearer Firebase ID Token
 *
 * クエリ:
 *   minScore=40  : このスコア以上のみ返す
 *   limit=200    : 各カテゴリの最大件数 (デフォルト 200)
 */

export const maxDuration = 60;

const BATCH_SIZE = 120;

export async function GET(req: NextRequest) {
  // 認証
  const apiKey = req.headers.get("x-api-key");
  const authHeader = req.headers.get("authorization");
  let authorized = false;
  if (apiKey && apiKey === process.env.MCP_API_KEY) authorized = true;
  else if (authHeader?.startsWith("Bearer ")) {
    try {
      const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
      if (decoded.email && ALLOWED_EMAILS.includes(decoded.email)) authorized = true;
    } catch {}
  }
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const minScore = Number(req.nextUrl.searchParams.get("minScore") ?? "40");
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "200");
  const startedAt = Date.now();

  // 立花マスタから全銘柄取得 (Firestore cached)
  const masterStocks = await getCachedJpStocks();
  if (masterStocks.length === 0) {
    return NextResponse.json(
      { ok: false, error: "立花マスタが未取得。POST /api/stocks/master で取得してください。" },
      { status: 500 }
    );
  }
  const nameMap = new Map(masterStocks.map((s) => [s.ticker, s.name]));

  // 4桁数字 ticker のみ (ETF/REIT/特殊銘柄を一部除外、簡易)
  const allTickers = masterStocks.map((s) => s.ticker).filter((t) => /^\d{4}[A-Z]?$/.test(t));

  let session = null;
  try {
    session = await tachibanaLogin();

    // バッチ実行
    const allQuotes: Awaited<ReturnType<typeof getMarketQuotes>> = [];
    const totalBatches = Math.ceil(allTickers.length / BATCH_SIZE);
    let processedBatches = 0;

    for (let i = 0; i < allTickers.length; i += BATCH_SIZE) {
      // 時間予算チェック
      if (Date.now() - startedAt > 50_000) {
        console.warn(`[scan-jp-all] time budget exceeded at batch ${processedBatches}/${totalBatches}`);
        break;
      }
      const batch = allTickers.slice(i, i + BATCH_SIZE);
      try {
        const quotes = await getMarketQuotes(session, batch);
        allQuotes.push(...quotes);
      } catch (err) {
        console.error(`batch ${processedBatches} failed:`, err);
      }
      processedBatches++;
    }

    // 市場平均変動率
    const changePcts = allQuotes
      .map((q) => q.changePct)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const marketCh =
      changePcts.length > 0
        ? changePcts.reduce((a, b) => a + b, 0) / changePcts.length
        : null;

    // 各銘柄を評価
    const results: (UltraShortInsight & {
      name: string;
      market: "JP";
      price: number | null;
      changePct: number | null;
      vwap: number | null;
      bidPct: number | null;
    })[] = [];

    for (const q of allQuotes) {
      // 板情報集計
      let bidVolume = 0;
      let askVolume = 0;
      for (const lv of q.bids ?? []) if (lv.quantity) bidVolume += lv.quantity;
      for (const lv of q.asks ?? []) if (lv.quantity) askVolume += lv.quantity;

      const input: IntradayInput = {
        ticker: q.ticker,
        currentPrice: q.currentPrice,
        prevClose: q.prevClose,
        open: q.openPrice,
        dayHigh: q.highPrice,
        dayLow: q.lowPrice,
        changePct: q.changePct,
        vwap: q.vwap,
        volume: q.volume,
        avgVolume20d: null,
        bidVolume,
        askVolume,
        sector: null,
        sectorChangePct: null,
        marketChangePct: marketCh,
        hasRecentNews: undefined,
      };
      const insight = evaluateUltraShort(input);
      if (
        insight.reboundScore >= minScore ||
        insight.plungeScore >= minScore ||
        insight.newsReactionScore >= minScore
      ) {
        const total = bidVolume + askVolume;
        results.push({
          ...insight,
          name: nameMap.get(q.ticker) ?? q.ticker,
          market: "JP",
          price: q.currentPrice,
          changePct: q.changePct,
          vwap: q.vwap,
          bidPct: total > 0 ? (bidVolume / total) * 100 : null,
        });
      }
    }

    // カテゴリ分け
    const rebounds = results
      .filter((r) => r.overallSignal === "buy_rebound")
      .sort((a, b) => b.reboundScore - a.reboundScore)
      .slice(0, limit);
    const overheats = results
      .filter((r) => r.overallSignal === "sell_overheat")
      .sort((a, b) => b.plungeScore - a.plungeScore)
      .slice(0, limit);
    const newsActive = results
      .filter((r) => r.overallSignal === "hold_news_active")
      .sort((a, b) => b.newsReactionScore - a.newsReactionScore)
      .slice(0, limit);
    const others = results
      .filter((r) => !["buy_rebound", "sell_overheat", "hold_news_active"].includes(r.overallSignal))
      .sort((a, b) => b.overallScore - a.overallScore)
      .slice(0, limit);

    return NextResponse.json({
      ok: true,
      universe: "jp-all",
      computedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      marketAvg: { jp: marketCh, us: null },
      counts: {
        total: allTickers.length,
        processed: allQuotes.length,
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  } finally {
    if (session) await tachibanaLogout(session).catch(() => {});
  }
}
