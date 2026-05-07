"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import {
  getHoldings,
  addHolding,
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

  useEffect(() => {
    loadData();
  }, [loadData]);

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

  // 銘柄削除
  const handleDelete = async (id: string) => {
    if (!user || !confirm("この保有銘柄を削除しますか？")) return;
    setDeleting(id);
    try {
      await deleteHolding(user.uid, id);
      await loadData();
    } catch (err) {
      console.error("Failed to delete:", err);
    }
    setDeleting(null);
  };

  // 集計
  const totalCost = holdings.reduce(
    (sum, h) => sum + h.shares * h.avgCost,
    0
  );

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
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          // Portfolio
        </h1>
      </div>

      {/* サマリーカード */}
      <div
        className="relative p-4 md:p-6"
        style={{
          border: "1px solid var(--color-border)",
          background: "var(--bg-card)",
          clipPath:
            "polygon(12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 12px)",
          boxShadow:
            "inset 0 0 0 1px rgba(0,240,255,0.06), 0 0 20px rgba(0,240,255,0.08)",
        }}
      >
        <span className="absolute top-0 right-0 w-3 h-3 border-t border-r border-[var(--color-accent)] opacity-60" />
        <span className="absolute bottom-0 left-0 w-3 h-3 border-b border-l border-[var(--color-accent-2)] opacity-60" />
        <span
          className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          Total Asset (Cost Basis)
        </span>
        <div
          className="text-2xl md:text-3xl font-bold mt-2"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            color: "var(--color-accent)",
            textShadow: "0 0 14px rgba(0,240,255,0.5)",
          }}
        >
          ¥{totalCost.toLocaleString("ja-JP")}
        </div>
        <div className="flex items-center gap-3 mt-2 text-xs text-[var(--color-text-secondary)]">
          <span>{holdings.length} 銘柄保有</span>
        </div>
      </div>

      {/* 資産推移チャート */}
      {snapshots.length > 1 && (
        <div
          className="p-4"
          style={{
            border: "1px solid var(--color-border)",
            background: "var(--bg-card)",
          }}
        >
          <span
            className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-3"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
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
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {showForm ? "> CANCEL" : "> ADD HOLDING"}
      </button>

      {/* 追加フォーム */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="p-4 space-y-4"
          style={{
            border: "1px solid var(--color-border)",
            background: "var(--bg-card)",
          }}
        >
          {/* 銘柄検索 */}
          <div ref={searchRef} className="relative">
            <label
              className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              銘柄を検索
            </label>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              onFocus={() => {
                if (suggestions.length > 0) setShowSuggestions(true);
              }}
              className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
              placeholder="銘柄コードまたは企業名で検索 (例: イビデン, 7203, AAPL)"
            />
            {searching && (
              <span
                className="absolute right-3 top-[30px] text-[10px] text-[var(--color-accent)]"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                検索中...
              </span>
            )}

            {/* サジェスト一覧 */}
            {showSuggestions && (
              <div
                className="absolute z-50 w-full mt-1 max-h-[280px] overflow-y-auto"
                style={{
                  background: "var(--bg-card)",
                  border: "1px solid var(--color-accent)",
                  boxShadow:
                    "0 4px 20px rgba(0,0,0,0.6), 0 0 12px rgba(0,240,255,0.15)",
                }}
              >
                {suggestions.map((s, i) => (
                  <button
                    key={`${s.ticker}-${s.market}`}
                    type="button"
                    className="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors"
                    style={{
                      background:
                        i === selectedIndex
                          ? "rgba(0,240,255,0.12)"
                          : "transparent",
                      borderBottom: "1px solid var(--color-border)",
                    }}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => selectStock(s)}
                  >
                    <span
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={{
                        background:
                          s.market === "US"
                            ? "rgba(255,43,214,0.15)"
                            : "rgba(0,240,255,0.15)",
                        color:
                          s.market === "US"
                            ? "var(--color-accent-2)"
                            : "var(--color-accent)",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: "10px",
                      }}
                    >
                      {s.market}
                    </span>
                    <span
                      className="text-sm font-bold text-[var(--color-accent)]"
                      style={{ fontFamily: "'JetBrains Mono', monospace" }}
                    >
                      {s.ticker}
                    </span>
                    <span className="text-sm text-[var(--color-text)] flex-1">
                      {s.name}
                    </span>
                    {s.exchange && (
                      <span className="text-[10px] text-[var(--color-text-secondary)] opacity-60">
                        {s.exchange}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 選択された銘柄の表示 */}
          {formData.ticker && (
            <div
              className="flex items-center gap-3 px-3 py-2"
              style={{
                background: "rgba(0,240,255,0.06)",
                border: "1px solid rgba(0,240,255,0.2)",
              }}
            >
              <span
                className="text-xs px-1.5 py-0.5"
                style={{
                  background:
                    formData.market === "US"
                      ? "rgba(255,43,214,0.15)"
                      : "rgba(0,240,255,0.15)",
                  color:
                    formData.market === "US"
                      ? "var(--color-accent-2)"
                      : "var(--color-accent)",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: "10px",
                }}
              >
                {formData.market}
              </span>
              <span
                className="text-sm font-bold text-[var(--color-accent)]"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                {formData.ticker}
              </span>
              <span className="text-sm text-[var(--color-text)]">
                {formData.name}
              </span>
              <button
                type="button"
                onClick={() =>
                  setFormData({
                    ...formData,
                    ticker: "",
                    name: "",
                    market: "JP",
                  })
                }
                className="ml-auto text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-up)] transition-colors"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                {">"} CLEAR
              </button>
            </div>
          )}

          {/* 数量 / 取得単価 / 購入日 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label
                className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                数量（株数）
              </label>
              <input
                type="number"
                value={formData.shares}
                onChange={(e) =>
                  setFormData({ ...formData, shares: e.target.value })
                }
                min="1"
                className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
                placeholder="100"
              />
            </div>
            <div>
              <label
                className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                取得単価（円）
              </label>
              <input
                type="number"
                value={formData.avgCost}
                onChange={(e) =>
                  setFormData({ ...formData, avgCost: e.target.value })
                }
                required
                min="0"
                step="0.01"
                className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
                placeholder="3200"
              />
            </div>
            <div>
              <label
                className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                購入日
              </label>
              <input
                type="date"
                value={formData.purchaseDate}
                onChange={(e) =>
                  setFormData({ ...formData, purchaseDate: e.target.value })
                }
                required
                className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  colorScheme: "dark",
                }}
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
              fontFamily: "'JetBrains Mono', monospace",
              boxShadow: "0 0 14px rgba(0,240,255,0.3)",
            }}
          >
            {submitting ? "> ADDING..." : "> CONFIRM"}
          </button>
        </form>
      )}

      {/* 保有銘柄リスト */}
      <div
        style={{
          border: "1px solid var(--color-border)",
          background: "var(--bg-card)",
        }}
      >
        {/* ヘッダー */}
        <div
          className="hidden md:grid grid-cols-7 gap-2 px-4 py-2 border-b border-[var(--color-border)]"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "10px",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "var(--color-text-secondary)",
          }}
        >
          <span>Ticker / Name</span>
          <span className="text-right">数量</span>
          <span className="text-right">取得単価</span>
          <span className="text-right">取得総額</span>
          <span className="text-center">購入日</span>
          <span className="text-center">Market</span>
          <span className="text-right">Action</span>
        </div>

        {holdings.length === 0 && (
          <div className="py-12 text-center text-[var(--color-text-secondary)]">
            <p className="text-sm">保有銘柄がありません</p>
            <p className="text-xs mt-1">
              上のボタンから銘柄を追加してください
            </p>
          </div>
        )}

        {holdings.map((h) => {
          const totalCostH = h.shares * h.avgCost;
          return (
            <div
              key={h.id}
              className="border-b border-[var(--color-border)] last:border-b-0"
            >
              {/* モバイル */}
              <div className="md:hidden p-3 space-y-2">
                <div className="flex justify-between items-start">
                  <div
                    className="cursor-pointer flex-1"
                    onClick={() => router.push(`/stock/${h.ticker}`)}
                  >
                    <span
                      className="text-[10px] text-[var(--color-accent)] tracking-[0.1em]"
                      style={{ fontFamily: "'JetBrains Mono', monospace" }}
                    >
                      {h.ticker}
                    </span>
                    <div className="text-sm font-medium">{h.name}</div>
                  </div>
                  <button
                    onClick={() => h.id && handleDelete(h.id)}
                    disabled={deleting === h.id}
                    className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-up)] min-w-[44px] min-h-[44px] flex items-center justify-center disabled:opacity-50"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    {deleting === h.id ? "..." : "DEL"}
                  </button>
                </div>
                <div
                  className="flex justify-between text-xs text-[var(--color-text-secondary)] cursor-pointer"
                  onClick={() => router.push(`/stock/${h.ticker}`)}
                >
                  <span>
                    {h.shares}株 @ ¥{h.avgCost.toLocaleString()}
                    {h.purchaseDate && (
                      <span className="ml-2 opacity-60">
                        ({h.purchaseDate})
                      </span>
                    )}
                  </span>
                  <span
                    className="text-[var(--color-text)]"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    ¥{totalCostH.toLocaleString()}
                  </span>
                </div>
              </div>

              {/* デスクトップ */}
              <div
                className="hidden md:grid grid-cols-7 gap-2 px-4 py-3 items-center hover:bg-[var(--bg-card-hover)] hover:border-l-2 hover:border-l-[var(--color-accent)] transition-all cursor-pointer"
                onClick={() => router.push(`/stock/${h.ticker}`)}
              >
                <div>
                  <span
                    className="text-[10px] text-[var(--color-accent)] tracking-[0.1em]"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    {h.ticker}
                  </span>
                  <div className="text-sm">{h.name}</div>
                </div>
                <span
                  className="text-sm text-right"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  {h.shares.toLocaleString()}
                </span>
                <span
                  className="text-sm text-right"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  ¥{h.avgCost.toLocaleString()}
                </span>
                <span
                  className="text-sm text-right font-bold"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  ¥{totalCostH.toLocaleString()}
                </span>
                <span
                  className="text-xs text-center text-[var(--color-text-secondary)]"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  {h.purchaseDate || "—"}
                </span>
                <span className="text-xs text-center text-[var(--color-text-secondary)]">
                  {h.market === "US" ? "US" : "JP"}
                </span>
                <div className="text-right">
                  <button
                    onClick={(e) => { e.stopPropagation(); h.id && handleDelete(h.id); }}
                    disabled={deleting === h.id}
                    className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-up)] px-2 py-1 min-h-[44px] disabled:opacity-50 transition-colors"
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      border: "1px solid transparent",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.borderColor = "var(--color-up)")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.borderColor = "transparent")
                    }
                  >
                    {deleting === h.id ? "..." : "> DEL"}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
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

  // Y軸ラベル (3つ)
  const yLabels = [minV, (minV + maxV) / 2, maxV].map((v) => ({
    value: v,
    y: PY + chartH - ((v - minV) / rangeV) * chartH,
  }));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      style={{ maxHeight: 220 }}
    >
      <defs>
        <filter id="chart-glow">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>
      {/* Grid lines */}
      {yLabels.map((l, i) => (
        <g key={i}>
          <line
            x1={PX}
            y1={l.y}
            x2={PX + chartW}
            y2={l.y}
            stroke="var(--color-border)"
            strokeWidth="0.5"
            strokeDasharray="4 4"
          />
          <text
            x={PX - 5}
            y={l.y + 3}
            textAnchor="end"
            fill="var(--color-text-secondary)"
            fontSize="9"
            fontFamily="'JetBrains Mono', monospace"
          >
            {(l.value / 10000).toFixed(0)}万
          </text>
        </g>
      ))}
      {/* X軸ラベル (最初と最後) */}
      <text
        x={PX}
        y={H - 2}
        fill="var(--color-text-secondary)"
        fontSize="9"
        fontFamily="'JetBrains Mono', monospace"
      >
        {snapshots[0].date.slice(5)}
      </text>
      <text
        x={PX + chartW}
        y={H - 2}
        textAnchor="end"
        fill="var(--color-text-secondary)"
        fontSize="9"
        fontFamily="'JetBrains Mono', monospace"
      >
        {snapshots[snapshots.length - 1].date.slice(5)}
      </text>
      {/* Area fill */}
      <polygon points={areaPoints} fill={fillColor} />
      {/* Glow line */}
      <polyline
        points={polyline}
        fill="none"
        stroke={glowColor}
        strokeWidth="4"
        filter="url(#chart-glow)"
      />
      {/* Main line */}
      <polyline
        points={polyline}
        fill="none"
        stroke={lineColor}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* 最新値ドット */}
      {points.length > 0 && (
        <circle
          cx={parseFloat(points[points.length - 1].split(",")[0])}
          cy={parseFloat(points[points.length - 1].split(",")[1])}
          r="4"
          fill={lineColor}
          style={{
            filter: `drop-shadow(0 0 6px ${glowColor})`,
          }}
        />
      )}
    </svg>
  );
}
