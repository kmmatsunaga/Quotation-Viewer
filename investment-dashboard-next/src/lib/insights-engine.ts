/**
 * 投資インサイトエンジン
 *
 * 全データ (価格・テクニカル・ファンダ・パターン・板・信用残) を入力に、
 * 短期 / 中期 / 長期 の3つの時間軸で「買い/売り/様子見」シグナルを生成。
 *
 * ルールベース: Claude API 不要、無料。
 * 時間軸別に異なるルールを適用するのがポイント。
 *
 * 短期 (1-4週間): 日足パターン, RSI, 板情報, 出来高異常, 直近ニュース
 * 中期 (1-6か月): 週足パターン, SMA50, 信用残, 決算近接, ROC20, モメンタム
 * 長期 (1年以上): 月足パターン, ファンダメンタル, 配当, 業績成長
 */

export type Timeframe = "short" | "mid" | "long";
export type SignalDirection = "bullish" | "bearish" | "neutral";

export interface Signal {
  timeframe: Timeframe;
  direction: SignalDirection;
  weight: number;            // 1-10 (大きいほど判断材料として重い)
  source: string;            // どのデータから出たか
  message: string;            // 人間向けに解釈した一文
}

export interface TimeframeVerdict {
  timeframe: Timeframe;
  label: string;
  score: number;             // 0-100
  signalCount: { bullish: number; bearish: number; neutral: number };
  signals: Signal[];
  action: string;             // 推奨アクション (短文)
  detail: string;             // 詳細説明
}

export interface InsightResult {
  ticker: string;
  short: TimeframeVerdict;
  mid: TimeframeVerdict;
  long: TimeframeVerdict;
  // 推奨シナリオ値
  suggestedScenario: {
    entry: number | null;
    target: number | null;
    stopLoss: number | null;
    riskRewardRatio: number | null;
  };
}

