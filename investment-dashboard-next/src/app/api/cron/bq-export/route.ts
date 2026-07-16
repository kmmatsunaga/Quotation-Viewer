import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { BigQuery } from "@google-cloud/bigquery";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * GET /api/cron/bq-export
 *
 * Firestore の日次履歴を BigQuery (booking-data-388605.cavka) にアーカイブ。
 * Firestore = ホット層 (アプリ配信) / BQ = コールド層 (バックテスト・SQL分析)。
 *
 * 各ソースの最新ドキュメントを、その日付パーティションに WRITE_TRUNCATE で
 * ロード = 同日再実行しても二重登録なし (冪等)。
 *
 * ?date=YYYYMMDD 指定でその日付のドキュメントを明示的にエクスポート (バックフィル用)。
 *
 * 実行: 毎日 UTC 18:00 (JST 03:00、verdict-track 完了後)。
 */

const CRON_SECRET = process.env.CRON_SECRET;
export const maxDuration = 120;

const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";

function jstDateKey(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
}
const toDateStr = (key: string) => `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;

function getBq(): BigQuery {
  const raw = process.env.BQ_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("BQ_SERVICE_ACCOUNT_JSON is not set");
  const credentials = JSON.parse(raw);
  return new BigQuery({ projectId: BQ_PROJECT, credentials });
}

/** rows を NDJSON にして日付パーティションへ WRITE_TRUNCATE ロード */
async function loadPartition(bq: BigQuery, table: string, dateKey: string, rows: Record<string, unknown>[]): Promise<number> {
  if (rows.length === 0) return 0;
  const tmp = join(tmpdir(), `bq_${table}_${dateKey}_${Date.now()}.ndjson`);
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n"), "utf8");
  try {
    const [job] = await bq
      .dataset(BQ_DATASET)
      .table(`${table}$${dateKey}`)
      .load(tmp, {
        sourceFormat: "NEWLINE_DELIMITED_JSON",
        writeDisposition: "WRITE_TRUNCATE",
      });
    const errs = job.status?.errors;
    if (errs && errs.length > 0) throw new Error(`${table}: ${JSON.stringify(errs.slice(0, 2))}`);
    return rows.length;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

/** 指定 prefix の最新 (または指定日) ドキュメントを探す */
async function findDoc(
  db: FirebaseFirestore.Firestore,
  prefix: string,
  explicitKey: string | null,
  maxBack = 5
): Promise<{ key: string; data: FirebaseFirestore.DocumentData } | null> {
  if (explicitKey) {
    const snap = await db.collection("meta").doc(`${prefix}${explicitKey}`).get();
    return snap.exists ? { key: explicitKey, data: snap.data() ?? {} } : null;
  }
  for (let i = 0; i <= maxBack; i++) {
    const key = jstDateKey(new Date(Date.now() - i * 24 * 3600 * 1000));
    const snap = await db.collection("meta").doc(`${prefix}${key}`).get();
    if (snap.exists) return { key, data: snap.data() ?? {} };
  }
  return null;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const explicit = req.nextUrl.searchParams.get("date");
  const explicitKey = explicit && /^\d{8}$/.test(explicit) ? explicit : null;

  const db = getAdminDb();
  const startedAt = Date.now();
  const results: Record<string, number | string> = {};

  let bq: BigQuery;
  try {
    bq = getBq();
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  // 1. score_rankings
  try {
    const doc = await findDoc(db, "score_rankings_", explicitKey);
    if (doc) {
      const date = toDateStr(doc.key);
      const rows = ((doc.data.entries ?? []) as Record<string, unknown>[]).map((e) => ({
        date, ticker: e.ticker, name: e.name ?? null, market: e.market ?? null,
        price: e.price ?? null, short: e.short ?? null, mid: e.mid ?? null,
        long: e.long ?? null, overall: e.overall ?? null,
      }));
      results.score_rankings = await loadPartition(bq, "score_rankings_daily", doc.key, rows);
    } else results.score_rankings = "no doc";
  } catch (err) { results.score_rankings = `error: ${err instanceof Error ? err.message : String(err)}`; }

  // 2. verdict_history
  try {
    const doc = await findDoc(db, "verdict_history_", explicitKey);
    if (doc) {
      const date = toDateStr(doc.key);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = ((doc.data.entries ?? []) as any[]).map((e) => ({
        date, ticker: e.ticker, price: e.price ?? null,
        short_stance: e.short?.stance ?? null, short_direction: e.short?.direction ?? null, short_conviction: e.short?.conviction ?? null,
        mid_stance: e.mid?.stance ?? null, mid_direction: e.mid?.direction ?? null, mid_conviction: e.mid?.conviction ?? null,
        long_stance: e.long?.stance ?? null, long_direction: e.long?.direction ?? null, long_conviction: e.long?.conviction ?? null,
      }));
      results.verdict_history = await loadPartition(bq, "verdict_history_daily", doc.key, rows);
    } else results.verdict_history = "no doc";
  } catch (err) { results.verdict_history = `error: ${err instanceof Error ? err.message : String(err)}`; }

  // 3. verdict_evals
  try {
    const doc = await findDoc(db, "verdict_eval_", explicitKey);
    if (doc) {
      const date = toDateStr(doc.key);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = ((doc.data.verdictEvals ?? []) as any[]).map((e) => ({
        date, tf: e.tf, ticker: e.ticker,
        past_date: e.pastDate ? toDateStr(e.pastDate) : null,
        stance: e.stance ?? null, conviction: e.conviction ?? null,
        ret: e.ret ?? null, hit: e.hit ?? null,
      }));
      results.verdict_evals = await loadPartition(bq, "verdict_evals_daily", doc.key, rows);
    } else results.verdict_evals = "no doc";
  } catch (err) { results.verdict_evals = `error: ${err instanceof Error ? err.message : String(err)}`; }

  // 4. macro (スナップショット全体を JSON で保存)
  try {
    const doc = await findDoc(db, "macro_fred_watch_history_", explicitKey);
    if (doc) {
      const date = toDateStr(doc.key);
      // Firestore Timestamp などを除去して plain JSON 化
      const payload = JSON.parse(JSON.stringify(doc.data, (k, v) => (k === "cachedAt" || k === "savedAtIso" ? undefined : v)));
      results.macro = await loadPartition(bq, "macro_daily", doc.key, [{ date, payload: JSON.stringify(payload) }]);
    } else results.macro = "no doc";
  } catch (err) { results.macro = `error: ${err instanceof Error ? err.message : String(err)}`; }

  return NextResponse.json({
    ok: true,
    dateRequested: explicitKey ?? "latest",
    results,
    elapsedMs: Date.now() - startedAt,
  });
}
