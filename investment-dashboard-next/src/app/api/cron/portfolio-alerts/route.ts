import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { sendLineMessage } from "@/lib/line-notify";
import { getCronOrigin } from "@/lib/cron-origin";

/**
 * GET /api/cron/portfolio-alerts
 *
 * 毎朝 JST 08:30 (= UTC 23:30) に走らせる:
 *   ポートフォリオ+お気に入り銘柄について、直近24時間の重大イベントを LINE 通知。
 *   通知対象:
 *     - 🚨 scandal / lawsuit (不祥事/訴訟)
 *     - 📉 earnings_revision_down (業績下方修正)
 *     - 💸 dividend_down (減配/無配)
 *     - 🚨 valueTrap フラグが立っている銘柄 (継続注意喚起)
 *   同じイベントは重複通知しない (Firestore に通知済記録)
 *
 * 認証: Vercel Cron は Authorization: Bearer ${CRON_SECRET}
 */

const CRON_SECRET = process.env.CRON_SECRET;
const MCP_API_KEY = process.env.MCP_API_KEY;
const FALLBACK_EMAIL = "make.some.noise6984@gmail.com";

export const maxDuration = 300;

interface DisclosureEvent {
  newsId: string;
  date: string;        // YYYYMMDD
  type: string;
  headline: string;
  impact: string;
}

interface SentimentDoc {
  disclosures?: {
    events: DisclosureEvent[];
    hasCriticalNegative: boolean;
  };
}

