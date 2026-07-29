/**
 * 🏔 ネットキャッシュ比率スクリーナー (清原化学反応 ④)
 *
 * 清原達郎『わが投資術』の中核指標:
 *   ネットキャッシュ = 流動資産 + 投資有価証券×70% − 負債 (全部)
 *   NC比率 = ネットキャッシュ ÷ 時価総額
 *     → 1以上 = 会社を丸ごと買ってもお釣りが来る (時価総額 < 手元資産)
 *   実質PER = (時価総額 − ネットキャッシュ) ÷ 純利益
 *     → 事業そのものを何年分の利益で買えるか。キャッシュの山を除いた「素の値段」
 *
 * データ: Yahoo fundamentals-timeseries (年次BS) × ③時価総額基盤。
 * 「割安の測定」であり「上がる予測」ではない — 清原自身、割安だけでは動かない
 * (カタリスト/変化が要る) と言っている。FutureScore とのレースで検証する。
 */

export interface BalanceSheetSnapshot {
  ticker: string;
  asOfDate: string | null;          // BS の基準日 (年次)
  currentAssets: number | null;     // 流動資産 (円)
  investSecurities: number | null;  // 投資有価証券 (円)
  totalLiabilities: number | null;  // 負債合計 (円)
  netIncome: number | null;         // 純利益 (円, 年次)
}

export interface NetCashRow extends BalanceSheetSnapshot {
  date: string;              // スナップショット日
  market_cap: number | null; // 円 (③から)
  nc: number | null;         // ネットキャッシュ (円)
  nc_ratio: number | null;   // NC ÷ 時価総額
  real_per: number | null;   // 実質PER (純利益<=0 は null)
}

const TS_TYPES = [
  "annualCurrentAssets",
  "annualInvestmentinFinancialAssets",
  "annualTotalLiabilitiesNetMinorityInterest",
  "annualNetIncome",
].join(",");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Yahoo fundamentals-timeseries から年次BSの最新値を取得 (crumb 不要)。失敗はリトライ */
export async function fetchBalanceSheet(ticker: string, retries = 2): Promise<BalanceSheetSnapshot | null> {
  const p1 = Math.floor(Date.now() / 1000);
  const p0 = p1 - 2 * 365 * 86400;
  const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(
    `${ticker}.T`,
  )}?type=${TS_TYPES}&period1=${p0}&period2=${p1}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store" });
      if (res.status === 429 || res.status === 401) {
        if (attempt >= retries) return null;
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) return null;
      const j = await res.json();
      const out: BalanceSheetSnapshot = {
        ticker, asOfDate: null, currentAssets: null, investSecurities: null, totalLiabilities: null, netIncome: null,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const r of (j?.timeseries?.result ?? []) as any[]) {
        const type: string = r?.meta?.type?.[0] ?? "";
        const vals = (r?.[type] ?? []).filter(Boolean);
        const last = vals[vals.length - 1];
        const v: number | undefined = last?.reportedValue?.raw;
        if (typeof v !== "number") continue;
        if (last.asOfDate && (!out.asOfDate || last.asOfDate > out.asOfDate)) out.asOfDate = last.asOfDate;
        if (type === "annualCurrentAssets") out.currentAssets = v;
        else if (type === "annualInvestmentinFinancialAssets") out.investSecurities = v;
        else if (type === "annualTotalLiabilitiesNetMinorityInterest") out.totalLiabilities = v;
        else if (type === "annualNetIncome") out.netIncome = v;
      }
      // 最低限 流動資産と負債が無いと NC を計算できない
      if (out.currentAssets == null || out.totalLiabilities == null) return null;
      return out;
    } catch {
      if (attempt >= retries) return null;
      await sleep(1000 * (attempt + 1));
    }
  }
}

/** 清原式ネットキャッシュの計算 (市場データと合流して行を完成させる) */
export function computeNetCash(bs: BalanceSheetSnapshot, marketCap: number | null, date: string): NetCashRow {
  const nc =
    bs.currentAssets != null && bs.totalLiabilities != null
      ? bs.currentAssets + (bs.investSecurities ?? 0) * 0.7 - bs.totalLiabilities
      : null;
  const ncRatio = nc != null && marketCap != null && marketCap > 0 ? nc / marketCap : null;
  const realPer =
    nc != null && marketCap != null && bs.netIncome != null && bs.netIncome > 0
      ? (marketCap - nc) / bs.netIncome
      : null;
  return {
    ...bs,
    date,
    market_cap: marketCap,
    nc,
    nc_ratio: ncRatio == null ? null : Math.round(ncRatio * 1000) / 1000,
    real_per: realPer == null ? null : Math.round(realPer * 10) / 10,
  };
}

