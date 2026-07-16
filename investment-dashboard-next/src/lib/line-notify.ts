/**
 * LINE Messaging API helper
 *
 * LINE Notify は 2025/3/31 で終了。
 * 代わりに LINE Messaging API (Push Message) を使用。
 *
 * 必要な情報:
 *   - Channel Access Token: LINE Developers コンソールで発行
 *   - User ID: LINE Developers コンソールの「あなたのユーザーID」で確認
 *
 * セットアップ手順:
 *   1. LINE Official Account を作成 (https://manager.line.biz/)
 *   2. LINE Developers (https://developers.line.biz/) でプロバイダー作成
 *   3. Messaging API チャネルを作成
 *   4. チャネルアクセストークン（長期）を発行
 *   5. 基本設定の「あなたのユーザーID」をメモ
 *   6. 作成したLINE公式アカウントを友だち追加
 */

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

export interface LineSendResult {
  ok: boolean;
  status: number;
  message: string;
}

/**
 * LINE Messaging API でプッシュメッセージを送信する
 */
export async function sendLineMessage(
  channelAccessToken: string,
  userId: string,
  message: string
): Promise<LineSendResult> {
  // fetch にタイムアウトを付ける (無いと LINE 側の無応答で関数がハングし、
  // cron が maxDuration で強制終了 → 状態が "running" のまま残る事故になる)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(LINE_PUSH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${channelAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: userId,
        messages: [
          {
            type: "text",
            text: message,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (res.status === 200) {
      return { ok: true, status: 200, message: "Success" };
    }

    const json = await res.json().catch(() => ({}));
    return {
      ok: false,
      status: res.status,
      message: json.message ?? `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: err instanceof Error ? (err.name === "AbortError" ? "LINE timeout (10s)" : err.message) : "Unknown error",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * パターン遷移アラートのLINEメッセージを構築する
 */
export function buildPatternAlertMessage(alerts: PatternAlertItem[]): string {
  if (alerts.length === 0) return "";

  const lines = [
    "📊 パターン遷移アラート",
    "━━━━━━━━━━━━━━━━━",
    "",
  ];

  for (const a of alerts) {
    const signalEmoji =
      a.signal === "buy" ? "🔴" :
      a.signal === "sell" ? "🔵" :
      a.signal === "watch" ? "🟡" : "⚪";

    lines.push(`${signalEmoji} ${a.ticker} ${a.name}`);
    lines.push(`  現在: ${a.currentPattern}`);
    lines.push(`  → 次: ${a.nextPattern} (確度${a.proximity}%)`);
    lines.push(`  条件: ${a.triggers.join(", ")}`);
    lines.push("");
  }

  lines.push(`🕒 ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`);

  return lines.join("\n");
}

export interface PatternAlertItem {
  ticker: string;
  name: string;
  currentPattern: string;
  nextPattern: string;
  signal: string;
  proximity: number;
  triggers: string[];
}
