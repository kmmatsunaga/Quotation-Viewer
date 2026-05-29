/**
 * 超短期 (当日中) シグナル評価エンジン
 *
 * 想定ユースケース:
 *   寄付後の急変 (急落 / 急騰) のうち、ファンダ要因の薄い「一時的乖離」を見つけて
 *   リバウンド狙い / 利食い検討の銘柄を浮き上がらせる。
 *
 * 入力:
 *   - 立花 getMarketQuotes から取れる現値・前日比・VWAP・板情報
 *   - セクター平均値動き (代乗り判定用、提供できれば)
 *   - 指数値動き (相場全体との比較用)
 *   - 直近ニュース有無
 *
 * 出力:
 *   - リバウンド候補度 (急落+ファンダ薄+板良好)
 *   - 反落警告度 (急騰+過熱+板悪化)
 *   - 代乗り判定 (セクター連動かどうか)
 *   - 寄付パターン (寄り天 / 寄り底)
 *   - 総合シグナル ("buy_rebound" / "sell_overheat" / "hold_news_active" / "wait" / "avoid")
 */

export interface IntradayInput {
  ticker: string;
  // 価格
  currentPrice: number | null;
  prevClose: number | null;
  open: number | null;          // 始値
  dayHigh: number | null;
  dayLow: number | null;
  changePct: number | null;     // 前日比%
  vwap: number | null;
  // 出来高
  volume: number | null;
  avgVolume20d?: number | null;
  // 板情報 (10段合計でOK)
  bidVolume?: number | null;    // 買い気配総数量
  askVolume?: number | null;    // 売り気配総数量
  // セクター (代乗り判定)
  sector?: string | null;
  sectorChangePct?: number | null;
  // 指数 (日経 or S&P)
  marketChangePct?: number | null;
  // 直近ニュース有無
  hasRecentNews?: boolean;
  newsHoursAgo?: number | null;
}

export type IntradaySignalDirection = "bullish" | "bearish" | "neutral";

export interface IntradaySignal {
  source: string;
  direction: IntradaySignalDirection;
  weight: number;       // 1-10
  message: string;
}

export type MorningPattern =
  | "morning_top"     // 寄り天: 寄付高値→現在値下落
  | "morning_bottom"  // 寄り底: 寄付安値→現在値上昇
  | "trending_up"     // 順調に上昇
  | "trending_down"   // 順調に下落
  | "flat"            // 横ばい
  | "unknown";

export type OverallSignal =
  | "buy_rebound"        // 🟢 リバウンド狙い: 急落+ファンダ薄+反発材料
  | "sell_overheat"      // 🔥 過熱反落警戒: 急騰+過熱+押し材料
  | "hold_news_active"   // 📰 材料反応中: ニュースで動き中、追従検討
  | "wait"               // 🟡 様子見: 明確シグナルなし
  | "avoid";             // ⚠ 触らず: 不明瞭な動き

