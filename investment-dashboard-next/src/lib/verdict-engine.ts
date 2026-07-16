/**
 * Cavka Verdict Engine — 「スコア合成」から「見解の合議」へ
 *
 * 思想:
 *   全データソースを「証人 (Witness)」として扱う。各証人は
 *   方向 (-1..+1) × 確信度 (0..1) × 影響力 (weight) × 時間軸 で証言する。
 *
 *   - 合意していれば「確信のある見解」
 *   - 割れていれば「対立 (contested)」— 消さずに、そのまま見せる。
 *     対立それ自体が「答えが出しにくい状況だ」という重要な情報。
 *
 * 出力は時間軸別 (短期/中期/長期) の評決 + 対立リスト + 評決文。
 */

export type Timeframe = "short" | "mid" | "long";

export interface Witness {
  id: string;
  label: string;            // 表示名 (例: "将来性ファンダ")
  emoji: string;
  direction: number;        // -1.0 (強い弱気) 〜 +1.0 (強い強気)
  confidence: number;       // 0-1 (データ鮮度・量に基づく証言の信頼度)
  weight: number;           // 影響力 (時間軸内での相対値)
  timeframes: Timeframe[];  // この証言が効く時間軸
  reason: string;           // 1行の理由 (評決文に使う)
}

export interface Conflict {
  bullId: string;
  bullLabel: string;
  bearId: string;
  bearLabel: string;
  note: string;             // 対立の解釈 (例: "業績は強いが市場は織り込んでいない")
}

export type Stance = "strong_bull" | "bull" | "neutral" | "bear" | "strong_bear" | "contested";

export interface TimeframeVerdict {
  timeframe: Timeframe;
  stance: Stance;
  direction: number;        // 加重平均方向 -1..+1
  conviction: number;       // 0-100 (方向の強さ × 合意度 × カバレッジ)
  consensus: number;        // 0-1 (証人の一致度。1=全員同方向)
  coverage: number;         // 0-1 (この時間軸で証言できた証人の充実度)
  bulls: Witness[];
  bears: Witness[];
  neutrals: Witness[];
  conflicts: Conflict[];
  narrative: string;        // 評決文 (理由付き1〜2文)
}

export interface VerdictResult {
  verdicts: Record<Timeframe, TimeframeVerdict>;
  overallNote: string;      // 時間軸間の関係についての一言 (例: "短期は対立、長期は強気")
  witnessCount: number;
}

// ───────────────────────────────────────────────
// 対立ペアの解釈辞書 (bullId__bearId → 解釈)
// ───────────────────────────────────────────────

const CONFLICT_NOTES: Record<string, string> = {
  // ファンダ強気 × テクニカル弱気 → 未織り込み
  "future__tech": "業績・将来性は強いが、株価はまだ追いついていない。市場が織り込む前の可能性と、市場が何かを知っている可能性の両方がある",
  "momentum__tech": "業績モメンタムは加速中だが、チャートは弱い。転換点の初動か、業績鈍化の先読みか",
  // テクニカル強気 × ファンダ弱気 → 過熱
  "tech__future": "株価は強いが業績の裏付けが弱い。需給主導の上昇は反落も早い",
  "tech__momentum": "チャートは強いが業績の加速が見えない。テーマ株的な動きに注意",
  // セクター × 個別
  "sector__future": "セクター全体は追い風だが、この銘柄自体の業績は弱い。出遅れ Catch-up か、単に劣後か",
  "future__sector": "銘柄自体は優秀だがセクター全体が逆風。地合いに引きずられるリスク",
  // ニュース × その他
  "news__future": "ニュースは好感されているが業績が伴っていない。期待先行",
  "future__news": "業績は良いがニュースフローが悪い。悪材料の織り込み中",
  "news__tech": "ニュースは良いが株価反応が鈍い。材料出尽くしの可能性",
  // 需給
  "supply__tech": "需給は締まっている (踏み上げ余地) がチャートは弱い。反発の起点になりやすい",
  "tech__supply": "チャートは強いが信用買残が積み上がっている。上値は重くなりやすい",
  "macro__future": "マクロ環境は追い風だが銘柄業績が弱い。恩恵を取り込めていない",
  "future__macro": "業績は強いがマクロが逆風。外部環境の変化に注意",
};

