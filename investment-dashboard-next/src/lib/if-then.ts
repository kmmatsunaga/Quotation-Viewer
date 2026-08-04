/**
 * 🎯 if-then ルール — 冷静だった日の自分に、焦った瞬間の判断を代行させる装置
 *
 * ユーザーの問診票 (2026-08-04) から:
 *   焦り度90 / FOMO 5/5 / 損切りルールなし / 「とにかく勝ちたい」
 *   → 判断そのものではなく【判断のタイミング】が問題。
 *
 * だから予測はしない。本人が平常時に書いた「こうなったら、こうする」を保存し、
 * 条件が成立した瞬間に【本人の言葉をそのまま返す】。
 * Cavka は何も指示しない — 過去の自分に発言権を与えるだけ。
 */

export type ConditionKind =
  | "index_level"      // 日経が水準Xを割った/超えた
  | "index_change"     // 日経が1日でX%動いた
  | "regime"           // レジーム測定器が段階X以上
  | "stock_price"      // 銘柄Yが価格Xを割った/超えた
  | "stock_pnl"        // 保有Yの含み損益がX%を下回った/上回った
  | "cash_ratio";      // 現金比率がX%を下回った

export type Direction = "below" | "above";

export interface IfThenRule {
  id?: string;
  kind: ConditionKind;
  direction: Direction;
  threshold: number;
  ticker?: string | null;   // stock_* の対象銘柄
  tickerName?: string | null;
  /** then: 本人が書いた「その時どうするか」。これがそのまま通知される */
  thenText: string;
  /** なぜこのルールを作ったか (冷静だった時の理由) */
  whyText?: string;
  active: boolean;
  createdAt?: unknown;
  lastFiredAt?: string | null;
  fireCount?: number;
  /** 一度発火したら再通知しない (既定 false = クールダウン後に再通知) */
  once?: boolean;
  cooldownHours?: number;
}

/** 判定に使う市場・自分の状態 */
export interface IfThenContext {
  nikkeiLevel: number | null;
  nikkeiChangePct: number | null;
  regimeLow60Pct: number | null;
  cashRatioPct: number | null;
  /** ticker → { price, pnlPct, name } */
  positions: Record<string, { price: number | null; pnlPct: number | null; name: string }>;
}

export const KIND_META: Record<ConditionKind, { label: string; unit: string; needsTicker: boolean; help: string }> = {
  index_level: { label: "日経平均の水準", unit: "円", needsTicker: false, help: "例: 38500円を割ったら" },
  index_change: { label: "日経平均の1日の変動", unit: "%", needsTicker: false, help: "例: 1日で-3%以上下げたら" },
  regime: { label: "レジーム測定器 (洗い流しの深さ)", unit: "%", needsTicker: false, help: "例: 60日安値が25%を超えたら (歴史的には買い場側)" },
  stock_price: { label: "銘柄の株価", unit: "円", needsTicker: true, help: "例: この銘柄が◯◯円を割ったら" },
  stock_pnl: { label: "保有銘柄の含み損益", unit: "%", needsTicker: true, help: "例: -8%を下回ったら (損切りルールの自動化)" },
  cash_ratio: { label: "現金比率", unit: "%", needsTicker: false, help: "例: 現金が10%を下回ったら (弾切れの警告)" },
};

/** 人が読める条件文 */
export function describeCondition(r: IfThenRule): string {
  const dir = r.direction === "below" ? "を下回ったら" : "を超えたら";
  switch (r.kind) {
    case "index_level": return `日経平均が ${r.threshold.toLocaleString("ja-JP")}円 ${dir}`;
    case "index_change": return `日経平均が1日で ${r.threshold}% ${r.direction === "below" ? "以上下げたら" : "以上上げたら"}`;
    case "regime": return `レジーム測定器 (60日安値の割合) が ${r.threshold}% ${dir}`;
    case "stock_price": return `${r.tickerName ?? r.ticker} が ${r.threshold.toLocaleString("ja-JP")}円 ${dir}`;
    case "stock_pnl": return `${r.tickerName ?? r.ticker} の含み損益が ${r.threshold}% ${dir}`;
    case "cash_ratio": return `現金比率が ${r.threshold}% ${dir}`;
  }
}

/** 現在値の取り出し (判定不能なら null) */
export function currentValue(r: IfThenRule, ctx: IfThenContext): number | null {
  switch (r.kind) {
    case "index_level": return ctx.nikkeiLevel;
    case "index_change": return ctx.nikkeiChangePct;
    case "regime": return ctx.regimeLow60Pct;
    case "cash_ratio": return ctx.cashRatioPct;
    case "stock_price": return r.ticker ? ctx.positions[r.ticker]?.price ?? null : null;
    case "stock_pnl": return r.ticker ? ctx.positions[r.ticker]?.pnlPct ?? null : null;
  }
}

export interface FiredRule {
  rule: IfThenRule;
  value: number;
  condition: string;
  message: string;   // LINE / 画面に出す本文
}

/** クールダウン判定 (既定24時間。once=true なら一度きり) */
function canFire(r: IfThenRule, nowMs: number): boolean {
  if (!r.active) return false;
  if (!r.lastFiredAt) return true;
  if (r.once) return false;
  const hours = r.cooldownHours ?? 24;
  return nowMs - new Date(r.lastFiredAt).getTime() >= hours * 3600 * 1000;
}

/**
 * 発火判定。
 * index_change の "below -3" は「-3%以上下げた」= 値が -3 以下、という自然な読み方にする。
 */
export function evaluateRules(rules: IfThenRule[], ctx: IfThenContext, now = new Date()): FiredRule[] {
  const out: FiredRule[] = [];
  const nowMs = now.getTime();
  for (const r of rules) {
    if (!canFire(r, nowMs)) continue;
    const v = currentValue(r, ctx);
    if (v == null || !isFinite(v)) continue;
    const hit = r.direction === "below" ? v <= r.threshold : v >= r.threshold;
    if (!hit) continue;
    const cond = describeCondition(r);
    out.push({
      rule: r, value: v, condition: cond,
      message:
        `🎯 あなたが決めた条件が成立しました\n\n` +
        `【条件】${cond}\n` +
        `【現在】${formatValue(r, v)}\n\n` +
        `【あなたが書いたこと】\n${r.thenText}` +
        (r.whyText ? `\n\n【そう決めた理由】\n${r.whyText}` : ""),
    });
  }
  return out;
}

export function formatValue(r: IfThenRule, v: number): number | string {
  switch (r.kind) {
    case "index_level":
    case "stock_price": return `${Math.round(v).toLocaleString("ja-JP")}円`;
    case "index_change":
    case "regime":
    case "cash_ratio":
    case "stock_pnl": return `${Math.round(v * 10) / 10}%`;
  }
}
