"use client";

import { useEffect, useRef, useState, use, useCallback } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import PatternBadge, { type PatternData } from "@/components/PatternBadge";
import ScenarioEditorModal from "@/app/scenarios/ScenarioEditorModal";
import MultiTimeframeView from "./MultiTimeframeView";
import StockNewsPanel from "./StockNewsPanel";
import OrderBookPanel from "./OrderBookPanel";
import MarginPanel from "./MarginPanel";
import InsightPanel from "./InsightPanel";
import FutureScorePanel from "./FutureScorePanel";
import FinancialsPanel from "./FinancialsPanel";
import EarningsPatternPanel from "./EarningsPatternPanel";
import { TachibanaSnapshotProvider } from "./TachibanaSnapshotContext";
import {
  getWatchlistGroups,
  addToWatchlist,
  addAlert,
  getHoldings,
  getScenarios,
  type WatchlistGroup,
  type Holding,
  type InvestmentScenario,
} from "@/lib/firestore";

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
  time: string | number;
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

function defaultInterval(range: string): string {
  switch (range) {
    case "1d": return "1m";
    case "5d": return "5m";
    case "1mo": return "1h";
    case "3mo":
    case "6mo": return "1d";
    case "1y": return "1d";
    case "5y": return "1wk";
    case "10y":
    case "max": return "1mo";
    default: return "1d";
  }
}

function allowedIntervals(range: string): string[] {
  switch (range) {
    case "1d": return ["1m", "5m", "15m"];
    case "5d": return ["1m", "5m", "15m", "1h"];
    case "1mo": return ["15m", "1h", "1d"];
    case "3mo": return ["1h", "1d", "1wk"];
    case "6mo":
    case "1y": return ["1d", "1wk", "1mo"];
    case "5y": return ["1d", "1wk", "1mo"];
    case "10y":
    case "max": return ["1wk", "1mo"];
    default: return ["1d"];
  }
}

const MONO = { fontFamily: "'JetBrains Mono', monospace" };
const clip = (px = 6) =>
  `polygon(${px}px 0, 100% 0, 100% calc(100% - ${px}px), calc(100% - ${px}px) 100%, 0 100%, 0 ${px}px)`;

