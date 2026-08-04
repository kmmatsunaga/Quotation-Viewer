/**
 * 🧭 現在地コンパス — 「大きな流れの中で、いまはどの局面か」を毎日同じ物差しで測る
 *
 * ユーザーの要望 (2026-08-04):
 *   「当ててほしいとは言っていない。大きな流れの中でそれを読む力が欲しい」
 *
 * だから予測は一切しない。5つの物差しで【現在地】だけを示す。
 * 位置が分かれば次の一歩は自分で推測できる、という設計思想。
 *
 *   🌊 潮   = 洗い流しの深さ (60日安値の割合) … レジーム測定器
 *   🌡 温度 = 過熱/冷却 (60日高値の割合 − 60日安値の割合、日経RSI)
 *   📐 傾き = 中長期トレンドの向き (日経 vs 200日線・50日線の傾き)
 *   💎 割安の水位 = ネットキャッシュ比率1以上の銘柄数 (清原軸の在庫量)
 *   🧍 自分の位置 = 現金比率・β (ポートフォリオがある時だけ)
 *
 * 各物差しは「良い/悪い」ではなく「今どこ」を示す。判断は本人がする。
 */

export interface CompassInputs {
  low60Pct: number | null;      // 60日安値の割合 (regime_gauge)
  high60Pct: number | null;     // 60日高値の割合
  low60History: { date: string; low60Pct: number }[];
  nikkeiClose: number | null;
  nikkeiSma50: number | null;
  nikkeiSma200: number | null;
  nikkeiSma50Prev: number | null; // 20営業日前の50日線 (傾き判定用)
  nikkeiRsi14: number | null;
  netCashFortressCount: number | null; // NC比率>=1 の銘柄数
  cashRatioPct: number | null;   // 自分の現金比率
  portfolioBeta: number | null;
}

export type TideLevel = "historic" | "regime" | "washing" | "soft" | "calm";
export type TrendLevel = "strong_up" | "up" | "flat" | "down" | "strong_down";
export type HeatLevel = "overheated" | "warm" | "neutral" | "cool" | "frozen";

export interface CompassGauge {
  key: string;
  emoji: string;
  label: string;
  value: string;          // 表示値
  state: string;          // 状態ラベル
  color: string;
  detail: string;         // 数字の意味の一行説明
}

