import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";

/**
 * GET /api/cron/sentiment-update
 *
 * 毎日深夜、ポートフォリオ + お気に入り銘柄のニュース感情を Gemini で再計算し
 * Firestore (meta/sentiment_{ticker}) にキャッシュ。
 *
 * 立花のニュース API はセッション競合があるので、銘柄ごとに直列処理。
 * Hobby plan 10秒制限を超えるため maxDuration=300。
 *
 * 認証: Vercel Cron は Authorization: Bearer ${CRON_SECRET} を送ってくる。
 */

const CRON_SECRET = process.env.CRON_SECRET;
const MCP_API_KEY = process.env.MCP_API_KEY;
const FALLBACK_EMAIL = "make.some.noise6984@gmail.com";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
  }
  if (!MCP_API_KEY) {
    return NextResponse.json({ error: "MCP_API_KEY not configured" }, { status: 500 });
  }

  const host = req.headers.get("host") ?? "localhost:3000";
  const proto = host.includes("localhost") ? "http" : "https";
  const origin = `${proto}://${host}`;

  // 対象銘柄: ポートフォリオ + お気に入り (日本株のみ、立花のニュースは日本株中心)
  const emailsRaw = process.env.CAVKA_CRON_EMAILS ?? FALLBACK_EMAIL;
  const emails = emailsRaw.split(",").map((e) => e.trim()).filter(Boolean);

  const tickerSet = new Set<string>();
  try {
    const db = getAdminDb();
    for (const email of emails) {
      // users/{uid_or_email_hash}/portfolio etc. の取得は別実装に依存するため、
      // ここでは簡易的に users コレクションを email でクエリ
      const usersSnap = await db.collection("users").where("email", "==", email).get();
      for (const userDoc of usersSnap.docs) {
        const uid = userDoc.id;
        const subs = [
          { col: "favorites", field: "ticker" },
          { col: "portfolio", field: "ticker" },
        ];
        for (const s of subs) {
          const ss = await db.collection("users").doc(uid).collection(s.col).get();
          for (const d of ss.docs) {
            const t = (d.data() as Record<string, unknown>)[s.field];
            if (typeof t === "string" && /^\d{3,4}[A-Z]?$/.test(t)) tickerSet.add(t);
          }
        }
      }
    }
  } catch (e) {
    console.error("sentiment-update: portfolio fetch error", e);
  }

  // フォールバック: 主要日本株
  if (tickerSet.size === 0) {
    ["7203", "9984", "6920", "4502", "8035", "6758", "9432", "9434"].forEach((t) => tickerSet.add(t));
  }

  const tickers = Array.from(tickerSet);
  const results: { ticker: string; ok: boolean; error?: string; finalScore?: number; articleCount?: number }[] = [];

  // 直列処理 (Tachibana セッション競合 + Gemini rate limit 対策)
  for (const ticker of tickers) {
    try {
      const res = await fetch(`${origin}/api/stocks/sentiment/${encodeURIComponent(ticker)}`, {
        method: "POST",
        headers: { "x-api-key": MCP_API_KEY },
      });
      const json = (await res.json()) as { ok?: boolean; finalScore?: number; articleCount?: number; error?: string };
      results.push({
        ticker,
        ok: !!json.ok,
        finalScore: json.finalScore,
        articleCount: json.articleCount,
        error: json.error,
      });
      // Tachibana への連続アクセスを避けるため待機 (1秒だとセッション競合発生したため3秒に)
      await new Promise((r) => setTimeout(r, 3000));
    } catch (err) {
      results.push({ ticker, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({
    ok: true,
    processed: results.length,
    success: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}
