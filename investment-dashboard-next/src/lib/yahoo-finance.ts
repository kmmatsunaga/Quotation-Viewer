/**
 * Yahoo Finance API ヘルパー
 *
 * v10 quoteSummary 等は cookie + crumb 認証が必要になったため、
 * 一度取得して再利用する。crumb は 1時間程度有効。
 */

const YF_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json,text/plain,*/*",
  "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
};

interface CrumbCache {
  cookie: string;
  crumb: string;
  fetchedAt: number;
}

let cache: CrumbCache | null = null;
const CACHE_TTL = 30 * 60 * 1000; // 30分

async function fetchCrumb(): Promise<{ cookie: string; crumb: string } | null> {
  try {
    // 1. fc.yahoo.com で同意Cookie を取得 (米国以外でも有効)
    const consent = await fetch("https://fc.yahoo.com", {
      headers: YF_HEADERS,
      redirect: "manual",
    });
    const setCookie = consent.headers.get("set-cookie") ?? "";
    // A1 Cookie を抽出
    const cookieMatch = setCookie.match(/A3=[^;]+/);
    const cookie = cookieMatch ? cookieMatch[0] : "";

    if (!cookie) {
      // Try fallback: visit yahoo finance directly
      const directRes = await fetch("https://finance.yahoo.com/", {
        headers: YF_HEADERS,
        redirect: "manual",
      });
      const sc = directRes.headers.get("set-cookie") ?? "";
      const m = sc.match(/[AB]3=[^;]+/);
      if (m) {
        return { cookie: m[0], crumb: "" }; // crumbなしでも試す
      }
    }

    // 2. crumb 取得
    const crumbRes = await fetch(
      "https://query2.finance.yahoo.com/v1/test/getcrumb",
      {
        headers: { ...YF_HEADERS, Cookie: cookie },
      }
    );
    const crumb = (await crumbRes.text()).trim();

    if (crumb && !crumb.includes("Unauthorized")) {
      return { cookie, crumb };
    }
    return null;
  } catch (err) {
    console.error("Yahoo Finance crumb fetch error:", err);
    return null;
  }
}

async function getCrumbCache(): Promise<{ cookie: string; crumb: string } | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) {
    return { cookie: cache.cookie, crumb: cache.crumb };
  }
  const fresh = await fetchCrumb();
  if (fresh) {
    cache = { ...fresh, fetchedAt: Date.now() };
  }
  return fresh;
}

/**
 * Yahoo Finance v10 quoteSummary を crumb 付きで叩く。
 * @param yfTicker - Yahoo Finance 形式のティッカー (例: "7203.T", "AAPL")
 * @param modules - カンマ区切りモジュール名
 */
export async function yfQuoteSummary(
  yfTicker: string,
  modules: string
): Promise<Record<string, unknown> | null> {
  const auth = await getCrumbCache();
  const params = new URLSearchParams({ modules });
  if (auth?.crumb) params.set("crumb", auth.crumb);

  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
    yfTicker
  )}?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      ...YF_HEADERS,
      ...(auth?.cookie ? { Cookie: auth.cookie } : {}),
    },
    next: { revalidate: 300 },
  });

  if (!res.ok) {
    // 401/403 ならキャッシュ破棄してリトライ1回
    if ((res.status === 401 || res.status === 403) && cache) {
      cache = null;
      return yfQuoteSummary(yfTicker, modules);
    }
    return null;
  }

  const json = await res.json();
  return json.quoteSummary?.result?.[0] ?? null;
}
