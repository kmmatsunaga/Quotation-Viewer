"use client";

import { useState } from "react";
import useSWR from "swr";
import { IndexCard } from "@/components/IndexCard";
import { IndexDetailChart } from "@/components/IndexDetailChart";
import { NewsCard } from "@/components/NewsCard";
import { StockRow } from "@/components/StockRow";
import {
  fetcher,
  fetchIndicesUrl,
  fetchMarketNewsUrl,
  fetchPortfolioNewsUrl,
  fetchJPStocksUrl,
  fetchUSStocksUrl,
  type IndexData,
  type IndexCandle,
  type NewsItem,
  type StockData,
} from "@/lib/api";

const timeframes = [
  { key: "1m", label: "1分" },
  { key: "5m", label: "5分" },
  { key: "15m", label: "15分" },
  { key: "1d", label: "日足" },
  { key: "1w", label: "週足" },
  { key: "1M", label: "月足" },
];

export default function MarketOverview() {
  const [selectedTimeframe, setSelectedTimeframe] = useState("1d");
  const [selectedIndexName, setSelectedIndexName] = useState<string | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawIndices } = useSWR<any[]>(
    fetchIndicesUrl(),
    fetcher,
    { refreshInterval: 30000 }
  );
  // APIレスポンスを統一形式に変換
  const indices: IndexData[] | undefined = rawIndices?.map((d) => {
    const candles: IndexCandle[] = Array.isArray(d.chart)
      ? d.chart
          .filter((c: { close?: number | null }) => c.close != null)
          .map((c: {
            time: string;
            open?: number;
            high?: number;
            low?: number;
            close: number;
            volume?: number;
          }) => ({
            time: c.time,
            open: c.open ?? c.close,
            high: c.high ?? c.close,
            low: c.low ?? c.close,
            close: c.close,
            volume: c.volume,
          }))
      : [];
    return {
      name: d.name ?? "",
      value: d.price ?? d.value ?? 0,
      change: d.change_pct ?? d.change ?? 0,
      change_pct: d.change_pct ?? d.change ?? 0,
      chart_data: candles.length
        ? candles.map((c) => c.close)
        : d.chart_data ?? [],
      candles,
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawMarketNews } = useSWR<any[]>(fetchMarketNewsUrl(), fetcher, { refreshInterval: 60000 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawPortfolioNews } = useSWR<any[]>(fetchPortfolioNewsUrl(), fetcher, { refreshInterval: 60000 });
  // APIレスポンスを統一形式に変換
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapNews = (d: any): NewsItem => ({
    title: d.title ?? "",
    url: d.link ?? d.url ?? "#",
    publisher: d.publisher ?? "",
    published_at: d.published ?? d.published_at ?? "",
    thumbnail: d.thumbnail ?? undefined,
  });
  const marketNews = rawMarketNews?.map(mapNews);
  const portfolioNews = rawPortfolioNews?.map(mapNews);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawJP } = useSWR<any[]>(fetchJPStocksUrl(), fetcher, { refreshInterval: 30000 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawUS } = useSWR<any[]>(fetchUSStocksUrl(), fetcher, { refreshInterval: 30000 });
  // APIレスポンスを統一形式に変換
  const jpStocks: StockData[] | undefined = rawJP?.map((d) => ({
    code: (d.ticker ?? d.code ?? "").replace(".T", ""),
    name: d.name_jp ?? d.name ?? "",
    price: d.price ?? 0,
    change: d.change ?? 0,
    change_pct: d.change_pct ?? 0,
  }));
  const usStocks: StockData[] | undefined = rawUS?.map((d) => ({
    code: d.ticker ?? d.code ?? "",
    name: d.name_jp ?? d.name ?? "",
    price: d.price ?? 0,
    change: d.change ?? 0,
    change_pct: d.change_pct ?? 0,
  }));

  // Demo data when API is not available
  const makeDemoCandles = (bars: number[], base: number): IndexCandle[] => {
    const now = Date.now();
    const max = Math.max(...bars, 1);
    return bars.map((v, i) => {
      const close = base * (0.98 + (v / max) * 0.04);
      const t = new Date(now - (bars.length - i) * 5 * 60 * 1000).toISOString();
      return { time: t, open: close, high: close, low: close, close };
    });
  };
  const demoIndices: IndexData[] = [
    { name: "日経平均", value: 38457.89, change: 1.24, change_pct: 1.24, chart_data: [60, 65, 62, 70, 68, 75, 72, 78, 80, 85], candles: makeDemoCandles([60, 65, 62, 70, 68, 75, 72, 78, 80, 85], 38457.89) },
    { name: "TOPIX", value: 2678.34, change: 0.89, change_pct: 0.89, chart_data: [50, 52, 55, 53, 58, 60, 57, 62, 64, 66], candles: makeDemoCandles([50, 52, 55, 53, 58, 60, 57, 62, 64, 66], 2678.34) },
    { name: "S&P 500", value: 5234.18, change: -0.45, change_pct: -0.45, chart_data: [80, 78, 75, 77, 73, 70, 72, 68, 65, 67], candles: makeDemoCandles([80, 78, 75, 77, 73, 70, 72, 68, 65, 67], 5234.18) },
    { name: "NASDAQ", value: 16432.67, change: -0.72, change_pct: -0.72, chart_data: [90, 88, 85, 82, 84, 80, 78, 75, 73, 70], candles: makeDemoCandles([90, 88, 85, 82, 84, 80, 78, 75, 73, 70], 16432.67) },
  ];

  const demoNews: NewsItem[] = [
    { title: "日銀、金融政策の現状維持を決定", url: "#", publisher: "日経新聞", published_at: "2026-04-14T10:00:00Z" },
    { title: "米国株式市場、ハイテク株が下落", url: "#", publisher: "Bloomberg", published_at: "2026-04-14T08:30:00Z" },
    { title: "円相場、一時1ドル=152円台に", url: "#", publisher: "ロイター", published_at: "2026-04-14T07:00:00Z" },
  ];

  const demoJPStocks: StockData[] = [
    { code: "7203", name: "トヨタ自動車", price: 3450, change: 45, change_pct: 1.32 },
    { code: "6758", name: "ソニーG", price: 13200, change: -180, change_pct: -1.34 },
    { code: "6861", name: "キーエンス", price: 62500, change: 850, change_pct: 1.38 },
    { code: "8306", name: "三菱UFJ", price: 1685, change: 12, change_pct: 0.72 },
    { code: "9984", name: "ソフトバンクG", price: 8920, change: -110, change_pct: -1.22 },
  ];

  const demoUSStocks: StockData[] = [
    { code: "AAPL", name: "Apple", price: 189.45, change: -2.3, change_pct: -1.20 },
    { code: "MSFT", name: "Microsoft", price: 425.80, change: 3.5, change_pct: 0.83 },
    { code: "NVDA", name: "NVIDIA", price: 876.30, change: -12.4, change_pct: -1.40 },
    { code: "GOOGL", name: "Alphabet", price: 157.20, change: 1.8, change_pct: 1.16 },
    { code: "AMZN", name: "Amazon", price: 185.60, change: 0.9, change_pct: 0.49 },
  ];

  const displayIndices = indices ?? demoIndices;
  const displayNews = marketNews ?? demoNews;
  const displayPortfolioNews = portfolioNews ?? demoNews.slice(0, 2);
  const displayJPStocks = jpStocks ?? demoJPStocks;
  const displayUSStocks = usStocks ?? demoUSStocks;

  // 選択中の指数（未選択なら先頭）
  const selectedIndex =
    displayIndices.find((idx) => idx.name === selectedIndexName) ??
    displayIndices[0];
  const selectedTimeframeLabel =
    timeframes.find((tf) => tf.key === selectedTimeframe)?.label;

  return (
    <div className="space-y-6">
      {/* Timeframe selector */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1 scrollbar-hide">
        {timeframes.map((tf) => (
          <button
            key={tf.key}
            onClick={() => setSelectedTimeframe(tf.key)}
            className={`px-3 py-1.5 text-xs font-medium whitespace-nowrap min-h-[36px] transition-all duration-200 ${
              selectedTimeframe === tf.key
                ? "bg-[var(--color-accent)] text-white"
                : "bg-[var(--bg-card)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            }`}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              clipPath: "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
              ...(selectedTimeframe === tf.key
                ? { boxShadow: "0 0 18px rgba(0,240,255,0.35), inset 0 0 0 1px rgba(0,240,255,0.15)" }
                : { boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)" }),
            }}
          >
            {tf.label}
          </button>
        ))}
      </div>

      {/* Index cards - 2x2 grid + 選択した指数の詳細チャート */}
      <section>
        <h2
          className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] mb-3"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          主要指数
        </h2>
        {selectedIndex && (
          <div className="mb-3">
            <IndexDetailChart
              name={selectedIndex.name}
              value={selectedIndex.value}
              changePct={selectedIndex.change_pct}
              candles={selectedIndex.candles}
              timeframeLabel={selectedTimeframeLabel}
            />
          </div>
        )}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {displayIndices.map((idx) => (
            <IndexCard
              key={idx.name}
              name={idx.name}
              value={idx.value}
              change={idx.change_pct}
              chartData={idx.chart_data}
              selected={selectedIndex?.name === idx.name}
              onClick={() => setSelectedIndexName(idx.name)}
            />
          ))}
        </div>
      </section>

      {/* News sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <section>
          <h2
            className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] mb-3"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            マーケットニュース
          </h2>
          <div
            className="space-y-2 bg-[var(--bg-card)] p-3 relative overflow-hidden"
            style={{
              clipPath: "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)",
              boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
            }}
          >
            {displayNews.map((news, i) => (
              <NewsCard
                key={i}
                title={news.title}
                url={news.url}
                publisher={news.publisher}
                publishedAt={news.published_at}
                thumbnail={news.thumbnail}
              />
            ))}
          </div>
        </section>

        <section>
          <h2
            className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] mb-3"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            ポートフォリオ関連ニュース
          </h2>
          <div
            className="space-y-2 bg-[var(--bg-card)] p-3 relative overflow-hidden"
            style={{
              clipPath: "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)",
              boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
            }}
          >
            {displayPortfolioNews.map((news, i) => (
              <NewsCard
                key={i}
                title={news.title}
                url={news.url}
                publisher={news.publisher}
                publishedAt={news.published_at}
                thumbnail={news.thumbnail}
              />
            ))}
          </div>
        </section>
      </div>

      {/* Stock lists */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <section>
          <h2
            className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] mb-3"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            日本株
          </h2>
          <div
            className="bg-[var(--bg-card)] overflow-hidden relative"
            style={{
              clipPath: "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)",
              boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
            }}
          >
            {displayJPStocks.map((stock) => (
              <StockRow
                key={stock.code}
                code={stock.code}
                name={stock.name}
                price={stock.price}
                changePct={stock.change_pct}
              />
            ))}
          </div>
        </section>

        <section>
          <h2
            className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] mb-3"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            米国株
          </h2>
          <div
            className="bg-[var(--bg-card)] overflow-hidden relative"
            style={{
              clipPath: "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)",
              boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
            }}
          >
            {displayUSStocks.map((stock) => (
              <StockRow
                key={stock.code}
                code={stock.code}
                name={stock.name}
                price={stock.price}
                changePct={stock.change_pct}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
