/**
 * 板の温度計 — 板情報 (気配) を「人間の読み方」に言語化する純関数。
 *
 * 立花APIのスナップショット (SnapshotQuote) を入力に、
 * ・全体の状況 (下落中/上昇中/膠着 の文脈)
 * ・買い/売り厚みの偏りの意味 (順張り/逆張り警戒の出し分け)
 * ・支え/抵抗になりそうな大口の価格帯
 * ・板薄・スプレッド・クライマックス等の注意
 * を出す。断定ではなく「仮説の材料」として読ませる。投資助言ではない。
 *
 * 意図的に quote 全体でなく必要フィールドだけ受け取る (テスト容易性)。
 */

import { type Commentary, type CommentaryLine, C_UP as UP, C_DOWN as DOWN, C_NEUTRAL as NEUTRAL } from "./commentary";

export interface BookLevel {
  price: number | null;
  quantity: number | null;
}

export interface BookInput {
  currentPrice: number | null;
  changePct: number | null;
  vwap: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  bids: BookLevel[]; // 最良→最深
  asks: BookLevel[]; // 最良→最深
}

function biggest(levels: BookLevel[]): BookLevel | null {
  let best: BookLevel | null = null;
  for (const l of levels) {
    if (l.price == null || l.quantity == null) continue;
    if (!best || (l.quantity ?? 0) > (best.quantity ?? 0)) best = l;
  }
  return best;
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString()}`;
const qty = (n: number) => `${Math.round(n).toLocaleString()}株`;

export function assessOrderBook(q: BookInput): Commentary | null {
  const price = q.currentPrice;
  if (price == null) return null;
  const terms: string[] = ["板", "見せ板"];

  const bids = q.bids.filter((b) => b.price != null && b.quantity != null);
  const asks = q.asks.filter((a) => a.price != null && a.quantity != null);

  const totalBid = bids.reduce((s, b) => s + (b.quantity ?? 0), 0);
  const totalAsk = asks.reduce((s, a) => s + (a.quantity ?? 0), 0);
  const totalBoth = totalBid + totalAsk;
  const bidPct = totalBoth > 0 ? (totalBid / totalBoth) * 100 : 50;

  const chg = q.changePct ?? 0;
  const falling = chg <= -3;
  const surging = chg >= 3;
  const bigFall = chg <= -7;
  const bigSurge = chg >= 7;

  const lines: CommentaryLine[] = [];

  // ── 1. 全体の状況 (最初に文脈を固定) ──
  let temp: Commentary["temp"];
  let stance: string;
  if (bigFall) {
    temp = { label: "急落中", emoji: "🔻", color: DOWN };
    stance = "落下の最中。支えが本物か消えるかを見極めるまで手を出さないのが規律的。";
  } else if (falling) {
    temp = { label: "下落中", emoji: "🔵", color: DOWN };
    stance = "売り優勢の地合い。反発を確認してからでも遅くない。";
  } else if (bigSurge) {
    temp = { label: "急騰中", emoji: "🔺", color: UP };
    stance = "噴き上げの最中。高値掴みに注意。押し目を待つ選択肢も。";
  } else if (surging) {
    temp = { label: "上昇中", emoji: "🔴", color: UP };
    stance = "買い優勢の地合い。上値抵抗と勢いの持続を確認。";
  } else {
    temp = { label: "膠着", emoji: "⚪", color: NEUTRAL };
    stance = "方向感は乏しい。ブレイクの方向を待つ局面。";
  }

  // ── 2. 買い/売り厚みの偏り (文脈で意味を出し分け) ──
  const imbalanced = Math.abs(bidPct - 50) >= 15;
  if (bidPct >= 65) {
    if (falling) {
      lines.push({
        icon: "⚠",
        tone: "warn",
        text: `買い板が厚い (買${bidPct.toFixed(0)}%) が、${chg.toFixed(1)}% 下落中。落ちるナイフを掴もうとする買いが多い状態で、この買い板が約定で消えると一段下も。厚み=下値の堅さと即断しない。`,
      });
      terms.push("買い厚み", "落ちるナイフ");
    } else {
      lines.push({
        icon: "↗",
        tone: "pos",
        text: `買い板が厚い (買${bidPct.toFixed(0)}% / ${qty(totalBid)})。下値は当面堅めだが、大口は見せ板で引っ込むこともある。`,
      });
    }
  } else if (bidPct <= 35) {
    if (surging) {
      lines.push({
        icon: "⚠",
        tone: "warn",
        text: `売り板が厚い (売${(100 - bidPct).toFixed(0)}%) のに上昇中。戻り売りに押されやすく、上値は重い。`,
      });
    } else {
      lines.push({
        icon: "↘",
        tone: "neg",
        text: `売り板が厚い (売${(100 - bidPct).toFixed(0)}% / ${qty(totalAsk)})。上値は重め。`,
      });
    }
  } else {
    lines.push({
      icon: "◦",
      tone: "neutral",
      text: `買い${bidPct.toFixed(0)}% / 売り${(100 - bidPct).toFixed(0)}% で拮抗。厚みからの偏りは小さい。`,
    });
  }
  void imbalanced;

  // ── 3. 支え / 抵抗になりそうな大口 ──
  const supportWall = biggest(bids);
  const resistWall = biggest(asks);
  const bidAvg = bids.length ? totalBid / bids.length : 0;
  const askAvg = asks.length ? totalAsk / asks.length : 0;

  if (supportWall?.price != null && supportWall.quantity != null && supportWall.quantity >= bidAvg * 2) {
    lines.push({
      icon: "🛡",
      tone: "neutral",
      text: `${yen(supportWall.price)} に大きな買い板 (${qty(supportWall.quantity)})。当面の下値メド候補。出来高を伴ってここを割ったら「支え崩れ」のサイン。`,
    });
    terms.push("支え");
  }
  if (resistWall?.price != null && resistWall.quantity != null && resistWall.quantity >= askAvg * 2) {
    lines.push({
      icon: "🧱",
      tone: "neutral",
      text: `${yen(resistWall.price)} に大きな売り板 (${qty(resistWall.quantity)})。戻す時の上値抵抗になりやすい。`,
    });
    terms.push("抵抗");
  }

  // ── 4. VWAP との位置 (日中の優劣) ──
  if (q.vwap != null && q.vwap > 0) {
    const diff = ((price - q.vwap) / q.vwap) * 100;
    if (Math.abs(diff) >= 0.3) {
      lines.push(
        diff > 0
          ? { icon: "▲", tone: "pos", text: `現在値は VWAP (${yen(q.vwap)}) より上。日中に買った人は平均で含み益 = 買い優勢。` }
          : { icon: "▼", tone: "neg", text: `現在値は VWAP (${yen(q.vwap)}) より下。日中に買った人は平均で含み損 = 戻り売りが出やすい。` }
      );
      terms.push("VWAP");
    }
  }

  // ── 5. 日中レンジ内の位置 ──
  if (q.highPrice != null && q.lowPrice != null && q.highPrice > q.lowPrice) {
    const pos = ((price - q.lowPrice) / (q.highPrice - q.lowPrice)) * 100;
    if (pos <= 15) {
      lines.push({ icon: "⬇", tone: "neg", text: `本日安値圏 (レンジ下端 ${pos.toFixed(0)}%)。安値更新なら下落継続のサイン。` });
    } else if (pos >= 85) {
      lines.push({ icon: "⬆", tone: "pos", text: `本日高値圏 (レンジ上端 ${pos.toFixed(0)}%)。高値更新なら勢い継続。` });
    }
  }

  // ── 6. 板薄 / スプレッド注意 ──
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  if (bestBid != null && bestAsk != null && bestAsk > bestBid) {
    const spreadPct = ((bestAsk - bestBid) / price) * 100;
    if (spreadPct >= 0.5) {
      lines.push({
        icon: "↔",
        tone: "warn",
        text: `最良買い ${yen(bestBid)} / 最良売り ${yen(bestAsk)} とスプレッドが広い (${spreadPct.toFixed(2)}%)。成行だと不利な値で約定しやすい。`,
      });
    }
  }
  if (totalBoth > 0 && totalBoth < 3000) {
    lines.push({
      icon: "🪶",
      tone: "warn",
      text: `板全体が薄い (${qty(totalBoth)})。少しの注文で価格が飛びやすく、スリッページに注意。`,
    });
  }

  const caveat =
    "板は数秒で変わる「今の需給の写真」。見せ板 (すぐ引っ込む大口) の可能性もあり、厚みだけを信じないこと。これは板の読み方の説明で、売買の推奨ではありません。";

  return { temp, stance, lines, terms, caveat };
}
