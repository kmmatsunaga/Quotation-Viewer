import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { getAdminAuth } from "@/lib/firebase-admin";

const ALLOWED_EMAILS = ["make.some.noise6984@gmail.com"];

/**
 * GET /api/watchdog/events
 * Header: Authorization: Bearer <Firebase ID token>
 *   または x-api-key: <MCP_API_KEY> + ?email=xxx
 */
export async function GET(req: NextRequest) {
  const apiKey = req.headers.get("x-api-key");
  const authHeader = req.headers.get("authorization");
  let uid: string | null = null;

  if (apiKey && apiKey === process.env.MCP_API_KEY) {
    const email = req.nextUrl.searchParams.get("email");
    if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
    try {
      uid = (await getAdminAuth().getUserByEmail(email)).uid;
    } catch {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
  } else if (authHeader?.startsWith("Bearer ")) {
    try {
      const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
      if (decoded.email && ALLOWED_EMAILS.includes(decoded.email)) uid = decoded.uid;
    } catch {}
  }

  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? "50"), 100);
  const db = getAdminDb();
  const snap = await db
    .collection("users")
    .doc(uid)
    .collection("watchdogEvents")
    .orderBy("triggeredAt", "desc")
    .limit(limit)
    .get();

  const events = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      ...data,
      triggeredAt: data.triggeredAt?.toDate?.()?.toISOString() ?? null,
    };
  });

  return NextResponse.json({ ok: true, events });
}
