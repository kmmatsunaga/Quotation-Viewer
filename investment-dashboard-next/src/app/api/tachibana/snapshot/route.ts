import { NextRequest, NextResponse } from "next/server";
import {
  tachibanaLogin,
  tachibanaLogout,
  getMarketQuotes,
  getMarginBalances,
  getNegativeInterest,
  getSyoukinBalances,
} from "@/lib/tachibana";
import { getAdminAuth } from "@/lib/firebase-admin";

const ALLOWED_EMAILS = ["make.some.noise6984@gmail.com"];

/**
 * GET /api/tachibana/snapshot?tickers=6525&include=quotes,margin
 *
 * 1セッションで複数の立花I/Fを叩いて統合レスポンスを返す。
 * これにより複数パネルが同時に独立ログインしてセッション衝突する問題を解消。
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

  const include = (req.nextUrl.searchParams.get("include") ?? "quotes,margin")
    .split(",")
    .map((s) => s.trim());

  let session = null;
  try {
    session = await tachibanaLogin();

    const result: Record<string, unknown> = { ok: true, env: process.env.TACHIBANA_ENV ?? "demo" };

    if (include.includes("quotes")) {
      try {
        result.quotes = await getMarketQuotes(session, tickers);
      } catch (e) {
        result.quotesError = (e as Error).message;
      }
    }

    if (include.includes("margin")) {
      try {
        const margin = await getMarginBalances(session, tickers);
        const hibu = await getNegativeInterest(session, tickers);
        const syoukin = await getSyoukinBalances(session, tickers);
        const marginData: Record<string, unknown> = {};
        for (const t of tickers) {
          marginData[t] = {
            margin: margin.find((m) => m.ticker === t) ?? null,
            hibu: hibu.find((h) => h.ticker === t) ?? null,
            syoukin: syoukin.find((s) => s.ticker === t) ?? null,
          };
        }
        result.margin = marginData;
      } catch (e) {
        result.marginError = (e as Error).message;
      }
    }

    return NextResponse.json(result);
  } catch (err: unknown) {
    const e = err as Error;
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  } finally {
    if (session) await tachibanaLogout(session).catch(() => {});
  }
}
