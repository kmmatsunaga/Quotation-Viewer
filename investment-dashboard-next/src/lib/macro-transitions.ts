/**
 * マクロ状態遷移の検知 (macro-alerts cron と briefing API の共用)
 *
 * 前日 → 今日のマクロスナップショットを比較し、
 * jp-themes の macroDriver ID と対応する遷移イベントを返す。
 */

export interface MacroSnapshot {
  fedPolicy: { probRateCut: number; probRateHold: number; probRateHike: number };
  recession: { probRecession12m: number; isInverted: boolean; sahmRuleTriggered: boolean };
  fx: { usdJpy: number | null; near155: boolean };
  oil: { direction: "up" | "down" | "sideways"; highPrice: boolean; lowPrice: boolean };
  china: { demandLabel: "expansion" | "neutral" | "contraction" };
  semi: { cycleStage: "boom" | "expansion" | "peak" | "contraction" | "trough" | "neutral" };
  bojPolicy: { probRateCut: number; probRateHold: number; probRateHike: number };
}

export interface Transition {
  driver: string;
  direction: "activated" | "deactivated" | "intensified" | "weakened";
  emoji: string;
  message: string;
}

export function dominantDirection(cut: number, hold: number, hike: number): "cut" | "hold" | "hike" {
  const m = Math.max(cut, hold, hike);
  if (m === cut) return "cut";
  if (m === hike) return "hike";
  return "hold";
}

export function labelDir(d: "cut" | "hold" | "hike"): string {
  return d === "cut" ? "緩和/利下げ寄り" : d === "hike" ? "利上げ寄り" : "据置寄り";
}

