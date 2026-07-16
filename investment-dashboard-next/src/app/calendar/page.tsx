"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { getHoldings, getWatchlist, type Holding, type WatchlistItem } from "@/lib/firestore";
import type { EarningsInfo } from "@/app/api/stocks/earnings/route";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

type ScopeFilter = "all" | "holdings" | "watchlist";

interface EnrichedEarnings extends EarningsInfo {
  source: ("holding" | "watchlist")[];
  shares?: number;
  avgCost?: number;
  groupName?: string;
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.floor((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "未定";
  const d = new Date(dateStr);
  const days = ["日", "月", "火", "水", "木", "金", "土"];
  return `${d.getMonth() + 1}/${d.getDate()} (${days[d.getDay()]})`;
}

export default function CalendarPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [items, setItems] = useState<EnrichedEarnings[]>([]);
  const [showOnlyUpcoming, setShowOnlyUpcoming] = useState(true);

  const loadData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [holdings, watchlist] = await Promise.all([
        getHoldings(user.uid),
        getWatchlist(user.uid),
      ]);

      // ティッカー → ソース情報のマップ
      const tickerMeta = new Map<
        string,
        { source: ("holding" | "watchlist")[]; holding?: Holding; watchItem?: WatchlistItem }
      >();
      for (const h of holdings) {
        const cur = tickerMeta.get(h.ticker) ?? { source: [] };
        cur.source.push("holding");
        cur.holding = h;
        tickerMeta.set(h.ticker, cur);
      }
      for (const w of watchlist) {
        const cur = tickerMeta.get(w.ticker) ?? { source: [] };
        if (!cur.source.includes("watchlist")) cur.source.push("watchlist");
        cur.watchItem = w;
        tickerMeta.set(w.ticker, cur);
      }

      const tickers = Array.from(tickerMeta.keys());
      if (tickers.length === 0) {
        setItems([]);
        return;
      }

      // 20銘柄ずつにバッチして取得
      const batches: string[][] = [];
      for (let i = 0; i < tickers.length; i += 20) {
        batches.push(tickers.slice(i, i + 20));
      }

      const allEarnings: EnrichedEarnings[] = [];
      for (const batch of batches) {
        const res = await fetch(`/api/stocks/earnings?tickers=${batch.join(",")}`);
        const data = await res.json();
        const earnings = data.earnings ?? {};
        for (const t of batch) {
          const e = earnings[t];
          const meta = tickerMeta.get(t);
          if (!meta) continue;
          if (e) {
            allEarnings.push({
              ...e,
              source: meta.source,
              shares: meta.holding?.shares,
              avgCost: meta.holding?.avgCost,
            });
          } else {
            // データなし
            allEarnings.push({
              ticker: t,
              name: meta.holding?.name ?? meta.watchItem?.name ?? t,
              nextEarningsDate: null,
              nextEarningsDateRange: null,
              earningsAverage: null,
              earningsLow: null,
              earningsHigh: null,
              revenueAverage: null,
              exDividendDate: null,
              dividendDate: null,
              lastEarningsActual: null,
              lastEarningsEstimate: null,
              lastEarningsSurprise: null,
              fiscalYearEnd: null,
              currency: "JPY",
              source: meta.source,
              shares: meta.holding?.shares,
              avgCost: meta.holding?.avgCost,
            });
          }
        }
      }

      setItems(allEarnings);
    } catch (err) {
      console.error("Failed to load earnings:", err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // フィルタ + ソート
  const filtered = items
    .filter((e) => {
      if (scope === "holdings" && !e.source.includes("holding")) return false;
      if (scope === "watchlist" && !e.source.includes("watchlist")) return false;
      if (showOnlyUpcoming) {
        const days = daysUntil(e.nextEarningsDate);
        if (days === null || days < 0) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const aDays = daysUntil(a.nextEarningsDate);
      const bDays = daysUntil(b.nextEarningsDate);
      if (aDays === null && bDays === null) return 0;
      if (aDays === null) return 1;
      if (bDays === null) return -1;
      return aDays - bDays;
    });

  // 当週・来週・今月・来月のグループ化
  const groups: { label: string; items: EnrichedEarnings[]; range: [number, number] }[] = [
    { label: "🚨 今週 (〜7日)", items: [], range: [0, 7] },
    { label: "⏰ 来週 (8〜14日)", items: [], range: [8, 14] },
    { label: "📅 今月後半 (15〜30日)", items: [], range: [15, 30] },
    { label: "🔭 さらに先 (31〜90日)", items: [], range: [31, 90] },
    { label: "📆 90日以降", items: [], range: [91, 9999] },
    { label: "❓ 未定", items: [], range: [-9999, -1] },
  ];
  for (const e of filtered) {
    const days = daysUntil(e.nextEarningsDate);
    if (days === null) {
      groups[5].items.push(e);
      continue;
    }
    for (const g of groups) {
      if (days >= g.range[0] && days <= g.range[1]) {
        g.items.push(e);
        break;
      }
    }
  }

  if (loading) {
    return (
      <div className="text-center py-12 text-[var(--color-text-secondary)]" style={MONO}>
        決算情報を取得中...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ヘッダー */}
      <div>
        <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">
          📅 決算カレンダー
        </h1>
        <p className="text-xs text-[var(--color-text-secondary)] mt-1" style={MONO}>
          保有銘柄・お気に入りの決算予定。決算前後は値動きが激しくなりがちなのでポジション調整の検討を。
        </p>
      </div>

      {/* フィルタ */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1">
          {(["all", "holdings", "watchlist"] as const).map((s) => {
            const labels = { all: "すべて", holdings: "保有のみ", watchlist: "お気に入りのみ" };
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

        <label
          className="flex items-center gap-1.5 text-xs cursor-pointer select-none"
          style={MONO}
        >
          <input
            type="checkbox"
            checked={showOnlyUpcoming}
            onChange={(e) => setShowOnlyUpcoming(e.target.checked)}
            className="w-3.5 h-3.5 accent-[var(--color-accent)]"
          />
          <span className="text-[var(--color-text-secondary)]">予定済みのみ</span>
        </label>

        <span className="ml-auto text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
          全{items.length}銘柄 / 表示中 {filtered.length}件
        </span>
      </div>

      {/* 集計サマリ */}
      {filtered.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {groups.slice(0, 4).map((g) => (
            <div
              key={g.label}
              className="p-2.5 rounded text-center"
              style={{
                border: "1px solid var(--color-border)",
                background: g.items.length > 0 ? "rgba(0,240,255,0.05)" : "transparent",
                ...MONO,
              }}
            >
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                {g.label}
              </div>
              <div
                className="text-lg font-bold mt-1"
                style={{
                  color: g.items.length > 0 ? "var(--color-accent)" : "var(--color-text-secondary)",
                }}
              >
                {g.items.length}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* リスト */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-[var(--color-text-secondary)] text-sm" style={MONO}>
          {items.length === 0
            ? "保有銘柄もお気に入りもまだありません。"
            : "条件に合う銘柄がありません。"}
        </div>
      ) : (
        <div className="space-y-4">
          {groups
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <div key={g.label} className="space-y-2">
                <div
                  className="text-xs font-medium uppercase tracking-[0.1em] text-[var(--color-accent)]"
                  style={MONO}
                >
                  {g.label} ({g.items.length})
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {g.items.map((e) => (
                    <EarningsCard
                      key={e.ticker}
                      item={e}
                      onClick={() => router.push(`/stock/${e.ticker}`)}
                    />
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function EarningsCard({ item, onClick }: { item: EnrichedEarnings; onClick: () => void }) {
  const days = daysUntil(item.nextEarningsDate);
  let urgency: { color: string; bg: string; label: string } = {
    color: "var(--color-text-secondary)",
    bg: "transparent",
    label: "",
  };
  if (days !== null) {
    if (days < 0) {
      urgency = { color: "#9ca3af", bg: "rgba(156,163,175,0.05)", label: `${Math.abs(days)}日前` };
    } else if (days === 0) {
      urgency = { color: "#ef4444", bg: "rgba(239,68,68,0.1)", label: "本日" };
    } else if (days <= 3) {
      urgency = { color: "#ef4444", bg: "rgba(239,68,68,0.08)", label: `あと${days}日` };
    } else if (days <= 7) {
      urgency = { color: "#fbbf24", bg: "rgba(251,191,36,0.08)", label: `あと${days}日` };
    } else if (days <= 30) {
      urgency = { color: "#22c55e", bg: "rgba(34,197,94,0.05)", label: `あと${days}日` };
    } else {
      urgency = { color: "var(--color-text-secondary)", bg: "transparent", label: `あと${days}日` };
    }
  }

  const surprise = item.lastEarningsSurprise;

  return (
    <button
      onClick={onClick}
      className="text-left p-3 rounded transition-all hover:brightness-125 w-full"
      style={{
        border: `1px solid ${urgency.color === "var(--color-text-secondary)" ? "var(--color-border)" : urgency.color + "60"}`,
        background: urgency.bg !== "transparent" ? urgency.bg : "var(--bg-card)",
      }}
    >
      {/* ヘッダー: 銘柄 + バッジ */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-[var(--color-accent)] font-bold" style={MONO}>
              {item.ticker}
            </span>
            <span className="text-xs text-[var(--color-text)] truncate">{item.name}</span>
          </div>
          <div className="flex gap-1 mt-1">
            {item.source.includes("holding") && (
              <span className="text-[9px] px-1.5 py-0.5" style={{ background: "rgba(251,191,36,0.15)", color: "#fbbf24", ...MONO }}>
                💼 保有 {item.shares ? `${item.shares}株` : ""}
              </span>
            )}
            {item.source.includes("watchlist") && (
              <span className="text-[9px] px-1.5 py-0.5" style={{ background: "rgba(0,240,255,0.15)", color: "var(--color-accent)", ...MONO }}>
                ⭐ お気に入り
              </span>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs" style={{ color: urgency.color, ...MONO }}>
            {formatDate(item.nextEarningsDate)}
          </div>
          {urgency.label && (
            <div className="text-[10px] font-medium mt-0.5" style={{ color: urgency.color, ...MONO }}>
              {urgency.label}
            </div>
          )}
        </div>
      </div>

      {/* 詳細データ */}
      <div className="grid grid-cols-2 gap-2 text-[10px]" style={MONO}>
        {item.earningsAverage !== null && (
          <div>
            <span className="text-[var(--color-text-secondary)]">予想EPS: </span>
            <span>{item.earningsAverage.toFixed(2)} {item.currency}</span>
          </div>
        )}
        {surprise !== null && (
          <div>
            <span className="text-[var(--color-text-secondary)]">前回サプライズ: </span>
            <span style={{ color: surprise >= 0 ? "#22c55e" : "#ef4444" }}>
              {surprise >= 0 ? "+" : ""}{surprise.toFixed(2)}%
            </span>
          </div>
        )}
        {item.exDividendDate && (
          <div>
            <span className="text-[var(--color-text-secondary)]">権利落: </span>
            <span>{formatDate(item.exDividendDate)}</span>
          </div>
        )}
        {item.dividendDate && (
          <div>
            <span className="text-[var(--color-text-secondary)]">配当日: </span>
            <span>{formatDate(item.dividendDate)}</span>
          </div>
        )}
      </div>
    </button>
  );
}
