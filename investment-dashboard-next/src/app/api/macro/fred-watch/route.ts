import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import {
  fetchFredSeriesBulk,
  estimateFedPolicyOutlook,
  estimateRecessionOutlook,
  estimateFxOutlook,
  estimateOilOutlook,
  estimateChinaOutlook,
  estimateSemiCycleOutlook,
  estimateBojPolicyOutlook,
  fetchSmhMonthly,
} from "@/lib/fred";

/**
 * GET /api/macro/fred-watch
 *
 * FRB 政策方向 + 景気後退確率 + 為替動向の総合マクロ予兆データ。
 * Firestore キャッシュ 6時間 (FRED の更新頻度は月次〜日次なのでもっと長くてもOKだが安全マージン)。
 *
 * クエリ: fresh=1 で立花的にキャッシュバイパス
 *
 * 認証不要 (公開マクロデータ)
 */

const CACHE_HOURS = 6;
const CACHE_KEY = "macro_fred_watch_latest";

const SERIES_IDS = [
  "FEDFUNDS",     // Fed Funds Rate (月次)
  "CPIAUCSL",     // CPI (季調済)
  "CPILFESL",     // Core CPI
  "UNRATE",       // 失業率
  "T10Y3M",       // 10y - 3m スプレッド
  "T10Y2Y",       // 10y - 2y スプレッド
  "DGS10",        // 10年国債利回り
  "DGS2",         // 2年国債利回り
  "DEXJPUS",      // USD/JPY 為替 (Daily)
  // Phase B
  "DCOILWTICO",   // WTI 原油価格 (Daily)
  "DCOILBRENTEU", // Brent 原油価格 (Daily)
  "PCOPPUSDM",    // 銅価格 (Monthly, 中国需要バロメーター)
  "PIORECRUSDM",  // 鉄鉱石価格 (Monthly, 中国建設バロメーター)
  // Phase C
  "IPG3344S",         // 半導体製造業 生産指数 (Monthly)
  "PCU3344133441",    // 半導体製造業 PPI (Monthly)
  // Phase D - 日本マクロ (BOJ 政策方向)
  "IR3TIB01JPM156N",  // 日本 3M Interbank Rate (BOJ政策金利の代理) (Monthly)
  "JPNCPIALLMINMEI",  // 日本 CPI All Items (Monthly)
  "LRHUTTTTJPM156S",  // 日本 失業率 (Monthly)
  "IRLTLT01JPM156N",  // 日本 10年JGB利回り (Monthly)
];

export async function GET(req: NextRequest) {
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  const startedAt = Date.now();

  // Firestore キャッシュ確認
  const db = getAdminDb();
  if (!fresh) {
    try {
      const snap = await db.collection("meta").doc(CACHE_KEY).get();
      if (snap.exists) {
        const data = snap.data();
        const cachedAt =
          data?.cachedAt?.toDate?.()?.getTime?.() ??
          (data?.cachedAtIso ? new Date(data.cachedAtIso).getTime() : 0);
        const ageH = (Date.now() - cachedAt) / 3600000;
        if (ageH < CACHE_HOURS) {
          return NextResponse.json({
            ok: true,
            cached: true,
            ageHours: Math.round(ageH * 10) / 10,
            ...data,
          });
        }
      }
    } catch {}
  }

  try {
    if (!process.env.FRED_API_KEY) {
      return NextResponse.json(
        { ok: false, error: "FRED_API_KEY is not configured" },
        { status: 500 }
      );
    }

    const bulk = await fetchFredSeriesBulk(SERIES_IDS, 50, 5);

    const fedPolicy = estimateFedPolicyOutlook(
      bulk.FEDFUNDS ?? null,
      bulk.CPIAUCSL ?? null,
      bulk.CPILFESL ?? null,
      bulk.UNRATE ?? null
    );
    const recession = estimateRecessionOutlook(
      bulk.T10Y3M ?? null,
      bulk.T10Y2Y ?? null,
      bulk.UNRATE ?? null
    );
    const fx = estimateFxOutlook(bulk.DEXJPUS ?? null);
    const oil = estimateOilOutlook(bulk.DCOILWTICO ?? null, bulk.DCOILBRENTEU ?? null);
    const china = estimateChinaOutlook(bulk.PCOPPUSDM ?? null, bulk.PIORECRUSDM ?? null);

    // 半導体サイクル: FRED + Yahoo SMH ETF
    const smh = await fetchSmhMonthly();
    const semi = estimateSemiCycleOutlook(bulk.IPG3344S ?? null, bulk.PCU3344133441 ?? null, smh);

    // BOJ 政策方向 (日本マクロ)
    const bojPolicy = estimateBojPolicyOutlook(
      bulk.IR3TIB01JPM156N ?? null,
      bulk.JPNCPIALLMINMEI ?? null,
      bulk.LRHUTTTTJPM156S ?? null,
      bulk.IRLTLT01JPM156N ?? null,
      bulk.DEXJPUS?.latest?.value ?? null
    );

    // 主要指標のスナップショット
    const snapshot = {
      fedFundsRate: bulk.FEDFUNDS?.latest ?? null,
      cpi: bulk.CPIAUCSL?.latest ?? null,
      coreCpi: bulk.CPILFESL?.latest ?? null,
      unemployment: bulk.UNRATE?.latest ?? null,
      yieldCurveT10Y3M: bulk.T10Y3M?.latest ?? null,
      yieldCurveT10Y2Y: bulk.T10Y2Y?.latest ?? null,
      dgs10: bulk.DGS10?.latest ?? null,
      dgs2: bulk.DGS2?.latest ?? null,
      usdJpy: bulk.DEXJPUS?.latest ?? null,
      wti: bulk.DCOILWTICO?.latest ?? null,
      brent: bulk.DCOILBRENTEU?.latest ?? null,
      copper: bulk.PCOPPUSDM?.latest ?? null,
      ironOre: bulk.PIORECRUSDM?.latest ?? null,
      semiProduction: bulk.IPG3344S?.latest ?? null,
      semiPPI: bulk.PCU3344133441?.latest ?? null,
      jpCallRate: bulk.IR3TIB01JPM156N?.latest ?? null,
      jpCpi: bulk.JPNCPIALLMINMEI?.latest ?? null,
      jpUnemployment: bulk.LRHUTTTTJPM156S?.latest ?? null,
      jpJgb10y: bulk.IRLTLT01JPM156N?.latest ?? null,
    };

    const result = {
      snapshot,
      fedPolicy,
      recession,
      fx,
      oil,
      china,
      semi,
      bojPolicy,
      computedAtIso: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
    };

    // Firestore に保存
    try {
      const { FieldValue } = await import("firebase-admin/firestore");
      await db.collection("meta").doc(CACHE_KEY).set({
        ...result,
        cachedAt: FieldValue.serverTimestamp(),
        cachedAtIso: new Date().toISOString(),
      });
    } catch (err) {
      console.error("fred-watch cache save failed:", err);
    }

    return NextResponse.json({ ok: true, cached: false, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
