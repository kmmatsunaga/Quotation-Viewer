import { NextRequest, NextResponse } from "next/server";
import { BigQuery } from "@google-cloud/bigquery";
import { Readable } from "stream";
import { getCronOrigin } from "@/lib/cron-origin";
import { resolveUidByEmail, collectUserTickers } from "@/lib/firebase-admin";

/**
 * GET /api/cron/why-snapshot — 🔬 「なぜ動いたか」の毎日蓄積 (Phase 2 の材料)
 *
 * 保有・お気に入り + スコア急変銘柄について、当日の値動きを3層分解 (why?light=1) し、
 * cavka.why_daily に保存する。毎日貯めることで「個別要因が大きく動いた日 + その時の証拠」
 * のデータセットが育ち、Phase 2 (イベント効果測定) の入力になる。
 *
 * Gemini は呼ばない (light モード) のでコストは Yahoo 取得のみ。
 * 実行: 平日 JST 16:30 目標 (引け後)。?dry=1 は保存なし。
 */

const CRON_SECRET = process.env.CRON_SECRET;
const FALLBACK_EMAIL = "make.some.noise6984@gmail.com";
const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function getBq(): BigQuery {
  const raw = process.env.BQ_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("BQ_SERVICE_ACCOUNT_JSON is not set");
  return new BigQuery({ projectId: BQ_PROJECT, credentials: JSON.parse(raw) });
}

function jstDateKey(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
}

export async function GET(req: NextRequest) {
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const authHeader = req.headers.get("authorization");
  if (!dry && CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const origin = getCronOrigin(req);

  // ── 対象ユニバース: 保有 + お気に入り + スコア急変 ──
  const tickers = new Set<string>();
  try {
    const uid = await resolveUidByEmail(FALLBACK_EMAIL);
    if (uid) for (const t of await collectUserTickers(uid)) tickers.add(t);
  } catch {}
  try {
    const res = await fetch(`${origin}/api/briefing`, { signal: AbortSignal.timeout(20_000) });
    if (res.ok) {
      const j = await res.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const m of [...(j.movers?.up ?? []), ...(j.movers?.down ?? [])] as any[]) {
        if (/^\d{3,4}[A-Z0-9]?$/.test(m.ticker)) tickers.add(m.ticker);
      }
    }
  } catch {}

  const list = Array.from(tickers).slice(0, 40);
  if (list.length === 0) return NextResponse.json({ ok: true, note: "対象銘柄なし" });

  // ── 各銘柄の分解を light モードで取得 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = [];
  let date = jstDateKey(new Date());
  const CONC = 6;
  for (let i = 0; i < list.length; i += CONC) {
    const batch = list.slice(i, i + CONC);
    const results = await Promise.all(batch.map(async (t) => {
      try {
        const r = await fetch(`${origin}/api/stocks/why?ticker=${t}&light=1`, { signal: AbortSignal.timeout(25_000) });
        if (!r.ok) return null;
        return await r.json();
      } catch { return null; }
    }));
    for (const d of results) {
      if (!d?.ok) continue;
      date = d.date ?? date;
      rows.push({
        date: d.date,
        ticker: d.ticker,
        today_ret_pct: d.todayRetPct,
        market_part: d.breakdown?.market ?? null,
        sector_part: d.breakdown?.sector ?? null,
        individual_part: d.breakdown?.individual ?? null,
        dominant: d.dominant,
        beta: d.beta ?? null,
        volume_ratio: d.volumeRatio ?? null,
        sector: d.sector ?? null,
        evidence_kinds: (d.evidenceDetail ?? []).map((e: { kind: string }) => e.kind),
        event_types: d.eventTypes ?? [],   // 開示イベント種別 (上方修正/自社株買い等) — Phase 2 の材料
        evidence_count: (d.evidenceDetail ?? []).length,
        created_at: new Date().toISOString(),
      });
    }
  }

  if (rows.length === 0) return NextResponse.json({ ok: true, date, saved: 0, note: "分解できた銘柄なし" });

  if (!dry) {
    const bq = getBq();
    const partition = date.replace(/-/g, "");
    await new Promise<void>((resolve, reject) => {
      const ws = bq.dataset(BQ_DATASET).table(`why_daily$${partition}`).createWriteStream({
        sourceFormat: "NEWLINE_DELIMITED_JSON",
        writeDisposition: "WRITE_TRUNCATE",
        createDisposition: "CREATE_IF_NEEDED",
        timePartitioning: { type: "DAY", field: "date" },
        schema: {
          fields: [
            { name: "date", type: "DATE" },
            { name: "ticker", type: "STRING" },
            { name: "today_ret_pct", type: "FLOAT" },
            { name: "market_part", type: "FLOAT" },
            { name: "sector_part", type: "FLOAT" },
            { name: "individual_part", type: "FLOAT" },
            { name: "dominant", type: "STRING" },
            { name: "beta", type: "FLOAT" },
            { name: "volume_ratio", type: "FLOAT" },
            { name: "sector", type: "STRING" },
            { name: "evidence_kinds", type: "STRING", mode: "REPEATED" },
            { name: "event_types", type: "STRING", mode: "REPEATED" },
            { name: "evidence_count", type: "INTEGER" },
            { name: "created_at", type: "TIMESTAMP" },
          ],
        },
      });
      ws.on("complete", () => resolve());
      ws.on("error", reject);
      Readable.from([rows.map((r) => JSON.stringify(r)).join("\n")]).pipe(ws);
    });
  }

  return NextResponse.json({ ok: true, date, saved: rows.length, tickers: list.length, dry });
}
