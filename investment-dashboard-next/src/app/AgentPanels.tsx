"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

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
  generatedAt?: { seconds: number } | string;
}

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
    if (!user?.email) return;
    setChecking(true);
    try {
      const res = await fetch(`/api/watchdog/check?email=${encodeURIComponent(user.email)}`, {
        method: "POST",
        headers: { "x-api-key": "fe4f125d965940e2a98d4d948e5099b48bb22db8b41276c2b3c73ac839f94774" },
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

  const generate = async () => {
    if (!user?.email) return;
    setGenerating(true);
    try {
      const res = await fetch(`/api/agent/daily-recommend?email=${encodeURIComponent(user.email)}&n=30`, {
        method: "POST",
        headers: { "x-api-key": "fe4f125d965940e2a98d4d948e5099b48bb22db8b41276c2b3c73ac839f94774" },
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

      {loading ? (
        <div className="text-center py-6 text-xs text-[var(--color-text-secondary)]" style={MONO}>
          読み込み中...
        </div>
      ) : !rec || rec.recommendations.length === 0 ? (
        <div className="text-center py-6 text-xs text-[var(--color-text-secondary)]" style={MONO}>
          まだおすすめがありません。「🤖 生成」ボタンを押してください。
          <br />
          <span className="text-[10px]">※ 30銘柄の分析に約1分かかります</span>
        </div>
      ) : (
        <div className="space-y-2">
          {rec.recommendations.slice(0, 3).map((r) => (
            <button
              key={r.ticker}
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
                  <span className="text-xs font-bold text-[var(--color-accent)]" style={MONO}>
                    {r.ticker}
                  </span>
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
                  <span className="text-xs" style={MONO}>¥{r.currentPrice.toLocaleString()}</span>
                </div>
              </div>
              <div className="text-[10px] text-[var(--color-text-secondary)] mb-1" style={MONO}>
                {r.summary}
              </div>
              <div className="space-y-0.5">
                {r.reasons.slice(0, 3).map((reason, i) => (
                  <div key={i} className="text-[10px] text-[var(--color-text)]" style={MONO}>
                    ✓ {reason}
                  </div>
                ))}
              </div>
              {r.suggestedAction && (
                <div className="text-[10px] text-[#a78bfa] mt-1.5 pt-1.5 border-t border-[var(--color-border)]" style={MONO}>
                  📋 {r.suggestedAction}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
