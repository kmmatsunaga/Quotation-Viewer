/**
 * 業績の温度計 — 年次/四半期の業績推移を「人間の読み方」に言語化する純関数。
 *
 * 売上・利益の伸び、利益率の推移、ROE、財務の健全性、決算サプライズを読み、
 * 「成長企業か / 停滞か / 悪化か」「稼ぐ力は強いか」「財務は健全か」を平易に出す。
 * 断定でなく仮説の材料。投資助言ではない。
 */

import {
  type Commentary,
  type CommentaryLine,
  C_GOOD,
  C_UP,
  C_DOWN,
  C_NEUTRAL,
  C_WARN,
} from "./commentary";

export interface AnnualRow {
  fiscalYearEnd: string;
  revenue: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  equityRatio: number | null;
  roe: number | null;
  freeCashflow: number | null;
}

export interface QuarterlyRow {
  quarter: string;
  date: string;
  revenue: number | null;
  netIncome: number | null;
  surprise: number | null;
}

export interface FinancialsInput {
  currency: string | null;
  annual: AnnualRow[]; // 古い順
  quarterly: QuarterlyRow[]; // 任意順
}

function cagr(first: number, last: number, years: number): number | null {
  if (first <= 0 || last <= 0 || years <= 0) return null;
  return (Math.pow(last / first, 1 / years) - 1) * 100;
}

// n年で何回「前年比プラス」だったか
function upStreak(vals: (number | null)[]): { ups: number; total: number } {
  let ups = 0, total = 0;
  for (let i = 1; i < vals.length; i++) {
    const a = vals[i - 1], b = vals[i];
    if (a == null || b == null) continue;
    total++;
    if (b > a) ups++;
  }
  return { ups, total };
}

