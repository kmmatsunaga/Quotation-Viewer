import { NextRequest, NextResponse } from "next/server";
import { getAdminDb, resolveUidByEmail, collectUserTickers } from "@/lib/firebase-admin";
import { getCronOrigin } from "@/lib/cron-origin";
import { collectWitnesses } from "@/lib/verdict-witnesses";
import { aggregateVerdicts, type Timeframe, type Stance } from "@/lib/verdict-engine";

/**
 * GET /api/cron/verdict-track
 *
 * 検証ループ (Cavka が自分の予測の答え合わせをする仕組み):
 *
 *   Phase A (記録): ポートフォリオ + お気に入り銘柄の評決をサーバ側で計算し、
 *     meta/verdict_history_{date} に保存 (同日再実行は上書き = 冪等)。
 *
 *   Phase B (評決の評価): 7/30/90日前の verdict_history と今日の価格を突合し、
 *     強気評決→上昇 / 弱気評決→下落 を的中と判定。meta/verdict_eval_{date} に保存。
 *
 *   Phase C (テクニカルスコアの評価): score_rankings_{過去} と score_rankings_{今日} を
 *     突合 (731銘柄)。past score >=65 を強気 / <=45 を弱気として的中集計。
 *     少数銘柄の評決より統計的に早く有意になる。
 *
 * 実行: 毎日 UTC 16:30 (JST 01:30、score-rankings 完了後)。
 */

const CRON_SECRET = process.env.CRON_SECRET;
const FALLBACK_EMAIL = "make.some.noise6984@gmail.com";

export const maxDuration = 300;

const HORIZONS: { tf: Timeframe; days: number }[] = [
  { tf: "short", days: 7 },
  { tf: "mid", days: 30 },
  { tf: "long", days: 90 },
];

interface HistoryEntry {
  ticker: string;
  price: number | null;
  short: { stance: Stance; direction: number; conviction: number };
  mid: { stance: Stance; direction: number; conviction: number };
  long: { stance: Stance; direction: number; conviction: number };
}

interface RankingEntry {
  ticker: string;
  price: number | null;
  short: number;
  mid: number;
  long: number;
}

function jstDateKey(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
}

