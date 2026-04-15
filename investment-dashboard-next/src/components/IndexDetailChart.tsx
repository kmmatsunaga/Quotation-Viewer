"use client";

import { useEffect, useRef } from "react";
import type { IndexCandle } from "@/lib/api";

interface IndexDetailChartProps {
  name: string;
  value: number;
  changePct: number;
  candles?: IndexCandle[];
  timeframeLabel?: string;
}

export function IndexDetailChart({
  name,
  value,
  changePct,
  candles,
  timeframeLabel,
}: IndexDetailChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);

  const isUp = changePct >= 0;
  const color = isUp ? "var(--color-up)" : "var(--color-down)";
  const colorHex = isUp ? "#ff5252" : "#448aff";
  const arrow = isUp ? "+" : "";
  const changeValue = (value * changePct) / 100;

  useEffect(() => {
    if (!candles?.length || !chartContainerRef.current) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let chart: any = null;
    let resizeObserver: ResizeObserver | null = null;
    let cancelled = false;

    (async () => {
      try {
        const { createChart } = await import("lightweight-charts");
        if (cancelled || !chartContainerRef.current) return;

        chart = createChart(chartContainerRef.current, {
          width: chartContainerRef.current.clientWidth,
          height: 180,
          layout: {
            background: { color: "transparent" },
            textColor: "#9e9e9e",
            fontSize: 10,
          },
          grid: {
            vertLines: { color: "rgba(255,255,255,0.04)" },
            horzLines: { color: "rgba(255,255,255,0.04)" },
          },
          timeScale: {
            borderVisible: false,
            timeVisible: true,
            secondsVisible: false,
          },
          rightPriceScale: {
            borderVisible: false,
          },
          handleScroll: false,
          handleScale: false,
          crosshair: {
            horzLine: { visible: false },
            vertLine: { labelVisible: false },
          },
        });

        const areaSeries = chart.addAreaSeries({
          lineColor: colorHex,
          topColor: isUp ? "rgba(255,82,82,0.3)" : "rgba(68,138,255,0.3)",
          bottomColor: isUp ? "rgba(255,82,82,0.02)" : "rgba(68,138,255,0.02)",
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
        });

        const data = candles
          .filter((c) => c.close != null)
          .map((c) => ({
            time: (new Date(c.time).getTime() / 1000) as number,
            value: c.close,
          }));
        // lightweight-charts requires strictly ascending & unique times
        const dedup: typeof data = [];
        let prevTime = -Infinity;
        for (const p of data) {
          if (p.time > prevTime) {
            dedup.push(p);
            prevTime = p.time;
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        areaSeries.setData(dedup as any);
        chart.timeScale().fitContent();

        resizeObserver = new ResizeObserver((entries) => {
          if (!chart || !entries[0]) return;
          chart.applyOptions({ width: entries[0].contentRect.width });
        });
        resizeObserver.observe(chartContainerRef.current);
      } catch (e) {
        console.error("chart init failed", e);
      }
    })();

    return () => {
      cancelled = true;
      if (resizeObserver) resizeObserver.disconnect();
      if (chart) chart.remove();
    };
  }, [candles, colorHex, isUp]);

  return (
    <div className="bg-card rounded-xl border border-[var(--color-border)] overflow-hidden">
      {/* ヘッダー：銘柄名・価格・変化率 */}
      <div className="p-4 pb-2 flex items-start justify-between">
        <div>
          <div className="text-xs text-[var(--color-text-secondary)] mb-1">
            {name}
          </div>
          <div
            className="text-2xl md:text-3xl font-bold tabular-nums"
            style={{ color }}
          >
            {value.toLocaleString("ja-JP", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </div>
          <div
            className="text-sm font-medium mt-1 tabular-nums"
            style={{ color }}
          >
            {arrow}
            {changeValue.toLocaleString("ja-JP", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{" "}
            ({arrow}
            {changePct.toFixed(2)}%)
          </div>
        </div>
        {timeframeLabel && (
          <span className="text-xs text-[var(--color-text-secondary)] bg-[var(--bg-primary)] px-2 py-1 rounded">
            {timeframeLabel}
          </span>
        )}
      </div>

      {/* チャート */}
      <div
        ref={chartContainerRef}
        className="w-full"
        style={{ height: 180 }}
      />
      {(!candles || candles.length === 0) && (
        <div className="h-[180px] flex items-center justify-center text-xs text-[var(--color-text-secondary)]">
          チャートデータがありません
        </div>
      )}
    </div>
  );
}
