"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";

interface OrderBookLevel { price: number | null; quantity: number | null; }

export interface SnapshotQuote {
  ticker: string;
  currentPrice: number | null;
  priceTime: string | null;
  prevClose: number | null;
  changeAbs: number | null;
  changePct: number | null;
  openPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  vwap: number | null;
  volume: number | null;
  turnover: number | null;
  marketStatus: string | null;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  marketBidQty: number | null;
  marketAskQty: number | null;
}

export interface SnapshotMargin {
  margin: Record<string, unknown> | null;
  hibu: Record<string, unknown> | null;
  syoukin: Record<string, unknown> | null;
}

interface SnapshotData {
  quote: SnapshotQuote | null;
  margin: SnapshotMargin | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  refreshTick: number;
}

const Ctx = createContext<SnapshotData>({
  quote: null, margin: null, loading: true, error: null, refresh: () => {}, refreshTick: 0,
});

/**
 * 立花スナップショットプロバイダ
 * 板情報 + 信用残 を1つのリクエストで取得し、複数のパネルで共有。
 * これにより複数の同時ログインによるセッション衝突を防ぐ。
 */
export function TachibanaSnapshotProvider({ ticker, children }: { ticker: string; children: ReactNode }) {
  const [quote, setQuote] = useState<SnapshotQuote | null>(null);
  const [margin, setMargin] = useState<SnapshotMargin | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  useEffect(() => {
    // 日本株のみ
    if (!/^\d{3,4}[A-Z]?$/.test(ticker)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const { auth } = await import("@/lib/firebase");
        const token = await auth.currentUser?.getIdToken();
        if (!token) {
          setError("ログインが必要です");
          return;
        }
        const res = await fetch(`/api/tachibana/snapshot?tickers=${ticker}&include=quotes,margin`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await res.json();
        if (cancelled) return;
        if (json.ok) {
          setQuote(json.quotes?.[0] ?? null);
          setMargin(json.margin?.[ticker] ?? null);
        } else {
          setError(json.error ?? "取得失敗");
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [ticker, refreshTick]);

  return (
    <Ctx.Provider value={{ quote, margin, loading, error, refresh, refreshTick }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTachibanaSnapshot() {
  return useContext(Ctx);
}
