"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface ScanResult {
  ticker: string;
  name: string;
  market: "JP" | "US";
  price: number | null;
  changePct: number | null;
  reboundScore: number;
  plungeScore: number;
  newsReactionScore: number;
  overallSignal: string;
  overallScore: number;
  summary: string;
  morningPattern: string;
  sympathy: { detected: boolean; direction: string | null; reason: string };
  signals: { source: string; direction: string; weight: number; message: string }[];
}

interface ScanResponse {
  ok: boolean;
  elapsedMs: number;
  marketAvg: { jp: number | null; us: number | null };
  counts: {
    total: number;
    processed: number;
    rebounds: number;
    overheats: number;
    newsActive: number;
    others: number;
  };
  rebounds: ScanResult[];
  overheats: ScanResult[];
  newsActive: ScanResult[];
  others: ScanResult[];
  computedAt: string;
}

// ユニバース別の polling 間隔とパス
type Universe = "fast" | "jp-all";
const UNIVERSE_CONFIG: Record<Universe, { label: string; description: string; interval: number; path: string; requiresAuth: boolean }> = {
  fast: {
    label: "📍 高速 (日経225+米国)",
    description: "265銘柄、~1秒で更新",
    interval: 30_000,
    path: "/api/intraday/scan?minScore=30",
    requiresAuth: false,
  },
  "jp-all": {
    label: "🇯🇵 プライム全銘柄",
    description: "立花全マスタ ~4456 銘柄, ~25-30秒で更新",
    interval: 60_000,
    path: "/api/intraday/scan-jp-all?minScore=40&limit=100",
    requiresAuth: true,
  },
};

