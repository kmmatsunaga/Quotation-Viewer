import { NextRequest, NextResponse } from "next/server";
import {
  tachibanaLogin,
  tachibanaLogout,
  getMarginBalances,
  getNegativeInterest,
  getSyoukinBalances,
} from "@/lib/tachibana";
import { getAdminAuth } from "@/lib/firebase-admin";
import { getAdminDb } from "@/lib/firebase-admin";

void getAdminDb;
const ALLOWED_EMAILS = ["make.some.noise6984@gmail.com"];

/**
 * GET /api/tachibana/margin?tickers=7203,6501
 * 信用残・逆日歩・証金残を一度に取得 (3つのI/F呼び出しを1セッションで)
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
    // 並列ではなく、シーケンス番号管理のため直列実行
    const margin = await getMarginBalances(session, tickers);
    const hibu = await getNegativeInterest(session, tickers);
    const syoukin = await getSyoukinBalances(session, tickers);

    // ティッカーごとに統合
    const result: Record<string, {
      margin: typeof margin[0] | null;
      hibu: typeof hibu[0] | null;
      syoukin: typeof syoukin[0] | null;
    }> = {};

    for (const t of tickers) {
      result[t] = {
        margin: margin.find((m) => m.ticker === t) ?? null,
        hibu: hibu.find((h) => h.ticker === t) ?? null,
        syoukin: syoukin.find((s) => s.ticker === t) ?? null,
      };
    }

    return NextResponse.json({ ok: true, env: process.env.TACHIBANA_ENV ?? "demo", data: result });
  } catch (err: unknown) {
    const e = err as Error;
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  } finally {
    if (session) await tachibanaLogout(session).catch(() => {});
  }
}
