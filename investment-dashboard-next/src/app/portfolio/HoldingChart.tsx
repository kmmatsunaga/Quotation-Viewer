"use client";

import { useState, useEffect, useCallback } from "react";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

const TIMEFRAMES: { id: string; label: string; range: string; interval: string }[] = [
  { id: "1m",  label: "1分",  range: "1d",  interval: "1m" },
  { id: "5m",  label: "5分",  range: "5d",  interval: "5m" },
  { id: "15m", label: "15分", range: "1mo", interval: "15m" },
  { id: "30m", label: "30分", range: "1mo", interval: "30m" },
  { id: "1h",  label: "1時間", range: "3mo", interval: "60m" },
  { id: "1d",  label: "日",  range: "6mo", interval: "1d" },
  { id: "1wk", label: "週",  range: "2y",  interval: "1wk" },
  { id: "1mo", label: "月",  range: "5y",  interval: "1mo" },
];

interface Candle {
  time: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ChartData {
  ticker: string;
  candles: Candle[];
  price: number;
  prevClose: number;
}

export interface LotInfo {
  shares: number;
  avgCost: number;
  purchaseDate?: string;  // YYYY-MM-DD
}

/**
 * 保有銘柄一覧用のインラインチャート。
 * compact モードあり。複数ロット対応。
 */
export default function HoldingChart({
  ticker,
  avgCost,
  lots,
  market,
  height = 200,
  defaultTimeframe = "1d",
  compact = false,
  fixedTimeframe,
}: {
  ticker: string;
  avgCost?: number;
  lots?: LotInfo[];
  market?: string;
  height?: number;
  defaultTimeframe?: string;
  compact?: boolean;
  fixedTimeframe?: string;  // セットされてたらユーザー切替不可
}) {
  const [tf, setTf] = useState(fixedTimeframe ?? defaultTimeframe);

  // fixedTimeframe 変化に追従
  useEffect(() => {
    if (fixedTimeframe) setTf(fixedTimeframe);
  }, [fixedTimeframe]);
  const [data, setData] = useState<ChartData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    const t = TIMEFRAMES.find((x) => x.id === tf);
    if (!t) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/stock/${ticker}?range=${t.range}&interval=${t.interval}`);
      if (!res.ok) {
        // Yahoo Financeのデータ制限。とくに1mは7日まで・米国株などで失敗するケース有
        setError(`データなし (${t.label})`);
        setData(null);
        return;
      }
      const json = await res.json();
      if (!json.candles || json.candles.length === 0) {
        setError(`データなし (${t.label})`);
        setData(null);
        return;
      }
      setData(json);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [ticker, tf]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // コンパクトモード: ヘッダーなし、ラベル簡略
  if (compact) {
    return (
      <div
        className="relative rounded overflow-hidden"
        style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--color-border)" }}
      >
        {loading ? (
          <div className="flex items-center justify-center text-[10px] text-[var(--color-text-secondary)]" style={{ height, ...MONO }}>
            ...
          </div>
        ) : error || !data ? (
          <div className="flex items-center justify-center text-[10px] text-[var(--color-text-secondary)]" style={{ height, ...MONO }}>
            {error ?? "データなし"}
          </div>
        ) : (
          <SVGChart data={data} height={height} avgCost={avgCost} lots={lots} market={market} compact />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* タイムフレーム切替 */}
      <div className="flex gap-1 flex-wrap">
        {TIMEFRAMES.map((t) => {
          const active = tf === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTf(t.id)}
              className="px-2 py-1 text-[10px] transition-all"
              style={{
                border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border)"}`,
                color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
                background: active ? "rgba(0,240,255,0.1)" : "transparent",
                ...MONO,
              }}
            >
              {t.label}
            </button>
          );
        })}
        <button
          onClick={fetchData}
          disabled={loading}
          className="ml-auto px-2 py-1 text-[10px]"
          style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", ...MONO }}
        >
          🔄
        </button>
      </div>

      {/* チャート本体 */}
      <div
        className="relative rounded overflow-hidden"
        style={{ background: "rgba(0,0,0,0.3)", border: "1px solid var(--color-border)" }}
      >
        {loading ? (
          <div className="flex items-center justify-center text-xs text-[var(--color-text-secondary)]" style={{ height, ...MONO }}>
            読み込み中...
          </div>
        ) : error || !data ? (
          <div className="flex items-center justify-center text-xs text-[var(--color-text-secondary)]" style={{ height, ...MONO }}>
            {error ?? "データなし"}
          </div>
        ) : (
          <SVGChart data={data} height={height} avgCost={avgCost} lots={lots} market={market} />
        )}
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 軽量SVGチャート (依存なし、ローソク+取得単価ライン)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function SVGChart({
  data,
  height,
  avgCost,
  lots,
  market,
  compact = false,
}: {
  data: ChartData;
  height: number;
  avgCost?: number;
  lots?: LotInfo[];
  market?: string;
  compact?: boolean;
}) {
  const candles = data.candles;
  if (candles.length === 0) return null;

  const W = 800;
  const PAD = compact
    ? { top: 4, right: 50, bottom: 4, left: 4 }
    : { top: 8, right: 60, bottom: 28, left: 8 };
  const chartH = height - PAD.top - PAD.bottom;
  const chartW = W - PAD.left - PAD.right;

  // Y軸範囲
  let yMin = Math.min(...candles.map((c) => c.low));
  let yMax = Math.max(...candles.map((c) => c.high));
  if (avgCost && avgCost > 0) {
    yMin = Math.min(yMin, avgCost);
    yMax = Math.max(yMax, avgCost);
  }
  if (lots) {
    for (const lot of lots) {
      if (lot.avgCost > 0) {
        yMin = Math.min(yMin, lot.avgCost);
        yMax = Math.max(yMax, lot.avgCost);
      }
    }
  }
  // パディング上下5%
  const pad = (yMax - yMin) * 0.05;
  yMin -= pad;
  yMax += pad;
  const yRange = yMax - yMin || 1;

  const xStep = chartW / candles.length;
  const candleW = Math.max(1, xStep * 0.7);

  const yScale = (v: number) => PAD.top + (1 - (v - yMin) / yRange) * chartH;
  const xScale = (i: number) => PAD.left + i * xStep + xStep / 2;

  // 終値ライン
  const closesPath = candles
    .map((c, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(c.close)}`)
    .join(" ");

  // X軸: 等間隔で5箇所ラベル
  const tickIndices: number[] = [];
  const tickCount = Math.min(5, candles.length);
  for (let k = 0; k < tickCount; k++) {
    tickIndices.push(Math.floor(((candles.length - 1) * k) / Math.max(1, tickCount - 1)));
  }

  // Y軸: 4ラベル
  const yTicks: number[] = [];
  for (let k = 0; k <= 4; k++) {
    yTicks.push(yMin + (yRange * k) / 4);
  }

  const symbol = market === "US" ? "$" : "¥";
  const fmtPrice = (v: number) => (market === "US" ? v.toFixed(2) : Math.round(v).toLocaleString());

  const fmtTime = (t: number | string): string => {
    if (typeof t === "number") {
      // 秒UNIXタイムスタンプ
      const d = new Date(t * 1000);
      return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    // YYYY-MM-DD
    return t.slice(5);
  };

  // 直近値の色
  const last = candles[candles.length - 1].close;
  const first = candles[0].close;
  const changePct = ((last - first) / first) * 100;
  const lineColor = changePct >= 0 ? "#ff3b6b" : "#00d9ff";
  const fillColor = changePct >= 0 ? "rgba(255,59,107,0.08)" : "rgba(0,217,255,0.08)";

  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} preserveAspectRatio="none">
      {/* グリッド */}
      {yTicks.map((y, i) => (
        <g key={`y${i}`}>
          <line
            x1={PAD.left} x2={W - PAD.right}
            y1={yScale(y)} y2={yScale(y)}
            stroke="rgba(255,255,255,0.04)" strokeWidth="1"
          />
          <text
            x={W - PAD.right + 5}
            y={yScale(y) + 3}
            fontSize="9"
            fill="rgba(255,255,255,0.4)"
            style={MONO}
          >
            {symbol}{fmtPrice(y)}
          </text>
        </g>
      ))}

      {/* 塗りつぶし */}
      <path
        d={`${closesPath} L ${xScale(candles.length - 1)} ${PAD.top + chartH} L ${xScale(0)} ${PAD.top + chartH} Z`}
        fill={fillColor}
      />

      {/* ローソク */}
      {candles.map((c, i) => {
        const up = c.close >= c.open;
        const color = up ? "#ff3b6b" : "#00d9ff";
        const bodyTop = yScale(Math.max(c.open, c.close));
        const bodyBottom = yScale(Math.min(c.open, c.close));
        const bodyH = Math.max(1, bodyBottom - bodyTop);
        return (
          <g key={i}>
            <line
              x1={xScale(i)} x2={xScale(i)}
              y1={yScale(c.high)} y2={yScale(c.low)}
              stroke={color} strokeWidth="1"
            />
            <rect
              x={xScale(i) - candleW / 2}
              y={bodyTop}
              width={candleW}
              height={bodyH}
              fill={color}
            />
          </g>
        );
      })}

      {/* 終値ライン (薄く重ねる) */}
      <path d={closesPath} stroke={lineColor} strokeWidth="0.8" fill="none" opacity="0.3" />

      {/* 各ロットの取得単価ライン (複数ロット時) */}
      {lots && lots.length > 1 && lots.map((lot, i) => {
        if (!lot.avgCost || lot.avgCost <= 0 || lot.avgCost < yMin || lot.avgCost > yMax) return null;
        return (
          <g key={i}>
            <line
              x1={PAD.left} x2={W - PAD.right}
              y1={yScale(lot.avgCost)} y2={yScale(lot.avgCost)}
              stroke="#fb923c"
              strokeWidth="0.8"
              strokeDasharray="2,3"
              opacity="0.55"
            />
            {!compact && (
              <text
                x={W - PAD.right - 4}
                y={yScale(lot.avgCost) - 2}
                fontSize="8"
                fill="#fb923c"
                textAnchor="end"
                style={MONO}
              >
                {lot.purchaseDate ? lot.purchaseDate.slice(5) : `lot${i + 1}`} {lot.shares}株 {symbol}{fmtPrice(lot.avgCost)}
              </text>
            )}
          </g>
        );
      })}

      {/* 加重平均ライン (常に表示) */}
      {avgCost && avgCost > 0 && avgCost >= yMin && avgCost <= yMax && (
        <g>
          <line
            x1={PAD.left} x2={W - PAD.right}
            y1={yScale(avgCost)} y2={yScale(avgCost)}
            stroke="#fbbf24"
            strokeWidth={compact ? 1 : 1.5}
            strokeDasharray="4,3"
            opacity="0.85"
          />
          {!compact && (
            <text
              x={PAD.left + 4}
              y={yScale(avgCost) - 4}
              fontSize="9"
              fill="#fbbf24"
              style={MONO}
            >
              {lots && lots.length > 1 ? "加重平均" : "取得"} {symbol}{fmtPrice(avgCost)}
            </text>
          )}
        </g>
      )}

      {/* X軸ラベル (compact時は非表示) */}
      {!compact && tickIndices.map((i) => (
        <text
          key={`x${i}`}
          x={xScale(i)}
          y={height - 8}
          fontSize="9"
          fill="rgba(255,255,255,0.5)"
          textAnchor="middle"
          style={MONO}
        >
          {fmtTime(candles[i].time)}
        </text>
      ))}

      {/* 現在値ラベル */}
      <g>
        <line
          x1={PAD.left} x2={W - PAD.right}
          y1={yScale(last)} y2={yScale(last)}
          stroke={lineColor} strokeWidth="0.5" strokeDasharray="2,2"
          opacity="0.6"
        />
        <rect
          x={W - PAD.right + 2}
          y={yScale(last) - (compact ? 6 : 8)}
          width={compact ? 46 : 56}
          height={compact ? 12 : 16}
          fill={lineColor}
          opacity="0.9"
        />
        <text
          x={W - PAD.right + (compact ? 25 : 30)}
          y={yScale(last) + (compact ? 2 : 3)}
          fontSize={compact ? "9" : "10"}
          fill="#000"
          textAnchor="middle"
          fontWeight="bold"
          style={MONO}
        >
          {symbol}{fmtPrice(last)}
        </text>
      </g>
    </svg>
  );
}
