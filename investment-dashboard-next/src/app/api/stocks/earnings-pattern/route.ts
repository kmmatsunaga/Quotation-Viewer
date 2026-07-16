import { NextRequest, NextResponse } from "next/server";
import { yfQuoteSummary } from "@/lib/yahoo-finance";

/**
 * GET /api/stocks/earnings-pattern?ticker=7203
 *
 * 過去N回の決算前後の値動きパターンを分析。
 *
 * 戦略:
 *   1. earningsHistory から過去の決算日と実績を取得
 *   2. 各決算日の前後 ±15日の株価データを取得
 *   3. 決算前(7d/3d/1d) / 当日 / 決算後(1d/3d/7d) の値動きを計算
 *   4. 統計量 (平均/中央値/勝率/標準偏差) を算出
 *   5. 推奨売り時/買い時を判定
 */

const YF_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

interface EarningsEvent {
  date: string;             // YYYY-MM-DD
  epsActual: number | null;
  epsEstimate: number | null;
  surprisePercent: number | null;
}

interface MovementSnapshot {
  pre14d: number | null;
  pre7d: number | null;
  pre3d: number | null;
  pre1d: number | null;
  dayOf: number | null;     // 寄り or 翌寄りギャップ (当日終値 vs 前日終値)
  post1d: number | null;    // 当日終値 → 翌日終値
  post3d: number | null;
  post7d: number | null;
  pre7dHigh: number | null; // 決算前7日間の最高値到達日 (1-7)
}

export interface EarningsPatternResult {
  ticker: string;
  nextEarningsDate: string | null;   // 次回決算予定日 (YYYY-MM-DD)
  daysToNext: number | null;          // 次回までの残日数 (負なら過ぎてる)
  lastEarningsDate: string | null;    // 直近の決算日 (YYYY-MM-DD)
  daysSinceLast: number | null;       // 直近からの経過日数
  events: (EarningsEvent & MovementSnapshot)[];
  stats: {
    sampleSize: number;
    avgPre14d: number | null;
    avgPre7d: number | null;
    avgPre3d: number | null;
    avgDayOf: number | null;
    avgPost1d: number | null;
    avgPost3d: number | null;
    avgPost7d: number | null;
    winRatePre7d: number | null;     // 決算前7日が上昇した回数 / 全回数
    winRateDayOf: number | null;     // 決算当日が上昇した回数 / 全回数
    winRatePost7d: number | null;
    volatilityPost1d: number | null; // 標準偏差
  };
  insights: {
    bestSellTiming: string | null;   // 推奨売り時
    bestBuyTiming: string | null;    // 推奨買い時
    summary: string;                  // 全体パターン解説
  };
}

