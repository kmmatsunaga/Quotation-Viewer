"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

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
  recommendations: {
    ticker: string;
    name: string;
    market: string;
    score: number;
    summary: string;
    reasons: string[];
    currentPrice: number;
    suggestedAction?: string;
  }[];
  /** v2: 時間軸別リスト */
  horizons?: { short: HorizonPick[]; mid: HorizonPick[]; long: HorizonPick[] };
  generatedAt?: { seconds: number } | string;
}

const HORIZON_TABS = [
  { key: "short" as const, label: "⚡短期", desc: "数日 — 出来高×初動×相対強さ (全銘柄スキャン)" },
  { key: "mid" as const, label: "🌱中期", desc: "数週〜 — 続いているトレンド (決算直前は除外)" },
  { key: "long" as const, label: "🏔長期", desc: "数ヶ月〜 — 事業の質×安定地形 (罠銘柄は除外)" },
];

interface WatchdogEvent {
  id: string;
  ticker: string;
  name: string;
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
  triggeredAt: string | null;
}

const SEVERITY_COLORS = {
  critical: { color: "#ef4444", bg: "rgba(239,68,68,0.08)" },
  warning: { color: "#f97316", bg: "rgba(249,115,22,0.06)" },
  info: { color: "#fbbf24", bg: "rgba(251,191,36,0.04)" },
};

/**
 * トップページ用の AI エージェントパネル群:
 *  - デイリーおすすめ
 *  - ウォッチドッグ警告 (最新3件)
 */
