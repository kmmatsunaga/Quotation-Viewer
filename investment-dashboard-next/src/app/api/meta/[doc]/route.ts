import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";

/**
 * GET /api/meta/[doc] — 市場データ系の meta ドキュメントをサーバー経由で返す
 *
 * なぜ必要か: Firestore のセキュリティルールは users/{uid} 配下しか許可していないため、
 * クライアントから getDoc(doc(db,"meta",...)) は permission-denied で必ず失敗する。
 * 各所で .catch(() => {}) していたため「無言で空になる」バグになっていた
 * (地形バッジ・レジーム測定器・NCスクリーナーが全部これで表示されなかった)。
 *
 * meta は全ユーザー共通の市場データ (個人情報なし) なので Admin SDK で読んで返す。
 * 任意の meta ドキュメントを引けないよう、公開して良いものだけ許可リストで限定する。
 */

export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "regime_gauge",       // 🌊 レジーム測定器
  "terrain_latest",     // 🌪 全銘柄の地形スコア
  "net_cash_screener",  // 🏔 ネットキャッシュ比率スクリーナー
  "market_cap_latest",  // 🏗 時価総額基盤
]);

export async function GET(_req: NextRequest, ctx: { params: Promise<{ doc: string }> }) {
  const { doc } = await ctx.params;
  if (!ALLOWED.has(doc)) {
    return NextResponse.json({ ok: false, error: "not allowed" }, { status: 404 });
  }
  try {
    const snap = await getAdminDb().collection("meta").doc(doc).get();
    if (!snap.exists) return NextResponse.json({ ok: true, data: null });
    return NextResponse.json({ ok: true, data: snap.data() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
