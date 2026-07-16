import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";

/**
 * GET /api/accuracy
 *
 * 検証ループの集計。過去 120 日分の meta/verdict_eval_{date} を読み、
 *   - 評決: 時間軸 × スタンス別の 勝率 / 平均リターン / サンプル数
 *   - テクニカルスコア: 時間軸 × バケット別の同上 (731銘柄ベース)
 * を返す。認証不要 (統計情報のみ、銘柄は含めない)。
 */

export const maxDuration = 60;

interface VerdictEval {
  tf: "short" | "mid" | "long";
  ticker: string;
  stance: string;
  conviction: number;
  ret: number;
  hit: boolean | null;
}

interface TechEval {
  tf: "short" | "mid" | "long";
  bucket: "bull" | "bear" | "neutral";
  n: number;
  hits: number;
  sumRet: number;
}

function jstDateKey(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
}

export async function GET(req: NextRequest) {
  const days = Math.min(365, Number(req.nextUrl.searchParams.get("days") ?? "120"));
  const db = getAdminDb();
  const startedAt = Date.now();

  try {
    // 過去 N 日分のドキュメント参照を作って一括取得
    const refs = [];
    for (let i = 0; i < days; i++) {
      const key = jstDateKey(new Date(Date.now() - i * 24 * 3600 * 1000));
      refs.push(db.collection("meta").doc(`verdict_eval_${key}`));
    }
    // デイトレ候補の答え合わせ (candidates-eval cron が書く) も同じ期間で読む
    const candRefs = [];
    for (let i = 0; i < Math.min(days, 30); i++) {
      const key = jstDateKey(new Date(Date.now() - i * 24 * 3600 * 1000));
      candRefs.push(db.collection("meta").doc(`candidate_eval_${key}`));
    }
    const [snaps, candSnaps] = await Promise.all([db.getAll(...refs), db.getAll(...candRefs)]);
    const evalDocs = snaps.filter((s) => s.exists);

    // ── 評決の集計 (tf × stance) ──
    interface Agg { n: number; hits: number; judged: number; sumRet: number }
    const verdictAgg = new Map<string, Agg>();
    // ── テクニカルの集計 (tf × bucket) ──
    const techAgg = new Map<string, Agg>();

    let firstDate: string | null = null;
    let lastDate: string | null = null;

    for (const doc of evalDocs) {
      const data = doc.data() ?? {};
      const date = data.date as string;
      if (!firstDate || date < firstDate) firstDate = date;
      if (!lastDate || date > lastDate) lastDate = date;

      for (const e of (data.verdictEvals ?? []) as VerdictEval[]) {
        const key = `${e.tf}_${e.stance}`;
        const a = verdictAgg.get(key) ?? { n: 0, hits: 0, judged: 0, sumRet: 0 };
        a.n++;
        a.sumRet += e.ret;
        if (e.hit !== null) {
          a.judged++;
          if (e.hit) a.hits++;
        }
        verdictAgg.set(key, a);
      }

      for (const t of (data.techEvals ?? []) as TechEval[]) {
        const key = `${t.tf}_${t.bucket}`;
        const a = techAgg.get(key) ?? { n: 0, hits: 0, judged: 0, sumRet: 0 };
        a.n += t.n;
        a.judged += t.bucket === "neutral" ? 0 : t.n;
        a.hits += t.hits;
        a.sumRet += t.sumRet;
        techAgg.set(key, a);
      }
    }

    const fmt = (m: Map<string, Agg>) =>
      Array.from(m.entries()).map(([key, a]) => {
        const [tf, ...rest] = key.split("_");
        return {
          tf,
          group: rest.join("_"),
          n: a.n,
          judged: a.judged,
          hitRate: a.judged > 0 ? Math.round((a.hits / a.judged) * 1000) / 10 : null,  // %
          avgRet: a.n > 0 ? Math.round((a.sumRet / a.n) * 10000) / 100 : null,          // %
        };
      });

    // ── デイトレ候補の答え合わせ (日別 + 全体) ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candDays: any[] = [];
    let candN = 0, candHits = 0, candSumPct = 0;
    for (const doc of candSnaps.filter((s) => s.exists)) {
      const d = doc.data() ?? {};
      const s = d.summary ?? {};
      if (typeof s.n !== "number" || s.n === 0) continue;
      candDays.push({
        date: d.date,
        n: s.n,
        hitRate: s.hitRate,
        avgSignedPct: s.avgSignedPct,
        // 個別詳細 (ticker/hint/hit/signedPct のみに絞る)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        entries: ((d.entries ?? []) as any[])
          .filter((e) => e.evaluated)
          .map((e) => ({ ticker: e.ticker, name: e.name, hint: e.hint, hit: e.hit, signedPct: e.signedPct, consistency: e.consistency })),
      });
      candN += s.n;
      candHits += s.hits ?? 0;
      candSumPct += (s.avgSignedPct ?? 0) * s.n;
    }
    candDays.sort((a, b) => (b.date as string).localeCompare(a.date as string));

    return NextResponse.json({
      ok: true,
      evalDays: evalDocs.length,
      firstDate,
      lastDate,
      verdict: fmt(verdictAgg),
      tech: fmt(techAgg),
      candidates: {
        days: candDays.slice(0, 15),
        total: {
          n: candN,
          hitRate: candN > 0 ? Math.round((candHits / candN) * 1000) / 10 : null,
          avgSignedPct: candN > 0 ? Math.round((candSumPct / candN) * 100) / 100 : null,
        },
      },
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
