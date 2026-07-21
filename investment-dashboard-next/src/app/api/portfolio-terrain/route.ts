import { NextRequest, NextResponse } from "next/server";
import { assessTerrain, summarizePortfolioTerrain, type TerrainBar, type HoldingTerrain } from "@/lib/fragile-terrain";

/**
 * POST /api/portfolio-terrain
 * body: { holdings: [{ ticker, name, value }] }  (value = 時価評価額)
 *
 * 各保有の地形スコアを日足から算出し、時価加重で「資産の何%が脆弱地形か」を返す。
 * 認証は不要 (銘柄コードと重みだけ受け取る。個人情報は含まない)。日本株のみ評価。
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const YF_HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

async function fetchBars(ticker: string): Promise<TerrainBar[]> {
  const isJP = /^\d{3,}[A-Z]?$/.test(ticker);
  const yf = isJP ? `${ticker}.T` : encodeURIComponent(ticker);
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yf}?range=3mo&interval=1d`, {
      headers: YF_HEADERS, next: { revalidate: 600 },
    });
    if (!res.ok) return [];
    const j = await res.json();
    const q = j?.chart?.result?.[0]?.indicators?.quote?.[0];
    if (!q) return [];
    const out: TerrainBar[] = [];
    for (let i = 0; i < q.close.length; i++) {
      const h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if ([h, l, c].every((v: unknown) => typeof v === "number" && isFinite(v as number))) {
        out.push({ high: h, low: l, close: c });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  let body: { holdings?: { ticker: string; name?: string; value?: number }[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }
  const holdings = (body.holdings ?? []).filter((h) => h.ticker && (h.value ?? 0) > 0);
  if (holdings.length === 0) return NextResponse.json({ ok: true, summary: null });

  // 日本株のみ地形評価 (米株・投信は「評価不能」として時価には含めるが tier=null)
  const results: HoldingTerrain[] = [];
  for (let i = 0; i < holdings.length; i += 6) {
    const batch = holdings.slice(i, i + 6);
    const rs = await Promise.all(batch.map(async (h) => {
      const isJP = /^\d{3,4}[A-Z]?$/.test(h.ticker);
      if (!isJP) return { ticker: h.ticker, name: h.name ?? h.ticker, value: h.value!, score: null, tier: null };
      const bars = await fetchBars(h.ticker);
      if (bars.length < 20) return { ticker: h.ticker, name: h.name ?? h.ticker, value: h.value!, score: null, tier: null };
      const t = assessTerrain({ price: bars[bars.length - 1].close, bars });
      return {
        ticker: h.ticker, name: h.name ?? h.ticker, value: h.value!,
        score: t?.score ?? null, tier: t?.tier ?? null,
      } as HoldingTerrain;
    }));
    results.push(...rs);
  }

  return NextResponse.json({ ok: true, summary: summarizePortfolioTerrain(results), holdings: results });
}
