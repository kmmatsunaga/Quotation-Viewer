/**
 * 🏗 時価総額基盤 (清原化学反応 ③)
 *
 * 発行済株式数と時価総額を週次で全銘柄スナップショット。
 * これが入ると解禁されるもの:
 *   - ④ ネットキャッシュ比率 = (流動資産 + 投資有価証券×70% − 負債) ÷ 時価総額
 *   - 実質PER = (時価総額 − ネットキャッシュ) ÷ 純利益
 *   - 回転率 (売買代金 ÷ 時価総額) — 「小型株は土俵」の定量化
 *
 * 取得元は Yahoo v10 quoteSummary (price + defaultKeyStatistics)。
 * BQ cavka.market_cap (日付パーティション) + Firestore meta/market_cap_latest。
 */

import { yfQuoteSummary } from "@/lib/yahoo-finance";

export interface MarketCapRow {
  date: string;                     // YYYY-MM-DD (スナップショット日)
  ticker: string;
  market_cap: number | null;        // 円
  shares_outstanding: number | null;
  close: number | null;             // 取得時の株価 (整合チェック用)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 1銘柄の時価総額スナップショットを取得 (失敗時 null)。
 * Yahoo は連続アクセスでレート制限をかける (初回シードで2,400件以降が全滅した実績)
 * ため、null 応答はバックオフ付きで最大3回リトライする。
 */
export async function fetchMarketCapRow(ticker: string, date: string, retries = 3): Promise<MarketCapRow | null> {
  try {
    let r = await yfQuoteSummary(`${ticker}.T`, "price,defaultKeyStatistics");
    for (let i = 0; r == null && i < retries; i++) {
      await sleep(1500 * (i + 1));
      r = await yfQuoteSummary(`${ticker}.T`, "price,defaultKeyStatistics");
    }
    if (!r) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const price = r.price as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ks = r.defaultKeyStatistics as any;
    const marketCap: number | null = typeof price?.marketCap?.raw === "number" ? price.marketCap.raw : null;
    const shares: number | null = typeof ks?.sharesOutstanding?.raw === "number" ? ks.sharesOutstanding.raw : null;
    const close: number | null = typeof price?.regularMarketPrice?.raw === "number" ? price.regularMarketPrice.raw : null;
    if (marketCap == null && shares == null) return null;
    return {
      date,
      ticker,
      market_cap: marketCap ?? (shares != null && close != null ? Math.round(shares * close) : null),
      shares_outstanding: shares,
      close,
    };
  } catch {
    return null;
  }
}

/** Firestore meta/market_cap_latest 用: {ticker: 時価総額(億円, 小数1桁)} */
export function toCapsMap(rows: MarketCapRow[]): Record<string, number> {
  const caps: Record<string, number> = {};
  for (const r of rows) {
    if (r.market_cap != null && r.market_cap > 0) {
      caps[r.ticker] = Math.round(r.market_cap / 1e8 * 10) / 10;
    }
  }
  return caps;
}
