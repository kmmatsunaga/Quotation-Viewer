import { NextRequest, NextResponse } from "next/server";
import { tachibanaLogin, tachibanaLogout, getMarketQuotes } from "@/lib/tachibana";
import { getAdminAuth } from "@/lib/firebase-admin";
import { assess, fetchAvgVolume } from "@/lib/warroom-assess";

const ALLOWED_EMAILS = ["make.some.noise6984@gmail.com"];

/**
 * GET /api/warroom?tickers=7203,6501
 *
 * 場中ウォールーム用バッチ取得。立花 PRICE I/F の時価+板から、
 * デイトレ向けの派生指標と「場中評決」を計算して返す。
 * 評決ロジック本体は src/lib/warroom-assess.ts (snapshot cron と共用)。
 *
 * 認証: x-api-key (MCP) または Bearer (ブラウザ)。日本株のみ (板は立花)。
 */

export const maxDuration = 30;

export async function GET(req: NextRequest) {
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
  if (!authorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tickersParam = req.nextUrl.searchParams.get("tickers") ?? "";
  const tickers = tickersParam
    .split(",")
    .map((t) => t.trim())
    .filter((t) => /^\d{3,4}[A-Z]?$/.test(t))  // 日本株のみ (板は立花)
    .slice(0, 20);
  if (tickers.length === 0) {
    return NextResponse.json({ ok: false, error: "有効な日本株 ticker がありません (板情報は日本株のみ)" }, { status: 400 });
  }

  const startedAt = Date.now();
  let session = null;
  try {
    session = await tachibanaLogin();
    const [quotes, avgVols] = await Promise.all([
      getMarketQuotes(session, tickers),
      Promise.all(tickers.map((t) => fetchAvgVolume(t))),
    ]);
    const avgVolMap = new Map(tickers.map((t, i) => [t, avgVols[i]]));
    const entries = quotes.map((q) => assess(q, avgVolMap.get(q.ticker) ?? null));
    return NextResponse.json({
      ok: true,
      entries,
      computedAtIso: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  } finally {
    if (session) await tachibanaLogout(session).catch(() => {});
  }
}
