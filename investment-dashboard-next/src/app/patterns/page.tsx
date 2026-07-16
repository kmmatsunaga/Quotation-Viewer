"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import {
  PATTERNS,
  DIRECTION_LABELS,
  PHASE_LABELS,
  buildPatternGrid,
  type PatternInfo,
  type PatternDirection,
  type PatternPhase,
} from "@/lib/chart-patterns";
import PatternBadge, { type PatternData } from "@/components/PatternBadge";
import { STOCK_LIST } from "@/lib/stock-list";
import { NIKKEI225 } from "@/lib/nikkei225";
import {
  getWatchedPatterns,
  setWatchedPatterns,
  getPatternAlertSettings,
  getWatchlist,
  getWatchlistGroups,
  addToWatchlist,
  removeFromWatchlist,
  type WatchlistItem,
  type WatchlistGroup,
} from "@/lib/firestore";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };
const clip = (px = 6) =>
  `polygon(${px}px 0, 100% 0, 100% calc(100% - ${px}px), calc(100% - ${px}px) 100%, 0 100%, 0 ${px}px)`;

const DIRECTION_ORDER: PatternDirection[] = [
  "strong_up", "mild_up", "sideways", "mild_down", "strong_down",
];
const PHASE_ORDER: PatternPhase[] = [
  "early", "mid", "late", "reversal_early", "reversal_mid",
];

const DIRECTION_COLORS: Record<PatternDirection, string> = {
  strong_up: "#ff3b6b",
  mild_up: "#ff7b9b",
  sideways: "#8a9aba",
  mild_down: "#5bc0de",
  strong_down: "#00d9ff",
};

type ScanSource = "stock_list" | "nikkei225";

interface TickerPattern {
  ticker: string;
  name: string;
  patterns: Record<string, PatternData[]>;
}

// sessionStorage keys
const SS_SCAN_RESULTS = "cavka_pattern_scanResults";
const SS_SCAN_SOURCE = "cavka_pattern_scanSource";
const SS_SCANNED_ALL = "cavka_pattern_scannedAll";
const SS_TIMEFRAME = "cavka_pattern_timeframe";

function loadScanCache(): { results: TickerPattern[]; source: ScanSource; scannedAll: boolean; timeframe: "daily" | "weekly" } | null {
  try {
    const raw = sessionStorage.getItem(SS_SCAN_RESULTS);
    if (!raw) return null;
    const results = JSON.parse(raw) as TickerPattern[];
    const source = (sessionStorage.getItem(SS_SCAN_SOURCE) ?? "nikkei225") as ScanSource;
    const scannedAll = sessionStorage.getItem(SS_SCANNED_ALL) === "true";
    const timeframe = (sessionStorage.getItem(SS_TIMEFRAME) ?? "daily") as "daily" | "weekly";
    return { results, source, scannedAll, timeframe };
  } catch { return null; }
}

function saveScanCache(results: TickerPattern[], source: ScanSource, scannedAll: boolean, timeframe: string) {
  try {
    sessionStorage.setItem(SS_SCAN_RESULTS, JSON.stringify(results));
    sessionStorage.setItem(SS_SCAN_SOURCE, source);
    sessionStorage.setItem(SS_SCANNED_ALL, String(scannedAll));
    sessionStorage.setItem(SS_TIMEFRAME, timeframe);
  } catch {}
}

