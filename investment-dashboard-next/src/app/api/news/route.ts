import { NextRequest, NextResponse } from "next/server";
import { tachibanaLogin, tachibanaLogout, getNewsHeaders } from "@/lib/tachibana";
import { getAdminAuth, getAdminDb } from "@/lib/firebase-admin";

const ALLOWED_EMAILS = ["make.some.noise6984@gmail.com"];

/**
 * GET /api/news?ticker=7203&limit=30&days=30&fresh=1
 *
 * Firestore キャッシュ層付き (60分 TTL)。複数パネルが並行アクセスして立花
 * セッションを奪い合う問題を回避。
 *
 * 認証: x-api-key (MCP) または Bearer Firebase ID Token (ブラウザ)
 *
 * クエリ:
 *   ticker: 銘柄コード絞り込み (省略可)
 *   limit: 最大100 (デフォルト30)
 *   days: 過去何日分か (デフォルト30)
 *   fresh=1: キャッシュ無視して立花直叩き (任意)
 *
 * キャッシュキー: meta/news_cache_{ticker}_{days}d  (ticker省略時は __all__)
 */

const CACHE_TTL_MIN = 60;

export async function GET(req: NextRequest) {
  // 認証
  const apiKey = req.headers.get("x-api-key");
  const authHeader = req.headers.get("authorization");
  let authorized = false;
  if (apiKey && apiKey === process.env.MCP_API_KEY) {
    authorized = true;
  } else if (authHeader?.startsWith("Bearer ")) {
    try {
      const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
      if (decoded.email && ALLOWED_EMAILS.includes(decoded.email)) authorized = true;
    } catch {}
  }
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ticker = req.nextUrl.searchParams.get("ticker") ?? undefined;
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? "30"), 100);
  const days = Number(req.nextUrl.searchParams.get("days") ?? "30");
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";

  const db = getAdminDb();
  const cacheKey = `news_cache_${ticker ?? "__all__"}_${days}d`;
  const cacheRef = db.collection("meta").doc(cacheKey);

  // ── Firestore キャッシュ確認 ──
  if (!fresh) {
    try {
      const snap = await cacheRef.get();
      if (snap.exists) {
        const data = snap.data();
        const cachedAt =
          data?.cachedAt?.toDate?.()?.getTime?.() ??
          (data?.cachedAtIso ? new Date(data.cachedAtIso).getTime() : 0);
        const ageMin = (Date.now() - cachedAt) / 60000;
        if (ageMin < CACHE_TTL_MIN) {
          return NextResponse.json({
            ok: true,
            total: data?.total ?? 0,
            items: (data?.items ?? []).slice(0, limit),
            query: { ticker, days, limit },
            cached: true,
            ageMin: Math.round(ageMin),
          });
        }
      }
    } catch {}
  }

  // ── 立花から取得 ──
  const dateTo = formatDateJst(new Date());
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);
  const dateFrom = formatDateJst(fromDate);

  let session = null;
  // セッション切断時の自動リトライ (1回まで)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      session = await tachibanaLogin();
      const result = await getNewsHeaders(session, {
        issueCode: ticker,
        dateFrom,
        dateTo,
        limit: Math.max(limit, 50),  // キャッシュ用に少し多めに取る
      });

      // Firestore に保存
      try {
        const { FieldValue } = await import("firebase-admin/firestore");
        await cacheRef.set({
          ticker: ticker ?? null,
          days,
          total: result.total,
          items: result.items,
          cachedAt: FieldValue.serverTimestamp(),
          cachedAtIso: new Date().toISOString(),
        });
      } catch (cacheErr) {
        console.error("news cache save failed:", cacheErr);
      }

      return NextResponse.json({
        ok: true,
        total: result.total,
        items: result.items.slice(0, limit),
        query: { ticker, dateFrom, dateTo, limit },
        cached: false,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // セッション切断系のエラーは 1回だけリトライ
      const isSessionErr =
        msg.includes("セッション") ||
        msg.includes("切断") ||
        msg.includes("session");
      if (attempt === 0 && isSessionErr) {
        // 少し待ってからリトライ
        try { if (session) await tachibanaLogout(session); } catch {}
        session = null;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      // 最終的に失敗 → stale キャッシュがあれば返す (UX 優先)
      try {
        const snap = await cacheRef.get();
        if (snap.exists) {
          const data = snap.data();
          const cachedAt =
            data?.cachedAt?.toDate?.()?.getTime?.() ??
            (data?.cachedAtIso ? new Date(data.cachedAtIso).getTime() : 0);
          return NextResponse.json({
            ok: true,
            total: data?.total ?? 0,
            items: (data?.items ?? []).slice(0, limit),
            query: { ticker, days, limit },
            cached: true,
            stale: true,
            ageMin: Math.round((Date.now() - cachedAt) / 60000),
            staleReason: msg,
          });
        }
      } catch {}
      return NextResponse.json({ ok: false, error: msg }, { status: 500 });
    } finally {
      if (session) await tachibanaLogout(session).catch(() => {});
    }
  }

  return NextResponse.json({ ok: false, error: "Unknown" }, { status: 500 });
}

function formatDateJst(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
