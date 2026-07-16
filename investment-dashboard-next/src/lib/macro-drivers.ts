/**
 * macroDriver の「現在アクティブ (追い風) か」判定。
 * verdict-witnesses / PortfolioIntel / MasterScorePanel で共用。
 *
 * mw = /api/macro/fred-watch のレスポンス
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isDriverActive(d: string, mw: any): boolean {
  if (!mw) return false;
  return (
    (d === "fed_cut" && mw.fedPolicy?.probRateCut >= 35) ||
    (d === "fed_hike" && mw.fedPolicy?.probRateHike >= 40) ||
    (d === "boj_hike" && (mw.bojPolicy?.probRateHike ?? 0) >= 35) ||
    (d === "boj_dovish" && (mw.bojPolicy?.probRateCut ?? 0) >= 30) ||
    (d === "recession_low" && mw.recession?.probRecession12m < 30) ||
    (d === "fx_weak_yen" && ((mw.fx?.changeFrom30d ?? 0) >= 1 || (mw.fx?.usdJpy ?? 0) >= 148)) ||
    (d === "fx_strong_yen" && (mw.fx?.changeFrom30d ?? 0) <= -1) ||
    (d === "oil_high" && (mw.oil?.highPrice || mw.oil?.direction === "up")) ||
    (d === "oil_low" && (mw.oil?.lowPrice || mw.oil?.direction === "down")) ||
    (d === "china_demand" && mw.china?.demandLabel === "expansion") ||
    (d === "inbound" && (mw.fx?.usdJpy ?? 0) >= 145) ||
    (d === "consumer_strong" && mw.recession?.probRecession12m < 30) ||
    (d === "semi_cycle_up" && (mw.semi?.cycleStage === "boom" || mw.semi?.cycleStage === "expansion"))
  );
}
