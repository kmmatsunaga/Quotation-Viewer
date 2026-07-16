"use client";

import { useState, useEffect } from "react";
import { useTachibanaSnapshot, type SnapshotQuote as MarketQuote } from "./TachibanaSnapshotContext";
import { assessOrderBook } from "@/lib/order-book-assess";
import CommentaryPanel from "@/components/CommentaryPanel";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

/**
 * 立花APIから取得する板情報パネル。最大10段。
 * 自動更新: 5秒ごと（タブ非表示時は停止）。
 */
// 不使用変数の警告を回避するため
void undefined as unknown as string;

export default function OrderBookPanel({ ticker }: { ticker: string }) {
  const snapshot = useTachibanaSnapshot();
  const quote = snapshot.quote;
  const loading = snapshot.loading;
  const error = snapshot.error;
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);

  const fetchQuote = snapshot.refresh;

  // スナップショット更新時に lastUpdate を更新
  useEffect(() => {
    if (!loading && quote) setLastUpdate(new Date());
  }, [loading, quote, snapshot.refreshTick]);

  // 自動更新 (5秒ごと、タブ非表示時停止)
  useEffect(() => {
    if (!autoRefresh) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        if (!document.hidden) fetchQuote();
      }, 5000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVis = () => (document.hidden ? stop() : start());
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [autoRefresh, fetchQuote]);

  // "Xs ago" 表示更新
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  void tick;
  void ticker;  // 互換のため引数は残す (Context から取得)

  const sinceText = lastUpdate
    ? (() => {
        const s = Math.floor((Date.now() - lastUpdate.getTime()) / 1000);
        if (s < 60) return `${s}秒前`;
        return `${Math.floor(s / 60)}分前`;
      })()
    : "未取得";

  if (loading && !quote) {
    return (
      <div className="p-4 rounded text-xs text-[var(--color-text-secondary)] text-center" style={{ background: "var(--bg-card)", border: "1px solid var(--color-border)", ...MONO }}>
        板情報を取得中...
      </div>
    );
  }

  if (error || !quote) {
    return (
      <div className="p-4 rounded text-xs text-red-400 text-center" style={{ background: "var(--bg-card)", border: "1px solid var(--color-border)", ...MONO }}>
        ⚠ {error ?? "データ取得失敗"}
      </div>
    );
  }

  // 板の最大数量で正規化（バーグラフ用）
  const allQtys = [
    ...quote.bids.map((b) => b.quantity ?? 0),
    ...quote.asks.map((a) => a.quantity ?? 0),
  ];
  const maxQty = Math.max(...allQtys, 1);

  const totalBidQty = quote.bids.reduce((s, b) => s + (b.quantity ?? 0), 0);
  const totalAskQty = quote.asks.reduce((s, a) => s + (a.quantity ?? 0), 0);
  const bidPct = totalBidQty + totalAskQty > 0
    ? (totalBidQty / (totalBidQty + totalAskQty)) * 100
    : 50;

  const upColor = "#ff3b6b";
  const downColor = "#00d9ff";
  const isUp = (quote.changeAbs ?? 0) >= 0;

  // 板の温度計 (自動解説)
  const assessment = assessOrderBook({
    currentPrice: quote.currentPrice,
    changePct: quote.changePct,
    vwap: quote.vwap,
    highPrice: quote.highPrice,
    lowPrice: quote.lowPrice,
    bids: quote.bids,
    asks: quote.asks,
  });

  return (
    <div
      className="p-4 rounded space-y-3"
      style={{ background: "var(--bg-card)", border: "1px solid var(--color-border)" }}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-[var(--color-accent)]" style={MONO}>
            📊 板情報 (リアルタイム)
          </h3>
          {autoRefresh && (
            <span
              className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded"
              style={{ background: "rgba(0,240,255,0.1)", color: "var(--color-accent)", border: "1px solid var(--color-accent)" }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
              LIVE (5秒毎)
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-[var(--color-text-secondary)]" style={MONO}>
            最終: {sinceText} | 時刻: {quote.priceTime ?? "?"}
          </span>
          <label className="flex items-center gap-1 cursor-pointer" style={MONO}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="w-3 h-3 accent-[var(--color-accent)]"
            />
            <span className="text-[var(--color-text-secondary)]">自動更新</span>
          </label>
          <button
            onClick={fetchQuote}
            className="px-2 py-0.5"
            style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", ...MONO }}
          >
            🔄
          </button>
        </div>
      </div>

      {/* 売買比率 (数字大表示、補助バーは薄く) */}
      <div>
        <div className="flex justify-between items-baseline" style={MONO}>
          <div>
            <div className="text-xs font-bold text-[var(--color-text)]">買い厚み</div>
            <div className="text-2xl font-black" style={{ color: upColor }}>{bidPct.toFixed(0)}%</div>
            <div className="text-xs text-[var(--color-text)]">{totalBidQty.toLocaleString()}株</div>
          </div>
          <div className="text-right">
            <div className="text-xs font-bold text-[var(--color-text)]">売り厚み</div>
            <div className="text-2xl font-black" style={{ color: downColor }}>{(100 - bidPct).toFixed(0)}%</div>
            <div className="text-xs text-[var(--color-text)]">{totalAskQty.toLocaleString()}株</div>
          </div>
        </div>
        <div
          className="h-1 rounded-full overflow-hidden flex mt-2 opacity-50"
          style={{ background: "rgba(255,255,255,0.05)" }}
        >
          <div style={{ width: `${bidPct}%`, background: upColor }} />
          <div style={{ width: `${100 - bidPct}%`, background: downColor }} />
        </div>
      </div>

      {/* 板テーブル */}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-1 text-xs" style={MONO}>
        {/* ヘッダー */}
        <div className="text-[9px] text-[var(--color-text-secondary)] px-2 text-right">買数量</div>
        <div className="text-[9px] text-[var(--color-text-secondary)] text-center px-3">気配値</div>
        <div className="text-[9px] text-[var(--color-text-secondary)] px-2">売数量</div>

        {/* 売 (上から最深→最良) */}
        {[...quote.asks].reverse().map((ask, idx) => {
          const realIdx = 10 - idx;
          const widthPct = ask.quantity ? (ask.quantity / maxQty) * 100 : 0;
          const isBestAsk = realIdx === 1;
          return (
            <BookRow
              key={`a${realIdx}`}
              side="ask"
              level={realIdx}
              isBest={isBestAsk}
              price={ask.price}
              quantity={ask.quantity}
              widthPct={widthPct}
              barColor={downColor}
            />
          );
        })}

        {/* 中央: 現在値 */}
        <div className="col-span-3 my-1">
          <div
            className="px-2 py-1 text-center rounded"
            style={{
              background: isUp ? "rgba(255,59,107,0.1)" : "rgba(0,217,255,0.1)",
              border: `1px solid ${isUp ? "rgba(255,59,107,0.4)" : "rgba(0,217,255,0.4)"}`,
            }}
          >
            <span className="text-xs text-[var(--color-text-secondary)]" style={MONO}>現在 </span>
            <span className="text-lg font-bold" style={{ color: isUp ? upColor : downColor, ...MONO }}>
              ¥{quote.currentPrice?.toLocaleString()}
            </span>
            <span className="text-xs ml-2" style={{ color: isUp ? upColor : downColor, ...MONO }}>
              {isUp ? "▲" : "▼"}{Math.abs(quote.changeAbs ?? 0).toLocaleString()} ({(quote.changePct ?? 0) >= 0 ? "+" : ""}{quote.changePct?.toFixed(2)}%)
            </span>
          </div>
        </div>

        {/* 買 (上から最良→最深) */}
        {quote.bids.map((bid, idx) => {
          const realIdx = idx + 1;
          const widthPct = bid.quantity ? (bid.quantity / maxQty) * 100 : 0;
          const isBestBid = realIdx === 1;
          return (
            <BookRow
              key={`b${realIdx}`}
              side="bid"
              level={realIdx}
              isBest={isBestBid}
              price={bid.price}
              quantity={bid.quantity}
              widthPct={widthPct}
              barColor={upColor}
            />
          );
        })}
      </div>

      {/* 価格・出来高サマリー */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-[10px] pt-2 border-t border-[var(--color-border)]" style={MONO}>
        <Stat label="始値" value={quote.openPrice} />
        <Stat label="高値" value={quote.highPrice} color={upColor} />
        <Stat label="安値" value={quote.lowPrice} color={downColor} />
        <Stat label="VWAP" value={quote.vwap} digits={1} />
        <Stat label="出来高" value={quote.volume} format="vol" />
        <Stat label="売買代金" value={quote.turnover} format="money" />
      </div>

      {/* 板の温度計 (自動解説) */}
      {assessment && <CommentaryPanel title="板の温度計" c={assessment} />}
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function BookRow({
  side,
  level,
  isBest,
  price,
  quantity,
  widthPct,
  barColor,
}: {
  side: "ask" | "bid";
  level: number;
  isBest: boolean;
  price: number | null;
  quantity: number | null;
  widthPct: number;
  barColor: string;
}) {
  const isAsk = side === "ask";
  return (
    <>
      <div className="px-2 py-0.5 text-right relative" style={MONO}>
        {!isAsk && (
          <div
            className="absolute top-0 right-0 bottom-0 opacity-20"
            style={{ width: `${widthPct}%`, background: barColor }}
          />
        )}
        <span className="relative" style={{ color: isAsk ? "#ccc" : "var(--color-text)" }}>
          {isAsk ? "" : quantity?.toLocaleString() ?? "-"}
        </span>
      </div>
      <div
        className="text-center px-3 py-0.5"
        style={{
          color: isBest
            ? isAsk ? "#00d9ff" : "#ff3b6b"
            : "var(--color-text-secondary)",
          fontWeight: isBest ? 600 : 400,
          ...MONO,
        }}
      >
        {price?.toLocaleString() ?? "-"}
      </div>
      <div className="px-2 py-0.5 relative" style={MONO}>
        {isAsk && (
          <div
            className="absolute top-0 left-0 bottom-0 opacity-20"
            style={{ width: `${widthPct}%`, background: barColor }}
          />
        )}
        <span className="relative" style={{ color: isAsk ? "var(--color-text)" : "#ccc" }}>
          {isAsk ? quantity?.toLocaleString() ?? "-" : ""}
        </span>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  color,
  digits = 0,
  format,
}: {
  label: string;
  value: number | null;
  color?: string;
  digits?: number;
  format?: "vol" | "money";
}) {
  const fmt = (v: number) => {
    if (format === "money") {
      if (v >= 1e12) return `${(v / 1e12).toFixed(2)}兆`;
      if (v >= 1e8) return `${(v / 1e8).toFixed(1)}億`;
      if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
      return v.toLocaleString();
    }
    if (format === "vol") {
      if (v >= 1e6) return `${(v / 1e4).toFixed(0)}万`;
      return v.toLocaleString();
    }
    return v.toFixed(digits);
  };
  return (
    <div>
      <div className="text-[var(--color-text-secondary)]">{label}</div>
      <div style={{ color: color ?? "var(--color-text)" }}>
        {value !== null ? fmt(value) : "-"}
      </div>
    </div>
  );
}
