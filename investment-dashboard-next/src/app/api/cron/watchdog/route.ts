import { NextRequest, NextResponse } from "next/server";
import { getCronOrigin } from "@/lib/cron-origin";

/**
 * GET /api/cron/watchdog
 * Vercel Cron 専用エンドポイント。
 * Authorization: Bearer ${CRON_SECRET} (Vercel が自動付与) で認証。
 *
 * 保有銘柄・お気に入り・シナリオの異変を自動検知して LINE 通知。
 *
 * 設定対象ユーザーは CAVKA_CRON_EMAILS 環境変数のカンマ区切り、なければ単一ユーザー fallback。
 */

const CRON_SECRET = process.env.CRON_SECRET;
const MCP_API_KEY = process.env.MCP_API_KEY;
const FALLBACK_EMAIL = "make.some.noise6984@gmail.com";

export async function GET(req: NextRequest) {
  // Vercel Cron 認証
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!MCP_API_KEY) {
    return NextResponse.json({ error: "MCP_API_KEY not configured" }, { status: 500 });
  }

  const emailsRaw = process.env.CAVKA_CRON_EMAILS ?? FALLBACK_EMAIL;
  const emails = emailsRaw.split(",").map((e) => e.trim()).filter(Boolean);

  const origin = getCronOrigin(req);

  const results: Record<string, unknown>[] = [];
  for (const email of emails) {
    try {
      const res = await fetch(
        `${origin}/api/watchdog/check?email=${encodeURIComponent(email)}`,
        {
          method: "POST",
          headers: { "x-api-key": MCP_API_KEY },
        }
      );
      const json = await res.json();
      results.push({ email, status: res.status, ...json });
    } catch (err) {
      results.push({ email, error: (err as Error).message });
    }
  }

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    results,
  });
}
