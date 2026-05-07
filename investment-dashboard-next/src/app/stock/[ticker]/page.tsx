"use client";

import { useEffect, useRef, useState, use } from "react";
import Link from "next/link";

interface StockDetail {
  ticker: string;
  name: string;
  currency: string;
  exchange: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  candles: Candle[];
  indicators: Indicators;
}

interface Candle {
  time: string | number; // 日足以上: "YYYY-MM-DD", イントラデイ: Unixタイムスタンプ
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Indicators {
  rsi: number | null;
  macd: number | null;
  signal: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  bbUpper: number | null;
  bbLower: number | null;
}

const RANGES = [
  { label: "1D", value: "1d" },
  { label: "5D", value: "5d" },
  { label: "1M", value: "1mo" },
  { label: "3M", value: "3mo" },
  { label: "6M", value: "6mo" },
  { label: "1Y", value: "1y" },
  { label: "5Y", value: "5y" },
  { label: "10Y", value: "10y" },
  { label: "MAX", value: "max" },
];

const INTERVALS = [
  { label: "1m", value: "1m" },
  { label: "5m", value: "5m" },
  { label: "15m", value: "15m" },
  { label: "1h", value: "1h" },
  { label: "日", value: "1d" },
  { label: "週", value: "1wk" },
  { label: "月", value: "1mo" },
];

// レンジに対するデフォルトインターバル
function defaultInterval(range: string): string {
  switch (range) {
    case "1d":
      return "1m";
    case "5d":
      return "5m";
    case "1mo":
      return "1h";
    case "3mo":
    case "6mo":
      return "1d";
    case "1y":
      return "1d";
    case "5y":
      return "1wk";
    case "10y":
    case "max":
      return "1mo";
    default:
      return "1d";
  }
}

// レンジに対して選択可能なインターバル
function allowedIntervals(range: string): string[] {
  switch (range) {
    case "1d":
      return ["1m", "5m", "15m"];
    case "5d":
      return ["1m", "5m", "15m", "1h"];
    case "1mo":
      return ["15m", "1h", "1d"];
    case "3mo":
      return ["1h", "1d", "1wk"];
    case "6mo":
    case "1y":
      return ["1d", "1wk", "1mo"];
    case "5y":
      return ["1d", "1wk", "1mo"];
    case "10y":
    case "max":
      return ["1wk", "1mo"];
    default:
      return ["1d"];
  }
}

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

export default function StockDetailPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = use(params);
  const [data, setData] = useState<StockDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState("6mo");
  const [interval, setInterval] = useState(() => defaultInterval("6mo"));
  const chartRef = useRef<HTMLDivElement>(null);

  // レンジ変更時にインターバルも自動調整
  const handleRangeChange = (newRange: string) => {
    setRange(newRange);
    const allowed = allowedIntervals(newRange);
    if (!allowed.includes(interval)) {
      setInterval(defaultInterval(newRange));
    }
  };

