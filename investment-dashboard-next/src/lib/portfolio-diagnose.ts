/**
 * 🩺 ポートフォリオ診断エンジン (純関数・完全に機械的)
 *
 * 既存パネルは「銘柄ごとの評価」(将来性/地形/警告) が中心で、
 * 「ポートフォリオを一つの塊として見たときの数学」が抜けていた。
 * ここでは分散が実際に効いているか、どこがリスクを作っているか、
 * 下げ相場で何が起きるかを、実データから計算する。
 *
 * 使うのは過去250営業日の実リターン系列のみ。予測は一切しない。
 */

export interface DiagHolding {
  ticker: string;
  name: string;
  value: number;              // 時価評価額 (円)
  pnlPct: number | null;      // 含み損益率
  industry: string | null;    // 業種 (1,846銘柄130業種マップ由来)
}

/** ticker → 日付順の日次リターン% (共通の日付軸に揃えてあること) */
export type ReturnSeries = Map<string, number[]>;

export interface Diagnosis {
  // ── 構成 ──
  totalValue: number;
  holdingCount: number;
  topWeightPct: number;          // 最大銘柄の比率
  top3WeightPct: number;
  hhi: number;                   // ハーフィンダール指数 (0-1)
  effectiveStocks: number;       // 実効銘柄数 = 1/HHI 「実質何銘柄に分散しているか」
  industryTop: { industry: string; weightPct: number; tickers: string[] }[];
  // ── 分散の実質 ──
  avgCorrelation: number | null;   // 保有銘柄間の平均相関
  diversificationRatio: number | null; // 加重平均ボラ ÷ ポートボラ (1に近いほど分散が効いていない)
  effectiveIndependent: number | null; // 相関を考慮した実質独立銘柄数
  // ── リスク ──
  portfolioVolPct: number | null;  // ポート日次σ%
  annualVolPct: number | null;     // 年率換算
  beta: number | null;             // 日経に対するβ
  riskContrib: { ticker: string; name: string; weightPct: number; riskPct: number }[]; // リスク寄与分解
  // ── ストレス (実測) ──
  downCapturePct: number | null;   // 日経が下げた日のポート平均 ÷ 日経平均 (1.0超 = 下げに弱い)
  upCapturePct: number | null;
  worstDay: { date: string; portPct: number; nikkeiPct: number } | null;
  maxDrawdownPct: number | null;   // 現ウェイト固定で再現した過去250日の最大DD
  bigDropDays: { date: string; portPct: number; nikkeiPct: number }[]; // 日経-2%以下の日の実績
  // ── 損益構造 ──
  winners: number;
  losers: number;
  avgWinPct: number | null;
  avgLossPct: number | null;
  /** 最も含み損の大きい銘柄 (平均だと塩漬け1本が薄まるため、損切りルールの照合はこちらを使う) */
  worstLoser: { ticker: string; name: string; pnlPct: number } | null;
  // ── 所見 (機械的に生成される事実ベースの指摘) ──
  findings: { level: "critical" | "warn" | "info" | "good"; text: string }[];
  daysUsed: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

function std(xs: number[]): number | null {
  if (xs.length < 3) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}
function cov(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs.slice(-n))!, my = mean(ys.slice(-n))!;
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[xs.length - n + i] - mx) * (ys[ys.length - n + i] - my);
  return s / (n - 1);
}
function corr(xs: number[], ys: number[]): number | null {
  const c = cov(xs, ys), sx = std(xs), sy = std(ys);
  return c != null && sx && sy ? c / (sx * sy) : null;
}

