import { NextRequest, NextResponse } from "next/server";
import {
  WATCHED_RELEASES, computeReaction, daysBetween, toJstImpactDate, looksLikeCalendarEvent,
  type EventHorizon, type MacroEvent, type ReactionStats, type EarningsEvent,
} from "@/lib/event-horizon";
import { getCronOrigin } from "@/lib/cron-origin";

/**
 * GET /api/events/horizon?days=14&tickers=7203,9432
 *
 * 📅 確定した未来 (今後N日のマクロ日程 + 決算) を返す。
 * マクロ日程は FRED の公式リリースカレンダーから取得する。
 * 日付を推測で書かないための設計 — 取得できないものは載せない。
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const YF = { "User-Agent": "Mozilla/5.0" };
const FRED = "https://api.stlouisfed.org/fred";

async function fredReleaseDates(id: number, from: string, to: string, key: string): Promise<string[]> {
  try {
    const url = `${FRED}/release/dates?release_id=${id}&api_key=${key}&file_type=json` +
      `&include_release_dates_with_no_data=true&realtime_start=${from}&realtime_end=${to}&sort_order=asc&limit=200`;
    const res = await fetch(url, { next: { revalidate: 21600 } });
    if (!res.ok) return [];
    const j = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((j.release_dates ?? []) as any[]).map((x) => x.date as string);
  } catch {
    return [];
  }
}

/** 日経の日次変動% (過去5年) */
async function fetchNikkei(): Promise<{ byDate: Map<string, number>; days: string[] }> {
  const byDate = new Map<string, number>();
  const days: string[] = [];
  try {
    const res = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/%5EN225?range=5y&interval=1d",
      { headers: YF, next: { revalidate: 21600 } },
    );
    const j = await res.json();
    const r = j?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const closes = r?.indicators?.quote?.[0]?.close ?? [];
    let prev: number | null = null;
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (typeof c !== "number" || !isFinite(c)) continue;
      const d = new Date(ts[i] * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10);
      if (prev != null && prev > 0) { byDate.set(d, ((c - prev) / prev) * 100); days.push(d); }
      prev = c;
    }
  } catch {}
  return { byDate, days };
}

export async function GET(req: NextRequest) {
  const key = process.env.FRED_API_KEY;
  const windowDays = Math.min(Number(req.nextUrl.searchParams.get("days") ?? 14), 60);
  const tickersParam = (req.nextUrl.searchParams.get("tickers") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const heldSet = new Set((req.nextUrl.searchParams.get("held") ?? "").split(",").map((s) => s.trim()).filter(Boolean));

  const today = new Date().toISOString().slice(0, 10);
  const until = new Date(Date.now() + windowDays * 86400000).toISOString().slice(0, 10);
  const threeYearsAgo = new Date(Date.now() - 3 * 365 * 86400000).toISOString().slice(0, 10);

  try {
    const { byDate: nikkeiByDate, days: tradingDays } = await fetchNikkei();

    // ── マクロ: 今後の日程 + 過去の実測反応 ──
    const macro: (MacroEvent & { reaction: ReactionStats | null })[] = [];
    if (key) {
      await Promise.all(
        WATCHED_RELEASES.map(async (rel) => {
          const [future, past] = await Promise.all([
            fredReleaseDates(rel.id, today, until, key),
            fredReleaseDates(rel.id, threeYearsAgo, today, key),
          ]);
          // 安全弁: 連続配信フィード (FOMC Press Release 等) をカレンダーとして扱わない
          if (!looksLikeCalendarEvent(past.length, 3 * 365)) {
            console.warn(`[event-horizon] release ${rel.id} (${rel.label}) は配信頻度が高すぎるため除外`);
            return;
          }
          const reaction = computeReaction(rel.label, past, nikkeiByDate, tradingDays);
          for (const d of future) {
            const jst = toJstImpactDate(d);
            macro.push({
              date: jst, releaseDate: d, name: rel.label, releaseId: rel.id,
              daysAhead: daysBetween(today, jst), reaction,
            });
          }
        }),
      );
      macro.sort((a, b) => a.date.localeCompare(b.date));
    }

    // ── 決算 (指定銘柄) ──
    const earnings: EarningsEvent[] = [];
    if (tickersParam.length > 0) {
      try {
        const origin = getCronOrigin(req);
        const res = await fetch(`${origin}/api/stocks/next-earnings?tickers=${tickersParam.join(",")}`, {
          signal: AbortSignal.timeout(20_000),
        });
        if (res.ok) {
          const j = await res.json();
          for (const [ticker, v] of Object.entries(j.earnings ?? {})) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const e = v as any;
            const d = e?.nextDate ?? e?.date ?? null;
            const ahead = typeof e?.daysToNext === "number" ? e.daysToNext : d ? daysBetween(today, d) : null;
            if (d && ahead != null && ahead >= 0 && ahead <= windowDays) {
              earnings.push({ ticker, name: e?.name ?? ticker, date: d, daysAhead: ahead, held: heldSet.has(ticker) });
            }
          }
          earnings.sort((a, b) => a.daysAhead - b.daysAhead);
        }
      } catch {}
    }

    const horizon: EventHorizon = {
      generatedAt: new Date().toISOString(),
      windowDays,
      macro,
      earnings,
      note: key
        ? "日程は FRED の公式リリースカレンダーから取得しています。反応幅は過去3年の実測で、今後の予測ではありません。日銀会合など FRED に無い日程は含みません。"
        : "FRED_API_KEY が未設定のため、マクロ日程を取得できません。",
    };
    return NextResponse.json({ ok: true, horizon });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
