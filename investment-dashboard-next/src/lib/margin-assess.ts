/**
 * 需給の温度計 — 信用残・逆日歩・貸借倍率を「人間の読み方」に言語化する純関数。
 *
 * 核になる考え方は2つだけ:
 * ・買残 = いつか必ず売られる玉 (将来の売り圧力)
 * ・売残 = いつか必ず買い戻される玉 (将来の買い圧力)
 * これを信用倍率・逆日歩・前週比の変化で味付けして読む。断定でなく仮説の材料。投資助言ではない。
 */

import {
  type Commentary,
  type CommentaryLine,
  C_UP,
  C_DOWN,
  C_NEUTRAL,
  C_WARN,
} from "./commentary";

export interface MarginAssessInput {
  /** 買残 (株) */
  longTotal: number | null;
  /** 買残 前週比 (株) */
  longChangeTotal: number | null;
  /** 売残 (株) */
  shortTotal: number | null;
  /** 売残 前週比 (株) */
  shortChangeTotal: number | null;
  /** 信用倍率 (買残/売残) */
  ratioTotal: number | null;
  /** 逆日歩 (¥/株/日)。0以下 or null = なし */
  hibuRate: number | null;
  /** 貸借倍率 (証金) */
  syoukinRatio: number | null;
  /** 週間の株価変化率 (%)。取れなければ null — 買残増の意味の出し分けに使う */
  weeklyChangePct?: number | null;
}

export function assessMargin(m: MarginAssessInput): Commentary | null {
  const lines: CommentaryLine[] = [];
  const terms: string[] = ["信用取引"];

  const ratio = m.ratioTotal;
  const hibu = (m.hibuRate ?? 0) > 0 ? m.hibuRate! : null;
  const hasData = ratio != null || m.longTotal != null || m.shortTotal != null;
  if (!hasData) return null;

  // ── 見出し: 需給の型 ──
  let temp: Commentary["temp"];
  let stance: string;
  const squeezy = (ratio != null && ratio < 1) || hibu != null;
  const heavyLong = ratio != null && ratio >= 10;

  if (squeezy) {
    temp = { label: "踏み上げ含み (売り方不利)", emoji: "🔥", color: C_UP };
    stance =
      "空売りが混んでいる。株価が上がり出すと売り方の損切り (買い戻し) が燃料になって急騰しやすい反面、値動きは荒くなる。順張りで乗るなら小さく、逆張りの空売りは危険地帯。";
  } else if (heavyLong) {
    temp = { label: "買い長 (上値重め)", emoji: "⚖", color: C_WARN };
    stance =
      "信用買いが積み上がっている。上には「早く逃げたい人の売り」が控えるため、上値が重く戻り売りに押されやすい。買うなら買残の整理が進むのを待つ選択肢も。";
  } else {
    temp = { label: "需給は概ね中立", emoji: "🌊", color: C_NEUTRAL };
    stance = "信用残から強い偏りは読み取れない。需給よりも業績・地合いが主導する局面。";
  }

  // ── 信用倍率 ──
  if (ratio != null) {
    if (ratio < 1) {
      lines.push({
        icon: "🔥",
        tone: "pos",
        text: `信用倍率 ${ratio.toFixed(2)}倍 = 売残が買残より多い逆転状態。売り方は全員「いつか買い戻す義務」があるので、上昇が始まると買い戻しの連鎖 (踏み上げ) の素地になる。`,
      });
      terms.push("信用倍率", "踏み上げ");
    } else if (ratio < 3) {
      lines.push({
        icon: "◦",
        tone: "neutral",
        text: `信用倍率 ${ratio.toFixed(2)}倍 = 買いと売りのバランスが取れた健全圏 (1〜3倍が目安)。`,
      });
      terms.push("信用倍率");
    } else if (ratio < 10) {
      lines.push({
        icon: "⚖",
        tone: "neutral",
        text: `信用倍率 ${ratio.toFixed(2)}倍 = 買い方がやや優勢。信用で買った人はいずれ売って返すので、この分の売り圧力が上値に乗っている。`,
      });
      terms.push("信用倍率", "買残");
    } else {
      lines.push({
        icon: "⚠",
        tone: "warn",
        text: `信用倍率 ${ratio.toFixed(2)}倍 = 極端な買い偏重。株価が上がるたびに利確売り、下がるたびに投げ売りが出やすい「上値の重い」需給。急騰には売り圧力の消化が必要。`,
      });
      terms.push("信用倍率", "買残");
    }
  }

  // ── 買残の変化 (前週比) ──
  if (m.longChangeTotal != null && m.longTotal != null && m.longTotal > 0) {
    const chgPct = (m.longChangeTotal / Math.max(m.longTotal - m.longChangeTotal, 1)) * 100;
    if (chgPct >= 10) {
      const falling = (m.weeklyChangePct ?? 0) < 0;
      lines.push({
        icon: falling ? "⚠" : "📈",
        tone: falling ? "warn" : "neutral",
        text: falling
          ? `買残が前週比 +${chgPct.toFixed(0)}% と急増、しかも株価は下落中 = 「安くなったから」の逆張り買いが溜まっている。この層は戻ると売ってくるので、反発しても上値が重くなりやすい。`
          : `買残が前週比 +${chgPct.toFixed(0)}% と増加。上昇に飛び乗った信用買いが積み上がっており、将来の売り圧力も同時に増えている。`,
      });
      terms.push("買残");
    } else if (chgPct <= -10) {
      lines.push({
        icon: "🧹",
        tone: "pos",
        text: `買残が前週比 ${chgPct.toFixed(0)}% と減少 = 信用買いの整理 (利確・投げ) が進んだ。しこりが減って上値が軽くなる方向。`,
      });
      terms.push("買残");
    }
  }

  // ── 売残の変化 (前週比) ──
  if (m.shortChangeTotal != null && m.shortTotal != null && m.shortTotal > 0) {
    const chgPct = (m.shortChangeTotal / Math.max(m.shortTotal - m.shortChangeTotal, 1)) * 100;
    if (chgPct >= 20) {
      lines.push({
        icon: "🐻",
        tone: "neutral",
        text: `売残が前週比 +${chgPct.toFixed(0)}% と急増 = 「下がる」に張る空売りが増えた。弱気のサインである一方、この全員が将来の買い戻し予備軍でもある (上がれば踏み上げ燃料)。`,
      });
      terms.push("売残");
    }
  }

  // ── 逆日歩 ──
  if (hibu != null) {
    lines.push({
      icon: "💸",
      tone: "warn",
      text: `逆日歩 ¥${hibu}/株/日 が発生中 = 空売り用の株が足りないほど売りが混んでいる。売り方は保有コストを毎日払わされるため長く粘れない = 買い戻しを急ぎやすい。`,
    });
    terms.push("逆日歩");
  }

  // ── 貸借倍率 ──
  if (m.syoukinRatio != null && m.syoukinRatio > 0 && m.syoukinRatio < 1) {
    lines.push({
      icon: "🩸",
      tone: "warn",
      text: `貸借倍率 ${m.syoukinRatio.toFixed(2)} (1倍割れ) = 株不足の兆候。逆日歩の発生や踏み上げにつながりやすい状態。`,
    });
    terms.push("貸借倍率");
  }

  if (lines.length === 0) return null;

  void C_DOWN;

  const caveat =
    "信用残は週1回 (火曜公表・前週金曜時点) の古いデータ。今日の需給そのものではない。また現物の大口売買はここに写らない。これは需給の読み方の説明で、売買の推奨ではありません。";

  return { temp, stance, lines, terms, caveat };
}
