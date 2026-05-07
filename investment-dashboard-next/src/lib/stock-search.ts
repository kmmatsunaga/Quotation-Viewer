/**
 * 銘柄検索モジュール
 *
 * ハイブリッド方式:
 *   1. ローカル静的リスト（日本語名で即時検索）
 *   2. Yahoo Finance API（番号・英語名でリモート検索）
 * 将来的に立花証券 API 等に差し替え可能な設計。
 */

import { searchStocks } from "./stock-list";

export interface StockSearchResult {
  ticker: string;
  name: string;
  market: "JP" | "US" | string;
  exchange?: string;
  type?: string; // EQUITY, ETF, etc.
}

/**
 * Yahoo Finance API 経由でリモート検索
 */
async function searchRemote(
  keyword: string
): Promise<StockSearchResult[]> {
  try {
    const res = await fetch(
      `/api/stocks/search?q=${encodeURIComponent(keyword.trim())}`
    );
    if (!res.ok) return [];
    return await res.json();
  } catch {
    console.error("Remote stock search failed");
    return [];
  }
}

/**
 * ハイブリッド検索:
 *  - ローカルリスト（日本語名対応、即時）
 *  - Yahoo Finance API（番号・英語名対応、非同期）
 * 両方の結果をマージし、重複を除去して返す
 */
export async function searchStocksAPI(
  keyword: string
): Promise<StockSearchResult[]> {
  if (!keyword.trim()) return [];

  // ローカル検索（即時）
  const localResults: StockSearchResult[] = searchStocks(keyword, 5).map(
    (s) => ({
      ticker: s.ticker,
      name: s.name,
      market: s.market,
      exchange: s.market === "JP" ? "JPX" : "",
    })
  );

  // リモート検索（非同期）
  const remoteResults = await searchRemote(keyword);

  // マージ（ローカル優先、重複除去）
  const seen = new Set(localResults.map((r) => r.ticker));
  const merged = [...localResults];
  for (const r of remoteResults) {
    if (!seen.has(r.ticker)) {
      seen.add(r.ticker);
      merged.push(r);
    }
  }

  return merged.slice(0, 10);
}
