"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { getHoldings, getWatchlist } from "@/lib/firestore";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface NewsItem {
  id: string;
  date: string;
  time: string;
  categories: string[];
  genres: string[];
  relatedTickers: string[];
  headline: string;
}

type Scope = "all" | "holdings" | "watchlist" | "market";

export default function NewsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [scope, setScope] = useState<Scope>("holdings");
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNews, setSelectedNews] = useState<{ id: string; body?: string } | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);

  // 銘柄名のマップ（ticker → name）
  const [tickerNames, setTickerNames] = useState<Record<string, string>>({});

  const loadNews = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const token = await (await import("@/lib/firebase")).auth.currentUser?.getIdToken();
      if (!token) throw new Error("ログインが必要です");

      let tickers: string[] = [];
      if (scope === "market") {
        tickers = []; // ティッカー絞り込みなし → 全市場ニュース
      } else {
        const [holdings, watchlist] = await Promise.all([
          getHoldings(user.uid),
          getWatchlist(user.uid),
        ]);
        const nameMap: Record<string, string> = {};
        for (const h of holdings) nameMap[h.ticker] = h.name;
        for (const w of watchlist) nameMap[w.ticker] = w.name;
        setTickerNames(nameMap);

        if (scope === "holdings") tickers = holdings.map((h) => h.ticker);
        else if (scope === "watchlist") tickers = watchlist.map((w) => w.ticker);
        else if (scope === "all") {
          tickers = Array.from(new Set([...holdings.map((h) => h.ticker), ...watchlist.map((w) => w.ticker)]));
        }
      }

      // 各ティッカーごとに取得 (並列、市場全体時は1回)
      if (scope === "market") {
        const res = await fetch(`/api/news?limit=50`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        setItems(json.items ?? []);
      } else if (tickers.length === 0) {
        setItems([]);
      } else {
        // 並列取得
        const all: NewsItem[] = [];
        const results = await Promise.allSettled(
          tickers.map((t) =>
            fetch(`/api/news?ticker=${t}&limit=15`, {
              headers: { Authorization: `Bearer ${token}` },
            }).then((r) => r.json())
          )
        );
        for (const r of results) {
          if (r.status === "fulfilled" && r.value.ok) {
            all.push(...(r.value.items ?? []));
          }
        }
        // 日時降順にソート、ID重複除去
        const seen = new Set<string>();
        const uniq = all.filter((n) => {
          if (seen.has(n.id)) return false;
          seen.add(n.id);
          return true;
        });
        uniq.sort((a, b) => (b.id > a.id ? 1 : -1));
        setItems(uniq);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user, scope]);

  useEffect(() => {
    loadNews();
  }, [loadNews]);

  const openBody = async (id: string) => {
    setSelectedNews({ id });
    setBodyLoading(true);
    try {
      const token = await (await import("@/lib/firebase")).auth.currentUser?.getIdToken();
      const res = await fetch(`/api/news/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (json.ok) {
        setSelectedNews({ id, body: json.news.body });
      } else {
        setSelectedNews({ id, body: `エラー: ${json.error}` });
      }
    } catch (err) {
      setSelectedNews({ id, body: `エラー: ${(err as Error).message}` });
    } finally {
      setBodyLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* ヘッダー */}
      <div>
        <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">
          📰 ニュース
        </h1>
        <p className="text-xs text-[var(--color-text-secondary)] mt-1" style={MONO}>
          立花証券APIから配信されるリアルタイム日本株ニュース。保有・お気に入り銘柄でフィルタ可能。
        </p>
      </div>

      {/* スコープ切替 */}
      <div className="flex gap-1 flex-wrap">
        {(
          [
            { id: "holdings", label: "💼 保有のみ" },
            { id: "watchlist", label: "⭐ お気に入りのみ" },
            { id: "all", label: "🎯 保有+お気に入り" },
            { id: "market", label: "🌐 市場全体" },
          ] as { id: Scope; label: string }[]
        ).map((s) => (
          <button
            key={s.id}
            onClick={() => setScope(s.id)}
            className="px-3 py-1.5 text-xs"
            style={{
              border: `1px solid ${scope === s.id ? "var(--color-accent)" : "var(--color-border)"}`,
              color: scope === s.id ? "var(--color-accent)" : "var(--color-text-secondary)",
              background: scope === s.id ? "rgba(0,240,255,0.1)" : "transparent",
              ...MONO,
            }}
          >
            {s.label}
          </button>
        ))}
        <button
          onClick={loadNews}
          disabled={loading}
          className="ml-auto px-3 py-1.5 text-xs"
          style={{
            border: "1px solid var(--color-accent-magenta)",
            color: "var(--color-accent-magenta)",
            ...MONO,
          }}
        >
          {loading ? "取得中..." : "🔄 更新"}
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-400 p-3" style={{ border: "1px solid rgba(239,68,68,0.3)", ...MONO }}>
          {error}
        </div>
      )}

      {/* ニュース一覧 */}
      {loading && items.length === 0 ? (
        <div className="text-center py-12 text-[var(--color-text-secondary)] text-sm" style={MONO}>
          ニュース取得中...
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-[var(--color-text-secondary)] text-sm" style={MONO}>
          {scope === "holdings" && "保有銘柄に関するニュースはありません"}
          {scope === "watchlist" && "お気に入り銘柄に関するニュースはありません"}
          {scope === "all" && "対象銘柄に関するニュースはありません"}
          {scope === "market" && "市場ニュースを取得できませんでした"}
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
            {items.length}件のニュース
          </div>
          {items.map((n) => (
            <NewsRow
              key={n.id}
              news={n}
              tickerNames={tickerNames}
              onOpenBody={() => openBody(n.id)}
              onClickTicker={(t) => router.push(`/stock/${t}`)}
            />
          ))}
        </div>
      )}

      {/* ニュース本文モーダル */}
      {selectedNews && (
        <NewsBodyModal
          id={selectedNews.id}
          body={selectedNews.body}
          loading={bodyLoading}
          onClose={() => setSelectedNews(null)}
        />
      )}
    </div>
  );
}

function formatNewsTime(date: string, time: string): string {
  // date: YYYYMMDD, time: HHMM
  const m = parseInt(date.slice(4, 6), 10);
  const d = parseInt(date.slice(6, 8), 10);
  const hh = time.slice(0, 2);
  const mm = time.slice(2, 4);
  return `${m}/${d} ${hh}:${mm}`;
}

function NewsRow({
  news,
  tickerNames,
  onOpenBody,
  onClickTicker,
}: {
  news: NewsItem;
  tickerNames: Record<string, string>;
  onOpenBody: () => void;
  onClickTicker: (t: string) => void;
}) {
  // ヘッドラインからソース判定
  const sourceMatch = news.headline.match(/^<([^>]+)>/);
  const source = sourceMatch ? sourceMatch[1] : "";
  const cleanHeadline = news.headline.replace(/^<[^>]+>\s*/, "");
  const isToday = news.date === new Date().toISOString().slice(0, 10).replace(/-/g, "");

  return (
    <div
      className="flex items-start gap-2 px-2.5 py-2 rounded transition-all hover:bg-[rgba(0,240,255,0.04)]"
      style={{ border: "1px solid var(--color-border)" }}
    >
      <div className="text-[10px] text-[var(--color-text-secondary)] shrink-0 w-20 pt-0.5" style={MONO}>
        {formatNewsTime(news.date, news.time)}
        {isToday && <span className="ml-1 text-[#22c55e]">●</span>}
      </div>
      {source && (
        <div
          className="text-[9px] shrink-0 w-14 pt-0.5"
          style={{ color: "var(--color-accent-magenta)", ...MONO }}
        >
          {source}
        </div>
      )}
      <button onClick={onOpenBody} className="text-left flex-1 text-xs hover:text-[var(--color-accent)] transition-colors">
        {cleanHeadline}
      </button>
      <div className="flex gap-1 flex-wrap shrink-0 max-w-[200px]">
        {news.relatedTickers.slice(0, 3).map((t) => (
          <button
            key={t}
            onClick={() => onClickTicker(t)}
            className="text-[9px] px-1.5 py-0.5 hover:brightness-125"
            style={{
              background: "rgba(0,240,255,0.1)",
              color: "var(--color-accent)",
              ...MONO,
            }}
            title={tickerNames[t] ?? t}
          >
            {t}
          </button>
        ))}
        {news.relatedTickers.length > 3 && (
          <span className="text-[9px] text-[var(--color-text-secondary)] self-center" style={MONO}>
            +{news.relatedTickers.length - 3}
          </span>
        )}
      </div>
    </div>
  );
}

function NewsBodyModal({
  id,
  body,
  loading,
  onClose,
}: {
  id: string;
  body?: string;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl p-5 rounded space-y-4 max-h-[85vh] overflow-y-auto"
        style={{ background: "var(--bg-card)", border: "1px solid var(--color-accent)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start gap-2">
          <div className="text-[10px] text-[var(--color-text-secondary)] truncate" style={MONO}>
            ID: {id}
          </div>
          <button
            onClick={onClose}
            className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]"
          >
            ✕ 閉じる
          </button>
        </div>
        {loading ? (
          <div className="text-center py-8 text-[var(--color-text-secondary)] text-sm" style={MONO}>
            読み込み中...
          </div>
        ) : (
          <div className="text-sm text-[var(--color-text)] whitespace-pre-wrap leading-relaxed" style={MONO}>
            {body || "本文がありません"}
          </div>
        )}
      </div>
    </div>
  );
}
