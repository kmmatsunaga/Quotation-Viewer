import { NextRequest, NextResponse } from "next/server";
import { BigQuery } from "@google-cloud/bigquery";
import { getAdminDb } from "@/lib/firebase-admin";
import { getAdminAuth } from "@/lib/firebase-admin";
import { getCachedJpStocks } from "@/lib/jp-stocks-cache";
import {
  buildShortList,
  buildMidList,
  buildLongList,
  type FeatureRow,
  type RankEntry,
  type LongEnrichment,
  type HorizonPick,
} from "@/lib/horizon-recommend";

/**
 * POST /api/agent/daily-recommend?email=user@example.com
 * Header: x-api-key: <MCP_API_KEY>
 *
 * v2 (2026-07-17): 時間軸別おすすめ。
 *  ⚡短期 = BQ daily_features 全銘柄スキャン (出来高×初動×相対強さ)
 *  🌱中期 = score_rankings_latest (毎晩731銘柄) × 20日トレンド精査 + 決算接近フィルタ
 *  🏔長期 = score_rankings_latest × Future Score 5因子 (バリュートラップ除外) × 安定地形
 * 旧版の「お気に入り無条件保証 + ランダム12銘柄」はメンツ固定化の原因だったため廃止。
 * 全 pick に根拠 (reasons) を付けて保存する。
 *
 * GET 版は最新の保存済みおすすめを返す (変更なし)。
 */

const API_KEY = process.env.MCP_API_KEY;
const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";

export const maxDuration = 300;

function getBq(): BigQuery {
  const raw = process.env.BQ_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("BQ_SERVICE_ACCOUNT_JSON is not set");
  return new BigQuery({ projectId: BQ_PROJECT, credentials: JSON.parse(raw) });
}

export async function GET(req: NextRequest) {
  // 認証
  const apiKey = req.headers.get("x-api-key");
  const authHeader = req.headers.get("authorization");
  let uid: string | null = null;
  if (apiKey && apiKey === API_KEY) {
    const email = req.nextUrl.searchParams.get("email");
    if (email) {
      try { uid = (await getAdminAuth().getUserByEmail(email)).uid; } catch {}
    }
  } else if (authHeader?.startsWith("Bearer ")) {
    try {
      const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
      uid = decoded.uid;
    } catch {}
  }
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getAdminDb();
  const wantHistory = req.nextUrl.searchParams.get("history") === "1";

  if (wantHistory) {
    const histLimit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? "30"), 100);
    const snap = await db
      .collection("users")
      .doc(uid)
      .collection("dailyRecommendations")
      .orderBy("generatedAt", "desc")
      .limit(histLimit)
      .get();
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return NextResponse.json({ ok: true, history: items });
  }

  const date = req.nextUrl.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  const snap = await db.collection("users").doc(uid).collection("dailyRecommendations").doc(date).get();
  if (!snap.exists) {
    // 直近の保存済みを取る
    const recent = await db
      .collection("users")
      .doc(uid)
      .collection("dailyRecommendations")
      .orderBy("generatedAt", "desc")
      .limit(1)
      .get();
    if (recent.empty) {
      return NextResponse.json({ ok: true, recommendation: null });
    }
    return NextResponse.json({ ok: true, recommendation: { id: recent.docs[0].id, ...recent.docs[0].data() } });
  }
  return NextResponse.json({ ok: true, recommendation: { id: snap.id, ...snap.data() } });
}

