import { NextRequest, NextResponse } from "next/server";
import { NIKKEI225 } from "@/lib/nikkei225";

/**
 * 株式検索 API
 * GET /api/stocks/search?q=フジクラ
 *
 * 戦略:
 *  1. Yahoo Finance v1 検索を試行
 *  2. 日本語クエリは Yahoo に弾かれることが多いので、
 *     内部の日経225 + 主要銘柄リストで部分一致フォールバック
 *  3. ヒットした銘柄は Yahoo Finance で詳細を取得して返す
 */

const YF_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

interface SearchResult {
  ticker: string;
  name: string;
  market: string;
  exchange: string;
  type: string;
}

// 日本語クエリかどうかを判定
function containsJapanese(s: string): boolean {
  return /[぀-ヿ一-鿿＀-￯]/.test(s);
}

// Yahoo Finance 検索API呼び出し
async function yahooSearch(q: string): Promise<SearchResult[]> {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
    q
  )}&lang=ja&region=JP&quotesCount=10&newsCount=0&listsCount=0&enableFuzzyQuery=false&quotesQueryId=tss_match_phrase_query`;

  const res = await fetch(url, {
    headers: YF_HEADERS,
    next: { revalidate: 300 },
  });

  if (!res.ok) return [];

  const data = await res.json();
  if (data.finance?.error) return [];

  const allowedTypes = new Set(["EQUITY", "ETF", "MUTUALFUND"]);
  return (data.quotes ?? [])
    .filter(
      (q: Record<string, unknown>) =>
        allowedTypes.has(String(q.quoteType ?? ""))
    )
    .map((q: Record<string, unknown>) => {
      const symbol = String(q.symbol ?? "");
      const isJP = symbol.endsWith(".T");
      const quoteType = String(q.quoteType ?? "");
      return {
        ticker: isJP ? symbol.replace(".T", "") : symbol,
        name: String(q.shortname ?? q.longname ?? symbol),
        market: isJP ? "JP" : "US",
        exchange: String(q.exchange ?? ""),
        type: quoteType,
      };
    });
}

// 内部リストで日本語名・ティッカー部分一致検索
function searchInternalList(q: string): { ticker: string; name: string }[] {
  const lower = q.toLowerCase();
  return NIKKEI225.filter(
    (s) =>
      s.name.toLowerCase().includes(lower) ||
      s.ticker.toLowerCase().includes(lower)
  ).slice(0, 10);
}

// Yahoo Finance Japan のサイトをスクレイピングして検索（日本語クエリ対応）
async function yahooFinanceJapanSearch(
  q: string
): Promise<{ ticker: string; name: string }[]> {
  try {
    const url = `https://finance.yahoo.co.jp/search/?query=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
      next: { revalidate: 600 },
    });
    if (!res.ok) return [];
    const html = await res.text();

    // 銘柄コードを抽出（4桁数字または数字+英字、最近の上場で5桁になりつつあるので考慮）
    const codePattern =
      /\/stocks\/detail\?code=([0-9]{3,4}[A-Z]?)[^"]*"[^>]*>([^<]+)</g;
    const found: { ticker: string; name: string }[] = [];
    const seen = new Set<string>();

    let match;
    while ((match = codePattern.exec(html)) !== null) {
      const ticker = match[1];
      const name = match[2].trim();
      if (!seen.has(ticker) && name && !name.match(/^[0-9]/)) {
        seen.add(ticker);
        found.push({ ticker, name });
        if (found.length >= 10) break;
      }
    }

    // バックアップ: コードだけ抽出して名前は別途取得
    if (found.length === 0) {
      const simpleCodePattern = /code=([0-9]{3,4}[A-Z]?)/g;
      const codes = new Set<string>();
      while ((match = simpleCodePattern.exec(html)) !== null) {
        codes.add(match[1]);
        if (codes.size >= 5) break;
      }
      for (const ticker of codes) {
        found.push({ ticker, name: `銘柄コード ${ticker}` });
      }
    }

    return found;
  } catch {
    return [];
  }
}

// ティッカー → Yahoo Finance quote 情報取得
async function fetchYahooDetails(ticker: string): Promise<SearchResult | null> {
  try {
    const yfTicker = `${ticker}.T`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      yfTicker
    )}?range=1d&interval=1d`;
    const res = await fetch(url, {
      headers: YF_HEADERS,
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const meta = json.chart?.result?.[0]?.meta;
    if (!meta) return null;
    return {
      ticker,
      name: meta.shortName ?? meta.longName ?? ticker,
      market: "JP",
      exchange: meta.exchangeName ?? "JPX",
      type: "EQUITY",
    };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) {
    return NextResponse.json([]);
  }

  try {
    // 1. Yahoo Finance を試行
    let results = await yahooSearch(q);

    // 2. 日本語クエリで Yahoo が結果を返さなかった場合、フォールバック
    if (results.length === 0 && containsJapanese(q)) {
      // 2a. 日経225 内部リストで部分一致
      const internalMatches = searchInternalList(q);
      if (internalMatches.length > 0) {
        results = internalMatches.map((m) => ({
          ticker: m.ticker,
          name: m.name,
          market: "JP",
          exchange: "JPX",
          type: "EQUITY",
        }));
      }

      // 2b. それでもダメなら Yahoo Finance Japan サイトをスクレイピング
      if (results.length === 0) {
        const yfjResults = await yahooFinanceJapanSearch(q);
        if (yfjResults.length > 0) {
          // 名前が「銘柄コード XXX」のものは Yahoo Finance で詳細補完
          results = await Promise.all(
            yfjResults.map(async (m) => {
              if (m.name.startsWith("銘柄コード")) {
                const detail = await fetchYahooDetails(m.ticker);
                if (detail) return detail;
              }
              return {
                ticker: m.ticker,
                name: m.name,
                market: "JP",
                exchange: "JPX",
                type: "EQUITY",
              };
            })
          );
        }
      }
    }

    return NextResponse.json(results);
  } catch (err) {
    console.error("Stock search error:", err);
    return NextResponse.json([]);
  }
}