function conflictNote(bullId: string, bearId: string): string {
  // id の前半 (カテゴリ) で辞書を引く
  const cat = (id: string): string => {
    if (id.startsWith("tech_") || id.startsWith("pattern_")) return "tech";
    if (id === "future" || id === "value_trap" || id === "disclosure") return "future";
    if (id === "momentum") return "momentum";
    if (id === "sector") return "sector";
    if (id === "news") return "news";
    if (id === "supply") return "supply";
    if (id === "macro") return "macro";
    return id;
  };
  return (
    CONFLICT_NOTES[`${cat(bullId)}__${cat(bearId)}`] ??
    "強気材料と弱気材料が拮抗。判断を急がず両方の根拠を確認したい局面"
  );
}

// ───────────────────────────────────────────────
// 集計
// ───────────────────────────────────────────────

const TF_LABELS: Record<Timeframe, string> = {
  short: "短期 (数日〜数週)",
  mid: "中期 (1〜6ヶ月)",
  long: "長期 (6ヶ月〜)",
};

/** この時間軸で期待される最大 weight 合計 (カバレッジ計算用の目安) */
const EXPECTED_WEIGHT: Record<Timeframe, number> = {
  short: 10,
  mid: 14,
  long: 12,
};

function stanceOf(direction: number, consensus: number, hasStrongBothSides: boolean): Stance {
  // 対立判定を最優先: 両陣営に強い証人がいて、合意度が低い
  if (hasStrongBothSides && consensus < 0.60) return "contested";
  if (direction >= 0.45) return "strong_bull";
  if (direction >= 0.15) return "bull";
  if (direction <= -0.45) return "strong_bear";
  if (direction <= -0.15) return "bear";
  return "neutral";
}

export const STANCE_META: Record<Stance, { label: string; emoji: string; color: string }> = {
  strong_bull: { label: "強気", emoji: "🔺", color: "#ff3b6b" },
  bull: { label: "やや強気", emoji: "🔺", color: "#ff7a9c" },
  neutral: { label: "中立", emoji: "🟡", color: "#facc15" },
  bear: { label: "やや弱気", emoji: "🔻", color: "#5ce1ff" },
  strong_bear: { label: "弱気", emoji: "🔻", color: "#00d9ff" },
  contested: { label: "見解対立", emoji: "⚡", color: "#a78bfa" },
};

function buildNarrative(v: Omit<TimeframeVerdict, "narrative">): string {
  const meta = STANCE_META[v.stance];
  const topBull = [...v.bulls].sort((a, b) => b.direction * b.weight * b.confidence - a.direction * a.weight * a.confidence)[0];
  const topBear = [...v.bears].sort((a, b) => a.direction * a.weight * a.confidence - b.direction * b.weight * b.confidence)[0];

  if (v.stance === "contested") {
    const c = v.conflicts[0];
    return `判断が割れている局面。${topBull ? `強気側は${topBull.label} (${topBull.reason})` : ""}${topBull && topBear ? "、" : ""}${topBear ? `弱気側は${topBear.label} (${topBear.reason})` : ""}。${c ? c.note : ""}`;
  }
  if (v.stance === "neutral") {
    if (v.coverage < 0.4) return "証言が少なく判断材料不足。データが揃うまで様子見が無難";
    return `強弱どちらにも決め手なし。${topBull ? `プラス材料は${topBull.label}` : ""}${topBull && topBear ? "、" : ""}${topBear ? `マイナス材料は${topBear.label}` : ""}だが、いずれも決定打ではない`;
  }
  const dir = v.direction > 0;
  const main = dir ? topBull : topBear;
  const counter = dir ? topBear : topBull;
  let s = `${meta.label} (確信度${v.conviction}%)`;
  if (main) s += `。主因は${main.label}: ${main.reason}`;
  if (counter) s += `。ただし${counter.label}が逆方向 (${counter.reason})`;
  else if (v.consensus >= 0.85) s += `。証言はほぼ全員一致`;
  return s;
}