export interface CompassReading {
  date: string;
  headline: string;       // 局面の一言 (潮×傾きの組合せ)
  headlineNote: string;   // その局面で何が起きやすいか (事実ベース)
  gauges: CompassGauge[];
  trend: TrendLevel;
  tide: TideLevel;
  heat: HeatLevel;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

const GRAY = "#94a3b8", GREEN = "#22c55e", YELLOW = "#facc15", RED = "#ef4444", CYAN = "#22d3ee";

export function tideOf(low60Pct: number | null): TideLevel {
  if (low60Pct == null) return "calm";
  if (low60Pct >= 60) return "historic";
  if (low60Pct >= 40) return "regime";
  if (low60Pct >= 25) return "washing";
  if (low60Pct >= 12) return "soft";
  return "calm";
}

export function trendOf(close: number | null, sma50: number | null, sma200: number | null, sma50Prev: number | null): TrendLevel {
  if (close == null || sma200 == null || sma50 == null) return "flat";
  const above200 = close > sma200;
  const above50 = close > sma50;
  const rising50 = sma50Prev != null ? sma50 > sma50Prev : above50;
  if (above200 && above50 && rising50) return "strong_up";
  if (above200) return "up";
  if (!above200 && !above50 && !rising50) return "strong_down";
  if (!above200) return "down";
  return "flat";
}

export function heatOf(high60Pct: number | null, low60Pct: number | null, rsi: number | null): HeatLevel {
  const net = high60Pct != null && low60Pct != null ? high60Pct - low60Pct : null;
  if (net == null && rsi == null) return "neutral";
  const hot = (net != null && net >= 25) || (rsi != null && rsi >= 70);
  const warm = (net != null && net >= 10) || (rsi != null && rsi >= 60);
  const cold = (net != null && net <= -25) || (rsi != null && rsi <= 30);
  const cool = (net != null && net <= -10) || (rsi != null && rsi <= 40);
  if (hot) return "overheated";
  if (warm) return "warm";
  if (cold) return "frozen";
  if (cool) return "cool";
  return "neutral";
}

const TIDE_LABEL: Record<TideLevel, string> = {
  historic: "歴史的な洗い流し", regime: "レジーム級の洗い流し", washing: "洗い流し進行中",
  soft: "下げ圧力あり", calm: "平常",
};
const TREND_LABEL: Record<TrendLevel, string> = {
  strong_up: "明確な上昇トレンド", up: "長期は上向き", flat: "方向感なし",
  down: "長期は下向き", strong_down: "明確な下降",
};
const HEAT_LABEL: Record<HeatLevel, string> = {
  overheated: "過熱", warm: "やや高い", neutral: "中立", cool: "やや低い", frozen: "冷え切り",
};

/** 潮 × 傾き から局面の一言を作る (予測ではなく状態の命名) */
function headlineOf(tide: TideLevel, trend: TrendLevel, heat: HeatLevel): { headline: string; note: string } {
  if (tide === "historic" || tide === "regime") {
    return {
      headline: `🎁 ${TIDE_LABEL[tide]}`,
      note: "市場の広い範囲が同時に安値圏。実測では、この深さの後の60日リターンはベースラインを大きく上回っていました (2年で2〜3例の観察)。ただし底がここだとは誰にも分かりません。",
    };
  }
  if (tide === "washing") {
    return {
      headline: `⚠ ${TIDE_LABEL[tide]}・${TREND_LABEL[trend]}`,
      note: "1/4超の銘柄が60日安値。さらに深くなる余地も、ここで止まる可能性も両方あります。弾薬の残量を確認する局面です。",
    };
  }
  if (trend === "strong_up" && heat === "overheated") {
    return {
      headline: "🔥 上昇トレンド・過熱圏",
      note: "長期・中期とも上向きで、高値更新銘柄が多い状態。飛びつきが最も報われにくい局面でもあります (今週の検証: 動いたものへの追随は勝率39%)。",
    };
  }
  if (trend === "strong_up") return { headline: "📈 上昇トレンド継続中", note: "長期線の上、中期線も上向き。素直な地合いです。" };
  if (trend === "up") return { headline: "🌤 長期は上向き・小休止", note: "200日線の上を維持。押し目か、天井かは事後にしか分かりません。" };
  if (trend === "strong_down") return { headline: "🌧 明確な下降局面", note: "長期・中期とも下向き。反発しても戻り売りに押されやすい地合いです。" };
  if (trend === "down") return { headline: "☁ 長期は下向き", note: "200日線の下。ここでの買いは、トレンドに逆らう側になります。" };
  return { headline: "〜 方向感の乏しい相場", note: "長期線の周辺で揉み合い。動くまで待つ選択肢に価値がある局面です。" };
}

export function buildCompass(date: string, i: CompassInputs): CompassReading {
  const tide = tideOf(i.low60Pct);
  const trend = trendOf(i.nikkeiClose, i.nikkeiSma50, i.nikkeiSma200, i.nikkeiSma50Prev);
  const heat = heatOf(i.high60Pct, i.low60Pct, i.nikkeiRsi14);
  const { headline, note } = headlineOf(tide, trend, heat);

  const gauges: CompassGauge[] = [];

  // 潮
  if (i.low60Pct != null) {
    const hist = i.low60History ?? [];
    const prev = hist.length >= 6 ? hist[hist.length - 6].low60Pct : null;
    // 平常圏 (12%未満) では数ポイントの上下はノイズなので方向を言わない
    const dir =
      prev != null && (i.low60Pct >= 12 || prev >= 12)
        ? i.low60Pct > prev + 2 ? "深まっている" : i.low60Pct < prev - 2 ? "和らいでいる" : "横ばい"
        : "";
    gauges.push({
      key: "tide", emoji: "🌊", label: "潮 (洗い流し)",
      value: `${i.low60Pct}%`,
      state: TIDE_LABEL[tide],
      color: tide === "historic" || tide === "regime" ? GREEN : tide === "washing" ? YELLOW : GRAY,
      detail: `流動銘柄のうち60日安値にいる割合。25%超で「洗い流し」、40%超で「レジーム級」${dir ? ` — 1週間前と比べ${dir}` : ""}`,
    });
  }

  // 温度
  if (i.high60Pct != null || i.nikkeiRsi14 != null) {
    const net = i.high60Pct != null && i.low60Pct != null ? r1(i.high60Pct - i.low60Pct) : null;
    gauges.push({
      key: "heat", emoji: "🌡", label: "温度 (過熱度)",
      value: net != null ? `${net > 0 ? "+" : ""}${net}` : `RSI ${i.nikkeiRsi14}`,
      state: HEAT_LABEL[heat],
      color: heat === "overheated" ? RED : heat === "warm" ? YELLOW : heat === "frozen" ? CYAN : GRAY,
      detail: `高値更新銘柄の割合 − 安値更新銘柄の割合${i.nikkeiRsi14 != null ? ` (日経RSI ${i.nikkeiRsi14})` : ""}。プラスが大きいほど買われている状態`,
    });
  }

  // 傾き
  if (i.nikkeiClose != null && i.nikkeiSma200 != null) {
    const gap = r1(((i.nikkeiClose - i.nikkeiSma200) / i.nikkeiSma200) * 100);
    gauges.push({
      key: "trend", emoji: "📐", label: "傾き (長期トレンド)",
      value: `${gap > 0 ? "+" : ""}${gap}%`,
      state: TREND_LABEL[trend],
      color: trend === "strong_up" || trend === "up" ? GREEN : trend === "flat" ? GRAY : RED,
      detail: "日経平均と200日移動平均線の乖離。プラスなら長期上昇基調、マイナスなら下降基調の中にいる",
    });
  }

  // 割安の水位
  if (i.netCashFortressCount != null) {
    gauges.push({
      key: "value", emoji: "💎", label: "割安の水位",
      value: `${i.netCashFortressCount}銘柄`,
      state: i.netCashFortressCount >= 300 ? "在庫潤沢" : i.netCashFortressCount >= 150 ? "そこそこ" : "品薄",
      color: i.netCashFortressCount >= 300 ? GREEN : GRAY,
      detail: "ネットキャッシュ比率1以上 (時価総額 < 手元資産) の銘柄数。市場が悲観的なほど増える清原軸の在庫量",
    });
  }

  // 自分の位置
  if (i.cashRatioPct != null) {
    gauges.push({
      key: "self", emoji: "🧍", label: "自分の位置",
      value: `現金${i.cashRatioPct}%`,
      state: i.portfolioBeta != null ? `β${i.portfolioBeta}` : "—",
      color: CYAN,
      detail: `弾薬の残量と、市場に対する感応度。洗い流しが来た時に動けるかはここで決まる`,
    });
  }

  return { date, headline, headlineNote: note, gauges, trend, tide, heat };
}

/** 日経の終値配列から SMA / RSI を計算 (純関数) */
export function sma(closes: number[], n: number, offsetFromEnd = 0): number | null {
  const end = closes.length - offsetFromEnd;
  if (end < n) return null;
  const slice = closes.slice(end - n, end);
  return slice.reduce((a, b) => a + b, 0) / n;
}

export function rsi14(closes: number[]): number | null {
  if (closes.length < 15) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  if (gain + loss === 0) return 50;
  const rs = gain / 14 / (loss / 14 || 1e-9);
  return Math.round(100 - 100 / (1 + rs));
}
