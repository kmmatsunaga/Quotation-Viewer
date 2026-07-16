"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface Recommendation {
  ticker: string;
  name: string;
  market: string;
  score: number;
  // 個別時間軸スコア (新フォーマット)
  shortScore?: number;
  midScore?: number;
  longScore?: number;
  shortAction?: string;
  midAction?: string;
  longAction?: string;
  summary: string;
  reasons: string[];
  currentPrice: number;
  suggestedAction?: string;
}

type Timeframe = "overall" | "short" | "mid" | "long";

const TIMEFRAME_LABELS: Record<Timeframe, { label: string; icon: string; description: string }> = {
  overall: { label: "総合", icon: "📊", description: "短中長 加重平均" },
  short:   { label: "短期", icon: "🔥", description: "1〜4週で動きそう" },
  mid:     { label: "中期", icon: "📈", description: "1〜6か月で勝負" },
  long:    { label: "長期", icon: "🏛", description: "1年以上の保有想定" },
};

// 既存データは summary "(短X/中Y/長Z)" から個別スコアを抽出
function extractScores(r: Recommendation): { short: number; mid: number; long: number } {
  if (r.shortScore !== undefined && r.midScore !== undefined && r.longScore !== undefined) {
    return { short: r.shortScore, mid: r.midScore, long: r.longScore };
  }
  const m = r.summary?.match(/短(\d+)\/中(\d+)\/長(\d+)/);
  if (m) {
    return { short: parseInt(m[1], 10), mid: parseInt(m[2], 10), long: parseInt(m[3], 10) };
  }
  // fallback: 総合スコアを全部に適用
  return { short: r.score, mid: r.score, long: r.score };
}

interface DailyRec {
  id: string;
  date: string;
  recommendations: Recommendation[];
  generatedAt?: { _seconds?: number; seconds?: number } | string;
}

