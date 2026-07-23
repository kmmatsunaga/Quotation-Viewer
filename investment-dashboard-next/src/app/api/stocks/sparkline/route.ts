import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";

/**
 * GET /api/stocks/sparkline?tickers=7203,AAPL&tf=1mo
 *
 * お気に入りカード用の軽量バッチ:
 *   - 各 ticker の終値配列 (スパークライン用、古い順)
 *   - score_rankings_latest から S/M/L/overall スコアを join
 *
 * tf (時間軸):
 *   1m  = 当日・1分足   (iSpeed的ザラ場ビュー、Yahoo は約15-20分遅延)
 *   5m  = 5日・5分足
 *   1mo = 1ヶ月・日足 (デフォルト)
 *   3mo = 3ヶ月・日足
 *
 * 最大 30 銘柄。Yahoo v8 chart を並列取得 (closes のみの軽量ペイロード)。
 */

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

export const maxDuration = 30;

const TF_CONFIG: Record<string, { range: string; interval: string; revalidate: number }> = {
  "1m": { range: "1d", interval: "1m", revalidate: 60 },
  "5m": { range: "5d", interval: "5m", revalidate: 300 },
  "1mo": { range: "1mo", interval: "1d", revalidate: 900 },
  "3mo": { range: "3mo", interval: "1d", revalidate: 900 },
};

interface SparkEntry {
  ticker: string;
  closes: number[];          // 古い順
  price: number | null;      // 最新値
  changePct: number | null;  // 前日比%
  periodChangePct: number | null; // 期間騰落率 (先頭比)
  scores: { short: number; mid: number; long: number; overall: number } | null;
  startTime: string | null;  // 最初の点の時刻 (JST "HH:MM")
  endTime: string | null;    // 最後の点の時刻 (JST "HH:MM")
}

/** unix秒 → JST "HH:MM" */
function jstHM(sec: number): string {
  const d = new Date(sec * 1000 + 9 * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export async function GET(req: NextRequest) {
  const tickersParam = req.nextUrl.searchParams.get("tickers") ?? "";
  const tfParam = req.nextUrl.searchParams.get("tf") ?? req.nextUrl.searchParams.get("range") ?? "1mo";
  const tf = TF_CONFIG[tfParam] ? tfParam : "1mo";
  const { range, interval, revalidate } = TF_CONFIG[tf];
  const tickers = tickersParam
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 30);
  if (tickers.length === 0) {
    return NextResponse.json({ ok: false, error: "tickers required" }, { status: 400 });
  }

  const startedAt = Date.now();

  // スコア join 用 (取れなくても続行)
  const scoreMap = new Map<string, { short: number; mid: number; long: number; overall: number }>();
  try {
    const db = getAdminDb();
    const latest = await db.collection("meta").doc("score_rankings_latest").get();
    const ref = latest.data()?.ref as string | undefined;
    if (ref) {
      const doc = await db.collection("meta").doc(ref).get();
      const entries = (doc.data()?.entries ?? []) as { ticker: string; short: number; mid: number; long: number; overall: number }[];
      for (const e of entries) scoreMap.set(e.ticker, { short: e.short, mid: e.mid, long: e.long, overall: e.overall });
    }
  } catch {}

  const results = await Promise.all(
    tickers.map(async (ticker): Promise<SparkEntry> => {
      const isJP = /^\d{3,4}[A-Z]?$/.test(ticker);
      const yfTicker = isJP ? `${ticker}.T` : ticker;
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfTicker)}?range=${range}&interval=${interval}`;
        const res = await fetch(url, { headers: YF_HEADERS, next: { revalidate } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        const r = j.chart?.result?.[0];
        const raw = (r?.indicators?.quote?.[0]?.close ?? []) as (number | null)[];
        const ts = (r?.timestamp ?? []) as number[];
        // 有効な終値だけ残し、対応するタイムスタンプも同じ添字で残す
        const validTs: number[] = [];
        const closes: number[] = [];
        for (let i = 0; i < raw.length; i++) {
          const c = raw[i];
          if (c !== null && Number.isFinite(c)) { closes.push(c); validTs.push(ts[i] ?? 0); }
        }
        const price = closes.length > 0 ? closes[closes.length - 1] : null;
        const prev = closes.length > 1 ? closes[closes.length - 2] : null;
        const first = closes.length > 0 ? closes[0] : null;
        const startTime = validTs.length > 0 && validTs[0] > 0 ? jstHM(validTs[0]) : null;
        const endTime = validTs.length > 0 && validTs[validTs.length - 1] > 0 ? jstHM(validTs[validTs.length - 1]) : null;
        // 分足は点数が多いので間引き (最大120点)
        const MAX_PTS = 120;
        const thinned =
          closes.length > MAX_PTS
            ? closes.filter((_, i) => i % Math.ceil(closes.length / MAX_PTS) === 0 || i === closes.length - 1)
            : closes;
        return {
          ticker,
          closes: thinned.map((c) => Math.round(c * 100) / 100),
          price,
          changePct: price !== null && prev !== null && prev !== 0 ? Math.round((price / prev - 1) * 10000) / 100 : null,
          periodChangePct: price !== null && first !== null && first !== 0 ? Math.round((price / first - 1) * 10000) / 100 : null,
          scores: scoreMap.get(ticker) ?? null,
          startTime,
          endTime,
        };
      } catch {
        return { ticker, closes: [], price: null, changePct: null, periodChangePct: null, scores: scoreMap.get(ticker) ?? null, startTime: null, endTime: null };
      }
    })
  );

  return NextResponse.json({
    ok: true,
    tf,
    range,
    interval,
    entries: Object.fromEntries(results.map((r) => [r.ticker, r])),
    elapsedMs: Date.now() - startedAt,
  });
}
