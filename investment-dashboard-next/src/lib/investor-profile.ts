/**
 * 🩺 投資家問診票 (Investor Profile)
 *
 * 思想: Cavka は「ツール」ではなく「パートナー」を目指す。パートナーであるためには
 * 相手を知る必要がある。ここで集めるのは【本人が宣言した意図】であり、
 * 診断側はそれを【実測データと照合】して"ズレ"だけを指摘する。
 *
 * 重要な設計原則:
 *  ・私 (Cavka) が「こうすべき」と助言はしない。本人の宣言を鏡として当てるだけ
 *  ・正解のない質問しかない。すべて任意回答 (無回答も情報)
 *  ・回答は保存・編集可能。保存のたびに履歴を残し、心境の変化を追える
 *
 * 質問構成は、証券会社の適合性確認 (目的/期間/許容度) に、
 * 行動ファイナンスの既知バイアス (損失回避・処分効果・自信過剰・追随) と
 * スタイル選好 (配当/成長・集中/分散・土俵) を足したもの。
 */

export type QuestionType = "single" | "multi" | "scale" | "number" | "text" | "month";

export interface Question {
  id: string;
  label: string;
  help?: string;              // 用語や意図の補足 (初見でも答えられるように)
  type: QuestionType;
  options?: { value: string; label: string; note?: string }[];
  min?: number; max?: number; step?: number; unit?: string;
  placeholder?: string;
  /** この質問がどの合成スコアに寄与するか (スコア: 0-100) */
  scores?: { key: ScoreKey; map: Record<string, number> }[];
  /** 🪞 = ポートフォリオ診断で「実測」と突き合わせる質問 (聞きっぱなしにしない印) */
  mirrored?: boolean;
}

/**
 * 「触りたくない業種」の選択肢。
 * 自由記述だけだと保有銘柄と機械照合できないため、チップ選択と併用する。
 * match は Yahoo 業種名 (stock_industry) に対する部分一致パターン。
 */
