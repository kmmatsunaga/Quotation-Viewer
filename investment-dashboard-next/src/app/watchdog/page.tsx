"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface WatchdogEventDisplay {
  id: string;
  ticker: string;
  name: string;
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
  data?: Record<string, unknown>;
  triggeredAt: string | null;
  acknowledged?: boolean;
  lineNotified?: boolean;
}

const TYPE_LABELS: Record<string, { label: string; emoji: string }> = {
  price_spike: { label: "価格急変", emoji: "📊" },
  volume_anomaly: { label: "出来高異常", emoji: "🔥" },
  margin_squeeze: { label: "踏み上げ警戒", emoji: "⚡" },
  earnings_warning: { label: "決算近接", emoji: "📅" },
  stop_loss_near: { label: "損切り接近", emoji: "🚨" },
  target_reached: { label: "目標達成", emoji: "🎯" },
  news_alert: { label: "重要ニュース", emoji: "📰" },
};

const SEVERITY_COLORS = {
  critical: { color: "#ef4444", bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.4)" },
  warning: { color: "#f97316", bg: "rgba(249,115,22,0.06)", border: "rgba(249,115,22,0.3)" },
  info: { color: "#fbbf24", bg: "rgba(251,191,36,0.04)", border: "rgba(251,191,36,0.25)" },
};

export default function WatchdogPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [events, setEvents] = useState<WatchdogEventDisplay[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "critical" | "warning" | "info">("all");
  const [checkResult, setCheckResult] = useState<{ checked: number; triggered: number } | null>(null);

  const loadEvents = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const { auth } = await import("@/lib/firebase");
      const token = await auth.currentUser?.getIdToken();
      if (!token) {
        setError("ログインが必要です");
        return;
      }
      const res = await fetch(`/api/watchdog/events?limit=100`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (json.ok) setEvents(json.events ?? []);
      else setError(json.error ?? "取得失敗");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  // 手動チェック実行
  const runCheck = async () => {
    if (!user?.email) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await fetch(`/api/watchdog/check?email=${encodeURIComponent(user.email)}`, {
        method: "POST",
        headers: { "x-api-key": "fe4f125d965940e2a98d4d948e5099b48bb22db8b41276c2b3c73ac839f94774" },
      });
      const json = await res.json();
      if (json.ok) {
        setCheckResult({ checked: json.checked, triggered: json.triggered });
        await loadEvents();
      } else {
        setError(json.error ?? "チェック失敗");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const filtered = filter === "all" ? events : events.filter((e) => e.severity === filter);

  // サマリ
  const summary = {
    critical: events.filter((e) => e.severity === "critical").length,
    warning: events.filter((e) => e.severity === "warning").length,
    info: events.filter((e) => e.severity === "info").length,
  };

  return (
    <div className="space-y-4">
      {/* ヘッダー */}
      <div className="flex justify-between items-start flex-wrap gap-3">
        <div>
          <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">
            📡 ポートフォリオ・ウォッチドッグ
          </h1>
          <p className="text-xs text-[var(--color-text-secondary)] mt-1" style={MONO}>
            保有銘柄・お気に入り・シナリオを自動監視。重要な変化を即検知してLINE通知。
          </p>
        </div>
        <button
          onClick={runCheck}
          disabled={checking}
          className="px-4 py-2 text-sm font-medium"
          style={{
            border: "1px solid var(--color-accent-magenta)",
            color: "var(--color-accent-magenta)",
            background: checking ? "rgba(255,0,255,0.1)" : "transparent",
            ...MONO,
          }}
        >
          {checking ? "チェック中..." : "🔍 今すぐチェック"}
        </button>
      </div>

      {checkResult && (
        <div
          className="p-3 rounded text-xs"
          style={{
            background: "rgba(0,240,255,0.05)",
            border: "1px solid var(--color-accent)",
            ...MONO,
          }}
        >
          ✓ {checkResult.checked}銘柄チェック完了 → 新規イベント {checkResult.triggered}件
        </div>
      )}

      {/* サマリ */}
      <div className="grid grid-cols-3 gap-2">
        <SummaryCard label="🚨 重大" count={summary.critical} severity="critical" />
        <SummaryCard label="⚠️ 警告" count={summary.warning} severity="warning" />
        <SummaryCard label="💡 情報" count={summary.info} severity="info" />
      </div>

      {/* フィルタ */}
      <div className="flex gap-1 flex-wrap">
        {(["all", "critical", "warning", "info"] as const).map((s) => {
          const labels = { all: "すべて", critical: "重大のみ", warning: "警告のみ", info: "情報のみ" };
          const active = filter === s;
          return (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className="px-3 py-1.5 text-xs"
              style={{
                border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border)"}`,
                color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
                background: active ? "rgba(0,240,255,0.1)" : "transparent",
                ...MONO,
              }}
            >
              {labels[s]}
            </button>
          );
        })}
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
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-[var(--color-text-secondary)] text-sm" style={MONO}>
          {events.length === 0
            ? "イベント履歴がありません。「🔍 今すぐチェック」を実行してください。"
            : "このフィルタに該当するイベントがありません。"}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((e) => (
            <EventCard key={e.id} event={e} onClick={() => router.push(`/stock/${e.ticker}`)} />
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, count, severity }: { label: string; count: number; severity: "critical" | "warning" | "info" }) {
  const c = SEVERITY_COLORS[severity];
  return (
    <div className="p-3 rounded text-center" style={{ background: count > 0 ? c.bg : "transparent", border: `1px solid ${c.border}`, ...MONO }}>
      <div className="text-[10px] text-[var(--color-text-secondary)]">{label}</div>
      <div className="text-2xl font-bold" style={{ color: count > 0 ? c.color : "var(--color-text-secondary)" }}>
        {count}
      </div>
    </div>
  );
}

function EventCard({ event, onClick }: { event: WatchdogEventDisplay; onClick: () => void }) {
  const c = SEVERITY_COLORS[event.severity];
  const t = TYPE_LABELS[event.type] ?? { label: event.type, emoji: "📡" };
  const time = event.triggeredAt ? new Date(event.triggeredAt) : null;
  const timeStr = time
    ? `${time.getMonth() + 1}/${time.getDate()} ${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`
    : "?";

  return (
    <button
      onClick={onClick}
      className="w-full text-left p-3 rounded transition-all hover:brightness-125"
      style={{
        background: c.bg,
        border: `1px solid ${c.border}`,
      }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base">{t.emoji}</span>
          <span
            className="text-[9px] px-1.5 py-0.5 rounded uppercase"
            style={{ background: `${c.color}20`, color: c.color, border: `1px solid ${c.border}`, ...MONO }}
          >
            {t.label}
          </span>
          <span className="text-xs font-bold text-[var(--color-accent)]" style={MONO}>
            {event.ticker}
          </span>
          <span className="text-xs text-[var(--color-text)]">{event.name}</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
          {event.lineNotified && (
            <span className="px-1.5 py-0.5" style={{ color: "#22c55e", border: "1px solid #22c55e40" }}>
              📱 LINE送信済
            </span>
          )}
          <span>{timeStr}</span>
        </div>
      </div>
      <div className="text-xs mt-2 ml-7" style={{ color: c.color, ...MONO }}>
        {event.message}
      </div>
    </button>
  );
}
