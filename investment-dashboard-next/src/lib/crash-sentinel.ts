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
  | "overnight_gap"        // 前夜の米市況 (SOX等) による寄りギャップ警戒
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
  /** 半導体関連銘柄か (前夜の米SOXギャップ警戒に使う) */
  isSemiconductor?: boolean;
}

export interface MarketContext {
  nikkeiChangePct: number | null;
  /** マクロ: 12ヶ月以内の景気後退確率 (%) — 無ければ null */
  recessionProb: number | null;
  /** 前夜の米フィラデルフィア半導体指数 (SOX) の騰落率 (%)。寄り前チェック用。無ければ null */
  soxChangePct?: number | null;
}

export interface CrashSignal {
  scope: SignalScope;
  kind: SignalKind;
  level: "warning" | "critical";
  reactive: boolean;          // true=リアルタイム暴落, false=予兆
  ticker?: string;
  text: string;
  /** 個別急落/投げ売りのエスカレーション段階 (⚡1=初動 🔥2=連鎖 🚨3=本警報) */
  stage?: 1 | 2 | 3;
}

export interface CrashAssessment {
  level: CrashLevel;
  headline: string;           // 例: "🚨 暴落警報"
  summary: string;            // 一言
  advice: string;             // 規律的な行動 (慌てて投げない等)
  signals: CrashSignal[];
  affectedTickers: string[];
  /** 通知重複排除用の署名 (level + 種別 + 対象 + 段階)。段階が上がると変わる = LINE 再送 */
  signature: string;
  /** 更新後のストライク履歴 (呼び出し側が永続化する) */
  strikesOut: StrikeHistory;
}

/**
 * ストライク履歴: 銘柄ごとの「急落を検知した日 (JST YYYYMMDD)」のリスト。
 * 高ボラ株の段階的エスカレーション (⚡→🔥→🚨) の記憶。cron が Firestore に永続化。
 */
export type StrikeHistory = Record<string, string[]>;

// ── 閾値 (重大時のみ = 高め) ──
const TH = {
  plungePct: -7,             // 個別急落 (ストライク=段階カウントの1票)
  capitulationPct: -5,       // 投げ売り (出来高2倍以上と併用、これもストライク)
  capitulationVol: 2.0,
  stage2SinglePct: -12,      // 単日これ以下なら一撃で🔥第2報
  stage3SinglePct: -15,      // 単日これ以下なら一撃で🚨本警報
  stage3DrawdownPct: -25,    // 2票目 + 20日高値からこれ以下なら🚨
  strikeWindowDays: 10,      // ストライクの記憶期間 (暦日) ≒ 7営業日
  marketSelloffPct: -3,      // 地合い総崩れ
  marketCrashPct: -5,
  portfolioDropPct: -5,      // ポート全体
  portfolioCrashPct: -7,
  distributionDropPct: -4,   // 分配売り (当日下落)
  distributionVol: 2.0,
  distributionRecentHighDays: 5, // 直近5日以内に20日高値
  recessionProb: 55,         // マクロ景気後退確率
  soxGapPct: -3,             // 前夜の米SOX急落 (半導体保有の寄りギャップ警戒)
  soxGapHeavyPct: -4.5,
};

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

function jstDateKey(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
}

/** dateKey (YYYYMMDD) が基準日から windowDays 以内か */
function withinWindow(dateKey: string, todayKey: string, windowDays: number): boolean {
  const p = (k: string) => Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8));
  const diff = (p(todayKey) - p(dateKey)) / 86400000;
  return diff >= 0 && diff <= windowDays;
}

