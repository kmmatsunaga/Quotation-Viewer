import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";

/**
 * GET /api/verdict-latest
 *
 * 最新の verdict_history (日次 cron が記録) から、
 * ticker → 時間軸別スタンスのマップを返す。
 * お気に入りカードの「⚡対立中」バッジ等に使う軽量エンドポイント。
 */

function jstDateKey(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
}

export async function GET() {
  const db = getAdminDb();
  try {
    for (let i = 0; i <= 5; i++) {
      const key = jstDateKey(new Date(Date.now() - i * 24 * 3600 * 1000));
      const snap = await db.collection("meta").doc(`verdict_history_${key}`).get();
      if (!snap.exists) continue;
      const entries = (snap.data()?.entries ?? []) as {
        ticker: string;
        short: { stance: string; conviction: number };
        mid: { stance: string; conviction: number };
        long: { stance: string; conviction: number };
      }[];
      return NextResponse.json({
        ok: true,
        date: key,
        stances: Object.fromEntries(
          entries.map((e) => [e.ticker, { short: e.short.stance, mid: e.mid.stance, long: e.long.stance }])
        ),
      });
    }
    return NextResponse.json({ ok: true, date: null, stances: {} });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
