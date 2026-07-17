/**
 * 暴落番犬 (Crash Sentinel) — 保有ポートフォリオに対する暴落サインを検知する純関数。
 *
 * 2系統を見る (ユーザー方針 2026-07-17):
 *  ・リアルタイム暴落 (reactive): 今まさに急落している (個別急落 / 投げ売り / 地合い総崩れ / ポート全体急落)
 *  ・予兆 (predictive): 落ちる前の兆候 (天井からの分配売り / 200日線割れ / デッドクロス / マクロ景気後退確率)
 *
 * 感度は「重大時のみ」= 空振りを避け、本当にヤバい時だけ warning/critical を返す (高い閾値)。
 * これは検知ロジックであって投資助言ではない。最終判断はユーザー。
 */

export type CrashLevel = "none" | "warning" | "critical";
export type SignalScope = "market" | "portfolio" | "holding";
export type SignalKind =
  // reactive
  | "holding_plunge"       // 個別急落
  | "capitulation"         // 出来高を伴う投げ売り
  | "market_selloff"       // 地合い総崩れ (日経)
  | "portfolio_drop"       // ポート全体の当日下落
  // predictive
  | "distribution"         // 天井圏からの分配売り
  | "trend_break"          // 200日線割れ
  | "death_cross"          // デッドクロス
  | "macro_recession";     // マクロ景気後退確率上昇

export interface HoldingQuote {
  ticker: string;
  name: string;
  price: number;
  prevClose: number;
  changePct: number;          // 前日終値比 (%)
  openPct: number | null;     // 寄りギャップ (%) — 前日終値→今日始値
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  high20: number | null;      // 直近20営業日高値
  daysSinceHigh20: number | null; // 20日高値をつけてからの経過日数
  volRatio: number | null;    // 当日出来高 / 直近20日平均出来高
  /** ポートフォリオ内の時価ウェイト 0..1 */
  weight: number;
}

export interface MarketContext {
  nikkeiChangePct: number | null;
  /** マクロ: 12ヶ月以内の景気後退確率 (%) — 無ければ null */
  recessionProb: number | null;
}

export interface CrashSignal {
  scope: SignalScope;
  kind: SignalKind;
  level: "warning" | "critical";
  reactive: boolean;          // true=リアルタイム暴落, false=予兆
  ticker?: string;
  text: string;
}

export interface CrashAssessment {
  level: CrashLevel;
  headline: string;           // 例: "🚨 暴落警報"
  summary: string;            // 一言
  advice: string;             // 規律的な行動 (慌てて投げない等)
  signals: CrashSignal[];
  affectedTickers: string[];
  /** 通知重複排除用の署名 (level + 種別 + 対象) */
  signature: string;
}

// ── 閾値 (重大時のみ = 高め) ──
const TH = {
  plungePct: -7,             // 個別急落
  plungeCriticalPct: -10,
  capitulationPct: -5,       // 投げ売り (出来高2倍以上と併用)
  capitulationVol: 2.0,
  marketSelloffPct: -3,      // 地合い総崩れ
  marketCrashPct: -5,
  portfolioDropPct: -5,      // ポート全体
  portfolioCrashPct: -7,
  distributionDropPct: -4,   // 分配売り (当日下落)
  distributionVol: 2.0,
  distributionRecentHighDays: 5, // 直近5日以内に20日高値
  recessionProb: 55,         // マクロ景気後退確率
};

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