export function diagnose(
  holdings: DiagHolding[],
  series: ReturnSeries,
  nikkei: number[],
  dates: string[],
): Diagnosis {
  const total = holdings.reduce((s, h) => s + h.value, 0);
  const sorted = [...holdings].sort((a, b) => b.value - a.value);
  const w = new Map(holdings.map((h) => [h.ticker, h.value / total]));

  // ── 構成 ──
  const hhi = holdings.reduce((s, h) => s + (h.value / total) ** 2, 0);
  const byIndustry = new Map<string, { v: number; t: string[] }>();
  for (const h of holdings) {
    const key = h.industry ?? "(業種不明)";
    const e = byIndustry.get(key) ?? { v: 0, t: [] };
    e.v += h.value; e.t.push(h.ticker);
    byIndustry.set(key, e);
  }
  const industryTop = Array.from(byIndustry.entries())
    .map(([industry, e]) => ({ industry, weightPct: r1((e.v / total) * 100), tickers: e.t }))
    .sort((a, b) => b.weightPct - a.weightPct);

  // ── ポートフォリオのリターン系列 (現ウェイト固定で再現) ──
  const usable = holdings.filter((h) => (series.get(h.ticker)?.length ?? 0) >= 60);
  const n = Math.min(...usable.map((h) => series.get(h.ticker)!.length), nikkei.length);
  const portSeries: number[] = [];
  if (usable.length > 0 && n >= 60) {
    const wSum = usable.reduce((s, h) => s + h.value, 0);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (const h of usable) {
        const s = series.get(h.ticker)!;
        r += (h.value / wSum) * s[s.length - n + i];
      }
      portSeries.push(r);
    }
  }
  const nkSeries = nikkei.slice(-n);
  const dateSeries = dates.slice(-n);

  const portVol = std(portSeries);
  const beta = portSeries.length >= 60 ? (() => {
    const c = cov(portSeries, nkSeries), vn = std(nkSeries);
    return c != null && vn ? c / (vn * vn) : null;
  })() : null;

  // ── 分散の実質 ──
  //
  // 【重要】単純平均の相関は使わない。
  // 例: 資産の80%が半導体3銘柄 (相互相関0.6) + 8%のNTT (半導体と-0.25) の場合、
  //     単純平均は0.19となり「分散が効いている」という正反対の結論が出る。
  //     ポートのリスクに効くのは【保有比率で重み付けした相関】(分散公式の交差項そのもの)。
  let avgCorrelation: number | null = null;   // = 加重平均相関
  let diversificationRatio: number | null = null;
  let effectiveIndependent: number | null = null;
  if (usable.length >= 2) {
    const wSum = usable.reduce((s, h) => s + h.value, 0);
    const wOf = (h: DiagHolding) => h.value / wSum;
    let num = 0, den = 0;
    for (let i = 0; i < usable.length; i++) {
      for (let j = 0; j < usable.length; j++) {
        if (i === j) continue;
        const c = corr(series.get(usable[i].ticker)!, series.get(usable[j].ticker)!);
        if (c == null) continue;
        const ww = wOf(usable[i]) * wOf(usable[j]);
        num += ww * c;
        den += ww;
      }
    }
    avgCorrelation = den > 0 ? num / den : null;

    const weightedVol = usable.reduce((s, h) => s + wOf(h) * (std(series.get(h.ticker)!) ?? 0), 0);
    if (portVol && portVol > 0) diversificationRatio = weightedVol / portVol;
    // 実質独立数: 分散比の2乗 (= 何銘柄分の独立したリスク分散に相当するか)
    if (diversificationRatio != null) effectiveIndependent = diversificationRatio ** 2;
  }

  // ── リスク寄与 (周辺リスク寄与 MCTR) ──
  const riskContrib: Diagnosis["riskContrib"] = [];
  if (usable.length >= 2 && portVol && portVol > 0) {
    const wSum = usable.reduce((s, h) => s + h.value, 0);
    let totalC = 0;
    const raw: { h: DiagHolding; c: number }[] = [];
    for (const h of usable) {
      const c = cov(series.get(h.ticker)!, portSeries);
      const contrib = (h.value / wSum) * (c ?? 0);
      raw.push({ h, c: contrib });
      totalC += contrib;
    }
    for (const { h, c } of raw) {
      riskContrib.push({
        ticker: h.ticker, name: h.name,
        weightPct: r1((h.value / total) * 100),
        riskPct: totalC !== 0 ? r1((c / totalC) * 100) : 0,
      });
    }
    riskContrib.sort((a, b) => b.riskPct - a.riskPct);
  }

  // ── ストレス (実測) ──
  let downCapturePct: number | null = null, upCapturePct: number | null = null;
  let worstDay: Diagnosis["worstDay"] = null;
  const bigDropDays: Diagnosis["bigDropDays"] = [];
  if (portSeries.length >= 60) {
    const downIdx = nkSeries.map((v, i) => (v < 0 ? i : -1)).filter((i) => i >= 0);
    const upIdx = nkSeries.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
    const dp = mean(downIdx.map((i) => portSeries[i])), dn = mean(downIdx.map((i) => nkSeries[i]));
    const up = mean(upIdx.map((i) => portSeries[i])), un = mean(upIdx.map((i) => nkSeries[i]));
    if (dp != null && dn && dn !== 0) downCapturePct = r2(dp / dn);
    if (up != null && un && un !== 0) upCapturePct = r2(up / un);
    let wi = 0;
    for (let i = 1; i < portSeries.length; i++) if (portSeries[i] < portSeries[wi]) wi = i;
    worstDay = { date: dateSeries[wi] ?? "", portPct: r2(portSeries[wi]), nikkeiPct: r2(nkSeries[wi]) };
    for (let i = 0; i < nkSeries.length; i++) {
      if (nkSeries[i] <= -2) bigDropDays.push({ date: dateSeries[i] ?? "", portPct: r2(portSeries[i]), nikkeiPct: r2(nkSeries[i]) });
    }
    bigDropDays.sort((a, b) => a.nikkeiPct - b.nikkeiPct);
  }
  // 最大ドローダウン (現ウェイト固定の累積)
  let maxDrawdownPct: number | null = null;
  if (portSeries.length >= 60) {
    let cum = 1, peak = 1, mdd = 0;
    for (const r of portSeries) {
      cum *= 1 + r / 100;
      peak = Math.max(peak, cum);
      mdd = Math.min(mdd, cum / peak - 1);
    }
    maxDrawdownPct = r1(mdd * 100);
  }

  // ── 損益構造 ──
  const withPnl = holdings.filter((h) => h.pnlPct != null);
  const winners = withPnl.filter((h) => h.pnlPct! > 0);
  const losers = withPnl.filter((h) => h.pnlPct! <= 0);

  // ── 所見 (すべて上の数値から機械的に導出) ──
  const findings: Diagnosis["findings"] = [];
  const effN = 1 / hhi;
  if (sorted.length > 0) {
    const topW = (sorted[0].value / total) * 100;
    if (topW >= 40) findings.push({ level: "critical", text: `${sorted[0].name} 1銘柄で資産の ${r1(topW)}% — この1銘柄の値動きがポート全体をほぼ決めています` });
    else if (topW >= 25) findings.push({ level: "warn", text: `${sorted[0].name} が ${r1(topW)}% と偏りあり` });
  }
  if (effN < 3 && holdings.length >= 3) {
    findings.push({ level: "warn", text: `${holdings.length}銘柄保有していますが、比率の偏りにより実質 ${r1(effN)}銘柄分の分散しかありません` });
  }
  if (industryTop.length > 0 && industryTop[0].weightPct >= 50 && industryTop[0].industry !== "(業種不明)") {
    findings.push({ level: "critical", text: `${industryTop[0].industry} に ${industryTop[0].weightPct}% 集中 — 業種イベント1つで資産の半分以上が同時に動きます` });
  } else if (industryTop.length > 0 && industryTop[0].weightPct >= 35 && industryTop[0].industry !== "(業種不明)") {
    findings.push({ level: "warn", text: `${industryTop[0].industry} に ${industryTop[0].weightPct}% 集中` });
  }
  if (effectiveIndependent != null && holdings.length >= 3 && effectiveIndependent < holdings.length * 0.5) {
    findings.push({
      level: effectiveIndependent < 2 ? "warn" : "info",
      text: `${holdings.length}銘柄保有していますが、値動きの重なりを考慮した実質的な分散は ${r1(effectiveIndependent)}銘柄分です (加重平均相関 ${avgCorrelation != null ? r2(avgCorrelation) : "?"})`,
    });
  } else if (avgCorrelation != null && avgCorrelation <= 0.25 && holdings.length >= 3) {
    findings.push({ level: "good", text: `加重平均相関 ${r2(avgCorrelation)} — 保有どうしがバラバラに動いており分散が効いています` });
  }
  if (downCapturePct != null && downCapturePct >= 1.3) {
    findings.push({ level: "critical", text: `日経が下げた日、ポートは平均で日経の ${downCapturePct}倍 下げています (下げに弱い構成)` });
  } else if (downCapturePct != null && upCapturePct != null && upCapturePct >= downCapturePct + 0.2) {
    findings.push({ level: "good", text: `上げ ${upCapturePct}倍 / 下げ ${downCapturePct}倍 — 上げに強く下げに耐える形になっています` });
  }
  if (beta != null && beta >= 1.4) {
    findings.push({ level: "warn", text: `日経に対するβが ${r2(beta)} — 市場が5%下げると理論上 ${r1(beta * 5)}% 下げる構成です` });
  }
  if (riskContrib.length >= 2 && riskContrib[0].riskPct >= 50) {
    findings.push({ level: "warn", text: `値動きの ${riskContrib[0].riskPct}% を ${riskContrib[0].name} 1銘柄が作っています (資産比率は ${riskContrib[0].weightPct}%)` });
  }
  if (losers.length >= 3 && winners.length >= 1) {
    const aw = mean(winners.map((h) => h.pnlPct!)), al = mean(losers.map((h) => h.pnlPct!));
    if (aw != null && al != null && Math.abs(al) > aw * 1.5) {
      findings.push({ level: "warn", text: `勝ち平均 +${r1(aw)}% に対し負け平均 ${r1(al)}% — 損失を伸ばして利益を伸ばせていない形 (損大利小)` });
    }
  }
  if (maxDrawdownPct != null && maxDrawdownPct <= -25) {
    findings.push({ level: "warn", text: `この構成を過去250日に当てはめると最大 ${maxDrawdownPct}% の落ち込みを経験する計算です` });
  }
  if (findings.length === 0) {
    findings.push({ level: "good", text: "構成・分散・下げ耐性のいずれにも、機械的に指摘すべき偏りは見つかりませんでした" });
  }

  return {
    totalValue: total,
    holdingCount: holdings.length,
    topWeightPct: sorted.length ? r1((sorted[0].value / total) * 100) : 0,
    top3WeightPct: r1((sorted.slice(0, 3).reduce((s, h) => s + h.value, 0) / total) * 100),
    hhi: r2(hhi),
    effectiveStocks: r1(effN),
    industryTop: industryTop.slice(0, 6),
    avgCorrelation: avgCorrelation != null ? r2(avgCorrelation) : null,
    diversificationRatio: diversificationRatio != null ? r2(diversificationRatio) : null,
    effectiveIndependent: effectiveIndependent != null ? r1(effectiveIndependent) : null,
    portfolioVolPct: portVol != null ? r2(portVol) : null,
    annualVolPct: portVol != null ? r1(portVol * Math.sqrt(250)) : null,
    beta: beta != null ? r2(beta) : null,
    riskContrib: riskContrib.slice(0, 8),
    downCapturePct, upCapturePct, worstDay,
    maxDrawdownPct,
    bigDropDays: bigDropDays.slice(0, 5),
    winners: winners.length,
    losers: losers.length,
    avgWinPct: winners.length ? r1(mean(winners.map((h) => h.pnlPct!))!) : null,
    avgLossPct: losers.length ? r1(mean(losers.map((h) => h.pnlPct!))!) : null,
    worstLoser: losers.length
      ? (() => {
          const w = losers.reduce((a, b) => (a.pnlPct! <= b.pnlPct! ? a : b));
          return { ticker: w.ticker, name: w.name, pnlPct: r1(w.pnlPct!) };
        })()
      : null,
    findings,
    daysUsed: portSeries.length,
  };
}

