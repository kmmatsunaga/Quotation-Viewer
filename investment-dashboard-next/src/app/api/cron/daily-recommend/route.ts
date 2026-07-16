import { NextRequest, NextResponse } from "next/server";
import { getCronOrigin } from "@/lib/cron-origin";

/**
 * GET /api/cron/daily-recommend
 * 毎朝、各ユーザー向けにおすすめ銘柄を生成。
 */

const CRON_SECRET = process.env.CRON_SECRET;
const MCP_API_KEY = process.env.MCP_API_KEY;
const FALLBACK_EMAIL = "make.some.noise6984@gmail.com";

export const maxDuration = 300;  // 最大5分まで許容 (30銘柄分析に時間かかるため)

export async function GET(req: NextRequest) {
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
      // Hobby plan の10秒制限を考慮して n=12 (お気に入り全部+ランダム数銘柄)
      const sampleSize = process.env.CAVKA_CRON_SAMPLE_SIZE ?? "12";
      const res = await fetch(
        `${origin}/api/agent/daily-recommend?email=${encodeURIComponent(email)}&n=${sampleSize}`,
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
