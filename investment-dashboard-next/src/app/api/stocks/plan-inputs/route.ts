import { NextRequest, NextResponse } from "next/server";
import { getCachedJpStocks } from "@/lib/jp-stocks-cache";

/**
 * GET /api/stocks/plan-inputs?ticker=7203
 *
 * 買い方プラン (position-plan) の計算材料を返す:
 *   現在値 / ATR14 / 20日安値 / 60日安値 / 銘柄名
 * Yahoo 日足 6ヶ月から算出。計算本体は client の position-plan.ts (純関数)。
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!/^\d{3,4}[A-Z0-9]?$/.test(ticker)) {
    return NextResponse.json({ error: "ticker が不正です (日本株のみ対応)" }, { status: 400 });
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}.T?range=6mo&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 600 } });
    if (!res.ok) return NextResponse.json({ error: `Yahoo ${res.status}` }, { status: 502 });
    const j = await res.json();
    const r = j?.chart?.result?.[0];
    const q = r?.indicators?.quote?.[0];
    const ts: number[] = r?.timestamp ?? [];
    if (!q || ts.length < 30) return NextResponse.json({ error: "価格データ不足" }, { status: 404 });

    interface Bar { h: number; l: number; c: number }
    const bars: Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if ([h, l, c].every((v: unknown) => typeof v === "number" && isFinite(v as number))) {
        bars.push({ h, l, c });
      }
    }
    if (bars.length < 30) return NextResponse.json({ error: "有効データ不足" }, { status: 404 });

    const last = bars[bars.length - 1];
    // ATR14
    let atrSum = 0;
    for (let i = bars.length - 14; i < bars.length; i++) {
      const tr = Math.max(
        bars[i].h - bars[i].l,
        Math.abs(bars[i].h - bars[i - 1].c),
        Math.abs(bars[i].l - bars[i - 1].c),
      );
      atrSum += tr;
    }
    const atr = atrSum / 14;
    const low20 = Math.min(...bars.slice(-20).map((b) => b.l));
    const low60 = Math.min(...bars.slice(-60).map((b) => b.l));

    let name = ticker;
    try {
      const master = await getCachedJpStocks();
      name = master.find((s) => s.ticker === ticker)?.name ?? ticker;
    } catch {}

    return NextResponse.json({
      ticker, name,
      price: last.c,
      atr: Math.round(atr * 10) / 10,
      atrPct: Math.round((atr / last.c) * 1000) / 10,
      low20, low60,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
