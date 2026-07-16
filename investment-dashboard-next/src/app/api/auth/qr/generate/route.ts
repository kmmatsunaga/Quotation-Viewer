import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getAdminAuth, getAdminDb } from "@/lib/firebase-admin";

const ALLOWED_EMAILS = ["make.some.noise6984@gmail.com"];

/**
 * POST /api/auth/qr/generate
 * Header: Authorization: Bearer <Firebase ID token>
 *
 * PC (ログイン済み) が QR ログイン用の一時トークンを生成。
 * 有効期限 5分、1回使用で無効化。
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let uid: string;
  let email: string;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    if (!decoded.email || !ALLOWED_EMAILS.includes(decoded.email)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    uid = decoded.uid;
    email = decoded.email;
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  // 一時トークン生成 (URL-safe Base64)
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5分後

  const db = getAdminDb();
  await db.collection("qrLoginTokens").doc(token).set({
    uid,
    email,
    createdAt: new Date(),
    expiresAt,
    used: false,
  });

  // QR の中身に入れる URL
  const host = req.headers.get("host") ?? "localhost:3000";
  const proto = host.includes("localhost") ? "http" : "https";
  const url = `${proto}://${host}/qr-login?token=${token}`;

  return NextResponse.json({
    ok: true,
    token,
    url,
    expiresAt: expiresAt.toISOString(),
  });
}
