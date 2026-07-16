/**
 * テクニカルの温度計 — RSI / MACD / ボリンジャー / 移動平均 を「人間の読み方」に言語化する純関数。
 *
 * 数字の意味が分からない人向けに、各指標が「今どういう状態で、何を示唆するか」を
 * 平易な言葉で出す。断定でなく仮説の材料。投資助言ではない。
 */

import {
  type Commentary,
  type CommentaryLine,
  C_UP,
  C_DOWN,
  C_NEUTRAL,
} from "./commentary";

export interface TechnicalInput {
  price: number | null;
  rsi: number | null;
  macd: number | null;
  signal: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  bbUpper: number | null;
  bbLower: number | null;
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString()}`;

export function assessTechnical(t: TechnicalInput): Commentary | null {
  const lines: CommentaryLine[] = [];
  const terms: string[] = [];
  const price = t.price;

  // ── トレンドの向き (移動平均の並び) をまず判定 → 見出しの土台 ──
  // 上昇トレンド: price > SMA20 > SMA50 (パーフェクトオーダー気味)
  // 下降トレンド: price < SMA20 < SMA50
  let trendScore = 0; // + で強気, - で弱気
  if (price != null && t.sma20 != null) trendScore += price >= t.sma20 ? 1 : -1;
  if (price != null && t.sma50 != null) trendScore += price >= t.sma50 ? 1 : -1;
  if (t.sma20 != null && t.sma50 != null) trendScore += t.sma20 >= t.sma50 ? 1 : -1;
  if (price != null && t.sma200 != null) trendScore += price >= t.sma200 ? 0.5 : -0.5;

  let temp: Commentary["temp"];
  let stance: string;
  if (trendScore >= 2) {
    temp = { label: "上昇トレンド", emoji: "📈", color: C_UP };
    stance = "移動平均が上向きの並び。押し目 (一時的な下げ) を拾う戦略が基本の地合い。";
  } else if (trendScore <= -2) {
    temp = { label: "下降トレンド", emoji: "📉", color: C_DOWN };
    stance = "移動平均が下向きの並び。戻り (一時的な上げ) は売られやすい。逆張りの買いは慎重に。";
  } else {
    temp = { label: "方向感なし (もみ合い)", emoji: "➡️", color: C_NEUTRAL };
    stance = "トレンドがはっきりしない。ブレイクの方向が出るまで様子見が無難。";
  }

  // ── RSI ──
  if (t.rsi != null) {
    const r = t.rsi;
    if (r >= 70) {
      lines.push({
        icon: "🔴",
        tone: "warn",
        text: `RSI ${r.toFixed(0)} = 買われすぎ圏 (70以上)。短期的に過熱。ここから急落・調整が入りやすい。「上がってるから買う」が一番危ない位置。`,
      });
    } else if (r <= 30) {
      lines.push({
        icon: "🔵",
        tone: "warn",
        text: `RSI ${r.toFixed(0)} = 売られすぎ圏 (30以下)。短期的に売られ過ぎ。反発 (リバウンド) が出やすいが、下落トレンド中はさらに沈むこともある。`,
      });
    } else if (r >= 55) {
      lines.push({ icon: "◦", tone: "pos", text: `RSI ${r.toFixed(0)} = やや強い中立 (50〜70)。買いの勢いがある通常運転。` });
    } else if (r <= 45) {
      lines.push({ icon: "◦", tone: "neg", text: `RSI ${r.toFixed(0)} = やや弱い中立 (30〜50)。売りの勢いがある通常運転。` });
    } else {
      lines.push({ icon: "◦", tone: "neutral", text: `RSI ${r.toFixed(0)} = 中立 (50付近)。買われすぎでも売られすぎでもない。` });
    }
    terms.push("RSI");
  }

  // ── MACD ──
  if (t.macd != null && t.signal != null) {
    const diff = t.macd - t.signal;
    const above = diff >= 0;
    lines.push({
      icon: above ? "↗" : "↘",
      tone: above ? "pos" : "neg",
      text: above
        ? `MACD がシグナルより上 (${t.macd.toFixed(2)} > ${t.signal.toFixed(2)})。短〜中期の勢いは上向き。買いサイン寄り。`
        : `MACD がシグナルより下 (${t.macd.toFixed(2)} < ${t.signal.toFixed(2)})。短〜中期の勢いは下向き。売りサイン寄り。`,
    });
    // ゼロライン
    if (t.macd > 0 && !above) {
      lines.push({ icon: "⚠", tone: "warn", text: "MACD はプラス圏だがシグナルを下抜け。上昇の勢いが鈍り始めたサインのことがある。" });
    }
    terms.push("MACD", "シグナル線");
  } else if (t.macd != null) {
    lines.push({
      icon: t.macd >= 0 ? "↗" : "↘",
      tone: t.macd >= 0 ? "pos" : "neg",
      text: `MACD ${t.macd.toFixed(2)} (${t.macd >= 0 ? "プラス=上向き基調" : "マイナス=下向き基調"})。`,
    });
  }

  // ── ボリンジャーバンド (現在値の位置) ──
  if (t.bbUpper != null && t.bbLower != null && price != null && t.bbUpper > t.bbLower) {
    const pos = ((price - t.bbLower) / (t.bbUpper - t.bbLower)) * 100;
    if (price >= t.bbUpper) {
      lines.push({ icon: "🔴", tone: "warn", text: `株価が上バンド (${yen(t.bbUpper)}) にタッチ/超過。統計的に行き過ぎの上限。反落 or 強い上昇継続の分岐点。` });
    } else if (price <= t.bbLower) {
      lines.push({ icon: "🔵", tone: "warn", text: `株価が下バンド (${yen(t.bbLower)}) にタッチ/割れ。統計的に行き過ぎの下限。反発 or 急落継続の分岐点。` });
    } else {
      lines.push({ icon: "◦", tone: "neutral", text: `株価はバンドの${pos >= 50 ? "上" : "下"}寄り (下端から${pos.toFixed(0)}%)。バンド内=通常の変動範囲。` });
    }
    terms.push("ボリンジャーバンド");
  }

  // ── 移動平均線の具体位置 (支え・抵抗) ──
  if (price != null && t.sma20 != null) {
    const gap = ((price - t.sma20) / t.sma20) * 100;
    lines.push({
      icon: price >= t.sma20 ? "▲" : "▼",
      tone: price >= t.sma20 ? "pos" : "neg",
      text: `現在値は 20日線 (${yen(t.sma20)}) の${price >= t.sma20 ? "上" : "下"} (${gap >= 0 ? "+" : ""}${gap.toFixed(1)}%)。20日線は短期の${price >= t.sma20 ? "支え" : "抵抗"}になりやすい。`,
    });
    terms.push("移動平均線");
  }
  if (price != null && t.sma200 != null) {
    lines.push({
      icon: price >= t.sma200 ? "▲" : "▼",
      tone: price >= t.sma200 ? "pos" : "neg",
      text: `200日線 (${yen(t.sma200)}) の${price >= t.sma200 ? "上=長期は上昇基調" : "下=長期は下降基調"}。長期投資家が最も重視する分岐線。`,
    });
    terms.push("200日線");
  }

  if (lines.length === 0) return null;

  const caveat =
    "テクニカルは「過去の値動きの型」であって未来の保証ではない。複数の指標が同じ方向を示す時ほど信頼度が上がる。これは指標の読み方の説明で、売買の推奨ではありません。";

  return { temp, stance, lines, terms, caveat };
}
