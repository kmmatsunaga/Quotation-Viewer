import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { ALL_SECTORS, type SectorDef } from "@/lib/jp-themes";

/**
 * GET /api/sectors/trends
 *
 * 業界/テーマごとに「熱さ」を集計。
 * 入力: meta/score_rankings_latest (Cavka が日次で計算済の Master Score 群)
 *
 * 出力: 各セクターについて
 *   - 平均スコア (構成銘柄の overall 平均)
 *   - 平均騰落率 — score_rankings には保有してないので一旦保留 (Phase 2 で /api/stocks/prices 連携)
 *   - 強気銘柄比率 (overall >= 65 の銘柄割合)
 *   - 弱気銘柄比率 (overall < 45)
 *   - Hot Index 0-100 (3要素合成)
 *
 * Firestore キャッシュ 1時間 (score_rankings の更新頻度に合わせる)
 */

const CACHE_HOURS = 1;
const CACHE_KEY = "sector_trends_latest";

interface RankingEntry {
  ticker: string;
  name: string;
  market: "JP" | "US";
  price: number | null;
  short: number;
  mid: number;
  long: number;
  overall: number;
}

interface SectorTrend {
  id: string;
  name: string;
  emoji: string;
  category: "industry" | "theme";
  description: string;
  macroDrivers: string[];
  coverage: number;            // ランキングに含まれていた銘柄数 / 定義銘柄数
  totalTickers: number;        // 定義された銘柄数
  matchedTickers: number;      // ランキングに含まれていた銘柄数
  avgOverall: number | null;   // 平均総合スコア
  avgShort: number | null;
  avgMid: number | null;
  avgLong: number | null;
  bullishRatio: number;        // overall >= 65 の比率 (0-1)
  bearishRatio: number;        // overall < 45 の比率
  topPicks: { ticker: string; name: string; overall: number; mid: number; long: number }[];  // Top 5
  weakest: { ticker: string; name: string; overall: number; mid: number; long: number }[];   // Worst 3
  hotIndex: number;            // 0-100 統合
}

function average(arr: number[]): number | null {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function computeHotIndex(avgOverall: number | null, bullishRatio: number, bearishRatio: number): number {
  // 平均スコアを 0-100 に正規化 (50 = 中立、+で熱い、-で冷たい)
  const avgComponent = avgOverall !== null ? avgOverall : 50;
  // 強気比率 - 弱気比率 を -1 〜 +1 にして、50 を中心に ±25pt 振らす
  const ratioComponent = 50 + (bullishRatio - bearishRatio) * 25;
  // 重み付け平均
  const score = avgComponent * 0.6 + ratioComponent * 0.4;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function aggregateSector(sector: SectorDef, byTicker: Map<string, RankingEntry>): SectorTrend {
  const matched = sector.tickers
    .map((t) => byTicker.get(t))
    .filter((e): e is RankingEntry => e !== undefined);

  const overalls = matched.map((e) => e.overall);
  const shorts = matched.map((e) => e.short);
  const mids = matched.map((e) => e.mid);
  const longs = matched.map((e) => e.long);

  const avgOverall = average(overalls);
  const bullishCount = matched.filter((e) => e.overall >= 65).length;
  const bearishCount = matched.filter((e) => e.overall < 45).length;
  const bullishRatio = matched.length > 0 ? bullishCount / matched.length : 0;
  const bearishRatio = matched.length > 0 ? bearishCount / matched.length : 0;

  const topPicks = [...matched]
    .sort((a, b) => b.overall - a.overall)
    .slice(0, 5)
    .map((e) => ({ ticker: e.ticker, name: e.name, overall: e.overall, mid: e.mid, long: e.long }));

  const weakest = [...matched]
    .sort((a, b) => a.overall - b.overall)
    .slice(0, 3)
    .map((e) => ({ ticker: e.ticker, name: e.name, overall: e.overall, mid: e.mid, long: e.long }));

  return {
    id: sector.id,
    name: sector.name,
    emoji: sector.emoji,
    category: sector.category,
    description: sector.description,
    macroDrivers: sector.macroDrivers,
    coverage: sector.tickers.length > 0 ? matched.length / sector.tickers.length : 0,
    totalTickers: sector.tickers.length,
    matchedTickers: matched.length,
    avgOverall: avgOverall !== null ? Math.round(avgOverall) : null,
    avgShort: average(shorts) !== null ? Math.round(average(shorts) as number) : null,
    avgMid: average(mids) !== null ? Math.round(average(mids) as number) : null,
    avgLong: average(longs) !== null ? Math.round(average(longs) as number) : null,
    bullishRatio: Math.round(bullishRatio * 100) / 100,
    bearishRatio: Math.round(bearishRatio * 100) / 100,
    topPicks,
    weakest,
    hotIndex: computeHotIndex(avgOverall, bullishRatio, bearishRatio),
  };
}

export async function GET(req: NextRequest) {
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  const startedAt = Date.now();
  const db = getAdminDb();

  // キャッシュ
  if (!fresh) {
    try {
      const snap = await db.collection("meta").doc(CACHE_KEY).get();
      if (snap.exists) {
        const data = snap.data();
        const cachedAt = data?.cachedAt?.toDate?.()?.getTime?.() ?? 0;
        const ageH = (Date.now() - cachedAt) / 3600000;
        if (ageH < CACHE_HOURS) {
          return NextResponse.json({ ok: true, cached: true, ageHours: Math.round(ageH * 10) / 10, ...data });
        }
      }
    } catch {}
  }

  try {
    // score_rankings_latest を取得
    const latest = await db.collection("meta").doc("score_rankings_latest").get();
    if (!latest.exists) {
      return NextResponse.json(
        { ok: false, error: "score_rankings_latest が未取得。/api/cron/score-rankings を先に実行してください" },
        { status: 503 }
      );
    }
    const ref = latest.data()?.ref as string | undefined;
    if (!ref) {
      return NextResponse.json({ ok: false, error: "no ref" }, { status: 500 });
    }
    const rankings = await db.collection("meta").doc(ref).get();
    if (!rankings.exists) {
      return NextResponse.json({ ok: false, error: `${ref} not found` }, { status: 404 });
    }
    const entries = (rankings.data()?.entries ?? []) as RankingEntry[];
    const byTicker = new Map(entries.map((e) => [e.ticker, e]));

    const trends = ALL_SECTORS.map((s) => aggregateSector(s, byTicker));
    // hotIndex で降順ソート
    const sorted = [...trends].sort((a, b) => b.hotIndex - a.hotIndex);
    const industries = sorted.filter((t) => t.category === "industry");
    const themes = sorted.filter((t) => t.category === "theme");

    const result = {
      sourceRef: ref,
      sourceDate: rankings.data()?.date ?? null,
      sourceEntries: entries.length,
      totalSectors: trends.length,
      industries,
      themes,
      hotTop10: sorted.slice(0, 10),
      coldTop10: [...sorted].sort((a, b) => a.hotIndex - b.hotIndex).slice(0, 10),
      elapsedMs: Date.now() - startedAt,
      computedAtIso: new Date().toISOString(),
    };

    // キャッシュ保存
    try {
      const { FieldValue } = await import("firebase-admin/firestore");
      await db.collection("meta").doc(CACHE_KEY).set({
        ...result,
        cachedAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.error("sector trends cache save failed:", err);
    }

    return NextResponse.json({ ok: true, cached: false, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
