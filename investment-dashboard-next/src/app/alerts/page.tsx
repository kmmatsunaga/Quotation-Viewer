"use client";

import { useState } from "react";
import useSWR from "swr";
import {
  fetcher,
  fetchAlertsUrl,
  addAlert,
  deleteAlert,
  checkAlerts,
  type PriceAlert,
} from "@/lib/api";

export default function AlertsPage() {
  const { data: alerts, mutate } = useSWR<PriceAlert[]>(
    fetchAlertsUrl(),
    fetcher,
    { refreshInterval: 60000 }
  );

  const [showForm, setShowForm] = useState(false);
  const [checking, setChecking] = useState(false);
  const [formData, setFormData] = useState({
    code: "",
    name: "",
    target_price: "",
    direction: "above" as "above" | "below",
  });
  const [submitting, setSubmitting] = useState(false);

  const demoAlerts: PriceAlert[] = [
    { id: 1, code: "7203", name: "トヨタ自動車", target_price: 3500, direction: "above", current_price: 3450, triggered: false, created_at: "2026-04-10T09:00:00Z" },
    { id: 2, code: "6758", name: "ソニーG", target_price: 13000, direction: "below", current_price: 13200, triggered: false, created_at: "2026-04-11T10:00:00Z" },
    { id: 3, code: "NVDA", name: "NVIDIA", target_price: 850, direction: "below", current_price: 876.30, triggered: false, created_at: "2026-04-12T08:00:00Z" },
    { id: 4, code: "9984", name: "ソフトバンクG", target_price: 9000, direction: "above", current_price: 8920, triggered: false, created_at: "2026-04-09T11:00:00Z" },
  ];

  const displayAlerts = alerts ?? demoAlerts;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await addAlert({
        code: formData.code,
        name: formData.name,
        target_price: Number(formData.target_price),
        direction: formData.direction,
      });
      setFormData({ code: "", name: "", target_price: "", direction: "above" });
      setShowForm(false);
      mutate();
    } catch (err) {
      console.error("Failed to add alert:", err);
    }
    setSubmitting(false);
  };

  const handleDelete = async (id: number) => {
    if (!confirm("このアラートを削除しますか？")) return;
    try {
      await deleteAlert(id);
      mutate();
    } catch (err) {
      console.error("Failed to delete:", err);
    }
  };

  const handleCheck = async () => {
    setChecking(true);
    try {
      await checkAlerts();
      mutate();
    } catch (err) {
      console.error("Failed to check alerts:", err);
    }
    setChecking(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1
          className="text-lg font-bold"
          style={{
            fontFamily: "'Orbitron', sans-serif",
            background: "linear-gradient(90deg, #00f0ff 0%, #ff2bd6 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          価格アラート
        </h1>
        <div className="flex items-center gap-3">
          <button
            onClick={handleCheck}
            disabled={checking}
            className="px-4 py-2 text-sm font-medium transition-all min-h-[44px] disabled:opacity-50 uppercase tracking-wider"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              clipPath: "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
              border: "1px solid var(--color-accent-2)",
              boxShadow: "0 0 18px rgba(255,43,214,0.35), inset 0 0 12px rgba(255,43,214,0.08)",
              background: "transparent",
              color: "var(--color-accent-2)",
            }}
          >
            {checking ? "確認中..." : "手動チェック"}
          </button>
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-4 py-2.5 text-sm font-medium transition-all min-h-[44px] uppercase tracking-wider"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              clipPath: "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
              border: "1px solid var(--color-accent)",
              boxShadow: "0 0 18px rgba(0,240,255,0.35), inset 0 0 12px rgba(0,240,255,0.08)",
              background: "transparent",
              color: "var(--color-accent)",
            }}
          >
            {showForm ? "キャンセル" : "+ アラート追加"}
          </button>
        </div>
      </div>

      {/* Add form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="relative bg-card p-4 border border-[var(--color-border)] space-y-3"
          style={{
            clipPath: "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)",
            boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)",
          }}
        >
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
                  clipPath: "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
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
                  fontFamily: "'JetBrains Mono', monospace",
                  clipPath: "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
                }}
                placeholder="トヨタ自動車"
              />
            </div>
            <div>
              <label
                className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-1"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                目標価格
              </label>
              <input
                type="number"
                value={formData.target_price}
                onChange={(e) =>
                  setFormData({ ...formData, target_price: e.target.value })
                }
                required
                min="0"
                step="0.01"
                className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  clipPath: "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
                }}
                placeholder="3500"
              />
            </div>
            <div>
              <label
                className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-1"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                条件
              </label>
              <select
                value={formData.direction}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    direction: e.target.value as "above" | "below",
                  })
                }
                className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  clipPath: "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
                }}
              >
                <option value="above">以上になったら</option>
                <option value="below">以下になったら</option>
              </select>
            </div>
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full md:w-auto px-6 py-2.5 text-sm font-medium transition-all disabled:opacity-50 min-h-[44px] uppercase tracking-wider"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              clipPath: "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
              border: "1px solid var(--color-accent)",
              boxShadow: "0 0 18px rgba(0,240,255,0.35), inset 0 0 12px rgba(0,240,255,0.08)",
              background: "transparent",
              color: "var(--color-accent)",
            }}
          >
            {submitting ? "追加中..." : "追加する"}
          </button>
        </form>
      )}

      {/* Alerts list */}
      <div className="space-y-2">
        {displayAlerts.map((alert) => {
          const isTriggered = alert.triggered;
          const dirLabel =
            alert.direction === "above" ? "以上" : "以下";

          return (
            <div
              key={alert.id}
              className="relative bg-card p-4 border transition-all duration-200"
              style={{
                clipPath: "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)",
                borderColor: isTriggered ? "var(--color-accent)" : "var(--color-border)",
                boxShadow: isTriggered
                  ? "0 0 18px rgba(0,240,255,0.35), inset 0 0 0 1px rgba(0,240,255,0.15)"
                  : "inset 0 0 0 1px rgba(0,240,255,0.04)",
              }}
            >
              <span className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-accent)] opacity-60" />
              <span className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[var(--color-accent-2)] opacity-60" />
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="text-xs text-[var(--color-accent)]"
                      style={{ fontFamily: "'JetBrains Mono', monospace" }}
                    >
                      {alert.code}
                    </span>
                    <span className="text-sm font-medium">{alert.name}</span>
                    {isTriggered && (
                      <span
                        className="text-[10px] uppercase tracking-[0.15em] px-2 py-0.5 font-medium"
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          border: "1px solid var(--color-accent)",
                          color: "var(--color-accent)",
                          boxShadow: "0 0 12px rgba(0,240,255,0.3), inset 0 0 8px rgba(0,240,255,0.1)",
                          clipPath: "polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px)",
                        }}
                      >
                        発動済み
                      </span>
                    )}
                    {!isTriggered && (
                      <span
                        className="text-[10px] uppercase tracking-[0.15em] px-2 py-0.5 font-medium"
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          border: "1px solid var(--color-success)",
                          color: "var(--color-success)",
                          boxShadow: "0 0 12px rgba(0,255,136,0.3), inset 0 0 8px rgba(0,255,136,0.1)",
                          clipPath: "polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px)",
                        }}
                      >
                        監視中
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex items-center gap-4 text-sm">
                    <span
                      className="text-[var(--color-text-secondary)]"
                      style={{ fontFamily: "'JetBrains Mono', monospace" }}
                    >
                      目標: ¥{alert.target_price.toLocaleString()} {dirLabel}
                    </span>
                    <span
                      className="text-[var(--color-text-secondary)]"
                      style={{ fontFamily: "'JetBrains Mono', monospace" }}
                    >
                      現在: ¥{alert.current_price.toLocaleString()}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(alert.id)}
                  className="text-xs min-w-[44px] min-h-[44px] flex items-center justify-center uppercase tracking-wider transition-colors"
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    color: "var(--color-text-secondary)",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--color-accent-2)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--color-text-secondary)")}
                >
                  削除
                </button>
              </div>
            </div>
          );
        })}

        {displayAlerts.length === 0 && (
          <div className="text-center py-12 text-[var(--color-text-secondary)]">
            <p className="text-sm">アラートがありません</p>
            <p className="text-xs mt-1">上のボタンからアラートを追加してください</p>
          </div>
        )}
      </div>
    </div>
  );
}
