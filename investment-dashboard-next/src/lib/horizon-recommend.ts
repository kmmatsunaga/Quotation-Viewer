/**
 * 時間軸別おすすめ選定エンジン (純関数)
 *
 * 思想: 短期/中期/長期は「同じリストの並べ替え」ではなく、別の生き物。
 *  ⚡短期 = 今日の需給イベント (出来高×初動×相対強さ) — daily_features 全銘柄スキャンから
 *  🌱中期 = 続いているトレンド (20日モメンタム×時間軸スコア) — score_rankings + features
 *  🏔長期 = 事業の質 (Future Score 5因子×安定地形) — score_rankings + future-score
 *
 * 全 pick に「なぜ挙がったか」の根拠 (reasons) を必ず付ける。
 * お気に入りの無条件優遇はしない (メンツ固定化の原因だった) — 実力で選ぶ。
 * 投資助言ではなく「データがこう言っている」の提示。
 */

export interface FeatureRow {
  ticker: string;
  close: number;
  dayChangePct: number | null;
  volumeRatio: number | null;
  turnover: number | null;
  streak: number;
  isHigh20: boolean;
  isHigh60: boolean;
  ret5dPct: number | null;
  ret20dPct: number | null;
  rsi14: number | null;
  atrPct14: number | null;
  vsNikkeiPct: number | null;
  vsSectorPct: number | null;
  sector: string | null;
}

export interface RankEntry {
  ticker: string;
  name: string;
  market: "JP" | "US";
  price: number | null;
  short: number;
  mid: number;
  long: number;
  overall: number;
}