export function assessCrashRisk(
  holdings: HoldingQuote[],
  market: MarketContext,
  opts?: { strikes?: StrikeHistory; todayKey?: string }
): CrashAssessment {
  const signals: CrashSignal[] = [];
  const affected = new Set<string>();
  const todayKey = opts?.todayKey ?? jstDateKey(new Date());
  const strikesIn: StrikeHistory = opts?.strikes ?? {};
  const strikesOut: StrikeHistory = {};

  // ── リアルタイム: 個別急落 / 投げ売り (段階エスカレーション) + 予兆 (per holding) ──
  for (const h of holdings) {
    // 窓内の過去ストライク (今日を除く)
    const past = (strikesIn[h.ticker] ?? []).filter(
      (d) => d !== todayKey && withinWindow(d, todayKey, TH.strikeWindowDays)
    );

    // 今日のストライク判定 (急落 or 出来高急増を伴う投げ売り)
    const isPlunge = h.changePct <= TH.plungePct;
    const isCapitulation =
      !isPlunge && h.volRatio != null && h.volRatio >= TH.capitulationVol && h.changePct <= TH.capitulationPct;
    const struckToday = isPlunge || isCapitulation;

    if (struckToday) {
      // -15%級の一撃は2票として記録 → 翌日以降も段階が下がらない (単調エスカレーション)
      const deepBlow = h.changePct <= TH.stage3SinglePct;
      strikesOut[h.ticker] = deepBlow ? [...past, todayKey, todayKey] : [...past, todayKey];
      const count = past.length + (deepBlow ? 2 : 1);
      const drawdown20 = h.high20 && h.high20 > 0 ? ((h.price - h.high20) / h.high20) * 100 : null;

      // 段階判定: 回数 (7営業日窓) + 一撃の深さ + 累積ドローダウン
      let stage: 1 | 2 | 3;
      if (
        count >= 3 ||
        h.changePct <= TH.stage3SinglePct ||
        (count >= 2 && drawdown20 != null && drawdown20 <= TH.stage3DrawdownPct)
      ) {
        stage = 3;
      } else if (count === 2 || h.changePct <= TH.stage2SinglePct) {
        stage = 2;
      } else {
        stage = 1;
      }

      const gapNote = h.openPct != null && h.openPct <= -3 ? ` (寄りから ${pct(h.openPct)} のギャップダウン)` : "";
      const volNote = isCapitulation && h.volRatio != null ? ` 出来高${h.volRatio.toFixed(1)}倍の投げ売りを伴う。` : "";
      const ddNote = drawdown20 != null && drawdown20 <= -15 ? ` 直近高値から累積 ${pct(drawdown20)}。` : "";
      // 表示上の回数は実日数 (deepBlow の2票は内部の重み付けのみ)
      const daysCount = new Set([...past, todayKey]).size;

      const text =
        stage === 1
          ? `⚡ 第1報: ${h.name}(${h.ticker}) が ${pct(h.changePct)} の急落${gapNote}。${volNote}この銘柄では珍しくない振れの可能性もあるが、初動として警戒。`
          : stage === 2
          ? `🔥 第2報: ${h.name}(${h.ticker}) が ${pct(h.changePct)}${gapNote}。直近7営業日で${daysCount}回目${daysCount === 1 ? " (一撃で深い)" : ""} — 単発のブレではなく、崩れの連鎖の可能性。${volNote}${ddNote}`
          : `🚨 第3報 (本警報): ${h.name}(${h.ticker}) が ${pct(h.changePct)}${gapNote}。直近7営業日で${daysCount}回目${daysCount === 1 ? " (一撃で本警報級)" : ""}。${volNote}${ddNote}地形が崩れている。決めたルールに基づく判断を。`;

      signals.push({
        scope: "holding",
        kind: isCapitulation ? "capitulation" : "holding_plunge",
        reactive: true,
        level: stage >= 2 ? "critical" : "warning",
        ticker: h.ticker,
        stage,
        text,
      });
      affected.add(h.ticker);
    } else if (past.length > 0) {
      // 今日は落ちていないが、記憶は窓内で持ち越す
      strikesOut[h.ticker] = past;
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

  // ── 予兆: 前夜の米SOX急落 → 保有半導体の寄りギャップ警戒 (主に寄り前チェックで有効) ──
  // 既に急落済み (affected) の銘柄は holding_plunge が語るのでここでは挙げない
  if (market.soxChangePct != null && market.soxChangePct <= TH.soxGapPct) {
    const semis = holdings.filter((h) => h.isSemiconductor && !affected.has(h.ticker));
    if (semis.length > 0) {
      const names = semis.map((h) => `${h.name}(${h.ticker})`).join("、");
      const heavy = market.soxChangePct <= TH.soxGapHeavyPct;
      signals.push({
        scope: "market", kind: "overnight_gap", reactive: false, level: "warning",
        text: `前夜の米フィラデルフィア半導体指数 (SOX) が ${pct(market.soxChangePct)}${heavy ? " と大幅安" : ""}。保有の半導体関連 (${names}) は、寄りで大きく下げて始まる可能性。寄り成りでの狼狽売り・ナンピンは危険。`,
      });
      semis.forEach((h) => affected.add(h.ticker));
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

  // 署名 (通知重複排除用): level + 種別+対象+段階。
  // 段階付き (個別の急落) は日付入り = 急落した営業日ごとに1回 LINE。
  // 同日内は段階が上がった時だけ再送 (⚡09:30 → 🔥14:00 なら再度鳴る)。
  const signature = [
    level,
    ...signals
      .map((s) => {
        const stagePart = s.stage ? `@s${s.stage}:${todayKey}` : "";
        return `${s.kind}:${s.ticker ?? "_"}${stagePart}`;
      })
      .sort(),
  ].join("|");

  return {
    level, headline, summary, advice, signals,
    affectedTickers: Array.from(affected),
    signature,
    strikesOut,
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