  // データ取得
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/stock/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to fetch");
        return res.json();
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setError("データの取得に失敗しました");
        setLoading(false);
      });
  }, [ticker, range, interval]);

  // Lightweight Charts
  useEffect(() => {
    if (!data?.candles?.length || !chartRef.current) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let chart: any = null;
    let disposed = false;

    (async () => {
      try {
        const { createChart, ColorType } = await import("lightweight-charts");
        if (disposed || !chartRef.current) return;

        // 既存のチャートをクリア
        chartRef.current.innerHTML = "";

        chart = createChart(chartRef.current, {
          width: chartRef.current.clientWidth,
          height: 400,
          layout: {
            background: { type: ColorType.Solid, color: "#0a0c1a" },
            textColor: "#666",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
          },
          grid: {
            vertLines: { color: "rgba(0,240,255,0.04)" },
            horzLines: { color: "rgba(0,240,255,0.04)" },
          },
          timeScale: {
            borderColor: "rgba(0,240,255,0.15)",
            timeVisible: ["1m", "5m", "15m", "1h"].includes(interval),
            secondsVisible: false,
          },
          rightPriceScale: {
            borderColor: "rgba(0,240,255,0.15)",
          },
          crosshair: {
            vertLine: { color: "rgba(0,240,255,0.3)", width: 1 },
            horzLine: { color: "rgba(0,240,255,0.3)", width: 1 },
          },
        });

        // Candlestick series (日本株式市場の慣習: 上=赤, 下=青)
        const candleSeries = chart.addCandlestickSeries({
          upColor: "#ff3b6b",
          downColor: "#00d9ff",
          borderUpColor: "#ff3b6b",
          borderDownColor: "#00d9ff",
          wickUpColor: "#ff3b6b",
          wickDownColor: "#00d9ff",
        });

        candleSeries.setData(data.candles);

        // Volume series
        const volumeSeries = chart.addHistogramSeries({
          priceFormat: { type: "volume" },
          priceScaleId: "volume",
        });

        chart.priceScale("volume").applyOptions({
          scaleMargins: { top: 0.85, bottom: 0 },
          visible: false,
        });

        volumeSeries.setData(
          data.candles.map((c) => ({
            time: c.time,
            value: c.volume,
            color:
              c.close >= c.open
                ? "rgba(255,59,107,0.2)"
                : "rgba(0,217,255,0.2)",
          }))
        );

        // SMA lines
        if (data.indicators.sma20) {
          const sma20Series = chart.addLineSeries({
            color: "rgba(0,240,255,0.5)",
            lineWidth: 1,
            title: "SMA20",
          });
          sma20Series.setData(calcSMA(data.candles, 20));
        }
        if (data.indicators.sma50) {
          const sma50Series = chart.addLineSeries({
            color: "rgba(255,43,214,0.5)",
            lineWidth: 1,
            title: "SMA50",
          });
          sma50Series.setData(calcSMA(data.candles, 50));
        }

        chart.timeScale().fitContent();

        // ズームアウト制限: データ範囲外に出たらfitContentに戻す
        const totalBars = data.candles.length;
        chart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange: { from: number; to: number } | null) => {
          if (disposed || !logicalRange) return;
          const barsVisible = logicalRange.to - logicalRange.from;
          // データの全バー数より広くズームアウトしようとしたら制限
          if (barsVisible > totalBars * 1.3 || logicalRange.from < -totalBars * 0.1) {
            chart.timeScale().fitContent();
          }
        });

        // Resize observer
        const observer = new ResizeObserver((entries) => {
          if (disposed) return;
          for (const entry of entries) {
            chart?.applyOptions({ width: entry.contentRect.width });
          }
        });
        observer.observe(chartRef.current);
      } catch (err) {
        console.error("Chart error:", err);
      }
    })();

    return () => {
      disposed = true;
      try { chart?.remove(); } catch { /* already disposed */ }
    };
  }, [data, interval]);

  const isJP = /^\d{4}$/.test(ticker);
  const currencySymbol = isJP ? "¥" : "$";

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-12 w-48" />
        <div className="skeleton h-[400px] w-full" />
        <div className="skeleton h-32 w-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="text-center py-16">
        <p className="text-[var(--color-text-secondary)]">
          {error ?? "データが見つかりません"}
        </p>
        <Link
          href="/portfolio"
          className="inline-block mt-4 text-sm text-[var(--color-accent)]"
          style={MONO}
        >
          {"<"} ポートフォリオに戻る
        </Link>
      </div>
    );
  }

  const isUp = data.change >= 0;
  const upColor = "var(--color-up)";
  const downColor = "var(--color-down)";
  const priceColor = isUp ? upColor : downColor;

  return (
    <div className="space-y-4">
      {/* 戻るリンク */}
      <Link
        href="/portfolio"
        className="inline-flex items-center gap-2 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors"
        style={MONO}
      >
        {"<"} PORTFOLIO
      </Link>

      {/* ヘッダ: 銘柄名 & 価格 */}
      <div
        className="relative p-5 rounded"
        style={{
          border: "1px solid var(--color-border)",
          background: "var(--bg-card)",
        }}
      >
        <span className="absolute top-0 right-0 w-3 h-3 border-t border-r border-[var(--color-accent)] opacity-60 rounded-tr" />
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-3">
              <span
                className="text-xs px-1.5 py-0.5"
                style={{
                  background: isJP
                    ? "rgba(0,240,255,0.15)"
                    : "rgba(255,43,214,0.15)",
                  color: isJP
                    ? "var(--color-accent)"
                    : "var(--color-accent-2)",
                  ...MONO,
                  fontSize: "10px",
                }}
              >
                {isJP ? "JP" : "US"}
              </span>
              <span
                className="text-sm text-[var(--color-accent)] tracking-[0.15em]"
                style={MONO}
              >
                {data.ticker}
              </span>
              {data.exchange && (
                <span className="text-[10px] text-[var(--color-text-secondary)] opacity-60">
                  {data.exchange}
                </span>
              )}
            </div>
            <h1 className="text-xl font-bold mt-1">{data.name}</h1>
          </div>
          <div className="text-right">
            <div
              className="text-3xl font-bold"
              style={{
                color: priceColor,
                textShadow: `0 0 14px ${isUp ? "rgba(255,59,107,0.4)" : "rgba(0,217,255,0.4)"}`,
                ...MONO,
              }}
            >
              {currencySymbol}
              {data.price.toLocaleString()}
            </div>
            <div className="flex items-center gap-2 justify-end mt-1">
              <span
                className="text-sm font-medium px-2 py-0.5"
                style={{
                  color: priceColor,
                  background: isUp
                    ? "rgba(255,59,107,0.12)"
                    : "rgba(0,217,255,0.12)",
                  ...MONO,
                }}
              >
                {isUp ? "+" : ""}
                {data.change.toLocaleString()} ({isUp ? "+" : ""}
                {data.changePct.toFixed(2)}%)
              </span>
            </div>
          </div>
        </div>

        {/* 日中情報 */}
        <div
          className="flex gap-6 mt-3 text-xs text-[var(--color-text-secondary)]"
          style={MONO}
        >
          {data.dayHigh != null && (
            <span>
              HIGH{" "}
              <span className="text-[var(--color-text)]">
                {currencySymbol}
                {data.dayHigh.toLocaleString()}
              </span>
            </span>
          )}
          {data.dayLow != null && (
            <span>
              LOW{" "}
              <span className="text-[var(--color-text)]">
                {currencySymbol}
                {data.dayLow.toLocaleString()}
              </span>
            </span>
          )}
          {data.volume != null && (
            <span>
              VOL{" "}
              <span className="text-[var(--color-text)]">
                {formatVolume(data.volume)}
              </span>
            </span>
          )}
          <span>
            PREV{" "}
            <span className="text-[var(--color-text)]">
              {currencySymbol}
              {data.prevClose.toLocaleString()}
            </span>
          </span>
        </div>
      </div>

      {/* レンジ切替 + チャート */}
      <div
        className="rounded overflow-hidden"
        style={{
          border: "1px solid var(--color-border)",
          background: "var(--bg-card)",
        }}
      >
        {/* レンジ & インターバル ボタン */}
        <div
          className="flex flex-wrap items-center gap-1.5 px-4 py-2.5 border-b"
          style={{ borderColor: "var(--color-border)" }}
        >
          {/* レンジ */}
          {RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => handleRangeChange(r.value)}
              className="px-3 py-1.5 text-xs transition-all"
              style={{
                ...MONO,
                letterSpacing: "0.05em",
                color:
                  range === r.value
                    ? "var(--color-accent)"
                    : "var(--color-text-secondary)",
                background:
                  range === r.value
                    ? "rgba(0,240,255,0.1)"
                    : "transparent",
                border:
                  range === r.value
                    ? "1px solid rgba(0,240,255,0.3)"
                    : "1px solid transparent",
              }}
            >
              {r.label}
            </button>
          ))}

          {/* セパレータ */}
          <span
            className="mx-1 h-5 w-px"
            style={{ background: "var(--color-border)" }}
          />

          {/* インターバル */}
          {INTERVALS.filter((iv) =>
            allowedIntervals(range).includes(iv.value)
          ).map((iv) => (
            <button
              key={iv.value}
              onClick={() => setInterval(iv.value)}
              className="px-2 py-1.5 text-xs transition-all"
              style={{
                ...MONO,
                letterSpacing: "0.05em",
                color:
                  interval === iv.value
                    ? "var(--color-accent-2)"
                    : "var(--color-text-secondary)",
                background:
                  interval === iv.value
                    ? "rgba(255,43,214,0.1)"
                    : "transparent",
                border:
                  interval === iv.value
                    ? "1px solid rgba(255,43,214,0.3)"
                    : "1px solid transparent",
              }}
            >
              {iv.label}
            </button>
          ))}

          <span className="ml-auto flex items-center gap-3 text-[10px] text-[var(--color-text-secondary)] pr-2">
            <span className="flex items-center gap-1">
              <span className="w-3 h-0.5 bg-[rgba(0,240,255,0.5)]" />
              SMA20
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-0.5 bg-[rgba(255,43,214,0.5)]" />
              SMA50
            </span>
          </span>
        </div>

        {/* チャートコンテナ */}
        <div className="relative">
          <div ref={chartRef} className="w-full" style={{ minHeight: 400 }} />
          {/* ローディングオーバーレイ */}
          {loading && (
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{ background: "rgba(5,6,13,0.75)", zIndex: 10 }}
            >
              <div className="flex flex-col items-center gap-3">
                <div
                  className="loading-pulse"
                  style={{
                    width: 40,
                    height: 40,
                    border: "2px solid rgba(0,240,255,0.3)",
                    borderTop: "2px solid var(--color-accent)",
                    borderRadius: "50%",
                    animation: "spin 0.8s linear infinite, pulse-glow 1.2s ease-in-out infinite",
                  }}
                />
                <span
                  className="text-xs text-[var(--color-accent)] loading-pulse"
                  style={MONO}
                >
                  LOADING...
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* テクニカル指標 */}
      <div
        className="p-5 rounded"
        style={{
          border: "1px solid var(--color-border)",
          background: "var(--bg-card)",
        }}
      >
        <span
          className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-4"
          style={MONO}
        >
          Technical Indicators
        </span>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          {/* RSI */}
          <IndicatorCard
            label="RSI (14)"
            value={data.indicators.rsi?.toFixed(1) ?? "—"}
            color={
              data.indicators.rsi
                ? data.indicators.rsi >= 70
                  ? upColor
                  : data.indicators.rsi <= 30
                    ? downColor
                    : "var(--color-text)"
                : "var(--color-text-secondary)"
            }
            sub={
              data.indicators.rsi
                ? data.indicators.rsi >= 70
                  ? "買われすぎ"
                  : data.indicators.rsi <= 30
                    ? "売られすぎ"
                    : "中立"
                : null
            }
            bar={data.indicators.rsi ? data.indicators.rsi / 100 : null}
          />

          {/* MACD */}
          <IndicatorCard
            label="MACD"
            value={data.indicators.macd?.toFixed(2) ?? "—"}
            color={
              data.indicators.macd
                ? data.indicators.macd > 0
                  ? upColor
                  : downColor
                : "var(--color-text-secondary)"
            }
            sub={
              data.indicators.signal != null
                ? `Signal: ${data.indicators.signal.toFixed(2)}`
                : null
            }
          />

          {/* Bollinger Bands */}
          <div>
            <span
              className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1"
              style={MONO}
            >
              Bollinger Bands
            </span>
            {data.indicators.bbUpper ? (
              <div style={MONO}>
                <div className="text-sm">
                  <span className="text-[var(--color-text-secondary)]">
                    Upper{" "}
                  </span>
                  <span style={{ color: upColor }}>
                    {currencySymbol}
                    {data.indicators.bbUpper.toLocaleString()}
                  </span>
                </div>
                <div className="text-sm mt-1">
                  <span className="text-[var(--color-text-secondary)]">
                    Lower{" "}
                  </span>
                  <span style={{ color: downColor }}>
                    {currencySymbol}
                    {data.indicators.bbLower?.toLocaleString()}
                  </span>
                </div>
              </div>
            ) : (
              <span className="text-sm text-[var(--color-text-secondary)]">
                —
              </span>
            )}
          </div>

          {/* Moving Averages */}
          <div>
            <span
              className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1"
              style={MONO}
            >
              Moving Averages
            </span>
            <div style={MONO} className="text-sm space-y-1">
              <div>
                <span className="text-[rgba(0,240,255,0.7)]">SMA20 </span>
                <span>
                  {data.indicators.sma20
                    ? `${currencySymbol}${data.indicators.sma20.toLocaleString()}`
                    : "—"}
                </span>
              </div>
              <div>
                <span className="text-[rgba(255,43,214,0.7)]">SMA50 </span>
                <span>
                  {data.indicators.sma50
                    ? `${currencySymbol}${data.indicators.sma50.toLocaleString()}`
                    : "—"}
                </span>
              </div>
              {data.indicators.sma200 && (
                <div>
                  <span className="text-[var(--color-text-secondary)]">
                    SMA200{" "}
                  </span>
                  <span>
                    {currencySymbol}
                    {data.indicators.sma200.toLocaleString()}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* スコア判定 */}
      <ScorePanel indicators={data.indicators} price={data.price} />
    </div>
  );
}

