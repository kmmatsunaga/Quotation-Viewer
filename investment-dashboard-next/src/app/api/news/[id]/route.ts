import { NextRequest, NextResponse } from "next/server";
import { tachibanaLogin, tachibanaLogout, getNewsBody } from "@/lib/tachibana";
import { getAdminAuth, getAdminDb } from "@/lib/firebase-admin";

const ALLOWED_EMAILS = ["make.some.noise6984@gmail.com"];

/**
 * GET /api/news/[id]
 * 認証: x-api-key (MCP) または Bearer Firebase ID Token (ブラウザ)
 *
 * 1件のニュース本文を取得 (Firestore 永続キャッシュ)。
 * ニュース本文は基本変わらないので一度取ったら無期限キャッシュ。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  // Firestore キャッシュ確認 (本文は永続)
  const db = getAdminDb();
  // ニュース ID をそのまま docID に使う (Firestore は / を含めなければ可)
  const safeId = id.replace(/[^a-zA-Z0-9_]/g, "_");
  const cacheRef = db.collection("meta").doc(`news_body_${safeId}`);
  try {
    const snap = await cacheRef.get();
    if (snap.exists) {
      const data = snap.data();
      if (data?.news) {
        return NextResponse.json({ ok: true, news: data.news, cached: true });
      }
    }
  } catch {}

  // セッション切断時の自動リトライ (1回まで)
  let session = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      session = await tachibanaLogin();
      const body = await getNewsBody(session, id);
      if (!body) {
        return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
      }

      // キャッシュ保存
      try {
        const { FieldValue } = await import("firebase-admin/firestore");
        await cacheRef.set({
          newsId: id,
          news: body,
          cachedAt: FieldValue.serverTimestamp(),
        });
      } catch (cacheErr) {
        console.error("news body cache save failed:", cacheErr);
      }

      return NextResponse.json({ ok: true, news: body, cached: false });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isSessionErr =
        msg.includes("セッション") || msg.includes("切断") || msg.includes("session");
      if (attempt === 0 && isSessionErr) {
        try { if (session) await tachibanaLogout(session); } catch {}
        session = null;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      return NextResponse.json({ ok: false, error: msg }, { status: 500 });
    } finally {
      if (session) await tachibanaLogout(session).catch(() => {});
    }
  }

  return NextResponse.json({ ok: false, error: "Unknown" }, { status: 500 });
}