export interface HorizonPick {
  ticker: string;
  name: string;
  market: "JP" | "US";
  price: number | null;
  score: number;          // 0-100
  reasons: string[];      // なぜ挙がったか (必須)
  caution: string | null; // 注意 (決算接近など)
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const oku = (v: number) => `${r1(v / 1e8)}億`;

/** atrPct14 から地形の一言 (全銘柄バッチ前の近似。脆弱は候補から除外済み) */
function terrainHint(atrPct: number | null): string | null {
  if (atrPct == null) return null;
  if (atrPct >= 5) return `値動きは荒め (日次±${r1(atrPct)}%) — 枚数は控えめに`;
  if (atrPct <= 2.5) return null;
  return null;
}

// ────────────────────────────────────────────
// 統制群 (control): 「同じ関門を通ったが、順位付けでは選ばれなかった銘柄」
//
// なぜ必要か: pick が市場に勝っても「関門を通った銘柄なら何でも良かった」を否定できない。
// ロジックの価値 = pick超過 − 統制群超過 で初めて測れる。
// 必ず生成時に保存すること (後から再構築すると当時のプールを再現できず必ずバイアスが入る)。
// ────────────────────────────────────────────
export interface ControlEntry { ticker: string; price: number | null; market: "JP" | "US" }

/** プールから picks を除いてランダム n 件。rand は呼び出し側から注入 (テスト容易性) */
export function sampleControls(
  pool: ControlEntry[],
  picked: Set<string>,
  n: number,
  rand: () => number = Math.random,
): ControlEntry[] {
  const rest = pool.filter((p) => !picked.has(p.ticker));
  // Fisher-Yates で先頭 n 件だけシャッフル
  const a = [...rest];
  const take = Math.min(n, a.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rand() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, take);
}

/** ⚡短期の関門だけを通した「候補プール」(順位付けはしない) */
export function shortGatePool(features: FeatureRow[], excluded: Set<string>): ControlEntry[] {
  return features
    .filter((f) => {
      if (excluded.has(f.ticker)) return false;
      if ((f.turnover ?? 0) < 2e8) return false;
      if (f.close < 100) return false;
      if (f.rsi14 == null || f.rsi14 < 40 || f.rsi14 > 74) return false;
      if (f.atrPct14 != null && f.atrPct14 > 8) return false;
      if ((f.dayChangePct ?? 0) < -1) return false;
      if ((f.dayChangePct ?? 0) > 9) return false;
      return true;
    })
    .map((f) => ({ ticker: f.ticker, price: f.close, market: "JP" as const }));
}

/** 🌱中期の関門プール */
export function midGatePool(
  rankEntries: RankEntry[],
  featuresMap: Map<string, FeatureRow>,
  excluded: Set<string>,
): ControlEntry[] {
  return rankEntries
    .filter((e) => {
      if (excluded.has(e.ticker)) return false;
      if (e.mid < 58) return false;
      const f = featuresMap.get(e.ticker);
      if (f) {
        if (f.atrPct14 != null && f.atrPct14 > 8) return false;
        if ((f.ret20dPct ?? 0) < -5) return false;
        if (f.rsi14 != null && f.rsi14 > 75) return false;
      }
      return true;
    })
    .map((e) => ({ ticker: e.ticker, price: e.price, market: e.market }));
}

/** 🏔長期の関門プール (Future Score 精査前 = 素の長期スコア関門のみ) */
export function longGatePool(rankEntries: RankEntry[], excluded: Set<string>): ControlEntry[] {
  return rankEntries
    .filter((e) => !excluded.has(e.ticker) && e.long >= 58)
    .map((e) => ({ ticker: e.ticker, price: e.price, market: e.market }));
}

// ────────────────────────────────────────────
// ⚡ 短期 (数日): 出来高を伴う初動・ブレイク・相対強さ
// ────────────────────────────────────────────
export function buildShortList(
  features: FeatureRow[],
  ranks: Map<string, RankEntry>,
  nameOf: (t: string) => string,
  excluded: Set<string>,
  limit = 8,
): HorizonPick[] {
  const picks: (HorizonPick & { _s: number })[] = [];

  for (const f of features) {
    if (excluded.has(f.ticker)) continue;
    // ── 関門: 流動性 / 過熱・崩れ / 脆弱地形の近似除外 ──
    if ((f.turnover ?? 0) < 2e8) continue;                        // 売買代金2億以上
    if (f.close < 100) continue;                                  // 低位株除外
    if (f.rsi14 == null || f.rsi14 < 40 || f.rsi14 > 74) continue; // 冷えすぎ/過熱を除外
    if (f.atrPct14 != null && f.atrPct14 > 8) continue;           // 宝くじ地形は短期候補にしない
    if ((f.dayChangePct ?? 0) < -1) continue;                     // 崩れている日ではない
    if ((f.dayChangePct ?? 0) > 9) continue;                      // 噴き上げ済みは追わない

    // ── トリガー (1つ以上必要。そのまま根拠になる) ──
    const reasons: string[] = [];
    const vol = f.volumeRatio ?? 0;
    const chg = f.dayChangePct ?? 0;
    const rel = f.vsNikkeiPct ?? 0;

    if (vol >= 1.8 && chg >= 1.5) {
      reasons.push(`出来高${r1(vol)}倍を伴って +${r1(chg)}% — 資金流入の初動`);
    }
    if (f.isHigh20 && chg > 0) {
      reasons.push(`20日高値を更新 — 直近の上値しこりが薄く伸びやすい`);
    }
    if (rel >= 1.5 && chg >= 0.5) {
      reasons.push(`日経比 +${r1(rel)}% の相対強さ — 地合いに頼らず買われている`);
    }
    if (reasons.length === 0) continue;

    // ── スコア (説明可能な加点方式) ──
    let s = 40;
    s += Math.min(20, Math.max(0, (vol - 1) * 8));       // 出来高
    s += Math.min(12, Math.max(0, rel) * 3);             // 相対強さ
    if (f.isHigh20) s += 12;
    if (f.rsi14 >= 50 && f.rsi14 <= 65) { s += 6; reasons.push(`RSI ${Math.round(f.rsi14)} — 過熱前の適温`); }
    const rank = ranks.get(f.ticker);
    if (rank && rank.short >= 60) { s += 8; reasons.push(`短期テクニカル総合スコア ${rank.short} (ランキング上位)`); }

    // 補足情報
    reasons.push(`売買代金 ${oku(f.turnover ?? 0)} — 流動性は十分`);
    const hint = terrainHint(f.atrPct14);

    picks.push({
      ticker: f.ticker,
      name: rank?.name ?? nameOf(f.ticker),
      market: "JP",
      price: f.close,
      score: Math.min(100, Math.round(s)),
      reasons,
      caution: hint,
      _s: s,
    });
  }

  picks.sort((a, b) => b._s - a._s);
  return picks.slice(0, limit).map(({ _s, ...p }) => { void _s; return p; });
}

// ────────────────────────────────────────────
// 🌱 中期 (数週〜数ヶ月): 続いているトレンド
// ────────────────────────────────────────────
export function buildMidList(
  rankEntries: RankEntry[],
  featuresMap: Map<string, FeatureRow>,
  excluded: Set<string>,
  limit = 10,
): HorizonPick[] {
  const picks: (HorizonPick & { _s: number })[] = [];

  for (const e of rankEntries) {
    if (excluded.has(e.ticker)) continue;
    if (e.mid < 58) continue; // 中期スコアの土台

    const f = featuresMap.get(e.ticker); // JP のみ存在
    const reasons: string[] = [];
    let s = e.mid;

    if (f) {
      // JP: features で精査
      if (f.atrPct14 != null && f.atrPct14 > 8) continue;          // 脆弱地形は中期でも避ける
      if ((f.ret20dPct ?? 0) < -5) continue;                        // 下向きトレンドは弾く
      if (f.rsi14 != null && f.rsi14 > 75) continue;                // 過熱

      const t20 = f.ret20dPct ?? 0;
      if (t20 >= 5 && t20 <= 45) {
        s += Math.min(12, t20 * 0.4);
        reasons.push(`直近20日で +${r1(t20)}% — トレンドが続いている (伸び切ってはいない)`);
      }
      if (f.isHigh60) { s += 8; reasons.push(`60日高値圏 — 中期の主導株の位置`); }
      if ((f.vsSectorPct ?? 0) >= 2) { s += 4; reasons.push(`同セクター比 +${r1(f.vsSectorPct ?? 0)}% — 業界内でも選ばれている`); }
      if (f.atrPct14 != null && f.atrPct14 <= 3) reasons.push(`値動きが安定 (日次±${r1(f.atrPct14)}%) — 中期で持ちやすい`);
    }

    reasons.push(`中期テクニカル総合スコア ${e.mid} (トレンド/モメンタム/需給の合成)`);

    picks.push({
      ticker: e.ticker,
      name: e.name,
      market: e.market,
      price: e.price,
      score: Math.min(100, Math.round(s)),
      reasons,
      caution: null,
      _s: s,
    });
  }

  picks.sort((a, b) => b._s - a._s);
  return picks.slice(0, limit).map(({ _s, ...p }) => { void _s; return p; });
}

// ────────────────────────────────────────────
// 🏔 長期 (数ヶ月〜年): 事業の質 × 安定地形
// ────────────────────────────────────────────
export interface LongEnrichment {
  overallRaw: number | null;
  verdict: string | null;
  summary: string | null;
  valueTrap: boolean;
  valueTrapReason: string | null;
  topFactors: string[];    // 例: ["成長性 A", "収益力 B+"]
  upsidePct: number | null;
}

export function buildLongList(
  rankEntries: RankEntry[],
  featuresMap: Map<string, FeatureRow>,
  enrich: Map<string, LongEnrichment>,
  excluded: Set<string>,
  limit = 8,
): HorizonPick[] {
  const picks: (HorizonPick & { _s: number })[] = [];

  for (const e of rankEntries) {
    if (excluded.has(e.ticker)) continue;
    if (e.long < 58) continue;

    const en = enrich.get(e.ticker);
    const reasons: string[] = [];
    let s = e.long * 0.6;
    let caution: string | null = null;

    if (en) {
      if (en.valueTrap) continue; // 🪤 安いのには理由がある銘柄を長期で掴まない
      if (en.overallRaw != null) {
        s += en.overallRaw * 0.4;
        reasons.push(`将来性スコア ${en.overallRaw} (5因子総合)`);
      }
      if (en.topFactors.length > 0) reasons.push(`強い因子: ${en.topFactors.join(" / ")}`);
      if (en.summary) reasons.push(en.summary);
      if (en.upsidePct != null && en.upsidePct >= 15) {
        s += 4;
        reasons.push(`アナリスト目標株価まで +${r1(en.upsidePct)}% の余地`);
      }
    } else {
      s += e.overall * 0.3; // future-score が取れなかった場合のフォールバック
    }

    const f = featuresMap.get(e.ticker);
    if (f?.atrPct14 != null) {
      if (f.atrPct14 <= 3) { s += 5; reasons.push(`値動きが穏やか (日次±${r1(f.atrPct14)}%) — 長期保有に向く地形`); }
      else if (f.atrPct14 > 7) caution = `値動きが荒い (日次±${r1(f.atrPct14)}%) — 長期でも下振れ耐性の確認を`;
    }

    reasons.push(`長期テクニカル総合スコア ${e.long}`);

    picks.push({
      ticker: e.ticker,
      name: e.name,
      market: e.market,
      price: e.price,
      score: Math.min(100, Math.round(s)),
      reasons,
      caution,
      _s: s,
    });
  }

  picks.sort((a, b) => b._s - a._s);
  return picks.slice(0, limit).map(({ _s, ...p }) => { void _s; return p; });
}
