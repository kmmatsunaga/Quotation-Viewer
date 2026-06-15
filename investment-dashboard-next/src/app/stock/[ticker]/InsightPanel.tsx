"use client";

import { useState, useEffect, useCallback } from "react";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface Signal {
  timeframe: "short" | "mid" | "long";
  direction: "bullish" | "bearish" | "neutral";
  weight: number;
  source: string;
  message: string;
}

interface TimeframeVerdict {
  timeframe: "short" | "mid" | "long";
  label: string;
  score: number;
  signalCount: { bullish: number; bearish: number; neutral: number };
  signals: Signal[];
  action: string;
  detail: string;
}

interface InsightData {
  ticker: string;
  name: string;
  currentPrice: number | null;
  short: TimeframeVerdict;
  mid: TimeframeVerdict;
  long: TimeframeVerdict;
  suggestedScenario: {
    entry: number | null;
    target: number | null;
    stopLoss: number | null;
    riskRewardRatio: number | null;
  };
  fetchedAt: string;
}

/**
 * 💡 インサイトパネル - 銘柄の意思決定を支援する総合判断ビュー
 * 短期/中期/長期の3軸で「この銘柄、いま買うべき?」を可視化。
 */
export default function InsightPanel({ ticker }: { ticker: string }) {
  const [data, setData] = useState<InsightData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<"short" | "mid" | "long" | null>("mid");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/stocks/insights?ticker=${ticker}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [ticker]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="p-4 rounded text-center text-xs text-[var(--color-text-secondary)]" style={{ background: "var(--bg-card)", border: "1px solid var(--color-border)", ...MONO }}>
        💡 インサイトを生成中...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4 rounded text-center text-xs text-red-400" style={{ background: "var(--bg-card)", border: "1px solid var(--color-border)", ...MONO }}>
        ⚠ {error ?? "データ取得失敗"}
      </div>
    );
  }

  // 総合スコア = 3つの平均 (短期1 : 中期2 : 長期1.5の重み)
  const overall = Math.round(
    (data.short.score * 1 + data.mid.score * 2 + data.long.score * 1.5) / 4.5
  );

  return (
    <div
      className="rounded overflow-hidden"
      style={{
        background: "linear-gradient(180deg, rgba(0,240,255,0.05) 0%, var(--bg-card) 100%)",
        border: "1px solid var(--color-accent)",
        boxShadow: "0 0 24px rgba(0,240,255,0.1)",
      }}
    >
      {/* ヘッダー */}
      <div className="p-4 pb-3 border-b border-[var(--color-border)]">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-base font-medium text-[var(--color-accent)]" style={MONO}>
              💡 インサイト ({data.name})
            </h3>
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-1" style={MONO}>
              全データから自動診断 - 短期/中期/長期それぞれの目線で判定
            </p>
          </div>
          <button
            onClick={fetchData}
            className="text-[10px] px-2 py-1"
            style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", ...MONO }}
          >
            🔄 再計算
          </button>
        </div>
      </div>

      {/* 3軸スコアサマリー */}
      <div className="grid grid-cols-3 gap-px bg-[var(--color-border)]">
        <ScoreCard
          verdict={data.short}
          isExpanded={expanded === "short"}
          onClick={() => setExpanded(expanded === "short" ? null : "short")}
        />
        <ScoreCard
          verdict={data.mid}
          isExpanded={expanded === "mid"}
          onClick={() => setExpanded(expanded === "mid" ? null : "mid")}
          isFeatured
        />
        <ScoreCard
          verdict={data.long}
          isExpanded={expanded === "long"}
          onClick={() => setExpanded(expanded === "long" ? null : "long")}
        />
      </div>

      {/* 展開: シグナル詳細 */}
      {expanded && (
        <div className="p-4 space-y-2" style={{ background: "rgba(0,0,0,0.2)" }}>
          {(() => {
            const v = data[expanded];
            return (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-[var(--color-accent)]" style={MONO}>
                    {v.label} - 詳細シグナル
                  </span>
                  <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
                    🟢{v.signalCount.bullish} 🔴{v.signalCount.bearish} 🟡{v.signalCount.neutral}
                  </span>
                </div>
                {v.signals.length === 0 ? (
                  <div className="text-xs text-[var(--color-text-secondary)] py-2 text-center" style={MONO}>
                    このタイムフレームでは判定可能なシグナルがありません
                  </div>
                ) : (
                  <div className="space-y-1">
                    {v.signals.map((s, i) => (
                      <SignalRow key={i} signal={s} />
                    ))}
                  </div>
                )}
                <div
                  className="mt-3 p-2.5 rounded text-xs"
                  style={{
                    background: "rgba(0,240,255,0.05)",
                    border: "1px solid rgba(0,240,255,0.2)",
                    ...MONO,
                  }}
                >
                  <div className="text-[10px] text-[var(--color-text-secondary)] mb-1">解説</div>
                  {v.detail}
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* 推奨シナリオ */}
      {data.suggestedScenario.entry && (
        <div className="p-4 border-t border-[var(--color-border)]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-[var(--color-text)]" style={MONO}>
              📋 推奨シナリオ (中期目線)
            </span>
            <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
              総合スコア: <span style={{ color: scoreColor(overall) }}>{overall}/100</span>
            </span>
          </div>
          <div className="grid grid-cols-4 gap-2 text-xs" style={MONO}>
            <ScenarioCell label="エントリー" value={data.suggestedScenario.entry} color="var(--color-accent)" />
            <ScenarioCell label="🎯 目標" value={data.suggestedScenario.target} color="#22c55e" />
            <ScenarioCell label="⚠ 損切り" value={data.suggestedScenario.stopLoss} color="#ef4444" />
            <ScenarioCell label="R:R" value={data.suggestedScenario.riskRewardRatio} suffix="" color="#a78bfa" prefix="1:" />
          </div>
          <p className="text-[10px] text-[var(--color-text-secondary)] mt-2" style={MONO}>
            ※ 中期スコアに基づく機械的な提案です。実際の判断はご自身で。
          </p>
        </div>
      )}
    </div>
  );
}

function scoreColor(score: number): string {
  if (score >= 65) return "#22c55e";
  if (score >= 45) return "#fbbf24";
  if (score >= 30) return "#f97316";
  return "#ef4444";
}

function ScoreCard({
  verdict,
  isExpanded,
  onClick,
  isFeatured,
}: {
  verdict: TimeframeVerdict;
  isExpanded: boolean;
  onClick: () => void;
  isFeatured?: boolean;
}) {
  const color = scoreColor(verdict.score);
  return (
    <button
      onClick={onClick}
      className="p-3 text-left transition-all hover:brightness-125 relative"
      style={{
        background: isExpanded
          ? `${color}15`
          : isFeatured
          ? "rgba(0,0,0,0.3)"
          : "rgba(0,0,0,0.2)",
        ...MONO,
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-bold text-[var(--color-text)]">
          {verdict.label}
        </span>
        <span className="text-4xl font-black leading-none" style={{ color, ...MONO }}>
          {verdict.score}
        </span>
      </div>
      <div className="text-sm font-bold mt-2" style={{ color }}>
        {verdict.action}
      </div>
      <div className="flex gap-2 mt-2 text-xs" style={{ color: "var(--color-text-secondary)" }}>
        <span>🟢{verdict.signalCount.bullish}</span>
        <span>🔴{verdict.signalCount.bearish}</span>
        <span>🟡{verdict.signalCount.neutral}</span>
      </div>
      {isExpanded && (
        <div
          className="absolute bottom-0 left-0 right-0 h-0.5"
          style={{ background: color }}
        />
      )}
    </button>
  );
}

function SignalRow({ signal }: { signal: Signal }) {
  const colors = {
    bullish: { color: "#22c55e", icon: "🟢" },
    bearish: { color: "#ef4444", icon: "🔴" },
    neutral: { color: "#fbbf24", icon: "🟡" },
  };
  const c = colors[signal.direction];
  // 重みを視覚化
  const weightBars = Math.min(5, Math.ceil(signal.weight / 2));
  return (
    <div
      className="flex items-start gap-2 px-2 py-1.5 text-xs rounded"
      style={{ background: "rgba(255,255,255,0.02)", ...MONO }}
    >
      <span className="shrink-0">{c.icon}</span>
      <span className="text-[9px] text-[var(--color-text-secondary)] shrink-0 w-16 pt-0.5">
        {signal.source}
      </span>
      <span className="flex-1" style={{ color: c.color }}>
        {signal.message}
      </span>
      <span className="shrink-0 flex gap-0.5 pt-0.5" title={`重み: ${signal.weight}/10`}>
        {Array.from({ length: 5 }, (_, i) => (
          <span
            key={i}
            className="w-1 h-2.5"
            style={{ background: i < weightBars ? c.color : "rgba(255,255,255,0.1)" }}
          />
        ))}
      </span>
    </div>
  );
}

function ScenarioCell({
  label,
  value,
  color,
  prefix = "¥",
  suffix = "",
}: {
  label: string;
  value: number | null;
  color: string;
  prefix?: string;
  suffix?: string;
}) {
  return (
    <div className="p-2 rounded" style={{ background: "rgba(0,0,0,0.3)", border: `1px solid ${color}40` }}>
      <div className="text-[9px] text-[var(--color-text-secondary)]">{label}</div>
      <div className="text-sm font-medium" style={{ color }}>
        {value !== null ? `${prefix}${value.toLocaleString()}${suffix}` : "-"}
      </div>
    </div>
  );
}
