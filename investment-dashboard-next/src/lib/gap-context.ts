/**
 * 🌅 寄りギャップ文脈 — 「今朝のGU/GDは統計的にどっち向きか」を返す純関数。
 *
 * 根拠: 2026-07-23 Phase 0 検証 (daily_features 2年×4,062銘柄、日クラスタ補正t)。
 * インフルエンサー記事の主張をデータで検証した結果、以下だけが生き残った:
 *
 *  ・初動 (直近5日リターン<10%) の大幅GU(+4%超) → 寄→引は大幅マイナス
 *      高ボラ -3.52% (勝率26.9%, t=-14.0) / 中 -1.86% (t=-15.0) / 低 -1.14% (t=-11.2)
 *      = 「寄り飛び乗り」は統計的に罠。記事の警告どおり
 *  ・既走 (5日+10%済) × 低〜中ボラ の大幅GU → 寄→引でさらに上がる
 *      低ボラ +1.47% (勝率60.9%, t=+8.1) / 中 +1.75% (勝率56.8%, t=+9.5)
 *      = 「強い銘柄は上値を追い続ける」の定量的証明。記事の1章の哲学
 *  ・既走でも高ボラ (祭り銘柄) は -0.83% (t=-2.3) → 地形が攻めでも効く
 *  ・大幅GD(-4%超): 個別要因は続落しやすい (-0.78%, t=-3.1)。
 *      全面安の日のみ小さなリバ期待 (+0.5〜0.7%, t≈1.9) だが裾が太い (p10 -4.1%)
 *
 * これは「寄りで買う/買わない」の統計的文脈であって、売買指示ではない。
 */

export interface GapContext {
  kind: "fresh_gu" | "ran_gu" | "ran_gu_fragile" | "big_gd";
  tone: "pos" | "warn" | "neg";
  label: string;   // 短い見出し
  detail: string;  // 根拠つきの一言
}

export function assessGapContext(input: {
  /** 今朝の寄りギャップ % (前日終値比) */
  gapPct: number | null;
  /** 昨日までの直近5営業日リターン % (当日を含めない) */
  ret5dPriorPct: number | null;
  /** 脆弱地形スコア 0..100 (無ければ null = 安定扱い) */
  terrainScore: number | null;
}): GapContext | null {
  const { gapPct, ret5dPriorPct, terrainScore } = input;
  if (gapPct == null) return null;

  const fragile = (terrainScore ?? 0) >= 65; // Phase 0 の hi_vol (atr>=6%) 相当

  // ── 大幅GU (+4%超) ──
  if (gapPct >= 4) {
    if (ret5dPriorPct == null) return null; // 判定材料不足なら黙る
    if (ret5dPriorPct < 10) {
      return {
        kind: "fresh_gu",
        tone: "neg",
        label: "🔴 初動の大幅GU — 寄り飛び乗りは統計的に罠",
        detail: `初動銘柄のGU+4%超は寄→引で平均-1.1〜-3.5% (勝率27〜32%, t=-11〜-15)。追うなら押し (VWAP/始値奪還) を待つ方が分が良い。`,
      };
    }
    if (fragile) {
      return {
        kind: "ran_gu_fragile",
        tone: "warn",
        label: "⚠ 祭り銘柄のGU — 既走でも寄→引は売られがち",
        detail: `高ボラ地形は既走トレンドでも寄→引 平均-0.8% (t=-2.3)。祭りの上のGUは利確が出やすい。`,
      };
    }
    return {
      kind: "ran_gu",
      tone: "pos",
      label: "🟢 既走トレンドのGU — 寄り後も続伸しやすい",
      detail: `5日+10%済×低中ボラのGU+4%超は寄→引 平均+1.5〜1.8% (勝率57〜61%, t=+8〜9.5)。「強い銘柄は上値を追う」が統計的に成立する数少ない地形。`,
    };
  }

  // ── 大幅GD (-4%超) ──
  if (gapPct <= -4) {
    return {
      kind: "big_gd",
      tone: "warn",
      label: "⚠ 大幅GD — 個別要因なら続落しやすい",
      detail: `個別材料のGDは寄→引でさらに-0.8% (t=-3.1)。全面安の日だけ小さなリバ期待 (+0.5〜0.7%) があるが裾が太い (10回に1回は-4%超)。安易な逆張りは非推奨。`,
    };
  }

  return null;
}
