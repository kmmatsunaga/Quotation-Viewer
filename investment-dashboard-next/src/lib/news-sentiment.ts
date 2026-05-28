/**
 * ニュース・センチメント分析 (Gemini)
 *
 * 設計:
 *   - 立花のニュース API から該当 ticker の直近ヘッダを取得
 *   - 各記事を Gemini で [-1.0, +1.0] のセンチメントに分類 (バッチで1リクエスト = コスト最適)
 *   - 拡散係数 = 記事数の対数 (件数1=0.0, 5=2.3, 20=4.3 → タンチで頭打ち)
 *   - スコア = 平均センチメント × 拡散係数係数 (-100 〜 +100)
 *
 * 注意:
 *   - 立花ニュースは要認証 → このモジュールを呼ぶ側 (cron / 認証ルート) でセッション管理
 *   - 結果は Firestore `meta/sentiment/{ticker}` にキャッシュして毎日更新
 *   - GEMINI_API_KEY 未設定なら全件 throw (呼び出し側で catch)
 */
import { geminiGenerateJson } from "./gemini-client";
import type { TachibanaNewsHeader } from "./tachibana";

export interface ArticleSentiment {
  id: string;
  date: string;        // YYYYMMDD
  headline: string;
  sentiment: number;   // -1.0 〜 +1.0
  reason: string;      // 短い根拠 (Gemini 出力)
}

export interface SentimentScore {
  ticker: string;
  articleCount: number;
  avgSentiment: number;      // -1.0 〜 +1.0 (時間減衰加重平均)
  diffusionCoef: number;     // ln(articleCount+1) / ln(20) → 0〜1
  finalScore: number;        // -100 〜 +100 (avg × diffusionCoef × 100)
  label: "very_positive" | "positive" | "neutral" | "negative" | "very_negative";
  articles: ArticleSentiment[];
  computedAt: string;        // ISO timestamp
  modelUsed: string;
}

/**
 * Gemini に複数のヘッドラインを一括投入して JSON で評価結果を取得。
 * 1リクエストで最大 50 件まで処理 (コスト/トークン最適化)。
 */
async function classifyHeadlines(
  ticker: string,
  headlines: { id: string; date: string; headline: string }[]
): Promise<ArticleSentiment[]> {
  if (headlines.length === 0) return [];

  // Gemini に渡すプロンプト
  const numbered = headlines
    .map((h, i) => `[${i}] (${h.date}) ${h.headline}`)
    .join("\n");

  const prompt = `あなたは日本株のニュース分析専門家です。以下は銘柄コード ${ticker} に関するニュースヘッドラインです。
各ヘッドラインを、その銘柄の株価に対する影響として -1.0 (極めてネガティブ) 〜 +1.0 (極めてポジティブ) の連続値で評価してください。

評価基準:
- +1.0: 大型受注/業績上方修正/画期的新製品/M&A買収側/規制緩和
- +0.5: 良好決算/新規事業/業務提携
-  0.0: 中立的報道/単なる人事/プロダクト発表 (規模不明)
- -0.5: 業績下方修正/競合参入/規制懸念
- -1.0: 不祥事/大型訴訟/重大事故/業績大幅悪化

JSON 配列で返却。各要素は { "i": インデックス番号, "sentiment": 数値, "reason": "10文字以内の理由" } の形式。
他の余計なテキストは出力しない。

ニュースヘッドライン:
${numbered}`;

  type Item = { i: number; sentiment: number; reason: string };
  const { data } = await geminiGenerateJson<Item[]>(prompt, {
    model: "gemini-2.5-flash",
    temperature: 0.2,
    maxOutputTokens: 4096,
  });

  // 結果を ArticleSentiment に変換
  const byIdx = new Map<number, Item>();
  for (const it of data) {
    if (typeof it.i === "number") byIdx.set(it.i, it);
  }
  return headlines.map((h, i) => {
    const r = byIdx.get(i);
    return {
      id: h.id,
      date: h.date,
      headline: h.headline,
      sentiment: typeof r?.sentiment === "number" ? Math.max(-1, Math.min(1, r.sentiment)) : 0,
      reason: r?.reason ?? "",
    };
  });
}

/**
 * 立花ニュースヘッダ配列を入力に、ticker のセンチメントスコアを算出。
 *
 * @param ticker - 銘柄コード
 * @param headers - 立花から取得したヘッダ配列 (新しい順)
 * @param maxArticles - 最大処理件数 (デフォルト 30)
 */
export async function computeSentimentFromHeaders(
  ticker: string,
  headers: TachibanaNewsHeader[],
  maxArticles: number = 30
): Promise<SentimentScore> {
  // ticker 関連のものに絞る + 新しい順で maxArticles まで
  const relevant = headers
    .filter((h) => h.relatedTickers.includes(ticker) || h.relatedTickers.length === 0)
    .slice(0, maxArticles);

  if (relevant.length === 0) {
    return {
      ticker,
      articleCount: 0,
      avgSentiment: 0,
      diffusionCoef: 0,
      finalScore: 0,
      label: "neutral",
      articles: [],
      computedAt: new Date().toISOString(),
      modelUsed: "gemini-2.5-flash",
    };
  }

  // Gemini 分類 (50件ずつバッチ、ここでは大体 30 件以下なので1回)
  const classified = await classifyHeadlines(
    ticker,
    relevant.map((h) => ({ id: h.id, date: h.date, headline: h.headline }))
  );

  // 時間減衰加重平均: 新しいニュースほど重みが高い
  // 重み = 0.85^(daysAgo)  (1日前=0.85, 7日前=0.32, 30日前=0.008)
  const today = new Date();
  const todayKey = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  let sumW = 0,
    sumWS = 0;
  for (const a of classified) {
    const daysAgo = Math.max(0, daysBetween(a.date, todayKey));
    const w = Math.pow(0.85, daysAgo);
    sumW += w;
    sumWS += w * a.sentiment;
  }
  const avgSentiment = sumW > 0 ? sumWS / sumW : 0;

  // 拡散係数: ln(n+1) / ln(20) で 20件以上は 1.0
  const diffusionCoef = Math.min(1, Math.log(relevant.length + 1) / Math.log(20));

  const finalScore = Math.round(avgSentiment * diffusionCoef * 100);

  let label: SentimentScore["label"];
  if (finalScore >= 40) label = "very_positive";
  else if (finalScore >= 15) label = "positive";
  else if (finalScore >= -15) label = "neutral";
  else if (finalScore >= -40) label = "negative";
  else label = "very_negative";

  return {
    ticker,
    articleCount: relevant.length,
    avgSentiment: Math.round(avgSentiment * 1000) / 1000,
    diffusionCoef: Math.round(diffusionCoef * 100) / 100,
    finalScore,
    label,
    articles: classified,
    computedAt: new Date().toISOString(),
    modelUsed: "gemini-2.5-flash",
  };
}

// YYYYMMDD 同士の日数差
function daysBetween(d1: string, d2: string): number {
  const p = (s: string) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`).getTime();
  return Math.round((p(d2) - p(d1)) / 86400000);
}
