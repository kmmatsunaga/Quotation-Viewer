import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { NIKKEI225 } from "@/lib/nikkei225";
import { STOCK_LIST } from "@/lib/stock-list";
import { SP500 } from "@/lib/sp500";
import { getCronOrigin } from "@/lib/cron-origin";

/**
 * GET /api/cron/score-rankings
 *
 * 日経225 + 米国 S&P500 (約731銘柄) をスキャンして
 * 短期/中期/長期 スコアを取得、Firestore meta/score_rankings_{YYYYMMDD} に保存。
 *
 * 1日1回 JST 01:00 (= UTC 16:00) に実行。
 * 731銘柄 / 10並列 = 74バッチ × ~1.2秒 = ~90秒目安。Vercel 300秒制限内。
 *
 * 認証: Vercel Cron は Authorization: Bearer ${CRON_SECRET} を送ってくる。
 */

const CRON_SECRET = process.env.CRON_SECRET;

export const maxDuration = 300; // 5分

interface InsightApiResponse {
  ticker: string;
  name: string;
  currentPrice: number | null;
  short: { score: number; action: string };
  mid: { score: number; action: string };
  long: { score: number; action: string };
}

interface RankingEntry {
  ticker: string;
  name: string;
  market: "JP" | "US";
  price: number | null;
  short: number;
  mid: number;
  long: number;
  overall: number;  // (short + mid*2 + long*1.5) / 4.5
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const origin = getCronOrigin(req);

  const startedAt = Date.now();

  // ユニバース構築 (日経225 + 米国 S&P500 + 既存STOCK_LISTの追加分)
  const jpUniverse = NIKKEI225.map((s) => ({ ticker: s.ticker, name: s.name, market: "JP" as const }));
  // S&P500 をベースに、既存 STOCK_LIST の US も merge
  const usTickerSet = new Set<string>(SP500.map((s) => s.ticker));
  const usUniverse = [
    ...SP500.map((s) => ({ ticker: s.ticker, name: s.name, market: "US" as const })),
    ...STOCK_LIST.filter((s) => s.market === "US" && !usTickerSet.has(s.ticker)).map((s) => ({
      ticker: s.ticker,
      name: s.name,
      market: "US" as const,
    })),
  ];
  const universe = [...jpUniverse, ...usUniverse];

  const entries: RankingEntry[] = [];
  let errors = 0;
  const batchSize = 10;
  const TIMEOUT_MS = 25_000;

  for (let i = 0; i < universe.length; i += batchSize) {
    // 時間切れ予防 (250秒で打ち切り)
    if (Date.now() - startedAt > 250_000) {
      console.warn(`[score-rankings] time budget exceeded at i=${i}, stopping`);
      break;
    }
    const batch = universe.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (entry) => {
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
          const res = await fetch(`${origin}/api/stocks/insights?ticker=${entry.ticker}`, {
            signal: controller.signal,
          });
          clearTimeout(t);
          if (!res.ok) return null;
          const json = (await res.json()) as InsightApiResponse;
          if (!json.short || !json.mid || !json.long) return null;
          const overall = Math.round((json.short.score + json.mid.score * 2 + json.long.score * 1.5) / 4.5);
          const result: RankingEntry = {
            ticker: entry.ticker,
            name: entry.name,
            market: entry.market,
            price: json.currentPrice,
            short: json.short.score,
            mid: json.mid.score,
            long: json.long.score,
            overall,
          };
          return result;
        } catch {
          return null;
        }
      })
    );
    for (const r of results) {
      if (r) entries.push(r);
      else errors++;
    }
  }

  // Firestore 保存
  const today = new Date();
  const dateKey = todayKey(today);
  const db = getAdminDb();
  const { FieldValue } = await import("firebase-admin/firestore");
  await db.collection("meta").doc(`score_rankings_${dateKey}`).set({
    date: dateKey,
    universe: { jp: jpUniverse.length, us: usUniverse.length, total: universe.length },
    processed: entries.length,
    errors,
    elapsedMs: Date.now() - startedAt,
    entries,
    computedAt: FieldValue.serverTimestamp(),
  });

  // 「最新」へのポインタも更新
  await db.collection("meta").doc("score_rankings_latest").set({
    dateKey,
    ref: `score_rankings_${dateKey}`,
    processed: entries.length,
    errors,
    computedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({
    ok: true,
    date: dateKey,
    processed: entries.length,
    errors,
    elapsedMs: Date.now() - startedAt,
  });
}

function todayKey(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