function tsToDateString(ts: number | undefined | null): string | null {
  if (!ts || typeof ts !== "number") return null;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function raw(obj: Record<string, unknown> | undefined, key: string): number | null {
  if (!obj) return null;
  const v = obj[key];
  if (v && typeof v === "object" && "raw" in (v as Record<string, unknown>)) {
    return (v as { raw: number }).raw;
  }
  if (typeof v === "number") return v;
  return null;
}

function avg(arr: (number | null)[]): number | null {
  const valid = arr.filter((v): v is number => v !== null && !isNaN(v));
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function winRate(arr: (number | null)[]): number | null {
  const valid = arr.filter((v): v is number => v !== null && !isNaN(v));
  if (valid.length === 0) return null;
  const wins = valid.filter((v) => v > 0).length;
  return (wins / valid.length) * 100;
}

function stdDev(arr: (number | null)[]): number | null {
  const valid = arr.filter((v): v is number => v !== null && !isNaN(v));
  if (valid.length < 2) return null;
  const m = valid.reduce((a, b) => a + b, 0) / valid.length;
  const variance = valid.reduce((s, v) => s + (v - m) ** 2, 0) / valid.length;
  return Math.sqrt(variance);
}

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker")?.trim();
  if (!ticker) {
    return NextResponse.json({ error: "ticker required" }, { status: 400 });
  }

  const isJP = /^\d{3,4}[A-Z]?$/.test(ticker);
  const yfTicker = isJP ? `${ticker}.T` : ticker;

  try {
    // 1. 過去決算履歴 + 次回予定 (calendarEvents) を取得
    const summary = await yfQuoteSummary(yfTicker, "earningsHistory,calendarEvents");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const historyArr = ((summary?.earningsHistory as any)?.history ?? []) as Array<Record<string, unknown>>;

    // 次回決算予定日 (calendarEvents.earnings.earningsDate は範囲を表す ts 配列。先頭=最早日)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calEarnings = (summary?.calendarEvents as any)?.earnings;
    const earningsDateArr = (calEarnings?.earningsDate ?? []) as Array<{ raw?: number } | number>;
    const nextTs =
      earningsDateArr.length > 0
        ? typeof earningsDateArr[0] === "number"
          ? (earningsDateArr[0] as number)
          : (earningsDateArr[0] as { raw?: number }).raw ?? null
        : null;
    const nextEarningsDate = tsToDateString(nextTs);

    const events: EarningsEvent[] = historyArr
      .map((h) => {
        const dateRaw = raw(h, "quarter");
        const date = tsToDateString(dateRaw);
        if (!date) return null;
        return {
          date,
          epsActual: raw(h, "epsActual"),
          epsEstimate: raw(h, "epsEstimate"),
          surprisePercent: raw(h, "surprisePercent"),
        } as EarningsEvent;
      })
      .filter((e): e is EarningsEvent => e !== null)
      .reverse(); // 古い順

    const todayIso = new Date().toISOString().slice(0, 10);
    const daysBetween = (a: string, b: string): number =>
      Math.round((new Date(a).getTime() - new Date(b).getTime()) / (24 * 60 * 60 * 1000));
    const lastEarningsDate = events.length > 0 ? events[events.length - 1].date : null;
    const daysSinceLast = lastEarningsDate ? daysBetween(todayIso, lastEarningsDate) : null;
    const daysToNext = nextEarningsDate ? daysBetween(nextEarningsDate, todayIso) : null;

    if (events.length === 0) {
      return NextResponse.json({
        ticker,
        nextEarningsDate,
        daysToNext,
        lastEarningsDate,
        daysSinceLast,
        events: [],
        stats: emptyStats(),
        insights: { bestSellTiming: null, bestBuyTiming: null, summary: "決算履歴データが取得できません" },
      });
    }

    // 2. 全期間カバーするチャート (3年分) を1回だけ取得
    const oldestDate = events[0].date;
    const today = new Date();
    const oldestTime = new Date(oldestDate).getTime();
    const yearsAgo = Math.ceil((today.getTime() - oldestTime) / (365 * 24 * 60 * 60 * 1000));
    const range = yearsAgo >= 5 ? "10y" : yearsAgo >= 2 ? "5y" : "2y";

    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      yfTicker
    )}?range=${range}&interval=1d`;
    const chartRes = await fetch(chartUrl, { headers: YF_HEADERS, next: { revalidate: 3600 } });
    if (!chartRes.ok) {
      return NextResponse.json({
        ticker,
        nextEarningsDate,
        daysToNext,
        lastEarningsDate,
        daysSinceLast,
        events: events.map((e) => ({ ...e, ...emptyMovement() })),
        stats: emptyStats(),
        insights: { bestSellTiming: null, bestBuyTiming: null, summary: "株価データ取得失敗" },
      });
    }

    const chartJson = await chartRes.json();
    const chartResult = chartJson.chart?.result?.[0];
    if (!chartResult) {
      return NextResponse.json({
        ticker,
        nextEarningsDate,
        daysToNext,
        lastEarningsDate,
        daysSinceLast,
        events: events.map((e) => ({ ...e, ...emptyMovement() })),
        stats: emptyStats(),
        insights: { bestSellTiming: null, bestBuyTiming: null, summary: "チャートデータなし" },
      });
    }

    const timestamps = chartResult.timestamp as number[];
    const closes = (chartResult.indicators?.quote?.[0]?.close ?? []) as (number | null)[];

    // 日付 → 終値のマップ
    const closeByDate = new Map<string, number>();
    for (let i = 0; i < timestamps.length; i++) {
      const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
      if (closes[i] !== null) closeByDate.set(date, closes[i] as number);
    }

    // 営業日リスト (チャートデータがある日のみ)
    const tradingDates = Array.from(closeByDate.keys()).sort();

    // 営業日インデックスを取得するヘルパー
    function findTradingDayIndex(targetDate: string, offset: number): number | null {
      // targetDate の営業日インデックスを探す (最も近い日)
      let baseIdx = tradingDates.indexOf(targetDate);
      if (baseIdx === -1) {
        // 最も近い前営業日
        for (let i = tradingDates.length - 1; i >= 0; i--) {
          if (tradingDates[i] <= targetDate) {
            baseIdx = i;
            break;
          }
        }
        if (baseIdx === -1) return null;
      }
      const targetIdx = baseIdx + offset;
      if (targetIdx < 0 || targetIdx >= tradingDates.length) return null;
      return targetIdx;
    }

    function priceAtOffset(eventDate: string, offset: number): number | null {
      const idx = findTradingDayIndex(eventDate, offset);
      if (idx === null) return null;
      return closeByDate.get(tradingDates[idx]) ?? null;
    }

    function pctChange(from: number | null, to: number | null): number | null {
      if (from === null || to === null || from === 0) return null;
      return ((to - from) / from) * 100;
    }

    // 3. 各イベントについて、前後の値動きを計算
    // 決算発表は終値後 or 翌寄り前に行われる前提。
    // dayOf = 当日終値 (発表前) vs 前営業日 → 期待値を含む
    // post1d = 当日終値 → 翌営業日終値 → 発表後の反応
    const enrichedEvents = events.map((e) => {
      const p14 = priceAtOffset(e.date, -14);
      const p7 = priceAtOffset(e.date, -7);
      const p3 = priceAtOffset(e.date, -3);
      const p1 = priceAtOffset(e.date, -1);
      const p0 = priceAtOffset(e.date, 0);
      const pAfter1 = priceAtOffset(e.date, 1);
      const pAfter3 = priceAtOffset(e.date, 3);
      const pAfter7 = priceAtOffset(e.date, 7);

      // 決算前7日間の最高値到達日 (どこで最も上がっていたか)
      let bestPreDay: number | null = null;
      let bestPreReturn = -Infinity;
      if (p7) {
        for (let d = 1; d <= 7; d++) {
          const pd = priceAtOffset(e.date, -7 + d);
          const ret = pctChange(p7, pd);
          if (ret !== null && ret > bestPreReturn) {
            bestPreReturn = ret;
            bestPreDay = d;
          }
        }
      }

      return {
        ...e,
        pre14d: pctChange(p14, p0),
        pre7d: pctChange(p7, p0),
        pre3d: pctChange(p3, p0),
        pre1d: pctChange(p1, p0),
        dayOf: pctChange(p1, p0),  // 当日終値 vs 前日終値 (発表後の市場反応)
        post1d: pctChange(p0, pAfter1),
        post3d: pctChange(p0, pAfter3),
        post7d: pctChange(p0, pAfter7),
        pre7dHigh: bestPreDay !== null ? 7 - bestPreDay : null, // 何日前にピーク到達
      };
    });

    // 4. 統計量集計
    const stats = {
      sampleSize: enrichedEvents.length,
      avgPre14d: avg(enrichedEvents.map((e) => e.pre14d)),
      avgPre7d: avg(enrichedEvents.map((e) => e.pre7d)),
      avgPre3d: avg(enrichedEvents.map((e) => e.pre3d)),
      avgDayOf: avg(enrichedEvents.map((e) => e.dayOf)),
      avgPost1d: avg(enrichedEvents.map((e) => e.post1d)),
      avgPost3d: avg(enrichedEvents.map((e) => e.post3d)),
      avgPost7d: avg(enrichedEvents.map((e) => e.post7d)),
      winRatePre7d: winRate(enrichedEvents.map((e) => e.pre7d)),
      winRateDayOf: winRate(enrichedEvents.map((e) => e.dayOf)),
      winRatePost7d: winRate(enrichedEvents.map((e) => e.post7d)),
      volatilityPost1d: stdDev(enrichedEvents.map((e) => e.post1d)),
    };

    // 5. 推奨タイミング判定
    const insights = generateInsights(stats);

    return NextResponse.json({
      ticker,
      nextEarningsDate,
      daysToNext,
      lastEarningsDate,
      daysSinceLast,
      events: enrichedEvents,
      stats,
      insights,
    } satisfies EarningsPatternResult);
  } catch (err) {
    console.error("Earnings pattern error:", err);
    return NextResponse.json(
      { error: "Failed to analyze", details: (err as Error).message },
      { status: 500 }
    );
  }
}

function generateInsights(stats: EarningsPatternResult["stats"]): EarningsPatternResult["insights"] {
  const lines: string[] = [];
  let bestSell: string | null = null;
  let bestBuy: string | null = null;

  // パターン1: 決算前ラリー型 (pre7d > 3% & winRate > 60%)
  if (stats.avgPre7d !== null && stats.avgPre7d > 3 && stats.winRatePre7d !== null && stats.winRatePre7d >= 60) {
    lines.push(`📈 決算前ラリー型: 過去${stats.sampleSize}回中、決算前7日で平均+${stats.avgPre7d.toFixed(1)}% (勝率${stats.winRatePre7d.toFixed(0)}%)`);
    bestSell = "決算1〜3日前に売却推奨 (ラリー後の利食い)";
  }

  // パターン2: 材料出尽くし型 (pre7d > 0 & post1d < 0)
  if (stats.avgPre7d !== null && stats.avgPre7d > 1 && stats.avgPost1d !== null && stats.avgPost1d < -1) {
    lines.push(`📊 材料出尽くし型: 決算前は上昇 (+${stats.avgPre7d.toFixed(1)}%) するが、決算後翌日は下落 (${stats.avgPost1d.toFixed(1)}%) しがち`);
    bestSell = "決算当日寄り or 前日終値で売却 (発表後の下落回避)";
  }

  // パターン3: 決算後上昇型 (post7d > 2 & winRatePost7d > 60)
  if (stats.avgPost7d !== null && stats.avgPost7d > 2 && stats.winRatePost7d !== null && stats.winRatePost7d >= 60) {
    lines.push(`🚀 決算後上昇型: 決算後7日で平均+${stats.avgPost7d.toFixed(1)}% (勝率${stats.winRatePost7d.toFixed(0)}%)`);
    bestBuy = "決算後の反応を見て初動で買い";
  }

  // パターン4: 決算後失望売り型 (post1d/post3d/post7d 全て negative)
  if (
    stats.avgPost1d !== null && stats.avgPost1d < -1 &&
    stats.avgPost3d !== null && stats.avgPost3d < -1 &&
    stats.avgPost7d !== null && stats.avgPost7d < -1
  ) {
    lines.push(`📉 決算後失望売り型: 決算後は継続的に下落 (1日${stats.avgPost1d.toFixed(1)}% / 3日${stats.avgPost3d.toFixed(1)}% / 7日${stats.avgPost7d.toFixed(1)}%)`);
    bestBuy = "決算後7日以降の押し目を待つ";
  }

  // パターン5: 高ボラ型
  if (stats.volatilityPost1d !== null && stats.volatilityPost1d > 5) {
    lines.push(`⚡ 高ボラ型: 決算翌日のボラティリティ±${stats.volatilityPost1d.toFixed(1)}% - 大きく動く銘柄`);
  }

  // 全体サマリー
  let summary = lines.length > 0 ? lines.join(" / ") : "明確な傾向は検出されませんでした";
  if (stats.sampleSize < 3) {
    summary = `サンプル数 ${stats.sampleSize}回と少ないため傾向分析は参考程度に。 ${summary}`;
  }

  return { bestSellTiming: bestSell, bestBuyTiming: bestBuy, summary };
}

function emptyStats() {
  return {
    sampleSize: 0,
    avgPre14d: null,
    avgPre7d: null,
    avgPre3d: null,
    avgDayOf: null,
    avgPost1d: null,
    avgPost3d: null,
    avgPost7d: null,
    winRatePre7d: null,
    winRateDayOf: null,
    winRatePost7d: null,
    volatilityPost1d: null,
  };
}

function emptyMovement(): MovementSnapshot {
  return {
    pre14d: null, pre7d: null, pre3d: null, pre1d: null,
    dayOf: null, post1d: null, post3d: null, post7d: null,
    pre7dHigh: null,
  };
}