export function assessFinancials(f: FinancialsInput): Commentary | null {
  const annual = f.annual.filter((a) => a.revenue != null || a.netIncome != null);
  const lines: CommentaryLine[] = [];
  const terms: string[] = [];

  if (annual.length < 2) {
    // 年次が乏しくても四半期だけで最低限
    if (f.quarterly.length === 0) return null;
  }

  const revs = annual.map((a) => a.revenue);
  const nis = annual.map((a) => a.netIncome);

  // ── 売上の成長 (CAGR + 連続増収) ──
  const firstRev = revs.find((v) => v != null) ?? null;
  const lastRev = [...revs].reverse().find((v) => v != null) ?? null;
  const spanYears = annual.length - 1;
  const revCagr = firstRev != null && lastRev != null ? cagr(firstRev, lastRev, spanYears) : null;
  const revStreak = upStreak(revs);
  const niStreak = upStreak(nis);

  // ── 直近YoY (最新2年) ──
  const latest = annual[annual.length - 1];
  const prev = annual[annual.length - 2];
  const latestRevYoY = latest && prev && prev.revenue && latest.revenue != null
    ? ((latest.revenue - prev.revenue) / Math.abs(prev.revenue)) * 100 : null;
  const latestNiYoY = latest && prev && prev.netIncome && latest.netIncome != null
    ? ((latest.netIncome - prev.netIncome) / Math.abs(prev.netIncome)) * 100 : null;

  // ── 見出しの温度感 (成長ステージ) ──
  let temp: Commentary["temp"];
  let stance: string;
  const growing = (revCagr ?? 0) >= 8 && revStreak.ups >= Math.ceil(revStreak.total * 0.6);
  const shrinking = (revCagr ?? 0) < 0 || (latestRevYoY != null && latestRevYoY < -5);
  if (growing && (latestNiYoY == null || latestNiYoY >= 0)) {
    temp = { label: "成長企業", emoji: "🌱", color: C_GOOD };
    stance = "売上が継続的に伸びている。成長が続くか (受注・市場の拡大) を確認するのが要点。";
  } else if (shrinking) {
    temp = { label: "縮小・悪化", emoji: "🥀", color: C_DOWN };
    stance = "売上/利益が縮んでいる。一時要因か構造的な衰退かの見極めが必要。安いだけで飛びつかない。";
  } else {
    temp = { label: "安定・横ばい", emoji: "🌳", color: C_NEUTRAL };
    stance = "大きな成長も衰退もない安定期。配当・利益率・株主還元が投資判断の軸になりやすい。";
  }

  // ── 売上トレンド行 ──
  if (revCagr != null) {
    lines.push({
      icon: revCagr >= 8 ? "📈" : revCagr >= 0 ? "➡️" : "📉",
      tone: revCagr >= 8 ? "pos" : revCagr >= 0 ? "neutral" : "neg",
      text: `売上は年平均 ${revCagr >= 0 ? "+" : ""}${revCagr.toFixed(1)}% で推移 (${annual.length}年)。${revStreak.total > 0 ? `${revStreak.total}年中${revStreak.ups}年が増収。` : ""}${revCagr >= 10 ? "二桁成長は高成長企業の目安。" : revCagr < 0 ? "減収基調は要注意。" : ""}`,
    });
    terms.push("年平均成長率");
  }
  if (latestRevYoY != null) {
    lines.push({
      icon: latestRevYoY >= 0 ? "▲" : "▼",
      tone: latestRevYoY >= 10 ? "pos" : latestRevYoY >= 0 ? "neutral" : "neg",
      text: `直近の売上は前年比 ${latestRevYoY >= 0 ? "+" : ""}${latestRevYoY.toFixed(1)}%。`,
    });
  }

  // ── 利益トレンド ──
  if (latestNiYoY != null) {
    lines.push({
      icon: latestNiYoY >= 0 ? "▲" : "▼",
      tone: latestNiYoY >= 15 ? "pos" : latestNiYoY >= 0 ? "neutral" : "neg",
      text: `直近の純利益は前年比 ${latestNiYoY >= 0 ? "+" : ""}${latestNiYoY.toFixed(1)}%。${niStreak.total > 0 ? `${niStreak.total}年中${niStreak.ups}年が増益。` : ""}${latestRevYoY != null && latestNiYoY > latestRevYoY + 5 ? "売上以上に利益が伸びる=収益性が改善。" : latestRevYoY != null && latestNiYoY < latestRevYoY - 5 ? "売上ほど利益が伸びず=コスト増や採算悪化のサイン。" : ""}`,
    });
    if (latestRevYoY != null && latestRevYoY >= 0 && latestNiYoY >= 0) terms.push("増収増益");
  }

  // ── 利益率 (稼ぐ力) ──
  if (latest?.operatingMargin != null) {
    const om = latest.operatingMargin;
    const prevOm = prev?.operatingMargin ?? null;
    const trend = prevOm != null ? (om > prevOm + 0.5 ? "改善" : om < prevOm - 0.5 ? "悪化" : "横ばい") : null;
    lines.push({
      icon: om >= 15 ? "💪" : om >= 5 ? "◦" : "⚠",
      tone: om >= 15 ? "pos" : om >= 5 ? "neutral" : "warn",
      text: `営業利益率 ${om.toFixed(1)}%${trend ? ` (前年から${trend})` : ""}。${om >= 15 ? "高収益 (10%超で優良の目安)。" : om >= 5 ? "標準的な収益性。" : "薄利。価格競争や高コスト体質の可能性。"}`,
    });
    terms.push("営業利益率");
  }

  // ── ROE (株主資本の効率) ──
  if (latest?.roe != null) {
    const roe = latest.roe;
    lines.push({
      icon: roe >= 15 ? "💪" : roe >= 8 ? "◦" : "⚠",
      tone: roe >= 15 ? "pos" : roe >= 8 ? "neutral" : "warn",
      text: `ROE ${roe.toFixed(1)}% = 株主のお金をどれだけ効率よく利益に変えたか。${roe >= 15 ? "15%超は優良。" : roe >= 8 ? "8%超で合格ライン (日本企業平均程度)。" : "8%未満は資本効率が低め。"}`,
    });
    terms.push("ROE");
  }

  // ── 財務健全性 (自己資本比率) ──
  if (latest?.equityRatio != null) {
    const er = latest.equityRatio;
    lines.push({
      icon: er >= 50 ? "🛡" : er >= 30 ? "◦" : "⚠",
      tone: er >= 50 ? "pos" : er >= 30 ? "neutral" : "warn",
      text: `自己資本比率 ${er.toFixed(0)}% = 資産のうち借金でない割合。${er >= 50 ? "50%超で財務は健全 (不況に強い)。" : er >= 30 ? "30〜50%は標準。" : "30%未満は借入依存が高め。金利上昇や業績悪化に弱い。"}`,
    });
    terms.push("自己資本比率");
  }

  // ── フリーキャッシュフロー (実際に手元に残る現金) ──
  if (latest?.freeCashflow != null) {
    const fcf = latest.freeCashflow;
    lines.push({
      icon: fcf > 0 ? "💵" : "⚠",
      tone: fcf > 0 ? "pos" : "warn",
      text: `フリーキャッシュフロー ${fcf > 0 ? "プラス" : "マイナス"} = 事業で稼いだ現金から投資を引いた「実際に自由に使える金」。${fcf > 0 ? "プラスは自力で稼げている証。配当・自社株買い・無借金化の原資。" : "マイナス継続は資金流出。増資や借入に頼る局面かも。"}`,
    });
    terms.push("フリーキャッシュフロー");
  }

  // ── 決算サプライズ (四半期のEPS予想比) ──
  const withSurp = f.quarterly.filter((q) => q.surprise != null).sort((a, b) => b.date.localeCompare(a.date));
  if (withSurp.length > 0) {
    const recent = withSurp.slice(0, 4);
    const beats = recent.filter((q) => (q.surprise ?? 0) >= 0).length;
    const latestSurp = recent[0].surprise ?? 0;
    lines.push({
      icon: latestSurp >= 0 ? "🎯" : "❌",
      tone: latestSurp >= 5 ? "pos" : latestSurp >= -5 ? "neutral" : "neg",
      text: `直近決算はEPS予想比 ${latestSurp >= 0 ? "+" : ""}${latestSurp.toFixed(1)}% (${latestSurp >= 0 ? "上振れ" : "下振れ"})。直近${recent.length}回中${beats}回が予想達成。${beats >= recent.length - 1 ? "予想を安定して上回る=信頼できる経営。" : beats <= 1 ? "予想を外し続ける=業績の下方リスク。" : ""}`,
    });
    terms.push("決算サプライズ", "EPS");
  }

  if (lines.length === 0) return null;

  void C_UP; void C_WARN;

  const caveat =
    "過去の業績は未来を保証しない。特に日本株は一部指標 (営業利益率等) が欠落することがある。株価には将来の期待が既に織り込まれている点にも注意。これは業績の読み方の説明で、売買の推奨ではありません。";

  return { temp, stance, lines, terms, caveat };
}
