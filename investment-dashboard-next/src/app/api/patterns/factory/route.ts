import { NextResponse } from "next/server";
import { BigQuery } from "@google-cloud/bigquery";

/**
 * GET /api/patterns/factory — パターン工場の生態系を返す (認証不要・統計のみ)
 *
 * pattern_candidates を status 別 (promoted/incubating/retired) に整理して返す。
 * 発見時の in-sample 成績 + 発見後のライブ成績を両方含む。
 */

const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
export const maxDuration = 30;
export const dynamic = "force-dynamic";
export const revalidate = 0;

function getBq(): BigQuery {
  const raw = process.env.BQ_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("BQ_SERVICE_ACCOUNT_JSON is not set");
  return new BigQuery({ projectId: BQ_PROJECT, credentials: JSON.parse(raw) });
}

const d = (v: { value: string } | string | null): string | null =>
  v === null || v === undefined ? null : typeof v === "string" ? v : v.value;

export async function GET() {
  try {
    const bq = getBq();
    const [rows] = await bq.query({
      query: `SELECT * FROM \`${BQ_PROJECT}.${BQ_DATASET}.pattern_candidates\`
        ORDER BY CASE status WHEN 'promoted' THEN 0 WHEN 'incubating' THEN 1 ELSE 2 END,
                 ABS(edge) DESC`,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const patterns = (rows as any[]).map((r) => ({
      id: r.pattern_id,
      labels: r.labels ?? [],
      direction: r.direction,
      status: r.status,
      // 発見時 (過去2年 in-sample)
      n: r.n, winPct: r.win_pct, avgRet: r.avg_ret,
      winFirst: r.win_first, winSecond: r.win_second,
      edge: r.edge, z: r.z_score, baseline: r.baseline_pct,
      // 発見後 (ライブ out-of-sample)
      liveN: r.live_n, liveDays: r.live_days ?? null, liveWinPct: r.live_win_pct, liveAvgRet: r.live_avg_ret,
      discoveredDate: d(r.discovered_date),
      lastFired: d(r.last_fired_date),
    }));

    const counts = {
      promoted: patterns.filter((p) => p.status === "promoted").length,
      incubating: patterns.filter((p) => p.status === "incubating").length,
      retired: patterns.filter((p) => p.status === "retired").length,
    };

    // ── 中長期パターン (5/20/60営業日先)。平均は外れ値で汚染されるため中央値を主表示に ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let midPatterns: any[] = [];
    try {
      const [midRows] = await bq.query({
        query: `SELECT * FROM \`${BQ_PROJECT}.${BQ_DATASET}.pattern_candidates_mid\`
          ORDER BY CASE status WHEN 'promoted' THEN 0 WHEN 'incubating' THEN 1 ELSE 2 END, horizon_days, ABS(z_score) DESC`,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      midPatterns = (midRows as any[]).map((r) => ({
        id: r.pattern_id,
        labels: r.labels ?? [],
        direction: r.direction,
        status: r.status,
        horizonDays: r.horizon_days,
        n: r.n, nEff: r.n_eff, winPct: r.win_pct,
        medRet: r.med_ret, avgRet: r.avg_ret,
        winFirst: r.win_first, winSecond: r.win_second,
        edge: r.edge, z: r.z_score,
        liveN: r.live_n, liveDays: r.live_days ?? null, liveWinPct: r.live_win_pct, liveAvgRet: r.live_avg_ret,
        discoveredDate: d(r.discovered_date),
        lastFired: d(r.last_fired_date),
      }));
    } catch {
      // mid テーブル未作成時は空
    }
    const midCounts = {
      promoted: midPatterns.filter((p) => p.status === "promoted").length,
      incubating: midPatterns.filter((p) => p.status === "incubating").length,
      retired: midPatterns.filter((p) => p.status === "retired").length,
    };

    // ── 急騰前兆パターン (宝くじ地形。当てる装置ではなく候補を寄せるバイアス) ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let surgePatterns: any[] = [];
    try {
      const [sRows] = await bq.query({
        query: `SELECT * FROM \`${BQ_PROJECT}.${BQ_DATASET}.pattern_candidates_surge\`
          ORDER BY CASE status WHEN 'promoted' THEN 0 WHEN 'incubating' THEN 1 ELSE 2 END, lift * SQRT(surges) DESC`,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      surgePatterns = (sRows as any[]).map((r) => ({
        id: r.pattern_id,
        labels: r.labels ?? [],
        status: r.status,
        n: r.n, surges: r.surges,
        surgeRate: r.surge_rate, crashRate: r.crash_rate, baseRate: r.base_rate,
        lift: r.lift, z: r.z_score, avgRet: r.avg_ret, medRet: r.med_ret,
        rateFirst: r.rate_first, rateSecond: r.rate_second,
        liveN: r.live_n, liveDays: r.live_days ?? null, liveSurges: r.live_surges ?? null, liveRate: r.live_rate ?? null,
        discoveredDate: d(r.discovered_date),
      }));
    } catch {}
    const surgeCounts = {
      promoted: surgePatterns.filter((p) => p.status === "promoted").length,
      incubating: surgePatterns.filter((p) => p.status === "incubating").length,
      retired: surgePatterns.filter((p) => p.status === "retired").length,
    };

    return NextResponse.json({ ok: true, counts, patterns, midCounts, midPatterns, surgeCounts, surgePatterns });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
