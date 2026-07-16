/**
 * 自動解説 (◯◯の温度計) の共通データ型。
 * 板・テクニカル・業績など、数値の羅列を「人間の読み方」に言語化する各アセッサが
 * この形を返し、共通コンポーネント <CommentaryPanel> が描画する。
 * 断定でなく「仮説の材料」。投資助言ではない。
 */

export type Tone = "pos" | "neg" | "neutral" | "warn";

export interface CommentaryLine {
  icon: string;
  text: string;
  tone: Tone;
}

export interface Commentary {
  /** 見出しの温度感 */
  temp: { label: string; emoji: string; color: string };
  /** 規律的な一言スタンス */
  stance: string;
  /** 箇条書きの読み解き */
  lines: CommentaryLine[];
  /** 本文で使った専門用語のキー (glossary.ts)。用語メモとして注釈表示する */
  terms?: string[];
  /** 常に添える注意書き */
  caveat: string;
}

// トーン → 色 (共通)
export const TONE_COLOR: Record<Tone, string> = {
  pos: "#ff3b6b", // 日本式: 上げ/強気は赤
  neg: "#00d9ff", // 下げ/弱気は水色
  warn: "#ffb020",
  neutral: "var(--color-text-secondary)",
};

// よく使う色
export const C_UP = "#ff3b6b";
export const C_DOWN = "#00d9ff";
export const C_NEUTRAL = "#8892b0";
export const C_WARN = "#ffb020";
export const C_GOOD = "#22c55e";
