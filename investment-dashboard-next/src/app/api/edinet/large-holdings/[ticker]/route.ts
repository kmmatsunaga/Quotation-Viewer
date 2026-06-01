import { NextRequest, NextResponse } from "next/server";
import {
  fetchRecentLargeHoldings,
  parseLargeHoldingDescription,
  classifyLargeHolding,
} from "@/lib/edinet";
import { getAdminDb } from "@/lib/firebase-admin";

/**
 * GET /api/edinet/large-holdings/[ticker]?days=30
 *
 * EDINET から該当銘柄の直近大量保有報告書を取得 (Firestore キャッシュ 24時間)。
 *
 * 出力:
 *   {
 *     ticker, filings: [{ submitDateTime, filerName, docTypeCode, ... }],
 *     summary: { totalFilings, newFilers, increasing, decreasing }
 *   }
 */

const CACHE_HOURS = 24;
const DEFAULT_DAYS = 30;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params;
  const days = Number(req.nextUrl.searchParams.get("days") ?? DEFAULT_DAYS);

  if (!/^\d{4}$/.test(ticker)) {
    return NextResponse.json(
      { ok: false, error: "EDINET は日本株 (4桁ティッカー) のみ対応" },
      { status: 400 }
    );
  }

  // キャッシュ確認
  const db = getAdminDb();
  const cacheKey = `edinet_holdings_${ticker}_${days}d`;
  try {
    const snap = await db.collection("meta").doc(cacheKey).get();
    if (snap.exists) {
      const data = snap.data();
      const ts = data?.computedAt?.toDate?.()?.getTime?.() ?? 0;
      if (Date.now() - ts < CACHE_HOURS * 3600 * 1000) {
        return NextResponse.json({
          ok: true,
          cached: true,
          ...data,
        });
      }
    }
  } catch {}

  // EDINET API 叩く
  try {
    const filings = await fetchRecentLargeHoldings(ticker, days);

    // 提出者ごとに集計 (同じ filer の最新だけ表示)
    const byFiler = new Map<string, typeof filings>();
    for (const f of filings) {
      const key = f.filerName ?? "Unknown";
      if (!byFiler.has(key)) byFiler.set(key, []);
      byFiler.get(key)!.push(f);
    }

    // 整形した出力
    const filers = Array.from(byFiler.entries()).map(([filerName, docs]) => {
      docs.sort((a, b) => (b.submitDateTime ?? "").localeCompare(a.submitDateTime ?? ""));
      const latest = docs[0];
      const dir = parseLargeHoldingDescription(latest.docDescription);
      return {
        filerName,
        edinetCode: latest.edinetCode,
        docCount: docs.length,
        latestSubmitDateTime: latest.submitDateTime,
        latestDocDescription: latest.docDescription,
        latestType: classifyLargeHolding(latest),
        isIncrease: dir.isIncrease,
        isReduce: dir.isReduce,
        latestDocID: latest.docID,
      };
    });

    // 提出日時降順
    filers.sort((a, b) =>
      (b.latestSubmitDateTime ?? "").localeCompare(a.latestSubmitDateTime ?? "")
    );

    const summary = {
      totalFilings: filings.length,
      uniqueFilers: filers.length,
      newFilers: filers.filter((f) => f.latestType === "initial").length,
      changes: filers.filter((f) => f.latestType === "change").length,
      increasing: filers.filter((f) => f.isIncrease && !f.isReduce).length,
      decreasing: filers.filter((f) => f.isReduce && !f.isIncrease).length,
    };

    const result = {
      ticker,
      days,
      filings,
      filers,
      summary,
      computedAt: new Date().toISOString(),
    };

    // Firestore に保存
    try {
      const { FieldValue } = await import("firebase-admin/firestore");
      await db.collection("meta").doc(cacheKey).set({
        ...result,
        computedAt: FieldValue.serverTimestamp(),
        computedAtIso: result.computedAt,
      });
    } catch (err) {
      console.error("EDINET cache save failed:", err);
    }

    return NextResponse.json({ ok: true, cached: false, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