// ========================================
// サブコンポーネント
// ========================================

function IndicatorCard({
  label,
  value,
  color,
  sub,
  bar,
}: {
  label: string;
  value: string;
  color: string;
  sub?: string | null;
  bar?: number | null;
}) {
  return (
    <div>
      <span
        className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1"
        style={MONO}
      >
        {label}
      </span>
      <div className="text-xl font-bold" style={{ color, ...MONO }}>
        {value}
      </div>
      {sub && (
        <span className="text-[10px] text-[var(--color-text-secondary)] mt-0.5 block">
          {sub}
        </span>
      )}
      {bar != null && (
        <div className="mt-2 h-1 bg-[var(--bg-input)] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${bar * 100}%`, backgroundColor: color }}
          />
        </div>
      )}
    </div>
  );
}

function ScorePanel({
  indicators,
  price,
}: {
  indicators: Indicators;
  price: number;
}) {
  // シンプルなスコア算出
  let score = 50;
  const signals: string[] = [];

  if (indicators.rsi != null) {
    if (indicators.rsi < 30) {
      score += 15;
      signals.push("RSI 売られすぎ圏 → 反発の可能性");
    } else if (indicators.rsi > 70) {
      score -= 15;
      signals.push("RSI 買われすぎ圏 → 調整の可能性");
    } else if (indicators.rsi > 40 && indicators.rsi < 60) {
      score += 5;
      signals.push("RSI 中立圏");
    }
  }

  if (indicators.macd != null && indicators.signal != null) {
    if (indicators.macd > indicators.signal) {
      score += 10;
      signals.push("MACD がシグナルを上回る → 上昇トレンド");
    } else {
      score -= 10;
      signals.push("MACD がシグナルを下回る → 下降トレンド");
    }
  }

  if (indicators.sma20 != null && indicators.sma50 != null) {
    if (price > indicators.sma20 && indicators.sma20 > indicators.sma50) {
      score += 10;
      signals.push("価格 > SMA20 > SMA50 → 強気の並び");
    } else if (
      price < indicators.sma20 &&
      indicators.sma20 < indicators.sma50
    ) {
      score -= 10;
      signals.push("価格 < SMA20 < SMA50 → 弱気の並び");
    }
  }

  if (indicators.bbUpper != null && indicators.bbLower != null) {
    if (price >= indicators.bbUpper) {
      score -= 5;
      signals.push("ボリンジャーバンド上限付近 → 過熱感");
    } else if (price <= indicators.bbLower) {
      score += 5;
      signals.push("ボリンジャーバンド下限付近 → 割安感");
    }
  }

  score = Math.max(0, Math.min(100, score));

  const getColor = (s: number) => {
    if (s >= 65) return "var(--color-up)";
    if (s >= 40) return "#f0a030";
    return "var(--color-down)";
  };

  const getLabel = (s: number) => {
    if (s >= 75) return "強い買いシグナル";
    if (s >= 60) return "買い検討";
    if (s >= 45) return "中立";
    if (s >= 30) return "様子見";
    return "売り検討";
  };

  return (
    <div
      className="p-5 rounded"
      style={{
        border: "1px solid var(--color-border)",
        background: "var(--bg-card)",
      }}
    >
      <span
        className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-3"
        style={MONO}
      >
        Analysis Score
      </span>

      <div className="flex items-center gap-6">
        <div
          className="text-5xl font-bold"
          style={{
            color: getColor(score),
            textShadow: `0 0 20px ${getColor(score)}40`,
            ...MONO,
          }}
        >
          {score}
        </div>
        <div>
          <div
            className="text-lg font-bold"
            style={{ color: getColor(score) }}
          >
            {getLabel(score)}
          </div>
          <div className="mt-1 h-2 w-48 bg-[var(--bg-input)] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-1000"
              style={{
                width: `${score}%`,
                backgroundColor: getColor(score),
                boxShadow: `0 0 8px ${getColor(score)}80`,
              }}
            />
          </div>
        </div>
      </div>

      {/* シグナル一覧 */}
      <div className="mt-4 space-y-1.5">
        {signals.map((s, i) => (
          <div
            key={i}
            className="flex items-start gap-2 text-xs text-[var(--color-text-secondary)]"
          >
            <span className="text-[var(--color-accent)] mt-0.5">{">"}</span>
            {s}
          </div>
        ))}
      </div>
    </div>
  );
}

// ========================================
// ユーティリティ
// ========================================

function calcSMA(
  candles: Candle[],
  period: number
): { time: string | number; value: number }[] {
  const result: { time: string | number; value: number }[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += candles[j].close;
    }
    result.push({
      time: candles[i].time,
      value: Math.round((sum / period) * 100) / 100,
    });
  }
  return result;
}

function formatVolume(v: number): string {
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return v.toString();
}
