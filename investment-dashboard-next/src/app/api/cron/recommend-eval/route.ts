import { NextRequest, NextResponse } from "next/server";
import { getAdminDb, resolveUidByEmail } from "@/lib/firebase-admin";
import {
  buildDayEval,
  EVAL_WINDOW,
  type EvalItem,
  type Horizon,
  type DayEval,
} from "@/lib/recommend-eval";

/**
 * GET /api/cron/recommend-eval — 🌟 おすすめv2 の答え合わせ
 *
 * 満期が来た推薦日 (短期 D+5 / 中期 D+20 / 長期 D+60 営業日) を評価する:
 *   ・リターンは「推薦日の始値 → 満期日の終値」 (朝おすすめ → 寄りで買える、を反映)
 *   ・同期間の指数 (JP=日経225 / US=S&P500) を引いた超過リターンが主指標
 *   ・生成時に保存した統制群 (同じ関門・ランダム選抜) も同じ手続きで評価
 *   ・結果は dailyRecommendations/{date}.horizonEval に冪等で書き込む
 *
 * 実行: 平日 JST 17:30 (= UTC 08:30)、引け後。?dry=1 で保存なし。?date=YYYY-MM-DD で単日再評価。
 */

const CRON_SECRET = process.env.CRON_SECRET;
const FALLBACK_EMAIL = "make.some.noise6984@gmail.com";
const YF_HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const BENCH: Record<"JP" | "US", string> = { JP: "%5EN225", US: "%5EGSPC" };

interface Bar { date: string; open: number; close: number }

/** yahoo 日足を {date: YYYY-MM-DD} で取得 (直近1年) */
async function fetchBars(yfSymbol: string): Promise<Bar[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yfSymbol}?range=1y&interval=1d`;
    const res = await fetch(url, { headers: YF_HEADERS, next: { revalidate: 600 } });
    if (!res.ok) return [];
    const j = await res.json();
    const r = j?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const q = r?.indicators?.quote?.[0];
    if (!ts.length || !q) return [];
    const out: Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], c = q.close?.[i];
      if (typeof o !== "number" || typeof c !== "number") continue;
      // JST 日付キー (yahoo の timestamp は現地寄り時刻)
      const d = new Date(ts[i] * 1000);
      out.push({ date: d.toISOString().slice(0, 10), open: o, close: c });
    }
    return out;
  } catch {
    return [];
  }
}

const yfSymbol = (ticker: string, market: string) =>
  market === "US" ? encodeURIComponent(ticker) : `${encodeURIComponent(ticker)}.T`;

/**
 * 推薦日の始値 → N営業日後の終値。
 * bars は日足なので「推薦日以降の最初のバー」を起点、そこから N 本後を満期とする。
 */
function windowReturn(bars: Bar[], fromDate: string, n: number): { retPct: number; maturedOn: string } | null {
  const i = bars.findIndex((b) => b.date >= fromDate);
  if (i < 0) return null;
  const entry = bars[i];
  const j = i + n;
  if (j >= bars.length) return null; // まだ満期が来ていない
  const exit = bars[j];
  if (!(entry.open > 0)) return null;
  return { retPct: ((exit.close - entry.open) / entry.open) * 100, maturedOn: exit.date };
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const onlyDate = req.nextUrl.searchParams.get("date");

  const db = getAdminDb();
  const emailsRaw = process.env.CAVKA_CRON_EMAILS ?? FALLBACK_EMAIL;
  const emails = emailsRaw.split(",").map((e) => e.trim()).filter(Boolean);

  // 指数のバーは全ユーザー共通なので先に1回だけ
  const benchBars: Record<"JP" | "US", Bar[]> = {
    JP: await fetchBars(BENCH.JP),
    US: await fetchBars(BENCH.US),
  };

  const results: Record<string, unknown>[] = [];

  for (const email of emails) {
    const uid = await resolveUidByEmail(email);
    if (!uid) { results.push({ email, ok: false, error: "user not found" }); continue; }

    const col = db.collection("users").doc(uid).collection("dailyRecommendations");
    const snap = onlyDate
      ? await col.where("date", "==", onlyDate).get()
      : await col.orderBy("date", "desc").limit(90).get();

    // 銘柄バーのキャッシュ (同じ銘柄が複数日に登場するため)
    const barCache = new Map<string, Bar[]>();
    const getBars = async (ticker: string, market: string): Promise<Bar[]> => {
      const key = `${market}:${ticker}`;
      if (!barCache.has(key)) barCache.set(key, await fetchBars(yfSymbol(ticker, market)));
      return barCache.get(key)!;
    };

    let evaluatedDocs = 0;
    let newlyMatured = 0;

    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      if (data.version !== 2) continue; // v2 (統制群つき) のみ評価対象
      const date = data.date as string;
      const horizons = (data.horizons ?? {}) as Record<Horizon, { ticker: string; market: string }[]>;
      const controls = (data.controls ?? {}) as Record<Horizon, { ticker: string; market: string }[]>;
      const prevEval = (data.horizonEval ?? {}) as Record<string, DayEval>;

      const horizonEval: Record<string, DayEval> = { ...prevEval };
      let changed = false;

      for (const h of ["short", "mid", "long", "kiyohara"] as Horizon[]) {
        if (prevEval[h]) continue; // 評価済みは再計算しない (冪等 + API節約)
        const picks = horizons[h] ?? [];
        const ctrls = controls[h] ?? [];
        if (picks.length === 0) continue;

        const n = EVAL_WINDOW[h];

        // 満期チェック: 1銘柄でも満期が来ていなければ、この時間軸はまだ評価しない
        const probeMarket = (picks[0].market as "JP" | "US") ?? "JP";
        const probe = windowReturn(benchBars[probeMarket], date, n);
        if (!probe) continue; // まだ熟成中

        const evalOne = async (e: { ticker: string; market: string }): Promise<EvalItem> => {
          const mkt = (e.market === "US" ? "US" : "JP") as "JP" | "US";
          const bars = await getBars(e.ticker, mkt);
          const r = windowReturn(bars, date, n);
          const b = windowReturn(benchBars[mkt], date, n);
          if (!r || !b) {
            // 上場廃止・データ欠損 = 評価不能 (生存者バイアスを黙って埋めない)
            return { ticker: e.ticker, retPct: null, benchPct: null, excessPct: null };
          }
          return {
            ticker: e.ticker,
            retPct: Math.round(r.retPct * 100) / 100,
            benchPct: Math.round(b.retPct * 100) / 100,
            excessPct: Math.round((r.retPct - b.retPct) * 100) / 100,
          };
        };

        const pickItems: EvalItem[] = [];
        for (let i = 0; i < picks.length; i += 5) {
          pickItems.push(...await Promise.all(picks.slice(i, i + 5).map(evalOne)));
        }
        const ctrlItems: EvalItem[] = [];
        for (let i = 0; i < ctrls.length; i += 5) {
          ctrlItems.push(...await Promise.all(ctrls.slice(i, i + 5).map(evalOne)));
        }

        horizonEval[h] = buildDayEval(date, h, probe.maturedOn, pickItems, ctrlItems);
        changed = true;
        newlyMatured++;
      }

      if (changed) {
        evaluatedDocs++;
        if (!dry) await doc.ref.set({ horizonEval, evaluatedAt: new Date() }, { merge: true });
      }
    }

    results.push({ email, ok: true, docsScanned: snap.size, evaluatedDocs, newlyMatured, dry });
  }

  return NextResponse.json({ ok: true, timestamp: new Date().toISOString(), results });
}