// ────────────────────────────────────────────────────────────
// 🪞 宣言 (問診票) と 実測 (診断) の照合
//
// ここが問診票の本体。Cavka は「こうすべき」とは言わない。
// 本人が宣言したことと、データが示す実態のズレだけを機械的に並べる。
// ズレていること自体が悪いとは限らない (方針が変わったのかもしれない) ので、
// 断定はせず「宣言 ↔ 実測」を並置する書き方に統一する。
// ────────────────────────────────────────────────────────────

export interface ProfileAnswers { [k: string]: unknown }

/**
 * 「触りたくない業種」チップ → Yahoo業種名のパターン。
 * investor-profile.ts の AVOID_GROUPS と対で使う (循環参照を避けるためここに複製)。
 */
export const AVOID_GROUP_PATTERNS: { value: string; label: string; match: RegExp }[] = [
  { value: "bio", label: "バイオ・創薬", match: /Biotechnology|Drug Manufacturers/i },
  { value: "finance", label: "銀行・証券・保険", match: /Bank|Capital Markets|Insurance|Financial/i },
  { value: "realestate", label: "不動産", match: /Real Estate|REIT/i },
  { value: "shipping", label: "海運・空運", match: /Marine Shipping|Airlines|Airports/i },
  { value: "resource", label: "資源・エネルギー", match: /Oil|Gas|Coal|Uranium|Steel|Copper|Aluminum/i },
  { value: "gaming", label: "ゲーム・エンタメ", match: /Gambling|Electronic Gaming|Entertainment|Leisure/i },
  { value: "retail", label: "小売・外食", match: /Retail|Restaurants|Grocery|Apparel/i },
  { value: "semi", label: "半導体", match: /Semiconductor/i },
  { value: "smallcap_growth", label: "新興・グロース (赤字先行企業)", match: /Software - Application|Internet Content/i },
];

