import { NextRequest, NextResponse } from "next/server";
import {
  tachibanaLogin,
  tachibanaLogout,
  getHoldings,
} from "@/lib/tachibana";
import { getAdminAuth } from "@/lib/firebase-admin";
import { getAdminDb } from "@/lib/firebase-admin";

// Initialize admin SDK (side-effect via firebase-admin import)
void getAdminDb;

const ALLOWED_EMAILS = ["make.some.noise6984@gmail.com"];

/**
 * GET /api/tachibana/portfolio
 * 認証: 以下のいずれか
 *   1. Header: x-api-key: <MCP_API_KEY>   (MCPサーバ用)
 *   2. Header: Authorization: Bearer <Firebase ID token>  (ブラウザ用)
 *
 * 立花API デモ/本番環境から保有銘柄一覧を取得。
 */
export async function GET(req: NextRequest) {
  // 認証チェック
  const apiKey = req.headers.get("x-api-key");
  const authHeader = req.headers.get("authorization");

  let authorized = false;
  if (apiKey && apiKey === process.env.MCP_API_KEY) {
    authorized = true;
  } else if (authHeader?.startsWith("Bearer ")) {
    try {
      const token = authHeader.slice(7);
      const decoded = await getAdminAuth().verifyIdToken(token);
      if (decoded.email && ALLOWED_EMAILS.includes(decoded.email)) {
        authorized = true;
      }
    } catch {
      // ignore
    }
  }

  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let session = null;
  try {
    session = await tachibanaLogin();
    const holdings = await getHoldings(session);

    return NextResponse.json({
      ok: true,
      env: process.env.TACHIBANA_ENV ?? "demo",
      lastLoginDate: session.lastLoginDate,
      totalEvalAmount: holdings.totalEvalAmount,
      totalPnl: holdings.totalPnl,
      holdings: holdings.holdings,
    });
  } catch (err: unknown) {
    const e = err as Error;
    return NextResponse.json(
      { ok: false, error: e.message },
      { status: 500 }
    );
  } finally {
    if (session) await tachibanaLogout(session).catch(() => {});
  }
}
