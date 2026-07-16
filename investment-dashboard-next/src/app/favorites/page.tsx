"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import {
  getWatchlistGroups,
  addWatchlistGroup,
  updateWatchlistGroup,
  deleteWatchlistGroup,
  getWatchlistByGroup,
  addToWatchlist,
  removeFromWatchlist,
  type WatchlistGroup,
  type WatchlistItem,
} from "@/lib/firestore";

/* ── Style helpers ── */
const mono = { fontFamily: "'JetBrains Mono', monospace" } as const;
const clip = (px = 6) =>
  `polygon(${px}px 0, 100% 0, 100% calc(100% - ${px}px), calc(100% - ${px}px) 100%, 0 100%, 0 ${px}px)`;

interface PriceData {
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  currency: string;
}

interface SparkEntry {
  ticker: string;
  closes: number[];
  price: number | null;
  changePct: number | null;
  periodChangePct: number | null;
  scores: { short: number; mid: number; long: number; overall: number } | null;
}

/* ── チャート時間軸 (iSpeed 風、ただし一斉変更 + 個別上書きの両対応) ── */
type Tf = "1m" | "5m" | "1mo" | "3mo";
const TF_META: Record<Tf, { label: string; periodLabel: string }> = {
  "1m": { label: "1分", periodLabel: "当日" },
  "5m": { label: "5分", periodLabel: "5日" },
  "1mo": { label: "1M", periodLabel: "月間" },
  "3mo": { label: "3M", periodLabel: "3ヶ月" },
};
const TF_ORDER: Tf[] = ["1m", "5m", "1mo", "3mo"];
const LS_TF_GLOBAL = "cavka_fav_tf_global";
const LS_TF_OVERRIDES = "cavka_fav_tf_overrides";
const LS_SORT = "cavka_fav_sort";

/* ── 並び順 ── */
type SortMode = "added" | "attention" | "change" | "score";
const SORT_META: Record<SortMode, string> = {
  added: "登録順",
  attention: "🔔 注目順",
  change: "変化率順",
  score: "スコア順",
};

/* ── 気づきバッジ ── */
interface TickerBadges {
  verdictChanged: string | null;   // 例: "短期 やや強気→対立" (直近の評決変化)
  contested: boolean;              // いずれかの時間軸で見解対立中
  earningsInDays: number | null;   // 7日以内なら日数
}

const STANCE_JA: Record<string, string> = {
  strong_bull: "強気", bull: "やや強気", neutral: "中立",
  bear: "やや弱気", strong_bear: "弱気", contested: "対立",
};
const TF_JA: Record<string, string> = { short: "短期", mid: "中期", long: "長期" };

