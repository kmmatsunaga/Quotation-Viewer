import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";

/**
 * GET /api/cron/score-rankings/diag
 *
 * 一時診断: 本番側で cron が entries=0 となる原因を切り分ける。
 *   - 最新 score_rankings_<date> ドキュメントの統計 (processed/errors/elapsedMs)
 *   - host header の中身
 *   - その host で /api/stocks/insights?ticker=7203 を 1件叩いた結果 (status/duration/body 先頭)
 *
 * 認証なし (本番デプロイ後に動作確認したら削除予定)
 */

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const db = getAdminDb();
  const host = req.headers.get("host") ?? "(none)";
  const xfproto = req.headers.get("x-forwarded-proto");
  const proto = host.includes("localhost") ? "http" : "https";
  const origin = `${proto}://${host}`;

  // 1. 最新 ranking ドキュメントの集計値
  let latestStats: Record<string, unknown> = { found: false };
  try {
    const latest = await db.collection("meta").doc("score_rankings_latest").get();
    if (latest.exists) {
      const data = latest.data() ?? {};
      const refDoc = await db.collection("meta").doc(String(data.ref ?? "")).get();
      const refData = refDoc.exists ? refDoc.data() ?? {} : {};
      latestStats = {
        found: true,
        latestDoc: {
          dateKey: data.dateKey,
          ref: data.ref,
          processed: data.processed,
          errors: data.errors,
        },
        refDoc: refDoc.exists
          ? {
              date: refData.date,
              processed: refData.processed,
              errors: refData.errors,
              elapsedMs: refData.elapsedMs,
              universe: refData.universe,
              entriesLength: Array.isArray(refData.entries) ? refData.entries.length : 0,
              sampleEntries: Array.isArray(refData.entries) ? refData.entries.slice(0, 3) : [],
            }
          : { exists: false },
      };
    }
  } catch (err) {
    latestStats = { error: err instanceof Error ? err.message : String(err) };
  }

  // 2. cron と同じ origin で internal fetch を試す
  let internalFetch: Record<string, unknown> = { skipped: false };
  const url = `${origin}/api/stocks/insights?ticker=7203`;
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const tm = setTimeout(() => controller.abort(), 25_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(tm);
    const text = await res.text();
    internalFetch = {
      url,
      status: res.status,
      ok: res.ok,
      durationMs: Date.now() - t0,
      bodyHead: text.slice(0, 300),
      contentType: res.headers.get("content-type"),
    };
  } catch (err) {
    internalFetch = {
      url,
      durationMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return NextResponse.json({
    ok: true,
    host,
    xfproto,
    origin,
    env: {
      VERCEL_URL: process.env.VERCEL_URL ?? null,
      VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL ?? null,
    },
    latestStats,
    internalFetch,
  });
}
