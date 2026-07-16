import { NextRequest, NextResponse } from "next/server";
import { tachibanaLogin, tachibanaLogout, getAllJpStocks } from "@/lib/tachibana";
import { getAdminDb } from "@/lib/firebase-admin";

/**
 * POST /api/stocks/master
 *   Header: x-api-key
 *   立花APIから全銘柄マスタを取得して Firestore (`meta/jpStockMaster`) に保存。
 *   実行時間: 数秒〜数十秒。手動 or 週1回 cron で実行。
 *
 * GET /api/stocks/master
 *   Firestore から全銘柄リストを返す。
 *   キャッシュなしならエラー (まずPOSTで更新が必要)。
 */

const API_KEY = process.env.MCP_API_KEY;
const MASTER_DOC = "jpStockMaster";

export async function GET() {
  const db = getAdminDb();
  const snap = await db.collection("meta").doc(MASTER_DOC).get();
  if (!snap.exists) {
    return NextResponse.json({ ok: false, error: "Master not yet downloaded" }, { status: 404 });
  }
  const data = snap.data();
  return NextResponse.json({
    ok: true,
    updatedAt: data?.updatedAt?.toDate?.()?.toISOString() ?? null,
    count: data?.stocks?.length ?? 0,
    stocks: data?.stocks ?? [],
  });
}

export async function POST(req: NextRequest) {
  if (!API_KEY || req.headers.get("x-api-key") !== API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let session = null;
  try {
    session = await tachibanaLogin();
    const stocks = await getAllJpStocks(session);

    const db = getAdminDb();
    await db.collection("meta").doc(MASTER_DOC).set({
      stocks,
      updatedAt: new Date(),
      source: "tachibana",
    });

    return NextResponse.json({ ok: true, count: stocks.length });
  } catch (err: unknown) {
    const e = err as Error;
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  } finally {
    if (session) await tachibanaLogout(session).catch(() => {});
  }
}
