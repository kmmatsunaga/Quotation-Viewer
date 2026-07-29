import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase-admin";
import { summarize, EVAL_WINDOW, HORIZONS, type DayEval, type Horizon, type HorizonSummary } from "@/lib/recommend-eval";

/**
 * GET /api/recommend-accuracy — おすすめv2 の的中率サマリ (時間軸別)
 * 認証: Firebase ID トークン
 *
 * 統計単位は「営業日」(同日の銘柄は独立でないため)。/accuracy が表示する。
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  let uid: string | null = null;
  if (authHeader?.startsWith("Bearer ")) {
    try { uid = (await getAdminAuth().verifyIdToken(authHeader.slice(7))).uid; } catch {}
  }
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getAdminDb();
  const snap = await db
    .collection("users").doc(uid).collection("dailyRecommendations")
    .orderBy("date", "desc").limit(120).get();

  const byHorizon: Record<Horizon, DayEval[]> = { short: [], mid: [], long: [], kiyohara: [] };
  const maturing: Record<Horizon, number> = { short: 0, mid: 0, long: 0, kiyohara: 0 };

  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>;
    if (d.version !== 2) continue;
    const horizons = (d.horizons ?? {}) as Record<Horizon, unknown[]>;
    const ev = (d.horizonEval ?? {}) as Record<Horizon, DayEval>;
    for (const h of HORIZONS) {
      const hasPicks = (horizons[h]?.length ?? 0) > 0;
      if (!hasPicks) continue;
      if (ev[h]) byHorizon[h].push(ev[h]);
      else maturing[h]++; // 推薦はしたが、まだ満期が来ていない
    }
  }

  const summaries: HorizonSummary[] = HORIZONS.map((h) =>
    summarize(h, byHorizon[h], maturing[h])
  );

  return NextResponse.json({
    ok: true,
    windows: EVAL_WINDOW,
    summaries,
    // 直近の日次系列 (グラフ・デバッグ用)
    series: Object.fromEntries(
      HORIZONS.map((h) => [
        h,
        byHorizon[h].slice(0, 30).map((d) => ({
          date: d.date, maturedOn: d.maturedOn,
          pickExcess: d.pickExcess, controlExcess: d.controlExcess, edge: d.edge,
          winRate: d.winRate, unevaluable: d.unevaluable,
        })),
      ])
    ),
  });
}
