import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { detectTransitions, type MacroSnapshot, type Transition } from "@/lib/macro-transitions";
import { getCachedJpStocks } from "@/lib/jp-stocks-cache";

/**
 * GET /api/briefing
 *
 * 朝のブリーフィング: 「前日から何が変わったか」だけを返す。
 *   1. マクロ遷移 (macro_fred_watch_history の直近2日差分)
 *   2. 評決の変化 (verdict_history の直近2日差分 — スタンスが変わった銘柄のみ)
 *   3. スコア急変 (score_rankings の直近2日差分 — overall 変化 Top5 上下)
 *
 * すべて Firestore キャッシュ読みのみ (外部API呼び出しなし) なので高速。
 */

export const maxDuration = 30;

function jstDateKey(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
}

/** 直近 N 日で最初に見つかった doc とその日付キーを返す (skipKey より古いもの) */
async function findLatestDoc(
  db: FirebaseFirestore.Firestore,
  prefix: string,
  maxBack: number,
  beforeKey?: string
): Promise<{ key: string; data: FirebaseFirestore.DocumentData } | null> {
  for (let i = 0; i <= maxBack; i++) {
    const key = jstDateKey(new Date(Date.now() - i * 24 * 3600 * 1000));
    if (beforeKey && key >= beforeKey) continue;
    const snap = await db.collection("meta").doc(`${prefix}${key}`).get();
    if (snap.exists) return { key, data: snap.data() ?? {} };
  }
  return null;
}

interface VerdictEntry {
  ticker: string;
  price: number | null;
  short: { stance: string; conviction: number };
  mid: { stance: string; conviction: number };
  long: { stance: string; conviction: number };
}

interface RankEntry {
  ticker: string;
  name: string;
  market: string;
  overall: number;
  price: number | null;
}

export async function GET() {
  const db = getAdminDb();
  const startedAt = Date.now();

  try {
    // ── 1. マクロ遷移 ──
    let macroTransitions: Transition[] = [];
    let macroDates: { today: string; prev: string } | null = null;
    const mToday = await findLatestDoc(db, "macro_fred_watch_history_", 3);
    if (mToday) {
      const mPrev = await findLatestDoc(db, "macro_fred_watch_history_", 7, mToday.key);
      if (mPrev) {
        macroTransitions = detectTransitions(
          mPrev.data as Partial<MacroSnapshot>,
          mToday.data as MacroSnapshot
        );
        macroDates = { today: mToday.key, prev: mPrev.key };
      }
    }

    // ── 2. 評決の変化 ──
    interface VerdictChange {
      ticker: string;
      name: string;
      tf: "short" | "mid" | "long";
      from: string;
      to: string;
      conviction: number;
    }
    const verdictChanges: VerdictChange[] = [];
    let verdictDates: { today: string; prev: string } | null = null;
    const vToday = await findLatestDoc(db, "verdict_history_", 3);
    if (vToday) {
      const vPrev = await findLatestDoc(db, "verdict_history_", 7, vToday.key);
      if (vPrev) {
        verdictDates = { today: vToday.key, prev: vPrev.key };
        // 社名解決 (立花マスタ)。失敗しても ticker で継続
        let nameMap = new Map<string, string>();
        try {
          nameMap = new Map((await getCachedJpStocks()).map((s) => [s.ticker, s.name]));
        } catch {}
        const prevMap = new Map(
          ((vPrev.data.entries ?? []) as VerdictEntry[]).map((e) => [e.ticker, e])
        );
        for (const cur of (vToday.data.entries ?? []) as VerdictEntry[]) {
          const prev = prevMap.get(cur.ticker);
          if (!prev) continue;
          for (const tf of ["short", "mid", "long"] as const) {
            if (prev[tf]?.stance && cur[tf]?.stance && prev[tf].stance !== cur[tf].stance) {
              verdictChanges.push({
                ticker: cur.ticker,
                name: nameMap.get(cur.ticker) ?? cur.ticker,
                tf,
                from: prev[tf].stance,
                to: cur[tf].stance,
                conviction: cur[tf].conviction,
              });
            }
          }
        }
      }
    }

    // ── 3. スコア急変 (全731銘柄から Top5 上下) ──
    interface Mover {
      ticker: string;
      name: string;
      market: string;
      overallFrom: number;
      overallTo: number;
      delta: number;
    }
    let movers: { up: Mover[]; down: Mover[] } = { up: [], down: [] };
    let rankDates: { today: string; prev: string } | null = null;
    const rToday = await findLatestDoc(db, "score_rankings_", 3);
    if (rToday) {
      const rPrev = await findLatestDoc(db, "score_rankings_", 7, rToday.key);
      if (rPrev) {
        rankDates = { today: rToday.key, prev: rPrev.key };
        const prevMap = new Map(
          ((rPrev.data.entries ?? []) as RankEntry[]).map((e) => [e.ticker, e])
        );
        const all: Mover[] = [];
        for (const cur of (rToday.data.entries ?? []) as RankEntry[]) {
          const prev = prevMap.get(cur.ticker);
          if (!prev) continue;
          const delta = cur.overall - prev.overall;
          if (Math.abs(delta) >= 8) {
            all.push({
              ticker: cur.ticker,
              name: cur.name,
              market: cur.market,
              overallFrom: prev.overall,
              overallTo: cur.overall,
              delta,
            });
          }
        }
        all.sort((a, b) => b.delta - a.delta);
        movers = {
          up: all.filter((m) => m.delta > 0).slice(0, 5),
          down: all.filter((m) => m.delta < 0).slice(-5).reverse().slice(0, 5),
        };
        // down は昇順末尾5件を delta 降順 (最も下落) で
        movers.down = all.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5);
      }
    }

    const hasAnything =
      macroTransitions.length > 0 || verdictChanges.length > 0 || movers.up.length > 0 || movers.down.length > 0;

    return NextResponse.json({
      ok: true,
      generatedAtIso: new Date().toISOString(),
      hasAnything,
      macro: { transitions: macroTransitions, dates: macroDates },
      verdicts: { changes: verdictChanges, dates: verdictDates },
      movers: { ...movers, dates: rankDates },
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
