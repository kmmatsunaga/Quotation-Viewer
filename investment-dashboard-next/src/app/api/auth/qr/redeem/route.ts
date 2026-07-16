import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase-admin";

/**
 * POST /api/auth/qr/redeem
 * Body: { token: string }
 *
 * トークンを検証 → Firebase Custom Token を発行して返す。
 * iPhone側はこの Custom Token を使って signInWithCustomToken でログインする。
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const token = body?.token as string | undefined;
  if (!token) {
    return NextResponse.json({ error: "token required" }, { status: 400 });
  }

  const db = getAdminDb();
  const ref = db.collection("qrLoginTokens").doc(token);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  }

  const data = snap.data();
  if (data?.used) {
    return NextResponse.json({ error: "Token already used" }, { status: 410 });
  }

  const expiresAt = data?.expiresAt?.toDate?.() as Date | undefined;
  if (expiresAt && expiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: "Token expired" }, { status: 410 });
  }

  const uid = data?.uid as string | undefined;
  if (!uid) {
    return NextResponse.json({ error: "Invalid token data" }, { status: 500 });
  }

  // Custom Token 発行
  const customToken = await getAdminAuth().createCustomToken(uid);

  // 使用済みフラグを立てる
  await ref.update({ used: true, usedAt: new Date() });

  return NextResponse.json({
    ok: true,
    customToken,
    email: data?.email,
  });
}
