import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { sendLineMessage } from "@/lib/line-notify";

/**
 * POST /api/watchdog/check?email=user@example.com
 * Header: x-api-key: <MCP_API_KEY>
 *
 * 指定ユーザーの保有銘柄・お気に入り・アクティブシナリオを総合的に監視。
 * 異変を検知したら watchdogEvents に記録 + LINE通知。
 *
 * cron で 15分毎などに実行する想定。
 */

const API_KEY = process.env.MCP_API_KEY;

interface WatchdogTrigger {
  ticker: string;
  name: string;
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
  data: Record<string, unknown>;
  dedupKey: string;
}

export async function POST(req: NextRequest) {
  if (!API_KEY || req.headers.get("x-api-key") !== API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const email = req.nextUrl.searchParams.get("email");
  if (!email) {
    return NextResponse.json({ error: "email required" }, { status: 400 });
  }

  // UID解決
  const { getAuth } = await import("firebase-admin/auth");
  let uid: string;
  try {
    const userRecord = await getAuth().getUserByEmail(email);
    uid = userRecord.uid;
  } catch {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const db = getAdminDb();

  // 保有銘柄取得
  const holdingsSnap = await db
    .collection("users")
    .doc(uid)
    .collection("holdings")
    .get();
  const holdings = holdingsSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown>));

  // お気に入り
  const watchlistSnap = await db
    .collection("users")
    .doc(uid)
    .collection("watchlist")
    .get();
  const watchlist = watchlistSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown>));

  // アクティブシナリオ
  const scenariosSnap = await db
    .collection("users")
    .doc(uid)
    .collection("scenarios")
    .where("status", "==", "active")
    .get();
  const scenarios = scenariosSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown>));

  // 監視対象ティッカー
  const allTickers = [...new Set([
    ...holdings.map((h) => h.ticker as string),
    ...watchlist.map((w) => w.ticker as string),
  ])];

  if (allTickers.length === 0) {
    return NextResponse.json({ ok: true, checked: 0, triggered: 0 });
  }

  const host = req.headers.get("host") ?? "localhost:3000";
  const proto = host.includes("localhost") ? "http" : "https";
  const origin = `${proto}://${host}`;

  // バッチで取得
  const triggers: WatchdogTrigger[] = [];

  // 1. 価格変動 + 出来高異常
  try {
    const anomalyRes = await fetch(`${origin}/api/stocks/volume-anomaly?tickers=${allTickers.slice(0, 30).join(",")}`);
    const anomalyData = await anomalyRes.json();
    for (const a of anomalyData.anomalies ?? []) {
      const holding = holdings.find((h) => h.ticker === a.ticker);
      const watchOnly = !holding;

      // 価格急変
      if (Math.abs(a.changePct) >= 5) {
        const dir = a.changePct > 0 ? "急騰" : "急落";
        triggers.push({
          ticker: a.ticker,
          name: a.name,
          type: "price_spike",
          severity: holding ? "critical" : "warning",
          message: `${dir} ${a.changePct >= 0 ? "+" : ""}${a.changePct.toFixed(2)}%${holding ? " (保有中)" : ""}`,
          data: { changePct: a.changePct, currentPrice: a.currentPrice },
          dedupKey: `${a.ticker}_price_spike_${new Date().toISOString().slice(0, 10)}`,
        });
      }

      // 出来高異常
      if (a.volumeRatio >= 3) {
        triggers.push({
          ticker: a.ticker,
          name: a.name,
          type: "volume_anomaly",
          severity: a.volumeRatio >= 5 ? "warning" : "info",
          message: `出来高 ×${a.volumeRatio.toFixed(1)} (普段の${a.volumeRatio.toFixed(1)}倍)${watchOnly ? " [お気に入り]" : ""}`,
          data: { volumeRatio: a.volumeRatio, signals: a.signals },
          dedupKey: `${a.ticker}_volume_${new Date().toISOString().slice(0, 10)}`,
        });
      }

      // 保有銘柄: 損切りライン接近
      if (holding && a.currentPrice) {
        const sc = scenarios.find((s) => s.ticker === a.ticker);
        if (sc && typeof sc.stopLossPrice === "number" && sc.stopLossPrice > 0) {
          const distance = ((a.currentPrice - (sc.stopLossPrice as number)) / a.currentPrice) * 100;
          if (distance >= 0 && distance <= 3) {
            triggers.push({
              ticker: a.ticker,
              name: a.name,
              type: "stop_loss_near",
              severity: "critical",
              message: `損切り価格 ¥${sc.stopLossPrice} まで残${distance.toFixed(1)}% (現在 ¥${a.currentPrice})`,
              data: { stopLoss: sc.stopLossPrice, currentPrice: a.currentPrice, distance },
              dedupKey: `${a.ticker}_stoploss_${new Date().toISOString().slice(0, 10)}`,
            });
          }
        }
        // 目標達成
        if (sc && Array.isArray(sc.targetPrices) && sc.targetPrices.length > 0) {
          const target = (sc.targetPrices as number[])[0];
          const isBuy = sc.direction === "buy";
          const reached = isBuy ? a.currentPrice >= target : a.currentPrice <= target;
          if (reached) {
            triggers.push({
              ticker: a.ticker,
              name: a.name,
              type: "target_reached",
              severity: "warning",
              message: `🎯 目標 ¥${target} 達成! (現在 ¥${a.currentPrice})`,
              data: { target, currentPrice: a.currentPrice },
              dedupKey: `${a.ticker}_target_${target}_${new Date().toISOString().slice(0, 10)}`,
            });
          }
        }
      }
    }
  } catch (e) {
    console.error("Volume anomaly check failed:", e);
  }

  // 2. 決算近接 + 過去パターン警告
  try {
    const earningsRes = await fetch(`${origin}/api/stocks/earnings?tickers=${allTickers.slice(0, 20).join(",")}`);
    const earningsData = await earningsRes.json();
    for (const [ticker, e] of Object.entries(earningsData.earnings ?? {}) as [string, Record<string, unknown>][]) {
      if (!e.nextEarningsDate) continue;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const target = new Date(e.nextEarningsDate as string);
      target.setHours(0, 0, 0, 0);
      const days = Math.floor((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
      const holding = holdings.find((h) => h.ticker === ticker);
      if (!holding) continue;  // 保有銘柄のみ警告

      if (days === 3 || days === 1) {
        triggers.push({
          ticker,
          name: e.name as string,
          type: "earnings_warning",
          severity: days === 1 ? "warning" : "info",
          message: `📅 決算まで${days}日 (${e.nextEarningsDate})`,
          data: { daysUntil: days, earningsDate: e.nextEarningsDate, lastSurprise: e.lastEarningsSurprise },
          dedupKey: `${ticker}_earnings_${days}_${new Date().toISOString().slice(0, 10)}`,
        });
      }
    }
  } catch (er) {
    console.error("Earnings check failed:", er);
  }

  // 3. 信用倍率 → 踏み上げ候補
  try {
    const jpTickers = allTickers.filter((t) => /^\d{3,4}[A-Z]?$/.test(t)).slice(0, 30);
    if (jpTickers.length > 0) {
      const marginRes = await fetch(`${origin}/api/tachibana/margin?tickers=${jpTickers.join(",")}`, {
        headers: { "x-api-key": API_KEY },
      });
      const marginData = await marginRes.json();
      for (const [ticker, info] of Object.entries(marginData.data ?? {}) as [string, Record<string, unknown>][]) {
        const m = info.margin as Record<string, unknown> | null;
        const watch = watchlist.find((w) => w.ticker === ticker);
        const hold = holdings.find((h) => h.ticker === ticker);
        if (!m || !watch && !hold) continue;
        if (typeof m.ratioTotal === "number" && m.ratioTotal < 1) {
          triggers.push({
            ticker,
            name: (watch?.name ?? hold?.name ?? ticker) as string,
            type: "margin_squeeze",
            severity: "warning",
            message: `信用倍率 ${m.ratioTotal.toFixed(2)} = 踏み上げ候補 (売残>買残)`,
            data: { ratio: m.ratioTotal },
            dedupKey: `${ticker}_squeeze_${new Date().toISOString().slice(0, 10)}`,
          });
        }
      }
    }
  } catch (mError) {
    console.error("Margin check failed:", mError);
  }

  // 重複排除 (dedupKey で既存イベントがあれば追加しない)
  // 過去24時間以内に同じ dedupKey のイベントがあれば重複扱い
  const newTriggers: WatchdogTrigger[] = [];
  for (const t of triggers) {
    const existSnap = await db
      .collection("users")
      .doc(uid)
      .collection("watchdogEvents")
      .where("dedupKey", "==", t.dedupKey)
      .limit(1)
      .get();
    if (existSnap.empty) {
      newTriggers.push(t);
    }
  }

  // Firestore に記録
  for (const t of newTriggers) {
    await db.collection("users").doc(uid).collection("watchdogEvents").add({
      ...t,
      acknowledged: false,
      triggeredAt: new Date(),
      lineNotified: false,
    });
  }

  // LINE通知 (critical / warning のみ)
  let lineNotified = false;
  if (newTriggers.length > 0) {
    const notifyTriggers = newTriggers.filter((t) => t.severity === "critical" || t.severity === "warning");
    if (notifyTriggers.length > 0) {
      try {
        // LINE設定取得
        const settingsTokenSnap = await db.collection("users").doc(uid).collection("settings").doc("lineChannelAccessToken").get();
        const settingsUserIdSnap = await db.collection("users").doc(uid).collection("settings").doc("lineUserId").get();
        const channelAccessToken = settingsTokenSnap.exists ? settingsTokenSnap.data()?.value : null;
        const lineUserId = settingsUserIdSnap.exists ? settingsUserIdSnap.data()?.value : null;
        if (channelAccessToken && lineUserId) {
          const lines: string[] = [];
          lines.push("📡 ポートフォリオ・ウォッチドッグ");
          lines.push("━━━━━━━━━━━━━━━━━");
          lines.push("");
          for (const t of notifyTriggers) {
            const emoji = t.severity === "critical" ? "🚨" : "⚠️";
            lines.push(`${emoji} ${t.ticker} ${t.name}`);
            lines.push(`  ${t.message}`);
            lines.push("");
          }
          lines.push(`🕒 ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`);
          const result = await sendLineMessage(channelAccessToken, lineUserId, lines.join("\n"));
          lineNotified = result.ok;
        }
      } catch (e) {
        console.error("LINE notify failed:", e);
      }
    }
  }

  return NextResponse.json({
    ok: true,
    checked: allTickers.length,
    triggered: newTriggers.length,
    triggers: newTriggers,
    lineNotified,
  });
}
