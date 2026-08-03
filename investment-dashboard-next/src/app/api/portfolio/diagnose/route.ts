import { NextRequest, NextResponse } from "next/server";
import { BigQuery } from "@google-cloud/bigquery";
import { getAdminDb } from "@/lib/firebase-admin";
import {
  diagnose, compareWithProfile, goalArithmetic,
  type DiagHolding, type ReturnSeries, type ProfileAnswers,
} from "@/lib/portfolio-diagnose";

/**
 * POST /api/portfolio/diagnose
 * body: { holdings: [{ ticker, name, value, pnlPct }] }
 *
 * ポートフォリオを「一つの塊」として機械的に診断する。
 * 過去250営業日の実リターン (BQ daily_features) から
 * 分散の実効性・リスク寄与・下げ耐性を計算する。予測は一切しない。
 *
 * 認証不要 (銘柄コードと金額比率のみ受け取る。個人特定情報は含まない
 *  = /api/portfolio-terrain と同じ扱い)。
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
const LOOKBACK = 250;

function getBq(): BigQuery {
  const raw = process.env.BQ_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("BQ_SERVICE_ACCOUNT_JSON is not set");
  return new BigQuery({ projectId: BQ_PROJECT, credentials: JSON.parse(raw) });
}
const dstr = (v: { value: string } | string) => (typeof v === "string" ? v : v.value);

export async function POST(req: NextRequest) {
  let body: {
    holdings?: { ticker: string; name?: string; value?: number; pnlPct?: number | null }[];
    /** 問診票の回答 (任意)。あれば「宣言と実測のズレ」を照合する */
    profile?: ProfileAnswers;
    /** 待機現金 (任意)。目標金額は「投資資産」に対して立てるので、現金を含めないと必要リターンが過大になる */
    cashJpy?: number;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  // 日本株のみ (BQ daily_features が日本株ベースのため)
  const input = (body.holdings ?? []).filter(
    (h) => h.ticker && (h.value ?? 0) > 0 && /^\d{3,4}[A-Z0-9]?$/.test(h.ticker),
  );
  if (input.length === 0) return NextResponse.json({ ok: true, diagnosis: null, reason: "日本株の保有がありません" });

  try {
    const bq = getBq();
    const tickers = Array.from(new Set(input.map((h) => h.ticker)));

    // ── 業種マップ (1,846銘柄130業種) ──
    const industryOf = new Map<string, string>();
    try {
      const snap = await getAdminDb().collection("meta").doc("industry_map").get();
      const map = (snap.data()?.map ?? {}) as Record<string, string>;
      for (const t of tickers) if (map[t]) industryOf.set(t, map[t]);
    } catch {}

    // ── 日次リターン (保有銘柄 + 日経) ──
    const [rows] = await bq.query({
      query: `
        SELECT FORMAT_DATE('%Y-%m-%d', date) d, ticker, dayChangePct, nikkeiChangePct
        FROM \`${BQ_PROJECT}.${BQ_DATASET}.daily_features\`
        WHERE ticker IN UNNEST(@t)
          AND date >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 400 DAY)
          AND dayChangePct IS NOT NULL
        ORDER BY d`,
      params: { t: tickers },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rs = rows as any[];
    if (rs.length === 0) return NextResponse.json({ ok: true, diagnosis: null, reason: "価格履歴が見つかりません" });

    // 日付軸 (全保有銘柄が揃っている日だけ使う)
    const perDate = new Map<string, Map<string, number>>();
    const nikkeiByDate = new Map<string, number>();
    for (const r of rs) {
      const d = dstr(r.d);
      if (!perDate.has(d)) perDate.set(d, new Map());
      perDate.get(d)!.set(r.ticker, Number(r.dayChangePct));
      if (r.nikkeiChangePct != null && !nikkeiByDate.has(d)) nikkeiByDate.set(d, Number(r.nikkeiChangePct));
    }
    // 履歴が十分ある銘柄のみ対象 (新規上場などは除外)
    const counts = new Map<string, number>();
    for (const [, m] of perDate) for (const t of m.keys()) counts.set(t, (counts.get(t) ?? 0) + 1);
    const dates = Array.from(perDate.keys()).sort().slice(-LOOKBACK);
    const covered = tickers.filter((t) => (counts.get(t) ?? 0) >= dates.length * 0.8);

    const series: ReturnSeries = new Map();
    for (const t of covered) {
      const arr: number[] = [];
      for (const d of dates) {
        const v = perDate.get(d)?.get(t);
        arr.push(v ?? 0); // 欠損日は0 (休止銘柄の影響を過大評価しないため)
      }
      series.set(t, arr);
    }
    const nikkei = dates.map((d) => nikkeiByDate.get(d) ?? 0);

    // ── 同一銘柄の合算 ──
    const merged = new Map<string, DiagHolding>();
    for (const h of input) {
      const e = merged.get(h.ticker);
      if (e) {
        // 加重平均で損益率をまとめる
        const tv = e.value + h.value!;
        if (e.pnlPct != null && h.pnlPct != null) e.pnlPct = (e.pnlPct * e.value + h.pnlPct * h.value!) / tv;
        e.value = tv;
      } else {
        merged.set(h.ticker, {
          ticker: h.ticker,
          name: h.name ?? h.ticker,
          value: h.value!,
          pnlPct: h.pnlPct ?? null,
          industry: industryOf.get(h.ticker) ?? null,
        });
      }
    }

    const diagnosis = diagnose(Array.from(merged.values()), series, nikkei, dates);

    // 問診票があれば「宣言 ↔ 実測」の照合と、目標の算術を添える
    const profile = body.profile ?? null;
    const gaps = profile ? compareWithProfile(diagnosis, profile) : [];
    const goal = profile ? goalArithmetic(diagnosis.totalValue, profile, Number(body.cashJpy ?? 0)) : null;

    return NextResponse.json({
      ok: true,
      diagnosis,
      gaps,
      goal,
      coverage: { requested: tickers.length, withHistory: covered.length, dates: dates.length },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
