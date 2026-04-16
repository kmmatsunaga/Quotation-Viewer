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
      <h1
        className="text-lg font-bold tracking-wide"
        style={{
          fontFamily: "'Orbitron', sans-serif",
          background: "linear-gradient(90deg, #00f0ff 0%, #ff2bd6 100%)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
        }}
      >
        ポートフォリオ
      </h1>

      {/* Summary */}
      <div
        className="relative bg-card p-4 md:p-6 border border-[var(--color-border)]"
        style={{
          clipPath:
            "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)",
          boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
        }}
      >
        {/* Corner ticks */}
        <span className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-accent)] opacity-60" />
        <span className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[var(--color-accent-2)] opacity-60" />

        <span
          className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          評価総額
        </span>
        <div
          className="text-2xl md:text-3xl font-bold mt-1"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            textShadow: "0 0 12px rgba(0,240,255,0.3)",
          }}
        >
          ¥{display.total_value.toLocaleString("ja-JP")}
        </div>
        <div className="flex items-center gap-3 mt-2">
          <span
            className="text-sm font-medium"
            style={{
              color: pnlColor,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {isUp ? "+" : ""}
            ¥{display.total_pnl.toLocaleString("ja-JP")}
          </span>
          <span
            className="text-xs font-medium px-2 py-0.5"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              color: pnlColor,
              backgroundColor: isUp
                ? "rgba(255,59,107,0.10)"
                : "rgba(0,217,255,0.10)",
              border: `1px solid ${isUp ? "rgba(255,59,107,0.5)" : "rgba(0,217,255,0.5)"}`,
              boxShadow: `0 0 8px ${isUp ? "rgba(255,59,107,0.25)" : "rgba(0,217,255,0.25)"}`,
              clipPath:
                "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
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
        className="w-full md:w-auto px-4 py-2.5 text-sm font-medium transition-all duration-200 min-h-[44px]"
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          clipPath:
            "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
          border: showForm
            ? "1px solid rgba(255,43,214,0.6)"
            : "1px solid rgba(0,240,255,0.6)",
          backgroundColor: showForm
            ? "rgba(255,43,214,0.08)"
            : "rgba(0,240,255,0.08)",
          color: showForm ? "#ff2bd6" : "#00f0ff",
          boxShadow: showForm
            ? "0 0 18px rgba(255,43,214,0.35), inset 0 0 0 1px rgba(255,43,214,0.15)"
            : "0 0 18px rgba(0,240,255,0.35), inset 0 0 0 1px rgba(0,240,255,0.15)",
        }}
      >
        {showForm ? "キャンセル" : "+ 銘柄を追加"}
      </button>

      {/* Add form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="relative bg-card p-4 border border-[var(--color-border)] space-y-3"
          style={{
            clipPath:
              "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)",
            boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
          }}
        >
          {/* Corner ticks */}
          <span className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-accent)] opacity-60" />
          <span className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[var(--color-accent-2)] opacity-60" />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label
                className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-1"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                銘柄コード
              </label>
              <input
                type="text"
                value={formData.code}
                onChange={(e) =>
                  setFormData({ ...formData, code: e.target.value })
                }
                required
                className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  clipPath:
                    "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
                  boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
                }}
                placeholder="7203"
              />
            </div>
            <div>
              <label
                className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-1"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                銘柄名
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                required
                className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
                style={{
                  clipPath:
                    "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
                  boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
                }}
                placeholder="トヨタ自動車"
              />
            </div>
            <div>
              <label
                className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-1"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
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
                className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  clipPath:
                    "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
                  boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
                }}
                placeholder="100"
              />
            </div>
            <div>
              <label
                className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-1"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
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
                className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  clipPath:
                    "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
                  boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
                }}
                placeholder="3200"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full md:w-auto px-6 py-2.5 text-sm font-medium transition-all duration-200 disabled:opacity-50 min-h-[44px]"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              clipPath:
                "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
              border: "1px solid rgba(0,240,255,0.6)",
              backgroundColor: "rgba(0,240,255,0.08)",
              color: "#00f0ff",
              boxShadow:
                "0 0 18px rgba(0,240,255,0.35), inset 0 0 0 1px rgba(0,240,255,0.15)",
            }}
          >
            {submitting ? "追加中..." : "追加する"}
          </button>
        </form>
      )}

      {/* Holdings table */}
      <div
        className="relative bg-card border border-[var(--color-border)] overflow-hidden"
        style={{
          clipPath:
            "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)",
          boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
        }}
      >
        {/* Corner ticks */}
        <span className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-accent)] opacity-60 z-10" />
        <span className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[var(--color-accent-2)] opacity-60 z-10" />

        {/* Header - desktop */}
        <div
          className="hidden md:grid grid-cols-6 gap-2 px-4 py-2 text-[var(--color-text-secondary)] border-b border-[var(--color-border)]"
          style={{
            backgroundColor: "rgba(0,240,255,0.03)",
          }}
        >
          <span
            className="text-[10px] uppercase tracking-[0.15em]"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            銘柄
          </span>
          <span
            className="text-[10px] uppercase tracking-[0.15em] text-right"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            数量
          </span>
          <span
            className="text-[10px] uppercase tracking-[0.15em] text-right"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            平均取得価格
          </span>
          <span
            className="text-[10px] uppercase tracking-[0.15em] text-right"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            現在価格
          </span>
          <span
            className="text-[10px] uppercase tracking-[0.15em] text-right"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            損益
          </span>
          <span
            className="text-[10px] uppercase tracking-[0.15em] text-right"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            操作
          </span>
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
                    <span
                      className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]"
                      style={{ fontFamily: "'JetBrains Mono', monospace" }}
                    >
                      {h.code}
                    </span>
                    <div className="text-sm font-medium">{h.name}</div>
                  </div>
                  <button
                    onClick={() => handleDelete(h.id)}
                    className="text-xs min-w-[44px] min-h-[44px] flex items-center justify-center transition-colors duration-200"
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      color: "rgba(255,43,214,0.6)",
                    }}
                  >
                    削除
                  </button>
                </div>
                <div className="flex justify-between text-xs">
                  <span
                    className="text-[var(--color-text-secondary)]"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    {h.quantity}株 @ ¥{h.avg_cost.toLocaleString()}
                  </span>
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      textShadow: "0 0 8px rgba(0,240,255,0.3)",
                    }}
                  >
                    現在: ¥{h.current_price.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-end">
                  <span
                    className="text-sm font-medium px-2 py-0.5"
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      color: hColor,
                      backgroundColor: hUp
                        ? "rgba(255,59,107,0.10)"
                        : "rgba(0,217,255,0.10)",
                      border: `1px solid ${hUp ? "rgba(255,59,107,0.5)" : "rgba(0,217,255,0.5)"}`,
                      boxShadow: `0 0 8px ${hUp ? "rgba(255,59,107,0.25)" : "rgba(0,217,255,0.25)"}`,
                      clipPath:
                        "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
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
                  <span
                    className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    {h.code}
                  </span>
                  <div className="text-sm">{h.name}</div>
                </div>
                <span
                  className="text-sm text-right"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  {h.quantity.toLocaleString()}
                </span>
                <span
                  className="text-sm text-right"
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    textShadow: "0 0 6px rgba(0,240,255,0.2)",
                  }}
                >
                  ¥{h.avg_cost.toLocaleString()}
                </span>
                <span
                  className="text-sm text-right"
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    textShadow: "0 0 8px rgba(0,240,255,0.3)",
                  }}
                >
                  ¥{h.current_price.toLocaleString()}
                </span>
                <div className="text-right">
                  <span
                    className="text-sm font-medium"
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      color: hColor,
                    }}
                  >
                    {hUp ? "+" : ""}
                    ¥{h.pnl.toLocaleString()}
                  </span>
                  <div>
                    <span
                      className="text-xs inline-block mt-0.5 px-1.5 py-0.5"
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        color: hColor,
                        backgroundColor: hUp
                          ? "rgba(255,59,107,0.10)"
                          : "rgba(0,217,255,0.10)",
                        border: `1px solid ${hUp ? "rgba(255,59,107,0.5)" : "rgba(0,217,255,0.5)"}`,
                        boxShadow: `0 0 8px ${hUp ? "rgba(255,59,107,0.25)" : "rgba(0,217,255,0.25)"}`,
                        clipPath:
                          "polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px)",
                      }}
                    >
                      {hUp ? "+" : ""}
                      {h.pnl_pct.toFixed(2)}%
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <button
                    onClick={() => handleDelete(h.id)}
                    className="text-xs px-2 py-1 min-h-[44px] transition-colors duration-200"
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      color: "rgba(255,43,214,0.6)",
                    }}
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