export interface UltraShortInsight {
  ticker: string;
  reboundScore: number;        // 0-100: リバウンド狙いやすさ
  plungeScore: number;         // 0-100: 反落警戒度
  newsReactionScore: number;   // 0-100: ニュース反応度
  sympathy: { detected: boolean; direction: "up" | "down" | null; reason: string };
  morningPattern: MorningPattern;
  overallSignal: OverallSignal;
  overallScore: number;        // 0-100: 総合の「動く可能性」
  signals: IntradaySignal[];
  summary: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ヘルパ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** VWAP からの乖離 % */
function vwapDeviationPct(d: IntradayInput): number | null {
  if (!d.currentPrice || !d.vwap || d.vwap <= 0) return null;
  return ((d.currentPrice - d.vwap) / d.vwap) * 100;
}

/** 板情報の買い偏り % (50% が中立、>50% で買い優勢) */
function bidPct(d: IntradayInput): number | null {
  if (d.bidVolume == null || d.askVolume == null) return null;
  const total = d.bidVolume + d.askVolume;
  if (total <= 0) return null;
  return (d.bidVolume / total) * 100;
}

/** 出来高倍率 (avgVolume20d があれば、なければ null) */
function volumeRatio(d: IntradayInput): number | null {
  if (d.volume == null || !d.avgVolume20d || d.avgVolume20d <= 0) return null;
  return d.volume / d.avgVolume20d;
}

/** 始値から現在値までの動き % */
function fromOpenPct(d: IntradayInput): number | null {
  if (!d.currentPrice || !d.open || d.open <= 0) return null;
  return ((d.currentPrice - d.open) / d.open) * 100;
}

/** 高値からの押し % (負の値) */
function pullbackFromHighPct(d: IntradayInput): number | null {
  if (!d.currentPrice || !d.dayHigh || d.dayHigh <= 0) return null;
  return ((d.currentPrice - d.dayHigh) / d.dayHigh) * 100;
}

/** 安値からの戻し % (正の値) */
function bounceFromLowPct(d: IntradayInput): number | null {
  if (!d.currentPrice || !d.dayLow || d.dayLow <= 0) return null;
  return ((d.currentPrice - d.dayLow) / d.dayLow) * 100;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 代乗り判定 (Sympathy Move)
//   セクター/指数連動なら sympathy あり = 「一時的、戻りやすい」
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function detectSympathy(d: IntradayInput): UltraShortInsight["sympathy"] {
  const ch = d.changePct;
  if (ch == null) return { detected: false, direction: null, reason: "" };
  const sectorCh = d.sectorChangePct;
  const marketCh = d.marketChangePct;

  // セクターと同方向で、自分の変動 ≤ セクターの 1.5倍 なら sympathy
  if (sectorCh !== null && sectorCh !== undefined) {
    if (ch < -1 && sectorCh < -0.5 && ch / sectorCh > 0.4 && ch / sectorCh < 3) {
      return {
        detected: true,
        direction: "down",
        reason: `自分 ${ch.toFixed(1)}% vs セクター ${sectorCh.toFixed(1)}% (連動下落)`,
      };
    }
    if (ch > 1 && sectorCh > 0.5 && ch / sectorCh > 0.4 && ch / sectorCh < 3) {
      return {
        detected: true,
        direction: "up",
        reason: `自分 +${ch.toFixed(1)}% vs セクター +${sectorCh.toFixed(1)}% (連動上昇)`,
      };
    }
  }
  // 市場全体との連動
  if (marketCh !== null && marketCh !== undefined) {
    if (ch < -1 && marketCh < -0.5 && ch / marketCh > 0.4 && ch / marketCh < 3) {
      return {
        detected: true,
        direction: "down",
        reason: `相場全体も ${marketCh.toFixed(1)}% (相場連動)`,
      };
    }
  }
  return { detected: false, direction: null, reason: "" };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 寄付パターン判定
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function detectMorningPattern(d: IntradayInput): MorningPattern {
  if (!d.currentPrice || !d.open || !d.dayHigh || !d.dayLow) return "unknown";
  const fromHigh = pullbackFromHighPct(d) ?? 0;       // 負の値
  const fromLow = bounceFromLowPct(d) ?? 0;            // 正の値
  const fromOpen = fromOpenPct(d) ?? 0;
  // 寄り天: 始値 ≒ 高値、現在値が高値から -1% 以上下
  if (Math.abs(d.dayHigh - d.open) / d.open < 0.003 && fromHigh < -1) {
    return "morning_top";
  }
  // 寄り底: 始値 ≒ 安値、現在値が安値から +1% 以上上
  if (Math.abs(d.dayLow - d.open) / d.open < 0.003 && fromLow > 1) {
    return "morning_bottom";
  }
  // トレンド
  if (fromOpen > 1.5) return "trending_up";
  if (fromOpen < -1.5) return "trending_down";
  return "flat";
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// シグナル: リバウンド候補度
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function evaluateRebound(d: IntradayInput, sympathy: UltraShortInsight["sympathy"]): {
  score: number;
  signals: IntradaySignal[];
} {
  const signals: IntradaySignal[] = [];
  let s = 0;
  const ch = d.changePct;
  if (ch == null) return { score: 0, signals };

  // 1. 急落していること (リバウンドの前提)
  if (ch <= -3) {
    s += 25;
    signals.push({ source: "前日比", direction: "bullish", weight: 8, message: `急落 ${ch.toFixed(1)}% → 反発期待` });
  } else if (ch <= -2) {
    s += 15;
    signals.push({ source: "前日比", direction: "bullish", weight: 5, message: `下落 ${ch.toFixed(1)}%` });
  } else if (ch <= -1) {
    s += 5;
  } else {
    // 下落していないとリバウンド対象ではない
    return { score: 0, signals: [] };
  }

  // 2. VWAP より下 (売られ過ぎ)
  const dev = vwapDeviationPct(d);
  if (dev !== null) {
    if (dev <= -1.5) {
      s += 15;
      signals.push({ source: "VWAP", direction: "bullish", weight: 6, message: `VWAP より ${dev.toFixed(1)}% 下 (売られ過ぎ)` });
    } else if (dev <= -0.5) {
      s += 8;
    }
  }

  // 3. 板情報 (買い優勢なら強い)
  const bidP = bidPct(d);
  if (bidP !== null) {
    if (bidP >= 65) {
      s += 18;
      signals.push({ source: "板情報", direction: "bullish", weight: 7, message: `買い厚み ${bidP.toFixed(0)}% (買い圧強い)` });
    } else if (bidP >= 55) {
      s += 8;
      signals.push({ source: "板情報", direction: "bullish", weight: 4, message: `買い厚み ${bidP.toFixed(0)}%` });
    } else if (bidP <= 35) {
      s -= 15;
      signals.push({ source: "板情報", direction: "bearish", weight: 5, message: `売り厚み ${(100-bidP).toFixed(0)}% (まだ売り圧優勢)` });
    }
  }

  // 4. 代乗り判定: セクター連動下落なら戻りやすい
  if (sympathy.detected && sympathy.direction === "down") {
    s += 12;
    signals.push({ source: "代乗り", direction: "bullish", weight: 6, message: `🌊 ${sympathy.reason} → 連れ安戻し期待` });
  }

  // 5. 安値からの戻り (底打ち兆候)
  const bounce = bounceFromLowPct(d);
  if (bounce !== null && bounce >= 0.5) {
    s += 10;
    signals.push({ source: "安値戻し", direction: "bullish", weight: 5, message: `安値から +${bounce.toFixed(1)}% 戻し中` });
  }

  // 6. 出来高 (パニック売り終焉のサイン)
  const volR = volumeRatio(d);
  if (volR !== null) {
    if (volR >= 3) {
      // 出来高大 + 安値戻り → セリングクライマックス候補
      if (bounce !== null && bounce >= 1) {
        s += 12;
        signals.push({ source: "出来高", direction: "bullish", weight: 6, message: `出来高×${volR.toFixed(1)} + 戻り → クライマックス候補` });
      } else {
        s -= 5;
        signals.push({ source: "出来高", direction: "bearish", weight: 3, message: `出来高×${volR.toFixed(1)} だがまだ底打ち未確認` });
      }
    } else if (volR >= 1 && volR < 2) {
      // 程よい商い、パニックではない
      s += 5;
    }
  }

  // 7. ニュース無し → 個別材料ない単なる連れ安 = 戻りやすい
  if (d.hasRecentNews === false) {
    s += 8;
    signals.push({ source: "材料", direction: "bullish", weight: 4, message: "🟢 直近ニュース無 (個別材料無く下落 = 戻し候補)" });
  } else if (d.hasRecentNews === true) {
    // ネガニュースなら危険
    s -= 8;
    signals.push({ source: "材料", direction: "bearish", weight: 4, message: "⚠ 直近ニュース有 (実材料の可能性、警戒)" });
  }

  // 8. 寄り底パターン
  const pattern = detectMorningPattern(d);
  if (pattern === "morning_bottom") {
    s += 12;
    signals.push({ source: "寄り底", direction: "bullish", weight: 6, message: "寄り底パターン → 切返し中" });
  }

  return { score: Math.max(0, Math.min(100, s)), signals };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// シグナル: 反落警告度
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function evaluatePlungeWarning(d: IntradayInput, sympathy: UltraShortInsight["sympathy"]): {
  score: number;
  signals: IntradaySignal[];
} {
  const signals: IntradaySignal[] = [];
  let s = 0;
  const ch = d.changePct;
  if (ch == null) return { score: 0, signals };

  // 1. 急騰の前提
  if (ch >= 5) {
    s += 25;
    signals.push({ source: "前日比", direction: "bearish", weight: 8, message: `急騰 +${ch.toFixed(1)}% → 過熱` });
  } else if (ch >= 3) {
    s += 15;
    signals.push({ source: "前日比", direction: "bearish", weight: 5, message: `上昇 +${ch.toFixed(1)}%` });
  } else if (ch >= 1.5) {
    s += 5;
  } else {
    return { score: 0, signals: [] };
  }

  // 2. VWAP より上 (買われ過ぎ)
  const dev = vwapDeviationPct(d);
  if (dev !== null) {
    if (dev >= 2) {
      s += 18;
      signals.push({ source: "VWAP", direction: "bearish", weight: 7, message: `VWAP より +${dev.toFixed(1)}% 上 (買われ過ぎ)` });
    } else if (dev >= 1) {
      s += 8;
    }
  }

  // 3. 板情報 (売り優勢なら反落リスク強い)
  const bidP = bidPct(d);
  if (bidP !== null) {
    if (bidP <= 35) {
      s += 18;
      signals.push({ source: "板情報", direction: "bearish", weight: 7, message: `売り厚み ${(100-bidP).toFixed(0)}% (売り圧強い)` });
    } else if (bidP <= 45) {
      s += 8;
    }
  }

  // 4. 代乗り判定: セクター連動上昇なら一時的
  if (sympathy.detected && sympathy.direction === "up") {
    s += 12;
    signals.push({ source: "代乗り", direction: "bearish", weight: 6, message: `🌊 ${sympathy.reason} → 連れ高戻し可能性` });
  }

  // 5. 高値からの押し (寄り天兆候)
  const pullback = pullbackFromHighPct(d);
  if (pullback !== null && pullback <= -1) {
    s += 12;
    signals.push({ source: "高値押し", direction: "bearish", weight: 5, message: `高値から ${pullback.toFixed(1)}% 押し` });
  }

  // 6. 出来高 (大商いの急騰は逆張り材料)
  const volR = volumeRatio(d);
  if (volR !== null && volR >= 3) {
    if (pullback !== null && pullback <= -0.5) {
      s += 10;
      signals.push({ source: "出来高", direction: "bearish", weight: 5, message: `出来高×${volR.toFixed(1)} + 押し → バイイングクライマックス候補` });
    }
  }

  // 7. ニュース無しの急騰は怪しい
  if (d.hasRecentNews === false) {
    s += 8;
    signals.push({ source: "材料", direction: "bearish", weight: 4, message: "🔥 ニュース無で急騰 → 仕手・短期売り買い候補" });
  }

  // 8. 寄り天パターン
  const pattern = detectMorningPattern(d);
  if (pattern === "morning_top") {
    s += 12;
    signals.push({ source: "寄り天", direction: "bearish", weight: 6, message: "寄り天パターン → 失速中" });
  }

  return { score: Math.max(0, Math.min(100, s)), signals };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// シグナル: ニュース反応度
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function evaluateNewsReaction(d: IntradayInput): { score: number; signal: IntradaySignal | null } {
  if (!d.hasRecentNews) return { score: 0, signal: null };
  const ch = d.changePct ?? 0;
  const volR = volumeRatio(d);

  // ニュース有 + 大幅変動 + 大商い = 材料反応中
  if (Math.abs(ch) >= 3 && volR !== null && volR >= 2) {
    const dir = ch > 0 ? "bullish" : "bearish";
    return {
      score: 80,
      signal: {
        source: "ニュース反応",
        direction: dir,
        weight: 8,
        message: `📰 ニュース反応中 (${ch > 0 ? "+" : ""}${ch.toFixed(1)}% / 出来高×${volR.toFixed(1)})`,
      },
    };
  }
  if (Math.abs(ch) >= 2) {
    return {
      score: 50,
      signal: {
        source: "ニュース反応",
        direction: ch > 0 ? "bullish" : "bearish",
        weight: 5,
        message: `📰 直近ニュース有 (${ch > 0 ? "+" : ""}${ch.toFixed(1)}%)`,
      },
    };
  }
  return { score: 20, signal: null };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// メイン関数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function evaluateUltraShort(d: IntradayInput): UltraShortInsight {
  const sympathy = detectSympathy(d);
  const morningPattern = detectMorningPattern(d);
  const rebound = evaluateRebound(d, sympathy);
  const plunge = evaluatePlungeWarning(d, sympathy);
  const newsReaction = evaluateNewsReaction(d);

  const allSignals = [
    ...rebound.signals,
    ...plunge.signals,
    ...(newsReaction.signal ? [newsReaction.signal] : []),
  ];

  // 総合シグナル判定 (changePct も判定基準に使う = 板/VWAP データ無くても動く)
  const ch = d.changePct ?? 0;
  let overallSignal: OverallSignal;
  let overallScore: number;
  let summary: string;

  // リバウンド: 急落 + reboundScore 一定以上
  const isRebound =
    (ch <= -3 && rebound.score >= 30) ||
    (ch <= -2 && rebound.score >= 50) ||
    rebound.score >= 60;
  // 過熱: 急騰 + plungeScore 一定以上
  const isOverheat =
    (ch >= 5 && plunge.score >= 30) ||
    (ch >= 3 && plunge.score >= 50) ||
    plunge.score >= 60;
  // ニュース反応: 大きな changePct + 出来高
  const isNewsActive = newsReaction.score >= 50;

  if (isRebound && plunge.score < 30) {
    overallSignal = "buy_rebound";
    overallScore = Math.max(rebound.score, Math.min(80, Math.abs(ch) * 8));
    summary = `🟢 リバウンド狙い (score ${rebound.score})`;
  } else if (isOverheat && rebound.score < 30) {
    overallSignal = "sell_overheat";
    overallScore = Math.max(plunge.score, Math.min(80, ch * 6));
    summary = `🔥 反落警戒 (score ${plunge.score})`;
  } else if (isNewsActive) {
    overallSignal = "hold_news_active";
    overallScore = newsReaction.score;
    summary = `📰 ニュース反応中 (score ${newsReaction.score})`;
  } else if (Math.abs(ch) < 1.5 && rebound.score < 20 && plunge.score < 20) {
    overallSignal = "wait";
    overallScore = 30;
    summary = `🟡 様子見 (顕著なシグナル無し)`;
  } else {
    overallSignal = "avoid";
    overallScore = 20;
    summary = `⚠ 不明瞭 (反転と継続両方の材料あり)`;
  }

  if (sympathy.detected) {
    summary += ` · ${sympathy.reason}`;
  }
  if (morningPattern !== "unknown" && morningPattern !== "flat") {
    summary += ` · ${morningPattern}`;
  }

  return {
    ticker: d.ticker,
    reboundScore: rebound.score,
    plungeScore: plunge.score,
    newsReactionScore: newsReaction.score,
    sympathy,
    morningPattern,
    overallSignal,
    overallScore,
    signals: allSignals,
    summary,
  };
}