export default function RecommendationsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [history, setHistory] = useState<DailyRec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>("overall");

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const { auth } = await import("@/lib/firebase");
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      const res = await fetch(`/api/agent/daily-recommend?history=1&limit=30`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (json.ok) {
        setHistory(json.history ?? []);
        if (json.history?.length > 0 && !selectedDate) {
          setSelectedDate(json.history[0].date);
        }
      } else {
        setError(json.error ?? "取得失敗");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user, selectedDate]);

  useEffect(() => {
    load();
  }, [load]);

  const generate = async (n: number) => {
    if (!user?.email) return;
    setGenerating(true);
    try {
      const res = await fetch(`/api/agent/daily-recommend?email=${encodeURIComponent(user.email)}&n=${n}`, {
        method: "POST",
        headers: { "x-api-key": "fe4f125d965940e2a98d4d948e5099b48bb22db8b41276c2b3c73ac839f94774" },
      });
      const json = await res.json();
      if (json.ok) await load();
    } finally {
      setGenerating(false);
    }
  };

  const selected = history.find((h) => h.date === selectedDate) ?? history[0];

  return (
    <div className="space-y-4">
      {/* ヘッダー */}
      <div className="flex justify-between items-start flex-wrap gap-3">
        <div>
          <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">
            🌟 おすすめ銘柄
          </h1>
          <p className="text-xs text-[var(--color-text-secondary)] mt-1" style={MONO}>
            AI エージェントが日経225 + お気に入りを分析、中期スコア上位を提示。
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => generate(30)}
            disabled={generating}
            className="px-3 py-1.5 text-xs"
            style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)", ...MONO }}
          >
            {generating ? "AIが分析中..." : "🤖 標準スキャン (30銘柄)"}
          </button>
          <button
            onClick={() => generate(60)}
            disabled={generating}
            className="px-3 py-1.5 text-xs"
            style={{ border: "1px solid var(--color-accent-magenta)", color: "var(--color-accent-magenta)", ...MONO }}
          >
            {generating ? "..." : "🚀 深掘りスキャン (60銘柄, 2分)"}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded text-xs text-red-400" style={{ border: "1px solid rgba(239,68,68,0.3)", ...MONO }}>
          ⚠ {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-[var(--color-text-secondary)] text-sm" style={MONO}>
          読み込み中...
        </div>
      ) : history.length === 0 ? (
        <div className="text-center py-12 text-[var(--color-text-secondary)] text-sm" style={MONO}>
          まだ履歴がありません。「🤖 標準スキャン」を実行してください。
        </div>
      ) : (
        <>
          {/* 日付タブ */}
          <div className="flex gap-1 flex-wrap overflow-x-auto pb-1">
            {history.map((h) => {
              const isActive = h.date === (selectedDate ?? history[0].date);
              return (
                <button
                  key={h.id}
                  onClick={() => setSelectedDate(h.date)}
                  className="px-2.5 py-1.5 text-[10px] whitespace-nowrap"
                  style={{
                    border: `1px solid ${isActive ? "var(--color-accent)" : "var(--color-border)"}`,
                    color: isActive ? "var(--color-accent)" : "var(--color-text-secondary)",
                    background: isActive ? "rgba(0,240,255,0.1)" : "transparent",
                    ...MONO,
                  }}
                >
                  {h.date} ({h.recommendations.length})
                </button>
              );
            })}
          </div>

          {/* 選択日の詳細 */}
          {selected && (
            <div className="space-y-2">
              {/* 時間軸タブ */}
              <div className="flex gap-1 flex-wrap pb-1 border-b border-[var(--color-border)]">
                {(Object.keys(TIMEFRAME_LABELS) as Timeframe[]).map((tf) => {
                  const info = TIMEFRAME_LABELS[tf];
                  const isActive = timeframe === tf;
                  return (
                    <button
                      key={tf}
                      onClick={() => setTimeframe(tf)}
                      title={info.description}
                      className="px-3 py-1.5 text-xs whitespace-nowrap transition-all"
                      style={{
                        borderBottom: `2px solid ${isActive ? "var(--color-accent)" : "transparent"}`,
                        color: isActive ? "var(--color-accent)" : "var(--color-text-secondary)",
                        ...MONO,
                      }}
                    >
                      {info.icon} {info.label}
                    </button>
                  );
                })}
              </div>

              <div className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
                {selected.date} のおすすめ {selected.recommendations.length} 銘柄
                ({TIMEFRAME_LABELS[timeframe].label}スコア順)
                {timeframe !== "overall" && (
                  <span className="ml-2 text-[var(--color-accent)]">
                    ※ {TIMEFRAME_LABELS[timeframe].description}
                  </span>
                )}
              </div>

              {selected.recommendations.length === 0 ? (
                <div className="text-center py-8 text-xs text-[var(--color-text-secondary)]" style={MONO}>
                  この日のスキャンでは推奨閾値 (スコア55) を超える銘柄が見つかりませんでした。
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {(() => {
                    // 時間軸別ソート
                    const sorted = [...selected.recommendations].sort((a, b) => {
                      if (timeframe === "overall") return b.score - a.score;
                      const sa = extractScores(a);
                      const sb = extractScores(b);
                      return sb[timeframe] - sa[timeframe];
                    });
                    return sorted.map((r, idx) => (
                      <RecCard
                        key={r.ticker}
                        rank={idx + 1}
                        rec={r}
                        timeframe={timeframe}
                        onClick={() => router.push(`/stock/${r.ticker}`)}
                      />
                    ));
                  })()}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RecCard({
  rank,
  rec,
  timeframe,
  onClick,
}: {
  rank: number;
  rec: Recommendation;
  timeframe: Timeframe;
  onClick: () => void;
}) {
  const scores = extractScores(rec);
  const displayScore =
    timeframe === "overall" ? rec.score : scores[timeframe];
  const scoreColor = displayScore >= 80 ? "#22c55e" : displayScore >= 65 ? "#fbbf24" : "var(--color-accent)";
  const rankColor = rank <= 3 ? "#fbbf24" : "var(--color-text-secondary)";

  const tfBadge = (label: string, value: number, isActive: boolean) => {
    const color = value >= 75 ? "#22c55e" : value >= 60 ? "#fbbf24" : value >= 45 ? "var(--color-accent)" : "#fb923c";
    return (
      <span
        className="text-[9px] px-1 py-0.5"
        style={{
          background: isActive ? `${color}30` : `${color}10`,
          color,
          border: isActive ? `1px solid ${color}` : "1px solid transparent",
          ...MONO,
        }}
      >
        {label}{value}
      </span>
    );
  };

  return (
    <button
      onClick={onClick}
      className="text-left p-3 rounded transition-all hover:brightness-125"
      style={{ background: "rgba(0,240,255,0.04)", border: "1px solid rgba(0,240,255,0.2)" }}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-bold shrink-0" style={{ color: rankColor, ...MONO }}>
            #{rank}
          </span>
          <span
            className="text-[10px] px-1.5 py-0.5 shrink-0"
            style={{
              background: rec.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)",
              color: rec.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)",
              ...MONO,
            }}
          >
            {rec.market}
          </span>
          <span className="text-xs font-bold text-[var(--color-accent)]" style={MONO}>
            {rec.ticker}
          </span>
          <span className="text-xs text-[var(--color-text)] truncate">{rec.name}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className="text-[10px] px-1.5 py-0.5 font-bold"
            style={{ background: `${scoreColor}20`, color: scoreColor, ...MONO }}
          >
            {displayScore}/100
          </span>
          <span className="text-xs" style={MONO}>¥{rec.currentPrice.toLocaleString()}</span>
        </div>
      </div>
      {/* 3軸スコアバッジ */}
      <div className="flex gap-1 mb-1.5">
        {tfBadge("短", scores.short, timeframe === "short")}
        {tfBadge("中", scores.mid, timeframe === "mid")}
        {tfBadge("長", scores.long, timeframe === "long")}
        {timeframe === "overall" && (
          <span className="text-[9px] text-[var(--color-text-secondary)]" style={MONO}>
            総合{rec.score}
          </span>
        )}
      </div>
      <div className="text-[10px] text-[var(--color-text-secondary)] mb-1.5" style={MONO}>
        {rec.summary}
      </div>
      <div className="space-y-0.5">
        {rec.reasons.map((reason, i) => (
          <div key={i} className="text-[10px] text-[var(--color-text)]" style={MONO}>
            ✓ {reason}
          </div>
        ))}
      </div>
      {rec.suggestedAction && (
        <div className="text-[10px] text-[#a78bfa] mt-2 pt-2 border-t border-[var(--color-border)]" style={MONO}>
          📋 {rec.suggestedAction}
        </div>
      )}
    </button>
  );
}
