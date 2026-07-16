import { NextRequest, NextResponse } from "next/server";
import { tachibanaLogin, tachibanaLogout, getMarketQuotes } from "@/lib/tachibana";
import { getAdminAuth } from "@/lib/firebase-admin";
import { getAdminDb } from "@/lib/firebase-admin";

void getAdminDb;
const ALLOWED_EMAILS = ["make.some.noise6984@gmail.com"];

/**
 * GET /api/tachibana/quotes?tickers=7203,6501
 * 認証: x-api-key (MCP) または Bearer (ブラウザ)
 *
 * 立花API PRICE I/F から板情報含む時価情報を取得（最大120銘柄）。
 */
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
  const tickers = tickersParam.split(",").map((t) => t.trim()).filter(Boolean);
  if (tickers.length === 0) {
    return NextResponse.json({ ok: false, error: "tickers required" }, { status: 400 });
  }

  let session = null;
  try {
    session = await tachibanaLogin();
    const quotes = await getMarketQuotes(session, tickers);
    return NextResponse.json({ ok: true, env: process.env.TACHIBANA_ENV ?? "demo", quotes });
  } catch (err: unknown) {
    const e = err as Error;
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  } finally {
    if (session) await tachibanaLogout(session).catch(() => {});
  }
}
