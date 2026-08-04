import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { buildCompass, sma, rsi14, type CompassInputs } from "@/lib/market-compass";

/**
 * GET /api/market-compass — 🧭 現在地コンパス
 *
 * 「大きな流れの中で、いまはどの局面か」を毎日同じ物差しで返す。予測はしない。
 * 材料はすべて既存の資産の組み立て:
 *   meta/regime_gauge (潮・温度) / meta/net_cash_screener (割安の水位) / ^N225 (傾き)
 *
 * ?cashRatio=..&beta=.. を渡すと「自分の位置」も併記する (任意)。
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const YF = { "User-Agent": "Mozilla/5.0" };

async function fetchNikkeiCloses(): Promise<number[]> {
  try {
    const res = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/%5EN225?range=2y&interval=1d",
      { headers: YF, next: { revalidate: 1800 } },
    );
    if (!res.ok) return [];
    const j = await res.json();
    const q = j?.chart?.result?.[0]?.indicators?.quote?.[0];
    return (q?.close ?? []).filter((c: unknown): c is number => typeof c === "number" && isFinite(c));
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  try {
    const db = getAdminDb();
    const [regimeSnap, ncSnap, closes] = await Promise.all([
      db.collection("meta").doc("regime_gauge").get(),
      db.collection("meta").doc("net_cash_screener").get(),
      fetchNikkeiCloses(),
    ]);

    const regime = regimeSnap.data() ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (ncSnap.data()?.entries ?? []) as any[];
    const fortress = entries.filter((e) => (e.ncRatio ?? 0) >= 1).length;

    const cashRatio = req.nextUrl.searchParams.get("cashRatio");
    const beta = req.nextUrl.searchParams.get("beta");

    const inputs: CompassInputs = {
      low60Pct: regime.low60Pct ?? null,
      high60Pct: regime.high60Pct ?? null,
      low60History: regime.history ?? [],
      nikkeiClose: closes.length ? closes[closes.length - 1] : null,
      nikkeiSma50: sma(closes, 50),
      nikkeiSma200: sma(closes, 200),
      nikkeiSma50Prev: sma(closes, 50, 20),
      nikkeiRsi14: rsi14(closes),
      netCashFortressCount: entries.length > 0 ? fortress : null,
      cashRatioPct: cashRatio != null && cashRatio !== "" ? Number(cashRatio) : null,
      portfolioBeta: beta != null && beta !== "" ? Number(beta) : null,
    };

    const reading = buildCompass(regime.date ?? new Date().toISOString().slice(0, 10), inputs);
    return NextResponse.json({ ok: true, compass: reading });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
