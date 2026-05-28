"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

type Timeframe = "overall" | "short" | "mid" | "long";

const TF_LABELS: Record<Timeframe, { label: string; icon: string; desc: string }> = {
  overall: { label: "総合", icon: "📊", desc: "短中長 加重平均" },
  short:   { label: "短期", icon: "🔥", desc: "1〜4週で動きそう" },
  mid:     { label: "中期", icon: "📈", desc: "1〜6か月で勝負" },
  long:    { label: "長期", icon: "🏛", desc: "1年以上の保有想定" },
};

interface Entry {
  ticker: string;
  name: string;
  market: "JP" | "US";
  price: number | null;
  short: number;
  mid: number;
  long: number;
  overall: number;
}

interface RankingsResponse {
  ok: boolean;
  date?: string;
  universe?: { jp: number; us: number; total: number };
  processed?: number;
  errors?: number;
  elapsedMs?: number;
  entries?: Entry[];
  computedAt?: string;
  error?: string;
}

export default function RankingsPage() {
  const router = useRouter();
  const [data, setData] = useState<RankingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // フィルタ・ソート状態
  const [timeframe, setTimeframe] = useState<Timeframe>("overall");
  const [marketFilter, setMarketFilter] = useState<"all" | "JP" | "US">("all");
  const [scoreMin, setScoreMin] = useState<number>(0);
  const [query, setQuery] = useState<string>("");
  const [limit, setLimit] = useState<number>(50);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/rankings/score`)
      .then((r) => r.json())
      .then((j: RankingsResponse) => {
        if (cancelled) return;
        if (!j.ok) setError(j.error ?? "no data");
        else setData(j);
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!data?.entries) return [];
    const q = query.trim().toLowerCase();
    return data.entries
      .filter((e) => marketFilter === "all" || e.market === marketFilter)
      .filter((e) => e[timeframe] >= scoreMin)
      .filter((e) => !q || e.ticker.toLowerCase().includes(q) || e.name.toLowerCase().includes(q))
      .sort((a, b) => b[timeframe] - a[timeframe]);
  }, [data, timeframe, marketFilter, scoreMin, query]);

  const visible = filtered.slice(0, limit);

  return (
    <div className="space-y-4">
      {/* ヘッダー */}
      <div>
        <h1 className="text-xl font-bold text-[var(--color-accent)]" style={MONO}>
          📊 時間軸別スコアランキング
        </h1>
        <p className="text-xs text-[var(--color-text-secondary)] mt-1" style={MONO}>
          日経225 + 米国主要銘柄を毎日スキャン。短期/中期/長期 の時間軸ごとにランキング。
        </p>
      </div>

      {/* メタ情報 */}
      {data && data.entries && (
        <div
          className="p-3 border text-[10px] text-[var(--color-text-secondary)] grid grid-cols-2 sm:grid-cols-4 gap-2"
          style={{ ...MONO, borderColor: "var(--color-border)", background: "rgba(0,0,0,0.25)" }}
        >
          <div>
            <div className="uppercase">対象</div>
            <div className="text-[var(--color-text)] text-sm">
              JP {data.universe?.jp ?? "?"} + US {data.universe?.us ?? "?"} = {data.universe?.total ?? "?"}
            </div>
          </div>
          <div>
            <div className="uppercase">処理成功</div>
            <div className="text-[var(--color-text)] text-sm">
              {data.processed ?? 0} ({data.errors ?? 0} 失敗)
            </div>
          </div>
          <div>
            <div className="uppercase">計測日</div>
            <div className="text-[var(--color-text)] text-sm">{data.date ?? "—"}</div>
          </div>
          <div>
            <div className="uppercase">計算所要</div>
            <div className="text-[var(--color-text)] text-sm">
              {data.elapsedMs ? `${(data.elapsedMs / 1000).toFixed(1)}s` : "—"}
            </div>
          </div>
        </div>
      )}

      {/* 時間軸タブ */}
      <div className="flex gap-1 flex-wrap border-b border-[var(--color-border)]">
        {(Object.keys(TF_LABELS) as Timeframe[]).map((tf) => {
          const info = TF_LABELS[tf];
          const isActive = timeframe === tf;
          return (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              title={info.desc}
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

      {/* フィルタ */}
      <div className="flex flex-wrap gap-2 items-center text-xs" style={MONO}>
        <span className="text-[var(--color-text-secondary)]">市場:</span>
        {(["all", "JP", "US"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMarketFilter(m)}
            className="px-2 py-1 text-[11px]"
            style={{
              border: `1px solid ${marketFilter === m ? "var(--color-accent)" : "var(--color-border)"}`,
              color: marketFilter === m ? "var(--color-accent)" : "var(--color-text-secondary)",
              background: marketFilter === m ? "rgba(0,240,255,0.08)" : "transparent",
            }}
          >
            {m === "all" ? "全部" : m}
          </button>
        ))}
        <span className="ml-3 text-[var(--color-text-secondary)]">スコア下限:</span>
        <input
          type="number"
          value={scoreMin}
          onChange={(e) => setScoreMin(Number(e.target.value) || 0)}
          min={0}
          max={100}
          className="w-16 px-2 py-1 text-xs bg-[var(--bg-input)] border border-[var(--color-border)]"
          style={MONO}
        />
        <span className="ml-3 text-[var(--color-text-secondary)]">検索:</span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="銘柄コード/名"
          className="px-2 py-1 text-xs bg-[var(--bg-input)] border border-[var(--color-border)] flex-1 min-w-[160px]"
          style={MONO}
        />
        <span className="text-[10px] text-[var(--color-text-secondary)] ml-auto">
          {filtered.length} 銘柄
        </span>
      </div>

      {/* リスト */}
      {loading ? (
        <div className="text-center py-12 text-[var(--color-text-secondary)] text-sm" style={MONO}>
          読み込み中...
        </div>
      ) : error ? (
        <div className="p-3 border border-red-500/30 text-xs text-red-400" style={MONO}>
          ⚠ {error}
          <div className="mt-2 text-[var(--color-text-secondary)]">
            まだランキングが計算されていません。Cron が走るまでお待ちいただくか、管理者が手動実行してください:<br />
            <code className="text-[var(--color-accent)]">
              curl -H &quot;Authorization: Bearer $CRON_SECRET&quot; https://quotation-viewer.vercel.app/api/cron/score-rankings
            </code>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-8 text-xs text-[var(--color-text-secondary)]" style={MONO}>
          条件に合う銘柄がありません。
        </div>
      ) : (
        <>
          <div className="space-y-1">
            {visible.map((e, idx) => (
              <RankRow
                key={e.ticker}
                rank={idx + 1}
                entry={e}
                timeframe={timeframe}
                onClick={() => router.push(`/stock/${e.ticker}`)}
              />
            ))}
          </div>
          {filtered.length > limit && (
            <div className="text-center pt-2">
              <button
                onClick={() => setLimit(limit + 50)}
                className="px-3 py-1.5 text-xs"
                style={{
                  border: "1px solid var(--color-accent)",
                  color: "var(--color-accent)",
                  ...MONO,
                }}
              >
                さらに 50 件表示 (残り {filtered.length - limit} 件)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RankRow({
  rank,
  entry,
  timeframe,
  onClick,
}: {
  rank: number;
  entry: Entry;
  timeframe: Timeframe;
  onClick: () => void;
}) {
  const displayScore = entry[timeframe];
  const scoreColor =
    displayScore >= 75 ? "#22c55e"
    : displayScore >= 60 ? "#fbbf24"
    : displayScore >= 45 ? "var(--color-accent)"
    : "#fb923c";
  const rankColor = rank <= 3 ? "#fbbf24" : rank <= 10 ? "var(--color-accent)" : "var(--color-text-secondary)";

  const tfBadge = (label: string, value: number, isActive: boolean) => {
    const color = value >= 75 ? "#22c55e" : value >= 60 ? "#fbbf24" : value >= 45 ? "var(--color-accent)" : "#fb923c";
    return (
      <span
        className="text-[10px] px-1.5 py-0.5"
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
      className="w-full text-left p-2.5 flex items-center gap-3 transition-all hover:brightness-125"
      style={{
        background: "rgba(0,240,255,0.04)",
        border: "1px solid rgba(0,240,255,0.15)",
        borderLeft: `3px solid ${scoreColor}`,
      }}
    >
      <span
        className="text-sm font-bold shrink-0 w-8 text-right"
        style={{ color: rankColor, ...MONO }}
      >
        #{rank}
      </span>
      <span
        className="text-[10px] px-1.5 py-0.5 shrink-0"
        style={{
          background: entry.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)",
          color: entry.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)",
          ...MONO,
        }}
      >
        {entry.market}
      </span>
      <span className="text-xs font-bold text-[var(--color-accent)] shrink-0" style={MONO}>
        {entry.ticker}
      </span>
      <span className="text-xs text-[var(--color-text)] truncate flex-1">{entry.name}</span>
      <div className="flex gap-1 shrink-0">
        {tfBadge("短", entry.short, timeframe === "short")}
        {tfBadge("中", entry.mid, timeframe === "mid")}
        {tfBadge("長", entry.long, timeframe === "long")}
      </div>
      <span
        className="text-sm font-black shrink-0 w-12 text-right"
        style={{ color: scoreColor, ...MONO }}
      >
        {displayScore}
      </span>
      <span className="text-[10px] text-[var(--color-text-secondary)] shrink-0 w-20 text-right" style={MONO}>
        {entry.price ? `¥${entry.price.toLocaleString()}` : "—"}
      </span>
    </button>
  );
}
