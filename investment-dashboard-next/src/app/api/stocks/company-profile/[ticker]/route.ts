import { NextRequest, NextResponse } from "next/server";
import { yfQuoteSummary } from "@/lib/yahoo-finance";
import { getCachedJpStocks } from "@/lib/jp-stocks-cache";
import { geminiGenerate } from "@/lib/gemini-client";
import { getAdminDb } from "@/lib/firebase-admin";

/**
 * GET /api/stocks/company-profile/[ticker]
 *
 * 会社概要 (どんな会社か) を返す:
 *  - Yahoo summaryProfile から 事業内容 / 従業員 / 本社 / 業種 / サイト
 *  - 日本株は事業説明が英語で返るため、Gemini で日本語の要約を生成
 *  - Gemini 結果は Firestore meta/company_profile_{ticker} にキャッシュ (1銘柄1回)
 *
 * ?refresh=1 で再生成。
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// キャッシュの有効期間 (会社概要は変化が遅いので 90日。過ぎたら次アクセス時に再生成)
const CACHE_TTL_DAYS = 90;

interface ProfilePayload {
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  employees: number | null;
  website: string | null;
  city: string | null;
  country: string | null;
  summaryOriginal: string | null; // Yahoo の原文 (英語のことが多い)
  summaryJa: string | null;       // Gemini 日本語要約
  generatedAt: string | null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params;
  if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  const isJP = /^\d{3,4}[A-Z]?$/.test(ticker);
  const yfTicker = isJP ? `${ticker}.T` : ticker;

  const db = getAdminDb();
  const cacheRef = db.collection("meta").doc(`company_profile_${ticker}`);

  // キャッシュヒット (refresh でなく、かつ TTL 内なら)。TTL 切れは staleCache に退避
  let staleCache: ProfilePayload | null = null;
  if (!refresh) {
    const snap = await cacheRef.get();
    if (snap.exists) {
      const cached = snap.data() as ProfilePayload;
      const ageMs = cached.generatedAt ? Date.now() - new Date(cached.generatedAt).getTime() : Infinity;
      if (ageMs < CACHE_TTL_DAYS * 24 * 3600 * 1000) {
        return NextResponse.json({ ok: true, cached: true, profile: cached });
      }
      staleCache = cached; // 再生成に失敗したらこれを返す
    }
  }

  // Yahoo から取得
  let result: Record<string, unknown> | null = null;
  try {
    result = await yfQuoteSummary(yfTicker, "summaryProfile,quoteType");
  } catch {
    result = null;
  }
  // 取得失敗 → 古いキャッシュがあれば捨てずに返す (空で上書きしない)
  if (!result && staleCache) {
    return NextResponse.json({ ok: true, cached: true, stale: true, profile: staleCache });
  }
  const sp = (result?.summaryProfile ?? {}) as Record<string, unknown>;
  const qt = (result?.quoteType ?? {}) as Record<string, unknown>;

  // 日本株の名前は立花マスタ優先 (Yahoo は英語名のことがある)
  let name = (qt.longName as string) || (qt.shortName as string) || null;
  if (isJP) {
    try {
      const jp = await getCachedJpStocks();
      const found = jp.find((s) => s.ticker === ticker);
      if (found) name = found.name;
    } catch {}
  }

  const summaryOriginal = (sp.longBusinessSummary as string) || null;

  // 日本語要約 (Gemini)。原文があり、かつ日本語でなければ生成
  let summaryJa: string | null = null;
  const looksJa = summaryOriginal ? /[ぁ-んァ-ヶ一-龠]/.test(summaryOriginal) : false;
  if (summaryOriginal && !looksJa) {
    try {
      const r = await geminiGenerate(
        `次の企業の事業説明を、日本語で分かりやすく要約してください。投資判断のためではなく「この会社が何をしているか」を理解する目的です。\n` +
        `・3〜4文、200字程度\n・専門用語は噛み砕く\n・誇張や推奨表現は入れない (事実の要約のみ)\n・「〜しています」調\n\n` +
        `企業: ${name ?? ticker}\n事業説明(原文):\n${summaryOriginal.slice(0, 2000)}`,
        // 2.5-flash は thinking にも出力トークンを使うため 512 だと本文が切れる (金下建設で実証)
        { model: "gemini-2.5-flash", temperature: 0.3, maxOutputTokens: 2048 }
      );
      summaryJa = r.text.trim() || null;
    } catch {
      summaryJa = null;
    }
  } else if (looksJa) {
    summaryJa = summaryOriginal;
  }

  const raw = (obj: Record<string, unknown>, key: string): number | null => {
    const v = obj[key];
    if (v && typeof v === "object" && "raw" in (v as Record<string, unknown>)) return (v as { raw: number }).raw;
    if (typeof v === "number") return v;
    return null;
  };

  const profile: ProfilePayload = {
    ticker,
    name,
    sector: (sp.sector as string) || null,
    industry: (sp.industry as string) || null,
    employees: raw(sp, "fullTimeEmployees"),
    website: (sp.website as string) || null,
    city: (sp.city as string) || null,
    country: (sp.country as string) || null,
    summaryOriginal,
    summaryJa,
    generatedAt: new Date().toISOString(),
  };

  // キャッシュ保存 (Gemini 要約が取れた時、または原文がある時)
  if (summaryOriginal || profile.sector) {
    try { await cacheRef.set(profile); } catch {}
  }

  return NextResponse.json({ ok: true, cached: false, profile });
}
