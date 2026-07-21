import { NextResponse } from "next/server";
import { BigQuery } from "@google-cloud/bigquery";
import { analyzeLaw, BUCKETS, type ObsRow, type LawResult } from "@/lib/intraday-laws";

/**
 * GET /api/intraday-laws — 場中観測 (warroom_ticks) からの法則探索
 *
 * Cavka独自の板圧・成行データを使い「場中のこの状態 → その後どう動くか」を集計。
 * 統計単位は営業日 (日クラスタ補正)。認証不要 (統計のみ)。
 */

const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

function getBq(): BigQuery {
  const raw = process.env.BQ_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("BQ_SERVICE_ACCOUNT_JSON is not set");
  return new BigQuery({ projectId: BQ_PROJECT, credentials: JSON.parse(raw) });
}

const dstr = (v: { value: string } | string | null): string =>
  v == null ? "" : typeof v === "string" ? v : v.value;

/**
 * 各 (date,ticker) について、JST指定時刻に最も近い観測の信号値と、
 * そこから当日引け (最後のtick) までのリターンを返す。
 * obsHourUtc: 観測時刻 (UTC hh:mm)。JST10:00 = "01:00"。
 */
async function obsToClose(
  bq: BigQuery,
  valueCol: string,
  obsHourUtc: string,
): Promise<ObsRow[]> {
  const q = `
    WITH obs AS (
      SELECT date, ticker, ${valueCol} AS v, price,
        ROW_NUMBER() OVER (PARTITION BY date, ticker ORDER BY ABS(TIMESTAMP_DIFF(
          ts, TIMESTAMP(CONCAT(FORMAT_DATE('%Y-%m-%d', date), ' ${obsHourUtc}:00'), 'UTC'), MINUTE))) rn
      FROM \`${BQ_PROJECT}.${BQ_DATASET}.warroom_ticks\`
      WHERE price IS NOT NULL AND ${valueCol} IS NOT NULL
    ),
    cl AS (
      SELECT date, ticker, price AS cp,
        ROW_NUMBER() OVER (PARTITION BY date, ticker ORDER BY ts DESC) rn
      FROM \`${BQ_PROJECT}.${BQ_DATASET}.warroom_ticks\` WHERE price IS NOT NULL
    )
    SELECT o.date, o.ticker, o.v AS value,
           ROUND((c.cp - o.price) / o.price * 100, 3) AS fwd
    FROM obs o JOIN cl c ON o.date = c.date AND o.ticker = c.ticker
    WHERE o.rn = 1 AND c.rn = 1 AND c.cp IS NOT NULL AND o.price > 0
  `;
  const [rows] = await bq.query(q);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (rows as any[]).map((r) => ({
    date: dstr(r.date), ticker: r.ticker,
    value: r.value == null ? null : Number(r.value),
    fwdRet: r.fwd == null ? null : Number(r.fwd),
  }));
}

/** 引けの成行インバランス (15:25頃, JST) → 翌営業日の始値リターン */
async function closeImbalanceToNextOpen(bq: BigQuery): Promise<ObsRow[]> {
  // 相関サブクエリを避け、営業日を ticker ごとに DENSE_RANK して「翌営業日 = k+1」で結合
  const q = `
    WITH imb AS (  -- 引け前板寄せ (成行が板に見える) の観測
      SELECT date, ticker, market_order_ratio AS v, price AS close_price,
        ROW_NUMBER() OVER (PARTITION BY date, ticker ORDER BY ts DESC) rn
      FROM \`${BQ_PROJECT}.${BQ_DATASET}.warroom_ticks\`
      WHERE market_order_ratio IS NOT NULL AND price IS NOT NULL
    ),
    opens AS (  -- 各日の最初の観測 = 寄り近辺 (全営業日)
      SELECT date, ticker, price AS open_price,
        ROW_NUMBER() OVER (PARTITION BY date, ticker ORDER BY ts ASC) rn
      FROM \`${BQ_PROJECT}.${BQ_DATASET}.warroom_ticks\` WHERE price IS NOT NULL
    ),
    open_seq AS (
      SELECT date, ticker, open_price,
        DENSE_RANK() OVER (PARTITION BY ticker ORDER BY date) k
      FROM opens WHERE rn = 1
    ),
    imb1 AS ( SELECT date, ticker, v, close_price FROM imb WHERE rn = 1 AND close_price > 0 )
    SELECT i.date, i.ticker, i.v AS value,
           ROUND((nx.open_price - i.close_price) / i.close_price * 100, 3) AS fwd
    FROM imb1 i
    JOIN open_seq cur ON cur.ticker = i.ticker AND cur.date = i.date
    JOIN open_seq nx  ON nx.ticker = i.ticker AND nx.k = cur.k + 1
  `;
  const [rows] = await bq.query(q);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (rows as any[]).map((r) => ({
    date: dstr(r.date), ticker: r.ticker,
    value: r.value == null ? null : Number(r.value),
    fwdRet: r.fwd == null ? null : Number(r.fwd),
  }));
}

export async function GET() {
  try {
    const bq = getBq();

    // データ範囲
    const [meta] = await bq.query(
      `SELECT MIN(date) mn, MAX(date) mx, COUNT(DISTINCT date) days, COUNT(*) rowcount FROM \`${BQ_PROJECT}.${BQ_DATASET}.warroom_ticks\``
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = (meta as any[])[0] ?? {};

    const [board, vwap, gap, closeImb] = await Promise.all([
      obsToClose(bq, "board_ratio", "01:00"),  // JST10:00
      obsToClose(bq, "vwap_dev", "01:00"),
      obsToClose(bq, "gap_pct", "00:05"),      // 寄り直後
      closeImbalanceToNextOpen(bq),
    ]);

    const laws: LawResult[] = [
      analyzeLaw(
        "板圧 (10時頃) → 引けまで",
        "板圧 = 買い板÷売り板。厚い買い板は「下値の堅さ」に見えるが、落ちている株では逆張り買いの溜まりで、さらに落ちやすい (落ちるナイフ)。",
        board, BUCKETS.boardRatio,
      ),
      analyzeLaw(
        "VWAP乖離 (10時頃) → 引けまで",
        "VWAPより上=日中に買った人が平均で含み益。上/下でその後の引けまでの動きが変わるか。",
        vwap, BUCKETS.vwapDev,
      ),
      analyzeLaw(
        "寄りギャップ → 引けまで",
        "寄りのGU/GDが、その日の引けまでに埋まるか継続するか。",
        gap, BUCKETS.gapPct,
      ),
      analyzeLaw(
        "引け成行インバランス (15:25) → 翌日始値",
        "成行はザラ場では即約定して板に残らず、引けの板寄せでだけ数量が見える = Cavka独自データ。引けの成行の偏りが翌日の寄りを予告するか。",
        closeImb, BUCKETS.closeImbalance,
      ),
    ];

    return NextResponse.json({
      ok: true,
      range: { from: dstr(m.mn), to: dstr(m.mx), days: Number(m.days ?? 0), rows: Number(m.rowcount ?? 0) },
      laws,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
