import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";

/**
 * GET /api/backtest/score-rankings?signal=overall&holdDays=5&topN=20
 *
 * meta/score_rankings_{YYYYMMDD} のスナップショットを使い、
 * 各時点の Top N 銘柄を保有 → N日後の価格でリターン計算 → 統計集計
 *
 * パラメータ:
 *   signal: 'overall' | 'short' | 'mid' | 'long' (デフォルト: overall)
 *   holdDays: 1, 3, 5, 10, 20, 60 (デフォルト: 5)
 *   topN: 各日選ぶ銘柄数 (デフォルト: 20)
 *   minScore: 採用最低スコア (デフォルト: 60)
 *
 * 出力: 全シグナル集計 (勝率/平均リターン/標準偏差) + 個別シグナル一覧
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

interface RankingDoc {
  date: string;
  entries: RankingEntry[];
}

interface SignalResult {
  entryDate: string;
  exitDate: string;
  ticker: string;
  name: string;
  market: string;
  entryScore: number;
  entryPrice: number;
  exitPrice: number;
  returnPct: number;
}

export async function GET(req: NextRequest) {
  const signal = (req.nextUrl.searchParams.get("signal") ?? "overall") as keyof RankingEntry;
  const holdDays = Math.max(1, Math.min(60, Number(req.nextUrl.searchParams.get("holdDays") ?? "5")));
  const topN = Math.max(1, Math.min(50, Number(req.nextUrl.searchParams.get("topN") ?? "20")));
  const minScore = Number(req.nextUrl.searchParams.get("minScore") ?? "60");

  const db = getAdminDb();

  // meta コレクションから score_rankings_* を全部取得 (最大100件)
  const snap = await db.collection("meta").orderBy("__name__").get();
  const rankingsDocs: { date: string; doc: RankingDoc }[] = [];
  for (const docSnap of snap.docs) {
    const id = docSnap.id;
    const m = id.match(/^score_rankings_(\d{8})$/);
    if (!m) continue;
    const data = docSnap.data() as RankingDoc;
    if (!data.entries || !data.date) continue;
    rankingsDocs.push({ date: m[1], doc: data });
  }
  rankingsDocs.sort((a, b) => a.date.localeCompare(b.date));

  if (rankingsDocs.length < 2) {
    return NextResponse.json({
      ok: false,
      error: `バックテストには最低2日分のスナップショットが必要。現在 ${rankingsDocs.length} 日分。`,
    });
  }

  // 各エントリ日について N 日後のスナップショットを引く
  const docsByDate = new Map(rankingsDocs.map((r) => [r.date, r.doc]));

  const results: SignalResult[] = [];

  for (const { date: entryDate, doc: entryDoc } of rankingsDocs) {
    // N日後の "exit date" 候補 (営業日換算は厳密でなく単純な日付加算で近似)
    const exitDateCandidates = nextNDays(entryDate, holdDays, 7);
    let exitDoc: RankingDoc | null = null;
    let exitDate: string | null = null;
    for (const cand of exitDateCandidates) {
      if (docsByDate.has(cand)) {
        exitDoc = docsByDate.get(cand)!;
        exitDate = cand;
        break;
      }
    }
    if (!exitDoc || !exitDate) continue;
    const exitMap = new Map(exitDoc.entries.map((e) => [e.ticker, e]));

    // エントリ日の Top N (シグナル順)
    const entryRanked = [...entryDoc.entries]
      .filter((e) => (e[signal] as number) >= minScore)
      .sort((a, b) => (b[signal] as number) - (a[signal] as number))
      .slice(0, topN);

    for (const e of entryRanked) {
      if (e.price === null) continue;
      const exit = exitMap.get(e.ticker);
      if (!exit || exit.price === null || e.price <= 0) continue;
      const returnPct = ((exit.price - e.price) / e.price) * 100;
      results.push({
        entryDate,
        exitDate,
        ticker: e.ticker,
        name: e.name,
        market: e.market,
        entryScore: e[signal] as number,
        entryPrice: e.price,
        exitPrice: exit.price,
        returnPct: Math.round(returnPct * 100) / 100,
      });
    }
  }

  // 集計
  if (results.length === 0) {
    return NextResponse.json({
      ok: true,
      summary: null,
      results: [],
      meta: {
        signal, holdDays, topN, minScore,
        availableDates: rankingsDocs.length,
      },
    });
  }

  const returns = results.map((r) => r.returnPct);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const winRate = (returns.filter((r) => r > 0).length / returns.length) * 100;
  const stdDev = Math.sqrt(
    returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / returns.length
  );
  const sortedRet = [...returns].sort((a, b) => a - b);
  const median = sortedRet[Math.floor(sortedRet.length / 2)];
  const p10 = sortedRet[Math.floor(sortedRet.length * 0.1)];
  const p90 = sortedRet[Math.floor(sortedRet.length * 0.9)];
  const minReturn = sortedRet[0];
  const maxReturn = sortedRet[sortedRet.length - 1];

  // 銘柄別集計 (この期間に複数回シグナル出た銘柄)
  const byTicker = new Map<string, { count: number; avgReturn: number; name: string }>();
  for (const r of results) {
    if (!byTicker.has(r.ticker)) {
      byTicker.set(r.ticker, { count: 0, avgReturn: 0, name: r.name });
    }
    const t = byTicker.get(r.ticker)!;
    t.count++;
    t.avgReturn += r.returnPct;
  }
  for (const t of byTicker.values()) t.avgReturn /= t.count;

  const topTickers = Array.from(byTicker.entries())
    .map(([ticker, t]) => ({ ticker, ...t, avgReturn: Math.round(t.avgReturn * 100) / 100 }))
    .sort((a, b) => b.avgReturn - a.avgReturn)
    .slice(0, 20);

  // Sharpe 風: 平均 / 標準偏差 (年率換算は holdDays 考慮)
  const sharpe = stdDev > 0 ? avgReturn / stdDev : 0;

  return NextResponse.json({
    ok: true,
    summary: {
      sampleCount: results.length,
      avgReturn: Math.round(avgReturn * 100) / 100,
      median: Math.round(median * 100) / 100,
      winRate: Math.round(winRate * 100) / 100,
      stdDev: Math.round(stdDev * 100) / 100,
      sharpe: Math.round(sharpe * 100) / 100,
      p10: Math.round(p10 * 100) / 100,
      p90: Math.round(p90 * 100) / 100,
      minReturn,
      maxReturn,
    },
    topTickers,
    results: results.slice(0, 100), // サンプルとして 100件返す
    meta: {
      signal,
      holdDays,
      topN,
      minScore,
      availableDates: rankingsDocs.length,
      dateRange: `${rankingsDocs[0].date} 〜 ${rankingsDocs[rankingsDocs.length - 1].date}`,
    },
  });
}

function nextNDays(yyyymmdd: string, n: number, slack: number): string[] {
  // n 日後 + slack 日後までの候補リスト (土日で当該日のスナップがなくてもよいよう)
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const base = Date.UTC(y, m, d);
  const arr: string[] = [];
  for (let i = n; i <= n + slack; i++) {
    const ts = base + i * 86400 * 1000;
    const dt = new Date(ts);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    arr.push(`${yy}${mm}${dd}`);
  }
  return arr;
}
