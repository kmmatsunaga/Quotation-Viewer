/**
 * パターン工場 Layer 1 — 日次特徴量の計算 (純関数)
 *
 * 銘柄×日の「状況」を数値化して BQ cavka.daily_features に蓄積する。
 * 翌日リターン (答え) は保存しない — 採掘 SQL 側で LEAD() により算出する。
 * これにより「特徴量の記録」と「何を予測するか」を分離できる
 * (寄り→引け、引け→引け、2日後、どれを目的変数にするかは採掘時に選べる)。
 *
 * バックフィル (scripts/daily-features-backfill.mts) と
 * 毎晩の cron (/api/cron/daily-features) の両方から使う。
 */

import { scoreTerrainMetrics } from "./fragile-terrain";

export interface DailyBar {
  date: string;   // YYYY-MM-DD (JST)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DailyFeatureRow {
  date: string;
  ticker: string;
  sector: string | null;
  close: number;
  // ── 当日の値動き ──
  dayChangePct: number | null;    // 終値の前日比%
  gapPct: number | null;          // 寄りの前日終値比% (GU/GD)
  openToClosePct: number;         // 寄り→引け% (陽線/陰線の実体)
  rangePosClose: number | null;   // 引けの日中レンジ内位置 0-1 (1=高値引け)
  rangePct: number | null;        // 日中レンジ幅% (高値-安値)/前日終値
  // ── 出来高・流動性 ──
  volumeRatio: number | null;     // 出来高 / 20日平均
  turnover: number | null;        // 売買代金 (終値×出来高, 円)。執行可能性の判定に使う
  // ── 継続性・位置 ──
  streak: number;                 // 連騰(+)/連落(-) 日数 (当日含む)
  isHigh20: boolean;              // 終値が直近20日高値更新
  isLow20: boolean;
  isHigh60: boolean;
  isLow60: boolean;
  ret5dPct: number | null;        // 5日リターン%
  ret20dPct: number | null;
  // ── テクニカル状態 ──
  rsi14: number | null;
  atrPct14: number | null;        // ATR14 / 終値 % (その銘柄のノイズ幅)
  terrainScore: number | null;    // 脆弱地形スコア 0..100 (どれだけ振られる地面か)
  // ── 相対 (地合い・セクター) — パイプライン後段で埋める ──
  nikkeiChangePct: number | null;
  vsNikkeiPct: number | null;
  sectorChangePct: number | null;
  vsSectorPct: number | null;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const pct = (a: number, b: number): number | null => (b > 0 ? round2(((a - b) / b) * 100) : null);

/** 十分な履歴 (60本) がある日から特徴量行を作る */
export function computeDailyFeatures(
  ticker: string,
  sector: string | null,
  bars: DailyBar[],
  opts?: { onlyLastDay?: boolean },
): DailyFeatureRow[] {
  const WARMUP = 60;
  if (bars.length <= WARMUP) return [];
  const rows: DailyFeatureRow[] = [];
  const start = opts?.onlyLastDay ? bars.length - 1 : WARMUP;

  // RSI 用の平均上昇/下落 (Wilder) を逐次計算
  // start 位置まで先に温める
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= 14; i++) {
    const d = bars[i].close - bars[i - 1].close;
    avgGain += Math.max(0, d) / 14;
    avgLoss += Math.max(0, -d) / 14;
  }
  for (let i = 15; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    avgGain = (avgGain * 13 + Math.max(0, d)) / 14;
    avgLoss = (avgLoss * 13 + Math.max(0, -d)) / 14;
    if (i < start) continue;

    const b = bars[i];
    const prev = bars[i - 1];
    if (!(b.close > 0) || !(prev.close > 0)) continue;

    // 出来高20日平均 (当日除く)
    const vols = bars.slice(i - 20, i).map((x) => x.volume).filter((v) => v > 0);
    const avgVol = vols.length >= 10 ? vols.reduce((s, v) => s + v, 0) / vols.length : null;

    // 連騰/連落 (当日含む)
    let streak = 0;
    for (let j = i; j >= 1; j--) {
      const dd = bars[j].close - bars[j - 1].close;
      if (streak === 0) streak = dd > 0 ? 1 : dd < 0 ? -1 : 0;
      else if (streak > 0 && dd > 0) streak++;
      else if (streak < 0 && dd < 0) streak--;
      else break;
      if (Math.abs(streak) >= 15) break; // 上限
    }

    // 高値/安値更新 (終値ベース、当日除く過去N日と比較)
    const closes20 = bars.slice(i - 20, i).map((x) => x.close);
    const closes60 = bars.slice(i - 60, i).map((x) => x.close);

    // ATR14
    let atrSum = 0;
    for (let j = i - 13; j <= i; j++) {
      const tr = Math.max(
        bars[j].high - bars[j].low,
        Math.abs(bars[j].high - bars[j - 1].close),
        Math.abs(bars[j].low - bars[j - 1].close),
      );
      atrSum += tr;
    }
    const atr = atrSum / 14;

    const range = b.high - b.low;
    const rsiDen = avgGain + avgLoss;

    // ── 脆弱地形スコア (採点は scoreTerrainMetrics に委譲 = 二重実装回避) ──
    // 既存の bars から地形メトリクスを直接計算 (当日を含む直近窓)
    const last20chg: number[] = [];
    for (let j = Math.max(1, i - 19); j <= i; j++) {
      if (bars[j - 1].close > 0) last20chg.push((bars[j].close / bars[j - 1].close - 1) * 100);
    }
    const high60 = closes60.length > 0 ? Math.max(...closes60.map((_, k) => bars[i - 60 + k].high), b.high) : b.high;
    const sma25 = i >= 25 ? bars.slice(i - 24, i + 1).reduce((s, x) => s + x.close, 0) / 25 : null;
    const terrainScore = b.close > 0 && last20chg.length >= 10
      ? scoreTerrainMetrics({
          atrPct: round2((atr / b.close) * 100),
          bigDayRate: last20chg.filter((c) => Math.abs(c) >= 7).length / last20chg.length,
          worstDrop20: Math.min(...last20chg),
          drawdownFromHigh: high60 > 0 ? (b.close / high60 - 1) * 100 : null,
          extensionPct: sma25 && sma25 > 0 ? (b.close / sma25 - 1) * 100 : null,
        }).score
      : null;

    rows.push({
      date: b.date,
      ticker,
      sector,
      close: b.close,
      dayChangePct: pct(b.close, prev.close),
      gapPct: pct(b.open, prev.close),
      openToClosePct: b.open > 0 ? round2(((b.close - b.open) / b.open) * 100) : 0,
      rangePosClose: range > 0 ? Math.round(((b.close - b.low) / range) * 100) / 100 : null,
      rangePct: prev.close > 0 ? round2((range / prev.close) * 100) : null,
      volumeRatio: avgVol && avgVol > 0 ? round2(b.volume / avgVol) : null,
      turnover: b.volume > 0 ? Math.round(b.close * b.volume) : null,
      streak,
      isHigh20: closes20.length > 0 && b.close > Math.max(...closes20),
      isLow20: closes20.length > 0 && b.close < Math.min(...closes20),
      isHigh60: closes60.length > 0 && b.close > Math.max(...closes60),
      isLow60: closes60.length > 0 && b.close < Math.min(...closes60),
      ret5dPct: i >= 5 ? pct(b.close, bars[i - 5].close) : null,
      ret20dPct: i >= 20 ? pct(b.close, bars[i - 20].close) : null,
      rsi14: rsiDen > 0 ? round2((avgGain / rsiDen) * 100) : null,
      atrPct14: b.close > 0 ? round2((atr / b.close) * 100) : null,
      terrainScore,
      nikkeiChangePct: null,
      vsNikkeiPct: null,
      sectorChangePct: null,
      vsSectorPct: null,
    });
  }
  return rows;
}

