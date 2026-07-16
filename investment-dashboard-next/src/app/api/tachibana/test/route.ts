import { NextRequest, NextResponse } from "next/server";
import {
  tachibanaLogin,
  tachibanaLogout,
  getHoldings,
} from "@/lib/tachibana";

/**
 * GET /api/tachibana/test
 * Header: x-api-key: <MCP_API_KEY>
 *
 * 立花APIへの接続テスト＋保有銘柄取得。
 * デモ環境の動作確認用。
 */
export async function GET(req: NextRequest) {
  const API_KEY = process.env.MCP_API_KEY;
  if (!API_KEY) {
    return NextResponse.json(
      { error: "MCP_API_KEY not set" },
      { status: 500 }
    );
  }
  if (req.headers.get("x-api-key") !== API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 1. ログイン
    const session = await tachibanaLogin();
    const debug: Record<string, unknown> = {
      step: "login_ok",
      urlRequestPreview: session.urlRequest.slice(0, 120),
      urlMasterPreview: session.urlMaster.slice(0, 120),
      lastLoginDate: session.lastLoginDate,
    };

    // 2. 保有銘柄取得
    try {
      const holdingsRes = await getHoldings(session);
      debug.step = "holdings_ok";
      debug.holdingsRaw = holdingsRes.raw;
      await tachibanaLogout(session);
      return NextResponse.json({
        ok: true,
        debug,
        env: process.env.TACHIBANA_ENV ?? "demo",
        totalEvalAmount: holdingsRes.totalEvalAmount,
        totalPnl: holdingsRes.totalPnl,
        holdings: holdingsRes.holdings,
      });
    } catch (holdErr: unknown) {
      await tachibanaLogout(session).catch(() => {});
      const e = holdErr as Error;
      return NextResponse.json({
        ok: false,
        debug,
        error: "holdings_failed: " + e.message,
      });
    }
  } catch (err: unknown) {
    const e = err as Error;
    return NextResponse.json(
      { ok: false, error: e.message, stack: e.stack },
      { status: 500 }
    );
  }
}
