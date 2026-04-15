const BASE_URL = "/api";

export async function fetcher<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15秒タイムアウト
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      throw new Error(`API error: ${res.status} ${res.statusText}`);
    }
    return res.json();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

function buildUrl(path: string, params?: Record<string, string>): string {
  const url = new URL(`${BASE_URL}${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }
  return url.toString();
}

// --- Index / Market Data ---

export interface IndexCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface IndexData {
  name: string;
  value: number;
  change: number;
  change_pct: number;
  chart_data?: number[];
  candles?: IndexCandle[];
}

export function fetchIndicesUrl(): string {
  return `${BASE_URL}/indices`;
}

export function fetchIndexBarUrl(symbol: string, timeframe: string): string {
  return buildUrl(`/index-bar/${symbol}`, { timeframe });
}

// --- Stocks ---

export interface StockData {
  code: string;
  name: string;
  price: number;
  change: number;
  change_pct: number;
  volume?: number;
}

export function fetchJPStocksUrl(): string {
  return `${BASE_URL}/stocks/jp`;
}

export function fetchUSStocksUrl(): string {
  return `${BASE_URL}/stocks/us`;
}

// --- News ---

export interface NewsItem {
  title: string;
  url: string;
  publisher: string;
  published_at: string;
  thumbnail?: string;
}

export function fetchMarketNewsUrl(): string {
  return `${BASE_URL}/news/market`;
}

export function fetchPortfolioNewsUrl(): string {
  return `${BASE_URL}/news/portfolio`;
}

// --- Favorites ---

export interface FavoriteStock {
  code: string;
  name: string;
  price: number;
  change: number;
  change_pct: number;
  score?: number;
  chart_data?: number[];
}

export function fetchFavoritesUrl(): string {
  return `${BASE_URL}/favorites`;
}

// --- Portfolio ---

export interface Holding {
  id: number;
  code: string;
  name: string;
  quantity: number;
  avg_cost: number;
  current_price: number;
  pnl: number;
  pnl_pct: number;
}

export interface PortfolioSummary {
  total_value: number;
  total_pnl: number;
  total_pnl_pct: number;
  holdings: Holding[];
}

export function fetchHoldingsUrl(): string {
  return `${BASE_URL}/portfolio/holdings`;
}

export async function addHolding(data: {
  code: string;
  name: string;
  quantity: number;
  avg_cost: number;
}): Promise<Holding> {
  const res = await fetch(`${BASE_URL}/portfolio/holdings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to add holding");
  return res.json();
}

export async function updateHolding(
  id: number,
  data: Partial<Holding>
): Promise<Holding> {
  const res = await fetch(`${BASE_URL}/portfolio/holdings/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update holding");
  return res.json();
}

export async function deleteHolding(id: number): Promise<void> {
  const res = await fetch(`${BASE_URL}/portfolio/holdings/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete holding");
}

// --- Alerts ---

export interface PriceAlert {
  id: number;
  code: string;
  name: string;
  target_price: number;
  direction: "above" | "below";
  current_price: number;
  triggered: boolean;
  created_at: string;
}

export function fetchAlertsUrl(): string {
  return `${BASE_URL}/alerts`;
}

export async function addAlert(data: {
  code: string;
  name: string;
  target_price: number;
  direction: "above" | "below";
}): Promise<PriceAlert> {
  const res = await fetch(`${BASE_URL}/alerts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to add alert");
  return res.json();
}

export async function deleteAlert(id: number): Promise<void> {
  const res = await fetch(`${BASE_URL}/alerts/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete alert");
}

export async function checkAlerts(): Promise<PriceAlert[]> {
  const res = await fetch(`${BASE_URL}/alerts/check`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to check alerts");
  return res.json();
}

// --- Analysis ---

export interface AnalysisResult {
  code: string;
  name: string;
  price: number;
  change_pct: number;
  indicators: {
    rsi: number;
    macd: number;
    signal: number;
    bb_upper: number;
    bb_lower: number;
    sma_20: number;
    sma_50: number;
  };
  score: number;
  recommendation: string;
  candles: {
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[];
}

export function fetchAnalysisUrl(code: string): string {
  return `${BASE_URL}/analysis/${code}`;
}
