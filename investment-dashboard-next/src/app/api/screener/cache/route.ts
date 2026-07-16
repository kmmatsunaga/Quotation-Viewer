import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";

/**
 * GET /api/screener/cache?scope=nikkei225
 * 保存済みスクリーナー結果を返す (全銘柄キャッシュ用)。
 *
 * POST /api/screener/cache?scope=nikkei225
 * Body: { results: FundamentalData[] }
 * スキャン完了後にユーザーが保存する。
 */

interface CacheBody {
  results: unknown[];
}

export async function GET(req: NextRequest) {
  const scope = req.nextUrl.searchParams.get("scope") ?? "nikkei225";
  const db = getAdminDb();
  const snap = await db.collection("meta").doc(`screenerCache_${scope}`).get();
  if (!snap.exists) {
    return NextResponse.json({ ok: false, error: "No cache yet" }, { status: 404 });
  }
  const data = snap.data();
  return NextResponse.json({
    ok: true,
    scope,
    updatedAt: data?.updatedAt?.toDate?.()?.toISOString() ?? null,
    count: data?.results?.length ?? 0,
    results: data?.results ?? [],
  });
}

export async function POST(req: NextRequest) {
  // Firebase ID Token 認証
  const authHeader = req.headers.get("authorization");
  const apiKey = req.headers.get("x-api-key");
  let authorized = false;

  if (apiKey && apiKey === process.env.MCP_API_KEY) {
    authorized = true;
  } else if (authHeader?.startsWith("Bearer ")) {
    try {
      const { getAdminAuth } = await import("@/lib/firebase-admin");
      const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
      if (decoded.email === "make.some.noise6984@gmail.com") authorized = true;
    } catch {}
  }
  if (!authorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const scope = req.nextUrl.searchParams.get("scope") ?? "nikkei225";
  const body = (await req.json()) as CacheBody;
  if (!Array.isArray(body.results)) {
    return NextResponse.json({ error: "results array required" }, { status: 400 });
  }

  const db = getAdminDb();
  await db.collection("meta").doc(`screenerCache_${scope}`).set({
    results: body.results,
    updatedAt: new Date(),
    scope,
  });

  return NextResponse.json({ ok: true, count: body.results.length });
}
