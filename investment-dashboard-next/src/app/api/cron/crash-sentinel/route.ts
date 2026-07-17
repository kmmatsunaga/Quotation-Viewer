import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { sendLineMessage } from "@/lib/line-notify";
import { getCronOrigin } from "@/lib/cron-origin";
import {
  assessCrashRisk,
  buildCrashLineMessage,
  type HoldingQuote,
  type MarketContext,
} from "@/lib/crash-sentinel";

/**
 * GET /api/cron/crash-sentinel
 *
 * ポートフォリオに対する暴落サイン (リアルタイム暴落 + 予兆) を検知し、
 *   - Firestore users/{uid}/alerts/crash_current に現在の警報を書き込む (トップページのバナーが読む)
 *   - level != none かつ署名が前回送信と変わったら LINE 通知
 * 感度は「重大時のみ」。日中の複数時刻 + 寄り前 (前日の米国株暴落によるギャップ警戒) に走らせる。
 *
 * 認証: Vercel Cron の Authorization: Bearer ${CRON_SECRET}
 */

const CRON_SECRET = process.env.CRON_SECRET;
const FALLBACK_EMAIL = "make.some.noise6984@gmail.com";
const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

export const maxDuration = 300;

function sma(arr: number[], n: number): number | null {
  if (arr.length < n) return null;
  const slice = arr.slice(-n);
  return slice.reduce((s, v) => s + v, 0) / n;
}

