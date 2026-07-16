import { NextRequest, NextResponse } from "next/server";
import { BigQuery } from "@google-cloud/bigquery";
import { Readable } from "stream";

/**
 * GET /api/cron/pattern-incubate — パターン工場 Layer 3: 学習ループ (インキュベーション)
 *
 * 毎晩、発見済みパターンの「発見日以降 (= out-of-sample)」のライブ実績を測り、
 * 昇格 / 退場を自動判定する。これがブラックボックスにしない肝:
 *   - 過去2年で見つけた型が、発見後の未知データでも効くか？を継続監視
 *   - まぐれで見つかった型はライブで崩れ → 自動退場
 *   - 本物はライブでも edge が残り → 昇格
 *
 * 手順:
 *   1. daily_features_labeled を最新日で作り直す (翌日リターン付き)
 *   2. 各パターンの date >= discovered_date のライブ成績を一括集計
 *   3. status 遷移: incubating → promoted / retired
 *   4. pattern_candidates を全置換で更新 (冪等)
 *
 * 遷移ルール (dir 方向に符号を揃えた実効 edge で判定):
 *   live_n < 10          → incubating (まだ早い)
 *   effLive >= 0.35×effIn → promoted   (発見時エッジの1/3以上が生存)
 *   effLive < 0          → retired     (エッジが反転 = 幻だった)
 *   その他               → incubating
 *   promoted でも後に effLive<0 に落ちれば retired (継続監視)
 *
 * 実行: 毎平日 JST 18:00 目標 (daily-features の後)。?dry=1 は保存なし。
 */

const CRON_SECRET = process.env.CRON_SECRET;
const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
const SRC = `\`${BQ_PROJECT}.${BQ_DATASET}.daily_features_labeled\``;
const CAND = `\`${BQ_PROJECT}.${BQ_DATASET}.pattern_candidates\``;
export const maxDuration = 120;
export const dynamic = "force-dynamic";

function getBq(): BigQuery {
  const raw = process.env.BQ_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("BQ_SERVICE_ACCOUNT_JSON is not set");
  return new BigQuery({ projectId: BQ_PROJECT, credentials: JSON.parse(raw) });
}

interface Candidate {
  pattern_id: string;
  predicates: string[];
  labels: string[];
  sql_where: string;
  direction: "long" | "short";
  target: string;
  n: number; win_pct: number; avg_ret: number; med_ret: number;
  win_first: number; win_second: number; edge: number; z_score: number;
  baseline_pct: number;
  status: string;
  discovered_date: { value: string } | string;
  live_n: number | null; live_win_pct: number | null; live_avg_ret: number | null;
  last_fired_date: { value: string } | string | null;
  discovered_at: { value: string } | string;
  updated_at: { value: string } | string;
}

const dateStr = (v: { value: string } | string | null): string | null =>
  v === null ? null : typeof v === "string" ? v : v.value;

