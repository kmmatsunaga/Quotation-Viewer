"use client";

import { useState, useEffect, useRef } from "react";
import useSWR from "swr";
import { fetcher, fetchAnalysisUrl, type AnalysisResult } from "@/lib/api";

export default function AnalysisPage() {
  const [ticker, setTicker] = useState("");
  const [searchTicker, setSearchTicker] = useState("");
  const chartContainerRef = useRef<HTMLDivElement>(null);

  const { data: analysis, isLoading } = useSWR<AnalysisResult>(
    searchTicker ? fetchAnalysisUrl(searchTicker) : null,
    fetcher
  );

  const demoAnalysis: AnalysisResult | null = searchTicker
    ? {
        code: searchTicker,
        name: searchTicker === "7203" ? "トヨタ自動車" : searchTicker,
        price: 3450,
        change_pct: 1.32,
        indicators: {
          rsi: 58.4,
          macd: 12.5,
          signal: 10.2,
          bb_upper: 3520,
          bb_lower: 3380,
          sma_20: 3420,
          sma_50: 3350,
        },
        score: 72,
        recommendation: "買い検討",
        candles: [],
      }
    : null;

  const display = analysis ?? demoAnalysis;

  // Lightweight charts
  useEffect(() => {
    if (!display?.candles?.length || !chartContainerRef.current) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let chart: any = null;

    (async () => {
      try {
        const { createChart } = await import("lightweight-charts");
        if (!chartContainerRef.current) return;

        chart = createChart(chartContainerRef.current, {
          width: chartContainerRef.current.clientWidth,
          height: 300,
          layout: {
            background: { color: "#1a1a2e" },
            textColor: "#9e9e9e",
          },
          grid: {
            vertLines: { color: "#2a2a4a" },
            horzLines: { color: "#2a2a4a" },
          },
          timeScale: {
            borderColor: "#2a2a4a",
          },
          rightPriceScale: {
            borderColor: "#2a2a4a",
          },
        });

        const candleSeries = chart.addCandlestickSeries({
          upColor: "#ff5252",
          downColor: "#448aff",
          borderUpColor: "#ff5252",
          borderDownColor: "#448aff",
          wickUpColor: "#ff5252",
          wickDownColor: "#448aff",
        });

        candleSeries.setData(
          display.candles.map((c: { time: string; open: number; high: number; low: number; close: number }) => ({
            time: c.time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          }))
        );

        chart.timeScale().fitContent();
      } catch (err) {
        console.error("Chart error:", err);
      }
    })();

    return () => {
      chart?.remove();
    };
  }, [display?.candles]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (ticker.trim()) {
      setSearchTicker(ticker.trim().toUpperCase());
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 70) return "var(--color-up)";
    if (score >= 40) return "var(--color-warning)";
    return "var(--color-down)";
  };

  const getRsiColor = (rsi: number) => {
    if (rsi >= 70) return "var(--color-up)";
    if (rsi <= 30) return "var(--color-down)";
    return "var(--color-text)";
  };

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-bold">銘柄分析</h1>

      {/* Search */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          type="text"
          value={ticker}
          onChange={(e) => setTicker(e.target.value)}
          placeholder="銘柄コードを入力 (例: 7203, AAPL)"
          className="flex-1 bg-[var(--bg-input)] border border-[var(--color-border)] rounded-lg px-4 py-2.5 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
        />
        <button
          type="submit"
          className="px-6 py-2.5 bg-[var(--color-accent)] text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity min-h-[44px]"
        >
          分析
        </button>
      </form>

      {isLoading && (
        <div className="space-y-3">
          <div className="skeleton h-[300px] rounded-xl" />
          <div className="skeleton h-32 rounded-xl" />
        </div>
      )}

      {display && !isLoading && (
        <>
          {/* Header */}
          <div className="bg-card rounded-xl p-4 border border-[var(--color-border)]">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-xs text-[var(--color-text-secondary)] font-mono">
                  {display.code}
                </span>
                <h2 className="text-xl font-bold mt-0.5">{display.name}</h2>
              </div>
              <div className="text-right">
                <div
                  className="text-2xl font-bold"
                  style={{
                    color:
                      display.change_pct >= 0
                        ? "var(--color-up)"
                        : "var(--color-down)",
                  }}
                >
                  ¥{display.price.toLocaleString()}
                </div>
                <span
                  className="text-sm font-medium px-2 py-0.5 rounded inline-block mt-1"
                  style={{
                    color:
                      display.change_pct >= 0
                        ? "var(--color-up)"
                        : "var(--color-down)",
                    backgroundColor:
                      display.change_pct >= 0
                        ? "rgba(255,82,82,0.15)"
                        : "rgba(68,138,255,0.15)",
                  }}
                >
                  {display.change_pct >= 0 ? "+" : ""}
                  {display.change_pct.toFixed(2)}%
                </span>
              </div>
            </div>
          </div>

          {/* Chart */}
          <div className="bg-card rounded-xl border border-[var(--color-border)] overflow-hidden">
            <div
              ref={chartContainerRef}
              className="w-full"
              style={{ minHeight: 300 }}
            >
              {(!display.candles || display.candles.length === 0) && (
                <div className="flex items-center justify-center h-[300px] text-[var(--color-text-secondary)] text-sm">
                  チャートデータを取得中...
                </div>
              )}
            </div>
          </div>

          {/* Score & Recommendation */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-card rounded-xl p-4 border border-[var(--color-border)]">
              <span className="text-xs text-[var(--color-text-secondary)]">
                総合スコア
              </span>
              <div className="flex items-end gap-3 mt-2">
                <span
                  className="text-4xl font-bold"
                  style={{ color: getScoreColor(display.score) }}
                >
                  {display.score}
                </span>
                <span className="text-sm text-[var(--color-text-secondary)] mb-1">
                  / 100
                </span>
              </div>
              <div className="mt-3 h-2 bg-[var(--bg-input)] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${display.score}%`,
                    backgroundColor: getScoreColor(display.score),
                  }}
                />
              </div>
            </div>

            <div className="bg-card rounded-xl p-4 border border-[var(--color-border)]">
              <span className="text-xs text-[var(--color-text-secondary)]">
                推奨アクション
              </span>
              <div
                className="text-2xl font-bold mt-2"
                style={{ color: getScoreColor(display.score) }}
              >
                {display.recommendation}
              </div>
            </div>
          </div>

          {/* Technical Indicators */}
          <div className="bg-card rounded-xl p-4 border border-[var(--color-border)]">
            <h3 className="text-sm font-medium text-[var(--color-text-secondary)] mb-3">
              テクニカル指標
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <span className="text-xs text-[var(--color-text-secondary)]">
                  RSI (14)
                </span>
                <div
                  className="text-lg font-bold mt-0.5"
                  style={{ color: getRsiColor(display.indicators.rsi) }}
                >
                  {display.indicators.rsi.toFixed(1)}
                </div>
              </div>
              <div>
                <span className="text-xs text-[var(--color-text-secondary)]">
                  MACD
                </span>
                <div className="text-lg font-bold mt-0.5">
                  {display.indicators.macd.toFixed(2)}
                </div>
                <span className="text-xs text-[var(--color-text-secondary)]">
                  Signal: {display.indicators.signal.toFixed(2)}
                </span>
              </div>
              <div>
                <span className="text-xs text-[var(--color-text-secondary)]">
                  ボリンジャーバンド
                </span>
                <div className="text-sm mt-0.5">
                  <span className="text-[var(--color-up)]">
                    上: ¥{display.indicators.bb_upper.toLocaleString()}
                  </span>
                  <br />
                  <span className="text-[var(--color-down)]">
                    下: ¥{display.indicators.bb_lower.toLocaleString()}
                  </span>
                </div>
              </div>
              <div>
                <span className="text-xs text-[var(--color-text-secondary)]">
                  移動平均線
                </span>
                <div className="text-sm mt-0.5">
                  <span>SMA20: ¥{display.indicators.sma_20.toLocaleString()}</span>
                  <br />
                  <span>SMA50: ¥{display.indicators.sma_50.toLocaleString()}</span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {!display && !isLoading && (
        <div className="text-center py-16 text-[var(--color-text-secondary)]">
          <svg
            className="w-16 h-16 mx-auto mb-4 opacity-50"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <p className="text-sm">銘柄コードを入力して分析を開始してください</p>
          <p className="text-xs mt-1">
            日本株 (例: 7203) または米国株 (例: AAPL)
          </p>
        </div>
      )}
    </div>
  );
}