export default function PatternsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [selectedPattern, setSelectedPattern] = useState<PatternInfo | null>(null);
  const [timeframe, setTimeframe] = useState<"daily" | "weekly">("daily");
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<TickerPattern[]>([]);
  const [scannedAll, setScannedAll] = useState(false);
  const [scanSource, setScanSource] = useState<ScanSource>("nikkei225");
  const [scanProgress, setScanProgress] = useState({ done: 0, total: 0 });

  // Restore scan cache on mount
  useEffect(() => {
    const cache = loadScanCache();
    if (cache && cache.results.length > 0) {
      setScanResults(cache.results);
      setScanSource(cache.source);
      setScannedAll(cache.scannedAll);
      setTimeframe(cache.timeframe);
      setScanProgress({ done: cache.results.length, total: cache.results.length });
    }
  }, []);

  // Watched patterns
  const [watchedPatterns, setWatchedPatternsState] = useState<Set<string>>(new Set());
  const [watchedLoading, setWatchedLoading] = useState(true);
  const [lineEnabled, setLineEnabled] = useState(false);

  // Watchlist (お気に入り)
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([]);
  const [watchlistGroups, setWatchlistGroups] = useState<WatchlistGroup[]>([]);
  const [openStarTicker, setOpenStarTicker] = useState<string | null>(null);

  // ticker → item id 引き換え用 (削除に必要)
  const tickerToItemId = new Map<string, string>(
    watchlistItems.filter((i) => i.id).map((i) => [i.ticker, i.id!])
  );

  // Load watchlist
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const [items, groups] = await Promise.all([
          getWatchlist(user.uid),
          getWatchlistGroups(user.uid),
        ]);
        setWatchlistItems(items);
        setWatchlistGroups(groups);
      } catch (err) {
        console.error("Failed to load watchlist:", err);
      }
    })();
  }, [user]);

  const handleAddToWatchlist = useCallback(
    async (ticker: string, name: string, market: string, groupId: string) => {
      if (!user) return;
      // 既に登録済みなら何もしない
      if (watchlistItems.some((i) => i.ticker === ticker)) return;
      try {
        const ref = await addToWatchlist(user.uid, { ticker, name, market, groupId });
        setWatchlistItems((prev) => [
          { id: ref.id, ticker, name, market, groupId },
          ...prev,
        ]);
        setOpenStarTicker(null);
      } catch (err) {
        console.error("Failed to add to watchlist:", err);
      }
    },
    [user, watchlistItems]
  );

  const handleRemoveFromWatchlist = useCallback(
    async (ticker: string) => {
      if (!user) return;
      const itemId = tickerToItemId.get(ticker);
      if (!itemId) return;
      try {
        await removeFromWatchlist(user.uid, itemId);
        setWatchlistItems((prev) => prev.filter((i) => i.ticker !== ticker));
        setOpenStarTicker(null);
      } catch (err) {
        console.error("Failed to remove from watchlist:", err);
      }
    },
    [user, tickerToItemId]
  );

  // ポップオーバー外クリックで閉じる
  useEffect(() => {
    if (!openStarTicker) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-star-popover]") && !target.closest("[data-star-button]")) {
        setOpenStarTicker(null);
      }
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [openStarTicker]);

  const patternGrid = buildPatternGrid();

  // Load watched patterns
  useEffect(() => {
    if (!user) { setWatchedLoading(false); return; }
    (async () => {
      try {
        const [watched, lineSettings] = await Promise.all([
          getWatchedPatterns(user.uid),
          getPatternAlertSettings(user.uid),
        ]);
        setWatchedPatternsState(new Set(watched));
        setLineEnabled(lineSettings.enabled && !!lineSettings.channelAccessToken && !!lineSettings.lineUserId);
      } catch {}
      setWatchedLoading(false);
    })();
  }, [user]);

  // Toggle watch
  const toggleWatch = useCallback(async (patternId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    const next = new Set(watchedPatterns);
    if (next.has(patternId)) {
      next.delete(patternId);
    } else {
      next.add(patternId);
    }
    setWatchedPatternsState(next);
    try {
      await setWatchedPatterns(user.uid, Array.from(next));
    } catch {}
  }, [user, watchedPatterns]);

  const getSourceStocks = useCallback(() => {
    return scanSource === "nikkei225"
      ? NIKKEI225.map((s) => s.ticker)
      : STOCK_LIST.map((s) => s.ticker);
  }, [scanSource]);

  // Scan stocks
  const scanStocks = useCallback(async () => {
    setScanning(true);
    setScanResults([]);
    setScannedAll(false);
    try {
      const allTickers = getSourceStocks();
      const batchSize = 10;
      const results: TickerPattern[] = [];
      setScanProgress({ done: 0, total: allTickers.length });

      for (let i = 0; i < allTickers.length; i += batchSize) {
        const batch = allTickers.slice(i, i + batchSize);
        try {
          const res = await fetch(
            `/api/stocks/patterns?tickers=${encodeURIComponent(batch.join(","))}`
          );
          if (res.ok) {
            const data = await res.json();
            for (const [ticker, info] of Object.entries(data.patterns ?? {})) {
              const p = info as { name?: string; patterns?: Record<string, PatternData[]> };
              if (p.patterns) {
                const nk = NIKKEI225.find((s) => s.ticker === ticker);
                const sl = STOCK_LIST.find((s) => s.ticker === ticker);
                results.push({
                  ticker,
                  name: nk?.name ?? sl?.name ?? p.name ?? ticker,
                  patterns: p.patterns,
                });
              }
            }
          }
        } catch {}

        setScanProgress({ done: Math.min(i + batchSize, allTickers.length), total: allTickers.length });
        const snapshot = [...results];
        setScanResults(snapshot);
        // Save incrementally to sessionStorage
        saveScanCache(snapshot, scanSource, false, timeframe);

        // Rate limiting
        if (i + batchSize < allTickers.length) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }

      setScannedAll(true);
      // Save final results to sessionStorage
      saveScanCache(results, scanSource, true, timeframe);

      // If watched patterns have matches and LINE is configured, send notification
      if (user && lineEnabled && watchedPatterns.size > 0) {
        const watchedMatches: { patternLabel: string; stocks: { ticker: string; name: string }[] }[] = [];
        for (const pid of watchedPatterns) {
          const patternInfo = PATTERNS.find((p) => p.id === pid);
          if (!patternInfo) continue;
          const matches = results.filter((r) => {
            const pats = r.patterns[timeframe];
            return pats && pats.length > 0 && pats[0].id === pid;
          });
          if (matches.length > 0) {
            watchedMatches.push({
              patternLabel: patternInfo.label,
              stocks: matches.map((m) => ({ ticker: m.ticker, name: m.name })),
            });
          }
        }

        if (watchedMatches.length > 0) {
          // Build message and send via LINE
          const lines = [
            "🔔 パターン監視アラート",
            "━━━━━━━━━━━━━━━━━",
            "",
          ];
          for (const wm of watchedMatches) {
            lines.push(`📊 ${wm.patternLabel} (${wm.stocks.length}銘柄)`);
            for (const s of wm.stocks.slice(0, 10)) {
              lines.push(`  ▸ ${s.ticker} ${s.name}`);
            }
            if (wm.stocks.length > 10) {
              lines.push(`  ... 他${wm.stocks.length - 10}銘柄`);
            }
            lines.push("");
          }
          lines.push(`🕒 ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`);

          try {
            const settings = await getPatternAlertSettings(user.uid);
            await fetch("/api/line/notify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                channelAccessToken: settings.channelAccessToken,
                userId: settings.lineUserId,
                message: lines.join("\n"),
              }),
            });
          } catch {}
        }
      }
    } catch (err) {
      console.error("Scan error:", err);
    }
    setScanning(false);
  }, [getSourceStocks, user, lineEnabled, watchedPatterns, timeframe]);

  // Matching stocks for selected pattern
  const matchingStocks = selectedPattern
    ? scanResults.filter((r) => {
        const pats = r.patterns[timeframe];
        if (!pats || pats.length === 0) return false;
        return pats[0].id === selectedPattern.id;
      })
    : [];

  // Count watched pattern matches
  const watchedMatchCount = scannedAll
    ? Array.from(watchedPatterns).reduce((sum, pid) => {
        return sum + scanResults.filter((r) => {
          const pats = r.patterns[timeframe];
          return pats && pats.length > 0 && pats[0].id === pid;
        }).length;
      }, 0)
    : 0;

  return (
    <div className="space-y-6">
      {/* ヘッダ */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-[26px] font-bold tracking-tight text-[var(--color-text)]">
          🕯 パターン <span className="text-[12px] text-[var(--color-accent)] font-normal align-middle" style={MONO}>// PATTERN SCREENER</span>
        </h1>
        <div className="flex items-center gap-2 flex-wrap">
          {/* タイムフレーム */}
          <div className="flex gap-1">
            {(["daily", "weekly"] as const).map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className="px-2.5 py-1 text-xs transition-all"
                style={{
                  ...MONO,
                  color: timeframe === tf ? "var(--color-accent)" : "var(--color-text-secondary)",
                  background: timeframe === tf ? "rgba(0,240,255,0.1)" : "transparent",
                  border: timeframe === tf ? "1px solid rgba(0,240,255,0.3)" : "1px solid transparent",
                }}
              >
                {tf === "daily" ? "日足" : "週足"}
              </button>
            ))}
          </div>

          {/* スキャンソース */}
          <select
            value={scanSource}
            onChange={(e) => setScanSource(e.target.value as ScanSource)}
            disabled={scanning}
            className="bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[28px]"
            style={{ ...MONO, clipPath: clip(3) }}
          >
            <option value="nikkei225">日経225</option>
            <option value="stock_list">主要銘柄</option>
          </select>

          {/* スキャンボタン */}
          <button
            onClick={scanStocks}
            disabled={scanning}
            className="px-4 py-1.5 text-xs font-medium transition-all disabled:opacity-50"
            style={{
              border: "1px solid var(--color-accent)",
              background: scanning ? "rgba(0,240,255,0.15)" : "rgba(0,240,255,0.08)",
              color: "var(--color-accent)",
              boxShadow: scanning ? "0 0 12px rgba(0,240,255,0.3)" : "none",
              ...MONO,
              clipPath: clip(4),
            }}
          >
            {scanning
              ? `SCANNING... ${scanProgress.done}/${scanProgress.total}`
              : scannedAll
              ? `RE-SCAN (${scanResults.length}銘柄)`
              : "SCAN"}
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {scanning && (
        <div className="w-full h-1.5 bg-[var(--color-border)] overflow-hidden" style={{ clipPath: clip(1) }}>
          <div
            className="h-full transition-all duration-500"
            style={{
              width: `${scanProgress.total > 0 ? (scanProgress.done / scanProgress.total) * 100 : 0}%`,
              background: "linear-gradient(90deg, #00f0ff, #ff2bd6)",
              boxShadow: "0 0 10px rgba(0,240,255,0.5)",
            }}
          />
        </div>
      )}

      {/* Watched patterns summary */}
      {watchedPatterns.size > 0 && (
        <div
          className="flex items-center gap-3 p-3 flex-wrap"
          style={{
            background: "rgba(255,43,214,0.04)",
            border: "1px solid rgba(255,43,214,0.2)",
            clipPath: clip(8),
          }}
        >
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-accent-2)]" style={MONO}>
            🔔 監視中
          </span>
          <div className="flex gap-1 flex-wrap">
            {Array.from(watchedPatterns).map((pid) => {
              const p = PATTERNS.find((pp) => pp.id === pid);
              if (!p) return null;
              return (
                <span
                  key={pid}
                  className="text-[9px] px-2 py-0.5 cursor-pointer hover:opacity-70"
                  style={{
                    ...MONO,
                    border: "1px solid rgba(255,43,214,0.4)",
                    color: "var(--color-accent-2)",
                    clipPath: clip(3),
                    background: "rgba(255,43,214,0.08)",
                  }}
                  onClick={(e) => toggleWatch(pid, e)}
                  title="クリックで監視解除"
                >
                  {p.label} ×
                </span>
              );
            })}
          </div>
          {scannedAll && watchedMatchCount > 0 && (
            <span className="text-[10px] text-[var(--color-accent-2)]" style={MONO}>
              → {watchedMatchCount}銘柄マッチ
            </span>
          )}
          {lineEnabled && (
            <span className="text-[9px] px-1.5 py-0.5" style={{
              ...MONO,
              border: "1px solid var(--color-success)",
              color: "var(--color-success)",
              clipPath: clip(3),
            }}>
              LINE通知ON
            </span>
          )}
        </div>
      )}

      {/* 5×5 パターングリッド */}
      <div
        className="rounded overflow-hidden"
        style={{
          border: "1px solid var(--color-border)",
          background: "var(--bg-card)",
          boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.06), 0 0 20px rgba(0,240,255,0.06)",
        }}
      >
        {/* ヘッダ行 */}
        <div className="grid grid-cols-6 gap-px" style={{ background: "var(--color-border)" }}>
          <div className="p-2" style={{ background: "var(--bg-card)" }} />
          {PHASE_ORDER.map((phase) => (
            <div key={phase} className="p-2 text-center" style={{ background: "var(--bg-card)" }}>
              <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]" style={MONO}>
                {PHASE_LABELS[phase]}
              </span>
            </div>
          ))}
        </div>

        {/* グリッド行 */}
        {DIRECTION_ORDER.map((dir, rowIdx) => (
          <div key={dir} className="grid grid-cols-6 gap-px" style={{ background: "var(--color-border)" }}>
            <div className="p-2 flex items-center justify-center" style={{ background: "var(--bg-card)" }}>
              <span className="text-[10px] font-bold tracking-[0.05em]" style={{ ...MONO, color: DIRECTION_COLORS[dir] }}>
                {DIRECTION_LABELS[dir]}
              </span>
            </div>

            {PHASE_ORDER.map((_, colIdx) => {
              const pattern = patternGrid[rowIdx]?.[colIdx];
              if (!pattern) {
                return <div key={colIdx} className="p-2" style={{ background: "var(--bg-card)" }} />;
              }

              const isSelected = selectedPattern?.id === pattern.id;
              const isWatched = watchedPatterns.has(pattern.id);
              const matchCount = scannedAll
                ? scanResults.filter((r) => {
                    const pats = r.patterns[timeframe];
                    return pats && pats.length > 0 && pats[0].id === pattern.id;
                  }).length
                : null;

              return (
                <button
                  key={colIdx}
                  onClick={() => setSelectedPattern(isSelected ? null : pattern)}
                  className="p-2 text-left transition-all relative group"
                  style={{
                    background: isSelected
                      ? "rgba(0,240,255,0.1)"
                      : isWatched
                      ? "rgba(255,43,214,0.06)"
                      : "var(--bg-card)",
                    outline: isSelected
                      ? "2px solid var(--color-accent)"
                      : isWatched
                      ? "1px solid rgba(255,43,214,0.3)"
                      : "none",
                    outlineOffset: "-2px",
                  }}
                >
                  {/* Watch bell */}
                  <button
                    onClick={(e) => toggleWatch(pattern.id, e)}
                    className="absolute top-0.5 right-0.5 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity p-0.5 z-10"
                    style={{
                      color: isWatched ? "var(--color-accent-2)" : "var(--color-text-secondary)",
                      filter: isWatched ? "drop-shadow(0 0 3px rgba(255,43,214,0.5))" : "none",
                    }}
                    title={isWatched ? "監視解除" : "このパターンを監視"}
                  >
                    {isWatched ? "🔔" : "🔕"}
                  </button>
                  {/* Always show bell if watched */}
                  {isWatched && (
                    <span className="absolute top-0.5 right-0.5 text-[10px] group-hover:opacity-0 transition-opacity"
                      style={{ filter: "drop-shadow(0 0 3px rgba(255,43,214,0.5))" }}>
                      🔔
                    </span>
                  )}

                  {/* パターン名 */}
                  <div className="text-[10px] font-medium leading-tight" style={{ ...MONO, color: DIRECTION_COLORS[pattern.direction as PatternDirection] }}>
                    {pattern.label}
                  </div>
                  {/* シグナル */}
                  <div className="mt-1 flex items-center gap-1">
                    <span
                      className="text-[8px] px-1 py-0.5 font-bold"
                      style={{
                        background: pattern.signal === "buy" ? "rgba(255,59,107,0.2)" : pattern.signal === "sell" ? "rgba(0,217,255,0.2)" : pattern.signal === "watch" ? "rgba(255,176,0,0.2)" : "rgba(106,122,154,0.15)",
                        color: pattern.signal === "buy" ? "#ff3b6b" : pattern.signal === "sell" ? "#00d9ff" : pattern.signal === "watch" ? "#ffb000" : "#8a9aba",
                        borderRadius: "2px",
                        ...MONO,
                      }}
                    >
                      {pattern.signal === "buy" ? "買" : pattern.signal === "sell" ? "売" : pattern.signal === "watch" ? "注目" : "中立"}
                    </span>
                    <span className="flex gap-0.5">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <span key={i} className="w-1 h-1 rounded-full" style={{ background: i < pattern.strength ? DIRECTION_COLORS[pattern.direction as PatternDirection] : "var(--color-border)" }} />
                      ))}
                    </span>
                  </div>
                  {/* マッチ数バッジ */}
                  {matchCount !== null && matchCount > 0 && (
                    <div className="absolute bottom-1 right-1 text-[8px] px-1 py-0.5 rounded-sm font-bold" style={{ background: "rgba(0,240,255,0.15)", color: "var(--color-accent)", ...MONO }}>
                      {matchCount}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* 選択パターンの詳細 + マッチ銘柄 */}
      {selectedPattern && (
        <div className="p-4 rounded space-y-4" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-lg font-bold" style={{ ...MONO, color: DIRECTION_COLORS[selectedPattern.direction as PatternDirection] }}>
                  {selectedPattern.label}
                </span>
                <span className="text-xs text-[var(--color-text-secondary)]" style={MONO}>
                  {selectedPattern.labelEn}
                </span>
                {/* Watch toggle */}
                <button
                  onClick={(e) => toggleWatch(selectedPattern.id, e)}
                  className="px-3 py-1 text-[10px] min-h-[28px] uppercase tracking-wider transition-all"
                  style={{
                    ...MONO,
                    clipPath: clip(4),
                    border: watchedPatterns.has(selectedPattern.id)
                      ? "1px solid var(--color-accent-2)"
                      : "1px solid var(--color-border)",
                    color: watchedPatterns.has(selectedPattern.id)
                      ? "var(--color-accent-2)"
                      : "var(--color-text-secondary)",
                    background: watchedPatterns.has(selectedPattern.id)
                      ? "rgba(255,43,214,0.1)"
                      : "transparent",
                    boxShadow: watchedPatterns.has(selectedPattern.id)
                      ? "0 0 12px rgba(255,43,214,0.25)"
                      : "none",
                  }}
                >
                  {watchedPatterns.has(selectedPattern.id) ? "🔔 監視中" : "🔕 監視する"}
                </button>
              </div>
              <p className="text-sm text-[var(--color-text)] mt-1 opacity-80">
                {selectedPattern.description}
              </p>
            </div>
            <PatternBadge
              pattern={{ ...selectedPattern, confidence: 0, timeframe } as PatternData}
              size="md"
            />
          </div>

          {/* マッチした銘柄リスト */}
          {scannedAll ? (
            matchingStocks.length > 0 ? (
              <div>
                <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-2" style={MONO}>
                  Matching Stocks ({matchingStocks.length})
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                  {matchingStocks.map((s) => {
                    const topPattern = s.patterns[timeframe]?.[0];
                    const isFav = watchlistItems.some((i) => i.ticker === s.ticker);
                    const isOpen = openStarTicker === s.ticker;
                    return (
                      <div
                        key={s.ticker}
                        className="relative p-3 rounded transition-all hover:brightness-125"
                        style={{ background: "rgba(0,240,255,0.03)", border: "1px solid var(--color-border)" }}
                      >
                        {/* ⭐ お気に入りボタン (右上) */}
                        <button
                          data-star-button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isFav) {
                              handleRemoveFromWatchlist(s.ticker);
                            } else {
                              if (watchlistGroups.length === 0) {
                                alert("先にお気に入りページでグループを作成してください");
                                return;
                              }
                              setOpenStarTicker(isOpen ? null : s.ticker);
                            }
                          }}
                          className="absolute top-1.5 right-1.5 text-base leading-none p-1 hover:scale-110 transition-transform"
                          title={isFav ? "お気に入りから削除" : "お気に入りに追加"}
                          style={{ color: isFav ? "#ffcb05" : "var(--color-text-secondary)" }}
                        >
                          {isFav ? "★" : "☆"}
                        </button>

                        {/* グループ選択ポップオーバー */}
                        {isOpen && !isFav && (
                          <div
                            data-star-popover
                            className="absolute top-8 right-1.5 z-20 min-w-[150px] rounded shadow-lg"
                            style={{
                              background: "var(--bg-card)",
                              border: "1px solid var(--color-accent)",
                              boxShadow: "0 4px 20px rgba(0,0,0,0.6), 0 0 12px rgba(0,240,255,0.2)",
                            }}
                          >
                            <div className="px-2.5 py-1.5 text-[9px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] border-b border-[var(--color-border)]" style={MONO}>
                              グループを選択
                            </div>
                            {watchlistGroups.map((g) => (
                              <button
                                key={g.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleAddToWatchlist(s.ticker, s.name, "JP", g.id!);
                                }}
                                className="block w-full text-left px-2.5 py-1.5 text-xs hover:bg-[rgba(0,240,255,0.08)] text-[var(--color-text)]"
                                style={MONO}
                              >
                                {g.name}
                              </button>
                            ))}
                          </div>
                        )}

                        {/* 銘柄情報 (クリックで詳細画面) */}
                        <button
                          onClick={() => router.push(`/stock/${s.ticker}`)}
                          className="w-full text-left"
                        >
                          <div className="flex items-center gap-2 pr-7">
                            <span className="text-[8px] px-1 py-0.5" style={{ background: "rgba(0,240,255,0.15)", color: "var(--color-accent)", ...MONO }}>JP</span>
                            <span className="text-xs text-[var(--color-accent)] font-bold" style={MONO}>{s.ticker}</span>
                          </div>
                          <div className="text-xs text-[var(--color-text)] mt-1 truncate pr-7">{s.name}</div>
                          {topPattern && (
                            <div className="mt-1.5 flex items-center gap-2 text-[9px] text-[var(--color-text-secondary)]" style={MONO}>
                              <span>conf: {topPattern.confidence}</span>
                              {topPattern.summary && (
                                <span>ROC5: {topPattern.summary.roc5 > 0 ? "+" : ""}{topPattern.summary.roc5}%</span>
                              )}
                            </div>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="text-center py-6">
                <span className="text-sm text-[var(--color-text-secondary)]">このパターンにマッチする銘柄はありません</span>
              </div>
            )
          ) : (
            <div className="text-center py-6">
              <span className="text-xs text-[var(--color-text-secondary)]">
                上の「SCAN」ボタンを押すとマッチする銘柄を表示します
              </span>
            </div>
          )}
        </div>
      )}

      {/* スキャン結果概要 */}
      {!selectedPattern && scannedAll && (
        <div className="p-4 rounded space-y-3" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}>
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>
            Scan Results — {timeframe === "daily" ? "日足" : "週足"} ({scanResults.length}銘柄)
          </span>
          <p className="text-xs text-[var(--color-text)] opacity-70">
            グリッドからパターンを選択するとマッチ銘柄が表示されます。セルの数字がマッチ数です。
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 mt-2">
            {PATTERNS.filter((p) => {
              return scanResults.some((r) => {
                const pats = r.patterns[timeframe];
                return pats && pats.length > 0 && pats[0].id === p.id;
              });
            }).sort((a, b) => {
              const countA = scanResults.filter((r) => r.patterns[timeframe]?.[0]?.id === a.id).length;
              const countB = scanResults.filter((r) => r.patterns[timeframe]?.[0]?.id === b.id).length;
              return countB - countA;
            }).slice(0, 10).map((p) => {
              const count = scanResults.filter((r) => {
                const pats = r.patterns[timeframe];
                return pats && pats.length > 0 && pats[0].id === p.id;
              }).length;
              return (
                <button
                  key={p.id}
                  onClick={() => setSelectedPattern(p)}
                  className="p-2 rounded text-left transition-all hover:brightness-125 relative"
                  style={{ background: "rgba(0,240,255,0.03)", border: `1px solid ${watchedPatterns.has(p.id) ? "rgba(255,43,214,0.4)" : "var(--color-border)"}` }}
                >
                  {watchedPatterns.has(p.id) && (
                    <span className="absolute top-1 right-1 text-[8px]">🔔</span>
                  )}
                  <div className="text-[10px] font-bold" style={{ ...MONO, color: DIRECTION_COLORS[p.direction] }}>
                    {p.label}
                  </div>
                  <div className="text-lg font-bold text-[var(--color-accent)] mt-0.5" style={MONO}>{count}</div>
                  <div className="text-[9px] text-[var(--color-text-secondary)]">銘柄</div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
