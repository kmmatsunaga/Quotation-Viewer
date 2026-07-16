"use client";

import { useState, useEffect, useCallback } from "react";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface NewsItem {
  id: string;
  date: string;
  time: string;
  headline: string;
  relatedTickers: string[];
}

/**
 * 銘柄詳細画面用の小型ニュースパネル。直近のニュースを並べる。
 */
export default function StockNewsPanel({ ticker }: { ticker: string }) {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});

  const fetchNews = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { auth } = await import("@/lib/firebase");
      const token = await auth.currentUser?.getIdToken();
      if (!token) {
        setError("ログインが必要です");
        return;
      }
      const res = await fetch(`/api/news?ticker=${ticker}&limit=10`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (json.ok) {
        setItems(json.items ?? []);
      } else {
        setError(json.error ?? "取得失敗");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [ticker]);

  useEffect(() => {
    fetchNews();
  }, [fetchNews]);

  const openBody = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!bodies[id]) {
      try {
        const { auth } = await import("@/lib/firebase");
        const token = await auth.currentUser?.getIdToken();
        const res = await fetch(`/api/news/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await res.json();
        if (json.ok) setBodies((prev) => ({ ...prev, [id]: json.news.body }));
      } catch {}
    }
  };

  return (
    <div className="p-4 rounded" style={{ background: "var(--bg-card)", border: "1px solid var(--color-border)" }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-[var(--color-accent)]" style={MONO}>
          📰 関連ニュース
        </h3>
        <button
          onClick={fetchNews}
          disabled={loading}
          className="text-[10px] px-2 py-1"
          style={{
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
            ...MONO,
          }}
        >
          {loading ? "..." : "🔄"}
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-400 mb-2" style={MONO}>
          {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="text-xs text-[var(--color-text-secondary)] py-4 text-center" style={MONO}>
          取得中...
        </div>
      ) : items.length === 0 ? (
        <div className="text-xs text-[var(--color-text-secondary)] py-4 text-center" style={MONO}>
          直近30日間にこの銘柄のニュースはありません
        </div>
      ) : (
        <div className="space-y-1.5">
          {items.map((n) => {
            const sourceMatch = n.headline.match(/^<([^>]+)>/);
            const source = sourceMatch ? sourceMatch[1] : "";
            const cleanHeadline = n.headline.replace(/^<[^>]+>\s*/, "");
            const isExpanded = expandedId === n.id;
            return (
              <div key={n.id}>
                <button
                  onClick={() => openBody(n.id)}
                  className="w-full text-left flex items-start gap-2 px-2 py-1.5 rounded hover:bg-[rgba(0,240,255,0.04)] transition-colors"
                >
                  <span className="text-[10px] text-[var(--color-text-secondary)] shrink-0 w-20 pt-0.5" style={MONO}>
                    {n.date.slice(4, 6)}/{n.date.slice(6)} {n.time.slice(0, 2)}:{n.time.slice(2)}
                  </span>
                  {source && (
                    <span
                      className="text-[9px] shrink-0 w-12 pt-0.5"
                      style={{ color: "var(--color-accent-magenta)", ...MONO }}
                    >
                      {source}
                    </span>
                  )}
                  <span className="text-xs text-[var(--color-text)] flex-1">{cleanHeadline}</span>
                </button>
                {isExpanded && (
                  <div
                    className="ml-24 mt-1 mb-2 p-2.5 rounded text-xs text-[var(--color-text)] whitespace-pre-wrap leading-relaxed"
                    style={{ background: "rgba(0,240,255,0.03)", border: "1px solid var(--color-border)", ...MONO }}
                  >
                    {bodies[n.id] ?? "本文取得中..."}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