// ────────────────────────────────────────────
// 🏔 清原エンジン (レース用トラック "kiyohara")
//
// 既存🏔長期 (FutureScore) と同じ60日窓・同じ統制群方式で並走させ、
// どちらの長期エンジンに順位付けの価値があるかをデータで決める。
// ────────────────────────────────────────────

export interface ScreenerEntry {
  ticker: string;
  name: string;
  ncRatio: number | null;
  realPer: number | null;
  marketCapOku: number;
  ncOku: number;
  netIncomeOku: number | null;
  asOfDate: string | null;
}

/**
 * 清原ゲート: レースの「土俵」。
 *  - NC比率 0.5以上 (深い割安) / 3未満 (データ疑義除外)
 *  - 黒字 (実質PERが定義できる)
 *  - 時価総額30億以上 (最低限の流動性)
 *  - 決算データが15か月以内 (古いBSで測らない)
 */
export function kiyoharaGate(entries: ScreenerEntry[], excluded: Set<string>): ScreenerEntry[] {
  const staleCut = new Date(Date.now() - 15 * 30 * 86400 * 1000).toISOString().slice(0, 10);
  return entries.filter(
    (e) =>
      !excluded.has(e.ticker) &&
      e.ncRatio != null && e.ncRatio >= 0.5 && e.ncRatio < 3 &&
      e.netIncomeOku != null && e.netIncomeOku > 0 &&
      e.marketCapOku >= 30 &&
      e.asOfDate != null && e.asOfDate >= staleCut,
  );
}

/**
 * 清原ランキング: ゲート通過者を実質PER昇順 (事業の素の値段が安い順)。
 * 実質PERが負 (時価総額<NC) は最安として先頭。同点は NC比率降順。
 */
export function buildKiyoharaList(
  gate: ScreenerEntry[],
  n: number,
): { ticker: string; name: string; market: "JP"; price: null; score: number; reasons: string[]; caution: string | null }[] {
  const ranked = [...gate].sort((a, b) => {
    const pa = a.realPer ?? Infinity, pb = b.realPer ?? Infinity;
    if (pa !== pb) return pa - pb;
    return (b.ncRatio ?? 0) - (a.ncRatio ?? 0);
  });
  return ranked.slice(0, n).map((e) => ({
    ticker: e.ticker,
    name: e.name,
    market: "JP" as const,
    price: null,
    score: Math.min(100, Math.round((e.ncRatio ?? 0) * 60)),
    reasons: [
      `NC比率 ${e.ncRatio?.toFixed(2)} — 時価総額${e.marketCapOku.toLocaleString("ja-JP")}億のうち${e.ncOku.toLocaleString("ja-JP")}億がネットキャッシュ`,
      e.realPer != null && e.realPer < 0
        ? `実質PER ${e.realPer.toFixed(1)} — 時価総額がネットキャッシュより小さい (事業がマイナス値段)`
        : `実質PER ${e.realPer?.toFixed(1)}倍 — キャッシュを除いた事業の素の値段`,
    ],
    caution: "割安の測定であって上昇の予測ではない。動くにはカタリスト (変化) が要る",
  }));
}

export type NetCashTier = "fortress" | "deep" | "cheap" | "normal";

/** NC比率の段階 (清原の語彙に寄せた表現) */
export function netCashTier(ncRatio: number | null): NetCashTier | null {
  if (ncRatio == null) return null;
  if (ncRatio >= 1) return "fortress";   // 時価総額まるごとキャッシュで賄える
  if (ncRatio >= 0.5) return "deep";
  if (ncRatio >= 0.25) return "cheap";
  return "normal";
}

export const NET_CASH_TIER_META: Record<NetCashTier, { label: string; emoji: string; color: string; note: string }> = {
  fortress: {
    label: "時価総額<手元資産",
    emoji: "🏰",
    color: "#22c55e",
    note: "会社を丸ごと買うとタダでお釣りが来る水準。清原が「まず疑ってかかれ (なぜ放置されているのか)」と言いつつ主戦場にした領域。",
  },
  deep: {
    label: "深い割安",
    emoji: "💎",
    color: "#4ade80",
    note: "時価総額の半分以上がネットキャッシュ。下値は資産が支える。カタリスト (変化) があるかが勝負。",
  },
  cheap: {
    label: "資産割安",
    emoji: "🪙",
    color: "#a3e635",
    note: "時価総額の1/4以上がネットキャッシュ。実質PERで見ると見た目のPERよりかなり安い。",
  },
  normal: {
    label: "通常",
    emoji: "・",
    color: "#94a3b8",
    note: "資産面での特筆すべき割安はない。",
  },
};