const isBull = (s: Stance) => s === "bull" || s === "strong_bull";
const isBear = (s: Stance) => s === "bear" || s === "strong_bear";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const origin = getCronOrigin(req);
  const db = getAdminDb();
  const startedAt = Date.now();
  const todayKey = jstDateKey(new Date());

  // ━━ Phase A: 記録 ━━
  // ユニバース: 全 cron ユーザーの お気に入り(watchlist) + 保有(holdings)
  // 注意: users doc に email フィールドは無いので Auth 経由で uid 解決する
  const emailsRaw = process.env.CAVKA_CRON_EMAILS ?? FALLBACK_EMAIL;
  const emails = emailsRaw.split(",").map((e) => e.trim()).filter(Boolean);
  const tickerSet = new Set<string>();
  for (const email of emails) {
    const uid = await resolveUidByEmail(email);
    if (!uid) continue;
    for (const t of await collectUserTickers(uid)) tickerSet.add(t);
  }
  const tickers = Array.from(tickerSet).slice(0, 60); // 安全上限

  const entries: HistoryEntry[] = [];
  const BATCH = 3;
  for (let i = 0; i < tickers.length; i += BATCH) {
    // 時間切れ予防
    if (Date.now() - startedAt > 220_000) break;
    const batch = tickers.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (ticker) => {
        try {
          const { witnesses, price } = await collectWitnesses(ticker, origin);
          if (witnesses.length === 0) return null;
          const { verdicts } = aggregateVerdicts(witnesses);
          const pick = (tf: Timeframe) => ({
            stance: verdicts[tf].stance,
            direction: verdicts[tf].direction,
            conviction: verdicts[tf].conviction,
          });
          const entry: HistoryEntry = {
            ticker, price,
            short: pick("short"), mid: pick("mid"), long: pick("long"),
          };
          return entry;
        } catch {
          return null;
        }
      })
    );
    for (const r of results) if (r) entries.push(r);
  }

  await db.collection("meta").doc(`verdict_history_${todayKey}`).set({
    date: todayKey,
    entries,
    savedAtIso: new Date().toISOString(),
  });

  // ━━ Phase B: 評決の評価 (過去の verdict_history vs 今日の価格) ━━
  const priceNow = new Map(entries.filter((e) => e.price !== null).map((e) => [e.ticker, e.price as number]));

  interface VerdictEval {
    tf: Timeframe;
    ticker: string;
    pastDate: string;
    stance: Stance;
    conviction: number;
    ret: number;      // 実際の変化率
    hit: boolean | null; // neutral/contested は null (的中判定対象外)
  }
  const verdictEvals: VerdictEval[] = [];

  for (const { tf, days } of HORIZONS) {
    // 過去ドキュメントを最大5日さかのぼって探す (休日ずれ対応)
    let pastDoc: FirebaseFirestore.DocumentSnapshot | null = null;
    let pastKey = "";
    for (let back = days; back <= days + 5; back++) {
      pastKey = jstDateKey(new Date(Date.now() - back * 24 * 3600 * 1000));
      const snap = await db.collection("meta").doc(`verdict_history_${pastKey}`).get();
      if (snap.exists) { pastDoc = snap; break; }
    }
    if (!pastDoc) continue;
    const pastEntries = (pastDoc.data()?.entries ?? []) as HistoryEntry[];
    for (const pe of pastEntries) {
      const cur = priceNow.get(pe.ticker);
      if (cur === undefined || pe.price === null || pe.price === 0) continue;
      const ret = cur / pe.price - 1;
      const v = pe[tf];
      let hit: boolean | null = null;
      if (isBull(v.stance)) hit = ret > 0;
      else if (isBear(v.stance)) hit = ret < 0;
      verdictEvals.push({
        tf, ticker: pe.ticker, pastDate: pastKey,
        stance: v.stance, conviction: v.conviction,
        ret: Math.round(ret * 10000) / 10000, hit,
      });
    }
  }

  // ━━ Phase C: テクニカルスコアの評価 (score_rankings 履歴) ━━
  interface TechBucketAgg { tf: Timeframe; bucket: "bull" | "bear" | "neutral"; n: number; hits: number; sumRet: number }
  const techAggMap = new Map<string, TechBucketAgg>();
  const techAdd = (tf: Timeframe, bucket: "bull" | "bear" | "neutral", ret: number) => {
    const key = `${tf}_${bucket}`;
    const agg = techAggMap.get(key) ?? { tf, bucket, n: 0, hits: 0, sumRet: 0 };
    agg.n++;
    agg.sumRet += ret;
    if ((bucket === "bull" && ret > 0) || (bucket === "bear" && ret < 0)) agg.hits++;
    techAggMap.set(key, agg);
  };

  const todayRankSnap = await db.collection("meta").doc(`score_rankings_${todayKey}`).get();
  const todayRank = (todayRankSnap.data()?.entries ?? []) as RankingEntry[];
  const todayPriceMap = new Map(todayRank.filter((e) => e.price !== null).map((e) => [e.ticker, e.price as number]));

  for (const { tf, days } of HORIZONS) {
    let pastData: RankingEntry[] | null = null;
    for (let back = days; back <= days + 5; back++) {
      const key = jstDateKey(new Date(Date.now() - back * 24 * 3600 * 1000));
      const snap = await db.collection("meta").doc(`score_rankings_${key}`).get();
      if (snap.exists) { pastData = (snap.data()?.entries ?? []) as RankingEntry[]; break; }
    }
    if (!pastData) continue;
    for (const pe of pastData) {
      const cur = todayPriceMap.get(pe.ticker);
      if (cur === undefined || pe.price === null || pe.price === 0) continue;
      const ret = cur / pe.price - 1;
      const score = tf === "short" ? pe.short : tf === "mid" ? pe.mid : pe.long;
      const bucket = score >= 65 ? "bull" : score <= 45 ? "bear" : "neutral";
      techAdd(tf, bucket, ret);
    }
  }

  const techEvals = Array.from(techAggMap.values()).map((a) => ({
    ...a,
    sumRet: Math.round(a.sumRet * 10000) / 10000,
    hitRate: a.n > 0 ? Math.round((a.hits / a.n) * 1000) / 1000 : null,
    avgRet: a.n > 0 ? Math.round((a.sumRet / a.n) * 10000) / 10000 : null,
  }));

  // 評価結果を保存 (同日再実行は上書き = 冪等、二重カウントなし)
  await db.collection("meta").doc(`verdict_eval_${todayKey}`).set({
    date: todayKey,
    verdictEvals,
    techEvals,
    savedAtIso: new Date().toISOString(),
  });

  return NextResponse.json({
    ok: true,
    date: todayKey,
    recorded: entries.length,
    verdictEvals: verdictEvals.length,
    techEvals: techEvals.length,
    elapsedMs: Date.now() - startedAt,
  });
}