export interface GapFinding {
  level: "critical" | "warn" | "info" | "good";
  declared: string;   // あなたが宣言したこと
  measured: string;   // 実測
  comment: string;    // 事実の並置 (助言ではない)
}

const numOf = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : NaN;
  return isFinite(n) ? n : null;
};

export function compareWithProfile(d: Diagnosis, a: ProfileAnswers): GapFinding[] {
  const out: GapFinding[] = [];

  // ① 自分で決めた1銘柄上限 vs 実際の最大比率
  const maxPos = numOf(a.maxPositionPct);
  if (maxPos != null && maxPos > 0) {
    if (d.topWeightPct > maxPos) {
      out.push({
        level: d.topWeightPct > maxPos * 1.5 ? "critical" : "warn",
        declared: `1銘柄は資産の ${maxPos}% まで`,
        measured: `最大 ${d.topWeightPct}%`,
        comment: `自分で決めた上限を ${r1(d.topWeightPct - maxPos)}ポイント超えています`,
      });
    } else {
      out.push({ level: "good", declared: `1銘柄 ${maxPos}% まで`, measured: `最大 ${d.topWeightPct}%`, comment: "自分のルールを守れています" });
    }
  }

  // ② 受け入れられる下落幅 vs 実測の最大ドローダウン
  const acceptDD = numOf(a.maxDrawdownAccept);
  if (acceptDD != null && acceptDD > 0 && d.maxDrawdownPct != null) {
    const actual = Math.abs(d.maxDrawdownPct);
    if (actual > acceptDD) {
      out.push({
        level: actual > acceptDD * 1.5 ? "critical" : "warn",
        declared: `資産の落ち込みは ${acceptDD}% まで受け入れられる`,
        measured: `この構成の過去実績は ${d.maxDrawdownPct}%`,
        comment: `受け入れると答えた範囲を超える落ち込みを、この構成は実際に経験しています`,
      });
    }
  }

  // ③ 分散の方針 vs 実質的な分散
  const div = a.diversification;
  if (div && d.effectiveIndependent != null) {
    if (div === "wide" && d.effectiveIndependent < 3) {
      out.push({
        level: "warn", declared: "広く分散したい (10銘柄以上)",
        measured: `実質 ${d.effectiveIndependent}銘柄分`,
        comment: "銘柄数を増やしても、値動きが重なっていると分散にはなりません",
      });
    } else if (div === "concentrated" && d.effectiveIndependent >= 4) {
      out.push({
        level: "info", declared: "少数に集中したい",
        measured: `実質 ${d.effectiveIndependent}銘柄分に分散`,
        comment: "宣言より分散が効いた状態です (悪いことではありません)",
      });
    }
  }

  // ④ リスク選好・損失耐性 vs 実測のβ / 下げ捕捉
  const thrill = numOf(a.thrill), volPref = numOf(a.volPreference);
  const appetite = thrill != null && volPref != null ? (thrill + volPref) / 2 : (thrill ?? volPref);
  if (appetite != null && d.beta != null) {
    if (appetite <= 2 && d.beta >= 1.3) {
      out.push({
        level: "warn", declared: "手堅くいきたい (大きく負けたくない・荒い値動きは苦手)",
        measured: `β ${d.beta} / 年率ボラ ${d.annualVolPct ?? "?"}%`,
        comment: "実際のポートフォリオは、答えた気質よりかなり攻めた構成になっています",
      });
    } else if (appetite >= 4 && d.beta <= 0.8) {
      out.push({
        level: "info", declared: "攻めたい",
        measured: `β ${d.beta}`,
        comment: "実際は市場より穏やかな構成です",
      });
    }
  }

  // ⑤ 損切りルール vs 実際に残っている最悪の含み損
  //    (平均で見ると塩漬け1本が軽傷の銘柄に薄められて検出できないため、最悪値で判定する)
  const stopRule = a.stopLossRule, stopPct = numOf(a.stopLossPct);
  if (stopRule === "pct" && stopPct != null && d.worstLoser != null && Math.abs(d.worstLoser.pnlPct) > stopPct) {
    const over = Math.abs(d.worstLoser.pnlPct) - stopPct;
    out.push({
      level: over >= stopPct ? "critical" : "warn",
      declared: `${stopPct}% 下落したら必ず損切りする`,
      measured: `${d.worstLoser.name} が ${d.worstLoser.pnlPct}%`,
      comment: `宣言した損切り水準を ${r1(over)}ポイント超えた含み損が、まだ残っています`,
    });
  }
  if (stopRule === "none" && d.losers >= 3) {
    out.push({
      level: "info", declared: "損切りルールは特にない",
      measured: `含み損 ${d.losers}銘柄 (平均 ${d.avgLossPct ?? "?"}%)`,
      comment: "ルールが無い状態でどこまで耐えるかは、その時の気分で決まることになります",
    });
  }

  // ⑥ 処分効果の自己申告 vs 実測の損大利小
  const regret = numOf(a.regretSell);
  if (regret != null && regret >= 4 && d.avgWinPct != null && d.avgLossPct != null) {
    if (Math.abs(d.avgLossPct) > d.avgWinPct) {
      out.push({
        level: "warn",
        declared: "含み損は売れず、含み益はすぐ利確してしまう (自己申告)",
        measured: `勝ち平均 +${d.avgWinPct}% / 負け平均 ${d.avgLossPct}%`,
        comment: "自己認識と実測が一致しています。自覚のあるクセは仕組みで止められます",
      });
    }
  }

  // ⑦ 配当重視の宣言 vs 業種構成 (高配当業種が薄い場合)
  if (a.returnSource === "income") {
    const incomeIsh = d.industryTop
      .filter((i) => /Bank|Insurance|Telecom|Utilities|Tobacco|REIT|Oil|Gas/i.test(i.industry))
      .reduce((s, i) => s + i.weightPct, 0);
    if (incomeIsh < 20) {
      out.push({
        level: "info", declared: "配当・インカム重視",
        measured: `内需・金融・通信など配当が厚い業種は ${r1(incomeIsh)}%`,
        comment: "現在の構成は値上がり益寄りの業種が中心です",
      });
    }
  }

  // ⑧ 時間軸の宣言 vs 値動きの荒さ (デイトレ志向でないのに超高ボラ)
  if ((a.tradeStyle === "long" || a.tradeStyle === "mid") && d.annualVolPct != null && d.annualVolPct >= 40) {
    out.push({
      level: "warn",
      declared: a.tradeStyle === "long" ? "年単位で保有したい" : "数ヶ月単位で持ちたい",
      measured: `年率ボラ ${d.annualVolPct}%`,
      comment: "長く持つには揺れが大きい構成です。途中で降りたくなる場面が増えます",
    });
  }

  // ⑨ 「触りたくない」と宣言した業種を、実際に保有していないか
  const avoid = Array.isArray(a.avoidIndustries) ? (a.avoidIndustries as string[]) : [];
  if (avoid.length > 0) {
    const hit: { label: string; industry: string; weightPct: number }[] = [];
    for (const g of AVOID_GROUP_PATTERNS) {
      if (!avoid.includes(g.value)) continue;
      for (const ind of d.industryTop) {
        if (g.match.test(ind.industry)) hit.push({ label: g.label, industry: ind.industry, weightPct: ind.weightPct });
      }
    }
    if (hit.length > 0) {
      const total = hit.reduce((s, h) => s + h.weightPct, 0);
      out.push({
        level: total >= 20 ? "warn" : "info",
        declared: `触りたくない: ${Array.from(new Set(hit.map((h) => h.label))).join(" / ")}`,
        measured: `該当業種を ${r1(total)}% 保有 (${hit.map((h) => h.industry).slice(0, 3).join(", ")})`,
        comment: "避けると決めた領域に資金が入っています",
      });
    }
  }

  // ⑩ 目的が「生活費の補填」なのに下げに弱い
  if (a.goalPurpose === "living" && d.downCapturePct != null && d.downCapturePct >= 1.2) {
    out.push({
      level: "critical",
      declared: "生活費の補填を期待している資金",
      measured: `日経が下げた日、平均で ${d.downCapturePct}倍 下げている`,
      comment: "生活に紐づく資金としては、下げ局面での振れが大きい構成です",
    });
  }

  return out;
}

