"use client";

import useSWR from "swr";
import { fetcher, fetchFavoritesUrl, type FavoriteStock } from "@/lib/api";

function MiniChart({ data, color }: { data: number[]; color: string }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const w = 120;
  const h = 40;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-10">
      <defs>
        <filter id={`glow-${color.replace(/[^a-zA-Z0-9]/g, "")}`}>
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter={`url(#glow-${color.replace(/[^a-zA-Z0-9]/g, "")})`}
      />
    </svg>
  );
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.min(Math.max(score, 0), 100);
  let barColor = "var(--color-down)";
  if (pct >= 70) barColor = "var(--color-up)";
  else if (pct >= 40) barColor = "var(--color-warning)";

  return (
    <div className="flex items-center gap-2">
      <div
        className="flex-1 h-1.5 overflow-hidden"
        style={{
          backgroundColor: "var(--bg-input)",
          clipPath:
            "polygon(3px 0, 100% 0, 100% calc(100% - 3px), calc(100% - 3px) 100%, 0 100%, 0 3px)",
        }}
      >
        <div
          className="h-full transition-all duration-500"
          style={{
            width: `${pct}%`,
            backgroundColor: barColor,
            boxShadow: `0 0 6px ${barColor}`,
          }}
        />
      </div>
      <span
        className="text-xs font-medium"
        style={{
          color: barColor,
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {pct}
      </span>
    </div>
  );
}

export default function FavoritesPage() {
  const { data: favorites } = useSWR<FavoriteStock[]>(
    fetchFavoritesUrl(),
    fetcher,
    { refreshInterval: 30000 }
  );

  const demoFavorites: FavoriteStock[] = [
    { code: "7203", name: "トヨタ自動車", price: 3450, change: 45, change_pct: 1.32, score: 78, chart_data: [3300, 3320, 3380, 3350, 3400, 3420, 3390, 3450] },
    { code: "6758", name: "ソニーG", price: 13200, change: -180, change_pct: -1.34, score: 62, chart_data: [13500, 13450, 13380, 13400, 13300, 13250, 13220, 13200] },
    { code: "6861", name: "キーエンス", price: 62500, change: 850, change_pct: 1.38, score: 85, chart_data: [61000, 61200, 61500, 61800, 62000, 62200, 62400, 62500] },
    { code: "9984", name: "ソフトバンクG", price: 8920, change: -110, change_pct: -1.22, score: 45, chart_data: [9100, 9050, 9000, 8980, 8950, 8930, 8910, 8920] },
    { code: "AAPL", name: "Apple", price: 189.45, change: -2.3, change_pct: -1.20, score: 72, chart_data: [192, 191.5, 191, 190.5, 190, 189.8, 189.5, 189.45] },
    { code: "NVDA", name: "NVIDIA", price: 876.30, change: 12.4, change_pct: 1.44, score: 91, chart_data: [860, 862, 865, 868, 870, 872, 874, 876.3] },
  ];

  const displayFavorites = favorites ?? demoFavorites;

  return (
    <div className="space-y-4">
      <h1
        className="text-lg font-bold tracking-wide"
        style={{
          fontFamily: "'Orbitron', sans-serif",
          background: "linear-gradient(90deg, #00f0ff 0%, #ff2bd6 100%)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
        }}
      >
        お気に入り銘柄
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {displayFavorites.map((stock) => {
          const isUp = stock.change_pct >= 0;
          const color = isUp ? "var(--color-up)" : "var(--color-down)";
          const arrow = isUp ? "+" : "";

          return (
            <div
              key={stock.code}
              className="relative bg-card p-4 border border-[var(--color-border)] hover:border-[var(--color-accent)]/30 transition-all duration-200"
              style={{
                clipPath:
                  "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)",
                boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
              }}
            >
              {/* Corner ticks */}
              <span className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-accent)] opacity-60" />
              <span className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[var(--color-accent-2)] opacity-60" />

              {/* Chart */}
              <MiniChart data={stock.chart_data ?? []} color={color} />

              {/* Info */}
              <div className="mt-3 flex items-start justify-between">
                <div>
                  <span
                    className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    {stock.code}
                  </span>
                  <h3 className="text-sm font-medium">{stock.name}</h3>
                </div>
                <div className="text-right">
                  <div
                    className="text-base font-bold"
                    style={{
                      color,
                      fontFamily: "'JetBrains Mono', monospace",
                      textShadow: `0 0 8px ${isUp ? "rgba(255,59,107,0.4)" : "rgba(0,217,255,0.4)"}`,
                    }}
                  >
                    {stock.price.toLocaleString("ja-JP", {
                      minimumFractionDigits: stock.price < 1000 ? 2 : 0,
                    })}
                  </div>
                  <span
                    className="text-xs font-medium px-1.5 py-0.5 inline-block mt-0.5"
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      color,
                      backgroundColor: isUp
                        ? "rgba(255,59,107,0.10)"
                        : "rgba(0,217,255,0.10)",
                      border: `1px solid ${isUp ? "rgba(255,59,107,0.5)" : "rgba(0,217,255,0.5)"}`,
                      boxShadow: `0 0 8px ${isUp ? "rgba(255,59,107,0.25)" : "rgba(0,217,255,0.25)"}`,
                      clipPath:
                        "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
                    }}
                  >
                    {arrow}
                    {stock.change_pct.toFixed(2)}%
                  </span>
                </div>
              </div>

              {/* Score */}
              {stock.score !== undefined && (
                <div className="mt-3">
                  <span
                    className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    スコア
                  </span>
                  <ScoreBar score={stock.score} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