/** yahoo 日足チャート (1年) から、暴落判定に必要な指標を計算 */
async function fetchHoldingQuote(ticker: string, name: string): Promise<Omit<HoldingQuote, "weight"> | null> {
  const isJP = /^\d{3,}[A-Z]?$/.test(ticker);
  const yf = isJP ? `${ticker}.T` : ticker;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yf)}?range=1y&interval=1d&includePrePost=false`;
    const res = await fetch(url, { headers: YF_HEADERS, next: { revalidate: 60 } });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;

    const quote = result.indicators?.quote?.[0] ?? {};
    const rawCloses: (number | null)[] = quote.close ?? [];
    const rawVols: (number | null)[] = quote.volume ?? [];
    const rawOpens: (number | null)[] = quote.open ?? [];

    // 当日を除いた確定終値の配列 (最後の要素は形成中の当日足なので分けて扱う)
    const closes = rawCloses.filter((v): v is number => v != null);
    const vols = rawVols.filter((v): v is number => v != null);

    const price = meta.regularMarketPrice ?? closes[closes.length - 1] ?? 0;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? closes[closes.length - 2] ?? price;
    if (!price || !prevClose) return null;
    const changePct = ((price - prevClose) / prevClose) * 100;

    // 寄りギャップ (今日の始値)
    const todayOpen = rawOpens.length ? rawOpens[rawOpens.length - 1] : null;
    const openPct = todayOpen != null && prevClose ? ((todayOpen - prevClose) / prevClose) * 100 : null;

    // 確定足ベース (当日足を除く) で移動平均・高値・平均出来高
    const hist = closes.slice(0, -1); // 前日までの終値
    const sma20 = sma(hist, 20);
    const sma50 = sma(hist, 50);
    const sma200 = sma(hist, 200);

    // 直近20日高値と、その日からの経過日数
    const last20 = hist.slice(-20);
    let high20: number | null = null;
    let daysSinceHigh20: number | null = null;
    if (last20.length > 0) {
      high20 = Math.max(...last20);
      const idx = last20.lastIndexOf(high20);
      daysSinceHigh20 = last20.length - 1 - idx;
    }

    // 出来高倍率 (当日 / 直近20日平均)
    const todayVol = vols.length ? vols[vols.length - 1] : null;
    const avg20Vol = vols.length > 1 ? sma(vols.slice(0, -1), 20) : null;
    const volRatio = todayVol != null && avg20Vol && avg20Vol > 0 ? todayVol / avg20Vol : null;

    return {
      ticker, name,
      price: Math.round(price * 100) / 100,
      prevClose: Math.round(prevClose * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
      openPct: openPct != null ? Math.round(openPct * 100) / 100 : null,
      sma20, sma50, sma200, high20, daysSinceHigh20, volRatio,
    };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const origin = getCronOrigin(req);
  const db = getAdminDb();
  const emailsRaw = process.env.CAVKA_CRON_EMAILS ?? FALLBACK_EMAIL;
  const emails = emailsRaw.split(",").map((e) => e.trim()).filter(Boolean);

  // ── 市場コンテキスト (全ユーザー共通) ──
  const market: MarketContext = { nikkeiChangePct: null, recessionProb: null };
  try {
    const res = await fetch(`${origin}/api/market/indices`, { next: { revalidate: 60 } });
    if (res.ok) {
      const arr = (await res.json()) as { name: string; change_pct: number }[];
      const nikkei = arr.find((i) => i.name?.includes("日経"));
      if (nikkei) market.nikkeiChangePct = nikkei.change_pct;
    }
  } catch {}
  try {
    const res = await fetch(`${origin}/api/macro/fred-watch`, { next: { revalidate: 3600 } });
    if (res.ok) {
      const j = await res.json();
      const p = j?.recession?.probRecession12m;
      if (typeof p === "number") market.recessionProb = p;
    }
  } catch {}

  const results: Record<string, unknown>[] = [];

  for (const email of emails) {
    try {
      const usersSnap = await db.collection("users").where("email", "==", email).get();
      if (usersSnap.empty) {
        results.push({ email, ok: false, error: "user not found" });
        continue;
      }

      for (const userDoc of usersSnap.docs) {
        const uid = userDoc.id;
        const userData = userDoc.data() as Record<string, unknown>;
        const channelAccessToken = userData.lineChannelAccessToken as string | undefined;
        const lineUserId = userData.lineUserId as string | undefined;

        // 保有銘柄 (日本株のみ: yahoo日足で判定)
        const pfSnap = await db.collection("users").doc(uid).collection("portfolio").get();
        const rawHoldings = pfSnap.docs
          .map((d) => d.data() as Record<string, unknown>)
          .map((d) => ({
            ticker: String(d.ticker ?? ""),
            name: String(d.name ?? d.ticker ?? ""),
            shares: Number(d.shares ?? 0),
          }))
          .filter((h) => /^\d{3,4}[A-Z]?$/.test(h.ticker) && h.shares > 0);

        if (rawHoldings.length === 0) {
          results.push({ email, uid, ok: true, level: "none", note: "no JP holdings" });
          continue;
        }

        // ティッカー重複を集約 (同一銘柄の複数ロット)
        const byTicker = new Map<string, { ticker: string; name: string; shares: number }>();
        for (const h of rawHoldings) {
          const ex = byTicker.get(h.ticker);
          if (ex) ex.shares += h.shares;
          else byTicker.set(h.ticker, { ...h });
        }

        // 各銘柄のクオート取得
        const quotes = (
          await Promise.all(
            Array.from(byTicker.values()).map(async (h) => {
              const q = await fetchHoldingQuote(h.ticker, h.name);
              return q ? { ...q, shares: h.shares } : null;
            })
          )
        ).filter((q): q is Omit<HoldingQuote, "weight"> & { shares: number } => q != null);

        if (quotes.length === 0) {
          results.push({ email, uid, ok: false, error: "no quotes" });
          continue;
        }

        // ウェイト (時価) を付与
        const totalValue = quotes.reduce((s, q) => s + q.price * q.shares, 0);
        const holdings: HoldingQuote[] = quotes.map((q) => {
          const { shares, ...rest } = q;
          return { ...rest, weight: totalValue > 0 ? (q.price * shares) / totalValue : 0 };
        });

        // ── 判定 ──
        const assessment = assessCrashRisk(holdings, market);

        // 現在の警報を Firestore に書き込む (トップページのバナーが購読)
        const alertRef = db.collection("users").doc(uid).collection("alerts").doc("crash_current");
        const prevSnap = await alertRef.get();
        const prevData = prevSnap.exists ? (prevSnap.data() as Record<string, unknown>) : {};
        const lastSentSignature = (prevData.lastSentSignature as string) ?? "";

        const nowIso = new Date().toISOString();
        await alertRef.set({
          level: assessment.level,
          headline: assessment.headline,
          summary: assessment.summary,
          advice: assessment.advice,
          signals: assessment.signals,
          affectedTickers: assessment.affectedTickers,
          signature: assessment.signature,
          nikkeiChangePct: market.nikkeiChangePct,
          updatedAt: nowIso,
          // lastSentSignature は下で更新
          lastSentSignature,
        });

        // ── LINE 通知 (level != none かつ 署名が変わった時のみ) ──
        let sent = false;
        if (
          assessment.level !== "none" &&
          assessment.signature !== lastSentSignature &&
          channelAccessToken && lineUserId
        ) {
          const msg = buildCrashLineMessage(assessment);
          const r = await sendLineMessage(channelAccessToken, lineUserId, msg);
          if (r.ok) {
            sent = true;
            await alertRef.update({ lastSentSignature: assessment.signature, lastSentAt: nowIso });
          }
        }

        results.push({
          email, uid, ok: true,
          level: assessment.level,
          signals: assessment.signals.length,
          affected: assessment.affectedTickers,
          lineSent: sent,
        });
      }
    } catch (err) {
      results.push({ email, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({
    ok: true,
    market,
    timestamp: new Date().toISOString(),
    results,
  });
}
