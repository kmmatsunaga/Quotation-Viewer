import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { computeSentimentFromHeaders } from "@/lib/news-sentiment";
import { summarizeDisclosures } from "@/lib/disclosure-events";
import { tachibanaLogin, tachibanaLogout, getNewsHeaders } from "@/lib/tachibana";

/**
 * GET  /api/stocks/sentiment/[ticker]  : Firestore キャッシュからセンチメント取得 (公開)
 * POST /api/stocks/sentiment/[ticker]  : センチメントを再計算して Firestore に保存 (認証必要)
 *
 * キャッシュキー: meta/sentiment_{ticker}
 * 推奨: Vercel Cron で毎日深夜にポートフォリオ + ウォッチリスト銘柄を一括 POST
 *
 * GET レスポンス例:
 * {
 *   ok: true,
 *   ticker: "7203",
 *   articleCount: 8,
 *   avgSentiment: 0.35,
 *   diffusionCoef: 0.74,
 *   finalScore: 26,
 *   label: "positive",
 *   computedAt: "2026-05-28T..."
 *   stale: false  // 24時間以上前なら true
 * }
 */

const STALE_HOURS = 36;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params;
  const db = getAdminDb();
  const snap = await db.collection("meta").doc(`sentiment_${ticker}`).get();
  if (!snap.exists) {
    return NextResponse.json(
      { ok: false, error: "No sentiment cache yet", ticker },
      { status: 404 }
    );
  }
  const data = snap.data();
  const computedAt = data?.computedAt?.toDate?.()?.toISOString?.() ?? data?.computedAtIso ?? null;
  const stale = computedAt
    ? Date.now() - new Date(computedAt).getTime() > STALE_HOURS * 3600 * 1000
    : true;

  return NextResponse.json({
    ok: true,
    ticker,
    stale,
    ...data,
    computedAt,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  // 認証 (MCP_API_KEY or CRON_SECRET or Firebase Token)
  const apiKey = req.headers.get("x-api-key");
  const cronSecret = req.headers.get("x-cron-secret");
  const authHeader = req.headers.get("authorization");
  let authorized = false;
  if (apiKey && apiKey === process.env.MCP_API_KEY) authorized = true;
  else if (cronSecret && cronSecret === process.env.CRON_SECRET) authorized = true;
  else if (authHeader?.startsWith("Bearer ")) {
    try {
      const { getAdminAuth } = await import("@/lib/firebase-admin");
      const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
      if (decoded.email === "make.some.noise6984@gmail.com") authorized = true;
    } catch {}
  }
  if (!authorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { ticker } = await params;
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? "30"), 50);
  const days = Number(req.nextUrl.searchParams.get("days") ?? "14");

  let session = null;
  try {
    // 立花からニュースヘッダ取得
    const dateTo = formatDateJst(new Date());
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);
    const dateFrom = formatDateJst(fromDate);

    session = await tachibanaLogin();
    const newsResult = await getNewsHeaders(session, {
      issueCode: ticker,
      dateFrom,
      dateTo,
      limit,
    });

    // 並列実行: Gemini感情分析 + 開示イベント分類 (後者は同期, 即終わる)
    const disclosures = summarizeDisclosures(ticker, newsResult.items);
    const sentiment = await computeSentimentFromHeaders(ticker, newsResult.items, limit);

    // Firestore に保存 (sentiment + disclosures を同一レコードに)
    const db = getAdminDb();
    const { FieldValue } = await import("firebase-admin/firestore");
    await db.collection("meta").doc(`sentiment_${ticker}`).set({
      ...sentiment,
      disclosures,                              // ← Phase 3a 追加
      computedAt: FieldValue.serverTimestamp(),
      computedAtIso: sentiment.computedAt,
    });

    const { ticker: _omit, ...rest } = sentiment;
    void _omit;
    return NextResponse.json({ ok: true, ticker, ...rest, disclosures });
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