export const AVOID_GROUPS: { value: string; label: string; match: RegExp }[] = [
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

export interface Section {
  id: string;
  title: string;
  emoji: string;
  description: string;
  questions: Question[];
}

export type ScoreKey =
  | "riskAppetite"    // リスク選好 (高いほど攻める)
  | "lossTolerance"   // 損失耐性 (高いほど耐えられる)
  | "timeHorizon"     // 時間軸 (高いほど長期)
  | "incomeFocus"     // 配当・インカム志向 (高いほど配当重視)
  | "concentration"   // 集中志向 (高いほど集中したい)
  | "discipline"      // 規律 (高いほどルールを持ち守る)
  | "urgency";        // 焦り度 (高いほど急いでいる)

export const SCORE_META: Record<ScoreKey, { label: string; low: string; high: string; emoji: string }> = {
  riskAppetite: { label: "リスク選好", low: "手堅く", high: "攻める", emoji: "🎲" },
  lossTolerance: { label: "損失耐性", low: "耐えにくい", high: "耐えられる", emoji: "🛡" },
  timeHorizon: { label: "時間軸", low: "短期", high: "長期", emoji: "⏳" },
  incomeFocus: { label: "インカム志向", low: "値上がり益", high: "配当重視", emoji: "💵" },
  concentration: { label: "集中志向", low: "分散したい", high: "集中したい", emoji: "🎯" },
  discipline: { label: "規律", low: "裁量的", high: "ルール厳守", emoji: "📏" },
  urgency: { label: "焦り度", low: "急がない", high: "急いでいる", emoji: "🔥" },
};

const scale5 = (id: string, label: string, help: string, scores?: Question["scores"]): Question => ({
  id, label, help, type: "scale", min: 1, max: 5, step: 1, scores,
});

export const SECTIONS: Section[] = [
  // ────────────────────────────────
  {
    id: "goal",
    title: "目標と期限",
    emoji: "🎯",
    description: "何を、いつまでに。ここが決まると「今のリスクの取り方が妥当か」を計算で確かめられます。",
    questions: [
      { id: "goalAmount", label: "目標金額", help: "投資資産 (現金含む) をいくらにしたいか。ざっくりで構いません。", type: "number", unit: "円", placeholder: "1200000", mirrored: true },
      { id: "goalDate", label: "その目標の期限", help: "年月を選んでください。急ぐほど必要リターンが上がり、必要リターンが上がるほどリスクを取らざるを得なくなります。", type: "month", placeholder: "2027-03", mirrored: true },
      {
        id: "goalPurpose", label: "この資金の使い道", type: "single",
        options: [
          { value: "surplus", label: "完全な余裕資金 (無くなっても生活に影響しない)" },
          { value: "future", label: "将来の大きな出費 (住宅・教育・老後など)" },
          { value: "living", label: "生活費の補填を期待している" },
          { value: "undecided", label: "特に決めていない" },
        ],
        scores: [{ key: "lossTolerance", map: { surplus: 85, future: 55, living: 20, undecided: 50 } }],
        mirrored: true,
      },
      { id: "monthlyAdd", label: "毎月の追加入金額", help: "積立や給与からの入金。0でも構いません。ここが大きいほど、相場に頼らず目標に近づけます。", type: "number", unit: "円/月", placeholder: "0", mirrored: true },
      {
        id: "horizon", label: "この資金を使わずに置いておける期間", type: "single",
        options: [
          { value: "lt1y", label: "1年未満" }, { value: "1to3y", label: "1〜3年" },
          { value: "3to10y", label: "3〜10年" }, { value: "gt10y", label: "10年以上" },
        ],
        scores: [{ key: "timeHorizon", map: { lt1y: 10, "1to3y": 35, "3to10y": 70, gt10y: 95 } }],
      },
    ],
  },
  // ────────────────────────────────
  {
    id: "capacity",
    title: "体力 (客観的に取れるリスク)",
    emoji: "🏋",
    description: "「取りたいリスク」ではなく「取っても壊れないリスク」。ここは気持ちではなく状況の話です。",
    questions: [
      {
        id: "assetShare", label: "全財産のうち、株式投資に回している割合", type: "single",
        options: [
          { value: "lt10", label: "1割未満" }, { value: "10to30", label: "1〜3割" },
          { value: "30to50", label: "3〜5割" }, { value: "gt50", label: "5割以上" },
        ],
        scores: [{ key: "lossTolerance", map: { lt10: 85, "10to30": 65, "30to50": 40, gt50: 20 } }],
      },
      {
        id: "incomeStability", label: "収入の安定性", type: "single",
        options: [
          { value: "stable", label: "安定している (固定給など)" },
          { value: "variable", label: "変動がある" },
          { value: "unstable", label: "不安定・見通しが立たない" },
        ],
        scores: [{ key: "lossTolerance", map: { stable: 75, variable: 50, unstable: 25 } }],
      },
      {
        id: "experience", label: "株式投資の経験", type: "single",
        options: [
          { value: "lt1y", label: "1年未満" }, { value: "1to3y", label: "1〜3年" },
          { value: "3to10y", label: "3〜10年" }, { value: "gt10y", label: "10年以上" },
        ],
      },
      {
        id: "crashExperience", label: "大きな暴落 (資産が2〜3割減る局面) を経験したことは?",
        help: "経験の有無で、次の暴落での行動はかなり変わります。",
        type: "single",
        options: [
          { value: "none", label: "ない" },
          { value: "held", label: "ある — 持ちこたえた" },
          { value: "sold", label: "ある — 耐えられず売った" },
          { value: "bought", label: "ある — むしろ買い増した" },
        ],
        scores: [{ key: "lossTolerance", map: { none: 45, held: 70, sold: 25, bought: 90 } }],
      },
    ],
  },
  // ────────────────────────────────
  {
    id: "temperament",
    title: "気質 (取りたいリスク)",
    emoji: "🎲",
    description: "正解はありません。ギャンブル寄りが悪いわけでもない。ただ「自分がどちら寄りか」を知らないまま運用すると、必ず途中で崩れます。",
    questions: [
      { ...scale5("thrill", "大きく勝てる可能性があるなら、大きく負けてもよい", "1=まったく思わない 〜 5=強くそう思う", [{ key: "riskAppetite", map: { "1": 10, "2": 30, "3": 50, "4": 75, "5": 95 } }]), mirrored: true },
      { ...scale5("volPreference", "値動きの激しい銘柄は、見ていて楽しい", "1=苦手 〜 5=好き。デイトレ適性に直結します。", [{ key: "riskAppetite", map: { "1": 15, "2": 35, "3": 50, "4": 70, "5": 90 } }]), mirrored: true },
      {
        id: "drawdownReaction", label: "保有株が -30% になったら、実際にどうすると思いますか",
        help: "「どうすべきか」ではなく「実際にどうしてしまうか」で答えてください。",
        type: "single",
        options: [
          { value: "panic", label: "耐えられず売る" },
          { value: "hold", label: "そのまま持ち続ける" },
          { value: "average", label: "買い増す" },
          { value: "rule", label: "その前に損切りルールで切っている" },
        ],
        scores: [
          { key: "lossTolerance", map: { panic: 20, hold: 65, average: 80, rule: 60 } },
          { key: "discipline", map: { panic: 25, hold: 40, average: 35, rule: 90 } },
        ],
      },
      { ...scale5("regretSell", "含み損の銘柄はなかなか売れず、含み益の銘柄はすぐ利確してしまう", "行動ファイナンスでいう『処分効果』。多くの人に当てはまります。正直に。", [{ key: "discipline", map: { "1": 80, "2": 65, "3": 50, "4": 30, "5": 15 } }]), mirrored: true },
      scale5("fomo", "他人が儲けている銘柄を見ると、乗り遅れたくなくて焦る", "1=まったくない 〜 5=とてもある", [{ key: "urgency", map: { "1": 15, "2": 35, "3": 50, "4": 75, "5": 90 } }]),
      scale5("confidence", "自分の相場観は、平均的な投資家より当たると思う", "自信過剰バイアスの確認。高いほど悪いわけではないが、検証で答え合わせすべき箇所が増えます。", [{ key: "riskAppetite", map: { "1": 35, "2": 45, "3": 50, "4": 65, "5": 80 } }]),
    ],
  },
  // ────────────────────────────────
  {
    id: "style",
    title: "スタイル (どう戦いたいか)",
    emoji: "⚔",
    description: "どの土俵で戦うか。清原達郎の言う「土俵選択」にあたる部分です。",
    questions: [
      {
        id: "returnSource", label: "リターンの主軸はどちらに置きたいか", type: "single",
        options: [
          { value: "growth", label: "値上がり益 (キャピタルゲイン)" },
          { value: "balanced", label: "半々" },
          { value: "income", label: "配当・優待 (インカムゲイン)" },
        ],
        scores: [{ key: "incomeFocus", map: { growth: 15, balanced: 50, income: 90 } }],
        mirrored: true,
      },
      {
        id: "daytradeShare", label: "投資資金のうち、デイトレ・短期売買に回している割合",
        help: "Cavka は「幹は中長期、デイトレはその一機能」という設計です。両方やる前提で、配分を教えてください。",
        type: "single",
        options: [
          { value: "none", label: "0% — 短期売買はしない" },
          { value: "lt10", label: "1割程度まで" },
          { value: "lt30", label: "2〜3割" },
          { value: "lt50", label: "4〜5割" },
          { value: "gt50", label: "5割超 — 短期売買が主戦場" },
        ],
        scores: [
          { key: "timeHorizon", map: { none: 95, lt10: 80, lt30: 55, lt50: 35, gt50: 15 } },
          { key: "riskAppetite", map: { none: 30, lt10: 45, lt30: 60, lt50: 75, gt50: 90 } },
        ],
        mirrored: true,
      },
      {
        id: "tradeStyle", label: "主力資金 (幹) の想定保有期間",
        help: "短期売買枠ではなく、中核として持つお金の話です。",
        type: "single",
        options: [
          { value: "swing", label: "数日〜数週間" },
          { value: "mid", label: "数ヶ月" },
          { value: "long", label: "1〜3年" },
          { value: "verylong", label: "3年以上 (基本売らない)" },
        ],
        scores: [{ key: "timeHorizon", map: { swing: 25, mid: 55, long: 85, verylong: 98 } }],
        mirrored: true,
      },
      {
        id: "diversification", label: "銘柄数の考え方", type: "single",
        options: [
          { value: "concentrated", label: "少数に集中したい (3銘柄以下)" },
          { value: "moderate", label: "ほどほど (4〜10銘柄)" },
          { value: "wide", label: "広く分散したい (10銘柄以上)" },
        ],
        scores: [{ key: "concentration", map: { concentrated: 90, moderate: 50, wide: 15 } }],
        mirrored: true,
      },
      {
        id: "battlefield", label: "得意にしたい・興味がある土俵 (複数可)", type: "multi",
        options: [
          { value: "largecap", label: "大型株 (安定・情報が多い)" },
          { value: "smallcap", label: "小型株 (人が来ない場所・清原式)" },
          { value: "value", label: "割安株 (バリュー)" },
          { value: "growth", label: "成長株 (グロース)" },
          { value: "theme", label: "テーマ株・材料株" },
          { value: "highdiv", label: "高配当株" },
          { value: "ipo", label: "IPO・新規上場" },
        ],
      },
      {
        id: "leverage", label: "信用取引・レバレッジについて", type: "single",
        options: [
          { value: "never", label: "使わない (現物のみ)" },
          { value: "sometimes", label: "限定的に使う" },
          { value: "active", label: "積極的に使う" },
        ],
        scores: [{ key: "riskAppetite", map: { never: 25, sometimes: 60, active: 90 } }],
      },
    ],
  },
  // ────────────────────────────────
  {
    id: "rules",
    title: "自分のルール",
    emoji: "📏",
    description: "ここに書いたことは、以後の診断で「守れているか」を機械的にチェックします。宣言した本人にしか作れない基準です。",
    questions: [
      { id: "maxPositionPct", label: "1銘柄に投じてよい上限 (資産に対する%)", help: "空欄なら判定しません。決めておくと、集中しすぎた時に警告が出ます。", type: "number", unit: "%", placeholder: "20", mirrored: true },
      {
        id: "stopLossRule", label: "損切りのルール", type: "single",
        options: [
          { value: "pct", label: "決めた下落率で必ず切る" },
          { value: "reason", label: "買った理由が崩れたら切る" },
          { value: "case", label: "その都度判断する" },
          { value: "none", label: "特にルールはない" },
        ],
        scores: [{ key: "discipline", map: { pct: 90, reason: 75, case: 35, none: 15 } }],
        mirrored: true,
      },
      { id: "stopLossPct", label: "損切りする下落率 (上のルールが『下落率』の場合)", type: "number", unit: "%", placeholder: "8", mirrored: true },
      {
        id: "avoidIndustries", label: "触りたくない業種 (複数可)",
        help: "選ぶと、保有銘柄の業種と自動で突き合わせます。理由は問いません (よく分からない/過去に負けた など)。",
        type: "multi",
        options: AVOID_GROUPS.map((g) => ({ value: g.value, label: g.label })),
        mirrored: true,
      },
      { id: "avoidSectors", label: "その他、避けたいもの (自由記述)", help: "上の選択肢に無いもの。例: 仕手株、社長が苦手な会社、値がさ株。", type: "text", placeholder: "例: 仕手株、よく分からないビジネスモデル" },
      { id: "maxDrawdownAccept", label: "資産全体で、どこまでの落ち込みなら受け入れられるか", help: "ポートフォリオ診断の最大ドローダウンと突き合わせます。", type: "number", unit: "%", placeholder: "20", mirrored: true },
    ],
  },
  // ────────────────────────────────
  {
    id: "narrative",
    title: "言葉にしておきたいこと",
    emoji: "✍",
    description: "数値化しない部分。後から読み返すと、自分の変化が一番よく分かる場所です。",
    questions: [
      { id: "wantToBe", label: "どんな投資家になりたいですか", type: "text", placeholder: "例: 焦らず、根拠のある時だけ動ける人になりたい" },
      { id: "currentWorry", label: "いま一番の悩み・不安は", type: "text", placeholder: "例: 候補の質に納得できていない / 買うタイミングをいつも逃す" },
      { id: "recentMood", label: "最近の相場に対する気分", type: "single",
        options: [
          { value: "confident", label: "自信がある・調子がいい" },
          { value: "calm", label: "落ち着いている" },
          { value: "uneasy", label: "不安・迷いがある" },
          { value: "frustrated", label: "悔しい・焦っている" },
          { value: "tired", label: "疲れている・距離を置きたい" },
        ],
        // 自信は焦りではない (過信は「自分の相場観」の質問で別途拾う)
        scores: [{ key: "urgency", map: { confident: 30, calm: 20, uneasy: 60, frustrated: 90, tired: 40 } }],
      },
      { id: "freeNote", label: "その他、Cavka に知っておいてほしいこと", type: "text", placeholder: "自由に" },
    ],
  },
];

export type Answers = Record<string, string | string[] | number | null>;

export interface ProfileScores { key: ScoreKey; value: number }[];

/** 回答から合成スコア (0-100) を計算。未回答の軸は null */
export function computeScores(answers: Answers): Partial<Record<ScoreKey, number>> {
  const acc: Partial<Record<ScoreKey, { sum: number; n: number }>> = {};
  for (const sec of SECTIONS) {
    for (const q of sec.questions) {
      if (!q.scores) continue;
      const a = answers[q.id];
      if (a == null || a === "") continue;
      const key = String(a);
      for (const s of q.scores) {
        const v = s.map[key];
        if (typeof v !== "number") continue;
        const e = acc[s.key] ?? { sum: 0, n: 0 };
        e.sum += v; e.n += 1;
        acc[s.key] = e;
      }
    }
  }
  const out: Partial<Record<ScoreKey, number>> = {};
  for (const [k, v] of Object.entries(acc)) {
    if (v && v.n > 0) out[k as ScoreKey] = Math.round(v.sum / v.n);
  }
  return out;
}

/** 回答済み率 (0-100)。全部埋める必要はないが、埋まるほど照合の精度が上がる */
export function completeness(answers: Answers): { answered: number; total: number; pct: number } {
  let answered = 0, total = 0;
  for (const sec of SECTIONS) {
    for (const q of sec.questions) {
      total++;
      const a = answers[q.id];
      if (a != null && a !== "" && !(Array.isArray(a) && a.length === 0)) answered++;
    }
  }
  return { answered, total, pct: Math.round((answered / total) * 100) };
}

export const ALL_QUESTIONS: Question[] = SECTIONS.flatMap((s) => s.questions);
export const questionById = (id: string) => ALL_QUESTIONS.find((q) => q.id === id) ?? null;

/** 選択肢の表示ラベル (履歴の差分表示用) */
export function labelOf(qid: string, value: unknown): string {
  const q = questionById(qid);
  if (!q) return String(value);
  if (q.type === "multi" && Array.isArray(value)) {
    return value.map((v) => q.options?.find((o) => o.value === v)?.label ?? v).join(", ");
  }
  if (q.options) return q.options.find((o) => o.value === String(value))?.label ?? String(value);
  if (q.type === "scale") return `${value} / 5`;
  if (q.type === "number") return `${Number(value).toLocaleString("ja-JP")}${q.unit ?? ""}`;
  return String(value);
}