export async function POST(req: NextRequest) {
  // 認証: cron からは x-api-key、画面からは Firebase ID トークン
  // (旧実装はクライアントに API キーをハードコードしていた — セキュリティ修正)
  let uid: string | null = null;
  const apiKey = req.headers.get("x-api-key");
  const authHeader = req.headers.get("authorization");
  if (apiKey && API_KEY && apiKey === API_KEY) {
    const email = req.nextUrl.searchParams.get("email");
    if (email) {
      try { uid = (await getAdminAuth().getUserByEmail(email)).uid; } catch {}
    }
  } else if (authHeader?.startsWith("Bearer ")) {
    try { uid = (await getAdminAuth().verifyIdToken(authHeader.slice(7))).uid; } catch {}
  }
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getAdminDb();

  // 保有銘柄 (既保有は全時間軸で除外 — 「新しく買う候補」を出す装置なので)
  const holdSnap = await db.collection("users").doc(uid).collection("holdings").get();
  const excluded = new Set(holdSnap.docs.map((d) => d.data().ticker as string));

  const host = req.headers.get("host") ?? "localhost:3000";
  const proto = host.includes("localhost") ? "http" : "https";
  const origin = `${proto}://${host}`;

  // ── 1. BQ: daily_features 最新日の全銘柄スキャン (短期候補 + 中長期の精査材料) ──
  let features: FeatureRow[] = [];
  try {
    const bq = getBq();
    const [rows] = await bq.query({
      query: `
        WITH latest AS (
          SELECT MAX(date) AS d FROM \`${BQ_PROJECT}.${BQ_DATASET}.daily_features\`
        )
        SELECT ticker, close, dayChangePct, volumeRatio, turnover, streak,
               isHigh20, isHigh60, ret5dPct, ret20dPct, rsi14, atrPct14,
               vsNikkeiPct, vsSectorPct, sector
        FROM \`${BQ_PROJECT}.${BQ_DATASET}.daily_features\`, latest
        WHERE date = latest.d AND turnover >= 5e7 AND close >= 100
      `,
    });
    features = rows as FeatureRow[];
  } catch (e) {
    console.error("[daily-recommend] BQ features fetch failed:", e);
  }
  const featuresMap = new Map(features.map((f) => [f.ticker, f]));

  // ── 2. 時間軸別スコアランキング (毎晩731銘柄を insights で採点済み) ──
  const rankSnap = await db.collection("meta").doc("score_rankings_latest").get();
  const rankEntries: RankEntry[] = (rankSnap.data()?.entries as RankEntry[]) ?? [];
  const ranksMap = new Map(rankEntries.map((e) => [e.ticker, e]));

  // 銘柄名の解決 (features 由来の銘柄はランキング外のことがある)
  let master: { ticker: string; name: string }[] = [];
  try { master = await getCachedJpStocks(); } catch {}
  const masterMap = new Map(master.map((s) => [s.ticker, s.name]));
  const nameOf = (t: string) => masterMap.get(t) ?? t;

  // ── 3. ⚡短期: 全銘柄スキャンから出来高×初動×相対強さ ──
  const shortList = buildShortList(features, ranksMap, nameOf, excluded, 8);

  // ── 4. 🌱中期: ランキング × 20日トレンド精査 → 決算接近フィルタ ──
  let midList = buildMidList(rankEntries, featuresMap, excluded, 12);
  try {
    const jpMid = midList.filter((p) => p.market === "JP").map((p) => p.ticker);
    if (jpMid.length > 0) {
      const res = await fetch(`${origin}/api/stocks/next-earnings?tickers=${jpMid.join(",")}`);
      if (res.ok) {
        const j = (await res.json()) as { earnings?: Record<string, { daysToNext: number | null }> };
        midList = midList.filter((p) => {
          const d = j.earnings?.[p.ticker]?.daysToNext;
          if (d != null && d >= 0 && d <= 7) return false; // 決算直前は中期エントリーに向かない
          if (d != null && d >= 8 && d <= 14) p.caution = `⚠ 決算が${d}日後 — またぐ前提かを決めてから`;
          return true;
        });
      }
    }
  } catch {}
  midList = midList.slice(0, 8);

  // ── 5. 🏔長期: ランキング上位を Future Score で精査 (バリュートラップ除外) ──
  const longCandidates = rankEntries
    .filter((e) => !excluded.has(e.ticker) && e.long >= 58)
    .sort((a, b) => b.long - a.long)
    .slice(0, 14);
  const enrich = new Map<string, LongEnrichment>();
  const FACTOR_LABELS: Record<string, string> = {
    value: "割安度", growth: "成長性", profitability: "収益力", momentum: "値動き", epsRevisions: "業績修正",
  };
  for (let i = 0; i < longCandidates.length; i += 5) {
    const batch = longCandidates.slice(i, i + 5);
    await Promise.all(batch.map(async (e) => {
      try {
        const res = await fetch(`${origin}/api/stocks/future-score/${encodeURIComponent(e.ticker)}`);
        if (!res.ok) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fs = (await res.json()) as any;
        const goodGrades = new Set(["A+", "A", "B+"]);
        const topFactors = Object.entries(fs.factors ?? {})
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter(([, v]: [string, any]) => goodGrades.has(v?.grade))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map(([k, v]: [string, any]) => `${FACTOR_LABELS[k] ?? k} ${v.grade}`)
          .slice(0, 3);
        enrich.set(e.ticker, {
          overallRaw: fs.overall?.raw ?? null,
          verdict: fs.overall?.verdict ?? null,
          summary: fs.overall?.summary ?? null,
          valueTrap: fs.flags?.valueTrap ?? false,
          valueTrapReason: fs.flags?.valueTrapReason ?? null,
          topFactors,
          upsidePct: fs.analyst?.upsidePct ?? null,
        });
      } catch {}
    }));
  }
  const longList = buildLongList(longCandidates, featuresMap, enrich, excluded, 8);

  // ── 6. 保存 (horizons が本体。recommendations は旧UI互換で中期リストを写す) ──
  const legacy = midList.map((p) => ({
    ticker: p.ticker, name: p.name, market: p.market,
    score: p.score, summary: p.reasons[0] ?? "", reasons: p.reasons,
    currentPrice: p.price ?? 0, changePct: 0, suggestedAction: "",
  }));

  const today = new Date().toISOString().slice(0, 10);
  const horizons: Record<string, HorizonPick[]> = { short: shortList, mid: midList, long: longList };
  await db.collection("users").doc(uid).collection("dailyRecommendations").doc(today).set({
    date: today,
    version: 2,
    horizons,
    recommendations: legacy,
    generatedAt: new Date(),
    meta: {
      featuresScanned: features.length,
      rankUniverse: rankEntries.length,
      longEnriched: enrich.size,
    },
  });

  return NextResponse.json({
    ok: true,
    date: today,
    counts: { short: shortList.length, mid: midList.length, long: longList.length },
    featuresScanned: features.length,
    rankUniverse: rankEntries.length,
    horizons,
  });
}