export default function FavoritesPage() {
  const { user } = useAuth();
  const router = useRouter();

  // Groups
  const [groups, setGroups] = useState<WatchlistGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [groupsLoading, setGroupsLoading] = useState(true);

  // Items in active group
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);

  // Prices
  const [prices, setPrices] = useState<Record<string, PriceData>>({});
  // Sparkline + scores (カード用)
  const [sparks, setSparks] = useState<Record<string, SparkEntry & { tf: Tf }>>({});
  // 時間軸: 全体設定 + 銘柄別上書き
  const [globalTf, setGlobalTf] = useState<Tf>("1mo");
  const [tfOverrides, setTfOverrides] = useState<Record<string, Tf>>({});

  // 時間軸設定の復元/永続化
  useEffect(() => {
    try {
      const g = localStorage.getItem(LS_TF_GLOBAL);
      if (g && TF_ORDER.includes(g as Tf)) setGlobalTf(g as Tf);
      const o = JSON.parse(localStorage.getItem(LS_TF_OVERRIDES) ?? "{}");
      if (o && typeof o === "object") setTfOverrides(o);
    } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem(LS_TF_GLOBAL, globalTf); } catch {}
  }, [globalTf]);
  useEffect(() => {
    try { localStorage.setItem(LS_TF_OVERRIDES, JSON.stringify(tfOverrides)); } catch {}
  }, [tfOverrides]);

  const effectiveTf = useCallback(
    (ticker: string): Tf => tfOverrides[ticker] ?? globalTf,
    [tfOverrides, globalTf]
  );

  // 並び順
  const [sortMode, setSortMode] = useState<SortMode>("attention");
  useEffect(() => {
    try {
      const s = localStorage.getItem(LS_SORT);
      if (s && s in SORT_META) setSortMode(s as SortMode);
    } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem(LS_SORT, sortMode); } catch {}
  }, [sortMode]);

  // 気づきバッジ (評決変化 / 対立中 / 決算接近)
  const [badges, setBadges] = useState<Record<string, TickerBadges>>({});
  useEffect(() => {
    if (items.length === 0) { setBadges({}); return; }
    const tickers = Array.from(new Set(items.map((i) => i.ticker)));
    (async () => {
      const [briefRes, stanceRes, earnRes] = await Promise.allSettled([
        fetch("/api/briefing").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/verdict-latest").then((r) => (r.ok ? r.json() : null)),
        fetch(`/api/stocks/next-earnings?tickers=${tickers.join(",")}`).then((r) => (r.ok ? r.json() : null)),
      ]);
      const val = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const brief = val(briefRes) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stances = ((val(stanceRes) as any)?.stances ?? {}) as Record<string, { short: string; mid: string; long: string }>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const earnings = ((val(earnRes) as any)?.earnings ?? {}) as Record<string, { daysToNext: number | null }>;

      const changeMap = new Map<string, string>();
      for (const c of (brief?.verdicts?.changes ?? []) as { ticker: string; tf: string; from: string; to: string }[]) {
        if (!changeMap.has(c.ticker)) {
          changeMap.set(c.ticker, `${TF_JA[c.tf] ?? c.tf} ${STANCE_JA[c.from] ?? c.from}→${STANCE_JA[c.to] ?? c.to}`);
        }
      }

      const next: Record<string, TickerBadges> = {};
      for (const t of tickers) {
        const st = stances[t];
        const days = earnings[t]?.daysToNext ?? null;
        next[t] = {
          verdictChanged: changeMap.get(t) ?? null,
          contested: !!st && [st.short, st.mid, st.long].includes("contested"),
          earningsInDays: days !== null && days >= 0 && days <= 7 ? days : null,
        };
      }
      setBadges(next);
    })();
  }, [items]);

  // Group management
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editGroupName, setEditGroupName] = useState("");

  // Add stock
  const [showAddStock, setShowAddStock] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ ticker: string; name: string; market: string }[]>([]);
  const [searching, setSearching] = useState(false);

  // Load groups
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const g = await getWatchlistGroups(user.uid);
        setGroups(g);
        if (g.length > 0 && !activeGroupId) {
          setActiveGroupId(g[0].id!);
        }
      } catch (err) {
        console.error("Failed to load groups:", err);
      } finally {
        setGroupsLoading(false);
      }
    })();
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load items when active group changes
  useEffect(() => {
    if (!user || !activeGroupId) {
      setItems([]);
      return;
    }
    setItemsLoading(true);
    (async () => {
      try {
        const w = await getWatchlistByGroup(user.uid, activeGroupId);
        setItems(w);
      } catch (err) {
        console.error("Failed to load items:", err);
      } finally {
        setItemsLoading(false);
      }
    })();
  }, [user, activeGroupId]);

  // Fetch prices when items change + 60秒ごとに自動更新
  useEffect(() => {
    if (items.length === 0) {
      setPrices({});
      return;
    }
    const tickers = Array.from(new Set(items.map((i) => i.ticker))).join(",");
    const load = () =>
      fetch(`/api/stocks/prices?tickers=${tickers}`)
        .then((r) => r.json())
        .then((data) => setPrices(data.prices ?? {}))
        .catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [items]);

  // スパークライン取得: 時間軸ごとにグループ化して並列バッチ
  const fetchSparks = useCallback(async () => {
    if (items.length === 0) {
      setSparks({});
      return;
    }
    const uniq = Array.from(new Set(items.map((i) => i.ticker)));
    const byTf = new Map<Tf, string[]>();
    for (const t of uniq) {
      const tf = effectiveTf(t);
      byTf.set(tf, [...(byTf.get(tf) ?? []), t]);
    }
    const results = await Promise.all(
      Array.from(byTf.entries()).map(async ([tf, ts]) => {
        try {
          const res = await fetch(`/api/stocks/sparkline?tickers=${ts.join(",")}&tf=${tf}`);
          const j = await res.json();
          return { tf, entries: (j.entries ?? {}) as Record<string, SparkEntry> };
        } catch {
          return { tf, entries: {} as Record<string, SparkEntry> };
        }
      })
    );
    const merged: Record<string, SparkEntry & { tf: Tf }> = {};
    for (const { tf, entries } of results) {
      for (const [t, e] of Object.entries(entries)) merged[t] = { ...e, tf };
    }
    setSparks(merged);
  }, [items, effectiveTf]);

  useEffect(() => {
    fetchSparks();
  }, [fetchSparks]);

  // 分足表示中は 60 秒ごとに自動更新 (iSpeed的ザラ場ウォッチ)
  useEffect(() => {
    const anyIntraday = items.some((i) => ["1m", "5m"].includes(effectiveTf(i.ticker)));
    if (!anyIntraday) return;
    const id = setInterval(fetchSparks, 60_000);
    return () => clearInterval(id);
  }, [items, effectiveTf, fetchSparks]);

  // 一斉変更: 全体設定を変え、個別上書きもリセット
  const applyGlobalTf = (tf: Tf) => {
    setGlobalTf(tf);
    setTfOverrides({});
  };

  // Create group
  const handleCreateGroup = useCallback(async () => {
    if (!user || !newGroupName.trim()) return;
    try {
      const ref = await addWatchlistGroup(user.uid, newGroupName.trim(), groups.length);
      const newGroup: WatchlistGroup = { id: ref.id, name: newGroupName.trim(), order: groups.length };
      setGroups((prev) => [...prev, newGroup]);
      setActiveGroupId(ref.id);
      setNewGroupName("");
      setShowNewGroup(false);
    } catch (err) {
      console.error("Failed to create group:", err);
    }
  }, [user, newGroupName, groups.length]);

  // Rename group
  const handleRenameGroup = useCallback(async () => {
    if (!user || !editingGroupId || !editGroupName.trim()) return;
    try {
      await updateWatchlistGroup(user.uid, editingGroupId, editGroupName.trim());
      setGroups((prev) =>
        prev.map((g) => (g.id === editingGroupId ? { ...g, name: editGroupName.trim() } : g))
      );
      setEditingGroupId(null);
      setEditGroupName("");
    } catch (err) {
      console.error("Failed to rename group:", err);
    }
  }, [user, editingGroupId, editGroupName]);

  // Delete group
  const handleDeleteGroup = useCallback(
    async (gid: string) => {
      if (!user) return;
      if (!confirm("このグループを削除しますか？（中の銘柄も全て削除されます）")) return;
      try {
        await deleteWatchlistGroup(user.uid, gid);
        const remaining = groups.filter((g) => g.id !== gid);
        setGroups(remaining);
        if (activeGroupId === gid) {
          setActiveGroupId(remaining.length > 0 ? remaining[0].id! : null);
        }
      } catch (err) {
        console.error("Failed to delete group:", err);
      }
    },
    [user, groups, activeGroupId]
  );

  // Search stocks
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/stocks/search?q=${encodeURIComponent(searchQuery.trim())}`);
      const data = await res.json();
      setSearchResults(Array.isArray(data) ? data : data.results ?? []);
    } catch {
      setSearchResults([]);
    }
    setSearching(false);
  }, [searchQuery]);

  // Add stock to active group
  const handleAddStock = useCallback(
    async (ticker: string, name: string, market: string) => {
      if (!user || !activeGroupId) return;
      // Check duplicate
      if (items.some((i) => i.ticker === ticker)) return;
      try {
        const ref = await addToWatchlist(user.uid, {
          ticker,
          name,
          market,
          groupId: activeGroupId,
        });
        setItems((prev) => [{ id: ref.id, ticker, name, market, groupId: activeGroupId }, ...prev]);
        setShowAddStock(false);
        setSearchQuery("");
        setSearchResults([]);
      } catch (err) {
        console.error("Failed to add stock:", err);
      }
    },
    [user, activeGroupId, items]
  );

  // Remove stock
  const handleRemoveStock = useCallback(
    async (itemId: string) => {
      if (!user) return;
      try {
        await removeFromWatchlist(user.uid, itemId);
        setItems((prev) => prev.filter((i) => i.id !== itemId));
      } catch (err) {
        console.error("Failed to remove stock:", err);
      }
    },
    [user]
  );

  const activeGroup = groups.find((g) => g.id === activeGroupId);

  // 重複除去 + 並び替え
  const displayItems = (() => {
    const uniq = items.filter((item, idx) => items.findIndex((x) => x.ticker === item.ticker) === idx);
    if (sortMode === "added") return uniq;
    const attention = (t: string): number => {
      const b = badges[t];
      if (!b) return 0;
      return (b.verdictChanged ? 8 : 0) + (b.contested ? 4 : 0) + (b.earningsInDays !== null ? 2 : 0);
    };
    return [...uniq].sort((a, b) => {
      if (sortMode === "change") {
        return Math.abs(prices[b.ticker]?.changePct ?? 0) - Math.abs(prices[a.ticker]?.changePct ?? 0);
      }
      if (sortMode === "score") {
        return (sparks[b.ticker]?.scores?.overall ?? -1) - (sparks[a.ticker]?.scores?.overall ?? -1);
      }
      // attention: バッジ優先 → 変化率
      const d = attention(b.ticker) - attention(a.ticker);
      if (d !== 0) return d;
      return Math.abs(prices[b.ticker]?.changePct ?? 0) - Math.abs(prices[a.ticker]?.changePct ?? 0);
    });
  })();

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-[26px] font-bold tracking-tight text-[var(--color-text)]">
          ⭐ お気に入り
        </h1>
        {activeGroupId && (
          <button
            onClick={() => setShowAddStock(!showAddStock)}
            className="px-4 py-2 text-sm min-h-[44px] uppercase tracking-wider transition-all"
            style={{
              ...mono,
              clipPath: clip(),
              border: "1px solid var(--color-accent)",
              boxShadow: "0 0 18px rgba(0,240,255,0.35), inset 0 0 12px rgba(0,240,255,0.08)",
              background: "transparent",
              color: "var(--color-accent)",
            }}
          >
            {showAddStock ? "キャンセル" : "+ 銘柄追加"}
          </button>
        )}
      </div>

      {/* ============================================================ */}
      {/* Group Tabs */}
      {/* ============================================================ */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1 scrollbar-hide">
        {groups.map((g) => {
          const isActive = g.id === activeGroupId;
          const isEditing = editingGroupId === g.id;

          return (
            <div key={g.id} className="flex-shrink-0 relative group">
              {isEditing ? (
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={editGroupName}
                    onChange={(e) => setEditGroupName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleRenameGroup(); if (e.key === "Escape") setEditingGroupId(null); }}
                    autoFocus
                    className="bg-[var(--bg-input)] border border-[var(--color-accent)] px-2 py-1.5 text-sm text-[var(--color-text)] focus:outline-none w-24"
                    style={{ ...mono, clipPath: clip(4) }}
                  />
                  <button
                    onClick={handleRenameGroup}
                    className="text-[10px] px-2 py-1.5 text-[var(--color-accent)]"
                    style={mono}
                  >
                    ✓
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setActiveGroupId(g.id!)}
                  onDoubleClick={() => { setEditingGroupId(g.id!); setEditGroupName(g.name); }}
                  className="px-4 py-2 text-sm min-h-[40px] transition-all whitespace-nowrap"
                  style={{
                    ...mono,
                    clipPath: clip(6),
                    border: isActive ? "1px solid var(--color-accent)" : "1px solid var(--color-border)",
                    background: isActive ? "rgba(0,240,255,0.08)" : "transparent",
                    color: isActive ? "var(--color-accent)" : "var(--color-text-secondary)",
                    boxShadow: isActive ? "0 0 15px rgba(0,240,255,0.2), inset 0 0 10px rgba(0,240,255,0.05)" : "none",
                  }}
                >
                  {g.name}
                  <span className="ml-1.5 text-[10px] opacity-60">
                    {items.length > 0 && isActive ? items.length : ""}
                  </span>
                </button>
              )}

              {/* Group context menu (shown on hover for active group) */}
              {isActive && !isEditing && (
                <div className="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 transition-opacity flex gap-0.5 z-10">
                  <button
                    onClick={() => { setEditingGroupId(g.id!); setEditGroupName(g.name); }}
                    className="w-5 h-5 flex items-center justify-center text-[9px] bg-[var(--bg-card)] border border-[var(--color-border)] rounded-sm text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]"
                    title="名前変更"
                  >
                    ✎
                  </button>
                  {groups.length > 1 && (
                    <button
                      onClick={() => handleDeleteGroup(g.id!)}
                      className="w-5 h-5 flex items-center justify-center text-[9px] bg-[var(--bg-card)] border border-[var(--color-border)] rounded-sm text-[var(--color-text-secondary)] hover:text-[var(--color-danger)]"
                      title="削除"
                    >
                      ✕
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* New group button / input */}
        {showNewGroup ? (
          <div className="flex items-center gap-1 flex-shrink-0">
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateGroup(); if (e.key === "Escape") setShowNewGroup(false); }}
              autoFocus
              placeholder="グループ名"
              className="bg-[var(--bg-input)] border border-[var(--color-accent)] px-2 py-1.5 text-sm text-[var(--color-text)] focus:outline-none w-28"
              style={{ ...mono, clipPath: clip(4) }}
            />
            <button
              onClick={handleCreateGroup}
              disabled={!newGroupName.trim()}
              className="text-sm px-2 py-1.5 text-[var(--color-accent)] disabled:opacity-30"
              style={mono}
            >
              ✓
            </button>
            <button
              onClick={() => { setShowNewGroup(false); setNewGroupName(""); }}
              className="text-sm px-1 py-1.5 text-[var(--color-text-secondary)]"
              style={mono}
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowNewGroup(true)}
            className="flex-shrink-0 px-3 py-2 text-sm min-h-[40px] transition-all"
            style={{
              ...mono,
              clipPath: clip(6),
              border: "1px dashed var(--color-border)",
              color: "var(--color-text-secondary)",
              background: "transparent",
            }}
          >
            +
          </button>
        )}
      </div>

      {/* ============================================================ */}
      {/* Add Stock Search */}
      {/* ============================================================ */}
      {showAddStock && activeGroupId && (
        <div
          className="relative bg-card p-4 border border-[var(--color-accent)]"
          style={{
            clipPath: clip(10),
            boxShadow: "0 0 20px rgba(0,240,255,0.15), inset 0 0 0 1px rgba(0,240,255,0.08)",
          }}
        >
          <div className="flex gap-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
              placeholder="銘柄コードまたは名前で検索（例: 7203, AAPL, トヨタ）"
              className="flex-1 bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
              style={{ ...mono, clipPath: clip() }}
              autoFocus
            />
            <button
              onClick={handleSearch}
              disabled={searching || !searchQuery.trim()}
              className="px-4 py-2 text-sm min-h-[44px] uppercase tracking-wider disabled:opacity-50"
              style={{
                ...mono,
                clipPath: clip(),
                border: "1px solid var(--color-accent)",
                color: "var(--color-accent)",
                background: "transparent",
              }}
            >
              {searching ? "..." : "検索"}
            </button>
          </div>

          {searchResults.length > 0 && (
            <div className="mt-3 space-y-1 max-h-[240px] overflow-y-auto">
              {searchResults.map((r) => {
                const alreadyAdded = items.some((i) => i.ticker === r.ticker);
                return (
                  <div
                    key={r.ticker}
                    data-ticker={r.ticker}
                    className="flex items-center justify-between px-3 py-2 border border-[var(--color-border)] hover:border-[var(--color-accent)]/30 transition-all"
                    style={{ clipPath: clip(4) }}
                  >
                    <div>
                      <span className="text-sm text-[var(--color-accent)] font-medium" style={mono}>
                        {r.ticker}
                      </span>
                      <span className="text-sm ml-2">{r.name}</span>
                      <span className="text-[10px] ml-2 text-[var(--color-text-secondary)]" style={mono}>
                        {r.market}
                      </span>
                    </div>
                    <button
                      onClick={() => handleAddStock(r.ticker, r.name, r.market)}
                      disabled={alreadyAdded}
                      className="text-xs px-3 py-1 min-h-[32px] uppercase tracking-wider disabled:opacity-30"
                      style={{
                        ...mono,
                        clipPath: clip(4),
                        border: alreadyAdded ? "1px solid var(--color-border)" : "1px solid var(--color-accent)",
                        color: alreadyAdded ? "var(--color-text-secondary)" : "var(--color-accent)",
                        background: "transparent",
                      }}
                    >
                      {alreadyAdded ? "追加済" : "追加"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* Empty state */}
      {/* ============================================================ */}
      {groupsLoading ? (
        <div className="text-center py-12 text-[var(--color-text-secondary)]">読み込み中...</div>
      ) : groups.length === 0 ? (
        <div
          className="relative bg-card p-8 border border-[var(--color-border)] text-center"
          style={{ clipPath: clip(10), boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)" }}
        >
          <p className="text-[var(--color-text-secondary)] mb-4">
            お気に入りグループがありません
          </p>
          <p className="text-sm text-[var(--color-text-secondary)] mb-6">
            「+」ボタンでグループを作成して、銘柄を管理しましょう
          </p>
          <button
            onClick={() => setShowNewGroup(true)}
            className="px-6 py-2.5 text-sm min-h-[44px] uppercase tracking-wider"
            style={{
              ...mono,
              clipPath: clip(),
              border: "1px solid var(--color-accent)",
              boxShadow: "0 0 18px rgba(0,240,255,0.35)",
              color: "var(--color-accent)",
              background: "transparent",
            }}
          >
            最初のグループを作成
          </button>
        </div>
      ) : activeGroupId && items.length === 0 && !itemsLoading ? (
        <div
          className="relative bg-card p-8 border border-[var(--color-border)] text-center"
          style={{ clipPath: clip(10), boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)" }}
        >
          <p className="text-[var(--color-text-secondary)] mb-2">
            「{activeGroup?.name}」に銘柄がありません
          </p>
          <p className="text-sm text-[var(--color-text-secondary)]">
            右上の「+ 銘柄追加」から追加してください
          </p>
        </div>
      ) : null}

      {/* ============================================================ */}
      {/* Stock Cards */}
      {/* ============================================================ */}
      {/* チャート時間軸: 一斉変更 (個別はカード上のチップで上書き) */}
      {items.length > 0 && !itemsLoading && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-[var(--color-text-secondary)] uppercase tracking-wider" style={mono}>
            チャート一斉変更:
          </span>
          <div className="flex gap-1">
            {TF_ORDER.map((tf) => {
              const isActive = globalTf === tf && Object.keys(tfOverrides).length === 0;
              return (
                <button
                  key={tf}
                  onClick={() => applyGlobalTf(tf)}
                  className="px-3 py-1 text-xs transition-all"
                  style={{
                    ...mono,
                    clipPath: clip(4),
                    border: `1px solid ${isActive ? "var(--color-accent)" : "var(--color-border)"}`,
                    color: isActive ? "var(--color-accent)" : "var(--color-text-secondary)",
                    background: isActive ? "rgba(0,240,255,0.08)" : "transparent",
                  }}
                >
                  {TF_META[tf].label}
                </button>
              );
            })}
          </div>
          {Object.keys(tfOverrides).length > 0 && (
            <span className="text-[10px] text-[var(--color-accent-2)]" style={mono}>
              ✦ {Object.keys(tfOverrides).length}銘柄が個別設定中 (一斉変更でリセット)
            </span>
          )}

          <span className="text-[10px] text-[var(--color-text-secondary)] uppercase tracking-wider ml-4" style={mono}>
            並び:
          </span>
          <div className="flex gap-1">
            {(Object.keys(SORT_META) as SortMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setSortMode(m)}
                className="px-2.5 py-1 text-xs transition-all"
                style={{
                  ...mono,
                  clipPath: clip(4),
                  border: `1px solid ${sortMode === m ? "var(--color-accent-2)" : "var(--color-border)"}`,
                  color: sortMode === m ? "var(--color-accent-2)" : "var(--color-text-secondary)",
                  background: sortMode === m ? "rgba(255,43,214,0.08)" : "transparent",
                }}
              >
                {SORT_META[m]}
              </button>
            ))}
          </div>
        </div>
      )}

      {itemsLoading ? (
        <div className="text-center py-8 text-[var(--color-text-secondary)]">読み込み中...</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {displayItems.map((item) => (
            <FavoriteCard
              key={item.id}
              item={item}
              price={prices[item.ticker]}
              spark={sparks[item.ticker]}
              tf={effectiveTf(item.ticker)}
              isOverridden={tfOverrides[item.ticker] !== undefined}
              tickerBadges={badges[item.ticker]}
              onTfChange={(tf) => setTfOverrides((prev) => ({ ...prev, [item.ticker]: tf }))}
              onOpen={() => router.push(`/stock/${item.ticker}`)}
              onRemove={() => handleRemoveStock(item.id!)}
            />
          ))}
        </div>
      )}

      {/* Group info */}
      {activeGroup && items.length > 0 && (
        <div className="text-center text-[10px] text-[var(--color-text-secondary)] pt-2" style={mono}>
          {activeGroup.name} — {items.length}銘柄 | ダブルクリックでグループ名変更
        </div>
      )}
    </div>
  );
}

/* ============================================================ */
/* Favorite Card (カード式: 中央スパークライン + 大きな価格 + スコア) */
/* ============================================================ */

function FavoriteCard({
  item,
  price,
  spark,
  tf,
  isOverridden,
  tickerBadges,
  onTfChange,
  onOpen,
  onRemove,
}: {
  item: WatchlistItem;
  price?: PriceData;
  spark?: (SparkEntry & { tf: Tf });
  tf: Tf;
  isOverridden: boolean;
  tickerBadges?: TickerBadges;
  onTfChange: (tf: Tf) => void;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const isUp = price ? price.changePct >= 0 : true;
  const color = isUp ? "var(--color-up)" : "var(--color-down)";
  const arrow = isUp ? "+" : "";
  const monthUp = (spark?.periodChangePct ?? 0) >= 0;
  // 表示中データの時間軸がまだ切替前なら loading 扱い
  const sparkReady = spark && spark.tf === tf && spark.closes.length >= 2;

  return (
    <div
      data-ticker={item.ticker}
      className="relative bg-card border border-[var(--color-border)] hover:border-[var(--color-accent)]/40 transition-all duration-200 cursor-pointer group"
      style={{ clipPath: clip(10), boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)" }}
      onClick={onOpen}
    >
      <span className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-accent)] opacity-60" />
      <span className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[var(--color-accent-2)] opacity-60" />

      {/* ヘッダ: ticker + 名前 + 削除 */}
      <div className="flex items-start justify-between px-4 pt-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-bold text-[var(--color-accent)]" style={mono}>{item.ticker}</span>
            <span
              className="text-[9px] px-1 py-0.5"
              style={{
                ...mono,
                background: item.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.12)",
                color: item.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)",
              }}
            >
              {item.market}
            </span>
          </div>
          <div className="text-xs text-[var(--color-text)] truncate mt-0.5">{item.name}</div>
          {/* 気づきバッジ: 意図的に調べなくても異変が目に入る */}
          {tickerBadges && (tickerBadges.verdictChanged || tickerBadges.contested || tickerBadges.earningsInDays !== null) && (
            <div className="flex flex-wrap gap-1 mt-1">
              {tickerBadges.verdictChanged && (
                <span
                  className="text-[9px] px-1.5 py-0.5 font-bold"
                  title={`評決変化: ${tickerBadges.verdictChanged}`}
                  style={{ ...mono, background: "rgba(0,240,255,0.12)", color: "var(--color-accent)", border: "1px solid rgba(0,240,255,0.45)" }}
                >
                  🔄 {tickerBadges.verdictChanged}
                </span>
              )}
              {tickerBadges.contested && (
                <span
                  className="text-[9px] px-1.5 py-0.5 font-bold"
                  title="いずれかの時間軸で見解が対立中 — 個別ページの Verdict を確認"
                  style={{ ...mono, background: "rgba(167,139,250,0.12)", color: "#a78bfa", border: "1px solid rgba(167,139,250,0.5)" }}
                >
                  ⚡ 対立中
                </span>
              )}
              {tickerBadges.earningsInDays !== null && (
                <span
                  className="text-[9px] px-1.5 py-0.5 font-bold"
                  title="決算発表が近い — ボラティリティ警戒"
                  style={{ ...mono, background: "rgba(251,191,36,0.12)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.5)" }}
                >
                  🗓 決算{tickerBadges.earningsInDays === 0 ? "本日" : `${tickerBadges.earningsInDays}日後`}
                </span>
              )}
            </div>
          )}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="opacity-0 group-hover:opacity-100 transition-opacity w-7 h-7 flex items-center justify-center text-[var(--color-text-secondary)] hover:text-red-400 shrink-0"
          title="削除"
        >
          ✕
        </button>
      </div>

      {/* 中央: スパークライン */}
      <div className="px-3 pt-2">
        {sparkReady ? (
          <Sparkline closes={spark.closes} up={monthUp} />
        ) : (
          <div className="h-[64px] flex items-center justify-center text-[10px] text-[var(--color-text-secondary)]" style={mono}>
            chart loading...
          </div>
        )}
        <div className="flex items-center justify-between text-[9px] px-1" style={mono}>
          {/* 時間軸チップ (個別上書き) */}
          <div className="flex gap-0.5" onClick={(e) => e.stopPropagation()}>
            {TF_ORDER.map((t) => (
              <button
                key={t}
                onClick={() => onTfChange(t)}
                className="px-1.5 py-0.5 transition-all"
                style={{
                  ...mono,
                  fontSize: "8px",
                  color: tf === t ? "var(--color-accent)" : "var(--color-text-secondary)",
                  background: tf === t ? "rgba(0,240,255,0.10)" : "transparent",
                  border: `1px solid ${tf === t ? "rgba(0,240,255,0.4)" : "transparent"}`,
                  opacity: tf === t ? 1 : 0.55,
                }}
              >
                {TF_META[t].label}
              </button>
            ))}
            {isOverridden && <span className="text-[var(--color-accent-2)] ml-0.5">✦</span>}
          </div>
          {sparkReady && spark.periodChangePct !== null && (
            <span style={{ color: monthUp ? "var(--color-up)" : "var(--color-down)" }}>
              {TF_META[tf].periodLabel} {monthUp ? "+" : ""}{spark.periodChangePct.toFixed(1)}%
            </span>
          )}
        </div>
      </div>

      {/* 価格 (主役) */}
      <div className="px-4 pt-1.5 flex items-baseline justify-between gap-2 flex-wrap">
        {price ? (
          <>
            <span
              className="text-2xl font-black leading-none"
              style={{ ...mono, color, textShadow: `0 0 10px ${isUp ? "rgba(255,59,107,0.35)" : "rgba(0,217,255,0.35)"}` }}
            >
              {price.currency === "JPY" ? `¥${price.price.toLocaleString()}` : `$${price.price.toFixed(2)}`}
            </span>
            <span
              className="text-sm px-1.5 py-0.5 font-bold"
              style={{
                ...mono,
                color,
                backgroundColor: isUp ? "rgba(255,59,107,0.10)" : "rgba(0,217,255,0.10)",
                border: `1px solid ${isUp ? "rgba(255,59,107,0.5)" : "rgba(0,217,255,0.5)"}`,
                clipPath: clip(4),
              }}
            >
              {arrow}{price.changePct.toFixed(2)}%
            </span>
          </>
        ) : (
          <span className="text-sm text-[var(--color-text-secondary)]" style={mono}>---</span>
        )}
      </div>

      {/* フッタ: S/M/L スコア */}
      <div className="px-4 pb-3 pt-2">
        {spark?.scores ? (
          <div className="grid grid-cols-4 gap-1.5">
            <ScoreCell label="総合" value={spark.scores.overall} bold />
            <ScoreCell label="短" value={spark.scores.short} />
            <ScoreCell label="中" value={spark.scores.mid} />
            <ScoreCell label="長" value={spark.scores.long} />
          </div>
        ) : (
          <div className="text-[9px] text-[var(--color-text-secondary)] text-center opacity-50" style={mono}>
            スコア未算出 (日経225/S&P500 対象外)
          </div>
        )}
      </div>
    </div>
  );
}

function ScoreCell({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  const color = value >= 65 ? "var(--color-up)" : value < 45 ? "var(--color-down)" : "var(--color-text)";
  return (
    <div className="text-center py-1 border border-[var(--color-border)]" style={{ background: "rgba(0,0,0,0.25)" }}>
      <div className="text-[8px] text-[var(--color-text-secondary)]" style={mono}>{label}</div>
      <div className={`leading-none mt-0.5 ${bold ? "text-base font-black" : "text-sm font-bold"}`} style={{ ...mono, color }}>
        {value}
      </div>
    </div>
  );
}

/** 依存ゼロの SVG スパークライン (グラデーション塗り + 終値ドット) */
function Sparkline({ closes, up }: { closes: number[]; up: boolean }) {
  const W = 260;
  const H = 64;
  const PAD = 4;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const stepX = (W - PAD * 2) / (closes.length - 1);
  const pts = closes.map((c, i) => ({
    x: PAD + i * stepX,
    y: PAD + (H - PAD * 2) * (1 - (c - min) / span),
  }));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${H - PAD} L${PAD},${H - PAD} Z`;
  const stroke = up ? "#ff3b6b" : "#00d9ff";
  const gid = `sg-${up ? "u" : "d"}`;
  const last = pts[pts.length - 1];
  // 始値の基準線
  const baseY = PAD + (H - PAD * 2) * (1 - (closes[0] - min) / span);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[64px]" preserveAspectRatio="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <line x1={PAD} y1={baseY} x2={W - PAD} y2={baseY} stroke="rgba(255,255,255,0.12)" strokeDasharray="3,3" strokeWidth="1" />
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last.x} cy={last.y} r="2.5" fill={stroke}>
        <animate attributeName="opacity" values="1;0.3;1" dur="2s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}
