import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";

/**
 * GET /api/rankings/score?date=YYYYMMDD (省略時は最新)
 *
 * Firestore meta/score_rankings_{YYYYMMDD} を返す。
 * 認証不要 (お気に入りや投資判断には個人情報含まれない)。
 */
export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date");
  const db = getAdminDb();

  let docId: string;
  if (date && /^\d{8}$/.test(date)) {
    docId = `score_rankings_${date}`;
  } else {
    // latest pointer から
    const latest = await db.collection("meta").doc("score_rankings_latest").get();
    if (!latest.exists) {
      return NextResponse.json(
        { ok: false, error: "No rankings cached yet. Run /api/cron/score-rankings first." },
        { status: 404 }
      );
    }
    docId = (latest.data()?.ref as string) ?? "";
  }

  const snap = await db.collection("meta").doc(docId).get();
  if (!snap.exists) {
    return NextResponse.json({ ok: false, error: `Document ${docId} not found` }, { status: 404 });
  }
  const data = snap.data() ?? {};
  const computedAt =
    data.computedAt?.toDate?.()?.toISOString?.() ?? data.computedAtIso ?? null;

  return NextResponse.json({
    ok: true,
    date: data.date,
    universe: data.universe,
    processed: data.processed,
    errors: data.errors,
    elapsedMs: data.elapsedMs,
    entries: data.entries ?? [],
    computedAt,
  });
}
