import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";

/**
 * GET /api/cron/candidates-eval — ⚔ デイトレ候補の日次答え合わせ
 *
 * 朝の候補 (morning-agent が meta/candidate_snapshot_{date} に保存) を、
 * 引け後に当日の OHLC で自動評価する:
 *   - hit: 方向的中 (long: 引け > 寄り / short: 引け < 寄り)
 *   - openToClosePct: 寄り→引けの騰落率 (候補方向で符号調整した signedPct も)
 *   - maxFavorablePct / maxAdversePct: 寄りから見た最大順行/逆行
 *
 * 「候補ロジック自体が信用できるか」を検証するループ。/accuracy に表示。
 *
 * 実行: 平日 JST 16:10 目標 (Hobby 遅延で 16:10〜17:10)。
 * ?date=YYYYMMDD で過去日の再評価 (スナップショットがある日のみ)。?dry=1 は保存なし。
 */

const CRON_SECRET = process.env.CRON_SECRET;
export const maxDuration = 120;
export const dynamic = "force-dynamic";

function jstDateKey(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
}

interface SnapCandidate {
  ticker: string;
  name: string;
  hint: "long" | "short" | string;
  weight: number | null;
  consistency: number | null;
  reasons: string[];
}

interface DayOhlc { open: number; high: number; low: number; close: number }

/** 当日 (dateKey) の日足 OHLC を Yahoo から取得 */
async function fetchDayOhlc(ticker: string, dateKey: string): Promise<DayOhlc | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}.T?range=5d&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 600 } });
    if (!res.ok) return null;
    const j = await res.json();
    const r = j?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const q = r?.indicators?.quote?.[0];
    if (!ts.length || !q) return null;
    for (let i = ts.length - 1; i >= 0; i--) {
      if (jstDateKey(new Date(ts[i] * 1000)) !== dateKey) continue;
      const open = q.open?.[i], high = q.high?.[i], low = q.low?.[i], close = q.close?.[i];
      if ([open, high, low, close].some((v) => typeof v !== "number" || !isFinite(v))) return null;
      return { open, high, low, close };
    }
    return null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const authHeader = req.headers.get("authorization");
  if (!dry && CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getAdminDb();
  const dateKey = req.nextUrl.searchParams.get("date") ?? jstDateKey(new Date());

  const snap = await db.collection("meta").doc(`candidate_snapshot_${dateKey}`).get();
  if (!snap.exists) {
    return NextResponse.json({ ok: true, date: dateKey, skipped: "スナップショットなし (休日 or morning-agent 未実行)" });
  }
  const data = snap.data() ?? {};
  const candidates: SnapCandidate[] = [
    ...((data.longs ?? []) as SnapCandidate[]),
    ...((data.shorts ?? []) as SnapCandidate[]),
  ];
  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, date: dateKey, skipped: "候補ゼロ" });
  }

  const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 10000) / 100 : 0);

  const entries = [];
  for (const c of candidates) {
    const ohlc = await fetchDayOhlc(c.ticker, dateKey);
    if (!ohlc) {
      entries.push({ ...c, evaluated: false });
      continue;
    }
    const openToClosePct = pct(ohlc.close, ohlc.open);
    const isLong = c.hint !== "short";
    const signedPct = isLong ? openToClosePct : -openToClosePct;
    entries.push({
      ...c,
      evaluated: true,
      ohlc,
      openToClosePct,
      signedPct,                                   // 候補方向に乗った場合の寄り→引け損益%
      hit: signedPct > 0,
      maxFavorablePct: isLong ? pct(ohlc.high, ohlc.open) : -pct(ohlc.low, ohlc.open),
      maxAdversePct: isLong ? pct(ohlc.low, ohlc.open) : -pct(ohlc.high, ohlc.open),
    });
  }

  const evaluated = entries.filter((e) => e.evaluated) as Array<{ hit: boolean; signedPct: number }>;
  const hits = evaluated.filter((e) => e.hit).length;
  const summary = {
    n: evaluated.length,
    hits,
    hitRate: evaluated.length > 0 ? Math.round((hits / evaluated.length) * 100) : null,
    avgSignedPct: evaluated.length > 0
      ? Math.round((evaluated.reduce((s, e) => s + e.signedPct, 0) / evaluated.length) * 100) / 100
      : null,
  };

  if (!dry) {
    await db.collection("meta").doc(`candidate_eval_${dateKey}`).set({
      date: dateKey,
      evaluatedAtIso: new Date().toISOString(),
      entries,
      summary,
    });
  }

  return NextResponse.json({ ok: true, date: dateKey, summary, entries: dry ? entries : entries.length });
}
