"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import NetCashStory from "@/components/NetCashStory";

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

type Timeframe = "overall" | "short" | "mid" | "long" | "kiyohara";

const TIMEFRAME_LABELS: Record<Timeframe, { label: string; icon: string; description: string }> = {
  overall: { label: "総合", icon: "📊", description: "短中長 加重平均" },
  short:   { label: "短期", icon: "🔥", description: "1〜4週で動きそう" },
  mid:     { label: "中期", icon: "📈", description: "1〜6か月で勝負" },
  long:    { label: "長期", icon: "🏛", description: "1年以上の保有想定" },
  kiyohara: { label: "清原式", icon: "🏔", description: "ネットキャッシュ×実質PER (長期のレース相手)" },
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

interface HorizonPick {
  ticker: string;
  name: string;
  market: string;
  price: number | null;
  score: number;
  reasons: string[];
  caution: string | null;
}

interface DailyRec {
  id: string;
  date: string;
  recommendations: Recommendation[];
  /** v2: 時間軸ごとに選定ロジックが異なる別リスト */
  horizons?: { short: HorizonPick[]; mid: HorizonPick[]; long: HorizonPick[]; kiyohara?: HorizonPick[] };
  generatedAt?: { _seconds?: number; seconds?: number } | string;
}

const HORIZON_DESC: Record<"short" | "mid" | "long" | "kiyohara", string> = {
  short: "数日 — 全銘柄スキャンから出来高×初動×相対強さで選定。宝くじ地形・低流動性は除外",
  mid: "数週〜数ヶ月 — 続いている20日トレンド×中期スコア。決算7日前以内は除外",
  long: "数ヶ月〜 — Future Score 5因子×安定地形。バリュートラップは除外",
  kiyohara: "数ヶ月〜 — 清原式: NC比率0.5以上×黒字×実質PER安い順。🏛長期と同じ60日窓で答え合わせのレース中 (割安の測定であり上昇予測ではない)",
};

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

  const generate = async () => {
    if (!user) return;
    setGenerating(true);
    try {
      // Firebase ID トークン認証 (API キーのクライアント埋め込みは廃止)
      const { auth } = await import("@/lib/firebase");
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      const res = await fetch(`/api/agent/daily-recommend`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
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
            短期=全銘柄スキャン / 中期=トレンド持続 / 長期=事業の質 — 時間軸ごとに別ロジックで選定。根拠つき。
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={generate}
            disabled={generating}
            className="px-3 py-1.5 text-xs"
            style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)", ...MONO }}
          >
            {generating ? "AIが分析中..." : "🤖 いま再スキャン"}
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
          {selected && (() => {
            const hasHorizons = !!selected.horizons;
            // v2 は時間軸ごとに別リストなので「総合」タブは出さない
            const tabs: Timeframe[] = hasHorizons
              ? ([
                  "short", "mid", "long",
                  ...((selected.horizons?.kiyohara?.length ?? 0) > 0 ? (["kiyohara"] as Timeframe[]) : []),
                ] as Timeframe[])
              : (Object.keys(TIMEFRAME_LABELS).filter((k) => k !== "kiyohara") as Timeframe[]);
            const effTf: Timeframe = hasHorizons && timeframe === "overall" ? "short" : timeframe;
            const horizonList =
              hasHorizons && effTf !== "overall" ? selected.horizons![effTf as "short" | "mid" | "long" | "kiyohara"] ?? [] : [];

            return (
              <div className="space-y-2">
                {/* 時間軸タブ */}
                <div className="flex gap-1 flex-wrap pb-1 border-b border-[var(--color-border)]">
                  {tabs.map((tf) => {
                    const info = TIMEFRAME_LABELS[tf];
                    const isActive = effTf === tf;
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

                {hasHorizons && effTf !== "overall" ? (
                  <>
                    <div className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
                      {selected.date} — {HORIZON_DESC[effTf as "short" | "mid" | "long" | "kiyohara"]}
                    </div>
                    {horizonList.length === 0 ? (
                      <div className="text-center py-8 text-xs text-[var(--color-text-secondary)]" style={MONO}>
                        この時間軸では条件を満たす銘柄がありませんでした (無理に挙げない仕様です)。
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {horizonList.map((r, idx) => (
                          <div key={r.ticker}>
                            <HorizonCard rank={idx + 1} pick={r} onClick={() => router.push(`/stock/${r.ticker}`)} />
                            {effTf === "kiyohara" && <KiyoharaStoryToggle ticker={r.ticker} />}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
                      {selected.date} のおすすめ {selected.recommendations.length} 銘柄
                      ({TIMEFRAME_LABELS[effTf].label}スコア順)
                    </div>
                    {selected.recommendations.length === 0 ? (
                      <div className="text-center py-8 text-xs text-[var(--color-text-secondary)]" style={MONO}>
                        この日のスキャンでは推奨閾値を超える銘柄が見つかりませんでした。
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {(() => {
                          const sorted = [...selected.recommendations].sort((a, b) => {
                            if (effTf === "overall") return b.score - a.score;
                            // 旧データ (v1) に清原軸は無い → 長期スコアで代用
                            const k = effTf === "kiyohara" ? "long" : effTf;
                            const sa = extractScores(a);
                            const sb = extractScores(b);
                            return sb[k] - sa[k];
                          });
                          return sorted.map((r, idx) => (
                            <RecCard
                              key={r.ticker}
                              rank={idx + 1}
                              rec={r}
                              timeframe={effTf}
                              onClick={() => router.push(`/stock/${r.ticker}`)}
                            />
                          ));
                        })()}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

/** v2: 時間軸別 pick のカード (根拠を主役に) */
/** 🏔清原式カード下部の「読み解き」開閉 (開いた時だけ生成APIを呼ぶ) */
function KiyoharaStoryToggle({ ticker }: { ticker: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1 rounded" style={{ border: "1px solid rgba(0,240,255,0.10)", background: "var(--bg-card)" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-3 py-1.5 text-[11px]"
        style={{ color: "var(--color-accent)", ...MONO }}
      >
        {open ? "▼" : "▶"} 🏔 この銘柄の読み解き (なぜ安い?動くきっかけは?)
      </button>
      {open && <NetCashStory ticker={ticker} />}
    </div>
  );
}

function HorizonCard({ rank, pick, onClick }: { rank: number; pick: HorizonPick; onClick: () => void }) {
  const scoreColor = pick.score >= 80 ? "#22c55e" : pick.score >= 65 ? "#fbbf24" : "var(--color-accent)";
  const rankColor = rank <= 3 ? "#fbbf24" : "var(--color-text-secondary)";
  return (
    <button
      data-ticker={pick.ticker}
      onClick={onClick}
      className="text-left p-3 rounded transition-all hover:brightness-125"
      style={{ background: "rgba(0,240,255,0.04)", border: "1px solid rgba(0,240,255,0.2)" }}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-bold shrink-0" style={{ color: rankColor, ...MONO }}>#{rank}</span>
          <span
            className="text-[10px] px-1.5 py-0.5 shrink-0"
            style={{
              background: pick.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)",
              color: pick.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)",
              ...MONO,
            }}
          >
            {pick.market}
          </span>
          <span className="text-xs font-bold text-[var(--color-accent)]" style={MONO}>{pick.ticker}</span>
          <span className="text-xs text-[var(--color-text)] truncate">{pick.name}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] px-1.5 py-0.5 font-bold" style={{ background: `${scoreColor}20`, color: scoreColor, ...MONO }}>
            {pick.score}/100
          </span>
          {pick.price != null && <span className="text-xs" style={MONO}>¥{pick.price.toLocaleString()}</span>}
        </div>
      </div>
      {/* 根拠 (なぜこのタブに挙がったか) */}
      <div className="space-y-0.5">
        {pick.reasons.map((reason, i) => (
          <div key={i} className="text-[10px] text-[var(--color-text)]" style={MONO}>✓ {reason}</div>
        ))}
      </div>
      {pick.caution && (
        <div className="text-[10px] mt-1.5 pt-1.5 border-t border-[var(--color-border)]" style={{ color: "#fbbf24", ...MONO }}>
          {pick.caution}
        </div>
      )}
    </button>
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
    timeframe === "overall" ? rec.score : scores[timeframe === "kiyohara" ? "long" : timeframe];
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
