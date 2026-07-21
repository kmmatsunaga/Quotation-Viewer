/**
 * 場中法則の探索 — warroom_ticks (Cavka独自の板圧・成行データ) から
 * 「場中のこの状態は、その後どう動くか」を反証可能に集計する純関数。
 *
 * 罠は答え合わせループと同じ: 同じ日の複数銘柄は独立でない (同じ地合いを共有)。
 * → バケットごとに「日ごとの平均」を出してから日次系列で t 検定。
 *   サンプル数は「銘柄数」でなく「営業日数」で読む。
 *
 * 2週間程度ではまだ何も断定できない。ready フラグで正直に出し分ける。
 * これは法則の「探索」であって確定した法則ではない。投資助言でもない。
 */

export interface ObsRow {
  date: string;      // YYYY-MM-DD (JST)
  ticker: string;
  value: number | null;   // 観測した信号値 (板圧など)
  fwdRet: number | null;  // その後のリターン% (引けまで等)
}

export interface Bucket {
  label: string;
  /** value がこの範囲 [lo, hi) に入る (lo=null は -∞, hi=null は +∞) */
  lo: number | null;
  hi: number | null;
}

export interface BucketStat {
  label: string;
  nObs: number;        // 観測数 (銘柄×日)
  nDays: number;       // 出現した営業日数 (真のサンプル数)
  meanRet: number | null;   // 全観測の平均リターン (参考)
  dayMeanRet: number | null; // 日ごと平均のさらに平均 (クラスタ補正済み)
  upRate: number | null;    // 上昇割合 %
  t: number | null;         // 日次系列の t 値 (平均=0 の検定)
}

export interface LawResult {
  signal: string;         // 例: "板圧 (10時頃) → 引けまで"
  note: string;           // 読み方の注記
  buckets: BucketStat[];
  totalDays: number;      // この法則が観測できた営業日数
  ready: boolean;         // 判定に足るサンプルがあるか
}

const MIN_DAYS_READY = 20; // これ未満は「まだ探索中」

function tStat(xs: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const m = xs.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1));
  if (!(sd > 0)) return null;
  return m / (sd / Math.sqrt(n));
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const r2 = (v: number) => Math.round(v * 100) / 100;

function inBucket(v: number, b: Bucket): boolean {
  if (b.lo != null && v < b.lo) return false;
  if (b.hi != null && v >= b.hi) return false;
  return true;
}

/** 観測行 × バケット定義 → 日クラスタ補正した統計 */
export function analyzeLaw(
  signal: string,
  note: string,
  rows: ObsRow[],
  buckets: Bucket[],
): LawResult {
  const valid = rows.filter((r) => r.value != null && r.fwdRet != null);
  const allDays = new Set(valid.map((r) => r.date));

  const bucketStats: BucketStat[] = buckets.map((b) => {
    const inb = valid.filter((r) => inBucket(r.value as number, b));
    const rets = inb.map((r) => r.fwdRet as number);

    // 日ごとの平均リターン (クラスタ補正の核)
    const byDay = new Map<string, number[]>();
    for (const r of inb) {
      const arr = byDay.get(r.date) ?? [];
      arr.push(r.fwdRet as number);
      byDay.set(r.date, arr);
    }
    const dayMeans = [...byDay.values()].map((a) => a.reduce((s, v) => s + v, 0) / a.length);

    return {
      label: b.label,
      nObs: inb.length,
      nDays: byDay.size,
      meanRet: mean(rets) != null ? r2(mean(rets)!) : null,
      dayMeanRet: mean(dayMeans) != null ? r2(mean(dayMeans)!) : null,
      upRate: rets.length ? Math.round((rets.filter((v) => v > 0).length / rets.length) * 100) : null,
      t: (() => { const t = tStat(dayMeans); return t != null ? r2(t) : null; })(),
    };
  });

  return {
    signal,
    note,
    buckets: bucketStats,
    totalDays: allDays.size,
    ready: allDays.size >= MIN_DAYS_READY,
  };
}

// ── よく使うバケット定義 ──
export const BUCKETS = {
  boardRatio: [
    { label: "厚い買い板 (>2)", lo: 2, hi: null },
    { label: "やや買い (1.2〜2)", lo: 1.2, hi: 2 },
    { label: "拮抗 (0.8〜1.2)", lo: 0.8, hi: 1.2 },
    { label: "売り板優勢 (<0.8)", lo: null, hi: 0.8 },
  ] as Bucket[],
  vwapDev: [
    { label: "VWAP大幅上 (>1%)", lo: 1, hi: null },
    { label: "やや上 (0〜1%)", lo: 0, hi: 1 },
    { label: "やや下 (-1〜0%)", lo: -1, hi: 0 },
    { label: "VWAP大幅下 (<-1%)", lo: null, hi: -1 },
  ] as Bucket[],
  gapPct: [
    { label: "大きなGU (>3%)", lo: 3, hi: null },
    { label: "小GU (0〜3%)", lo: 0, hi: 3 },
    { label: "小GD (-3〜0%)", lo: -3, hi: 0 },
    { label: "大きなGD (<-3%)", lo: null, hi: -3 },
  ] as Bucket[],
  closeImbalance: [
    { label: "引け買い成行優勢 (>1.5)", lo: 1.5, hi: null },
    { label: "やや買い (1〜1.5)", lo: 1, hi: 1.5 },
    { label: "やや売り (0.67〜1)", lo: 0.67, hi: 1 },
    { label: "引け売り成行優勢 (<0.67)", lo: null, hi: 0.67 },
  ] as Bucket[],
};
