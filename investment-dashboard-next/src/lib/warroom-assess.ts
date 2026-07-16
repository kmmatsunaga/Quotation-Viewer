/**
 * 場中評決 (warroom assess) — /api/warroom と /api/cron/warroom-snapshot の共用ロジック。
 *
 * 立花の時価+板から、デイトレ向け派生指標と「場中評決」を計算する:
 *   - boardRatio: 買い板合計 / 売り板合計
 *   - vwapDev / rangePos / gapPct / marketOrderRatio
 *   - ローソク足証人 (形 × 出来高の裏付け)
 *   - 合議 → stance / score
 */

import type { TachibanaMarketQuote } from "./tachibana";

export interface IntradaySignal {
  id: string;
  label: string;
  direction: 1 | 0 | -1;
  detail: string;
  weight: number;
}

export interface WarroomEntry {
  ticker: string;
  price: number | null;
  priceTime: string | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  vwap: number | null;
  volume: number | null;
  turnover: number | null;
  // 派生
  boardRatio: number | null;
  bidTotal: number | null;
  askTotal: number | null;
  vwapDev: number | null;      // %
  rangePos: number | null;     // 0-1
  gapPct: number | null;       // %
  marketOrderRatio: number | null;
  // 評決
  stance: "bull" | "bear" | "neutral" | "contested";
  score: number;               // -100 〜 +100
  signals: IntradaySignal[];
}

/** 平常出来高 (20日平均) を Yahoo から取得。Next の fetch cache で 6時間キャッシュ */
export async function fetchAvgVolume(ticker: string): Promise<number | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}.T?range=1mo&interval=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      next: { revalidate: 21600 },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const vols = ((j.chart?.result?.[0]?.indicators?.quote?.[0]?.volume ?? []) as (number | null)[])
      .filter((v): v is number => v !== null && v > 0);
    if (vols.length < 5) return null;
    const past = vols.slice(0, -1).slice(-20);
    return past.reduce((s, v) => s + v, 0) / past.length;
  } catch {
    return null;
  }
}

/** JST での場中経過率 (0-1)。前場9:00-11:30 + 後場12:30-15:30 = 330分 */
export function sessionProgress(): number {
  const now = new Date();
  const jst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60 * 1000);
  const mins = jst.getHours() * 60 + jst.getMinutes();
  let elapsed = 0;
  elapsed += Math.max(0, Math.min(mins, 11 * 60 + 30) - 9 * 60);
  elapsed += Math.max(0, Math.min(mins, 15 * 60 + 30) - (12 * 60 + 30));
  return Math.max(0.05, Math.min(1, elapsed / 330));
}

/**
 * ローソク足証人 (形成中の日足):
 *   形の判定 + 出来高の裏付けで確信度を増減する。
 *   「形」は需給の状態記述であって予言ではない — 薄商いの派手な足は割り引く。
 */
function candleSignal(q: TachibanaMarketQuote, avgVolume: number | null): IntradaySignal | null {
  const { openPrice: o, highPrice: h, lowPrice: l, currentPrice: c, prevClose, volume } = q;
  if (o === null || h === null || l === null || c === null || prevClose === null || prevClose <= 0) return null;
  const range = h - l;
  if (range <= 0) return null;

  const body = c - o;
  const bodyRatio = Math.abs(body) / range;
  const upperWick = (h - Math.max(o, c)) / range;
  const lowerWick = (Math.min(o, c) - l) / range;
  const rangePct = (range / prevClose) * 100;

  let volNote = "";
  let volFactor = 1;
  if (avgVolume !== null && volume !== null && avgVolume > 0) {
    const pace = volume / sessionProgress() / avgVolume;
    if (pace >= 1.5) { volFactor = 1; volNote = ` × 出来高${pace.toFixed(1)}倍で裏付けあり`; }
    else if (pace >= 0.7) { volFactor = 0.8; volNote = ` (出来高は平常並み)`; }
    else { volFactor = 0.4; volNote = ` ⚠出来高薄(平常の${Math.round(pace * 100)}%)・見せかけの可能性`; }
  }

  if (rangePct < 0.8) return null;

  let label: string | null = null;
  let dir: 1 | 0 | -1 = 0;

  if (bodyRatio >= 0.7 && body > 0 && rangePct >= 1.5) {
    label = "大陽線 (買いが押し切り)"; dir = 1;
  } else if (bodyRatio >= 0.7 && body < 0 && rangePct >= 1.5) {
    label = "大陰線 (売りが押し切り)"; dir = -1;
  } else if (lowerWick >= 0.5 && bodyRatio <= 0.4) {
    label = "長い下ヒゲ (下値で買い支え)"; dir = 1;
  } else if (upperWick >= 0.5 && bodyRatio <= 0.4) {
    label = "長い上ヒゲ (上値で売り圧)"; dir = -1;
  } else if (bodyRatio <= 0.15 && rangePct >= 1.2) {
    label = "コマ/十字 (激しい攻防、拮抗)"; dir = 0;
  }

  if (!label) return null;

  const weight = Math.max(1, Math.round(2 * volFactor));
  return { id: "candle", label: "日足形状", direction: dir, detail: `${label}${volNote}`, weight };
}