export function detectTransitions(y: Partial<MacroSnapshot> | null, t: MacroSnapshot): Transition[] {
  const transitions: Transition[] = [];
  if (!y) return transitions; // 初回は遷移なし扱い

  // FRB 政策方向
  const fedDirToday = dominantDirection(t.fedPolicy.probRateCut, t.fedPolicy.probRateHold, t.fedPolicy.probRateHike);
  const fedDirY = y.fedPolicy ? dominantDirection(y.fedPolicy.probRateCut, y.fedPolicy.probRateHold, y.fedPolicy.probRateHike) : null;
  if (fedDirY && fedDirY !== fedDirToday) {
    if (fedDirToday === "cut") {
      transitions.push({
        driver: "fed_cut", direction: "activated", emoji: "🇺🇸",
        message: `FRB 政策方向が「${labelDir(fedDirY)}」→「利下げ寄り」に転換 (cut ${t.fedPolicy.probRateCut}%)`,
      });
    } else if (fedDirToday === "hike") {
      transitions.push({
        driver: "fed_hike", direction: "activated", emoji: "🇺🇸",
        message: `FRB 政策方向が「${labelDir(fedDirY)}」→「利上げ寄り」に転換 (hike ${t.fedPolicy.probRateHike}%)`,
      });
    }
  }

  // BOJ 政策方向
  const bojDirToday = dominantDirection(t.bojPolicy.probRateCut, t.bojPolicy.probRateHold, t.bojPolicy.probRateHike);
  const bojDirY = y.bojPolicy ? dominantDirection(y.bojPolicy.probRateCut, y.bojPolicy.probRateHold, y.bojPolicy.probRateHike) : null;
  if (bojDirY && bojDirY !== bojDirToday) {
    if (bojDirToday === "hike") {
      transitions.push({
        driver: "boj_hike", direction: "activated", emoji: "🇯🇵",
        message: `BOJ 政策方向が「${labelDir(bojDirY)}」→「利上げ寄り」に転換 (hike ${t.bojPolicy.probRateHike}%)`,
      });
    } else if (bojDirToday === "cut") {
      transitions.push({
        driver: "boj_dovish", direction: "activated", emoji: "🇯🇵",
        message: `BOJ 政策方向が「${labelDir(bojDirY)}」→「緩和寄り」に転換 (cut ${t.bojPolicy.probRateCut}%)`,
      });
    }
  }

  // 中国デマンド
  if (y.china && y.china.demandLabel !== t.china.demandLabel) {
    if (t.china.demandLabel === "expansion") {
      transitions.push({
        driver: "china_demand", direction: "activated", emoji: "🇨🇳",
        message: `中国デマンドが「${y.china.demandLabel}」→「expansion」に転換`,
      });
    } else if (y.china.demandLabel === "expansion") {
      transitions.push({
        driver: "china_demand", direction: "deactivated", emoji: "🇨🇳",
        message: `中国デマンドが「expansion」→「${t.china.demandLabel}」に後退`,
      });
    }
  }

  // 原油
  if (y.oil && y.oil.direction !== t.oil.direction) {
    if (t.oil.direction === "up" || t.oil.highPrice) {
      transitions.push({
        driver: "oil_high", direction: "activated", emoji: "🛢",
        message: `原油トレンドが「${y.oil.direction}」→「up」に転換${t.oil.highPrice ? " (高値圏)" : ""}`,
      });
    } else if (t.oil.direction === "down" || t.oil.lowPrice) {
      transitions.push({
        driver: "oil_low", direction: "activated", emoji: "🛢",
        message: `原油トレンドが「${y.oil.direction}」→「down」に転換${t.oil.lowPrice ? " (安値圏)" : ""}`,
      });
    }
  }

  // 為替 (USD/JPY の 155 しきい超え)
  if (y.fx && y.fx.usdJpy !== null && y.fx.usdJpy !== undefined && t.fx.usdJpy !== null) {
    if (y.fx.usdJpy < 155 && t.fx.usdJpy >= 155) {
      transitions.push({
        driver: "fx_weak_yen", direction: "intensified", emoji: "💴",
        message: `USD/JPY が 155 を上抜け (${t.fx.usdJpy.toFixed(1)}円) — 介入警戒域`,
      });
    } else if (y.fx.usdJpy >= 155 && t.fx.usdJpy < 155) {
      transitions.push({
        driver: "fx_weak_yen", direction: "weakened", emoji: "💴",
        message: `USD/JPY が 155 を下抜け (${t.fx.usdJpy.toFixed(1)}円)`,
      });
    }
  }

  // 半導体サイクル
  if (y.semi && y.semi.cycleStage !== t.semi.cycleStage) {
    const bullish = ["boom", "expansion"];
    const bearish = ["peak", "contraction"];
    if (bullish.includes(t.semi.cycleStage) && !bullish.includes(y.semi.cycleStage)) {
      transitions.push({
        driver: "semi_cycle_up", direction: "activated", emoji: "🔬",
        message: `半導体サイクルが「${y.semi.cycleStage}」→「${t.semi.cycleStage}」に好転`,
      });
    } else if (bearish.includes(t.semi.cycleStage) && bullish.includes(y.semi.cycleStage)) {
      transitions.push({
        driver: "semi_cycle_up", direction: "deactivated", emoji: "🔬",
        message: `半導体サイクルが「${y.semi.cycleStage}」→「${t.semi.cycleStage}」に転換 — ピーク懸念`,
      });
    }
  }

  // 景気後退 (30% しきい跨ぎ)
  if (y.recession && y.recession.probRecession12m !== undefined) {
    const yLow = y.recession.probRecession12m < 30;
    const tLow = t.recession.probRecession12m < 30;
    if (yLow && !tLow) {
      transitions.push({
        driver: "recession_low", direction: "deactivated", emoji: "📉",
        message: `米景気後退確率が ${y.recession.probRecession12m}% → ${t.recession.probRecession12m}% に上昇 (拡大シナリオ後退)`,
      });
    } else if (!yLow && tLow) {
      transitions.push({
        driver: "recession_low", direction: "activated", emoji: "📈",
        message: `米景気後退確率が ${y.recession.probRecession12m}% → ${t.recession.probRecession12m}% に低下 (拡大シナリオ復活)`,
      });
    }
  }

  return transitions;
}