export function aggregateVerdicts(witnesses: Witness[]): VerdictResult {
  const verdicts = {} as Record<Timeframe, TimeframeVerdict>;

  for (const tf of ["short", "mid", "long"] as Timeframe[]) {
    const ws = witnesses.filter((w) => w.timeframes.includes(tf) && w.confidence > 0);

    const bulls = ws.filter((w) => w.direction >= 0.15);
    const bears = ws.filter((w) => w.direction <= -0.15);
    const neutrals = ws.filter((w) => w.direction > -0.15 && w.direction < 0.15);

    // 加重平均方向
    const totalW = ws.reduce((s, w) => s + w.weight * w.confidence, 0);
    const direction = totalW > 0 ? ws.reduce((s, w) => s + w.direction * w.weight * w.confidence, 0) / totalW : 0;

    // 合意度: 多数派方向と同符号の重み比率
    const majoritySign = Math.sign(direction) || 1;
    const agreeW = ws
      .filter((w) => Math.sign(w.direction) === majoritySign || Math.abs(w.direction) < 0.15)
      .reduce((s, w) => s + w.weight * w.confidence, 0);
    const consensus = totalW > 0 ? agreeW / totalW : 0;

    // カバレッジ
    const coverage = Math.min(1, totalW / EXPECTED_WEIGHT[tf]);

    // 対立検出: 両陣営の「強い証人」(|direction| >= 0.4 かつ weight*confidence 上位)
    const strongBulls = bulls.filter((w) => w.direction >= 0.4 && w.weight * w.confidence >= 1.5);
    const strongBears = bears.filter((w) => w.direction <= -0.4 && w.weight * w.confidence >= 1.5);
    const conflicts: Conflict[] = [];
    for (const b of strongBulls.slice(0, 2)) {
      for (const r of strongBears.slice(0, 2)) {
        conflicts.push({
          bullId: b.id,
          bullLabel: b.label,
          bearId: r.id,
          bearLabel: r.label,
          note: conflictNote(b.id, r.id),
        });
      }
    }

    const hasStrongBothSides = strongBulls.length > 0 && strongBears.length > 0;
    const stance = stanceOf(direction, consensus, hasStrongBothSides);

    // 確信度: 方向の強さ × 合意度 × カバレッジ
    const conviction = Math.round(Math.abs(direction) * consensus * Math.max(coverage, 0.3) * 100);

    const base = {
      timeframe: tf,
      stance,
      direction: Math.round(direction * 100) / 100,
      conviction,
      consensus: Math.round(consensus * 100) / 100,
      coverage: Math.round(coverage * 100) / 100,
      bulls: bulls.sort((a, b) => b.direction * b.weight * b.confidence - a.direction * a.weight * a.confidence),
      bears: bears.sort((a, b) => a.direction * a.weight * a.confidence - b.direction * b.weight * b.confidence),
      neutrals,
      conflicts: conflicts.slice(0, 3),
    };
    verdicts[tf] = { ...base, narrative: buildNarrative(base) };
  }

  // 時間軸間の総括
  const s = verdicts.short.stance;
  const m = verdicts.mid.stance;
  const l = verdicts.long.stance;
  const bullish = (x: Stance) => x === "bull" || x === "strong_bull";
  const bearish = (x: Stance) => x === "bear" || x === "strong_bear";

  let overallNote: string;
  if ([s, m, l].every(bullish)) {
    overallNote = "全時間軸で強気が揃う。順風。";
  } else if ([s, m, l].every(bearish)) {
    overallNote = "全時間軸で弱気。近づかない方が無難。";
  } else if ([s, m, l].some((x) => x === "contested")) {
    const which = [s === "contested" ? "短期" : null, m === "contested" ? "中期" : null, l === "contested" ? "長期" : null].filter(Boolean).join("・");
    overallNote = `${which}で見解が対立中。答えを急がず、対立の中身を見るべき局面。`;
  } else if (bearish(s) && bullish(l)) {
    overallNote = "短期は弱いが長期は強気。押し目を待つ型。";
  } else if (bullish(s) && bearish(l)) {
    overallNote = "短期は強いが長期に不安。深追い注意の短期勝負型。";
  } else {
    overallNote = "時間軸で強弱まちまち。自分の投資期間に合う軸だけ見る。";
  }

  return { verdicts, overallNote, witnessCount: witnesses.filter((w) => w.confidence > 0).length };
}

export { TF_LABELS };
