import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { getAdminAuth } from "@/lib/firebase-admin";
import { NIKKEI225 } from "@/lib/nikkei225";
import { getCachedJpStocks } from "@/lib/jp-stocks-cache";

/**
 * POST /api/agent/daily-recommend?email=user@example.com&n=20
 * Header: x-api-key: <MCP_API_KEY>
 *
 * 日経225+お気に入りから「今日のおすすめ」を自動生成。
 * 各銘柄を insights API で評価 → 中期スコア上位5を保存。
 *
 * 全銘柄分析するとコスト高いので、サンプリングして n 銘柄を分析。
 *
 * GET 版は最新の保存済みおすすめを返す。
 */

const API_KEY = process.env.MCP_API_KEY;

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

interface Insight {
  ticker: string;
  name: string;
  currentPrice: number | null;
  short: { score: number; signals: { direction: string; weight: number; source: string; message: string }[]; action: string };
  mid: { score: number; signals: { direction: string; weight: number; source: string; message: string }[]; action: string };
  long: { score: number; signals: { direction: string; weight: number; source: string; message: string }[]; action: string };
  suggestedScenario: { entry: number | null; target: number | null; stopLoss: number | null };
}

export async function POST(req: NextRequest) {
  if (!API_KEY || req.headers.get("x-api-key") !== API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const email = req.nextUrl.searchParams.get("email");
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  let uid: string;
  try {
    uid = (await getAdminAuth().getUserByEmail(email)).uid;
  } catch {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const sampleSize = Math.min(Number(req.nextUrl.searchParams.get("n") ?? "30"), 80);
  const db = getAdminDb();

  // お気に入り取得
  const wlSnap = await db.collection("users").doc(uid).collection("watchlist").get();
  const watchlistTickers = wlSnap.docs.map((d) => d.data().ticker as string);

  // 保有銘柄 (既保有は除外)
  const holdSnap = await db.collection("users").doc(uid).collection("holdings").get();
  const heldTickers = new Set(holdSnap.docs.map((d) => d.data().ticker as string));

  // 候補プール: scope=full なら立花マスタ(全銘柄), 既定は日経225
  const scope = req.nextUrl.searchParams.get("scope") ?? "nikkei225";
  let basePool: string[];
  if (scope === "full") {
    const masterStocks = await getCachedJpStocks();
    basePool = masterStocks.length > 0 ? masterStocks.map((s) => s.ticker) : NIKKEI225.map((s) => s.ticker);
  } else {
    basePool = NIKKEI225.map((s) => s.ticker);
  }
  const allCandidates = [...new Set([
    ...basePool,
    ...watchlistTickers,
  ])].filter((t) => !heldTickers.has(t));  // 既保有は除外

  // ランダムサンプリング + お気に入りは全部含める
  const guaranteed = watchlistTickers.filter((t) => !heldTickers.has(t));
  const remainingPool = allCandidates.filter((t) => !guaranteed.includes(t));
  const shuffled = [...remainingPool].sort(() => Math.random() - 0.5);
  const sampled = [...guaranteed, ...shuffled].slice(0, sampleSize);

  const host = req.headers.get("host") ?? "localhost:3000";
  const proto = host.includes("localhost") ? "http" : "https";
  const origin = `${proto}://${host}`;

  // 各銘柄を analyze (並列、5銘柄ずつバッチ)
  const insights: Insight[] = [];
  const batchSize = 5;
  for (let i = 0; i < sampled.length; i += batchSize) {
    const batch = sampled.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (t) => {
        try {
          const res = await fetch(`${origin}/api/stocks/insights?ticker=${t}`);
          if (!res.ok) return null;
          return (await res.json()) as Insight;
        } catch {
          return null;
        }
      })
    );
    for (const r of batchResults) if (r) insights.push(r);
  }

  // 中期スコア順にソート + シグナル数で同点処理
  const scored = insights
    .filter((i) => i.mid?.score !== undefined)
    .map((i) => {
      const midSignals = i.mid.signals.filter((s) => s.direction === "bullish");
      const longBullSignals = i.long.signals.filter((s) => s.direction === "bullish");
      const totalScore = (i.short.score + i.mid.score * 2 + i.long.score * 1.5) / 4.5;
      return {
        insight: i,
        overallScore: Math.round(totalScore),
        midBullCount: midSignals.length,
        longBullCount: longBullSignals.length,
      };
    })
    .filter((x) => x.overallScore >= 55)  // 一定スコア以上のみ
    .sort((a, b) => b.overallScore - a.overallScore || b.midBullCount - a.midBullCount);

  // 全候補を保存 (上位から並び順)
  const topN = scored.slice(0, 20);

  const recommendations = topN.map((s) => {
    const i = s.insight;
    // 推奨理由を生成 (各時間軸からBull/重み上位を取得)
    const reasons: string[] = [];
    const allSignals = [...i.short.signals, ...i.mid.signals, ...i.long.signals];
    const bullSignals = allSignals
      .filter((sig) => sig.direction === "bullish")
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5);
    for (const sig of bullSignals) {
      reasons.push(sig.message);
    }

    // changePct: insights API には含まれないので 0 でフォールバック
    return {
      ticker: i.ticker,
      name: i.name,
      market: /^\d{3,4}[A-Z]?$/.test(i.ticker) ? "JP" : "US",
      score: s.overallScore,
      // 個別時間軸スコア (時間軸別タブ用に追加)
      shortScore: i.short.score,
      midScore: i.mid.score,
      longScore: i.long.score,
      shortAction: i.short.action,
      midAction: i.mid.action,
      longAction: i.long.action,
      summary: `${i.mid.action} | スコア ${s.overallScore} (短${i.short.score}/中${i.mid.score}/長${i.long.score})`,
      reasons,
      currentPrice: i.currentPrice ?? 0,
      changePct: 0,
      suggestedAction: i.suggestedScenario.entry
        ? `エントリー¥${i.suggestedScenario.entry} / 目標¥${i.suggestedScenario.target} / 損切り¥${i.suggestedScenario.stopLoss}`
        : "",
    };
  });

  const today = new Date().toISOString().slice(0, 10);
  await db.collection("users").doc(uid).collection("dailyRecommendations").doc(today).set({
    date: today,
    recommendations,
    generatedAt: new Date(),
  });

  return NextResponse.json({
    ok: true,
    date: today,
    analyzed: insights.length,
    qualified: scored.length,
    recommended: recommendations.length,
    recommendations,
  });
}
