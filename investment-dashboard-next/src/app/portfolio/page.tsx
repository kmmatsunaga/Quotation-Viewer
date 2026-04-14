"use client";

import { useState } from "react";
import useSWR from "swr";
import {
  fetcher,
  fetchHoldingsUrl,
  addHolding,
  deleteHolding,
  type PortfolioSummary,
  type Holding,
} from "@/lib/api";

export default function PortfolioPage() {
  const { data, mutate } = useSWR<PortfolioSummary>(
    fetchHoldingsUrl(),
    fetcher,
    { refreshInterval: 30000 }
  );

  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    code: "",
    name: "",
    quantity: "",
    avg_cost: "",
  });
  const [submitting, setSubmitting] = useState(false);

  const demoData: PortfolioSummary = {
    total_value: 5234567,
    total_pnl: 234567,
    total_pnl_pct: 4.69,
    holdings: [
      { id: 1, code: "7203", name: "トヨタ自動車", quantity: 100, avg_cost: 3200, current_price: 3450, pnl: 25000, pnl_pct: 7.81 },
      { id: 2, code: "6758", name: "ソニーG", quantity: 50, avg_cost: 12800, current_price: 13200, pnl: 20000, pnl_pct: 3.13 },
      { id: 3, code: "AAPL", name: "Apple", quantity: 20, avg_cost: 175.0, current_price: 189.45, pnl: 289, pnl_pct: 8.26 },
      { id: 4, code: "9984", name: "ソフトバンクG", quantity: 200, avg_cost: 9200, current_price: 8920, pnl: -56000, pnl_pct: -3.04 },
    ],
  };

  const display = data ?? demoData;
  const isUp = display.total_pnl >= 0;
  const pnlColor = isUp ? "var(--color-up)" : "var(--color-down)";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await addHolding({
        code: formData.code,
        name: formData.name,
        quantity: Number(formData.quantity),
        avg_cost: Number(formData.avg_cost),
      });
      setFormData({ code: "", name: "", quantity: "", avg_cost: "" });
      setShowForm(false);
      mutate();
    } catch (err) {
      console.error("Failed to add holding:", err);
    }
    setSubmitting(false);
  };

  const handleDelete = async (id: number) => {
    if (!confirm("この保有銘柄を削除しますか？")) return;
    try {
      await deleteHolding(id);
      mutate();
    } catch (err) {
      console.error("Failed to delete:", err);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-bold">ポートフォリオ</h1>

      {/* Summary */}
      <div className="bg-card rounded-xl p-4 md:p-6 border border-[var(--color-border)]">
        <span className="text-xs text-[var(--color-text-secondary)]">
          評価総額
        </span>
        <div className="text-2xl md:text-3xl font-bold mt-1">
          ¥{display.total_value.toLocaleString("ja-JP")}
        </div>
        <div className="flex items-center gap-3 mt-2">
          <span className="text-sm font-medium" style={{ color: pnlColor }}>
            {isUp ? "+" : ""}
            ¥{display.total_pnl.toLocaleString("ja-JP")}
          </span>
          <span
            className="text-xs font-medium px-2 py-0.5 rounded"
            style={{
              color: pnlColor,
              backgroundColor: isUp
                ? "rgba(255,82,82,0.15)"
                : "rgba(68,138,255,0.15)",
            }}
          >
            {isUp ? "+" : ""}
            {display.total_pnl_pct.toFixed(2)}%
          </span>
        </div>
      </div>

      {/* Add button */}
      <button
        onClick={() => setShowForm(!showForm)}
        className="w-full md:w-auto px-4 py-2.5 bg-[var(--color-accent)] text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity min-h-[44px]"
      >
        {showForm ? "キャンセル" : "+ 銘柄を追加"}
      </button>

      {/* Add form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="bg-card rounded-xl p-4 border border-[var(--color-border)] space-y-3"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-[var(--color-text-secondary)] block mb-1">
                銘柄コード
              </label>
              <input
                type="text"
                value={formData.code}
                onChange={(e) =>
                  setFormData({ ...formData, code: e.target.value })
                }
                required
                className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
                placeholder="7203"
              />
            </div>
            <div>
              <label className="text-xs text-[var(--color-text-secondary)] block mb-1">
                銘柄名
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                required
                className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
                placeholder="トヨタ自動車"
              />
            </div>
            <div>
              <label className="text-xs text-[var(--color-text-secondary)] block mb-1">
                数量
              </label>
              <input
                type="number"
                value={formData.quantity}
                onChange={(e) =>
                  setFormData({ ...formData, quantity: e.target.value })
                }
                required
                min="1"
                className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
                placeholder="100"
              />
            </div>
            <div>
              <label className="text-xs text-[var(--color-text-secondary)] block mb-1">
                平均取得価格
              </label>
              <input
                type="number"
                value={formData.avg_cost}
                onChange={(e) =>
                  setFormData({ ...formData, avg_cost: e.target.value })
                }
                required
                min="0"
                step="0.01"
                className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
                placeholder="3200"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full md:w-auto px-6 py-2.5 bg-[var(--color-accent)] text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 min-h-[44px]"
          >
            {submitting ? "追加中..." : "追加する"}
          </button>
        </form>
      )}

      {/* Holdings table */}
      <div className="bg-card rounded-xl border border-[var(--color-border)] overflow-hidden">
        {/* Header - desktop */}
        <div className="hidden md:grid grid-cols-6 gap-2 px-4 py-2 text-xs font-medium text-[var(--color-text-secondary)] border-b border-[var(--color-border)]">
          <span>銘柄</span>
          <span className="text-right">数量</span>
          <span className="text-right">平均取得価格</span>
          <span className="text-right">現在価格</span>
          <span className="text-right">損益</span>
          <span className="text-right">操作</span>
        </div>

        {display.holdings.map((h) => {
          const hUp = h.pnl >= 0;
          const hColor = hUp ? "var(--color-up)" : "var(--color-down)";

          return (
            <div
              key={h.id}
              className="border-b border-[var(--color-border)] last:border-b-0"
            >
              {/* Mobile layout */}
              <div className="md:hidden p-3 space-y-2">
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-xs text-[var(--color-text-secondary)] font-mono">
                      {h.code}
                    </span>
                    <div className="text-sm font-medium">{h.name}</div>
                  </div>
                  <button
                    onClick={() => handleDelete(h.id)}
                    className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-up)] min-w-[44px] min-h-[44px] flex items-center justify-center"
                  >
                    削除
                  </button>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-[var(--color-text-secondary)]">
                    {h.quantity}株 @ ¥{h.avg_cost.toLocaleString()}
                  </span>
                  <span>現在: ¥{h.current_price.toLocaleString()}</span>
                </div>
                <div className="flex justify-end">
                  <span
                    className="text-sm font-medium px-2 py-0.5 rounded"
                    style={{
                      color: hColor,
                      backgroundColor: hUp
                        ? "rgba(255,82,82,0.15)"
                        : "rgba(68,138,255,0.15)",
                    }}
                  >
                    {hUp ? "+" : ""}
                    ¥{h.pnl.toLocaleString()} ({hUp ? "+" : ""}
                    {h.pnl_pct.toFixed(2)}%)
                  </span>
                </div>
              </div>

              {/* Desktop layout */}
              <div className="hidden md:grid grid-cols-6 gap-2 px-4 py-3 items-center hover:bg-[var(--bg-card-hover)] transition-colors">
                <div>
                  <span className="text-xs text-[var(--color-text-secondary)] font-mono">
                    {h.code}
                  </span>
                  <div className="text-sm">{h.name}</div>
                </div>
                <span className="text-sm text-right">
                  {h.quantity.toLocaleString()}
                </span>
                <span className="text-sm text-right">
                  ¥{h.avg_cost.toLocaleString()}
                </span>
                <span className="text-sm text-right">
                  ¥{h.current_price.toLocaleString()}
                </span>
                <div className="text-right">
                  <span className="text-sm font-medium" style={{ color: hColor }}>
                    {hUp ? "+" : ""}
                    ¥{h.pnl.toLocaleString()}
                  </span>
                  <div className="text-xs" style={{ color: hColor }}>
                    {hUp ? "+" : ""}
                    {h.pnl_pct.toFixed(2)}%
                  </div>
                </div>
                <div className="text-right">
                  <button
                    onClick={() => handleDelete(h.id)}
                    className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-up)] px-2 py-1 rounded min-h-[44px]"
                  >
                    削除
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