export default function RealtimePage() {
  const router = useRouter();
  const [data, setData] = useState<ScanResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [universe, setUniverse] = useState<Universe>("fast");
  const config = UNIVERSE_CONFIG[universe];
  const [secondsLeft, setSecondsLeft] = useState(config.interval / 1000);
  const [marketFilter, setMarketFilter] = useState<"all" | "JP" | "US">("all");
  const [minChange, setMinChange] = useState<number>(2);
  const timerRef = useRef<number | null>(null);

  const fetchScan = useCallback(async () => {
    try {
      const headers: HeadersInit = {};
      if (config.requiresAuth) {
        const { auth } = await import("@/lib/firebase");
        const token = await auth.currentUser?.getIdToken();
        if (token) headers["Authorization"] = `Bearer ${token}`;
      }
      const res = await fetch(config.path, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: ScanResponse = await res.json();
      setData(json);
      setLastUpdate(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [config]);

  // 初回 + 周期更新
  useEffect(() => {
    fetchScan();
  }, [fetchScan]);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => {
      fetchScan();
      setSecondsLeft(config.interval / 1000);
    }, config.interval);
    timerRef.current = id as unknown as number;
    return () => clearInterval(id);
  }, [paused, fetchScan, config.interval]);

  // 秒表示
  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setSecondsLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [paused, lastUpdate]);

  // ユニバース切替時はリセット
  useEffect(() => {
    setSecondsLeft(config.interval / 1000);
  }, [universe, config.interval]);

  const filterFn = (list: ScanResult[]) =>
    list
      .filter((r) => marketFilter === "all" || r.market === marketFilter)
      .filter((r) => Math.abs(r.changePct ?? 0) >= minChange);

  return (
    <div className="space-y-4">
      {/* ヘッダー */}
      <div>
        <h1 className="text-xl font-bold text-[var(--color-accent)]" style={MONO}>
          ⚡ リアルタイム超短期シグナル
        </h1>
        <p className="text-xs text-[var(--color-text-secondary)] mt-1" style={MONO}>
          {config.description} · {config.interval / 1000}秒ごと自動更新
        </p>
      </div>

      {/* ユニバース切替 */}
      <div className="flex flex-wrap gap-2 items-center text-xs" style={MONO}>
        <span className="text-[var(--color-text-secondary)]">対象:</span>
        {(Object.keys(UNIVERSE_CONFIG) as Universe[]).map((u) => {
          const isActive = universe === u;
          return (
            <button
              key={u}
              onClick={() => setUniverse(u)}
              title={UNIVERSE_CONFIG[u].description}
              className="px-3 py-1.5"
              style={{
                border: `1px solid ${isActive ? "var(--color-accent)" : "var(--color-border)"}`,
                color: isActive ? "var(--color-accent)" : "var(--color-text-secondary)",
                background: isActive ? "rgba(0,240,255,0.08)" : "transparent",
              }}
            >
              {UNIVERSE_CONFIG[u].label}
            </button>
          );
        })}
      </div>

      {/* ステータスバー */}
      <div
        className="p-3 border grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs"
        style={{ ...MONO, borderColor: "var(--color-border)", background: "rgba(0,0,0,0.25)" }}
      >
        <div>
          <div className="text-[9px] text-[var(--color-text-secondary)] uppercase">日経平均</div>
          <div
            className="text-base font-bold"
            style={{ color: (data?.marketAvg.jp ?? 0) >= 0 ? "#22c55e" : "#fb923c" }}
          >
            {data?.marketAvg.jp != null ? `${data.marketAvg.jp >= 0 ? "+" : ""}${data.marketAvg.jp.toFixed(2)}%` : "—"}
          </div>
        </div>
        <div>
          <div className="text-[9px] text-[var(--color-text-secondary)] uppercase">米国平均</div>
          <div
            className="text-base font-bold"
            style={{ color: (data?.marketAvg.us ?? 0) >= 0 ? "#22c55e" : "#fb923c" }}
          >
            {data?.marketAvg.us != null ? `${data.marketAvg.us >= 0 ? "+" : ""}${data.marketAvg.us.toFixed(2)}%` : "—"}
          </div>
        </div>
        <div>
          <div className="text-[9px] text-[var(--color-text-secondary)] uppercase">処理</div>
          <div className="text-base font-bold text-[var(--color-text)]">
            {data?.counts.processed ?? "?"}/{data?.counts.total ?? "?"}
            <span className="text-[10px] text-[var(--color-text-secondary)] ml-1">
              ({data?.elapsedMs ?? "?"}ms)
            </span>
          </div>
        </div>
        <div>
          <div className="text-[9px] text-[var(--color-text-secondary)] uppercase">最終更新</div>
          <div className="text-base font-bold text-[var(--color-text)]">
            {lastUpdate ? lastUpdate.toLocaleTimeString("ja-JP", { hour12: false }) : "—"}
          </div>
        </div>
        <div>
          <div className="text-[9px] text-[var(--color-text-secondary)] uppercase">次更新</div>
          <div className="text-base font-bold text-[var(--color-accent)]">
            {paused ? "⏸ 停止中" : `${secondsLeft}秒後`}
          </div>
        </div>
      </div>

      {/* コントロール */}
      <div className="flex flex-wrap gap-2 items-center text-xs" style={MONO}>
        <button
          onClick={() => setPaused(!paused)}
          className="px-3 py-1.5"
          style={{
            border: `1px solid ${paused ? "#fb923c" : "var(--color-accent)"}`,
            color: paused ? "#fb923c" : "var(--color-accent)",
          }}
        >
          {paused ? "▶ 再開" : "⏸ 停止"}
        </button>
        <button
          onClick={() => {
            fetchScan();
            setSecondsLeft(config.interval / 1000);
          }}
          className="px-3 py-1.5"
          style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}
        >
          🔄 今すぐ更新
        </button>
        <span className="ml-3 text-[var(--color-text-secondary)]">市場:</span>
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
        <span className="ml-3 text-[var(--color-text-secondary)]">変動下限:</span>
        <input
          type="number"
          value={minChange}
          onChange={(e) => setMinChange(Number(e.target.value) || 0)}
          min={0}
          step={0.5}
          className="w-14 px-2 py-1 text-xs bg-[var(--bg-input)] border border-[var(--color-border)]"
          style={MONO}
        />
        <span className="text-[10px] text-[var(--color-text-secondary)]">%</span>
      </div>

      {/* エラー */}
      {error && (
        <div className="p-2 border border-red-500/30 text-xs text-red-400" style={MONO}>
          ⚠ {error}
        </div>
      )}

      {/* ローディング */}
      {loading && !data ? (
        <div className="text-center py-12 text-[var(--color-text-secondary)] text-sm" style={MONO}>
          初回スキャン中...
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* リバウンド候補 */}
          <SignalColumn
            title="🟢 リバウンド候補"
            description="急落 + 戻し材料"
            color="#22c55e"
            items={filterFn(data?.rebounds ?? [])}
            scoreField="reboundScore"
            onClick={(t) => router.push(`/stock/${t}`)}
          />
          {/* 反落警戒 */}
          <SignalColumn
            title="🔥 反落警戒"
            description="急騰 + 過熱気味"
            color="#fb923c"
            items={filterFn(data?.overheats ?? [])}
            scoreField="plungeScore"
            onClick={(t) => router.push(`/stock/${t}`)}
          />
          {/* ニュース反応中 */}
          <SignalColumn
            title="📰 ニュース反応中"
            description="材料での急変"
            color="#facc15"
            items={filterFn(data?.newsActive ?? [])}
            scoreField="newsReactionScore"
            onClick={(t) => router.push(`/stock/${t}`)}
          />
        </div>
      )}
    </div>
  );
}

