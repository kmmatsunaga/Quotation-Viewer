import { NextRequest, NextResponse } from "next/server";
import { sendLineMessage } from "@/lib/line-notify";

/**
 * POST /api/line/notify
 * Body: { channelAccessToken: string, userId: string, message: string }
 *
 * LINE Messaging API でプッシュメッセージを送信する
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { channelAccessToken, userId, message } = body;

    if (!channelAccessToken || !userId || !message) {
      return NextResponse.json(
        { error: "channelAccessToken, userId, and message are required" },
        { status: 400 }
      );
    }

    const result = await sendLineMessage(channelAccessToken, userId, message);

    return NextResponse.json(result, {
      status: result.ok ? 200 : result.status || 500,
    });
  } catch (err) {
    console.error("LINE message error:", err);
    return NextResponse.json(
      { ok: false, error: "Failed to send message" },
      { status: 500 }
    );
  }
}