export async function GET(req: NextRequest) {
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const authHeader = req.headers.get("authorization");
  if (!dry && CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const bq = getBq();
  const startedAt = Date.now();

  // ── 1. ラベル付きテーブルを最新日で再構築 ──
  await bq.query({
    query: `CREATE OR REPLACE TABLE ${SRC.replace(/`/g, "")} AS
      SELECT *, LEAD(openToClosePct) OVER w AS nextO2C, LEAD(gapPct) OVER w AS nextGap,
        LEAD(close) OVER w / NULLIF(close,0) * 100 - 100 AS nextC2C,
        -- 中長期の目的変数 (5/20/60営業日先の終値リターン%)
        LEAD(close, 5) OVER w / NULLIF(close,0) * 100 - 100 AS fwd5dPct,
        LEAD(close, 20) OVER w / NULLIF(close,0) * 100 - 100 AS fwd20dPct,
        LEAD(close, 60) OVER w / NULLIF(close,0) * 100 - 100 AS fwd60dPct
      FROM \`${BQ_PROJECT}.${BQ_DATASET}.daily_features\`
      WINDOW w AS (PARTITION BY ticker ORDER BY date)`,
  });

  // ベースライン
  const [[base]] = await bq.query({
    query: `SELECT ROUND(COUNTIF(nextO2C>0)/COUNT(*)*100,2) AS b FROM ${SRC} WHERE nextO2C IS NOT NULL`,
  });
  const baseline = base.b as number;

  // ── 2. 候補を読み、ライブ成績を一括集計 ──
  const [candRows] = await bq.query({ query: `SELECT * FROM ${CAND}` });
  const candidates = candRows as Candidate[];
  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, note: "候補なし (mine-patterns 未実行)" });
  }

  const subq = candidates.map((c, i) => {
    const disc = dateStr(c.discovered_date);
    return `SELECT ${i} AS idx,
      COUNT(*) AS live_n, COUNTIF(nextO2C>0) AS live_w,
      COUNT(DISTINCT date) AS live_days,
      ROUND(AVG(nextO2C),3) AS live_avg, MAX(date) AS last_fired
    FROM ${SRC}
    WHERE nextO2C IS NOT NULL AND date >= DATE '${disc}' AND ${c.sql_where}`;
  });

  const live = new Map<number, { live_n: number; live_w: number; live_days: number; live_avg: number | null; last_fired: { value: string } | null }>();
  const BATCH = 100;
  for (let i = 0; i < subq.length; i += BATCH) {
    const [rows] = await bq.query({ query: subq.slice(i, i + BATCH).join("\nUNION ALL\n") });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of rows as any[]) live.set(r.idx, r);
  }

  // ── 3. status 遷移 ──
  let promoted = 0, retired = 0, incubating = 0;
  const nowIso = new Date().toISOString();
  const updated = candidates.map((c, i) => {
    const lv = live.get(i);
    const liveN = lv?.live_n ?? 0;
    const liveWin = liveN > 0 ? Math.round((lv!.live_w / liveN) * 1000) / 10 : null;
    const effIn = Math.abs(c.edge); // 発見時エッジの大きさ (pp)
    const effLive =
      liveWin === null ? null : c.direction === "long" ? liveWin - baseline : baseline - liveWin;

    // 昇格/退場は「ライブが複数の異なる営業日にまたがって」初めて有効。
    // 1日で多数の銘柄にマッチしても、それは1日の相場の気分にすぎない (time-forward 検証にならない)。
    const liveDays = lv?.live_days ?? 0;
    const MIN_LIVE_DAYS = 5;
    let status = "incubating";
    if (liveN >= 10 && liveDays >= MIN_LIVE_DAYS && effLive !== null) {
      if (effLive < 0) status = "retired";
      else if (effLive >= 0.35 * effIn) status = "promoted";
      else status = "incubating";
    }
    if (status === "promoted") promoted++;
    else if (status === "retired") retired++;
    else incubating++;

    return {
      pattern_id: c.pattern_id,
      predicates: c.predicates,
      labels: c.labels,
      sql_where: c.sql_where,
      direction: c.direction,
      target: c.target,
      n: c.n, win_pct: c.win_pct, avg_ret: c.avg_ret, med_ret: c.med_ret,
      win_first: c.win_first, win_second: c.win_second, edge: c.edge, z_score: c.z_score,
      baseline_pct: c.baseline_pct,
      status,
      discovered_date: dateStr(c.discovered_date),
      live_n: liveN,
      live_days: liveDays,
      live_win_pct: liveWin,
      live_avg_ret: lv?.live_avg ?? null,
      last_fired_date: lv?.last_fired ? lv.last_fired.value : null,
      discovered_at: dateStr(c.discovered_at),
      updated_at: nowIso,
    };
  });

  // ── 4. 全置換で更新 ──
  if (!dry) {
    await new Promise<void>((resolve, reject) => {
      const ws = bq.dataset(BQ_DATASET).table("pattern_candidates").createWriteStream({
        sourceFormat: "NEWLINE_DELIMITED_JSON",
        writeDisposition: "WRITE_TRUNCATE",
        schema: {
          fields: [
            { name: "pattern_id", type: "STRING" },
            { name: "predicates", type: "STRING", mode: "REPEATED" },
            { name: "labels", type: "STRING", mode: "REPEATED" },
            { name: "sql_where", type: "STRING" },
            { name: "direction", type: "STRING" },
            { name: "target", type: "STRING" },
            { name: "n", type: "INTEGER" },
            { name: "win_pct", type: "FLOAT" },
            { name: "avg_ret", type: "FLOAT" },
            { name: "med_ret", type: "FLOAT" },
            { name: "win_first", type: "FLOAT" },
            { name: "win_second", type: "FLOAT" },
            { name: "edge", type: "FLOAT" },
            { name: "z_score", type: "FLOAT" },
            { name: "baseline_pct", type: "FLOAT" },
            { name: "status", type: "STRING" },
            { name: "discovered_date", type: "DATE" },
            { name: "live_n", type: "INTEGER" },
            { name: "live_days", type: "INTEGER" },
            { name: "live_win_pct", type: "FLOAT" },
            { name: "live_avg_ret", type: "FLOAT" },
            { name: "last_fired_date", type: "DATE" },
            { name: "discovered_at", type: "TIMESTAMP" },
            { name: "updated_at", type: "TIMESTAMP" },
          ],
        },
      });
      ws.on("complete", () => resolve());
      ws.on("error", reject);
      Readable.from([updated.map((r) => JSON.stringify(r)).join("\n")]).pipe(ws);
    });
  }

  // ── 中長期パターン (pattern_candidates_mid) も同様にライブ検証 ──
  // 目的変数は行ごとの target 列 (fwd5dPct 等)。リターン確定に horizon 日かかるため、
  // ライブ実績が出るのはデイトレ版より遅い (5日型で発火+5営業日後から)。
  const midSummary = { total: 0, promoted: 0, incubating: 0, retired: 0 };
  try {
    const MID = `\`${BQ_PROJECT}.${BQ_DATASET}.pattern_candidates_mid\``;
    const [midRows] = await bq.query({ query: `SELECT * FROM ${MID}` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mids = midRows as any[];
    midSummary.total = mids.length;
    if (mids.length > 0) {
      // target ごとのベースライン
      const targets = Array.from(new Set(mids.map((m) => m.target as string)));
      const baseByTarget = new Map<string, number>();
      for (const t of targets) {
        const [[b]] = await bq.query({
          query: `SELECT ROUND(COUNTIF(${t}>0)/COUNT(*)*100,2) AS w FROM ${SRC} WHERE ${t} IS NOT NULL`,
        });
        baseByTarget.set(t, b.w as number);
      }
      const midSubq = mids.map((m, i) => {
        const disc = dateStr(m.discovered_date);
        return `SELECT ${i} AS idx, COUNT(*) AS live_n, COUNTIF(${m.target}>0) AS live_w,
          COUNT(DISTINCT date) AS live_days, ROUND(AVG(${m.target}),3) AS live_avg, MAX(date) AS last_fired
        FROM ${SRC} WHERE ${m.target} IS NOT NULL AND date >= DATE '${disc}' AND ${m.sql_where}`;
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const midLive = new Map<number, any>();
      for (let i = 0; i < midSubq.length; i += 100) {
        const [rows] = await bq.query({ query: midSubq.slice(i, i + 100).join("\nUNION ALL\n") });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const r of rows as any[]) midLive.set(r.idx, r);
      }
      const nowIso2 = new Date().toISOString();
      const midUpdated = mids.map((m, i) => {
        const lv = midLive.get(i);
        const liveN = lv?.live_n ?? 0;
        const liveDays = lv?.live_days ?? 0;
        const liveWin = liveN > 0 ? Math.round((lv.live_w / liveN) * 1000) / 10 : null;
        const midBase = baseByTarget.get(m.target) ?? 50;
        const effIn = Math.abs(m.edge);
        const effLive = liveWin === null ? null : m.direction === "long" ? liveWin - midBase : midBase - liveWin;
        // 中長期は重複があるので「実効発火 = live_n/horizon」でも最低限を要求
        const h = m.horizon_days ?? 1;
        let status = "incubating";
        if (liveDays >= 5 && liveN / h >= 5 && effLive !== null) {
          if (effLive < 0) status = "retired";
          else if (effLive >= 0.35 * effIn) status = "promoted";
        }
        if (status === "promoted") midSummary.promoted++;
        else if (status === "retired") midSummary.retired++;
        else midSummary.incubating++;
        return {
          ...m,
          discovered_date: dateStr(m.discovered_date),
          last_fired_date: lv?.last_fired ? lv.last_fired.value : null,
          discovered_at: dateStr(m.discovered_at),
          live_n: liveN, live_days: liveDays, live_win_pct: liveWin,
          live_avg_ret: lv?.live_avg ?? null,
          status, updated_at: nowIso2,
        };
      });
      if (!dry) {
        await new Promise<void>((resolve, reject) => {
          const ws = bq.dataset(BQ_DATASET).table("pattern_candidates_mid").createWriteStream({
            sourceFormat: "NEWLINE_DELIMITED_JSON",
            writeDisposition: "WRITE_TRUNCATE",
          });
          ws.on("complete", () => resolve());
          ws.on("error", reject);
          Readable.from([midUpdated.map((r) => JSON.stringify(r)).join("\n")]).pipe(ws);
        });
      }
    }
  } catch {
    // mid テーブル未作成などは無視 (デイトレ版の結果は返す)
  }

  // ── 急騰前兆パターン (pattern_candidates_surge) のライブ検証 ──
  // 目的変数: nextC2C >= +8 (稀少イベント)。サニティフィルタは採掘時と同一条件で適用。
  const surgeSummary = { total: 0, promoted: 0, incubating: 0, retired: 0 };
  try {
    const SURGE_SRC = `(SELECT * FROM ${SRC.replace(/`/g, "")}
      WHERE close >= 50 AND ABS(dayChangePct) <= 30 AND volumeRatio IS NOT NULL AND volumeRatio <= 200
        AND atrPct14 IS NOT NULL AND atrPct14 <= 25 AND nextC2C IS NOT NULL AND ABS(nextC2C) <= 100)`;
    const SURGE_TBL = `\`${BQ_PROJECT}.${BQ_DATASET}.pattern_candidates_surge\``;
    const [sRows] = await bq.query({ query: `SELECT * FROM ${SURGE_TBL}` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const surges = sRows as any[];
    surgeSummary.total = surges.length;
    if (surges.length > 0) {
      // ライブ期間のベース急騰率 (共通)
      const disc0 = dateStr(surges[0].discovered_date);
      const [[sb]] = await bq.query({
        query: `SELECT COUNT(*) n, COUNTIF(nextC2C>=8)/NULLIF(COUNT(*),0) p FROM ${SURGE_SRC} WHERE date >= DATE '${disc0}'`,
      });
      const liveBaseRate = ((sb.p as number) ?? 0) * 100;

      const subq2 = surges.map((m, i) => {
        const disc = dateStr(m.discovered_date);
        return `SELECT ${i} idx, COUNT(*) live_n, COUNTIF(nextC2C>=8) live_s,
          COUNT(DISTINCT date) live_days
        FROM ${SURGE_SRC} WHERE date >= DATE '${disc}' AND ${m.sql_where}`;
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sl = new Map<number, any>();
      for (let i = 0; i < subq2.length; i += 100) {
        const [rows] = await bq.query({ query: subq2.slice(i, i + 100).join("\nUNION ALL\n") });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const r of rows as any[]) sl.set(r.idx, r);
      }
      const nowIso3 = new Date().toISOString();
      const updated2 = surges.map((m, i) => {
        const lv = sl.get(i);
        const liveN = lv?.live_n ?? 0;
        const liveS = lv?.live_s ?? 0;
        const liveDays = lv?.live_days ?? 0;
        const liveRate = liveN > 0 ? Math.round((liveS / liveN) * 10000) / 100 : null;
        // 稀少イベントの昇格: 発火が十分 (n>=200) かつ 5営業日以上 かつ ライブ率がライブベースを上回る
        // 退場: 十分な発火があるのにライブ率がベース以下
        let status = "incubating";
        if (liveDays >= 5 && liveN >= 200 && liveRate !== null) {
          if (liveRate <= liveBaseRate) status = "retired";
          else if (liveRate >= liveBaseRate * 2 && liveS >= 5) status = "promoted";
        }
        if (status === "promoted") surgeSummary.promoted++;
        else if (status === "retired") surgeSummary.retired++;
        else surgeSummary.incubating++;
        return {
          ...m,
          discovered_date: dateStr(m.discovered_date),
          discovered_at: dateStr(m.discovered_at),
          live_n: liveN, live_days: liveDays, live_surges: liveS, live_rate: liveRate,
          status, updated_at: nowIso3,
        };
      });
      if (!dry) {
        await new Promise<void>((resolve, reject) => {
          const ws = bq.dataset(BQ_DATASET).table("pattern_candidates_surge").createWriteStream({
            sourceFormat: "NEWLINE_DELIMITED_JSON",
            writeDisposition: "WRITE_TRUNCATE",
          });
          ws.on("complete", () => resolve());
          ws.on("error", reject);
          Readable.from([updated2.map((r) => JSON.stringify(r)).join("\n")]).pipe(ws);
        });
      }
    }
  } catch {
    // surge テーブル未作成時は無視
  }

  return NextResponse.json({
    ok: true, baseline, total: candidates.length,
    promoted, incubating, retired,
    mid: midSummary,
    surge: surgeSummary,
    dry,
    elapsedMs: Date.now() - startedAt,
  });
}