function SignalColumn({
  title,
  description,
  color,
  items,
  scoreField,
  onClick,
}: {
  title: string;
  description: string;
  color: string;
  items: ScanResult[];
  scoreField: "reboundScore" | "plungeScore" | "newsReactionScore";
  onClick: (ticker: string) => void;
}) {
  return (
    <div
      className="p-3 border"
      style={{
        ...MONO,
        borderColor: `${color}55`,
        background: `${color}08`,
      }}
    >
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="text-sm font-bold" style={{ color }}>
            {title}
          </div>
          <div className="text-[9px] text-[var(--color-text-secondary)] uppercase">
            {description}
          </div>
        </div>
        <div className="text-xs font-black" style={{ color }}>
          {items.length}
        </div>
      </div>
      {items.length === 0 ? (
        <div className="text-center py-6 text-[10px] text-[var(--color-text-secondary)]">
          該当銘柄なし
        </div>
      ) : (
        <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
          {items.slice(0, 20).map((r) => (
            <button
              key={r.ticker}
              onClick={() => onClick(r.ticker)}
              className="w-full text-left p-2 transition-all hover:brightness-125"
              style={{
                background: "rgba(0,0,0,0.3)",
                border: `1px solid ${color}33`,
              }}
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className="text-[9px] px-1 py-0.5 shrink-0"
                  style={{
                    background: r.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)",
                    color: r.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)",
                  }}
                >
                  {r.market}
                </span>
                <span className="text-[11px] font-bold text-[var(--color-accent)] shrink-0">
                  {r.ticker}
                </span>
                <span className="text-[11px] text-[var(--color-text)] truncate flex-1">
                  {r.name}
                </span>
                <span
                  className="text-[11px] font-bold shrink-0"
                  style={{ color: (r.changePct ?? 0) >= 0 ? "#22c55e" : "#fb923c" }}
                >
                  {(r.changePct ?? 0) >= 0 ? "+" : ""}{(r.changePct ?? 0).toFixed(1)}%
                </span>
              </div>
              <div className="flex items-center gap-2 text-[9px] text-[var(--color-text-secondary)]">
                <span>
                  ¥{r.price?.toLocaleString() ?? "—"}
                </span>
                <span style={{ color }}>
                  score {r[scoreField]}
                </span>
                {r.morningPattern && r.morningPattern !== "unknown" && r.morningPattern !== "flat" && (
                  <span className="px-1" style={{ background: "rgba(0,0,0,0.5)" }}>
                    {r.morningPattern}
                  </span>
                )}
                {r.sympathy.detected && (
                  <span className="text-[var(--color-accent-2)]">🌊 連動</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