// ── 入力データの型 ─────────────────────────────────
export interface InsightInput {
  ticker: string;
  // 価格
  currentPrice?: number | null;
  changePct?: number | null;
  prevClose?: number | null;
  // テクニカル指標
  indicators?: {
    rsi?: number | null;
    macd?: number | null;
    signal?: number | null;
    sma20?: number | null;
    sma50?: number | null;
    sma200?: number | null;
    bbUpper?: number | null;
    bbLower?: number | null;
  } | null;
  // 6ヶ月レンジ位置
  priceContext?: {
    high6m: number;
    low6m: number;
    positionInRange: number;  // 0-100
  } | null;
  // ファンダ
  fundamentals?: {
    trailingPE?: number | null;
    forwardPE?: number | null;
    pbr?: number | null;
    pegRatio?: number | null;
    roe?: number | null;
    operatingMargin?: number | null;
    profitMargin?: number | null;
    debtToEquity?: number | null;
    revenueGrowth?: number | null;
    earningsGrowth?: number | null;
    dividendYield?: number | null;
    payoutRatio?: number | null;
    netCash?: number | null;
    sector?: string | null;
  } | null;
  // チャートパターン
  patterns?: {
    daily?: { label: string; signal: string; confidence: number; direction: string; strength: number; summary?: { roc5?: number; roc20?: number } }[];
    weekly?: { label: string; signal: string; confidence: number; direction: string; strength: number; summary?: { roc5?: number; roc20?: number } }[];
    monthly?: { label: string; signal: string; confidence: number; direction: string; strength: number; summary?: { roc5?: number; roc20?: number } }[];
  } | null;
  // 立花: 板情報
  orderBook?: {
    bidVolume: number;       // 買い側の総数量
    askVolume: number;       // 売り側の総数量
  } | null;
  // 立花: 信用残
  margin?: {
    ratioTotal?: number | null;
    longChangeTotal?: number | null;
    shortChangeTotal?: number | null;
    longTotal?: number | null;
    shortTotal?: number | null;
  } | null;
  // 立花: 逆日歩
  negativeInterest?: number | null;
  // 出来高
  volumeRatio?: number | null;   // 当日 / 20日平均
  // 決算情報
  daysUntilEarnings?: number | null;
  lastEarningsSurprise?: number | null;  // 前回サプライズ %
  // 過去決算パターン (Layer 2 で計算)
  earningsPattern?: {
    avgPre7d?: number | null;        // 決算7日前→当日の平均値動き %
    avgPre3d?: number | null;
    avgPost1d?: number | null;       // 決算翌日の平均ギャップ %
    avgPost3d?: number | null;
    winRatePre7d?: number | null;    // 決算7日前→当日に上昇する確率 %
    sampleSize?: number;             // 過去何回のサンプルか
    bestSellTiming?: string | null;  // 推奨売り時
    bestBuyTiming?: string | null;   // 推奨買い時
  } | null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 短期評価 (1-4週)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function evaluateShortTerm(d: InsightInput): Signal[] {
  const signals: Signal[] = [];
  const tf: Timeframe = "short";

  // 1. RSI
  const rsi = d.indicators?.rsi;
  if (rsi !== null && rsi !== undefined) {
    if (rsi >= 75) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 7, source: "RSI", message: `RSI ${rsi.toFixed(0)} = 買われすぎ圏、押し目を待つ` });
    } else if (rsi >= 65) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 4, source: "RSI", message: `RSI ${rsi.toFixed(0)} = やや過熱、利食い検討域` });
    } else if (rsi <= 25) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 7, source: "RSI", message: `RSI ${rsi.toFixed(0)} = 売られすぎ、反発期待` });
    } else if (rsi <= 35) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 4, source: "RSI", message: `RSI ${rsi.toFixed(0)} = やや売られすぎ、押し目候補` });
    } else if (rsi >= 50 && rsi <= 60) {
      signals.push({ timeframe: tf, direction: "neutral", weight: 2, source: "RSI", message: `RSI ${rsi.toFixed(0)} = 中立、トレンド継続中` });
    }
  }

  // 2. 日足パターン
  const daily = d.patterns?.daily?.[0];
  if (daily) {
    if (daily.signal === "buy" && daily.confidence >= 60) {
      signals.push({ timeframe: tf, direction: "bullish", weight: Math.min(8, 3 + daily.strength), source: "日足パターン", message: `日足: ${daily.label} (信頼度${daily.confidence}%)` });
    } else if (daily.signal === "sell" && daily.confidence >= 60) {
      signals.push({ timeframe: tf, direction: "bearish", weight: Math.min(8, 3 + daily.strength), source: "日足パターン", message: `日足: ${daily.label} (信頼度${daily.confidence}%)` });
    } else if (daily.confidence >= 40) {
      signals.push({ timeframe: tf, direction: "neutral", weight: 2, source: "日足パターン", message: `日足: ${daily.label}` });
    }
  }

  // 3. MACD
  const macd = d.indicators?.macd;
  const signalLine = d.indicators?.signal;
  if (macd !== null && macd !== undefined && signalLine !== null && signalLine !== undefined) {
    const diff = macd - signalLine;
    if (diff > 0 && Math.abs(diff) > 0.5) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 4, source: "MACD", message: "MACDがシグナル上抜け、買い優勢" });
    } else if (diff < 0 && Math.abs(diff) > 0.5) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 4, source: "MACD", message: "MACDがシグナル下抜け、売り優勢" });
    }
  }

  // 4. ボリンジャーバンド
  const bbU = d.indicators?.bbUpper;
  const bbL = d.indicators?.bbLower;
  const price = d.currentPrice;
  if (bbU && bbL && price) {
    if (price >= bbU) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 5, source: "BB", message: "ボリンジャー上限タッチ、反落リスク" });
    } else if (price <= bbL) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 5, source: "BB", message: "ボリンジャー下限タッチ、反発候補" });
    }
  }

  // 5. 板情報 (買い/売りの厚み比率)
  if (d.orderBook && (d.orderBook.bidVolume + d.orderBook.askVolume) > 0) {
    const total = d.orderBook.bidVolume + d.orderBook.askVolume;
    const bidPct = (d.orderBook.bidVolume / total) * 100;
    if (bidPct >= 65) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 5, source: "板情報", message: `買い厚み ${bidPct.toFixed(0)}%、買い圧力強い` });
    } else if (bidPct <= 35) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 5, source: "板情報", message: `売り厚み ${(100-bidPct).toFixed(0)}%、売り圧力強い` });
    }
  }

  // 6. 出来高異常
  const volRatio = d.volumeRatio;
  if (volRatio !== null && volRatio !== undefined) {
    const ch = d.changePct ?? 0;
    if (volRatio >= 3 && ch >= 3) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 7, source: "出来高", message: `出来高×${volRatio.toFixed(1)} + 上昇 = 強い買い流入` });
    } else if (volRatio >= 3 && ch <= -3) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 7, source: "出来高", message: `出来高×${volRatio.toFixed(1)} + 下落 = 強い売り流入` });
    } else if (volRatio >= 2 && Math.abs(ch) < 1) {
      signals.push({ timeframe: tf, direction: "neutral", weight: 4, source: "出来高", message: `出来高×${volRatio.toFixed(1)}あるが値動き小 = 大口仕込み?` });
    } else if (volRatio < 0.5) {
      signals.push({ timeframe: tf, direction: "neutral", weight: 2, source: "出来高", message: "出来高低調、注目薄" });
    }
  }

  // 7. 決算近接 + 過去パターン
  const dEa = d.daysUntilEarnings;
  if (dEa !== null && dEa !== undefined) {
    if (dEa === 0) {
      signals.push({ timeframe: tf, direction: "neutral", weight: 9, source: "決算", message: "🔥 本日決算、寄り後の動きで判断" });
    } else if (dEa > 0 && dEa <= 3) {
      // 直前3日: 過去パターンで上昇傾向なら強気、下落傾向なら警戒
      const pre = d.earningsPattern?.avgPre3d;
      const win = d.earningsPattern?.winRatePre7d;
      if (pre !== null && pre !== undefined && pre > 2) {
        signals.push({ timeframe: tf, direction: "bullish", weight: 6, source: "決算直前", message: `決算まで${dEa}日、過去パターンでは決算前+${pre.toFixed(1)}% (勝率${win?.toFixed(0) ?? "?"}%)` });
      } else if (pre !== null && pre !== undefined && pre < -2) {
        signals.push({ timeframe: tf, direction: "bearish", weight: 6, source: "決算直前", message: `決算まで${dEa}日、過去パターンでは決算前${pre.toFixed(1)}%` });
      } else {
        signals.push({ timeframe: tf, direction: "neutral", weight: 7, source: "決算", message: `決算まで${dEa}日 - 決算ギャンブル域、新規入りはリスク` });
      }
    } else if (dEa > 3 && dEa <= 7) {
      const pre = d.earningsPattern?.avgPre7d;
      const win = d.earningsPattern?.winRatePre7d;
      if (pre !== null && pre !== undefined && pre > 3 && win !== null && win !== undefined && win >= 60) {
        signals.push({ timeframe: tf, direction: "bullish", weight: 6, source: "決算前ラリー", message: `決算まで${dEa}日、過去${d.earningsPattern?.sampleSize ?? "?"}回で平均+${pre.toFixed(1)}% (勝率${win.toFixed(0)}%) - ラリー期` });
      } else {
        signals.push({ timeframe: tf, direction: "neutral", weight: 5, source: "決算", message: `決算まで${dEa}日、ポジション調整検討` });
      }
    } else if (dEa > 7 && dEa <= 14) {
      const pre = d.earningsPattern?.avgPre7d;
      if (pre !== null && pre !== undefined && pre > 3) {
        signals.push({ timeframe: tf, direction: "bullish", weight: 4, source: "決算前", message: `決算まで${dEa}日、過去パターンでは決算前+${pre.toFixed(1)}%の上昇傾向` });
      }
    } else if (dEa < 0 && dEa >= -3) {
      const post = d.earningsPattern?.avgPost1d;
      signals.push({ timeframe: tf, direction: "neutral", weight: 5, source: "決算後", message: `決算${Math.abs(dEa)}日後、反応期${post !== null && post !== undefined ? ` (過去平均: ${post >= 0 ? "+" : ""}${post.toFixed(1)}%)` : ""}` });
    }
  }

  // 8. 前回サプライズ実績
  const surprise = d.lastEarningsSurprise;
  if (surprise !== null && surprise !== undefined && dEa !== null && dEa !== undefined && dEa >= -7 && dEa <= 14) {
    if (surprise >= 10) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 4, source: "サプライズ実績", message: `前回決算は予想を+${surprise.toFixed(1)}%上回り、期待感あり` });
    } else if (surprise <= -10) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 4, source: "サプライズ実績", message: `前回決算は予想を${surprise.toFixed(1)}%下回り、慎重` });
    }
  }

  return signals;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 中期評価 (1-6か月)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function evaluateMidTerm(d: InsightInput): Signal[] {
  const signals: Signal[] = [];
  const tf: Timeframe = "mid";

  // 1. 週足パターン
  const weekly = d.patterns?.weekly?.[0];
  if (weekly) {
    if (weekly.signal === "buy" && weekly.confidence >= 50) {
      signals.push({ timeframe: tf, direction: "bullish", weight: Math.min(8, 4 + weekly.strength), source: "週足パターン", message: `週足: ${weekly.label} (信頼度${weekly.confidence}%)` });
    } else if (weekly.signal === "sell" && weekly.confidence >= 50) {
      signals.push({ timeframe: tf, direction: "bearish", weight: Math.min(8, 4 + weekly.strength), source: "週足パターン", message: `週足: ${weekly.label} (信頼度${weekly.confidence}%)` });
    } else if (weekly.confidence >= 30) {
      signals.push({ timeframe: tf, direction: "neutral", weight: 2, source: "週足パターン", message: `週足: ${weekly.label}` });
    }
  }

  // 2. SMA50 を価格が上回るか
  const price = d.currentPrice;
  const sma50 = d.indicators?.sma50;
  const sma200 = d.indicators?.sma200;
  if (price && sma50) {
    const diff = ((price - sma50) / sma50) * 100;
    if (diff > 5) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 5, source: "SMA50", message: `SMA50より +${diff.toFixed(1)}% = 中期上昇トレンド` });
    } else if (diff < -5) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 5, source: "SMA50", message: `SMA50より ${diff.toFixed(1)}% = 中期下降` });
    } else {
      signals.push({ timeframe: tf, direction: "neutral", weight: 2, source: "SMA50", message: `SMA50付近で推移` });
    }
  }

  // 3. ゴールデン/デッドクロス
  if (sma50 && sma200) {
    const diff = ((sma50 - sma200) / sma200) * 100;
    if (diff > 2) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 6, source: "MAクロス", message: "ゴールデンクロス維持中 = 中期強気" });
    } else if (diff < -2) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 6, source: "MAクロス", message: "デッドクロス継続 = 中期弱気" });
    }
  }

  // 4. 6か月レンジ位置
  if (d.priceContext) {
    const pos = d.priceContext.positionInRange;
    if (pos <= 25) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 5, source: "レンジ位置", message: `6mレンジ下位${pos}% = 押し目買い好機` });
    } else if (pos >= 80) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 4, source: "レンジ位置", message: `6mレンジ高位${pos}% = 高値警戒` });
    }
  }

  // 5. 信用倍率
  const ratio = d.margin?.ratioTotal;
  if (ratio !== null && ratio !== undefined) {
    if (ratio < 1) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 7, source: "信用倍率", message: `信用倍率 ${ratio.toFixed(2)} = 売残>買残、踏み上げ候補` });
    } else if (ratio < 3) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 4, source: "信用倍率", message: `信用倍率 ${ratio.toFixed(2)} = やや売り偏重、需給好転余地` });
    } else if (ratio > 20) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 4, source: "信用倍率", message: `信用倍率 ${ratio.toFixed(2)} = 買い偏重、利食い圧力` });
    }
  }

  // 6. 逆日歩
  if (d.negativeInterest !== null && d.negativeInterest !== undefined && d.negativeInterest > 0) {
    signals.push({ timeframe: tf, direction: "bullish", weight: 6, source: "逆日歩", message: `逆日歩発生 = 売り方コスト増、踏み上げ加速` });
  }

  // 7. 中期モメンタム (ROC20)
  const roc20 = d.patterns?.daily?.[0]?.summary?.roc20;
  if (roc20 !== null && roc20 !== undefined) {
    if (roc20 >= 10) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 4, source: "ROC20", message: `20日変化率 +${roc20.toFixed(1)}% = 上昇加速` });
    } else if (roc20 <= -10) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 4, source: "ROC20", message: `20日変化率 ${roc20.toFixed(1)}% = 下降加速` });
    }
  }

  return signals;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 長期評価 (1年以上)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function evaluateLongTerm(d: InsightInput): Signal[] {
  const signals: Signal[] = [];
  const tf: Timeframe = "long";

  // 1. 月足パターン
  const monthly = d.patterns?.monthly?.[0];
  if (monthly) {
    if (monthly.signal === "buy" && monthly.confidence >= 50) {
      signals.push({ timeframe: tf, direction: "bullish", weight: Math.min(9, 5 + monthly.strength), source: "月足パターン", message: `月足: ${monthly.label} (信頼度${monthly.confidence}%)` });
    } else if (monthly.signal === "sell" && monthly.confidence >= 50) {
      signals.push({ timeframe: tf, direction: "bearish", weight: Math.min(9, 5 + monthly.strength), source: "月足パターン", message: `月足: ${monthly.label} (信頼度${monthly.confidence}%)` });
    }
  }

  const f = d.fundamentals;
  if (!f) {
    return signals;
  }

  // 2. PER
  if (f.trailingPE !== null && f.trailingPE !== undefined && f.trailingPE > 0) {
    if (f.trailingPE < 10) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 6, source: "PER", message: `PER ${f.trailingPE.toFixed(1)} = 大幅割安` });
    } else if (f.trailingPE < 15) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 4, source: "PER", message: `PER ${f.trailingPE.toFixed(1)} = 割安` });
    } else if (f.trailingPE > 40) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 5, source: "PER", message: `PER ${f.trailingPE.toFixed(1)} = 大幅割高` });
    } else if (f.trailingPE > 25) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 3, source: "PER", message: `PER ${f.trailingPE.toFixed(1)} = やや割高` });
    }
  }

  // 3. PBR
  if (f.pbr !== null && f.pbr !== undefined && f.pbr > 0) {
    if (f.pbr < 1) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 5, source: "PBR", message: `PBR ${f.pbr.toFixed(2)} = 解散価値割れ` });
    } else if (f.pbr < 1.5) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 3, source: "PBR", message: `PBR ${f.pbr.toFixed(2)} = 割安水準` });
    } else if (f.pbr > 5) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 3, source: "PBR", message: `PBR ${f.pbr.toFixed(2)} = 高水準` });
    }
  }

  // 4. ROE
  if (f.roe !== null && f.roe !== undefined) {
    if (f.roe >= 20) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 6, source: "ROE", message: `ROE ${f.roe.toFixed(1)}% = 卓越した収益力` });
    } else if (f.roe >= 12) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 4, source: "ROE", message: `ROE ${f.roe.toFixed(1)}% = 健全な収益力` });
    } else if (f.roe < 5 && f.roe > 0) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 3, source: "ROE", message: `ROE ${f.roe.toFixed(1)}% = 収益力低い` });
    } else if (f.roe < 0) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 7, source: "ROE", message: `ROE マイナス = 赤字経営` });
    }
  }

  // 5. 売上・利益成長率
  if (f.earningsGrowth !== null && f.earningsGrowth !== undefined) {
    if (f.earningsGrowth >= 20) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 5, source: "利益成長", message: `利益成長 +${f.earningsGrowth.toFixed(1)}% = 急成長` });
    } else if (f.earningsGrowth >= 10) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 3, source: "利益成長", message: `利益成長 +${f.earningsGrowth.toFixed(1)}% = 安定成長` });
    } else if (f.earningsGrowth <= -10) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 5, source: "利益成長", message: `利益成長 ${f.earningsGrowth.toFixed(1)}% = 減益` });
    }
  }

  // 6. 配当利回り
  if (f.dividendYield !== null && f.dividendYield !== undefined && f.dividendYield > 0) {
    if (f.dividendYield >= 4) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 4, source: "配当", message: `配当 ${f.dividendYield.toFixed(2)}% = 高配当` });
    } else if (f.dividendYield >= 2.5) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 2, source: "配当", message: `配当 ${f.dividendYield.toFixed(2)}% = まずまず` });
    }
  }
  // 配当性向の確認
  if (f.payoutRatio !== null && f.payoutRatio !== undefined) {
    if (f.payoutRatio > 100) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 4, source: "配当性向", message: `配当性向 ${f.payoutRatio.toFixed(0)}% = 利益以上の配当, 持続性に懸念` });
    }
  }

  // 7. 財務健全性 (D/E)
  if (f.debtToEquity !== null && f.debtToEquity !== undefined) {
    if (f.debtToEquity > 200) {
      signals.push({ timeframe: tf, direction: "bearish", weight: 4, source: "D/Eレシオ", message: `D/E ${f.debtToEquity.toFixed(0)} = 借入過多` });
    } else if (f.debtToEquity < 30) {
      signals.push({ timeframe: tf, direction: "bullish", weight: 2, source: "D/Eレシオ", message: `D/E ${f.debtToEquity.toFixed(0)} = 健全な財務` });
    }
  }

  // 8. ネットキャッシュ
  if (f.netCash !== null && f.netCash !== undefined && f.netCash > 0) {
    signals.push({ timeframe: tf, direction: "bullish", weight: 3, source: "ネットキャッシュ", message: `ネットキャッシュ +${(f.netCash / 1e8).toFixed(0)}億円 = 実質無借金` });
  }

  return signals;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// シグナルを集計してスコアと推奨アクションを算出
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function aggregateSignals(signals: Signal[], timeframe: Timeframe, label: string): TimeframeVerdict {
  let bullScore = 0;
  let bearScore = 0;
  const count = { bullish: 0, bearish: 0, neutral: 0 };
  for (const s of signals) {
    if (s.direction === "bullish") {
      bullScore += s.weight;
      count.bullish++;
    } else if (s.direction === "bearish") {
      bearScore += s.weight;
      count.bearish++;
    } else {
      count.neutral++;
    }
  }
  // スコアを 0-100 に正規化
  let net = bullScore - bearScore;

  // ─ 一方向ボーナス/ペナルティ ─────────────────
  // 多数の材料が揃って一方向に偏っている銘柄を浮き上がらせる
  // 短期はシグナル種類が少ないのでボーナス強め、中期/長期は穏やか
  const bonus = timeframe === "short" ? 8 : 5;
  if (count.bearish === 0 && count.bullish >= 3) {
    net += bonus;
  } else if (count.bullish === 0 && count.bearish >= 3) {
    net -= bonus;
  }

  // 時間軸別にクリップ値を変える (シグナル総量の差を補正)
  //   短期: ±18 (シグナル少, 圧縮して 80+ を出やすく)
  //   中期: ±26 (シグナル中, やや穏やか)
  //   長期: ±26 (シグナル多, 同上)
  const CLIP = timeframe === "short" ? 18 : 26;
  const clamped = Math.max(-CLIP, Math.min(CLIP, net));
  const score = Math.round(50 + (clamped / CLIP) * 50);

  // アクション
  let action = "";
  let detail = "";
  if (score >= 80) {
    action = "🟢 強気 - 積極エントリー検討";
    detail = `${timeframe === "short" ? "短期" : timeframe === "mid" ? "中期" : "長期"}的に強い買い材料が揃っています。`;
  } else if (score >= 65) {
    action = "🟢 やや買い - 押し目で検討";
    detail = "買い材料が優勢。タイミングを見て段階的エントリーを。";
  } else if (score >= 45) {
    action = "🟡 様子見 - 方向性不明";
    detail = "買いと売りの材料が拮抗。決定打を待つのが賢明。";
  } else if (score >= 30) {
    action = "🟠 やや売り - 利食い検討";
    detail = "売り材料が優勢。既保有なら部分利食いも検討。";
  } else {
    action = "🔴 売り / 様子見 - 新規買い不向き";
    detail = `${timeframe === "short" ? "短期" : timeframe === "mid" ? "中期" : "長期"}的に売り材料が圧倒的。`;
  }

  return { timeframe, label, score, signalCount: count, signals, action, detail };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 推奨シナリオ値を算出
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function suggestScenario(
  d: InsightInput,
  midScore: number
): InsightResult["suggestedScenario"] {
  const price = d.currentPrice;
  if (!price) return { entry: null, target: null, stopLoss: null, riskRewardRatio: null };

  // 中期スコアを基準にエントリーバイアスを決定
  let entryDiscount = 0;     // 現在価格からの割引率(%)
  let targetUpside = 0;       // エントリーからの目標上昇率(%)
  let stopRisk = 0;           // エントリーからの損切り率(%)

  if (midScore >= 65) {
    // 強気: 現在値〜やや上で入って、目標は遠め
    entryDiscount = -1;       // やや上抜けで入る
    targetUpside = 12;
    stopRisk = 5;
  } else if (midScore >= 50) {
    // やや強気: 現在値で入って、目標は中庸
    entryDiscount = 0;
    targetUpside = 8;
    stopRisk = 4;
  } else if (midScore >= 35) {
    // 様子見: 押し目で入って、目標は短め
    entryDiscount = 3;        // 3%下まで待つ
    targetUpside = 6;
    stopRisk = 3;
  } else {
    // 弱気: 大きく押し目を待つ
    entryDiscount = 5;
    targetUpside = 5;
    stopRisk = 3;
  }

  // BBや高安値を加味
  let entry = price * (1 - entryDiscount / 100);
  if (d.priceContext) {
    // レンジ位置から微調整
    const pos = d.priceContext.positionInRange;
    if (pos >= 80) entry = Math.min(entry, price * 0.97);  // 高値圏は更に控えめ
  }

  const target = entry * (1 + targetUpside / 100);
  const stopLoss = entry * (1 - stopRisk / 100);
  const rr = stopRisk > 0 ? targetUpside / stopRisk : null;

  return {
    entry: Math.round(entry),
    target: Math.round(target),
    stopLoss: Math.round(stopLoss),
    riskRewardRatio: rr ? Math.round(rr * 100) / 100 : null,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// メイン関数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function evaluateInsights(d: InsightInput): InsightResult {
  const shortSignals = evaluateShortTerm(d);
  const midSignals = evaluateMidTerm(d);
  const longSignals = evaluateLongTerm(d);

  const short = aggregateSignals(shortSignals, "short", "短期 (1-4週)");
  const mid = aggregateSignals(midSignals, "mid", "中期 (1-6か月)");
  const long = aggregateSignals(longSignals, "long", "長期 (1年以上)");

  return {
    ticker: d.ticker,
    short,
    mid,
    long,
    suggestedScenario: suggestScenario(d, mid.score),
  };
}
