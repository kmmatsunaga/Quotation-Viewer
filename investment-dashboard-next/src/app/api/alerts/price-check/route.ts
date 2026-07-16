import { NextRequest, NextResponse } from "next/server";
import { sendLineMessage } from "@/lib/line-notify";

interface AlertInput {
  id: string;
  ticker: string;
  name: string;
  // 旧式
  condition?: "above" | "below";
  targetPrice?: number;
  // 新式
  type?: string;
  params?: {
    targetPrice?: number;
    daysBefore?: number;
    movePct?: number;
  };
}

/**
 * POST /api/alerts/price-check
 *
 * クライアントから呼ばれる価格アラートチェック。
 * Body: {
 *   alerts: AlertInput[],
 *   channelAccessToken?: string,
 *   lineUserId?: string,
 * }
 *
 * 各アラートの銘柄の現在価格を取得し、条件成立したアラートを返す。
 * LINE設定があれば通知も送信。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { alerts, channelAccessToken, lineUserId } = body;

    if (!alerts || !Array.isArray(alerts) || alerts.length === 0) {
      return NextResponse.json({ triggered: [], prices: {} });
    }

    // Fetch current prices
    const tickers = [...new Set(alerts.map((a: AlertInput) => a.ticker))];
    const baseUrl = req.nextUrl.origin;
    const pricesRes = await fetch(
      `${baseUrl}/api/stocks/prices?tickers=${tickers.join(",")}`,
      { headers: { "User-Agent": "PriceAlertBot/1.0" } }
    );

    if (!pricesRes.ok) {
      return NextResponse.json({ error: "Failed to fetch prices" }, { status: 500 });
    }

    const pricesData = await pricesRes.json();
    const prices: Record<string, { price: number; change: number; changePct: number }> =
      pricesData.prices ?? {};

    // 決算アラート用に earnings データも先にバッチ取得
    const earningsAlerts = (alerts as AlertInput[]).filter(
      (a) => a.type === "earnings_days_before"
    );
    let earningsMap: Record<string, { nextEarningsDate: string | null }> = {};
    if (earningsAlerts.length > 0) {
      const earningsTickers = [...new Set(earningsAlerts.map((a) => a.ticker))].join(",");
      try {
        const eRes = await fetch(`${baseUrl}/api/stocks/earnings?tickers=${earningsTickers}`, {
          headers: { "User-Agent": "PriceAlertBot/1.0" },
        });
        if (eRes.ok) {
          const eJson = await eRes.json();
          earningsMap = eJson.earnings ?? {};
        }
      } catch (e) {
        console.error("Earnings fetch error in alert check:", e);
      }
    }

    // Check each alert
    const triggered: {
      id: string;
      ticker: string;
      name: string;
      condition: string;
      targetPrice: number;
      currentPrice: number;
      message?: string;
      type?: string;
    }[] = [];

    for (const alert of alerts as AlertInput[]) {
      const p = prices[alert.ticker];

      // 新式の type で判定
      const aType = alert.type
        ?? (alert.condition === "above" ? "price_above" : alert.condition === "below" ? "price_below" : null);

      if (aType === "earnings_days_before") {
        const earnings = earningsMap[alert.ticker];
        const daysBefore = alert.params?.daysBefore ?? 3;
        if (earnings?.nextEarningsDate) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const target = new Date(earnings.nextEarningsDate);
          target.setHours(0, 0, 0, 0);
          const diffDays = Math.floor((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
          // 当日に発動 (diffDays === daysBefore)
          if (diffDays === daysBefore) {
            triggered.push({
              id: alert.id,
              ticker: alert.ticker,
              name: alert.name,
              condition: "earnings_days_before",
              targetPrice: 0,
              currentPrice: p?.price ?? 0,
              type: "earnings_days_before",
              message: `📅 決算${daysBefore}日前: ${earnings.nextEarningsDate}`,
            });
          }
        }
        continue;
      }

      // 価格アラート (旧式 + 新式 price_above/below)
      if (!p) continue;
      const targetPrice = alert.targetPrice ?? alert.params?.targetPrice ?? 0;
      if (!targetPrice) continue;
      const isAbove = aType === "price_above";
      const met = isAbove ? p.price >= targetPrice : p.price <= targetPrice;
      if (met) {
        triggered.push({
          id: alert.id,
          ticker: alert.ticker,
          name: alert.name,
          condition: isAbove ? "above" : "below",
          targetPrice,
          currentPrice: p.price,
          type: aType ?? "price",
        });
      }
    }

    // Send LINE notification
    let lineResult = null;
    if (triggered.length > 0 && channelAccessToken && lineUserId) {
      const lines = [
        "🔔 価格アラート発動",
        "━━━━━━━━━━━━━━━━━",
        "",
      ];

      for (const t of triggered) {
        if (t.type === "earnings_days_before") {
          lines.push(`📅 ${t.ticker} ${t.name}`);
          lines.push(`  ${t.message ?? "決算予定"}`);
          if (t.currentPrice) lines.push(`  現在: ¥${t.currentPrice.toLocaleString()}`);
        } else {
          const dirLabel = t.condition === "above" ? "以上" : "以下";
          const emoji = t.condition === "above" ? "📈" : "📉";
          lines.push(`${emoji} ${t.ticker} ${t.name}`);
          lines.push(`  目標: ¥${t.targetPrice.toLocaleString()} ${dirLabel}`);
          lines.push(`  現在: ¥${t.currentPrice.toLocaleString()}`);
        }
        lines.push("");
      }

      lines.push(
        `🕒 ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`
      );

      lineResult = await sendLineMessage(
        channelAccessToken,
        lineUserId,
        lines.join("\n")
      );
    }

    return NextResponse.json({
      triggered,
      prices,
      lineNotified: lineResult?.ok ?? false,
      lineError: lineResult && !lineResult.ok ? lineResult.message : null,
    });
  } catch (err) {
    console.error("Price check error:", err);
    return NextResponse.json({ error: "Price check failed" }, { status: 500 });
  }
}