export function assess(q: TachibanaMarketQuote, avgVolume: number | null = null): WarroomEntry {
  const signals: IntradaySignal[] = [];

  const bidTotal = q.bids.reduce((s, l) => s + (l.quantity ?? 0), 0) || null;
  const askTotal = q.asks.reduce((s, l) => s + (l.quantity ?? 0), 0) || null;
  const boardRatio = bidTotal !== null && askTotal !== null && askTotal > 0 ? bidTotal / askTotal : null;

  const vwapDev =
    q.currentPrice !== null && q.vwap !== null && q.vwap > 0
      ? (q.currentPrice / q.vwap - 1) * 100
      : null;

  const rangePos =
    q.currentPrice !== null && q.highPrice !== null && q.lowPrice !== null && q.highPrice > q.lowPrice
      ? (q.currentPrice - q.lowPrice) / (q.highPrice - q.lowPrice)
      : null;

  const gapPct =
    q.openPrice !== null && q.prevClose !== null && q.prevClose > 0
      ? (q.openPrice / q.prevClose - 1) * 100
      : null;

  const marketOrderRatio =
    q.marketBidQty !== null && q.marketAskQty !== null && q.marketAskQty > 0
      ? q.marketBidQty / q.marketAskQty
      : null;

  // ── シグナル判定 ──
  if (boardRatio !== null) {
    if (boardRatio >= 1.5) signals.push({ id: "board", label: "板圧", direction: 1, detail: `買い板が売り板の${boardRatio.toFixed(1)}倍`, weight: 3 });
    else if (boardRatio <= 0.67) signals.push({ id: "board", label: "板圧", direction: -1, detail: `売り板が買い板の${(1 / boardRatio).toFixed(1)}倍`, weight: 3 });
    else signals.push({ id: "board", label: "板圧", direction: 0, detail: `拮抗 (${boardRatio.toFixed(2)})`, weight: 3 });
  }

  if (vwapDev !== null) {
    if (vwapDev >= 0.3) signals.push({ id: "vwap", label: "VWAP", direction: 1, detail: `VWAP +${vwapDev.toFixed(2)}% (平均コスト上で推移)`, weight: 3 });
    else if (vwapDev <= -0.3) signals.push({ id: "vwap", label: "VWAP", direction: -1, detail: `VWAP ${vwapDev.toFixed(2)}% (平均コスト割れ)`, weight: 3 });
    else signals.push({ id: "vwap", label: "VWAP", direction: 0, detail: `VWAP付近 (${vwapDev >= 0 ? "+" : ""}${vwapDev.toFixed(2)}%)`, weight: 3 });
  }

  if (rangePos !== null) {
    if (rangePos >= 0.8) signals.push({ id: "range", label: "値位置", direction: 1, detail: `日中高値圏 (${Math.round(rangePos * 100)}%)`, weight: 2 });
    else if (rangePos <= 0.2) signals.push({ id: "range", label: "値位置", direction: -1, detail: `日中安値圏 (${Math.round(rangePos * 100)}%)`, weight: 2 });
    else signals.push({ id: "range", label: "値位置", direction: 0, detail: `レンジ中間 (${Math.round(rangePos * 100)}%)`, weight: 2 });
  }

  if (gapPct !== null && Math.abs(gapPct) >= 1) {
    const dir: 1 | 0 | -1 = gapPct > 0 ? (rangePos !== null && rangePos >= 0.5 ? 1 : 0) : (rangePos !== null && rangePos <= 0.5 ? -1 : 0);
    signals.push({ id: "gap", label: "ギャップ", direction: dir, detail: `寄り${gapPct > 0 ? "GU" : "GD"} ${gapPct > 0 ? "+" : ""}${gapPct.toFixed(1)}%${dir === 1 ? " → 維持 (強)" : dir === -1 ? " → 続落 (弱)" : ""}`, weight: 1 });
  }

  if (marketOrderRatio !== null && (marketOrderRatio >= 2 || marketOrderRatio <= 0.5)) {
    const dir: 1 | -1 = marketOrderRatio >= 2 ? 1 : -1;
    signals.push({ id: "mkt_order", label: "成行", direction: dir, detail: dir === 1 ? `買い成行が売りの${marketOrderRatio.toFixed(1)}倍` : `売り成行が買いの${(1 / marketOrderRatio).toFixed(1)}倍`, weight: 2 });
  }

  const candle = candleSignal(q, avgVolume);
  if (candle) signals.push(candle);

  // ── 合議 ──
  const totalW = signals.reduce((s, x) => s + x.weight, 0);
  const dirSum = signals.reduce((s, x) => s + x.direction * x.weight, 0);
  const score = totalW > 0 ? Math.round((dirSum / totalW) * 100) : 0;

  const strongBull = signals.filter((s) => s.direction === 1 && s.weight >= 2).length;
  const strongBear = signals.filter((s) => s.direction === -1 && s.weight >= 2).length;
  let stance: WarroomEntry["stance"];
  if (strongBull > 0 && strongBear > 0) stance = "contested";
  else if (score >= 30) stance = "bull";
  else if (score <= -30) stance = "bear";
  else stance = "neutral";

  return {
    ticker: q.ticker,
    price: q.currentPrice,
    priceTime: q.priceTime,
    changePct: q.changePct,
    open: q.openPrice,
    high: q.highPrice,
    low: q.lowPrice,
    vwap: q.vwap,
    volume: q.volume,
    turnover: q.turnover,
    boardRatio: boardRatio !== null ? Math.round(boardRatio * 100) / 100 : null,
    bidTotal,
    askTotal,
    vwapDev: vwapDev !== null ? Math.round(vwapDev * 100) / 100 : null,
    rangePos: rangePos !== null ? Math.round(rangePos * 100) / 100 : null,
    gapPct: gapPct !== null ? Math.round(gapPct * 100) / 100 : null,
    marketOrderRatio: marketOrderRatio !== null ? Math.round(marketOrderRatio * 100) / 100 : null,
    stance,
    score,
    signals,
  };
}
