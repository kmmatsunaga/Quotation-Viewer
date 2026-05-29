import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";

/**
 * GET /api/stocks/sector-rank/[ticker]
 *
 * 該当銘柄のセクター内ランキングを返す。
 *
 * フロー:
 *   1. /api/stocks/fundamentals でセクターを取得
 *   2. 同セクターの銘柄を score_rankings_latest から抽出 (高速)
 *   3. ランキング・乖離率・平均を集計
 */

interface RankingEntry {
  ticker: string;
  name: string;
  market: string;
  short: number;
  mid: number;
  long: number;
  overall: number;
  price: number | null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params;
  if (!ticker) {
    return NextResponse.json({ error: "ticker required" }, { status: 400 });
  }

  const host = req.headers.get("host") ?? "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const base = `${proto}://${host}`;

  try {
    // セクター情報を取得 (該当銘柄)
    const fundRes = await fetch(
      `${base}/api/stocks/fundamentals?tickers=${encodeURIComponent(ticker)}`,
      { next: { revalidate: 1800 } }
    );
    if (!fundRes.ok) {
      return NextResponse.json({ ok: false, error: "fundamentals 取得失敗" }, { status: 500 });
    }
    const fundData = await fundRes.json();
    const target = fundData.fundamentals?.[ticker];
    if (!target?.sector) {
      return NextResponse.json({
        ok: false,
        error: "セクター情報なし (Yahoo データ不足)",
      });
    }
    const sector = target.sector as string;

    // 最新ランキングを取得
    const db = getAdminDb();
    const latestPointer = await db.collection("meta").doc("score_rankings_latest").get();
    if (!latestPointer.exists) {
      return NextResponse.json({ ok: false, error: "ランキングキャッシュ無し" });
    }
    const refDocId = (latestPointer.data()?.ref as string) ?? "";
    const rankingsSnap = await db.collection("meta").doc(refDocId).get();
    const entries = (rankingsSnap.data()?.entries ?? []) as RankingEntry[];

    if (entries.length === 0) {
      return NextResponse.json({ ok: false, error: "ランキング entries 無し" });
    }

    // 同セクター銘柄のセクター情報をまとめて取得 (バッチで)
    // 既に entries にスコアあるが sector情報はないので別途取得
    const allTickers = entries.map((e) => e.ticker);
    // 一度に最大 20 銘柄なので、ターゲットを少し絞る (高速化)
    // ロジック: 該当銘柄含む 20件をランダムサンプル + 上位 20件
    const sample = entries
      .slice(0, 30) // 上位30 (overall高い順だが、計算上 entries は overall ソートではない)
      .map((e) => e.ticker);
    if (!sample.includes(ticker)) sample.push(ticker);

    // fundamentals でセクターを引く (20銘柄ずつバッチ)
    const sectorMap = new Map<string, string>();
    sectorMap.set(ticker, sector); // 既に持ってる
    const BATCH = 20;
    // 高速化のため、よく見られる代表銘柄のみ照会 (5バッチ = 100銘柄)
    const lookupTickers = allTickers.filter((t) => t !== ticker).slice(0, 100);
    for (let i = 0; i < lookupTickers.length; i += BATCH) {
      const batch = lookupTickers.slice(i, i + BATCH);
      try {
        const r = await fetch(
          `${base}/api/stocks/fundamentals?tickers=${encodeURIComponent(batch.join(","))}`,
          { next: { revalidate: 1800 } }
        );
        if (!r.ok) continue;
        const j = await r.json();
        for (const [t, f] of Object.entries(j.fundamentals ?? {}) as [string, { sector?: string }][]) {
          if (f?.sector) sectorMap.set(t, f.sector);
        }
      } catch {}
      void sample; // suppress unused
    }

    // 同セクターの entries を集計
    const sectorEntries = entries.filter((e) => sectorMap.get(e.ticker) === sector);
    if (sectorEntries.length === 0) {
      return NextResponse.json({
        ok: false,
        error: "同セクター銘柄が見つからない",
        sector,
        ticker,
      });
    }

    // ランキング集計 (各時間軸)
    const sorted = (key: "short" | "mid" | "long" | "overall") =>
      [...sectorEntries].sort((a, b) => b[key] - a[key]);

    const targetEntry = sectorEntries.find((e) => e.ticker === ticker);
    if (!targetEntry) {
      // 対象銘柄が ranking に居ない → スコア無し
      return NextResponse.json({
        ok: false,
        error: "対象銘柄がランキングキャッシュに存在せず",
        sector,
        ticker,
      });
    }

    const ranks: Record<string, { rank: number; total: number; avg: number; topName: string; pct: number }> = {};
    for (const key of ["short", "mid", "long", "overall"] as const) {
      const sortedList = sorted(key);
      const idx = sortedList.findIndex((e) => e.ticker === ticker);
      const avg = sortedList.reduce((a, b) => a + b[key], 0) / sortedList.length;
      ranks[key] = {
        rank: idx + 1,
        total: sortedList.length,
        avg: Math.round(avg * 10) / 10,
        topName: sortedList[0].name,
        pct: Math.round((targetEntry[key] - avg) * 10) / 10,
      };
    }

    return NextResponse.json({
      ok: true,
      ticker,
      sector,
      sectorEntries: sectorEntries.length,
      target: {
        short: targetEntry.short,
        mid: targetEntry.mid,
        long: targetEntry.long,
        overall: targetEntry.overall,
      },
      ranks,
      // セクター内 Top 10
      sectorTop: sorted("overall").slice(0, 10).map((e) => ({
        ticker: e.ticker,
        name: e.name,
        overall: e.overall,
        short: e.short,
        mid: e.mid,
        long: e.long,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
