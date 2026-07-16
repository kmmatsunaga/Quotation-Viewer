"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { getHoldings, getWatchlist } from "@/lib/firestore";
import type { VolumeAnomalyEntry } from "@/app/api/stocks/volume-anomaly/route";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

type Scope = "all" | "holdings" | "watchlist";

const HEAT_CONFIG = {
  0: { color: "var(--color-text-secondary)", bg: "transparent", label: "通常" },
  1: { color: "#fbbf24", bg: "rgba(251,191,36,0.05)", label: "やや高" },
  2: { color: "#f97316", bg: "rgba(249,115,22,0.08)", label: "高" },
  3: { color: "#ef4444", bg: "rgba(239,68,68,0.12)", label: "🔥 異常" },
};

export default function AnomalyPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [scope, setScope] = useState<Scope>("all");
  const [items, setItems] = useState<VolumeAnomalyEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const [_, setTick] = useState(0);
  void _;

  const loadData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const [holdings, watchlist] = await Promise.all([
        getHoldings(user.uid),
        getWatchlist(user.uid),
      ]);
      let tickers: string[] = [];
      if (scope === "holdings") tickers = holdings.map((h) => h.ticker);
      else if (scope === "watchlist") tickers = watchlist.map((w) => w.ticker);
      else {
        tickers = Array.from(
          new Set([...holdings.map((h) => h.ticker), ...watchlist.map((w) => w.ticker)])
        );
      }

      if (tickers.length === 0) {
        setItems([]);
        return;
      }

      // 30銘柄ずつバッチ
      const batches: string[][] = [];
      for (let i = 0; i < tickers.length; i += 30) batches.push(tickers.slice(i, i + 30));

      const all: VolumeAnomalyEntry[] = [];
      for (const batch of batches) {
        const res = await fetch(
          `/api/stocks/volume-anomaly?tickers=${batch.join(",")}`
        );
        const json = await res.json();
        if (json.anomalies) all.push(...json.anomalies);
      }
      // ヒート→出来高比率の順
      all.sort((a, b) => b.heatLevel - a.heatLevel || b.volumeRatio - a.volumeRatio);
      setItems(all);
      setLastFetched(new Date());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user, scope]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 自動更新
  useEffect(() => {
    if (!autoRefresh) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        if (!document.hidden) loadData();
      }, 60000); // 1分ごと
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    if (!document.hidden) start();
    const onVis = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [autoRefresh, loadData]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const sinceText = lastFetched
    ? (() => {
        const s = Math.floor((Date.now() - lastFetched.getTime()) / 1000);
        if (s < 60) return `${s}秒前`;
        return `${Math.floor(s / 60)}分前`;
      })()
    : "未取得";

  // ヒートレベル別グループ
  const grouped = {
    extreme: items.filter((e) => e.heatLevel === 3),
    high: items.filter((e) => e.heatLevel === 2),
    elevated: items.filter((e) => e.heatLevel === 1),
    normal: items.filter((e) => e.heatLevel === 0),
  };

  return (
    <div className="space-y-4">
      {/* ヘッダー */}
      <div>
        <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">
          🔥 出来高異常検知
        </h1>
        <p className="text-xs text-[var(--color-text-secondary)] mt-1" style={MONO}>
          普段の出来高との乖離を検知。大材料・大口売買・仕手の兆候を早期発見します。
        </p>
      </div>

      {/* スコープ + 更新 */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1">
          {(["all", "holdings", "watchlist"] as const).map((s) => {
            const labels = { all: "全部", holdings: "保有のみ", watchlist: "お気に入りのみ" };
            return (
              <button
                key={s}
                onClick={() => setScope(s)}
                className="px-3 py-1.5 text-xs"
                style={{
                  border: `1px solid ${scope === s ? "var(--color-accent)" : "var(--color-border)"}`,
                  color: scope === s ? "var(--color-accent)" : "var(--color-text-secondary)",
                  background: scope === s ? "rgba(0,240,255,0.1)" : "transparent",
                  ...MONO,
                }}
              >
                {labels[s]}
              </button>
            );
          })}
        </div>

        <label className="flex items-center gap-1 text-xs cursor-pointer" style={MONO}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="w-3.5 h-3.5 accent-[var(--color-accent)]"
          />
          <span className="text-[var(--color-text-secondary)]">自動更新(60秒)</span>
        </label>

        <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
          最終: {sinceText}
        </span>

        <button
          onClick={loadData}
          disabled={loading}
          className="ml-auto px-3 py-1.5 text-xs"
          style={{
            border: "1px solid var(--color-accent-magenta)",
            color: "var(--color-accent-magenta)",
            ...MONO,
          }}
        >
          {loading ? "..." : "🔄 更新"}
        </button>
      </div>

      {/* サマリ */}
      <div className="grid grid-cols-4 gap-2">
        <SummaryCard label="🔥 異常" count={grouped.extreme.length} color={HEAT_CONFIG[3].color} />
        <SummaryCard label="高熱度" count={grouped.high.length} color={HEAT_CONFIG[2].color} />
        <SummaryCard label="やや高" count={grouped.elevated.length} color={HEAT_CONFIG[1].color} />
        <SummaryCard label="通常" count={grouped.normal.length} color={HEAT_CONFIG[0].color} />
      </div>

      {error && (
        <div className="text-xs text-red-400 p-3" style={{ border: "1px solid rgba(239,68,68,0.3)", ...MONO }}>
          {error}
        </div>
      )}

      {items.length === 0 ? (
        <div className="text-center py-12 text-[var(--color-text-secondary)] text-sm" style={MONO}>
          {loading ? "解析中..." : "対象銘柄がありません"}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((e) => (
            <AnomalyCard key={e.ticker} entry={e} onClick={() => router.push(`/stock/${e.ticker}`)} />
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div
      className="p-2.5 rounded text-center"
      style={{ border: `1px solid ${color}40`, background: count > 0 ? `${color}10` : "transparent", ...MONO }}
    >
      <div className="text-[10px] text-[var(--color-text-secondary)]">{label}</div>
      <div className="text-lg font-bold" style={{ color: count > 0 ? color : "var(--color-text-secondary)" }}>
        {count}
      </div>
    </div>
  );
}

function AnomalyCard({ entry, onClick }: { entry: VolumeAnomalyEntry; onClick: () => void }) {
  const heat = HEAT_CONFIG[entry.heatLevel];
  const isUp = entry.changePct >= 0;
  return (
    <button
      onClick={onClick}
      className="w-full text-left p-3 rounded transition-all hover:brightness-125"
      style={{ border: `1px solid ${heat.color}40`, background: heat.bg }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-[var(--color-accent)]" style={MONO}>
            {entry.ticker}
          </span>
          <span className="text-xs text-[var(--color-text)]">{entry.name}</span>
        </div>
        <div className="flex items-center gap-3 text-xs" style={MONO}>
          <span style={{ color: isUp ? "#ff3b6b" : "#00d9ff" }}>
            ¥{entry.currentPrice.toLocaleString()} ({isUp ? "+" : ""}{entry.changePct.toFixed(2)}%)
          </span>
          <span
            className="px-2 py-0.5 rounded font-bold"
            style={{
              background: `${heat.color}20`,
              color: heat.color,
              border: `1px solid ${heat.color}60`,
            }}
          >
            出来高 ×{entry.volumeRatio.toFixed(1)}
          </span>
        </div>
      </div>

      {/* シグナルタグ */}
      {entry.signals.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {entry.signals.map((sig, i) => (
            <span
              key={i}
              className="text-[10px] px-1.5 py-0.5"
              style={{
                background: "rgba(0,240,255,0.08)",
                color: "var(--color-text)",
                ...MONO,
              }}
            >
              {sig}
            </span>
          ))}
        </div>
      )}

      {/* 詳細 */}
      <div className="grid grid-cols-4 gap-2 mt-2 text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
        <div>
          <span>当日: </span>
          <span className="text-[var(--color-text)]">{formatVol(entry.todayVolume)}</span>
        </div>
        <div>
          <span>20日平均: </span>
          <span className="text-[var(--color-text)]">{formatVol(entry.avgVolume20d)}</span>
        </div>
        <div>
          <span>ROC5: </span>
          <span style={{ color: entry.roc5 >= 0 ? "#22c55e" : "#ef4444" }}>
            {entry.roc5 >= 0 ? "+" : ""}{entry.roc5.toFixed(2)}%
          </span>
        </div>
        <div>
          <span>ROC20: </span>
          <span style={{ color: entry.roc20 >= 0 ? "#22c55e" : "#ef4444" }}>
            {entry.roc20 >= 0 ? "+" : ""}{entry.roc20.toFixed(2)}%
          </span>
        </div>
      </div>
    </button>
  );
}

function formatVol(v: number): string {
  if (v >= 1e6) return `${(v / 1e4).toFixed(0)}万`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return v.toLocaleString();
}