/**
 * 目標金額・期限から必要リターンを機械的に計算 (予測ではなく算術)。
 *
 * @param stockValue 株式評価額
 * @param cashJpy    待機現金。目標は「投資資産」に対して立てるので現金も分子に入れる
 *                   (入れないと分母が過小になり、必要リターンが嘘になる)
 */
export function goalArithmetic(
  stockValue: number,
  a: ProfileAnswers,
  cashJpy = 0,
): {
  targetAmount: number; months: number; monthlyAdd: number;
  currentTotal: number; requiredCagrPct: number | null; note: string; expired: boolean;
} | null {
  const target = numOf(a.goalAmount);
  const dateStr = typeof a.goalDate === "string" ? a.goalDate : null;
  if (target == null || target <= 0 || !dateStr) return null;
  const m = dateStr.match(/(\d{4})\D*(\d{1,2})?/);
  if (!m) return null;
  const y = Number(m[1]), mo = m[2] ? Number(m[2]) : 12;
  const goal = new Date(Date.UTC(y, mo - 1, 1));
  const now = new Date();
  const rawMonths = (goal.getTime() - now.getTime()) / (30.44 * 86400 * 1000);
  const currentValue = stockValue + Math.max(0, cashJpy);
  const monthlyAdd = numOf(a.monthlyAdd) ?? 0;

  // 期限切れ: 勝手に「あと1ヶ月」に丸めず、正直に伝える
  if (rawMonths < 0.5) {
    const reached = currentValue >= target;
    return {
      targetAmount: target, months: 0, monthlyAdd, currentTotal: currentValue,
      requiredCagrPct: null, expired: true,
      note: reached
        ? `期限 (${dateStr}) を過ぎています。現在 ${Math.round(currentValue).toLocaleString("ja-JP")}円 で目標は達成済みです — 次の目標を設定しましょう`
        : `期限 (${dateStr}) を過ぎています。現在 ${Math.round(currentValue).toLocaleString("ja-JP")}円 / 目標 ${target.toLocaleString("ja-JP")}円 — 問診票で期限を更新してください`,
    };
  }
  const months = Math.max(1, Math.round(rawMonths));

  // 入金だけで到達するか
  const byDeposit = currentValue + monthlyAdd * months;
  let requiredCagrPct: number | null = null;
  let note: string;
  if (currentValue >= target) {
    note = `現在 ${Math.round(currentValue).toLocaleString("ja-JP")}円 (株式+現金) で、目標 ${target.toLocaleString("ja-JP")}円 は既に達成しています`;
  } else if (byDeposit >= target) {
    note = `入金 (月${monthlyAdd.toLocaleString("ja-JP")}円 × ${months}ヶ月) だけで到達する計算です。相場に頼る必要はありません`;
  } else if (currentValue <= 0) {
    note = "現在の評価額が0のため計算できません";
  } else {
    // 積立を考慮した必要年率を二分探索
    const fv = (r: number) => {
      const mr = Math.pow(1 + r, 1 / 12) - 1;
      let v = currentValue;
      for (let i = 0; i < months; i++) v = v * (1 + mr) + monthlyAdd;
      return v;
    };
    let lo = -0.5, hi = 3;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (fv(mid) < target) lo = mid; else hi = mid;
    }
    requiredCagrPct = Math.round(((lo + hi) / 2) * 1000) / 10;
    note = `現在 ${Math.round(currentValue).toLocaleString("ja-JP")}円 (株式+現金) から、目標には年率 ${requiredCagrPct}% が必要な計算です`;
  }
  return { targetAmount: target, months, monthlyAdd, currentTotal: currentValue, requiredCagrPct, note, expired: false };
}