/**
 * 相対特徴量 (地合い・セクター) を埋める。
 * rows は複数銘柄×複数日でよい。nikkeiByDate は日付→日経騰落%。
 * セクター平均は rows 自身から日付×セクターで算出 (自銘柄を除いた平均)。
 */
export function fillRelativeFeatures(
  rows: DailyFeatureRow[],
  nikkeiByDate: Map<string, number>,
): void {
  // 日付×セクターごとの合計を先に集計
  const agg = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    if (r.sector === null || r.dayChangePct === null) continue;
    const key = `${r.date}|${r.sector}`;
    const a = agg.get(key) ?? { sum: 0, n: 0 };
    a.sum += r.dayChangePct;
    a.n++;
    agg.set(key, a);
  }
  for (const r of rows) {
    const nk = nikkeiByDate.get(r.date);
    if (nk !== undefined && r.dayChangePct !== null) {
      r.nikkeiChangePct = round2(nk);
      r.vsNikkeiPct = round2(r.dayChangePct - nk);
    }
    if (r.sector !== null && r.dayChangePct !== null) {
      const a = agg.get(`${r.date}|${r.sector}`);
      if (a && a.n >= 3) {
        // 自分を除いた平均 (1銘柄セクターの自己参照を防ぐ)
        const avg = (a.sum - r.dayChangePct) / (a.n - 1);
        r.sectorChangePct = round2(avg);
        r.vsSectorPct = round2(r.dayChangePct - avg);
      }
    }
  }
}

/** Yahoo v8 chart レスポンス → DailyBar[] (JST 日付キー) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function yahooChartToBars(json: any): DailyBar[] {
  const r = json?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0];
  if (!ts.length || !q) return [];
  const bars: DailyBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if ([o, h, l, c].some((x) => typeof x !== "number" || !isFinite(x))) continue;
    const jst = new Date(ts[i] * 1000 + 9 * 3600 * 1000);
    const date = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
    bars.push({ date, open: o, high: h, low: l, close: c, volume: typeof v === "number" ? v : 0 });
  }
  return bars;
}
