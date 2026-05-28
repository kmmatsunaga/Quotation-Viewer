/**
 * 適時開示イベント検出 (Phase 3a)
 *
 * 立花のニュースヘッドラインからキーワードで TDnet 系の重要イベントを分類。
 * Gemini 不要、ルールベースなので高速・無料・決定論的。
 *
 * 検出するイベント:
 *   - 業績予想の上方/下方修正
 *   - 配当予想の増配/減配
 *   - 自社株買い発表
 *   - 株式分割
 *   - 業務提携 / M&A
 *   - 不祥事 / 訴訟
 *
 * ニュース感情 (Phase 4) と併用することで「明示的イベント + 一般感情」の二段構え。
 */
import type { TachibanaNewsHeader } from "./tachibana";

export type DisclosureType =
  | "earnings_revision_up"
  | "earnings_revision_down"
  | "dividend_up"
  | "dividend_down"
  | "buyback"
  | "split"
  | "alliance"
  | "ma_acquirer"
  | "ma_target"
  | "scandal"
  | "lawsuit"
  | "other";

export interface DisclosureEvent {
  newsId: string;
  date: string;        // YYYYMMDD
  type: DisclosureType;
  headline: string;
  impact: "positive" | "negative" | "neutral";
  weight: number;      // 1-10 (株価へのインパクトの強さ)
}

export interface DisclosureSummary {
  ticker: string;
  events: DisclosureEvent[];      // 直近30日のイベント
  counts: Record<DisclosureType, number>;
  score: number;                   // -100 〜 +100
  latestUpRevision: DisclosureEvent | null;
  latestDownRevision: DisclosureEvent | null;
  hasCriticalNegative: boolean;    // 不祥事/訴訟など
  computedAt: string;
}

interface Rule {
  type: DisclosureType;
  impact: "positive" | "negative" | "neutral";
  weight: number;
  patterns: RegExp[];
}

/**
 * 分類ルール (上から順にマッチ判定)
 *   日本語の表記ゆれを考慮:
 *     - 「業績予想の修正」「業績予想の上方修正」「上方修正のお知らせ」
 *     - 「自社株式の取得」「自己株式取得」「自社株買い」
 */
const RULES: Rule[] = [
  // 不祥事系 (最優先で検出)
  {
    type: "scandal",
    impact: "negative",
    weight: 10,
    patterns: [
      /不祥事|不正|改竄|改ざん|粉飾|虚偽記載|社内調査|第三者委員会|内部統制報告書.*意見不表明/,
      /行政処分|業務停止命令|是正勧告|課徴金/,
      /品質問題|リコール.*重大/,
    ],
  },
  {
    type: "lawsuit",
    impact: "negative",
    weight: 7,
    patterns: [/訴訟提起|提訴|集団訴訟|損害賠償.*請求/],
  },

  // 業績修正 (一番効くカタリスト)
  {
    type: "earnings_revision_up",
    impact: "positive",
    weight: 9,
    patterns: [
      /業績予想.*上方修正/,
      /(通期|連結).*業績予想.*修正.*(増益|増収)/,
      /上方修正(のお知らせ|について|に関する)/,
    ],
  },
  {
    type: "earnings_revision_down",
    impact: "negative",
    weight: 9,
    patterns: [
      /業績予想.*下方修正/,
      /(通期|連結).*業績予想.*修正.*(減益|減収)/,
      /下方修正(のお知らせ|について|に関する)/,
      /特別損失.*計上/,
      /減損損失.*計上/,
    ],
  },

  // 配当修正
  {
    type: "dividend_up",
    impact: "positive",
    weight: 6,
    patterns: [
      /配当予想.*修正.*(増配|引上げ|引き上げ)/,
      /剰余金の配当.*増配/,
      /記念配当|特別配当/,
      /増配のお知らせ/,
    ],
  },
  {
    type: "dividend_down",
    impact: "negative",
    weight: 7,
    patterns: [
      /配当予想.*修正.*(減配|引下げ|引き下げ)/,
      /無配転落|無配化/,
      /減配のお知らせ/,
    ],
  },

  // 自社株買い (大型のものは強気シグナル)
  {
    type: "buyback",
    impact: "positive",
    weight: 7,
    patterns: [
      /自社株式の取得|自己株式の取得|自社株買い/,
      /自己株式取得.*に関する事項の決定/,
    ],
  },

  // 株式分割
  {
    type: "split",
    impact: "positive",
    weight: 5,
    patterns: [/株式分割(のお知らせ|に関する|について)/],
  },

  // M&A
  {
    type: "ma_acquirer",
    impact: "positive",
    weight: 6,
    patterns: [
      /(株式|完全)子会社化/,
      /TOB(の|に|を)|公開買付/,
      /株式取得.*連結子会社/,
    ],
  },
  {
    type: "ma_target",
    impact: "positive",
    weight: 8,
    patterns: [
      /(当社株式|当社に対する).*公開買付/,
      /MBO(に関する|のお知らせ)/,
    ],
  },

  // 業務提携
  {
    type: "alliance",
    impact: "positive",
    weight: 4,
    patterns: [/業務提携|資本業務提携|戦略的提携/],
  },
];

