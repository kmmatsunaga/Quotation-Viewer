import { NextRequest, NextResponse } from "next/server";
import {
  sendLineMessage,
  buildPatternAlertMessage,
  type PatternAlertItem,
} from "@/lib/line-notify";

/**
 * POST /api/alerts/pattern-check
 *
 * クライアントから呼ばれる手動パターンチェック。
 * Body: {
 *   tickers: { ticker: string; name: string }[],
 *   channelAccessToken?: string,
 *   lineUserId?: string,
 *   threshold: number  // proximity threshold (default: 40)
 * }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { tickers, channelAccessToken, lineUserId, threshold = 40 } = body;

    if (!tickers || !Array.isArray(tickers) || tickers.length === 0) {
      return NextResponse.json(
        { error: "tickers array is required" },
        { status: 400 }
      );
    }

    const tickerCodes = tickers.map((t: { ticker: string }) => t.ticker);
    const tickerNames: Record<string, string> = {};
    for (const t of tickers) {
      tickerNames[t.ticker] = t.name;
    }

    // Fetch patterns
    const baseUrl = req.nextUrl.origin;
    const patternsUrl = `${baseUrl}/api/stocks/patterns?tickers=${tickerCodes.join(",")}`;

    const patternsRes = await fetch(patternsUrl, {
      headers: { "User-Agent": "PatternCheckBot/1.0" },
    });

    if (!patternsRes.ok) {
      return NextResponse.json(
        { error: "Failed to fetch patterns" },
        { status: 500 }
      );
    }

    const patternsData = await patternsRes.json();
    const patterns = patternsData.patterns ?? {};

    // Evaluate transitions
    const alertItems: PatternAlertItem[] = [];
    const checkedResults: Record<string, unknown> = {};

    for (const ticker of tickerCodes) {
      const data = patterns[ticker];
      if (!data?.patterns?.daily?.length) continue;

      const topDaily = data.patterns.daily[0];
      const transitions = data.transitions ?? [];

      const highProximityTransitions = transitions.filter(
        (t: { proximity: number }) => t.proximity >= threshold
      );

      checkedResults[ticker] = {
        name: data.name ?? tickerNames[ticker] ?? ticker,
        currentPattern: topDaily.label,
        transitions: transitions.map((t: { toLabel: string; proximity: number; signal: string }) => ({
          to: t.toLabel,
          proximity: t.proximity,
          signal: t.signal,
        })),
        alertTriggered: highProximityTransitions.length > 0,
      };

      for (const t of highProximityTransitions) {
        alertItems.push({
          ticker,
          name: data.name ?? tickerNames[ticker] ?? ticker,
          currentPattern: topDaily.label,
          nextPattern: t.toLabel,
          signal: t.signal,
          proximity: t.proximity,
          triggers: t.triggers ?? [],
        });
      }
    }

    // Send LINE message if alerts exist and credentials provided
    let lineResult = null;
    if (alertItems.length > 0 && channelAccessToken && lineUserId) {
      const message = buildPatternAlertMessage(alertItems);
      lineResult = await sendLineMessage(channelAccessToken, lineUserId, message);
    }

    return NextResponse.json({
      checked: tickerCodes.length,
      alertsFound: alertItems.length,
      alerts: alertItems,
      results: checkedResults,
      lineNotified: lineResult?.ok ?? false,
      lineError: lineResult && !lineResult.ok ? lineResult.message : null,
    });
  } catch (err) {
    console.error("Pattern check error:", err);
    return NextResponse.json(
      { error: "Pattern check failed" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/alerts/pattern-check
 *
 * Vercel Cron から呼ばれる自動チェック。
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { getAdminDb } = await import("@/lib/firebase-admin");
    const adminDb = getAdminDb();

    const usersSnap = await adminDb.collection("users").listDocuments();

    let totalAlerts = 0;
    let totalChecked = 0;

    for (const userRef of usersSnap) {
      // Get LINE credentials
      const [tokenDoc, userIdDoc, enabledDoc, thresholdDoc] = await Promise.all([
        adminDb.collection("users").doc(userRef.id).collection("settings").doc("lineChannelAccessToken").get(),
        adminDb.collection("users").doc(userRef.id).collection("settings").doc("lineUserId").get(),
        adminDb.collection("users").doc(userRef.id).collection("settings").doc("patternAlertEnabled").get(),
        adminDb.collection("users").doc(userRef.id).collection("settings").doc("patternAlertThreshold").get(),
      ]);

      const channelAccessToken = tokenDoc.exists ? tokenDoc.data()?.value : null;
      const lineUserId = userIdDoc.exists ? userIdDoc.data()?.value : null;
      if (!channelAccessToken || !lineUserId) continue;

      if (enabledDoc.exists && enabledDoc.data()?.value === "false") continue;

      const threshold = thresholdDoc.exists ? Number(thresholdDoc.data()?.value ?? 40) : 40;

      // Get holdings
      const holdingsSnap = await adminDb.collection("users").doc(userRef.id).collection("holdings").get();
      if (holdingsSnap.empty) continue;

      const tickers = holdingsSnap.docs.map((d) => ({
        ticker: d.data().ticker,
        name: d.data().name,
      }));

      // Fetch patterns
      const tickerCodes = tickers.map((t) => t.ticker);
      const baseUrl = req.nextUrl.origin;
      const patternsUrl = `${baseUrl}/api/stocks/patterns?tickers=${tickerCodes.join(",")}`;

      const patternsRes = await fetch(patternsUrl);
      if (!patternsRes.ok) continue;

      const patternsData = await patternsRes.json();
      const patternResults = patternsData.patterns ?? {};

      const alertItems: PatternAlertItem[] = [];

      for (const { ticker, name } of tickers) {
        const data = patternResults[ticker];
        if (!data?.patterns?.daily?.length) continue;
        totalChecked++;

        const topDaily = data.patterns.daily[0];
        const transitions = data.transitions ?? [];

        for (const t of transitions) {
          if (t.proximity >= threshold) {
            alertItems.push({
              ticker,
              name: data.name ?? name ?? ticker,
              currentPattern: topDaily.label,
              nextPattern: t.toLabel,
              signal: t.signal,
              proximity: t.proximity,
              triggers: t.triggers ?? [],
            });
          }
        }
      }

      if (alertItems.length > 0) {
        const message = buildPatternAlertMessage(alertItems);
        await sendLineMessage(channelAccessToken, lineUserId, message);
        totalAlerts += alertItems.length;
      }
    }

    return NextResponse.json({
      ok: true,
      checked: totalChecked,
      alertsSent: totalAlerts,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Cron pattern check error:", err);
    return NextResponse.json(
      { ok: false, error: "Cron check failed" },
      { status: 500 }
    );
  }
}
