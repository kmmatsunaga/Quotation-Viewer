/**
 * モメンタム・グロース・モデルの全パラメータ (momentum_growth_model.md §6 準拠)
 *
 * Hardcode 禁止 — ここでチューニング。
 * デフォルトは「未発見の主役候補」を狙う設定 (MD で示されたデフォルトより厳しめ)。
 */

export interface MomentumParams {
  weights: {
    p1_growth: number;       // 30
    p2_estimate: number;     // 25
    p3_margin: number;       // 20
    p4_pricing: number;      // 10
    t_technical: number;     // 15
  };
  thresholds: {
    MIN_REV_GROWTH: number;       // P1 最低増収率 (= 15%)
    MIN_TURNOVER: number;         // 流動性ゲート (= ¥100M / 日)
    MAX_EXT: number;              // 200日線からの最大乖離 (= +50% に厳格化、元 +100%)
    MAX_PEG: number;              // (= 2.0 に厳格化、元 3.0)
    REV_GROWTH_FULL: number;      // P1 水準満点 (= 30%)
    ACCEL_FULL: number;           // P1 加速度満点 (= +10pt)
    OP_MARGIN_FULL: number;       // P3 利益率改善満点 (= +5pt)
    GM_LEVEL_FULL: number;        // P4 粗利率満点 (= 40%)
    CONS_REV_FULL: number;        // P2 コンセンサス改定満点 (= +10%)
    BIG_RUNUP_12M: number;        // no_base_gate しきい値 (= +150% に厳格化、元 +300%)
    NO_BASE_DRAWDOWN: number;     // 「ベースなし」判定: 12M中の最大DD (= 15%未満なら "ベースなし")
    MIN_QUARTERS_LISTED: number;  // IPO直後を no_base_gate から除外する閾値 (= 4Q)
    GUIDANCE_CUT_THRESHOLD: number; // cons_eps_rev <= -X で下方修正扱い (= -3%)
    // 「未発見の主役候補」フォーカス (MD 範囲外、Cavka 独自ゲート)
    MAX_MARKET_CAP_USD: number;   // 米国株: $200B超で除外
    MAX_MARKET_CAP_JPY: number;   // 日本株: ¥3兆超で除外
    MAX_ANALYSTS: number;         // 機関投資家カバレッジ上限
    MAX_RETURN_12M: number;       // 12Mリターン上限 (これを超えたら「もう主役」扱い)
  };
  exclusion: {
    use_peg_soft: boolean;        // true: PEG を除外じゃなく減点運用
    peg_soft_penalty: number;     // soft penalty 幅 (合計スコアから減点)
  };
  // P2 サブ配分 (TDnetガイダンス無のため再配分)
  // 元: ガイダンス10 + cons改定8 + サプライズ7 = 25
  // 改: cons改定 + サプライズ で 25pt 再配分
  p2_redistribution: {
    cons_eps_rev: number;         // = 13
    surprise_streak: number;      // = 12
    guidance_down_penalty: number; // = 15 (cons_eps_revが大幅下方修正なら減点)
  };
}

export const DEFAULT_PARAMS: MomentumParams = {
  weights: {
    p1_growth: 30,
    p2_estimate: 25,
    p3_margin: 20,
    p4_pricing: 10,
    t_technical: 15,
  },
  thresholds: {
    MIN_REV_GROWTH: 0.15,
    MIN_TURNOVER: 100_000_000,
    MAX_EXT: 0.50,            // 200日線+50%超で除外
    MAX_PEG: 2.0,
    REV_GROWTH_FULL: 0.30,
    ACCEL_FULL: 0.10,
    OP_MARGIN_FULL: 0.05,
    GM_LEVEL_FULL: 0.40,
    CONS_REV_FULL: 0.10,
    BIG_RUNUP_12M: 1.50,      // 12M +150%超 かつベース無しで除外
    NO_BASE_DRAWDOWN: 0.15,   // 15%以上のDDが12Mに無ければ "ベース無し"
    MIN_QUARTERS_LISTED: 4,
    GUIDANCE_CUT_THRESHOLD: -0.03,
    MAX_MARKET_CAP_USD: 200_000_000_000,    // $200B (v3: $500B → $200B に厳格化)
    MAX_MARKET_CAP_JPY: 3_000_000_000_000,  // ¥3兆 (v3: ¥5兆 → ¥3兆)
    MAX_ANALYSTS: 20,                        // v3: 25 → 20 に厳格化
    MAX_RETURN_12M: 2.00,                    // 12Mリターン +200%超で除外 (CIEN型を弾く)
  },
  exclusion: {
    use_peg_soft: true,
    peg_soft_penalty: 8,
  },
  p2_redistribution: {
    cons_eps_rev: 13,
    surprise_streak: 12,
    guidance_down_penalty: 15,
  },
};
