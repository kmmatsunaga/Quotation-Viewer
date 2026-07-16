"use client";

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  addScenario,
  updateScenario,
  SCENARIO_RATIONALE_TAGS,
  type InvestmentScenario,
  type ScenarioDirection,
  type ScenarioHoldingPeriod,
} from "@/lib/firestore";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface SearchResult {
  ticker: string;
  name: string;
  market: string;
}

export default function ScenarioEditorModal({
  scenario,
  onClose,
  presetTicker,
  presetName,
  presetMarket,
}: {
  scenario: InvestmentScenario | null;
  onClose: () => void;
  presetTicker?: string;
  presetName?: string;
  presetMarket?: string;
}) {
  const { user } = useAuth();
  const isEdit = !!scenario;

  // 銘柄
  const [ticker, setTicker] = useState(scenario?.ticker ?? presetTicker ?? "");
  const [name, setName] = useState(scenario?.name ?? presetName ?? "");
  const [market, setMarket] = useState(scenario?.market ?? presetMarket ?? "JP");

  // シナリオ
  const [direction, setDirection] = useState<ScenarioDirection>(scenario?.direction ?? "buy");
  const [entryPrice, setEntryPrice] = useState(scenario?.entryPrice ?? 0);
  const [targetPrices, setTargetPrices] = useState<number[]>(scenario?.targetPrices ?? [0]);
  const [stopLossPrice, setStopLossPrice] = useState(scenario?.stopLossPrice ?? 0);
  const [holdingPeriod, setHoldingPeriod] = useState<ScenarioHoldingPeriod>(
    scenario?.holdingPeriod ?? "3m"
  );
  const [rationale, setRationale] = useState(scenario?.rationale ?? "");
  const [rationaleTags, setRationaleTags] = useState<string[]>(scenario?.rationaleTags ?? []);
  const [risks, setRisks] = useState(scenario?.risks ?? "");
  const [confidence, setConfidence] = useState(scenario?.confidence ?? 3);

  // 検索
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  const [saving, setSaving] = useState(false);

  // 現在価格を自動取得（新規作成時のみ）
  useEffect(() => {
    if (isEdit || !ticker) return;
    fetch(`/api/stocks/prices?tickers=${ticker}`)
      .then((res) => res.json())
      .then((data) => {
        const p = data.prices?.[ticker]?.price;
        if (p && entryPrice === 0) {
          setEntryPrice(Math.round(p));
          // 目標とストップロスのデフォルト: 買いなら+10%/-5%、売りなら-10%/+5%
          if (direction === "buy") {
            setTargetPrices([Math.round(p * 1.1)]);
            setStopLossPrice(Math.round(p * 0.95));
          } else if (direction === "sell") {
            setTargetPrices([Math.round(p * 0.9)]);
            setStopLossPrice(Math.round(p * 1.05));
          }
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

  // 銘柄検索
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/stocks/search?q=${encodeURIComponent(searchQuery)}`);
        const data = (await res.json()) as SearchResult[];
        setSearchResults(data.slice(0, 8));
        setShowSuggestions(true);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const selectStock = (s: SearchResult) => {
    setTicker(s.ticker);
    setName(s.name);
    setMarket(s.market);
    setSearchQuery("");
    setSearchResults([]);
    setShowSuggestions(false);
  };

  const toggleTag = (tag: string) => {
    setRationaleTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const handleSubmit = async () => {
    if (!user) return;
    if (!ticker || !name) {
      alert("銘柄を選択してください");
      return;
    }
    if (entryPrice <= 0) {
      alert("エントリー価格を入力してください");
      return;
    }
    setSaving(true);
    try {
      const data = {
        ticker,
        name,
        market,
        direction,
        entryPrice,
        targetPrices: targetPrices.filter((p) => p > 0),
        stopLossPrice,
        holdingPeriod,
        rationale,
        rationaleTags,
        risks,
        confidence,
      };
      if (isEdit && scenario?.id) {
        await updateScenario(user.uid, scenario.id, data);
      } else {
        await addScenario(user.uid, data);
      }
      onClose();
    } catch (err) {
      console.error("Failed to save scenario:", err);
      alert("保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl p-5 rounded space-y-4 max-h-[90vh] overflow-y-auto"
        style={{ background: "var(--bg-card)", border: "1px solid var(--color-accent)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-bold text-[var(--color-accent)]" style={MONO}>
          {isEdit ? "シナリオを編集" : "新規シナリオ"}
        </h2>

        {/* 銘柄選択 */}
        {!isEdit && (
          <div ref={searchRef} className="relative">
            <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
              銘柄
            </label>
            {ticker ? (
              <div className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-input)] border border-[var(--color-border)]">
                <span className="text-[9px] px-1.5 py-0.5" style={{ background: "rgba(0,240,255,0.15)", color: "var(--color-accent)", ...MONO }}>
                  {market}
                </span>
                <span className="text-sm text-[var(--color-accent)] font-bold" style={MONO}>
                  {ticker}
                </span>
                <span className="text-sm text-[var(--color-text)] flex-1 truncate">{name}</span>
                <button
                  onClick={() => {
                    setTicker("");
                    setName("");
                    setSearchQuery("");
                  }}
                  className="text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]"
                >
                  変更
                </button>
              </div>
            ) : (
              <>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)]"
                  placeholder="銘柄コードまたは銘柄名で検索"
                  style={MONO}
                />
                {searching && (
                  <span className="absolute right-3 top-[30px] text-[10px] text-[var(--color-accent)]" style={MONO}>
                    検索中...
                  </span>
                )}
                {showSuggestions && searchResults.length > 0 && (
                  <div
                    className="absolute z-50 w-full mt-1 max-h-[200px] overflow-y-auto"
                    style={{ background: "var(--bg-card)", border: "1px solid var(--color-accent)" }}
                  >
                    {searchResults.map((s) => (
                      <button
                        key={s.ticker + s.market}
                        onClick={() => selectStock(s)}
                        className="block w-full text-left px-3 py-2 text-xs hover:bg-[rgba(0,240,255,0.08)]"
                      >
                        <span className="text-[var(--color-accent)] font-bold mr-2" style={MONO}>
                          {s.ticker}
                        </span>
                        <span className="text-[var(--color-text)]">{s.name}</span>
                        <span className="text-[9px] text-[var(--color-text-secondary)] ml-2" style={MONO}>
                          {s.market}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* 方向 */}
        <div>
          <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-2" style={MONO}>
            方向
          </label>
          <div className="grid grid-cols-3 gap-2">
            {(["buy", "sell", "watch"] as const).map((d) => {
              const labels = { buy: "▲ 買い", sell: "▼ 売り", watch: "◆ 様子見" };
              const colors = { buy: "#22c55e", sell: "#ef4444", watch: "#9ca3af" };
              return (
                <button
                  key={d}
                  onClick={() => setDirection(d)}
                  className="text-xs py-2"
                  style={{
                    border: `1px solid ${direction === d ? colors[d] : "var(--color-border)"}`,
                    color: direction === d ? colors[d] : "var(--color-text-secondary)",
                    background: direction === d ? `${colors[d]}10` : "transparent",
                    ...MONO,
                  }}
                >
                  {labels[d]}
                </button>
              );
            })}
          </div>
        </div>

        {/* 価格 */}
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
              エントリー
            </label>
            <input
              type="number"
              value={entryPrice}
              onChange={(e) => setEntryPrice(Number(e.target.value))}
              className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-2 text-sm text-[var(--color-text)]"
              style={MONO}
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-[0.1em] text-[#22c55e] block mb-1" style={MONO}>
              目標
            </label>
            <input
              type="number"
              value={targetPrices[0]}
              onChange={(e) => setTargetPrices([Number(e.target.value), ...targetPrices.slice(1)])}
              className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-2 text-sm text-[var(--color-text)]"
              style={MONO}
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-[0.1em] text-[#ef4444] block mb-1" style={MONO}>
              損切り
            </label>
            <input
              type="number"
              value={stopLossPrice}
              onChange={(e) => setStopLossPrice(Number(e.target.value))}
              className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-2 text-sm text-[var(--color-text)]"
              style={MONO}
            />
          </div>
        </div>

        {/* 損益試算 */}
        {entryPrice > 0 && targetPrices[0] > 0 && stopLossPrice > 0 && (
          <div className="grid grid-cols-2 gap-2 text-[10px]" style={MONO}>
            <div className="px-2 py-1 text-[#22c55e]">
              目標到達: {direction === "buy"
                ? `+${(((targetPrices[0] - entryPrice) / entryPrice) * 100).toFixed(2)}%`
                : `+${(((entryPrice - targetPrices[0]) / entryPrice) * 100).toFixed(2)}%`}
            </div>
            <div className="px-2 py-1 text-[#ef4444]">
              損切り到達: {direction === "buy"
                ? `${(((stopLossPrice - entryPrice) / entryPrice) * 100).toFixed(2)}%`
                : `${(((entryPrice - stopLossPrice) / entryPrice) * 100).toFixed(2)}%`}
            </div>
          </div>
        )}

        {/* 保有期間 */}
        <div>
          <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-2" style={MONO}>
            想定保有期間
          </label>
          <div className="flex flex-wrap gap-1.5">
            {(["1w", "1m", "3m", "6m", "1y", "long"] as const).map((p) => {
              const labels = { "1w": "1週間", "1m": "1か月", "3m": "3か月", "6m": "6か月", "1y": "1年", long: "長期" };
              return (
                <button
                  key={p}
                  onClick={() => setHoldingPeriod(p)}
                  className="text-[11px] px-3 py-1"
                  style={{
                    border: `1px solid ${holdingPeriod === p ? "var(--color-accent)" : "var(--color-border)"}`,
                    color: holdingPeriod === p ? "var(--color-accent)" : "var(--color-text-secondary)",
                    background: holdingPeriod === p ? "rgba(0,240,255,0.1)" : "transparent",
                    ...MONO,
                  }}
                >
                  {labels[p]}
                </button>
              );
            })}
          </div>
        </div>

        {/* 確信度 */}
        <div>
          <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-2" style={MONO}>
            確信度
          </label>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                onClick={() => setConfidence(n)}
                className="text-xl"
                style={{ color: n <= confidence ? "#fbbf24" : "var(--color-border)" }}
              >
                ★
              </button>
            ))}
            <span className="ml-2 text-xs text-[var(--color-text-secondary)] self-center" style={MONO}>
              {confidence}/5
            </span>
          </div>
        </div>

        {/* 根拠タグ */}
        <div>
          <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-2" style={MONO}>
            根拠タグ (複数選択可)
          </label>
          <div className="flex flex-wrap gap-1.5">
            {SCENARIO_RATIONALE_TAGS.map((tag) => (
              <button
                key={tag}
                onClick={() => toggleTag(tag)}
                className="text-[10px] px-2 py-1"
                style={{
                  border: `1px solid ${rationaleTags.includes(tag) ? "var(--color-accent)" : "var(--color-border)"}`,
                  color: rationaleTags.includes(tag) ? "var(--color-accent)" : "var(--color-text-secondary)",
                  background: rationaleTags.includes(tag) ? "rgba(0,240,255,0.1)" : "transparent",
                  ...MONO,
                }}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        {/* 根拠詳細 */}
        <div>
          <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
            根拠 (詳細)
          </label>
          <textarea
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            rows={3}
            className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] resize-none"
            placeholder="なぜこの銘柄を、この方向で、この価格で..."
            style={MONO}
          />
        </div>

        {/* リスク */}
        <div>
          <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
            想定リスク
          </label>
          <textarea
            value={risks}
            onChange={(e) => setRisks(e.target.value)}
            rows={2}
            className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] resize-none"
            placeholder="シナリオが崩れる要因..."
            style={MONO}
          />
        </div>

        {/* アクション */}
        <div className="flex gap-2 pt-2">
          <button
            onClick={onClose}
            className="flex-1 text-sm py-2.5"
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
            className="flex-1 text-sm py-2.5 font-medium"
            style={{
              border: "1px solid var(--color-accent)",
              color: "var(--color-accent)",
              background: "rgba(0,240,255,0.1)",
              ...MONO,
            }}
          >
            {saving ? "保存中..." : isEdit ? "更新" : "作成"}
          </button>
        </div>
      </div>
    </div>
  );
}
