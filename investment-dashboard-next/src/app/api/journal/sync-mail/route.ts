/**
 * POST /api/journal/sync-mail
 *
 * 楽天証券の約定通知メール (make.some.noise6984@gmail.com) を IMAP で取得し、
 * 現物の約定を RakutenFill[] にパースして返す。Firestore への書き込みは行わない
 * (client 側で既存 trades と突合し FIFO ペアリングして書く)。
 *
 * 認証: Gmail アプリパスワード (env GMAIL_USER / GMAIL_APP_PASSWORD)。
 * Node ランタイム必須 (imapflow / mailparser は Edge 不可)。
 */

import { NextRequest, NextResponse } from "next/server";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { parseRakutenFill, type RakutenFill } from "@/lib/rakuten-mail";
import { getAdminAuth } from "@/lib/firebase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RAKUTEN_FROM = "tradesys@rakuten-sec.co.jp";

export async function POST(req: NextRequest) {
  // ── 認証: ログイン済みユーザーの Firebase ID トークン必須 ──
  const authz = req.headers.get("authorization") ?? "";
  const idToken = authz.startsWith("Bearer ") ? authz.slice(7) : null;
  if (!idToken) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  try {
    await getAdminAuth().verifyIdToken(idToken);
  } catch {
    return NextResponse.json({ error: "トークンが無効です" }, { status: 401 });
  }

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    return NextResponse.json(
      { error: "GMAIL_USER / GMAIL_APP_PASSWORD 未設定" },
      { status: 500 },
    );
  }

  let sinceDays = 90;
  try {
    const body = await req.json();
    if (typeof body?.sinceDays === "number") sinceDays = body.sinceDays;
  } catch {
    /* body 無しでも可 */
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  const fills: RakutenFill[] = [];
  const errors: string[] = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date();
      since.setDate(since.getDate() - sinceDays);
      const uids = await client.search({ from: RAKUTEN_FROM, since }, { uid: true });
      const list = Array.isArray(uids) ? uids : [];

      for await (const msg of client.fetch(
        list.length ? list : "1:*",
        { uid: true, source: true, envelope: true },
        { uid: true },
      )) {
        try {
          if (!list.length) {
            // フォールバック検索が空だった場合は全件から差出人を絞る
            const from = msg.envelope?.from?.[0]?.address ?? "";
            if (!from.includes("tradesys@rakuten-sec.co.jp")) continue;
          }
          const parsed = await simpleParser(msg.source as Buffer);
          const html = parsed.html || parsed.textAsHtml || parsed.text || "";
          const msgId = parsed.messageId || `uid:${msg.uid}`;
          const dateMs = parsed.date ? parsed.date.getTime() : undefined;
          const fill = parseRakutenFill(html, msgId, dateMs);
          if (fill) fills.push(fill);
        } catch (e) {
          errors.push(`uid ${msg.uid}: ${(e as Error).message}`);
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    try {
      await client.close();
    } catch {
      /* noop */
    }
    return NextResponse.json(
      { error: `IMAP 接続失敗: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  // 約定日時の新しい順
  fills.sort((a, b) => b.executedAt.localeCompare(a.executedAt));

  return NextResponse.json({ fills, count: fills.length, errors });
}
