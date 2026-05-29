import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase-admin";
import { tachibanaLogin, tachibanaLogout, getMarketQuotes, getNewsHeaders } from "@/lib/tachibana";
import { evaluateUltraShort, type IntradayInput } from "@/lib/intraday-signals";

const ALLOWED_EMAILS = ["make.some.noise6984@gmail.com"];

/**
 * GET /api/intraday/analyze/[ticker]
 *
 * 個別銘柄を立花 getMarketQuotes で取得し、VWAP・板情報・直近ニュースを
 * 加味した精密な超短期シグナル分析を返す。
 *
 * Phase B1 (/scan) の高速スクリーン結果から、興味ある銘柄を深掘りするための API。
 *
 * 認証: x-api-key (MCP) または Bearer Firebase ID Token
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
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

  const { ticker } = await params;
  if (!/^\d{3,4}[A-Z]?$/.test(ticker)) {
    return NextResponse.json(
      { error: "Tachibana 詳細分析は日本株のみ対応" },
      { status: 400 }
    );
  }

  let session = null;
  try {
    session = await tachibanaLogin();

    // 立花から現値+板情報を取得 (1銘柄でも getMarketQuotes 使える)
    const quotes = await getMarketQuotes(session, [ticker]);
    const q = quotes[0];
    if (!q) {
      return NextResponse.json({ ok: false, error: "立花から価格データ取得不能" }, { status: 404 });
    }

    // 板情報を集計 (bidVolume = 買い気配総数量, askVolume = 売り気配総数量)
    let bidVolume = 0;
    let askVolume = 0;
    for (const lv of q.bids ?? []) {
      if (lv.quantity) bidVolume += lv.quantity;
    }
    for (const lv of q.asks ?? []) {
      if (lv.quantity) askVolume += lv.quantity;
    }

    // 直近ニュース有無 (過去 24時間)
    let hasRecentNews: boolean | undefined = undefined;
    let newsHoursAgo: number | null = null;
    try {
      const today = new Date();
      const dateTo = formatDateJst(today);
      const fromDate = new Date(today.getTime() - 24 * 60 * 60 * 1000);
      const dateFrom = formatDateJst(fromDate);
      const newsResult = await getNewsHeaders(session, {
        issueCode: ticker,
        dateFrom,
        dateTo,
        limit: 10,
      });
      const related = (newsResult.items ?? []).filter((n) =>
        n.relatedTickers.includes(ticker)
      );
      hasRecentNews = related.length > 0;
      if (related.length > 0) {
        const first = related[0];
        const ts = parseNewsDate(first.date, first.time);
        if (ts) newsHoursAgo = (Date.now() - ts) / (3600 * 1000);
      }
    } catch (err) {
      console.error("news fetch failed for", ticker, err);
    }

    // 評価
    const input: IntradayInput = {
      ticker,
      currentPrice: q.currentPrice,
      prevClose: q.prevClose,
      open: q.openPrice,
      dayHigh: q.highPrice,
      dayLow: q.lowPrice,
      changePct: q.changePct,
      vwap: q.vwap,
      volume: q.volume,
      avgVolume20d: null,        // 今回は取得スキップ (Yahoo 1d 範囲では 20日平均無し)
      bidVolume,
      askVolume,
      sector: null,              // 次フェーズ
      sectorChangePct: null,
      marketChangePct: null,     // 後で /scan と連携可能
      hasRecentNews,
      newsHoursAgo,
    };
    const insight = evaluateUltraShort(input);
    const { ticker: _omit, ...rest } = insight;
    void _omit;

    return NextResponse.json({
      ok: true,
      ticker,
      computedAt: new Date().toISOString(),
      raw: {
        currentPrice: q.currentPrice,
        prevClose: q.prevClose,
        open: q.openPrice,
        dayHigh: q.highPrice,
        dayLow: q.lowPrice,
        changePct: q.changePct,
        vwap: q.vwap,
        volume: q.volume,
        bidVolume,
        askVolume,
        bidAskRatio: bidVolume + askVolume > 0 ? bidVolume / (bidVolume + askVolume) : null,
      },
      news: { hasRecentNews, newsHoursAgo },
      ...rest,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  } finally {
    if (session) await tachibanaLogout(session).catch(() => {});
  }
}

function formatDateJst(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function parseNewsDate(date: string, time: string): number | null {
  // date=YYYYMMDD, time=HHMM
  if (!/^\d{8}$/.test(date) || !/^\d{4}$/.test(time)) return null;
  const y = parseInt(date.slice(0, 4), 10);
  const m = parseInt(date.slice(4, 6), 10) - 1;
  const d = parseInt(date.slice(6, 8), 10);
  const h = parseInt(time.slice(0, 2), 10);
  const min = parseInt(time.slice(2, 4), 10);
  // JST → UTC
  return Date.UTC(y, m, d, h - 9, min, 0);
}
