"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { fetcher, fetchAnalysisUrl, type AnalysisResult } from "@/lib/api";

interface SearchResult {
  ticker: string;
  name: string;
  market: string;
}

export default function AnalysisPage() {
  const router = useRouter();
  const [ticker, setTicker] = useState("");
  const [searchTicker, setSearchTicker] = useState("");
  const chartContainerRef = useRef<HTMLDivElement>(null);

  // サジェスト機能
  const [suggestions, setSuggestions] = useState<SearchResult[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  // 入力に応じて検索 (debounce 300ms)
  useEffect(() => {
    const q = ticker.trim();
    // ティッカーコード形式なら検索不要
    if (!q || /^\d{3,4}[A-Z]?$/.test(q) || /^[A-Z]{1,5}$/.test(q.toUpperCase())) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/stocks/search?q=${encodeURIComponent(q)}`);
        const data = (await res.json()) as SearchResult[];
        setSuggestions(data.slice(0, 8));
        setShowSuggestions(true);
      } catch {
        setSuggestions([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [ticker]);

  // 外クリックで閉じる
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const selectStock = (s: SearchResult) => {
    setSuggestions([]);
    setShowSuggestions(false);
    // 銘柄詳細画面 (新版・フル機能) に遷移
    router.push(`/stock/${s.ticker}`);
  };

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
            background: { color: "#0d1024" },
            textColor: "#9e9e9e",
          },
          grid: {
            vertLines: { color: "rgba(0,240,255,0.04)" },
            horzLines: { color: "rgba(0,240,255,0.04)" },
          },
          timeScale: {
            borderColor: "rgba(0,240,255,0.08)",
          },
          rightPriceScale: {
            borderColor: "rgba(0,240,255,0.08)",
          },
        });

        const candleSeries = chart.addCandlestickSeries({
          upColor: "#ff3b6b",
          downColor: "#00d9ff",
          borderUpColor: "#ff3b6b",
          borderDownColor: "#00d9ff",
          wickUpColor: "#ff3b6b",
          wickDownColor: "#00d9ff",
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
    const q = ticker.trim();
    if (!q) return;
    // ティッカーコード形式 (4桁数字 or 英字) なら直接 /stock へ
    if (/^\d{3,4}[A-Z]?$/.test(q) || /^[A-Z]{1,5}$/.test(q.toUpperCase())) {
      router.push(`/stock/${q.toUpperCase()}`);
      return;
    }
    // それ以外: 検索結果のトップを使う
    if (suggestions.length > 0) {
      router.push(`/stock/${suggestions[0].ticker}`);
      return;
    }
    setSearchTicker(q.toUpperCase());
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
      <h1 className="text-[26px] font-bold tracking-tight text-[var(--color-text)]">🔎 銘柄分析</h1>

      {/* Search */}
      <div ref={searchRef} className="relative">
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
            placeholder="銘柄コード or 銘柄名で検索 (例: 7203, AAPL, トヨタ, KOKUSAI)"
            className="flex-1 bg-[var(--bg-input)] border border-[var(--color-border)] px-4 py-2.5 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              clipPath: "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
            }}
          />
          <button
            type="submit"
            className="px-6 py-2.5 text-sm font-medium transition-all min-h-[44px] uppercase tracking-wider"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              clipPath: "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
              border: "1px solid var(--color-accent)",
              boxShadow: "0 0 18px rgba(0,240,255,0.35), inset 0 0 12px rgba(0,240,255,0.08)",
              background: "transparent",
              color: "var(--color-accent)",
            }}
          >
            分析
          </button>
        </form>
        {searching && (
          <span className="absolute right-28 top-3.5 text-[10px] text-[var(--color-accent)]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            検索中...
          </span>
        )}
        {showSuggestions && suggestions.length > 0 && (
          <div
            className="absolute z-50 left-0 right-24 mt-1 max-h-[300px] overflow-y-auto"
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--color-accent)",
              boxShadow: "0 4px 20px rgba(0,0,0,0.6), 0 0 12px rgba(0,240,255,0.15)",
            }}
          >
            {suggestions.map((s) => (
              <button
                key={s.ticker + s.market}
                onClick={() => selectStock(s)}
                className="block w-full text-left px-3 py-2 text-xs hover:bg-[rgba(0,240,255,0.08)] border-b border-[var(--color-border)] last:border-b-0"
              >
                <span className="text-[9px] px-1 py-0.5 mr-2" style={{ background: s.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)", color: s.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)", fontFamily: "'JetBrains Mono', monospace" }}>
                  {s.market}
                </span>
                <span className="text-[var(--color-accent)] font-bold mr-2" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  {s.ticker}
                </span>
                <span className="text-[var(--color-text)]">{s.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {isLoading && (
        <div className="space-y-3">
          <div className="skeleton h-[300px]" style={{ clipPath: "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)" }} />
          <div className="skeleton h-32" style={{ clipPath: "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)" }} />
        </div>
      )}

      {display && !isLoading && (
        <>
          {/* Header */}
          <div
            className="relative bg-card p-4 border border-[var(--color-border)]"
            style={{
              clipPath: "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)",
              boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
            }}
          >
            <span className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-accent)] opacity-60" />
            <span className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[var(--color-accent-2)] opacity-60" />
            <div className="flex items-start justify-between">
              <div>
                <span
                  className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-accent)]"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  {display.code}
                </span>
                <h2 className="text-xl font-bold mt-0.5">{display.name}</h2>
              </div>
              <div className="text-right">
                <div
                  className="text-2xl font-bold"
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    color:
                      display.change_pct >= 0
                        ? "var(--color-up)"
                        : "var(--color-down)",
                  }}
                >
                  ¥{display.price.toLocaleString()}
                </div>
                <span
                  className="text-sm font-medium px-2 py-0.5 inline-block mt-1"
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    color:
                      display.change_pct >= 0
                        ? "var(--color-up)"
                        : "var(--color-down)",
                    backgroundColor:
                      display.change_pct >= 0
                        ? "rgba(255,82,82,0.15)"
                        : "rgba(68,138,255,0.15)",
                    clipPath: "polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px)",
                  }}
                >
                  {display.change_pct >= 0 ? "+" : ""}
                  {display.change_pct.toFixed(2)}%
                </span>
              </div>
            </div>
          </div>

          {/* Chart */}
          <div
            className="relative bg-card border border-[var(--color-border)] overflow-hidden"
            style={{
              clipPath: "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)",
              boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
            }}
          >
            <span className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-accent)] opacity-60 z-10" />
            <span className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[var(--color-accent-2)] opacity-60 z-10" />
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
            <div
              className="relative bg-card p-4 border border-[var(--color-border)]"
              style={{
                clipPath: "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)",
                boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
              }}
            >
              <span className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-accent)] opacity-60" />
              <span className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[var(--color-accent-2)] opacity-60" />
              <span
                className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                総合スコア
              </span>
              <div className="flex items-end gap-3 mt-2">
                <span
                  className="text-4xl font-bold"
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    color: getScoreColor(display.score),
                    textShadow: `0 0 20px ${getScoreColor(display.score)}`,
                  }}
                >
                  {display.score}
                </span>
                <span
                  className="text-sm text-[var(--color-text-secondary)] mb-1"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  / 100
                </span>
              </div>
            </div>

            <div
              className="relative bg-card p-4 border border-[var(--color-border)]"
              style={{
                clipPath: "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)",
                boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
              }}
            >
              <span className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-accent)] opacity-60" />
              <span className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[var(--color-accent-2)] opacity-60" />
              <span
                className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                推奨アクション
              </span>
              <div
                className="text-2xl font-bold mt-2"
                style={{
                  fontFamily: "'Orbitron', sans-serif",
                  background: "linear-gradient(90deg, #00f0ff 0%, #ff2bd6 100%)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                {display.recommendation}
              </div>
            </div>
          </div>

          {/* Technical Indicators */}
          <div
            className="relative bg-card p-4 border border-[var(--color-border)]"
            style={{
              clipPath: "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)",
              boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
            }}
          >
            <span className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-accent)] opacity-60" />
            <span className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[var(--color-accent-2)] opacity-60" />
            <h3
              className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] mb-3"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              テクニカル指標
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <span
                  className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  RSI (14)
                </span>
                <div
                  className="text-lg font-bold mt-0.5"
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    color: getRsiColor(display.indicators.rsi),
                  }}
                >
                  {display.indicators.rsi.toFixed(1)}
                </div>
              </div>
              <div>
                <span
                  className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  MACD
                </span>
                <div
                  className="text-lg font-bold mt-0.5"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  {display.indicators.macd.toFixed(2)}
                </div>
                <span
                  className="text-xs text-[var(--color-text-secondary)]"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  Signal: {display.indicators.signal.toFixed(2)}
                </span>
              </div>
              <div>
                <span
                  className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  ボリンジャーバンド
                </span>
                <div className="text-sm mt-0.5" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
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
                <span
                  className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  移動平均線
                </span>
                <div className="text-sm mt-0.5" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
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
            className="w-16 h-16 mx-auto mb-4 neon-text-cyan"
            style={{ opacity: 0.7, filter: "drop-shadow(0 0 8px rgba(0,240,255,0.5))" }}
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
          <p className="text-sm">銘柄を選んで詳細分析画面に進みます</p>
          <p className="text-xs mt-1">
            銘柄コード (7203, AAPL) または銘柄名 (トヨタ, KOKUSAI)
          </p>
          <p className="text-[10px] mt-3 text-[var(--color-accent)]">
            ※ 候補をクリック → 銘柄詳細画面 (💡インサイト, 📊板情報, 🏦信用残, 📰ニュース, 📊決算パターン 等) に遷移
          </p>
        </div>
      )}
    </div>
  );
}