export function assessCrashRisk(holdings: HoldingQuote[], market: MarketContext): CrashAssessment {
  const signals: CrashSignal[] = [];
  const affected = new Set<string>();

  // ── リアルタイム: 個別急落 / 投げ売り / 分配売り / トレンド割れ (per holding) ──
  for (const h of holdings) {
    // 個別急落
    if (h.changePct <= TH.plungePct) {
      const critical = h.changePct <= TH.plungeCriticalPct;
      signals.push({
        scope: "holding", kind: "holding_plunge", reactive: true,
        level: critical ? "critical" : "warning", ticker: h.ticker,
        text: `${h.name}(${h.ticker}) が急落中 ${pct(h.changePct)}${h.openPct != null && h.openPct <= -3 ? ` (寄りから ${pct(h.openPct)} のギャップダウン)` : ""}。`,
      });
      affected.add(h.ticker);
    }
    // 投げ売り (出来高急増を伴う下落)
    else if (h.volRatio != null && h.volRatio >= TH.capitulationVol && h.changePct <= TH.capitulationPct) {
      signals.push({
        scope: "holding", kind: "capitulation", reactive: true, level: "warning", ticker: h.ticker,
        text: `${h.name}(${h.ticker}) が出来高${h.volRatio.toFixed(1)}倍の急増を伴って ${pct(h.changePct)}。投げ売り (キャピチュレーション) の様相。`,
      });
      affected.add(h.ticker);
    }

    // 予兆: 天井圏からの分配売り
    if (
      h.daysSinceHigh20 != null && h.daysSinceHigh20 <= TH.distributionRecentHighDays &&
      h.volRatio != null && h.volRatio >= TH.distributionVol &&
      h.changePct <= TH.distributionDropPct && h.changePct > TH.plungePct
    ) {
      signals.push({
        scope: "holding", kind: "distribution", reactive: false, level: "warning", ticker: h.ticker,
        text: `${h.name}(${h.ticker}) は直近高値圏で出来高を伴い ${pct(h.changePct)}。天井での分配売り (大口の利確) の可能性 — 崩れの初動サイン。`,
      });
      affected.add(h.ticker);
    }

    // 予兆: 200日線割れ (前日は上、今日下抜け)
    if (h.sma200 != null && h.prevClose >= h.sma200 && h.price < h.sma200) {
      signals.push({
        scope: "holding", kind: "trend_break", reactive: false, level: "warning", ticker: h.ticker,
        text: `${h.name}(${h.ticker}) が200日線 (¥${Math.round(h.sma200).toLocaleString()}) を下抜け。長期上昇基調の崩れ = 下落トレンド入りの警戒サイン。`,
      });
      affected.add(h.ticker);
    }
    // 予兆: デッドクロス (20日線が50日線を下回り、かつ株価も下)
    else if (
      h.sma20 != null && h.sma50 != null && h.sma20 < h.sma50 &&
      (h.sma50 - h.sma20) / h.sma50 <= 0.02 && h.price < h.sma50
    ) {
      signals.push({
        scope: "holding", kind: "death_cross", reactive: false, level: "warning", ticker: h.ticker,
        text: `${h.name}(${h.ticker}) は20日線が50日線を割り込むデッドクロス圏。中期の勢いが下向きに転換。`,
      });
      affected.add(h.ticker);
    }
  }

  // ── リアルタイム: 地合い総崩れ (日経) ──
  if (market.nikkeiChangePct != null && market.nikkeiChangePct <= TH.marketSelloffPct) {
    const critical = market.nikkeiChangePct <= TH.marketCrashPct;
    signals.push({
      scope: "market", kind: "market_selloff", reactive: true, level: critical ? "critical" : "warning",
      text: `日経平均が ${pct(market.nikkeiChangePct)} と${critical ? "暴落" : "急落"}。地合い総崩れで、個別の good/bad に関係なく巻き込まれ売りが出やすい。`,
    });
  }

  // ── リアルタイム: ポートフォリオ全体の当日下落 (ウェイト加重) ──
  const totalWeight = holdings.reduce((s, h) => s + h.weight, 0);
  if (totalWeight > 0) {
    const ptfPct = holdings.reduce((s, h) => s + h.weight * h.changePct, 0) / totalWeight;
    if (ptfPct <= TH.portfolioDropPct) {
      const critical = ptfPct <= TH.portfolioCrashPct;
      signals.push({
        scope: "portfolio", kind: "portfolio_drop", reactive: true, level: critical ? "critical" : "warning",
        text: `保有ポートフォリオ全体が本日 ${pct(ptfPct)} (時価加重)。含み益の急速な目減り。`,
      });
    }
  }

  // ── 予兆: マクロ景気後退確率 ──
  if (market.recessionProb != null && market.recessionProb >= TH.recessionProb) {
    signals.push({
      scope: "market", kind: "macro_recession", reactive: false, level: "warning",
      text: `マクロ指標が示す12ヶ月以内の景気後退確率が ${market.recessionProb.toFixed(0)}% に上昇。株全体の地合い悪化の下地。`,
    });
  }

  // ── 集約 ──
  const hasCritical = signals.some((s) => s.level === "critical");
  const level: CrashLevel = signals.length === 0 ? "none" : hasCritical ? "critical" : "warning";

  const reactiveCount = signals.filter((s) => s.reactive).length;
  const predictiveOnly = reactiveCount === 0 && signals.length > 0;

  let headline: string;
  let summary: string;
  let advice: string;
  if (level === "critical") {
    headline = "🚨 暴落警報";
    summary = `保有資産に重大な下落サインが ${signals.length} 件。`;
    advice = "まず深呼吸。暴落時の即断は事故のもと。損切りラインを決めていたなら機械的に従い、決めていないなら“今の値段で新規に買うか”を基準に冷静に判断を。狼狽売りと塩漬けの両方を避ける。";
  } else if (level === "warning") {
    headline = predictiveOnly ? "⚠ 暴落の予兆" : "⚠ 下落警戒";
    summary = predictiveOnly
      ? `落ちる前の兆候が ${signals.length} 件。まだ暴落ではないが警戒圏。`
      : `保有資産に下落サインが ${signals.length} 件。`;
    advice = "慌てる局面ではないが、損切りラインと“どこまで下がったら何をするか”を今のうちに再確認しておくと、いざという時に迷わない。";
  } else {
    headline = "";
    summary = "現在、重大な暴落サインは検知されていません。";
    advice = "";
  }

  // 署名 (通知重複排除用): level + 種別+対象 をソートして連結
  const signature = [
    level,
    ...signals.map((s) => `${s.kind}:${s.ticker ?? "_"}`).sort(),
  ].join("|");

  return {
    level, headline, summary, advice, signals,
    affectedTickers: Array.from(affected),
    signature,
  };
}

/** LINE 通知メッセージを組み立てる */
export function buildCrashLineMessage(a: CrashAssessment): string {
  const lines: string[] = [];
  lines.push(a.level === "critical" ? "🚨🚨 Cavka 暴落警報 🚨🚨" : "⚠ Cavka 下落警戒");
  lines.push("");
  lines.push(a.summary);
  lines.push("");
  // reactive を先、predictive を後
  const ordered = [...a.signals].sort((x, y) => Number(y.reactive) - Number(x.reactive));
  for (const s of ordered) {
    const tag = s.reactive ? "🔴" : "🟡";
    lines.push(`${tag} ${s.text}`);
  }
  lines.push("");
  lines.push(`💡 ${a.advice}`);
  lines.push("");
  lines.push("📱 https://quotation-viewer.vercel.app/portfolio");
  return lines.join("\n");
}