interface FutureScoreResp {
  ticker: string;
  name: string;
  overall?: { raw: number; label: string };
  flags?: {
    valueTrap: boolean;
    overhyped: boolean;
  };
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!MCP_API_KEY) {
    return NextResponse.json({ error: "MCP_API_KEY not configured" }, { status: 500 });
  }

  const origin = getCronOrigin(req);

  const db = getAdminDb();
  const emailsRaw = process.env.CAVKA_CRON_EMAILS ?? FALLBACK_EMAIL;
  const emails = emailsRaw.split(",").map((e) => e.trim()).filter(Boolean);

  const results: { email: string; sent: boolean; events: number; error?: string }[] = [];

  for (const email of emails) {
    try {
      const usersSnap = await db.collection("users").where("email", "==", email).get();
      if (usersSnap.empty) {
        results.push({ email, sent: false, events: 0, error: "user not found" });
        continue;
      }

      for (const userDoc of usersSnap.docs) {
        const uid = userDoc.id;
        const userData = userDoc.data() as Record<string, unknown>;
        const channelAccessToken = userData.lineChannelAccessToken as string | undefined;
        const lineUserId = userData.lineUserId as string | undefined;

        // ポートフォリオ + favorites の ticker を集める
        const tickerSet = new Set<string>();
        const subs = [
          { col: "favorites", field: "ticker" },
          { col: "portfolio", field: "ticker" },
          { col: "watchlist", field: "ticker" },
        ];
        for (const s of subs) {
          const ss = await db.collection("users").doc(uid).collection(s.col).get();
          for (const d of ss.docs) {
            const t = (d.data() as Record<string, unknown>)[s.field];
            if (typeof t === "string" && /^\d{3,4}[A-Z]?$/.test(t)) tickerSet.add(t);
          }
        }
        const tickers = Array.from(tickerSet);
        if (tickers.length === 0) continue;

        // 通知済記録を取得
        const notifiedSnap = await db.collection("users").doc(uid).collection("alertNotified").get();
        const notifiedSet = new Set(notifiedSnap.docs.map((d) => d.id));

        // 各 ticker のセンチメント (含む disclosures) と future-score を取得
        const alertItems: {
          ticker: string;
          name: string;
          type: "scandal" | "lawsuit" | "downRevision" | "dividendDown" | "valueTrap";
          date?: string;
          headline?: string;
          score?: number;
          notifyKey: string;
        }[] = [];

        const todayKey = formatDateJst(new Date());
        const yesterdayKey = formatDateJst(new Date(Date.now() - 24 * 60 * 60 * 1000));

        for (const ticker of tickers) {
          // 1. 開示イベント (直近24時間)
          const sentSnap = await db.collection("meta").doc(`sentiment_${ticker}`).get();
          if (sentSnap.exists) {
            const sd = sentSnap.data() as SentimentDoc;
            const events = sd.disclosures?.events ?? [];
            for (const e of events) {
              if (e.date < yesterdayKey) continue; // 24時間より古い → スキップ
              const notifyKey = `disc_${ticker}_${e.newsId}`;
              if (notifiedSet.has(notifyKey)) continue; // 通知済

              let type: "scandal" | "lawsuit" | "downRevision" | "dividendDown" | null = null;
              if (e.type === "scandal") type = "scandal";
              else if (e.type === "lawsuit") type = "lawsuit";
              else if (e.type === "earnings_revision_down") type = "downRevision";
              else if (e.type === "dividend_down") type = "dividendDown";
              if (!type) continue;

              // 名前を取得
              const stockMaster = await db.collection("meta").doc("jpStockMaster").get();
              const stocks = (stockMaster.data()?.stocks as { ticker: string; name: string }[]) ?? [];
              const name = stocks.find((s) => s.ticker === ticker)?.name ?? ticker;

              alertItems.push({
                ticker, name, type, date: e.date, headline: e.headline, notifyKey,
              });
            }
          }

          // 2. valueTrap (継続注意喚起、週1回まで)
          try {
            const res = await fetch(
              `${origin}/api/stocks/future-score/${encodeURIComponent(ticker)}`
            );
            if (res.ok) {
              const fs = (await res.json()) as FutureScoreResp;
              if (fs.flags?.valueTrap) {
                // 週次キー (今週の月曜日)
                const weekKey = getWeekKey(new Date());
                const notifyKey = `trap_${ticker}_${weekKey}`;
                if (!notifiedSet.has(notifyKey)) {
                  alertItems.push({
                    ticker, name: fs.name, type: "valueTrap",
                    score: fs.overall?.raw, notifyKey,
                  });
                }
              }
            }
          } catch {}
        }

        // 通知メッセージ構築
        if (alertItems.length > 0 && channelAccessToken && lineUserId) {
          const message = buildAlertMessage(alertItems);
          const sendResult = await sendLineMessage(channelAccessToken, lineUserId, message);
          if (sendResult.ok) {
            // Firestore に通知済記録を残す
            const batch = db.batch();
            for (const item of alertItems) {
              const ref = db
                .collection("users").doc(uid)
                .collection("alertNotified").doc(item.notifyKey);
              batch.set(ref, {
                ticker: item.ticker,
                type: item.type,
                date: item.date ?? todayKey,
                notifiedAt: new Date(),
              });
            }
            await batch.commit();
            results.push({ email, sent: true, events: alertItems.length });
          } else {
            results.push({ email, sent: false, events: alertItems.length, error: sendResult.message });
          }
        } else {
          results.push({ email, sent: false, events: alertItems.length, error: alertItems.length === 0 ? "no new events" : "no LINE credentials" });
        }
      }
    } catch (err) {
      results.push({
        email,
        sent: false,
        events: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ ok: true, results });
}

function formatDateJst(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function getWeekKey(d: Date): string {
  // 今週の月曜日 YYYYMMDD
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const dayOfWeek = jst.getUTCDay();
  const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(jst);
  monday.setUTCDate(jst.getUTCDate() + diff);
  return `${monday.getUTCFullYear()}${String(monday.getUTCMonth() + 1).padStart(2, "0")}${String(monday.getUTCDate()).padStart(2, "0")}`;
}

function buildAlertMessage(items: {
  ticker: string;
  name: string;
  type: string;
  date?: string;
  headline?: string;
  score?: number;
}[]): string {
  const lines = [`📊 Cavka 重要アラート (${items.length}件)`, ""];

  const grouped: Record<string, typeof items> = {};
  for (const item of items) {
    if (!grouped[item.type]) grouped[item.type] = [];
    grouped[item.type].push(item);
  }

  const labels: Record<string, string> = {
    scandal: "🚨 不祥事",
    lawsuit: "⚖ 訴訟",
    downRevision: "📉 業績下方修正",
    dividendDown: "💸 減配",
    valueTrap: "🪤 バリュートラップ警告",
  };

  for (const [type, list] of Object.entries(grouped)) {
    lines.push(labels[type] ?? type);
    for (const item of list) {
      const date = item.date ? `[${item.date.slice(4, 6)}/${item.date.slice(6, 8)}]` : "";
      const head = item.headline ? ` ${item.headline.slice(0, 40)}` : "";
      const sc = item.score !== undefined ? ` (score ${item.score})` : "";
      lines.push(`  ${date} ${item.ticker} ${item.name}${head}${sc}`);
    }
    lines.push("");
  }

  lines.push("📱 詳細: https://quotation-viewer.vercel.app/portfolio");
  return lines.join("\n");
}
