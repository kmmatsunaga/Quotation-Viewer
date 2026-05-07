"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import {
  getHoldings,
  addHolding,
  updateHolding,
  deleteHolding,
  type Holding,
} from "@/lib/firestore";
import {
  getPortfolioSnapshots,
  savePortfolioSnapshot,
  type PortfolioSnapshot,
} from "@/lib/firestore-snapshots";
import {
  searchStocksAPI,
  type StockSearchResult,
} from "@/lib/stock-search";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

// 価格情報の型
interface PriceInfo {
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  currency: string;
}

// 個別ロット（holding + 評価額情報）
interface HoldingWithValue extends Holding {
  currentPrice: number | null;
  marketValue: number | null;
  pnl: number | null;
  pnlPct: number | null;
  marketValueJpy: number | null;
  costBasisJpy: number;
}

// 銘柄グループ（同一ティッカーをまとめた集約行）
interface TickerGroup {
  ticker: string;
  name: string;
  market: string;
  totalShares: number;
  weightedAvgCost: number;
  totalCostBasis: number;
  currentPrice: number | null;
  totalMarketValue: number | null;
  totalPnl: number | null;
  totalPnlPct: number | null;
  totalMarketValueJpy: number | null;
  totalCostBasisJpy: number;
  lots: HoldingWithValue[];
}

