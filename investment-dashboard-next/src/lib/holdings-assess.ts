/**
 * 大口動向の温度計 — EDINET 大量保有報告 (5%ルール) を「人間の読み方」に言語化する純関数。
 *
 * 読み方の核: 大量保有報告は「大口が本気で張った/降りた」の公式記録。
 * ただし提出は最大5営業日遅れ = 公表時には動きが終わっていることもある。
 * 断定でなく仮説の材料。投資助言ではない。
 */

import {
  type Commentary,
  type CommentaryLine,
  C_GOOD,
  C_DOWN,
  C_NEUTRAL,
} from "./commentary";

export interface HoldingsAssessInput {
  totalFilings: number;
  uniqueFilers: number;
  newFilers: number;
  increasing: number;
  decreasing: number;
  /** 集計対象の日数 (例: 60) */
  windowDays: number;
}

export function assessLargeHoldings(s: HoldingsAssessInput): Commentary | null {
  if (s.totalFilings === 0) return null;

  const lines: CommentaryLine[] = [];
  const terms: string[] = ["大量保有報告"];

  // ── 見出し ──
  let temp: Commentary["temp"];
  let stance: string;
  if (s.increasing > s.decreasing && s.increasing > 0) {
    temp = { label: "大口の買い集め優勢", emoji: "🏛", color: C_GOOD };
    stance =
      "直近は機関投資家の買い増しが売りを上回る。大口が「この会社に張る」と判断した形跡。ただし提出遅れの分、既に株価に織り込まれている可能性は差し引く。";
  } else if (s.decreasing > s.increasing) {
    temp = { label: "大口の売り優勢", emoji: "🚪", color: C_DOWN };
    stance =
      "大口が持ち分を減らしている。売り切るまで断続的に売りが出て上値を抑えることがある。買うなら「誰の売りがいつ終わるか」を意識。";
  } else {
    temp = { label: "大口の出入りあり (中立)", emoji: "🔁", color: C_NEUTRAL };
    stance = "買いと売りが拮抗。大口の注目は集めているが方向はまだ読めない。";
  }

  // ── 新規5%超え ──
  if (s.newFilers > 0) {
    lines.push({
      icon: "🆕",
      tone: "pos",
      text: `新規に5%超を取得した大口が ${s.newFilers} 者。5%は「片手間の投資」では届かない水準で、調査と確信を持って入った買いであることが多い。誰か (アクティビスト/事業会社/ファンド) で意味が大きく変わる。`,
    });
  }

  // ── 買い増し / 売り ──
  if (s.increasing > 0) {
    lines.push({
      icon: "🟢",
      tone: "pos",
      text: `買い増し報告 ${s.increasing} 件 = 5%からさらに積み増した動き。継続的な買い需要が入っている証拠で、床 (下値) を作りやすい。`,
    });
  }
  if (s.decreasing > 0) {
    lines.push({
      icon: "🔴",
      tone: "neg",
      text: `売り報告 ${s.decreasing} 件 = 大口が持ち分を削っている。理由は利確・資金繰り・見切りなど様々だが、売り切るまで需給の重しになりやすい。`,
    });
  }

  // ── 注目度 ──
  lines.push({
    icon: "👀",
    tone: "neutral",
    text: `直近${s.windowDays}日で ${s.uniqueFilers} 者から ${s.totalFilings} 件の報告。件数が多い銘柄ほど大口の関心が高く、売買の主役が個人でなく機関になっている可能性が高い。`,
  });

  const caveat =
    "提出は義務発生から最大5営業日遅れ — 報告を見た時には動きが終わっていることもある。保有目的 (純投資か経営参加か) や共同保有の中身までは、ここの件数だけでは分からない。売買の推奨ではありません。";

  return { temp, stance, lines, terms, caveat };
}
