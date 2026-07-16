/**
 * 買い方の設計 (ポジション構築プラン) — 純関数
 *
 * 思想: 覚悟を仕組みに変換する。
 *   1. プランは買う前に作る (買った後に理屈をつけない)
 *   2. リスクは金額で先に決める (損切りまでの想定損失 ≤ 総資産の riskPct%)
 *   3. 分割エントリー (一度に全額入れない。下がったら安く拾う設計を最初から)
 *
 * 株数は楽天の2形態に対応:
 *   - 単元 (100株単位)
 *   - かぶミニ (1株単位、単元に届かない資金でも設計可能)
 */

export interface PlanInputs {
  ticker: string;
  name: string;
  price: number;        // 現在値
  atr: number;          // ATR14 (円)
  low20: number;        // 直近20日安値
  low60: number;        // 直近60日安値
  totalAssets: number;  // 総資産 (現金 + 保有評価額)
  cash: number;         // 使える現金
  riskPct: number;      // 1トレードの最大リスク (総資産比 %) 例 1.5
  maxPosPct: number;    // 1銘柄の最大投資額 (総資産比 %) 例 25
  lotSize: 1 | 100;     // 1=かぶミニ / 100=単元
}

export interface PlanEntry {
  label: string;
  price: number;
  shares: number;
  amount: number;
}

export interface PositionPlanCalc {
  ok: boolean;
  reason?: string;              // ok=false の理由
  entries: PlanEntry[];         // 分割エントリー (使う分だけ)
  totalShares: number;
  totalAmount: number;          // 全ロット約定時の投資額
  avgEntry: number;             // 加重平均取得単価
  stop: number;                 // 損切りライン (全ロット共通)
  stopPct: number;              // 平均取得単価からの損切り幅%
  target: number;               // 利確目安 (RRR 2:1)
  riskAmount: number;           // 全ロット約定+損切り時の損失額
  riskPctOfAssets: number;      // 損失額 / 総資産 %
  rrr: number;                  // リワード/リスク比
  positionPctOfAssets: number;  // 投資額 / 総資産 %
  notes: string[];              // 設計メモ・警告
}

const floorTo = (v: number, unit: number) => Math.floor(v / unit) * unit;

/** 呼値の簡易丸め (プラン用途なので 1円/5円/10円 程度の粗い丸めで十分) */
function roundTick(price: number): number {
  if (price < 3000) return Math.round(price);
  if (price < 30000) return Math.round(price / 5) * 5;
  return Math.round(price / 10) * 10;
}