export default function AgentPanels() {
  const { user } = useAuth();
  const [rec, setRec] = useState<DailyRec | null>(null);
  const [events, setEvents] = useState<WatchdogEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { auth } = await import("@/lib/firebase");
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      const [recRes, evtRes] = await Promise.all([
        fetch(`/api/agent/daily-recommend`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/watchdog/events?limit=5`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const recJson = await recRes.json();
      const evtJson = await evtRes.json();
      if (recJson.ok && recJson.recommendation) setRec(recJson.recommendation);
      if (evtJson.ok) {
        // 過去24h以内の critical/warning のみトップに表示
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        const recent = (evtJson.events as WatchdogEvent[]).filter((e) => {
          if (!e.triggeredAt) return false;
          if (new Date(e.triggeredAt).getTime() < dayAgo) return false;
          return e.severity === "critical" || e.severity === "warning";
        });
        setEvents(recent.slice(0, 3));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  if (!user) return null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <WatchdogPanel events={events} loading={loading} onRefresh={load} />
      <RecommendationPanel rec={rec} loading={loading} onRefresh={load} />
    </div>
  );
}

function WatchdogPanel({ events, loading, onRefresh }: { events: WatchdogEvent[]; loading: boolean; onRefresh: () => void }) {
  const router = useRouter();
  const { user } = useAuth();
  const [checking, setChecking] = useState(false);

  const runCheck = async () => {
    if (!user) return;
    setChecking(true);
    try {
      const { auth } = await import("@/lib/firebase");
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      const res = await fetch(`/api/watchdog/check`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (json.ok) await onRefresh();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      className="p-4 rounded space-y-3"
      style={{ background: "var(--bg-card)", border: "1px solid var(--color-border)" }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-[var(--color-accent)]" style={MONO}>
          📡 ウォッチドッグ警告
        </h2>
        <div className="flex gap-1">
          <button
            onClick={runCheck}
            disabled={checking}
            className="text-[10px] px-2 py-1"
            style={{ border: "1px solid var(--color-accent-magenta)", color: "var(--color-accent-magenta)", ...MONO }}
          >
            {checking ? "..." : "🔍"}
          </button>
          <button onClick={() => router.push("/watchdog")} className="text-[10px] px-2 py-1" style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", ...MONO }}>
            すべて
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-6 text-xs text-[var(--color-text-secondary)]" style={MONO}>
          読み込み中...
        </div>
      ) : events.length === 0 ? (
        <div className="text-center py-6 text-xs text-[var(--color-text-secondary)]" style={MONO}>
          直近24h以内の警告はありません ✓
        </div>
      ) : (
        <div className="space-y-1.5">
          {events.map((e) => {
            const c = SEVERITY_COLORS[e.severity];
            return (
              <button
                key={e.id}
                onClick={() => router.push(`/stock/${e.ticker}`)}
                className="w-full text-left p-2 rounded"
                style={{ background: c.bg, border: `1px solid ${c.color}30` }}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-bold text-[var(--color-accent)]" style={MONO}>
                    {e.ticker}
                  </span>
                  <span className="text-xs text-[var(--color-text)] truncate">{e.name}</span>
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: c.color, ...MONO }}>
                  {e.message}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RecommendationPanel({ rec, loading, onRefresh }: { rec: DailyRec | null; loading: boolean; onRefresh: () => void }) {
  const router = useRouter();
  const { user } = useAuth();
  const [generating, setGenerating] = useState(false);
  const [horizon, setHorizon] = useState<"short" | "mid" | "long">("short");

  const generate = async () => {
    if (!user?.email) return;
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
      if (json.ok) await onRefresh();
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div
      className="p-4 rounded space-y-3"
      style={{ background: "var(--bg-card)", border: "1px solid var(--color-border)" }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-[var(--color-accent)]" style={MONO}>
          🌟 今日のおすすめ銘柄
        </h2>
        <div className="flex gap-1">
          <button
            onClick={generate}
            disabled={generating}
            className="text-[10px] px-2 py-1"
            style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)", ...MONO }}
          >
            {generating ? "..." : "🤖 生成"}
          </button>
          <button
            onClick={() => router.push("/recommendations")}
            className="text-[10px] px-2 py-1"
            style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", ...MONO }}
          >
            すべて
          </button>
        </div>
      </div>

      {/* 時間軸タブ (v2) */}
      {rec?.horizons && (
        <div>
          <div className="flex gap-1">
            {HORIZON_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setHorizon(t.key)}
                className="flex-1 py-1.5 text-[11px] font-bold transition-all"
                style={{
                  border: `1px solid ${horizon === t.key ? "var(--color-accent)" : "var(--color-border)"}`,
                  color: horizon === t.key ? "var(--color-accent)" : "var(--color-text-secondary)",
                  background: horizon === t.key ? "rgba(0,240,255,0.08)" : "transparent",
                  ...MONO,
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="text-[9px] text-[var(--color-text-secondary)] mt-1" style={MONO}>
            {HORIZON_TABS.find((t) => t.key === horizon)?.desc}
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-6 text-xs text-[var(--color-text-secondary)]" style={MONO}>
          読み込み中...
        </div>
      ) : rec?.horizons ? (
        (() => {
          const list = rec.horizons[horizon] ?? [];
          if (list.length === 0) {
            return (
              <div className="text-center py-6 text-xs text-[var(--color-text-secondary)]" style={MONO}>
                この時間軸では今日、条件を満たす銘柄がありません (無理に挙げない仕様です)
              </div>
            );
          }
          return (
            <div className="space-y-2">
              {list.slice(0, 3).map((r) => (
                <button
                  key={r.ticker}
                  data-ticker={r.ticker}
                  onClick={() => router.push(`/stock/${r.ticker}`)}
                  className="w-full text-left p-2.5 rounded transition-all hover:brightness-125"
                  style={{ background: "rgba(0,240,255,0.04)", border: "1px solid rgba(0,240,255,0.2)" }}
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="text-[10px] px-1.5 py-0.5 shrink-0"
                        style={{
                          background: r.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)",
                          color: r.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)",
                          ...MONO,
                        }}
                      >
                        {r.market}
                      </span>
                      <span className="text-xs font-bold text-[var(--color-accent)]" style={MONO}>{r.ticker}</span>
                      <span className="text-xs text-[var(--color-text)] truncate">{r.name}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className="text-[10px] px-1.5 py-0.5 font-bold"
                        style={{
                          background: r.score >= 80 ? "rgba(34,197,94,0.2)" : "rgba(0,240,255,0.15)",
                          color: r.score >= 80 ? "#22c55e" : "var(--color-accent)",
                          ...MONO,
                        }}
                      >
                        {r.score}/100
                      </span>
                      {r.price != null && <span className="text-xs" style={MONO}>¥{r.price.toLocaleString()}</span>}
                    </div>
                  </div>
                  {/* 根拠 (なぜ挙がったか) */}
                  <div className="space-y-0.5">
                    {r.reasons.slice(0, 3).map((reason, i) => (
                      <div key={i} className="text-[10px] text-[var(--color-text)]" style={MONO}>
                        ✓ {reason}
                      </div>
                    ))}
                  </div>
                  {r.caution && (
                    <div className="text-[10px] mt-1" style={{ color: "#fbbf24", ...MONO }}>
                      {r.caution}
                    </div>
                  )}
                </button>
              ))}
            </div>
          );
        })()
      ) : !rec || rec.recommendations.length === 0 ? (
        <div className="text-center py-6 text-xs text-[var(--color-text-secondary)]" style={MONO}>
          まだおすすめがありません。「🤖 生成」ボタンを押してください。
        </div>
      ) : (
        /* 旧形式のフォールバック (v2 生成前) */
        <div className="space-y-2">
          {rec.recommendations.slice(0, 3).map((r) => (
            <button
              key={r.ticker}
              data-ticker={r.ticker}
              onClick={() => router.push(`/stock/${r.ticker}`)}
              className="w-full text-left p-2.5 rounded transition-all hover:brightness-125"
              style={{ background: "rgba(0,240,255,0.04)", border: "1px solid rgba(0,240,255,0.2)" }}
            >
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-bold text-[var(--color-accent)]" style={MONO}>{r.ticker}</span>
                  <span className="text-xs text-[var(--color-text)] truncate">{r.name}</span>
                </div>
                <span className="text-[10px] px-1.5 py-0.5 font-bold" style={{ background: "rgba(0,240,255,0.15)", color: "var(--color-accent)", ...MONO }}>
                  {r.score}/100
                </span>
              </div>
              <div className="space-y-0.5">
                {r.reasons.slice(0, 3).map((reason, i) => (
                  <div key={i} className="text-[10px] text-[var(--color-text)]" style={MONO}>✓ {reason}</div>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
