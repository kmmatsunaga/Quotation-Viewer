"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import {
  getScenarios,
  deleteScenario,
  closeScenario,
  type InvestmentScenario,
  type ScenarioStatus,
  SCENARIO_REFLECTION_TAGS,
} from "@/lib/firestore";
import ScenarioEditorModal from "./ScenarioEditorModal";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

const STATUS_LABELS: Record<ScenarioStatus, { label: string; color: string }> = {
  active: { label: "監視中", color: "#00f0ff" },
  achieved: { label: "目標達成", color: "#22c55e" },
  stopped: { label: "損切り", color: "#ef4444" },
  expired: { label: "期間超過", color: "#9ca3af" },
  manually_closed: { label: "手動終了", color: "#a78bfa" },
};

const PERIOD_LABELS = {
  "1w": "1週間",
  "1m": "1か月",
  "3m": "3か月",
  "6m": "6か月",
  "1y": "1年",
  "long": "長期",
};

export default function ScenariosPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [scenarios, setScenarios] = useState<InvestmentScenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | ScenarioStatus>("active");
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [editingScenario, setEditingScenario] = useState<InvestmentScenario | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [closingScenario, setClosingScenario] = useState<InvestmentScenario | null>(null);

  const loadScenarios = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const list = await getScenarios(user.uid);
      setScenarios(list);

      // Active シナリオの現在株価を取得
      const tickers = [...new Set(list.filter((s) => s.status === "active").map((s) => s.ticker))];
      if (tickers.length > 0) {
        const res = await fetch(`/api/stocks/prices?tickers=${tickers.join(",")}`);
        const data = await res.json();
        const priceMap: Record<string, number> = {};
        for (const [t, p] of Object.entries(data.prices ?? {})) {
          priceMap[t] = (p as { price: number }).price;
        }
        setPrices(priceMap);
      }
    } catch (err) {
      console.error("Failed to load scenarios:", err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadScenarios();
  }, [loadScenarios]);

  const filtered = filter === "all" ? scenarios : scenarios.filter((s) => s.status === filter);

  const handleDelete = async (id: string) => {
    if (!user) return;
    if (!confirm("このシナリオを削除しますか？")) return;
    try {
      await deleteScenario(user.uid, id);
      setScenarios((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      console.error("Failed to delete scenario:", err);
    }
  };

  const handleEdit = (s: InvestmentScenario) => {
    setEditingScenario(s);
    setShowEditor(true);
  };

  const handleNewScenario = () => {
    setEditingScenario(null);
    setShowEditor(true);
  };

  const handleCloseEditor = () => {
    setShowEditor(false);
    setEditingScenario(null);
    loadScenarios();
  };

  if (loading) {
    return (
      <div className="text-center py-12 text-[var(--color-text-secondary)]" style={MONO}>
        読み込み中...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ヘッダー */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">
            📋 投資シナリオ
          </h1>
          <p className="text-xs text-[var(--color-text-secondary)] mt-1" style={MONO}>
            買う前にシナリオを書く → 後で振り返る → 判断の質を向上させる
          </p>
        </div>
        <button
          onClick={handleNewScenario}
          className="px-4 py-2 text-sm font-medium min-h-[44px]"
          style={{
            border: "1px solid var(--color-accent)",
            color: "var(--color-accent)",
            background: "rgba(0,240,255,0.05)",
            ...MONO,
          }}
        >
          + 新規シナリオ
        </button>
      </div>

      {/* フィルタタブ */}
      <div className="flex gap-2 flex-wrap border-b border-[var(--color-border)] pb-1">
        {(["active", "achieved", "stopped", "expired", "manually_closed", "all"] as const).map((s) => {
          const count =
            s === "all" ? scenarios.length : scenarios.filter((x) => x.status === s).length;
          const isActive = filter === s;
          const label = s === "all" ? "すべて" : STATUS_LABELS[s].label;
          return (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className="px-3 py-1.5 text-xs transition-all"
              style={{
                color: isActive
                  ? s === "all"
                    ? "var(--color-accent)"
                    : STATUS_LABELS[s as ScenarioStatus].color
                  : "var(--color-text-secondary)",
                borderBottom: isActive
                  ? `2px solid ${s === "all" ? "var(--color-accent)" : STATUS_LABELS[s as ScenarioStatus].color}`
                  : "2px solid transparent",
                fontWeight: isActive ? 600 : 400,
                ...MONO,
              }}
            >
              {label} ({count})
            </button>
          );
        })}
      </div>

      {/* シナリオ一覧 */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-[var(--color-text-secondary)] text-sm" style={MONO}>
          {filter === "active"
            ? "監視中のシナリオがありません。「+ 新規シナリオ」から作成しましょう。"
            : "このステータスのシナリオはありません。"}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filtered.map((s) => {
            const sCfg = STATUS_LABELS[s.status];
            const currentPrice = prices[s.ticker];
            const isBuy = s.direction === "buy";
            const isActive = s.status === "active";

            // 進捗計算
            let progress = 0;
            let priceToTarget = null;
            let priceToStop = null;
            if (currentPrice && isActive) {
              const minTarget = Math.min(...s.targetPrices);
              const targetDist = isBuy
                ? (currentPrice - s.entryPrice) / (minTarget - s.entryPrice)
                : (s.entryPrice - currentPrice) / (s.entryPrice - minTarget);
              progress = Math.max(-1, Math.min(2, targetDist));
              priceToTarget = isBuy
                ? minTarget - currentPrice
                : currentPrice - minTarget;
              priceToStop = isBuy
                ? currentPrice - s.stopLossPrice
                : s.stopLossPrice - currentPrice;
            }

            return (
              <div
                key={s.id}
                className="p-4 rounded space-y-3"
                style={{
                  border: `1px solid ${isActive ? "var(--color-border)" : "rgba(255,255,255,0.1)"}`,
                  background: "var(--bg-card)",
                  opacity: isActive ? 1 : 0.75,
                }}
              >
                {/* ヘッダー: 銘柄 + ステータス */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <button
                      onClick={() => router.push(`/stock/${s.ticker}`)}
                      className="flex items-center gap-2 hover:opacity-80"
                    >
                      <span
                        className="text-[9px] px-1.5 py-0.5"
                        style={{
                          background: "rgba(0,240,255,0.15)",
                          color: "var(--color-accent)",
                          ...MONO,
                        }}
                      >
                        {s.market}
                      </span>
                      <span className="text-sm text-[var(--color-accent)] font-bold" style={MONO}>
                        {s.ticker}
                      </span>
                      <span className="text-sm text-[var(--color-text)] truncate">
                        {s.name}
                      </span>
                    </button>
                    <div className="flex items-center gap-2 mt-1">
                      <span
                        className="text-[10px] px-1.5 py-0.5"
                        style={{
                          background: isBuy ? "rgba(34,197,94,0.15)" : s.direction === "sell" ? "rgba(239,68,68,0.15)" : "rgba(156,163,175,0.15)",
                          color: isBuy ? "#22c55e" : s.direction === "sell" ? "#ef4444" : "#9ca3af",
                          ...MONO,
                        }}
                      >
                        {s.direction === "buy" ? "▲ 買い" : s.direction === "sell" ? "▼ 売り" : "◆ 様子見"}
                      </span>
                      <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
                        {PERIOD_LABELS[s.holdingPeriod]}
                      </span>
                      <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
                        確信度 {"★".repeat(s.confidence)}{"☆".repeat(5 - s.confidence)}
                      </span>
                    </div>
                  </div>
                  <span
                    className="text-[10px] px-2 py-1 rounded"
                    style={{
                      background: `${sCfg.color}20`,
                      color: sCfg.color,
                      border: `1px solid ${sCfg.color}`,
                      ...MONO,
                    }}
                  >
                    {sCfg.label}
                  </span>
                </div>

                {/* 価格ステータス */}
                <div className="grid grid-cols-3 gap-2 text-xs" style={MONO}>
                  <div>
                    <div className="text-[9px] text-[var(--color-text-secondary)]">エントリー</div>
                    <div>¥{s.entryPrice.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-[9px] text-[var(--color-text-secondary)]">目標</div>
                    <div className="text-[#22c55e]">
                      ¥{Math.min(...s.targetPrices).toLocaleString()}
                      {s.targetPrices.length > 1 && (
                        <span className="text-[9px] text-[var(--color-text-secondary)] ml-1">
                          (+{s.targetPrices.length - 1})
                        </span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] text-[var(--color-text-secondary)]">損切り</div>
                    <div className="text-[#ef4444]">¥{s.stopLossPrice.toLocaleString()}</div>
                  </div>
                </div>

                {/* 現在価格と進捗バー（アクティブのみ） */}
                {isActive && currentPrice && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs" style={MONO}>
                      <span className="text-[var(--color-text-secondary)]">現在</span>
                      <span className="font-medium">¥{currentPrice.toLocaleString()}</span>
                      <span
                        className="text-[10px]"
                        style={{
                          color:
                            priceToTarget !== null && priceToTarget < 0
                              ? "#22c55e"
                              : priceToStop !== null && priceToStop < 0
                              ? "#ef4444"
                              : "var(--color-text-secondary)",
                        }}
                      >
                        {priceToTarget !== null && priceToTarget < 0
                          ? "🎯 目標達成!"
                          : priceToStop !== null && priceToStop < 0
                          ? "⚠ 損切り!"
                          : priceToTarget !== null
                          ? `目標まで ¥${Math.abs(priceToTarget).toLocaleString()}`
                          : ""}
                      </span>
                    </div>
                    {/* シンプル進捗バー */}
                    <div
                      className="h-1.5 rounded-full overflow-hidden relative"
                      style={{ background: "rgba(255,255,255,0.08)" }}
                    >
                      <div
                        className="h-full transition-all"
                        style={{
                          width: `${Math.max(0, Math.min(100, progress * 100))}%`,
                          background:
                            progress >= 1 ? "#22c55e" : progress < 0 ? "#ef4444" : "var(--color-accent)",
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* 根拠タグ */}
                {s.rationaleTags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {s.rationaleTags.map((tag) => (
                      <span
                        key={tag}
                        className="text-[9px] px-1.5 py-0.5"
                        style={{
                          background: "rgba(255,255,255,0.06)",
                          color: "var(--color-text-secondary)",
                          ...MONO,
                        }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                {/* 根拠 (短縮表示) */}
                {s.rationale && (
                  <p className="text-xs text-[var(--color-text)] opacity-80 line-clamp-2">
                    {s.rationale}
                  </p>
                )}

                {/* 終了済みの場合: 振り返り表示 */}
                {!isActive && s.closePrice !== undefined && s.closePrice !== null && (
                  <div className="pt-2 border-t border-[var(--color-border)] space-y-2">
                    <div className="flex items-center justify-between text-xs" style={MONO}>
                      <span className="text-[var(--color-text-secondary)]">終値</span>
                      <span>¥{s.closePrice.toLocaleString()}</span>
                      <span
                        style={{
                          color:
                            (isBuy ? s.closePrice - s.entryPrice : s.entryPrice - s.closePrice) > 0
                              ? "#22c55e"
                              : "#ef4444",
                        }}
                      >
                        {isBuy
                          ? `${s.closePrice >= s.entryPrice ? "+" : ""}${(((s.closePrice - s.entryPrice) / s.entryPrice) * 100).toFixed(2)}%`
                          : `${s.entryPrice >= s.closePrice ? "+" : ""}${(((s.entryPrice - s.closePrice) / s.entryPrice) * 100).toFixed(2)}%`}
                      </span>
                    </div>
                    {s.reflectionTags && s.reflectionTags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {s.reflectionTags.map((t) => (
                          <span
                            key={t}
                            className="text-[9px] px-1.5 py-0.5"
                            style={{
                              background: "rgba(167,139,250,0.15)",
                              color: "#a78bfa",
                              ...MONO,
                            }}
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                    {s.reflectionNote && (
                      <p className="text-xs text-[var(--color-text-secondary)] italic">
                        “{s.reflectionNote}”
                      </p>
                    )}
                  </div>
                )}

                {/* アクション */}
                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => handleEdit(s)}
                    className="flex-1 text-[10px] py-1.5"
                    style={{
                      border: "1px solid var(--color-border)",
                      color: "var(--color-text-secondary)",
                      ...MONO,
                    }}
                  >
                    編集
                  </button>
                  {isActive && (
                    <button
                      onClick={() => setClosingScenario(s)}
                      className="flex-1 text-[10px] py-1.5"
                      style={{
                        border: "1px solid var(--color-accent-magenta)",
                        color: "var(--color-accent-magenta)",
                        ...MONO,
                      }}
                    >
                      終了する
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(s.id!)}
                    className="text-[10px] py-1.5 px-2"
                    style={{
                      border: "1px solid rgba(239,68,68,0.5)",
                      color: "#ef4444",
                      ...MONO,
                    }}
                  >
                    削除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* シナリオ作成・編集モーダル */}
      {showEditor && (
        <ScenarioEditorModal
          scenario={editingScenario}
          onClose={handleCloseEditor}
        />
      )}

      {/* シナリオ終了モーダル */}
      {closingScenario && (
        <CloseScenarioModal
          scenario={closingScenario}
          currentPrice={prices[closingScenario.ticker]}
          onClose={() => {
            setClosingScenario(null);
            loadScenarios();
          }}
        />
      )}
    </div>
  );
}

// ========================================
// シナリオ終了モーダル
// ========================================
function CloseScenarioModal({
  scenario,
  currentPrice,
  onClose,
}: {
  scenario: InvestmentScenario;
  currentPrice?: number;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const [status, setStatus] = useState<Exclude<ScenarioStatus, "active">>("manually_closed");
  const [closePrice, setClosePrice] = useState(currentPrice ?? scenario.entryPrice);
  const [reflectionTags, setReflectionTags] = useState<string[]>([]);
  const [reflectionNote, setReflectionNote] = useState("");
  const [saving, setSaving] = useState(false);

  const toggleTag = (tag: string) => {
    setReflectionTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const handleSubmit = async () => {
    if (!user || !scenario.id) return;
    setSaving(true);
    try {
      await closeScenario(user.uid, scenario.id, {
        status,
        closePrice,
        reflectionTags,
        reflectionNote,
      });
      onClose();
    } catch (err) {
      console.error("Failed to close scenario:", err);
    } finally {
      setSaving(false);
    }
  };

  const isBuy = scenario.direction === "buy";
  const pnlPct = isBuy
    ? ((closePrice - scenario.entryPrice) / scenario.entryPrice) * 100
    : ((scenario.entryPrice - closePrice) / scenario.entryPrice) * 100;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md p-5 rounded space-y-4 max-h-[90vh] overflow-y-auto"
        style={{ background: "var(--bg-card)", border: "1px solid var(--color-accent)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-bold text-[var(--color-accent)]" style={MONO}>
          シナリオを終了
        </h2>
        <div className="text-xs text-[var(--color-text-secondary)]" style={MONO}>
          {scenario.ticker} {scenario.name}
        </div>

        {/* ステータス選択 */}
        <div>
          <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-2" style={MONO}>
            終了タイプ
          </label>
          <div className="grid grid-cols-2 gap-2">
            {(["achieved", "stopped", "expired", "manually_closed"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className="text-xs py-2 px-2"
                style={{
                  border: `1px solid ${status === s ? STATUS_LABELS[s].color : "var(--color-border)"}`,
                  color: status === s ? STATUS_LABELS[s].color : "var(--color-text-secondary)",
                  background: status === s ? `${STATUS_LABELS[s].color}10` : "transparent",
                  ...MONO,
                }}
              >
                {STATUS_LABELS[s].label}
              </button>
            ))}
          </div>
        </div>

        {/* 終値 */}
        <div>
          <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
            終値
          </label>
          <input
            type="number"
            value={closePrice}
            onChange={(e) => setClosePrice(Number(e.target.value))}
            className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)]"
            style={MONO}
          />
          <div className="text-[10px] mt-1" style={MONO}>
            想定損益:{" "}
            <span style={{ color: pnlPct >= 0 ? "#22c55e" : "#ef4444" }}>
              {pnlPct >= 0 ? "+" : ""}
              {pnlPct.toFixed(2)}%
            </span>
          </div>
        </div>

        {/* 振り返りタグ */}
        <div>
          <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-2" style={MONO}>
            振り返り (複数選択可)
          </label>
          <div className="flex flex-wrap gap-1.5">
            {SCENARIO_REFLECTION_TAGS.map((tag) => (
              <button
                key={tag}
                onClick={() => toggleTag(tag)}
                className="text-[10px] px-2 py-1"
                style={{
                  border: `1px solid ${reflectionTags.includes(tag) ? "#a78bfa" : "var(--color-border)"}`,
                  color: reflectionTags.includes(tag) ? "#a78bfa" : "var(--color-text-secondary)",
                  background: reflectionTags.includes(tag) ? "rgba(167,139,250,0.1)" : "transparent",
                  ...MONO,
                }}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        {/* メモ */}
        <div>
          <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
            振り返りメモ (任意)
          </label>
          <textarea
            value={reflectionNote}
            onChange={(e) => setReflectionNote(e.target.value)}
            rows={3}
            className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] resize-none"
            placeholder="今回の学び、次回への教訓..."
            style={MONO}
          />
        </div>

        <div className="flex gap-2 pt-2">
          <button
            onClick={onClose}
            className="flex-1 text-sm py-2"
            style={{
              border: "1px solid var(--color-border)",
              color: "var(--color-text-secondary)",
              ...MONO,
            }}
          >
            キャンセル
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="flex-1 text-sm py-2 font-medium"
            style={{
              border: "1px solid var(--color-accent)",
              color: "var(--color-accent)",
              background: "rgba(0,240,255,0.1)",
              ...MONO,
            }}
          >
            {saving ? "保存中..." : "終了"}
          </button>
        </div>
      </div>
    </div>
  );
}