export default function PortfolioPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    ticker: "",
    name: "",
    shares: "100",
    avgCost: "",
    market: "JP",
    purchaseDate: new Date().toISOString().slice(0, 10),
  });
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  // 編集
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ shares: "", avgCost: "", purchaseDate: "" });
  const [editSubmitting, setEditSubmitting] = useState(false);

  // 削除確認モーダル
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; ticker: string; name: string; shares: number } | null>(null);

  // 展開中のグループ
  const [expandedTickers, setExpandedTickers] = useState<Set<string>>(new Set());

  // 現在価格
  const [prices, setPrices] = useState<Record<string, PriceInfo>>({});
  const [usdJpy, setUsdJpy] = useState<number | null>(null);
  const [pricesLoading, setPricesLoading] = useState(false);

  // オートコンプリート
  const [searchQuery, setSearchQuery] = useState("");
  const [suggestions, setSuggestions] = useState<StockSearchResult[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const searchRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 外側クリックでサジェスト閉じる
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // 検索キーワードが変わったらAPI検索（300msデバウンス）
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (searchQuery.length === 0) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const results = await searchStocksAPI(searchQuery);
      setSuggestions(results);
      setShowSuggestions(results.length > 0);
      setSelectedIndex(-1);
      setSearching(false);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery]);

  // 銘柄選択
  const selectStock = (stock: StockSearchResult) => {
    setFormData({
      ...formData,
      ticker: stock.ticker,
      name: stock.name,
      market: stock.market === "JP" ? "JP" : "US",
    });
    setSearchQuery("");
    setShowSuggestions(false);
  };

  // キーボード操作
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && selectedIndex >= 0) {
      e.preventDefault();
      selectStock(suggestions[selectedIndex]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  // データ取得
  const loadData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [h, s] = await Promise.all([
        getHoldings(user.uid),
        getPortfolioSnapshots(user.uid, 90),
      ]);
      setHoldings(h);
      setSnapshots(s);

      // 今日のスナップショットが無ければ保存
      const today = new Date().toISOString().slice(0, 10);
      const hasToday = s.some((sn) => sn.date === today);
      if (!hasToday && h.length > 0) {
        const totalCost = h.reduce(
          (sum, item) => sum + item.shares * item.avgCost,
          0
        );
        await savePortfolioSnapshot(user.uid, {
          date: today,
          totalValue: totalCost,
          totalCost,
          holdingsCount: h.length,
        });
        const updated = await getPortfolioSnapshots(user.uid, 90);
        setSnapshots(updated);
      }
    } catch (err) {
      console.error("Failed to load portfolio:", err);
    }
    setLoading(false);
  }, [user]);

  // 現在価格を取得
  const fetchPrices = useCallback(async (holdingsList: Holding[]) => {
    if (holdingsList.length === 0) return;
    setPricesLoading(true);
    try {
      // 重複ティッカーを除去
      const uniqueTickers = [...new Set(holdingsList.map((h) => h.ticker))];
      const res = await fetch(`/api/stocks/prices?tickers=${encodeURIComponent(uniqueTickers.join(","))}`);
      if (res.ok) {
        const data = await res.json();
        setPrices(data.prices ?? {});
        setUsdJpy(data.usdJpy ?? null);
      }
    } catch (err) {
      console.error("Failed to fetch prices:", err);
    }
    setPricesLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // holdingsが変わったら価格取得
  useEffect(() => {
    if (holdings.length > 0) {
      fetchPrices(holdings);
    }
  }, [holdings, fetchPrices]);

  // 銘柄追加
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSubmitting(true);
    try {
      await addHolding(user.uid, {
        ticker: formData.ticker.toUpperCase(),
        name: formData.name,
        shares: Number(formData.shares) || 1,
        avgCost: Number(formData.avgCost),
        market: formData.market,
        memo: "",
        purchaseDate: formData.purchaseDate,
      });
      setFormData({
        ticker: "",
        name: "",
        shares: "100",
        avgCost: "",
        market: "JP",
        purchaseDate: new Date().toISOString().slice(0, 10),
      });
      setShowForm(false);
      await loadData();
    } catch (err) {
      console.error("Failed to add holding:", err);
    }
    setSubmitting(false);
  };

  // 編集開始
  const startEdit = (h: Holding) => {
    setEditingId(h.id ?? null);
    setEditForm({
      shares: String(h.shares),
      avgCost: String(h.avgCost),
      purchaseDate: h.purchaseDate ?? "",
    });
  };

  // 編集保存
  const handleEditSave = async (holdingId: string) => {
    if (!user) return;
    setEditSubmitting(true);
    try {
      await updateHolding(user.uid, holdingId, {
        shares: Number(editForm.shares) || 1,
        avgCost: Number(editForm.avgCost) || 0,
        purchaseDate: editForm.purchaseDate,
      });
      setEditingId(null);
      await loadData();
    } catch (err) {
      console.error("Failed to update holding:", err);
    }
    setEditSubmitting(false);
  };

  // 削除確認モーダルを開く
  const requestDelete = (h: { id?: string; ticker: string; name: string; shares: number }) => {
    if (!h.id) return;
    setDeleteTarget({ id: h.id, ticker: h.ticker, name: h.name, shares: h.shares });
  };

  // 銘柄削除（モーダルから確定）
  const confirmDelete = async () => {
    if (!user || !deleteTarget) return;
    setDeleting(deleteTarget.id);
    setDeleteTarget(null);
    try {
      await deleteHolding(user.uid, deleteTarget.id);
      await loadData();
    } catch (err) {
      console.error("Failed to delete:", err);
    }
    setDeleting(null);
  };

  // グループ展開トグル
  const toggleExpand = (ticker: string) => {
    setExpandedTickers((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });
  };

  // === 集計計算 ===
  const currencySymbol = (market: string) => (market === "US" ? "$" : "¥");
  const formatPrice = (v: number, market: string) => {
    if (market === "US") return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return `¥${Math.round(v).toLocaleString("ja-JP")}`;
  };

  // 各銘柄の評価額計算
  const holdingsWithValue: HoldingWithValue[] = holdings.map((h) => {
    const p = prices[h.ticker];
    const costBasis = h.shares * h.avgCost;
    const currentPrice = p?.price ?? null;
    const marketValue = currentPrice !== null ? h.shares * currentPrice : null;
    const pnl = marketValue !== null ? marketValue - costBasis : null;
    const pnlPct = costBasis > 0 && pnl !== null ? (pnl / costBasis) * 100 : null;
    const marketValueJpy =
      marketValue !== null && h.market === "US" && usdJpy
        ? marketValue * usdJpy
        : marketValue;
    const costBasisJpy =
      h.market === "US" && usdJpy ? costBasis * usdJpy : costBasis;
    return { ...h, currentPrice, marketValue, pnl, pnlPct, marketValueJpy, costBasisJpy };
  });

  // ティッカー別にグループ化
  const tickerGroups: TickerGroup[] = (() => {
    const map = new Map<string, HoldingWithValue[]>();
    for (const h of holdingsWithValue) {
      const key = h.ticker;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(h);
    }
    const groups: TickerGroup[] = [];
    for (const [ticker, lots] of map) {
      const first = lots[0];
      const totalShares = lots.reduce((s, l) => s + l.shares, 0);
      const totalCostBasis = lots.reduce((s, l) => s + l.shares * l.avgCost, 0);
      const weightedAvgCost = totalShares > 0 ? totalCostBasis / totalShares : 0;
      const currentPrice = first.currentPrice;
      const totalMarketValue = currentPrice !== null ? totalShares * currentPrice : null;
      const totalPnl = totalMarketValue !== null ? totalMarketValue - totalCostBasis : null;
      const totalPnlPct = totalCostBasis > 0 && totalPnl !== null ? (totalPnl / totalCostBasis) * 100 : null;
      const totalMarketValueJpy = lots.reduce((s, l) => s + (l.marketValueJpy ?? l.costBasisJpy), 0);
      const totalCostBasisJpy = lots.reduce((s, l) => s + l.costBasisJpy, 0);
      // ロットを購入日順にソート
      lots.sort((a, b) => (a.purchaseDate ?? "").localeCompare(b.purchaseDate ?? ""));
      groups.push({
        ticker,
        name: first.name,
        market: first.market,
        totalShares,
        weightedAvgCost,
        totalCostBasis,
        currentPrice,
        totalMarketValue,
        totalPnl,
        totalPnlPct,
        totalMarketValueJpy,
        totalCostBasisJpy,
        lots,
      });
    }
    return groups;
  })();

  const totalCostJpy = holdingsWithValue.reduce((s, h) => s + h.costBasisJpy, 0);
  const totalValueJpy = holdingsWithValue.reduce((s, h) => s + (h.marketValueJpy ?? h.costBasisJpy), 0);
  const totalPnlJpy = totalValueJpy - totalCostJpy;
  const totalPnlPct = totalCostJpy > 0 ? (totalPnlJpy / totalCostJpy) * 100 : 0;

  // ユニーク銘柄数
  const uniqueTickerCount = tickerGroups.length;

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ヘッダ */}
      <div className="flex items-center justify-between">
        <h1
          className="text-sm uppercase tracking-[0.2em] text-[var(--color-accent)]"
          style={MONO}
        >
          // Portfolio
        </h1>
        {usdJpy && (
          <span className="text-xs text-[var(--color-text-secondary)]" style={MONO}>
            USD/JPY {usdJpy.toFixed(2)}
          </span>
        )}
      </div>

      {/* サマリーカード */}
      <div
        className="relative p-5 rounded"
        style={{
          border: "1px solid var(--color-border)",
          background: "var(--bg-card)",
          boxShadow:
            "inset 0 0 0 1px rgba(0,240,255,0.06), 0 0 20px rgba(0,240,255,0.08)",
        }}
      >
        <span className="absolute top-0 right-0 w-3 h-3 border-t border-r border-[var(--color-accent)] opacity-60" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* 評価額 */}
          <div>
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>
              Total Value (JPY)
            </span>
            <div
              className="text-2xl md:text-3xl font-bold mt-1"
              style={{
                ...MONO,
                color: "var(--color-accent)",
                textShadow: "0 0 14px rgba(0,240,255,0.5)",
              }}
            >
              ¥{Math.round(totalValueJpy).toLocaleString("ja-JP")}
            </div>
            {pricesLoading && (
              <span className="text-[10px] text-[var(--color-accent)] loading-pulse" style={MONO}>
                価格取得中...
              </span>
            )}
          </div>

          {/* 取得原価 */}
          <div>
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>
              Cost Basis (JPY)
            </span>
            <div className="text-xl font-bold mt-1 text-[var(--color-text)]" style={MONO}>
              ¥{Math.round(totalCostJpy).toLocaleString("ja-JP")}
            </div>
            <span className="text-xs text-[var(--color-text-secondary)]">
              {uniqueTickerCount} 銘柄 / {holdings.length} ロット保有
            </span>
          </div>

          {/* 損益 */}
          <div>
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>
              Unrealized P&L
            </span>
            <div
              className="text-xl font-bold mt-1"
              style={{
                ...MONO,
                color: totalPnlJpy >= 0 ? "var(--color-up)" : "var(--color-down)",
              }}
            >
              {totalPnlJpy >= 0 ? "+" : ""}¥{Math.round(totalPnlJpy).toLocaleString("ja-JP")}
            </div>
            <span
              className="text-xs font-medium px-1.5 py-0.5"
              style={{
                ...MONO,
                color: totalPnlJpy >= 0 ? "var(--color-up)" : "var(--color-down)",
                background: totalPnlJpy >= 0 ? "rgba(255,59,107,0.12)" : "rgba(0,217,255,0.12)",
              }}
            >
              {totalPnlPct >= 0 ? "+" : ""}{totalPnlPct.toFixed(2)}%
            </span>
          </div>
        </div>
      </div>

      {/* 資産推移チャート */}
      {snapshots.length > 1 && (
        <div
          className="p-4 rounded"
          style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}
        >
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-3" style={MONO}>
            Asset History
          </span>
          <PortfolioChart snapshots={snapshots} />
        </div>
      )}

      {/* 追加ボタン */}
      <button
        onClick={() => setShowForm(!showForm)}
        className="w-full md:w-auto px-4 py-2.5 text-sm font-medium min-h-[44px] transition-all"
        style={{
          border: "1px solid var(--color-accent)",
          color: "var(--color-accent)",
          background: showForm ? "rgba(0,240,255,0.1)" : "transparent",
          ...MONO,
        }}
      >
        {showForm ? "> CANCEL" : "> ADD HOLDING"}
      </button>

      {/* 追加フォーム */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="p-4 space-y-4 rounded"
          style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}
        >
          {/* 銘柄検索 */}
          <div ref={searchRef} className="relative">
            <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
              銘柄を検索
            </label>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
              className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
              style={MONO}
              placeholder="銘柄コードまたは企業名で検索 (例: イビデン, 7203, AAPL)"
            />
            {searching && (
              <span className="absolute right-3 top-[30px] text-[10px] text-[var(--color-accent)]" style={MONO}>
                検索中...
              </span>
            )}

            {/* サジェスト一覧 */}
            {showSuggestions && (
              <div
                className="absolute z-50 w-full mt-1 max-h-[280px] overflow-y-auto rounded"
                style={{
                  background: "var(--bg-card)",
                  border: "1px solid var(--color-accent)",
                  boxShadow: "0 4px 20px rgba(0,0,0,0.6), 0 0 12px rgba(0,240,255,0.15)",
                }}
              >
                {suggestions.map((s, i) => (
                  <button
                    key={`${s.ticker}-${s.market}`}
                    type="button"
                    className="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors"
                    style={{
                      background: i === selectedIndex ? "rgba(0,240,255,0.12)" : "transparent",
                      borderBottom: "1px solid var(--color-border)",
                    }}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => selectStock(s)}
                  >
                    <span
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={{
                        background: s.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)",
                        color: s.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)",
                        ...MONO,
                        fontSize: "10px",
                      }}
                    >
                      {s.market}
                    </span>
                    <span className="text-sm font-bold text-[var(--color-accent)]" style={MONO}>
                      {s.ticker}
                    </span>
                    <span className="text-sm text-[var(--color-text)] flex-1">{s.name}</span>
                    {s.exchange && (
                      <span className="text-[10px] text-[var(--color-text-secondary)] opacity-60">{s.exchange}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 選択された銘柄の表示 */}
          {formData.ticker && (
            <div
              className="flex items-center gap-3 px-3 py-2 rounded"
              style={{ background: "rgba(0,240,255,0.06)", border: "1px solid rgba(0,240,255,0.2)" }}
            >
              <span
                className="text-xs px-1.5 py-0.5"
                style={{
                  background: formData.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)",
                  color: formData.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)",
                  ...MONO,
                  fontSize: "10px",
                }}
              >
                {formData.market}
              </span>
              <span className="text-sm font-bold text-[var(--color-accent)]" style={MONO}>{formData.ticker}</span>
              <span className="text-sm text-[var(--color-text)]">{formData.name}</span>
              <button
                type="button"
                onClick={() => setFormData({ ...formData, ticker: "", name: "", market: "JP" })}
                className="ml-auto text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-up)] transition-colors"
                style={MONO}
              >
                {">"} CLEAR
              </button>
            </div>
          )}

          {/* 数量 / 取得単価 / 購入日 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
                数量（株数）
              </label>
              <input
                type="number"
                value={formData.shares}
                onChange={(e) => setFormData({ ...formData, shares: e.target.value })}
                min="1"
                className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
                style={MONO}
                placeholder="100"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
                取得単価（{formData.market === "US" ? "ドル" : "円"}）
              </label>
              <input
                type="number"
                value={formData.avgCost}
                onChange={(e) => setFormData({ ...formData, avgCost: e.target.value })}
                required
                min="0"
                step="0.01"
                className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
                style={MONO}
                placeholder={formData.market === "US" ? "150.00" : "3200"}
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
                購入日
              </label>
              <input
                type="date"
                value={formData.purchaseDate}
                onChange={(e) => setFormData({ ...formData, purchaseDate: e.target.value })}
                required
                className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
                style={{ ...MONO, colorScheme: "dark" }}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting || !formData.ticker || !formData.avgCost}
            className="w-full md:w-auto px-6 py-2.5 text-sm font-medium min-h-[44px] disabled:opacity-50 transition-all"
            style={{
              border: "1px solid var(--color-accent)",
              background: "rgba(0,240,255,0.12)",
              color: "var(--color-accent)",
              ...MONO,
              boxShadow: "0 0 14px rgba(0,240,255,0.3)",
            }}
          >
            {submitting ? "> SAVING..." : "> SAVE"}
          </button>
        </form>
      )}

      {/* 保有銘柄リスト（グループ化表示） */}
      <div className="rounded overflow-hidden" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}>
        {/* ヘッダー */}
        <div
          className="hidden md:grid grid-cols-8 gap-2 px-4 py-2 border-b border-[var(--color-border)]"
          style={{ ...MONO, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-secondary)" }}
        >
          <span>Ticker / Name</span>
          <span className="text-right">数量</span>
          <span className="text-right">平均単価</span>
          <span className="text-right">現在価格</span>
          <span className="text-right">評価額</span>
          <span className="text-right">損益</span>
          <span className="text-center">ロット</span>
          <span className="text-right">Action</span>
        </div>

        {tickerGroups.length === 0 && (
          <div className="py-12 text-center text-[var(--color-text-secondary)]">
            <p className="text-sm">保有銘柄がありません</p>
            <p className="text-xs mt-1">上のボタンから銘柄を追加してください</p>
          </div>
        )}

        {tickerGroups.map((g) => {
          const sym = currencySymbol(g.market);
          const isUp = (g.totalPnl ?? 0) >= 0;
          const pnlColor = isUp ? "var(--color-up)" : "var(--color-down)";
          const isExpanded = expandedTickers.has(g.ticker);
          const hasMultipleLots = g.lots.length > 1;

          return (
            <div key={g.ticker} className="border-b border-[var(--color-border)] last:border-b-0">
              {/* === モバイル サマリー行 === */}
              <div className="md:hidden p-3 space-y-2">
                <div className="flex justify-between items-start">
                  <div
                    className="cursor-pointer flex-1"
                    onClick={() => hasMultipleLots ? toggleExpand(g.ticker) : router.push(`/stock/${g.ticker}`)}
                  >
                    <div className="flex items-center gap-2">
                      {hasMultipleLots && (
                        <span className="text-[10px] text-[var(--color-accent)] transition-transform" style={{ display: "inline-block", transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}>
                          ▶
                        </span>
                      )}
                      <span
                        className="text-[9px] px-1 py-0.5"
                        style={{
                          background: g.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)",
                          color: g.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)",
                          ...MONO,
                        }}
                      >
                        {g.market}
                      </span>
                      <span className="text-[10px] text-[var(--color-accent)] tracking-[0.1em]" style={MONO}>
                        {g.ticker}
                      </span>
                    </div>
                    <div className="text-sm font-medium mt-0.5">{g.name}</div>
                  </div>
                  <div className="text-right">
                    {g.currentPrice !== null ? (
                      <>
                        <div className="text-sm font-bold" style={MONO}>
                          {formatPrice(g.currentPrice, g.market)}
                        </div>
                        {g.totalPnlPct !== null && (
                          <div className="text-xs font-medium" style={{ ...MONO, color: pnlColor }}>
                            {isUp ? "+" : ""}{g.totalPnlPct.toFixed(2)}%
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-xs text-[var(--color-text-secondary)] loading-pulse" style={MONO}>...</span>
                    )}
                  </div>
                </div>
                <div className="flex justify-between text-xs text-[var(--color-text-secondary)]">
                  <span>
                    {g.totalShares.toLocaleString()}株 @ {sym}{g.market === "US" ? g.weightedAvgCost.toFixed(2) : Math.round(g.weightedAvgCost).toLocaleString()}
                    {hasMultipleLots && <span className="ml-1 text-[var(--color-accent)] opacity-80">({g.lots.length}ロット)</span>}
                  </span>
                  {g.totalPnl !== null && (
                    <span style={{ ...MONO, color: pnlColor }}>
                      {isUp ? "+" : ""}{sym}{Math.abs(Math.round(g.totalPnl)).toLocaleString()}
                    </span>
                  )}
                </div>
              </div>

              {/* === デスクトップ サマリー行 === */}
              <div
                className="hidden md:grid grid-cols-8 gap-2 px-4 py-3 items-center transition-all"
                style={{
                  background: isExpanded ? "rgba(0,240,255,0.03)" : "transparent",
                }}
              >
                <div
                  className="cursor-pointer flex items-start gap-1"
                  onClick={() => hasMultipleLots ? toggleExpand(g.ticker) : router.push(`/stock/${g.ticker}`)}
                >
                  <div>
                    <div className="flex items-center gap-1.5">
                      {hasMultipleLots && (
                        <span
                          className="text-[9px] text-[var(--color-accent)] transition-transform inline-block"
                          style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
                        >
                          ▶
                        </span>
                      )}
                      <span
                        className="text-[9px] px-1 py-0.5"
                        style={{
                          background: g.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)",
                          color: g.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)",
                          ...MONO,
                        }}
                      >
                        {g.market}
                      </span>
                      <span className="text-[10px] text-[var(--color-accent)] tracking-[0.1em]" style={MONO}>
                        {g.ticker}
                      </span>
                    </div>
                    <div className="text-sm mt-0.5">{g.name}</div>
                  </div>
                </div>
                <span className="text-sm text-right font-bold" style={MONO}>
                  {g.totalShares.toLocaleString()}
                </span>
                <span className="text-sm text-right" style={MONO}>
                  {sym}{g.market === "US" ? g.weightedAvgCost.toFixed(2) : Math.round(g.weightedAvgCost).toLocaleString()}
                </span>
                <span className="text-sm text-right" style={MONO}>
                  {g.currentPrice !== null ? (
                    <span className="cursor-pointer hover:underline" onClick={() => router.push(`/stock/${g.ticker}`)}>
                      {formatPrice(g.currentPrice, g.market)}
                    </span>
                  ) : (
                    <span className="loading-pulse text-[var(--color-text-secondary)]">...</span>
                  )}
                </span>
                <span className="text-sm text-right font-bold" style={MONO}>
                  {g.totalMarketValue !== null ? formatPrice(g.totalMarketValue, g.market) : "—"}
                </span>
                <div className="text-right">
                  {g.totalPnl !== null ? (
                    <>
                      <div className="text-sm font-bold" style={{ ...MONO, color: pnlColor }}>
                        {isUp ? "+" : ""}{sym}{Math.abs(Math.round(g.totalPnl)).toLocaleString()}
                      </div>
                      <div className="text-[10px]" style={{ ...MONO, color: pnlColor }}>
                        {isUp ? "+" : ""}{g.totalPnlPct?.toFixed(2)}%
                      </div>
                    </>
                  ) : (
                    <span className="text-sm text-[var(--color-text-secondary)]">—</span>
                  )}
                </div>
                <span className="text-center">
                  {hasMultipleLots ? (
                    <button
                      onClick={() => toggleExpand(g.ticker)}
                      className="text-xs text-[var(--color-accent)] hover:underline px-2 py-1"
                      style={MONO}
                    >
                      {g.lots.length}ロット {isExpanded ? "▲" : "▼"}
                    </button>
                  ) : (
                    <span className="text-xs text-[var(--color-text-secondary)]" style={MONO}>1</span>
                  )}
                </span>
                <div className="text-right flex gap-1 justify-end">
                  {/* 1ロットの場合はサマリー行に直接EDIT/DELを表示 */}
                  {!hasMultipleLots && (
                    <>
                      <button
                        onClick={(e) => { e.stopPropagation(); startEdit(g.lots[0]); }}
                        className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] px-1.5 py-1 transition-colors"
                        style={{ ...MONO, border: "1px solid transparent" }}
                        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--color-accent)")}
                        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}
                      >
                        EDIT
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); requestDelete(g.lots[0]); }}
                        disabled={deleting === g.lots[0].id}
                        className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-up)] px-1.5 py-1 disabled:opacity-50 transition-colors"
                        style={{ ...MONO, border: "1px solid transparent" }}
                        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--color-up)")}
                        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}
                      >
                        {deleting === g.lots[0].id ? "..." : "DEL"}
                      </button>
                    </>
                  )}
                  {/* 複数ロットの場合は展開ボタン */}
                  {hasMultipleLots && !isExpanded && (
                    <button
                      onClick={() => toggleExpand(g.ticker)}
                      className="text-xs text-[var(--color-accent)] hover:underline px-1.5 py-1"
                      style={MONO}
                    >
                      詳細
                    </button>
                  )}
                </div>
              </div>

              {/* === 展開ロット（モバイル + デスクトップ共通） === */}
              {isExpanded && hasMultipleLots && (
                <div>
                  {g.lots.map((lot) => {
                    const lotSym = currencySymbol(lot.market);
                    const lotIsUp = (lot.pnl ?? 0) >= 0;
                    const lotPnlColor = lotIsUp ? "var(--color-up)" : "var(--color-down)";
                    const isEditingThis = editingId === lot.id;

                    return (
                      <div key={lot.id}>
                        {/* 編集フォーム（インライン） */}
                        {isEditingThis ? (
                          <div
                            className="px-4 md:px-8 py-3 space-y-3"
                            style={{
                              background: "rgba(0,240,255,0.05)",
                              borderTop: "1px solid rgba(0,240,255,0.15)",
                              borderBottom: "1px solid rgba(0,240,255,0.15)",
                            }}
                          >
                            <div className="text-[10px] text-[var(--color-accent)] uppercase tracking-[0.1em]" style={MONO}>
                              ▸ ロット編集 — {lot.purchaseDate || "日付なし"}
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              <div>
                                <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>数量</label>
                                <input
                                  type="number"
                                  value={editForm.shares}
                                  onChange={(e) => setEditForm({ ...editForm, shares: e.target.value })}
                                  min="1"
                                  className="w-full bg-[var(--bg-input)] border border-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none min-h-[40px]"
                                  style={MONO}
                                />
                              </div>
                              <div>
                                <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
                                  取得単価（{lot.market === "US" ? "ドル" : "円"}）
                                </label>
                                <input
                                  type="number"
                                  value={editForm.avgCost}
                                  onChange={(e) => setEditForm({ ...editForm, avgCost: e.target.value })}
                                  min="0"
                                  step="0.01"
                                  className="w-full bg-[var(--bg-input)] border border-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none min-h-[40px]"
                                  style={MONO}
                                />
                              </div>
                              <div>
                                <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>購入日</label>
                                <input
                                  type="date"
                                  value={editForm.purchaseDate}
                                  onChange={(e) => setEditForm({ ...editForm, purchaseDate: e.target.value })}
                                  className="w-full bg-[var(--bg-input)] border border-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none min-h-[40px]"
                                  style={{ ...MONO, colorScheme: "dark" }}
                                />
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={() => lot.id && handleEditSave(lot.id)}
                                disabled={editSubmitting}
                                className="px-4 py-1.5 text-xs font-medium disabled:opacity-50"
                                style={{
                                  border: "1px solid var(--color-accent)",
                                  background: "rgba(0,240,255,0.15)",
                                  color: "var(--color-accent)",
                                  ...MONO,
                                }}
                              >
                                {editSubmitting ? "SAVING..." : "SAVE"}
                              </button>
                              <button
                                onClick={() => setEditingId(null)}
                                className="px-4 py-1.5 text-xs"
                                style={{
                                  border: "1px solid var(--color-border)",
                                  color: "var(--color-text-secondary)",
                                  ...MONO,
                                }}
                              >
                                CANCEL
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {/* モバイル ロット行 */}
                            <div className="md:hidden px-6 py-2 border-t border-[var(--color-border)]" style={{ background: "rgba(0,240,255,0.02)" }}>
                              <div className="flex justify-between text-xs">
                                <span className="text-[var(--color-text-secondary)]">
                                  {lot.purchaseDate || "—"} ／ {lot.shares}株 @ {lotSym}{lot.avgCost.toLocaleString()}
                                </span>
                                <div className="flex gap-2 items-center">
                                  {lot.pnl !== null && (
                                    <span style={{ ...MONO, color: lotPnlColor }}>
                                      {lotIsUp ? "+" : ""}{lotSym}{Math.abs(Math.round(lot.pnl)).toLocaleString()}
                                    </span>
                                  )}
                                  <button
                                    onClick={() => startEdit(lot)}
                                    className="text-[var(--color-accent)] opacity-70"
                                    style={MONO}
                                  >
                                    EDIT
                                  </button>
                                  <button
                                    onClick={() => requestDelete(lot)}
                                    className="text-[var(--color-up)] opacity-70"
                                    style={MONO}
                                  >
                                    DEL
                                  </button>
                                </div>
                              </div>
                            </div>

                            {/* デスクトップ ロット行 */}
                            <div
                              className="hidden md:grid grid-cols-8 gap-2 px-4 py-2 items-center text-xs"
                              style={{
                                background: "rgba(0,240,255,0.02)",
                                borderTop: "1px dashed rgba(0,240,255,0.1)",
                                paddingLeft: "2.5rem",
                              }}
                            >
                              <div className="flex items-center gap-1.5">
                                <span className="text-[var(--color-text-secondary)] opacity-50" style={MONO}>└</span>
                                <span className="text-[var(--color-text-secondary)]" style={MONO}>
                                  {lot.purchaseDate || "—"}
                                </span>
                              </div>
                              <span className="text-right text-[var(--color-text-secondary)]" style={MONO}>
                                {lot.shares.toLocaleString()}
                              </span>
                              <span className="text-right text-[var(--color-text-secondary)]" style={MONO}>
                                {lotSym}{lot.avgCost.toLocaleString()}
                              </span>
                              <span className="text-right text-[var(--color-text-secondary)]" style={MONO}>
                                —
                              </span>
                              <span className="text-right text-[var(--color-text-secondary)]" style={MONO}>
                                {lot.marketValue !== null ? formatPrice(lot.marketValue, lot.market) : "—"}
                              </span>
                              <div className="text-right">
                                {lot.pnl !== null ? (
                                  <>
                                    <div style={{ ...MONO, color: lotPnlColor }}>
                                      {lotIsUp ? "+" : ""}{lotSym}{Math.abs(Math.round(lot.pnl)).toLocaleString()}
                                    </div>
                                    <div className="text-[9px] opacity-70" style={{ ...MONO, color: lotPnlColor }}>
                                      {lotIsUp ? "+" : ""}{lot.pnlPct?.toFixed(2)}%
                                    </div>
                                  </>
                                ) : (
                                  <span className="text-[var(--color-text-secondary)]">—</span>
                                )}
                              </div>
                              <span />
                              <div className="text-right flex gap-1 justify-end">
                                <button
                                  onClick={(e) => { e.stopPropagation(); startEdit(lot); }}
                                  className="text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] px-1.5 py-0.5 transition-colors"
                                  style={{ ...MONO, border: "1px solid transparent" }}
                                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--color-accent)")}
                                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}
                                >
                                  EDIT
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); requestDelete(lot); }}
                                  disabled={deleting === lot.id}
                                  className="text-[var(--color-text-secondary)] hover:text-[var(--color-up)] px-1.5 py-0.5 disabled:opacity-50 transition-colors"
                                  style={{ ...MONO, border: "1px solid transparent" }}
                                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--color-up)")}
                                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}
                                >
                                  {deleting === lot.id ? "..." : "DEL"}
                                </button>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 1ロットの場合の編集フォーム（展開不要） */}
              {!hasMultipleLots && editingId === g.lots[0].id && (
                <div
                  className="px-4 md:px-8 py-3 space-y-3"
                  style={{
                    background: "rgba(0,240,255,0.05)",
                    borderTop: "1px solid rgba(0,240,255,0.15)",
                  }}
                >
                  <div className="text-[10px] text-[var(--color-accent)] uppercase tracking-[0.1em]" style={MONO}>
                    ▸ 編集
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>数量</label>
                      <input
                        type="number"
                        value={editForm.shares}
                        onChange={(e) => setEditForm({ ...editForm, shares: e.target.value })}
                        min="1"
                        className="w-full bg-[var(--bg-input)] border border-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none min-h-[40px]"
                        style={MONO}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
                        取得単価（{g.market === "US" ? "ドル" : "円"}）
                      </label>
                      <input
                        type="number"
                        value={editForm.avgCost}
                        onChange={(e) => setEditForm({ ...editForm, avgCost: e.target.value })}
                        min="0"
                        step="0.01"
                        className="w-full bg-[var(--bg-input)] border border-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none min-h-[40px]"
                        style={MONO}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>購入日</label>
                      <input
                        type="date"
                        value={editForm.purchaseDate}
                        onChange={(e) => setEditForm({ ...editForm, purchaseDate: e.target.value })}
                        className="w-full bg-[var(--bg-input)] border border-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none min-h-[40px]"
                        style={{ ...MONO, colorScheme: "dark" }}
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => g.lots[0].id && handleEditSave(g.lots[0].id)}
                      disabled={editSubmitting}
                      className="px-4 py-1.5 text-xs font-medium disabled:opacity-50"
                      style={{
                        border: "1px solid var(--color-accent)",
                        background: "rgba(0,240,255,0.15)",
                        color: "var(--color-accent)",
                        ...MONO,
                      }}
                    >
                      {editSubmitting ? "SAVING..." : "SAVE"}
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="px-4 py-1.5 text-xs"
                      style={{
                        border: "1px solid var(--color-border)",
                        color: "var(--color-text-secondary)",
                        ...MONO,
                      }}
                    >
                      CANCEL
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* === 削除確認モーダル === */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: "rgba(5,6,13,0.85)", backdropFilter: "blur(4px)" }}
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className="relative w-[90vw] max-w-md p-6 rounded space-y-5"
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--color-up)",
              boxShadow: "0 0 40px rgba(255,59,107,0.2), inset 0 0 0 1px rgba(255,59,107,0.1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* コーナーアクセント */}
            <span className="absolute top-0 left-0 w-4 h-4 border-t border-l" style={{ borderColor: "var(--color-up)" }} />
            <span className="absolute top-0 right-0 w-4 h-4 border-t border-r" style={{ borderColor: "var(--color-up)" }} />
            <span className="absolute bottom-0 left-0 w-4 h-4 border-b border-l" style={{ borderColor: "var(--color-up)" }} />
            <span className="absolute bottom-0 right-0 w-4 h-4 border-b border-r" style={{ borderColor: "var(--color-up)" }} />

            {/* タイトル */}
            <div className="flex items-center gap-2">
              <span className="text-[var(--color-up)] text-lg">⚠</span>
              <span
                className="text-xs uppercase tracking-[0.15em] text-[var(--color-up)]"
                style={MONO}
              >
                Delete Confirmation
              </span>
            </div>

            {/* 対象銘柄情報 */}
            <div
              className="px-3 py-2.5 rounded"
              style={{ background: "rgba(255,59,107,0.06)", border: "1px solid rgba(255,59,107,0.15)" }}
            >
              <div className="text-sm font-bold text-[var(--color-text)]" style={MONO}>
                {deleteTarget.ticker} — {deleteTarget.name}
              </div>
              <div className="text-xs text-[var(--color-text-secondary)] mt-0.5" style={MONO}>
                {deleteTarget.shares.toLocaleString()} 株
              </div>
            </div>

            <p className="text-sm text-[var(--color-text-secondary)]">
              このロットを削除しますか？この操作は取り消せません。
            </p>

            {/* ボタン */}
            <div className="flex gap-3 justify-end pt-1">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-5 py-2 text-xs min-h-[40px] transition-all"
                style={{
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-secondary)",
                  background: "transparent",
                  ...MONO,
                }}
              >
                CANCEL
              </button>
              <button
                onClick={confirmDelete}
                className="px-5 py-2 text-xs font-medium min-h-[40px] transition-all"
                style={{
                  border: "1px solid var(--color-up)",
                  background: "rgba(255,59,107,0.15)",
                  color: "var(--color-up)",
                  boxShadow: "0 0 12px rgba(255,59,107,0.25)",
                  ...MONO,
                }}
              >
                DELETE
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ========================================
// 資産推移チャート（SVGベース）
// ========================================
function PortfolioChart({ snapshots }: { snapshots: PortfolioSnapshot[] }) {
  if (snapshots.length < 2) return null;

  const W = 800;
  const H = 200;
  const PX = 40;
  const PY = 20;
  const chartW = W - PX * 2;
  const chartH = H - PY * 2;

  const values = snapshots.map((s) => s.totalValue);
  const minV = Math.min(...values) * 0.98;
  const maxV = Math.max(...values) * 1.02;
  const rangeV = maxV - minV || 1;

  const points = snapshots.map((s, i) => {
    const x = PX + (i / (snapshots.length - 1)) * chartW;
    const y = PY + chartH - ((s.totalValue - minV) / rangeV) * chartH;
    return `${x},${y}`;
  });

  const polyline = points.join(" ");
  const areaPoints = `${PX},${PY + chartH} ${polyline} ${PX + chartW},${PY + chartH}`;

  const isUp = values[values.length - 1] >= values[0];
  const lineColor = isUp ? "var(--color-up)" : "var(--color-down)";
  const glowColor = isUp ? "rgba(255,59,107,0.5)" : "rgba(0,217,255,0.5)";
  const fillColor = isUp ? "rgba(255,59,107,0.08)" : "rgba(0,217,255,0.08)";

  const yLabels = [minV, (minV + maxV) / 2, maxV].map((v) => ({
    value: v,
    y: PY + chartH - ((v - minV) / rangeV) * chartH,
  }));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 220 }}>
      <defs>
        <filter id="chart-glow">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>
      {yLabels.map((l, i) => (
        <g key={i}>
          <line x1={PX} y1={l.y} x2={PX + chartW} y2={l.y} stroke="var(--color-border)" strokeWidth="0.5" strokeDasharray="4 4" />
          <text x={PX - 5} y={l.y + 3} textAnchor="end" fill="var(--color-text-secondary)" fontSize="9" fontFamily="'JetBrains Mono', monospace">
            {(l.value / 10000).toFixed(0)}万
          </text>
        </g>
      ))}
      <text x={PX} y={H - 2} fill="var(--color-text-secondary)" fontSize="9" fontFamily="'JetBrains Mono', monospace">
        {snapshots[0].date.slice(5)}
      </text>
      <text x={PX + chartW} y={H - 2} textAnchor="end" fill="var(--color-text-secondary)" fontSize="9" fontFamily="'JetBrains Mono', monospace">
        {snapshots[snapshots.length - 1].date.slice(5)}
      </text>
      <polygon points={areaPoints} fill={fillColor} />
      <polyline points={polyline} fill="none" stroke={glowColor} strokeWidth="4" filter="url(#chart-glow)" />
      <polyline points={polyline} fill="none" stroke={lineColor} strokeWidth="2" strokeLinejoin="round" />
      {points.length > 0 && (
        <circle
          cx={parseFloat(points[points.length - 1].split(",")[0])}
          cy={parseFloat(points[points.length - 1].split(",")[1])}
          r="4"
          fill={lineColor}
          style={{ filter: `drop-shadow(0 0 6px ${glowColor})` }}
        />
      )}
    </svg>
  );
}