export default function StockDetailPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = use(params);
  const { user } = useAuth();
  const [data, setData] = useState<StockDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState("6mo");
  const [interval, setInterval] = useState(() => defaultInterval("6mo"));
  const chartRef = useRef<HTMLDivElement>(null);
  const [patterns, setPatterns] = useState<Record<string, PatternData[]>>({});
  const [transitions, setTransitions] = useState<Array<{
    fromId: string; toId: string; toLabel: string;
    signal: string; triggerConditions: string[];
    probability: string; proximity: number;
  }> | null>(null);
  const [patternsLoading, setPatternsLoading] = useState(false);
  const [maMode, setMaMode] = useState<"pattern" | "analysis">("pattern");

  // Action panel state
  const [showFavPanel, setShowFavPanel] = useState(false);
  const [showAlertPanel, setShowAlertPanel] = useState(false);
  const [showScenarioModal, setShowScenarioModal] = useState(false);
  const [watchlistGroups, setWatchlistGroups] = useState<WatchlistGroup[]>([]);
  const [favAdded, setFavAdded] = useState<string | null>(null);
  const [alertPrice, setAlertPrice] = useState("");
  const [alertCondition, setAlertCondition] = useState<"above" | "below">("above");
  const [alertAdded, setAlertAdded] = useState(false);

  // この銘柄の保有データとシナリオ (チャートに損益分岐ライン表示用)
  const [myHoldings, setMyHoldings] = useState<Holding[]>([]);
  const [myScenarios, setMyScenarios] = useState<InvestmentScenario[]>([]);
  const [showOverlay, setShowOverlay] = useState(true);

  // 保有データ & シナリオを取得
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const [holdings, scenarios] = await Promise.all([
          getHoldings(user.uid),
          getScenarios(user.uid),
        ]);
        setMyHoldings(holdings.filter((h) => h.ticker === ticker));
        setMyScenarios(
          scenarios.filter((s) => s.ticker === ticker && s.status === "active")
        );
      } catch (err) {
        console.error("Failed to load holdings/scenarios:", err);
      }
    })();
  }, [user, ticker]);

  const handleRangeChange = (newRange: string) => {
    setRange(newRange);
    const allowed = allowedIntervals(newRange);
    if (!allowed.includes(interval)) {
      setInterval(defaultInterval(newRange));
    }
  };

  // Data fetch
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/stock/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to fetch");
        return res.json();
      })
      .then((d) => { setData(d); setLoading(false); })
      .catch((err) => { console.error(err); setError("データの取得に失敗しました"); setLoading(false); });
  }, [ticker, range, interval]);

  // Pattern detection
  useEffect(() => {
    setPatternsLoading(true);
    fetch(`/api/stocks/patterns?tickers=${encodeURIComponent(ticker)}`)
      .then(async (res) => {
        if (!res.ok) return;
        const json = await res.json();
        const info = json.patterns?.[ticker];
        if (info?.patterns) setPatterns(info.patterns);
        if (info?.transitions) setTransitions(info.transitions);
      })
      .catch((err) => console.error("Pattern fetch error:", err))
      .finally(() => setPatternsLoading(false));
  }, [ticker]);

  // Load watchlist groups
  useEffect(() => {
    if (!user) return;
    getWatchlistGroups(user.uid).then(setWatchlistGroups).catch(() => {});
  }, [user]);

  // Set default alert price when data loads
  useEffect(() => {
    if (data && !alertPrice) {
      setAlertPrice(String(Math.round(data.price)));
    }
  }, [data, alertPrice]);

  // Add to favorites
  const handleAddToFav = useCallback(async (groupId: string, groupName: string) => {
    if (!user || !data) return;
    try {
      await addToWatchlist(user.uid, {
        ticker: data.ticker,
        name: data.name,
        market: /^\d{3,4}[A-Z]?$/.test(data.ticker) ? "JP" : "US",
        groupId,
      });
      setFavAdded(groupName);
      setTimeout(() => { setFavAdded(null); setShowFavPanel(false); }, 1500);
    } catch {}
  }, [user, data]);

  // Add alert
  const handleAddAlert = useCallback(async () => {
    if (!user || !data || !alertPrice) return;
    try {
      await addAlert(user.uid, {
        ticker: data.ticker,
        name: data.name,
        condition: alertCondition,
        targetPrice: Number(alertPrice),
      });
      setAlertAdded(true);
      setTimeout(() => { setAlertAdded(false); setShowAlertPanel(false); }, 1500);
    } catch {}
  }, [user, data, alertPrice, alertCondition]);

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
          rightPriceScale: { borderColor: "rgba(0,240,255,0.15)" },
          crosshair: {
            vertLine: { color: "rgba(0,240,255,0.3)", width: 1 },
            horzLine: { color: "rgba(0,240,255,0.3)", width: 1 },
          },
        });

        const candleSeries = chart.addCandlestickSeries({
          upColor: "#ff3b6b", downColor: "#00d9ff",
          borderUpColor: "#ff3b6b", borderDownColor: "#00d9ff",
          wickUpColor: "#ff3b6b", wickDownColor: "#00d9ff",
        });
        candleSeries.setData(data.candles);

        // ── 損益分岐・目標・損切ラインを描画 ─────────
        if (showOverlay) {
          // 保有銘柄の取得単価
          for (const h of myHoldings) {
            if (!h.avgCost || h.avgCost <= 0) continue;
            candleSeries.createPriceLine({
              price: h.avgCost,
              color: "#fbbf24",
              lineWidth: 2,
              lineStyle: 2, // dashed
              axisLabelVisible: true,
              title: `取得単価 ${h.shares}株`,
            });
          }
          // アクティブシナリオのライン
          for (const s of myScenarios) {
            // エントリー価格
            if (s.entryPrice > 0) {
              candleSeries.createPriceLine({
                price: s.entryPrice,
                color: "#a78bfa",
                lineWidth: 1,
                lineStyle: 3, // dotted
                axisLabelVisible: true,
                title: `シナリオ${s.direction === "buy" ? "▲" : s.direction === "sell" ? "▼" : "◆"} ENTRY`,
              });
            }
            // 目標
            if (s.targetPrices.length > 0 && s.targetPrices[0] > 0) {
              candleSeries.createPriceLine({
                price: s.targetPrices[0],
                color: "#22c55e",
                lineWidth: 1,
                lineStyle: 0, // solid
                axisLabelVisible: true,
                title: "🎯 目標",
              });
            }
            // 損切り
            if (s.stopLossPrice > 0) {
              candleSeries.createPriceLine({
                price: s.stopLossPrice,
                color: "#ef4444",
                lineWidth: 1,
                lineStyle: 0,
                axisLabelVisible: true,
                title: "⚠ 損切り",
              });
            }
          }
        }

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
            time: c.time, value: c.volume,
            color: c.close >= c.open ? "rgba(255,59,107,0.2)" : "rgba(0,217,255,0.2)",
          }))
        );

        if (maMode === "pattern") {
          if (data.candles.length >= 5) {
            const s = chart.addLineSeries({ color: "rgba(0,255,157,0.7)", lineWidth: 1, title: "MA5" });
            s.setData(calcSMA(data.candles, 5));
          }
          if (data.candles.length >= 25) {
            const s = chart.addLineSeries({ color: "rgba(0,240,255,0.6)", lineWidth: 1, title: "MA25" });
            s.setData(calcSMA(data.candles, 25));
          }
          if (data.candles.length >= 75) {
            const s = chart.addLineSeries({ color: "rgba(255,43,214,0.6)", lineWidth: 1, title: "MA75" });
            s.setData(calcSMA(data.candles, 75));
          }
        } else {
          if (data.indicators.sma20) {
            const s = chart.addLineSeries({ color: "rgba(0,240,255,0.5)", lineWidth: 1, title: "SMA20" });
            s.setData(calcSMA(data.candles, 20));
          }
          if (data.indicators.sma50) {
            const s = chart.addLineSeries({ color: "rgba(255,43,214,0.5)", lineWidth: 1, title: "SMA50" });
            s.setData(calcSMA(data.candles, 50));
          }
        }

        chart.timeScale().fitContent();

        const totalBars = data.candles.length;
        chart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange: { from: number; to: number } | null) => {
          if (disposed || !logicalRange) return;
          const barsVisible = logicalRange.to - logicalRange.from;
          if (barsVisible > totalBars * 1.3 || logicalRange.from < -totalBars * 0.1) {
            chart.timeScale().fitContent();
          }
        });

        const observer = new ResizeObserver((entries) => {
          if (disposed) return;
          for (const entry of entries) chart?.applyOptions({ width: entry.contentRect.width });
        });
        observer.observe(chartRef.current);
      } catch (err) { console.error("Chart error:", err); }
    })();

    return () => { disposed = true; try { chart?.remove(); } catch {} };
  }, [data, interval, maMode, myHoldings, myScenarios, showOverlay]);

  const isJP = /^\d{3,4}[A-Z]?$/.test(ticker);
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
        <p className="text-[var(--color-text-secondary)]">{error ?? "データが見つかりません"}</p>
        <Link href="/portfolio" className="inline-block mt-4 text-sm text-[var(--color-accent)]" style={MONO}>{"<"} ポートフォリオに戻る</Link>
      </div>
    );
  }

  const isUp = data.change >= 0;
  const upColor = "var(--color-up)";
  const downColor = "var(--color-down)";
  const priceColor = isUp ? upColor : downColor;

  return (
    <TachibanaSnapshotProvider ticker={data.ticker}>
    <div className="space-y-4">
      {/* 戻るリンク */}
      <Link href="/portfolio" className="inline-flex items-center gap-2 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors" style={MONO}>
        {"<"} PORTFOLIO
      </Link>

      {/* ヘッダ: 銘柄名 & 価格 & アクションボタン */}
      <div className="relative p-5 rounded" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}>
        <span className="absolute top-0 right-0 w-3 h-3 border-t border-r border-[var(--color-accent)] opacity-60 rounded-tr" />
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-3">
              <span className="text-xs px-1.5 py-0.5" style={{ background: isJP ? "rgba(0,240,255,0.15)" : "rgba(255,43,214,0.15)", color: isJP ? "var(--color-accent)" : "var(--color-accent-2)", ...MONO, fontSize: "10px" }}>{isJP ? "JP" : "US"}</span>
              <span className="text-sm text-[var(--color-accent)] tracking-[0.15em]" style={MONO}>{data.ticker}</span>
              {data.exchange && <span className="text-[10px] text-[var(--color-text-secondary)] opacity-60">{data.exchange}</span>}
            </div>
            <h1 className="text-xl font-bold mt-1">{data.name}</h1>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold" style={{ color: priceColor, textShadow: `0 0 14px ${isUp ? "rgba(255,59,107,0.4)" : "rgba(0,217,255,0.4)"}`, ...MONO }}>
              {currencySymbol}{data.price.toLocaleString()}
            </div>
            <div className="flex items-center gap-2 justify-end mt-1">
              <span className="text-sm font-medium px-2 py-0.5" style={{ color: priceColor, background: isUp ? "rgba(255,59,107,0.12)" : "rgba(0,217,255,0.12)", ...MONO }}>
                {isUp ? "+" : ""}{data.change.toLocaleString()} ({isUp ? "+" : ""}{data.changePct.toFixed(2)}%)
              </span>
            </div>
          </div>
        </div>

        {/* 日中情報 */}
        <div className="flex gap-6 mt-3 text-xs text-[var(--color-text-secondary)]" style={MONO}>
          {data.dayHigh != null && <span>HIGH <span className="text-[var(--color-text)]">{currencySymbol}{data.dayHigh.toLocaleString()}</span></span>}
          {data.dayLow != null && <span>LOW <span className="text-[var(--color-text)]">{currencySymbol}{data.dayLow.toLocaleString()}</span></span>}
          {data.volume != null && <span>VOL <span className="text-[var(--color-text)]">{formatVolume(data.volume)}</span></span>}
          <span>PREV <span className="text-[var(--color-text)]">{currencySymbol}{data.prevClose.toLocaleString()}</span></span>
        </div>

        {/* ⭐ Action Buttons */}
        {user && (
          <div className="flex items-center gap-2 mt-4 flex-wrap">
            <button
              onClick={() => { setShowFavPanel(!showFavPanel); setShowAlertPanel(false); }}
              className="px-3 py-1.5 text-[10px] uppercase tracking-wider min-h-[32px] transition-all"
              style={{
                ...MONO, clipPath: clip(4),
                border: showFavPanel ? "1px solid var(--color-accent)" : "1px solid var(--color-border)",
                color: showFavPanel ? "var(--color-accent)" : "var(--color-text-secondary)",
                background: showFavPanel ? "rgba(0,240,255,0.08)" : "transparent",
              }}
            >
              ⭐ お気に入り追加
            </button>
            <button
              onClick={() => { setShowAlertPanel(!showAlertPanel); setShowFavPanel(false); }}
              className="px-3 py-1.5 text-[10px] uppercase tracking-wider min-h-[32px] transition-all"
              style={{
                ...MONO, clipPath: clip(4),
                border: showAlertPanel ? "1px solid var(--color-accent-2)" : "1px solid var(--color-border)",
                color: showAlertPanel ? "var(--color-accent-2)" : "var(--color-text-secondary)",
                background: showAlertPanel ? "rgba(255,43,214,0.08)" : "transparent",
              }}
            >
              🔔 アラート設定
            </button>
            <button
              onClick={() => setShowScenarioModal(true)}
              className="px-3 py-1.5 text-[10px] uppercase tracking-wider min-h-[32px] transition-all"
              style={{
                ...MONO, clipPath: clip(4),
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
                background: "transparent",
              }}
            >
              📋 シナリオ作成
            </button>
          </div>
        )}

        {showScenarioModal && (
          <ScenarioEditorModal
            scenario={null}
            presetTicker={data.ticker}
            presetName={data.name}
            presetMarket={data.currency === "JPY" ? "JP" : "US"}
            onClose={() => setShowScenarioModal(false)}
          />
        )}

        {/* Favorites panel */}
        {showFavPanel && user && (
          <div className="mt-3 p-3 border border-[var(--color-accent)]" style={{ clipPath: clip(8), background: "rgba(0,240,255,0.03)" }}>
            {favAdded ? (
              <div className="text-sm text-[var(--color-success)] flex items-center gap-2" style={MONO}>
                ✅ 「{favAdded}」に追加しました
              </div>
            ) : watchlistGroups.length === 0 ? (
              <div className="text-xs text-[var(--color-text-secondary)]">
                お気に入りグループがありません。<Link href="/favorites" className="text-[var(--color-accent)] underline">お気に入りページ</Link>でグループを作成してください。
              </div>
            ) : (
              <div className="space-y-2">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>追加先グループ</span>
                <div className="flex gap-2 flex-wrap">
                  {watchlistGroups.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => handleAddToFav(g.id!, g.name)}
                      className="px-3 py-1.5 text-xs min-h-[32px] transition-all hover:border-[var(--color-accent)]"
                      style={{ ...MONO, clipPath: clip(4), border: "1px solid var(--color-border)", color: "var(--color-text)", background: "transparent" }}
                    >
                      📁 {g.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Alert panel */}
        {showAlertPanel && user && (
          <div className="mt-3 p-3 border border-[var(--color-accent-2)]" style={{ clipPath: clip(8), background: "rgba(255,43,214,0.03)" }}>
            {alertAdded ? (
              <div className="text-sm text-[var(--color-success)] flex items-center gap-2" style={MONO}>
                ✅ アラートを設定しました
              </div>
            ) : (
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>価格</span>
                <input
                  type="number"
                  value={alertPrice}
                  onChange={(e) => setAlertPrice(e.target.value)}
                  className="bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text)] focus:border-[var(--color-accent-2)] focus:outline-none w-32 min-h-[32px]"
                  style={{ ...MONO, clipPath: clip(4) }}
                />
                <select
                  value={alertCondition}
                  onChange={(e) => setAlertCondition(e.target.value as "above" | "below")}
                  className="bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-1.5 text-xs text-[var(--color-text)] focus:border-[var(--color-accent-2)] focus:outline-none min-h-[32px]"
                  style={{ ...MONO, clipPath: clip(4) }}
                >
                  <option value="above">以上</option>
                  <option value="below">以下</option>
                </select>
                <button
                  onClick={handleAddAlert}
                  disabled={!alertPrice}
                  className="px-4 py-1.5 text-xs min-h-[32px] disabled:opacity-50 uppercase tracking-wider"
                  style={{ ...MONO, clipPath: clip(4), border: "1px solid var(--color-accent-2)", color: "var(--color-accent-2)", background: "transparent" }}
                >
                  設定
                </button>
                <span className="text-[9px] text-[var(--color-text-secondary)]" style={MONO}>
                  現在: {currencySymbol}{data.price.toLocaleString()}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* レンジ切替 + チャート */}
      <div className="rounded overflow-hidden" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}>
        <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5 border-b" style={{ borderColor: "var(--color-border)" }}>
          {RANGES.map((r) => (
            <button key={r.value} onClick={() => handleRangeChange(r.value)} className="px-3 py-1.5 text-xs transition-all" style={{ ...MONO, letterSpacing: "0.05em", color: range === r.value ? "var(--color-accent)" : "var(--color-text-secondary)", background: range === r.value ? "rgba(0,240,255,0.1)" : "transparent", border: range === r.value ? "1px solid rgba(0,240,255,0.3)" : "1px solid transparent" }}>
              {r.label}
            </button>
          ))}
          <span className="mx-1 h-5 w-px" style={{ background: "var(--color-border)" }} />
          {INTERVALS.filter((iv) => allowedIntervals(range).includes(iv.value)).map((iv) => (
            <button key={iv.value} onClick={() => setInterval(iv.value)} className="px-2 py-1.5 text-xs transition-all" style={{ ...MONO, letterSpacing: "0.05em", color: interval === iv.value ? "var(--color-accent-2)" : "var(--color-text-secondary)", background: interval === iv.value ? "rgba(255,43,214,0.1)" : "transparent", border: interval === iv.value ? "1px solid rgba(255,43,214,0.3)" : "1px solid transparent" }}>
              {iv.label}
            </button>
          ))}
          <span className="ml-auto flex items-center gap-3 text-[10px] pr-2" style={MONO}>
            <button onClick={() => setMaMode(maMode === "pattern" ? "analysis" : "pattern")} className="px-2 py-0.5 transition-all" style={{ border: "1px solid rgba(0,240,255,0.3)", color: "var(--color-accent)", background: "rgba(0,240,255,0.08)", fontSize: "9px", letterSpacing: "0.05em" }}>
              {maMode === "pattern" ? "PATTERN MA" : "SMA"}
            </button>
            {maMode === "pattern" ? (
              <>
                <span className="flex items-center gap-1 text-[var(--color-text-secondary)]"><span className="w-3 h-0.5" style={{ background: "rgba(0,255,157,0.7)" }} />MA5</span>
                <span className="flex items-center gap-1 text-[var(--color-text-secondary)]"><span className="w-3 h-0.5" style={{ background: "rgba(0,240,255,0.6)" }} />MA25</span>
                <span className="flex items-center gap-1 text-[var(--color-text-secondary)]"><span className="w-3 h-0.5" style={{ background: "rgba(255,43,214,0.6)" }} />MA75</span>
              </>
            ) : (
              <>
                <span className="flex items-center gap-1 text-[var(--color-text-secondary)]"><span className="w-3 h-0.5 bg-[rgba(0,240,255,0.5)]" />SMA20</span>
                <span className="flex items-center gap-1 text-[var(--color-text-secondary)]"><span className="w-3 h-0.5 bg-[rgba(255,43,214,0.5)]" />SMA50</span>
              </>
            )}
          </span>
        </div>
        {/* 保有・シナリオ・損益分岐の概要 (オーバーレイ表示時) */}
        {user && (myHoldings.length > 0 || myScenarios.length > 0) && (
          <div
            className="flex items-center justify-between gap-3 px-3 py-2 mb-2 text-[10px] flex-wrap"
            style={{
              ...MONO,
              background: "rgba(251,191,36,0.04)",
              border: "1px solid rgba(251,191,36,0.2)",
            }}
          >
            <div className="flex items-center gap-3 flex-wrap">
              {myHoldings.map((h) => {
                const cur = data.price;
                const pnl = (cur - h.avgCost) * h.shares;
                const pnlPct = ((cur - h.avgCost) / h.avgCost) * 100;
                return (
                  <span key={h.id} className="flex items-center gap-1.5">
                    <span className="w-3 h-0.5" style={{ background: "#fbbf24" }} />
                    <span className="text-[#fbbf24]">取得¥{h.avgCost}</span>
                    <span className="text-[var(--color-text-secondary)]">× {h.shares}株</span>
                    <span
                      style={{ color: pnl >= 0 ? "var(--color-accent)" : "#ff4d6d" }}
                    >
                      {pnl >= 0 ? "+" : ""}¥{Math.round(pnl).toLocaleString()} ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)
                    </span>
                  </span>
                );
              })}
              {myScenarios.map((s) => (
                <span key={s.id} className="flex items-center gap-1.5">
                  <span className="text-[#a78bfa]">📋</span>
                  <span className="text-[#a78bfa]">
                    {s.direction === "buy" ? "▲" : s.direction === "sell" ? "▼" : "◆"}¥{s.entryPrice}
                  </span>
                  <span className="text-[#22c55e]">🎯¥{s.targetPrices[0]}</span>
                  <span className="text-[#ef4444]">⚠¥{s.stopLossPrice}</span>
                </span>
              ))}
            </div>
            <button
              onClick={() => setShowOverlay(!showOverlay)}
              className="px-2 py-0.5 text-[9px]"
              style={{
                border: "1px solid rgba(251,191,36,0.3)",
                color: showOverlay ? "#fbbf24" : "var(--color-text-secondary)",
                background: showOverlay ? "rgba(251,191,36,0.08)" : "transparent",
              }}
            >
              {showOverlay ? "OVERLAY ON" : "OVERLAY OFF"}
            </button>
          </div>
        )}

        <div className="relative">
          <div ref={chartRef} className="w-full" style={{ minHeight: 400 }} />
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center" style={{ background: "rgba(5,6,13,0.75)", zIndex: 10 }}>
              <div className="flex flex-col items-center gap-3">
                <div className="loading-pulse" style={{ width: 40, height: 40, border: "2px solid rgba(0,240,255,0.3)", borderTop: "2px solid var(--color-accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite, pulse-glow 1.2s ease-in-out infinite" }} />
                <span className="text-xs text-[var(--color-accent)] loading-pulse" style={MONO}>LOADING...</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* テクニカル指標 */}
      <div className="p-5 rounded" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}>
        <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-4" style={MONO}>Technical Indicators</span>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          <IndicatorCard label="RSI (14)" value={data.indicators.rsi?.toFixed(1) ?? "—"} color={data.indicators.rsi ? data.indicators.rsi >= 70 ? upColor : data.indicators.rsi <= 30 ? downColor : "var(--color-text)" : "var(--color-text-secondary)"} sub={data.indicators.rsi ? data.indicators.rsi >= 70 ? "買われすぎ" : data.indicators.rsi <= 30 ? "売られすぎ" : "中立" : null} bar={data.indicators.rsi ? data.indicators.rsi / 100 : null} />
          <IndicatorCard label="MACD" value={data.indicators.macd?.toFixed(2) ?? "—"} color={data.indicators.macd ? data.indicators.macd > 0 ? upColor : downColor : "var(--color-text-secondary)"} sub={data.indicators.signal != null ? `Signal: ${data.indicators.signal.toFixed(2)}` : null} />
          <div>
            <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>Bollinger Bands</span>
            {data.indicators.bbUpper ? (
              <div style={MONO}>
                <div className="text-sm"><span className="text-[var(--color-text-secondary)]">Upper </span><span style={{ color: upColor }}>{currencySymbol}{data.indicators.bbUpper.toLocaleString()}</span></div>
                <div className="text-sm mt-1"><span className="text-[var(--color-text-secondary)]">Lower </span><span style={{ color: downColor }}>{currencySymbol}{data.indicators.bbLower?.toLocaleString()}</span></div>
              </div>
            ) : <span className="text-sm text-[var(--color-text-secondary)]">—</span>}
          </div>
          <div>
            <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>Moving Averages</span>
            <div style={MONO} className="text-sm space-y-1">
              <div><span className="text-[rgba(0,240,255,0.7)]">SMA20 </span><span>{data.indicators.sma20 ? `${currencySymbol}${data.indicators.sma20.toLocaleString()}` : "—"}</span></div>
              <div><span className="text-[rgba(255,43,214,0.7)]">SMA50 </span><span>{data.indicators.sma50 ? `${currencySymbol}${data.indicators.sma50.toLocaleString()}` : "—"}</span></div>
              {data.indicators.sma200 && <div><span className="text-[var(--color-text-secondary)]">SMA200 </span><span>{currencySymbol}{data.indicators.sma200.toLocaleString()}</span></div>}
            </div>
          </div>
        </div>
      </div>

      {/* 💡 インサイトパネル (一番目立つ位置) */}
      <InsightPanel ticker={data.ticker} />

      {/* 🔮 将来性スコア (Phase 1: 5因子グレード + バリュートラップ警告) */}
      <FutureScorePanel ticker={data.ticker} />

      {/* 📊 業績推移 (Yahoo 4年/4Q) */}
      <FinancialsPanel ticker={data.ticker} />

      {/* 📊 決算前後パターン分析 */}
      <EarningsPatternPanel ticker={data.ticker} />

      {/* 板情報 (日本株のみ) */}
      {/^\d{3,4}[A-Z]?$/.test(data.ticker) && (
        <OrderBookPanel ticker={data.ticker} />
      )}

      {/* 信用残・需給情報 (日本株のみ) */}
      {/^\d{3,4}[A-Z]?$/.test(data.ticker) && (
        <MarginPanel ticker={data.ticker} />
      )}

      {/* マルチタイムフレーム */}
      <div
        className="p-4 rounded"
        style={{ background: "var(--bg-card)", border: "1px solid var(--color-border)" }}
      >
        <MultiTimeframeView
          ticker={data.ticker}
          breakeven={myHoldings[0]?.avgCost}
          targetPrice={myScenarios[0]?.targetPrices[0]}
          stopLoss={myScenarios[0]?.stopLossPrice}
        />
      </div>

      {/* 関連ニュース */}
      <StockNewsPanel ticker={data.ticker} />

      {/* チャートパターン */}
      <PatternPanel patterns={patterns} loading={patternsLoading} transitions={transitions} />

      {/* 総合分析スコア（パターン統合版） */}
      <IntegratedScorePanel indicators={data.indicators} price={data.price} patterns={patterns} transitions={transitions} currencySymbol={currencySymbol} />
    </div>
    </TachibanaSnapshotProvider>
  );
}

// ========================================
// サブコンポーネント
// ========================================

function IndicatorCard({ label, value, color, sub, bar }: { label: string; value: string; color: string; sub?: string | null; bar?: number | null }) {
  return (
    <div>
      <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>{label}</span>
      <div className="text-xl font-bold" style={{ color, ...MONO }}>{value}</div>
      {sub && <span className="text-[10px] text-[var(--color-text-secondary)] mt-0.5 block">{sub}</span>}
      {bar != null && (
        <div className="mt-2 h-1 bg-[var(--bg-input)] rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${bar * 100}%`, backgroundColor: color }} />
        </div>
      )}
    </div>
  );
}

function PatternPanel({ patterns, loading, transitions }: { patterns: Record<string, PatternData[]>; loading: boolean; transitions?: Array<{ fromId: string; toId: string; toLabel: string; signal: string; triggerConditions: string[]; probability: string; proximity: number }> | null }) {
  const timeframes = ["daily", "weekly", "monthly"] as const;
  const tfLabels: Record<string, string> = { daily: "日足", weekly: "週足", monthly: "月足" };
  const tfLabelsEn: Record<string, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };
  const hasAny = timeframes.some((tf) => (patterns[tf]?.length ?? 0) > 0);

  if (loading) {
    return (
      <div className="p-4 rounded" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}>
        <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>Chart Patterns</span>
        <div className="mt-3 text-xs text-[var(--color-accent)] loading-pulse" style={MONO}>パターン分析中...</div>
      </div>
    );
  }

  if (!hasAny) return null;

  return (
    <div className="p-4 rounded space-y-4" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)", boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.06), 0 0 14px rgba(0,240,255,0.08)" }}>
      <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block" style={MONO}>Chart Patterns</span>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {timeframes.map((tf) => {
          const pats = patterns[tf];
          if (!pats || pats.length === 0) return null;
          const top = pats[0];
          return (
            <div key={tf} className="p-3 rounded space-y-2" style={{ background: "rgba(0,240,255,0.03)", border: "1px solid var(--color-border)" }}>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-[var(--color-text-secondary)] uppercase tracking-[0.1em]" style={MONO}>{tfLabelsEn[tf]} / {tfLabels[tf]}</span>
                {top.confidence > 0 && <span className="text-[9px] text-[var(--color-text-secondary)]" style={MONO}>conf: {top.confidence}</span>}
              </div>
              <PatternBadge pattern={top} size="md" showConfidence={false} />
              <p className="text-[11px] text-[var(--color-text)] opacity-70 leading-relaxed">{top.description}</p>
              {top.summary && (
                <div className="flex gap-2 flex-wrap text-[9px] text-[var(--color-text-secondary)]" style={MONO}>
                  <span>MA: {top.summary.maOrder === "bull" ? "🟢Bull" : top.summary.maOrder === "bear" ? "🔴Bear" : "⚪Mix"}</span>
                  <span>ROC5: {top.summary.roc5 > 0 ? "+" : ""}{top.summary.roc5}%</span>
                  <span>ROC20: {top.summary.roc20 > 0 ? "+" : ""}{top.summary.roc20}%</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {transitions && transitions.length > 0 && (
        <div className="space-y-3 pt-3" style={{ borderTop: "1px solid var(--color-border)" }}>
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-accent)] block" style={MONO}>▸ Next Pattern Predictions</span>
          {transitions.map((t, idx) => {
            const ss = t.signal === "buy" ? { bg: "rgba(255,59,107,0.08)", border: "rgba(255,59,107,0.3)", color: "#ff3b6b", label: "買" } : t.signal === "sell" ? { bg: "rgba(0,217,255,0.08)", border: "rgba(0,217,255,0.3)", color: "#00d9ff", label: "売" } : t.signal === "watch" ? { bg: "rgba(255,176,0,0.08)", border: "rgba(255,176,0,0.3)", color: "#ffb000", label: "注目" } : { bg: "rgba(106,122,154,0.08)", border: "rgba(106,122,154,0.3)", color: "#8a9aba", label: "中立" };
            const probLabel = t.probability === "high" ? "高" : t.probability === "medium" ? "中" : "低";
            return (
              <div key={idx} className="p-3 rounded space-y-2" style={{ background: ss.bg, border: `1px solid ${ss.border}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold" style={{ ...MONO, color: ss.color }}>→ {t.toLabel}</span>
                    <span className="text-[8px] px-1.5 py-0.5 font-bold rounded-sm" style={{ background: ss.color, color: "#05060d", ...MONO }}>{ss.label}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] text-[var(--color-text-secondary)]" style={MONO}>確率: {probLabel}</span>
                    <div className="flex items-center gap-1">
                      <div className="w-16 h-1.5 bg-[var(--bg-input)] rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${t.proximity}%`, background: ss.color }} />
                      </div>
                      <span className="text-[9px]" style={{ ...MONO, color: ss.color }}>{t.proximity}%</span>
                    </div>
                  </div>
                </div>
                <div className="space-y-1">
                  <span className="text-[9px] text-[var(--color-text-secondary)] uppercase tracking-[0.05em]" style={MONO}>Trigger Conditions:</span>
                  {t.triggerConditions.map((cond, ci) => (
                    <div key={ci} className="flex items-start gap-1.5 text-[11px] text-[var(--color-text)] opacity-80">
                      <span style={{ color: ss.color }}>▹</span><span>{cond}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 統合分析スコアパネル — テクニカル指標 + パターン分析を統合
 */
function IntegratedScorePanel({
  indicators,
  price,
  patterns,
  transitions,
  currencySymbol,
}: {
  indicators: Indicators;
  price: number;
  patterns: Record<string, PatternData[]>;
  transitions?: Array<{ signal: string; proximity: number; toLabel: string }> | null;
  currencySymbol: string;
}) {
  let score = 50;
  const signals: { text: string; weight: number; type: "positive" | "negative" | "neutral" }[] = [];

  // ── Technical indicators ──
  if (indicators.rsi != null) {
    if (indicators.rsi < 30) { score += 15; signals.push({ text: "RSI 売られすぎ圏 → 反発の可能性", weight: 15, type: "positive" }); }
    else if (indicators.rsi > 70) { score -= 15; signals.push({ text: "RSI 買われすぎ圏 → 調整の可能性", weight: -15, type: "negative" }); }
    else if (indicators.rsi > 40 && indicators.rsi < 60) { score += 5; signals.push({ text: "RSI 中立圏", weight: 5, type: "neutral" }); }
  }

  if (indicators.macd != null && indicators.signal != null) {
    if (indicators.macd > indicators.signal) { score += 10; signals.push({ text: "MACD > Signal → 上昇モメンタム", weight: 10, type: "positive" }); }
    else { score -= 10; signals.push({ text: "MACD < Signal → 下降モメンタム", weight: -10, type: "negative" }); }
  }

  if (indicators.sma20 != null && indicators.sma50 != null) {
    if (price > indicators.sma20 && indicators.sma20 > indicators.sma50) { score += 10; signals.push({ text: `価格 > SMA20 > SMA50 → ゴールデンクロス圏`, weight: 10, type: "positive" }); }
    else if (price < indicators.sma20 && indicators.sma20 < indicators.sma50) { score -= 10; signals.push({ text: `価格 < SMA20 < SMA50 → デッドクロス圏`, weight: -10, type: "negative" }); }
  }

  if (indicators.bbUpper != null && indicators.bbLower != null) {
    if (price >= indicators.bbUpper) { score -= 5; signals.push({ text: "BB上限タッチ → 過熱注意", weight: -5, type: "negative" }); }
    else if (price <= indicators.bbLower) { score += 5; signals.push({ text: "BB下限タッチ → 割安圏", weight: 5, type: "positive" }); }
  }

  // ── Pattern analysis ──
  const dailyPattern = patterns["daily"]?.[0];
  if (dailyPattern) {
    if (dailyPattern.signal === "buy") { score += 10; signals.push({ text: `パターン「${dailyPattern.label}」→ 買いシグナル`, weight: 10, type: "positive" }); }
    else if (dailyPattern.signal === "sell") { score -= 10; signals.push({ text: `パターン「${dailyPattern.label}」→ 売りシグナル`, weight: -10, type: "negative" }); }
    else if (dailyPattern.signal === "watch") { signals.push({ text: `パターン「${dailyPattern.label}」→ 注目`, weight: 0, type: "neutral" }); }
  }

  // Weekly pattern for longer-term confirmation
  const weeklyPattern = patterns["weekly"]?.[0];
  if (weeklyPattern) {
    if (dailyPattern && weeklyPattern.signal === dailyPattern.signal && weeklyPattern.signal !== "neutral") {
      score += 5;
      signals.push({ text: `日足・週足パターン一致 → シグナル強化`, weight: 5, type: weeklyPattern.signal === "buy" ? "positive" : "negative" });
    }
  }

  // Transition proximity
  if (transitions && transitions.length > 0) {
    const highProx = transitions.filter((t) => t.proximity >= 50);
    for (const t of highProx.slice(0, 2)) {
      if (t.signal === "buy") { score += 3; signals.push({ text: `転換接近: →${t.toLabel} (${t.proximity}%) 買い`, weight: 3, type: "positive" }); }
      else if (t.signal === "sell") { score -= 3; signals.push({ text: `転換接近: →${t.toLabel} (${t.proximity}%) 売り`, weight: -3, type: "negative" }); }
    }
  }

  score = Math.max(0, Math.min(100, score));

  const getColor = (s: number) => s >= 65 ? "var(--color-up)" : s >= 40 ? "#f0a030" : "var(--color-down)";
  const getLabel = (s: number) => s >= 75 ? "強い買いシグナル" : s >= 60 ? "買い検討" : s >= 45 ? "中立" : s >= 30 ? "様子見" : "売り検討";
  const getEmoji = (s: number) => s >= 75 ? "🔥" : s >= 60 ? "📈" : s >= 45 ? "➡️" : s >= 30 ? "⚠️" : "📉";

  // Support/Resistance levels
  const levels: { label: string; price: number; type: "support" | "resistance" }[] = [];
  if (indicators.sma20) levels.push({ label: "SMA20", price: indicators.sma20, type: price > indicators.sma20 ? "support" : "resistance" });
  if (indicators.sma50) levels.push({ label: "SMA50", price: indicators.sma50, type: price > indicators.sma50 ? "support" : "resistance" });
  if (indicators.sma200) levels.push({ label: "SMA200", price: indicators.sma200, type: price > indicators.sma200 ? "support" : "resistance" });
  if (indicators.bbUpper) levels.push({ label: "BB上限", price: indicators.bbUpper, type: "resistance" });
  if (indicators.bbLower) levels.push({ label: "BB下限", price: indicators.bbLower, type: "support" });

  const supports = levels.filter((l) => l.type === "support").sort((a, b) => b.price - a.price);
  const resistances = levels.filter((l) => l.type === "resistance").sort((a, b) => a.price - b.price);

  return (
    <div className="p-5 rounded space-y-5" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)", boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.06)" }}>
      <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block" style={MONO}>Integrated Analysis</span>

      <div className="flex items-center gap-6 flex-wrap">
        <div>
          <div className="text-5xl font-bold" style={{ color: getColor(score), textShadow: `0 0 20px ${getColor(score)}40`, ...MONO }}>{score}</div>
          <div className="text-[9px] text-[var(--color-text-secondary)] mt-1" style={MONO}>/ 100</div>
        </div>
        <div className="flex-1">
          <div className="text-lg font-bold flex items-center gap-2" style={{ color: getColor(score) }}>
            <span>{getEmoji(score)}</span> {getLabel(score)}
          </div>
          <div className="mt-2 h-2.5 bg-[var(--bg-input)] overflow-hidden" style={{ clipPath: clip(2) }}>
            <div className="h-full transition-all duration-1000" style={{ width: `${score}%`, background: `linear-gradient(90deg, var(--color-accent), ${getColor(score)})`, boxShadow: `0 0 8px ${getColor(score)}80` }} />
          </div>
          {dailyPattern && (
            <div className="mt-2 text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
              パターン: {dailyPattern.label} | テクニカル + パターン統合スコア
            </div>
          )}
        </div>
      </div>

      {/* Support / Resistance */}
      {levels.length > 0 && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--color-up)] block mb-2" style={MONO}>📈 サポートライン</span>
            {supports.length > 0 ? supports.map((l) => (
              <div key={l.label} className="flex items-center justify-between text-xs py-1" style={MONO}>
                <span className="text-[var(--color-text-secondary)]">{l.label}</span>
                <span className="text-[var(--color-text)]">{currencySymbol}{l.price.toLocaleString()}</span>
              </div>
            )) : <span className="text-[10px] text-[var(--color-text-secondary)]">—</span>}
          </div>
          <div>
            <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--color-down)] block mb-2" style={MONO}>📉 レジスタンスライン</span>
            {resistances.length > 0 ? resistances.map((l) => (
              <div key={l.label} className="flex items-center justify-between text-xs py-1" style={MONO}>
                <span className="text-[var(--color-text-secondary)]">{l.label}</span>
                <span className="text-[var(--color-text)]">{currencySymbol}{l.price.toLocaleString()}</span>
              </div>
            )) : <span className="text-[10px] text-[var(--color-text-secondary)]">—</span>}
          </div>
        </div>
      )}

      {/* Signal breakdown */}
      <div className="space-y-1.5 pt-3" style={{ borderTop: "1px solid var(--color-border)" }}>
        <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-2" style={MONO}>Signal Breakdown</span>
        {signals.map((s, i) => (
          <div key={i} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5" style={{ color: s.type === "positive" ? "var(--color-up)" : s.type === "negative" ? "var(--color-down)" : "var(--color-text-secondary)" }}>
              {s.type === "positive" ? "▲" : s.type === "negative" ? "▼" : "▸"}
            </span>
            <span className="text-[var(--color-text)] opacity-80">{s.text}</span>
            <span className="ml-auto text-[9px] font-bold" style={{ ...MONO, color: s.weight > 0 ? "var(--color-up)" : s.weight < 0 ? "var(--color-down)" : "var(--color-text-secondary)" }}>
              {s.weight > 0 ? `+${s.weight}` : s.weight < 0 ? String(s.weight) : "±0"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ========================================
// ユーティリティ
// ========================================

function calcSMA(candles: Candle[], period: number): { time: string | number; value: number }[] {
  const result: { time: string | number; value: number }[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
    result.push({ time: candles[i].time, value: Math.round((sum / period) * 100) / 100 });
  }
  return result;
}

function formatVolume(v: number): string {
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return v.toString();
}