export function computePositionPlan(inp: PlanInputs): PositionPlanCalc {
  const notes: string[] = [];
  const { price, atr, low20, low60, totalAssets, cash, riskPct, maxPosPct, lotSize } = inp;

  if (!(price > 0) || !(atr > 0) || !(totalAssets > 0)) {
    return { ok: false, reason: "価格・ATR・総資産が不正です", entries: [], totalShares: 0, totalAmount: 0, avgEntry: 0, stop: 0, stopPct: 0, target: 0, riskAmount: 0, riskPctOfAssets: 0, rrr: 0, positionPctOfAssets: 0, notes };
  }

  // ── 1. 買いゾーン: 現値 / -1ATR / -2ATR。ただし支持帯 (20日安値) より下の指値は
  //       「支持割れを買い下がる」ことになるので、20日安値近辺で止める ──
  const e1 = roundTick(price);
  const e2raw = price - 1.0 * atr;
  const e3raw = price - 2.0 * atr;
  const supportFloor = Math.min(low20, price); // 支持帯
  const e2 = roundTick(Math.max(e2raw, supportFloor));
  const e3 = roundTick(Math.max(e3raw, low60 > 0 ? Math.min(supportFloor, low60 * 1.02) : supportFloor));
  if (e2raw < supportFloor) notes.push(`2段目は20日安値 (¥${low20.toLocaleString()}) 付近で調整 — 支持割れを買い下がらない`);

  // ── 2. 損切り: 最深エントリーの下 1.2ATR。60日安値を明確に割る位置なら「構造崩壊」として妥当 ──
  const stop = roundTick(e3 - 1.2 * atr);

  // ── 3. 予算: 1銘柄上限 と 現金 の小さい方 ──
  const budgetCap = Math.min((maxPosPct / 100) * totalAssets, cash);
  if (budgetCap < price * lotSize) {
    return {
      ok: false,
      reason: lotSize === 100
        ? `予算 ¥${Math.round(budgetCap).toLocaleString()} では1単元 (100株=¥${Math.round(price * 100).toLocaleString()}) に届きません。かぶミニ (1株単位) に切り替えるか、対象を見直してください`
        : `予算 ¥${Math.round(budgetCap).toLocaleString()} では1株も買えません`,
      entries: [], totalShares: 0, totalAmount: 0, avgEntry: 0, stop, stopPct: 0, target: 0, riskAmount: 0, riskPctOfAssets: 0, rrr: 0, positionPctOfAssets: 0, notes,
    };
  }

  // ── 4. 3分割の株数設計 (各ロットほぼ均等) → リスク上限で縮小 ──
  const riskBudget = (riskPct / 100) * totalAssets;
  const zones = [
    { label: "1段目 (現値)", price: e1 },
    { label: "2段目 (押し目 -1ATR)", price: e2 },
    { label: "3段目 (深押し -2ATR)", price: e3 },
  ];
  // 重複ゾーン (ATRが小さい等で同値になった) を除去
  const uniq = zones.filter((z, i) => i === 0 || z.price < zones[i - 1].price - 0.0001);
  if (uniq.length < zones.length) notes.push("値幅が狭いためエントリーを統合しました");

  const perLotBudget = budgetCap / uniq.length;
  let entries: PlanEntry[] = uniq.map((z) => {
    const shares = floorTo(perLotBudget / z.price, lotSize);
    return { label: z.label, price: z.price, shares, amount: Math.round(shares * z.price) };
  }).filter((e) => e.shares >= lotSize);

  if (entries.length === 0) {
    return { ok: false, reason: "予算を分割すると1ロットも組めません。かぶミニへの切替を検討してください", entries: [], totalShares: 0, totalAmount: 0, avgEntry: 0, stop, stopPct: 0, target: 0, riskAmount: 0, riskPctOfAssets: 0, rrr: 0, positionPctOfAssets: 0, notes };
  }

  // リスク超過なら全ロットを等比縮小
  const calcRisk = (es: PlanEntry[]) => es.reduce((s, e) => s + e.shares * Math.max(0, e.price - stop), 0);
  let risk = calcRisk(entries);
  if (risk > riskBudget) {
    const scale = riskBudget / risk;
    entries = entries.map((e) => {
      const shares = floorTo(e.shares * scale, lotSize);
      return { ...e, shares, amount: Math.round(shares * e.price) };
    }).filter((e) => e.shares >= lotSize);
    risk = calcRisk(entries);
    notes.push(`リスク上限 (総資産の${riskPct}% = ¥${Math.round(riskBudget).toLocaleString()}) に合わせて株数を縮小`);
    if (entries.length === 0) {
      return { ok: false, reason: `リスク上限 ¥${Math.round(riskBudget).toLocaleString()} 内では${lotSize === 100 ? "1単元も" : "1株も"}組めません (損切り幅が広すぎる)。かぶミニ切替か損切りの近い設計を検討`, entries: [], totalShares: 0, totalAmount: 0, avgEntry: 0, stop, stopPct: 0, target: 0, riskAmount: 0, riskPctOfAssets: 0, rrr: 0, positionPctOfAssets: 0, notes };
    }
  }

  const totalShares = entries.reduce((s, e) => s + e.shares, 0);
  const totalAmount = entries.reduce((s, e) => s + e.amount, 0);
  const avgEntry = totalAmount / totalShares;
  const stopPct = ((stop - avgEntry) / avgEntry) * 100;
  // 利確目安: RRR 2:1
  const target = roundTick(avgEntry + 2 * (avgEntry - stop));
  const rrr = 2;

  if (totalAmount > cash) notes.push("⚠ 全ロット約定時に現金を超えます (他の予定と要調整)");
  if (Math.abs(stopPct) > 15) notes.push("⚠ 損切り幅が15%超 — 中長期でも深すぎないか要検討");
  notes.push("2段目・3段目は指値で置くか、押したら手動で。埋まらなければそれで良し (追いかけない)");

  return {
    ok: true,
    entries,
    totalShares,
    totalAmount: Math.round(totalAmount),
    avgEntry: Math.round(avgEntry * 10) / 10,
    stop,
    stopPct: Math.round(stopPct * 10) / 10,
    target,
    riskAmount: Math.round(risk),
    riskPctOfAssets: Math.round((risk / totalAssets) * 1000) / 10,
    rrr,
    positionPctOfAssets: Math.round((totalAmount / totalAssets) * 1000) / 10,
    notes,
  };
}