const ALL_TYPES: DisclosureType[] = [
  "earnings_revision_up",
  "earnings_revision_down",
  "dividend_up",
  "dividend_down",
  "buyback",
  "split",
  "alliance",
  "ma_acquirer",
  "ma_target",
  "scandal",
  "lawsuit",
  "other",
];

/**
 * 単一ヘッドラインを分類。
 * マッチしないものは null (other は明示的にマッチしたものだけ)。
 */
export function classifyHeadline(headline: string): { type: DisclosureType; impact: "positive" | "negative" | "neutral"; weight: number } | null {
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(headline)) {
        return { type: rule.type, impact: rule.impact, weight: rule.weight };
      }
    }
  }
  return null;
}

/**
 * 立花ニュースヘッダ配列から ticker 関連の開示イベントを抽出してサマリ生成。
 */
export function summarizeDisclosures(
  ticker: string,
  headers: TachibanaNewsHeader[]
): DisclosureSummary {
  // ticker 関連のみ
  const relevant = headers.filter((h) => h.relatedTickers.includes(ticker));

  const events: DisclosureEvent[] = [];
  for (const h of relevant) {
    const matched = classifyHeadline(h.headline);
    if (matched) {
      events.push({
        newsId: h.id,
        date: h.date,
        type: matched.type,
        headline: h.headline,
        impact: matched.impact,
        weight: matched.weight,
      });
    }
  }

  // カウント
  const counts = Object.fromEntries(ALL_TYPES.map((t) => [t, 0])) as Record<DisclosureType, number>;
  for (const e of events) counts[e.type]++;

  // 時間減衰加重スコア (新しいイベントほど重視)
  const today = new Date();
  const todayKey = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  let weighted = 0;
  for (const e of events) {
    const daysAgo = Math.max(0, daysBetween(e.date, todayKey));
    const decay = Math.pow(0.92, daysAgo);  // 7日前=0.56, 30日前=0.08
    const sign = e.impact === "positive" ? 1 : e.impact === "negative" ? -1 : 0;
    weighted += sign * e.weight * decay;
  }
  // [-100, +100] にクリップ (重み合計はせいぜい 50 程度なので 2倍してスケール)
  const score = Math.max(-100, Math.min(100, Math.round(weighted * 2)));

  const latestUpRevision =
    events.filter((e) => e.type === "earnings_revision_up").sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
  const latestDownRevision =
    events.filter((e) => e.type === "earnings_revision_down").sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
  const hasCriticalNegative = events.some((e) => e.type === "scandal" || e.type === "lawsuit");

  return {
    ticker,
    events,
    counts,
    score,
    latestUpRevision,
    latestDownRevision,
    hasCriticalNegative,
    computedAt: new Date().toISOString(),
  };
}

function daysBetween(d1: string, d2: string): number {
  const p = (s: string) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`).getTime();
  return Math.round((p(d2) - p(d1)) / 86400000);
}

// 表示用ヘルパー
export const DISCLOSURE_LABELS: Record<DisclosureType, string> = {
  earnings_revision_up: "📈 上方修正",
  earnings_revision_down: "📉 下方修正",
  dividend_up: "💴 増配",
  dividend_down: "💸 減配",
  buyback: "🔄 自社株買い",
  split: "🪓 株式分割",
  alliance: "🤝 業務提携",
  ma_acquirer: "🏢 M&A (買収側)",
  ma_target: "💎 M&A (被買収)",
  scandal: "🚨 不祥事",
  lawsuit: "⚖ 訴訟",
  other: "その他",
};
