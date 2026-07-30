import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { geminiGenerate } from "@/lib/gemini-client";
import { classifyHeadline } from "@/lib/disclosure-events";
import { getCronOrigin } from "@/lib/cron-origin";

/**
 * GET /api/stocks/net-cash-story/[ticker] — 🏔 清原式の読み解き (1銘柄の物語)
 *
 * NCスクリーナーの数字の羅列を「読める解説」にする。構成は清原本人が銘柄を見る順:
 *   ① 何の会社か (会社概要キャッシュを流用)
 *   ② どれくらい安いか (比率でなく金額で語る)
 *   ③ なぜ安い可能性があるか (流動性・業績トレンドから自動仮説)
 *   ④ 動くきっかけはあるか (直近開示のカタリスト突合。無ければ無いと言う)
 *   ⑤ リスクと正直な注意
 *
 * 誠実の原則: 割安の測定であって上昇予測ではない。カタリスト不在・赤字などの
 * 不都合な事実を省かない。データが無い項目は「わからない」と言う。
 *
 * キャッシュ: meta/nc_story_{ticker} に7日 (数字はスクリーナーが週次更新のため)。
 * ?refresh=1 で再生成。
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CACHE_TTL_DAYS = 7;
const YF = { "User-Agent": "Mozilla/5.0" };
const oku = (v: number) => `${Math.round(v * 10) / 10}億円`;
/** 円額の読みやすい表記 (超低流動性株で「0億円」にならないように) */
const yen = (v: number) =>
  v >= 1e8 ? `${Math.round(v / 1e7) / 10}億円` : v >= 1e4 ? `${Math.round(v / 1e4).toLocaleString("ja-JP")}万円` : `${Math.round(v)}円`;
/** Gemini 要約が文の途中で切れている場合、最後の「。」までに整える */
const trimToSentence = (s: string | null): string | null => {
  if (!s) return null;
  if (/[。.!?！？)」]$/.test(s.trim())) return s.trim();
  const i = s.lastIndexOf("。");
  return i > 20 ? s.slice(0, i + 1) : s.trim();
};

export interface StorySection {
  icon: string;
  title: string;
  body: string | null;       // 本文 (段落)
  bullets: string[];         // 箇条書きの事実
}

export interface NetCashStory {
  ticker: string;
  name: string;
  date: string;              // スクリーナーの基準日
  sections: StorySection[];
  terms: string[];           // 用語メモ (GLOSSARY のキー)
  generatedAt: string;
}

/** 直近1年の日足から 流動性 (売買代金中央値) と 52週レンジ位置 を計算 */
async function fetchMarketFacts(ticker: string): Promise<{
  medianTurnover: number | null;
  price: number | null;
  pos52w: number | null; // 52週レンジのどこにいるか 0(安値)〜100(高値)
} | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}.T?range=1y&interval=1d`;
    const res = await fetch(url, { headers: YF, next: { revalidate: 3600 } });
    if (!res.ok) return null;
    const j = await res.json();
    const r = j?.chart?.result?.[0];
    const q = r?.indicators?.quote?.[0];
    const closes: (number | null)[] = q?.close ?? [];
    const vols: (number | null)[] = q?.volume ?? [];
    const turnovers: number[] = [];
    const valid: number[] = [];
    for (let i = 0; i < closes.length; i++) {
      const c = closes[i], v = vols[i];
      if (typeof c === "number" && isFinite(c)) {
        valid.push(c);
        if (typeof v === "number" && v > 0) turnovers.push(c * v);
      }
    }
    if (valid.length < 30) return null;
    turnovers.sort((a, b) => a - b);
    const med = turnovers.length ? turnovers[Math.floor(turnovers.length / 2)] : null;
    const price = valid[valid.length - 1];
    const lo = Math.min(...valid), hi = Math.max(...valid);
    const pos = hi > lo ? Math.round(((price - lo) / (hi - lo)) * 100) : null;
    return { medianTurnover: med, price, pos52w: pos };
  } catch {
    return null;
  }
}

/** 年次の売上・純利益 5年分 (crumb不要の timeseries API) */
async function fetchEarningsTrend(ticker: string): Promise<{ year: string; revenue: number | null; netIncome: number | null }[]> {
  try {
    const p1 = Math.floor(Date.now() / 1000);
    const p0 = p1 - Math.floor(5.6 * 365 * 86400);
    const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}.T?type=annualTotalRevenue,annualNetIncome&period1=${p0}&period2=${p1}`;
    const res = await fetch(url, { headers: YF, next: { revalidate: 86400 } });
    if (!res.ok) return [];
    const j = await res.json();
    const byYear = new Map<string, { revenue: number | null; netIncome: number | null }>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of (j?.timeseries?.result ?? []) as any[]) {
      const type: string = r?.meta?.type?.[0] ?? "";
      for (const v of (r?.[type] ?? []).filter(Boolean)) {
        const y: string = v.asOfDate ?? "";
        const raw: number | undefined = v.reportedValue?.raw;
        if (!y || typeof raw !== "number") continue;
        const cur = byYear.get(y) ?? { revenue: null, netIncome: null };
        if (type === "annualTotalRevenue") cur.revenue = raw;
        else if (type === "annualNetIncome") cur.netIncome = raw;
        byYear.set(y, cur);
      }
    }
    return Array.from(byYear.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([year, v]) => ({ year, ...v }));
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params;
  if (!/^\d{3,4}[A-Z0-9]?$/.test(ticker)) {
    return NextResponse.json({ error: "日本株の ticker を指定してください" }, { status: 400 });
  }
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  const db = getAdminDb();
  const cacheRef = db.collection("meta").doc(`nc_story_${ticker}`);
  const origin = getCronOrigin(req);

  // ── キャッシュ ──
  if (!refresh) {
    try {
      const snap = await cacheRef.get();
      if (snap.exists) {
        const cached = snap.data() as NetCashStory;
        const age = Date.now() - new Date(cached.generatedAt).getTime();
        if (age < CACHE_TTL_DAYS * 24 * 3600 * 1000) {
          return NextResponse.json({ ok: true, cached: true, story: cached });
        }
      }
    } catch {}
  }

  try {
    // ── スクリーナーの数字 (これが物語の主役) ──
    const screenerDoc = await db.collection("meta").doc("net_cash_screener").get();
    const sdata = screenerDoc.data();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = ((sdata?.entries ?? []) as any[]).find((e) => e.ticker === ticker);
    if (!entry) {
      return NextResponse.json({ error: "この銘柄はNCスクリーナーの対象外です (NC比率0.25未満またはデータなし)" }, { status: 404 });
    }
    const name: string = entry.name ?? ticker;
    const ncRatio: number | null = entry.ncRatio ?? null;
    const realPer: number | null = entry.realPer ?? null;
    const mcap: number = entry.marketCapOku ?? 0;   // 億円
    const nc: number = entry.ncOku ?? 0;            // 億円
    const netIncome: number | null = entry.netIncomeOku ?? null;

    // ── 素材を並列収集 (会社概要 / 流動性 / 業績5年 / 直近ニュース) ──
    const [profileRes, market, trend, newsRes] = await Promise.all([
      fetch(`${origin}/api/stocks/company-profile/${ticker}`, { signal: AbortSignal.timeout(25_000) }).catch(() => null),
      fetchMarketFacts(ticker),
      fetchEarningsTrend(ticker),
      (async () => {
        try {
          const h: Record<string, string> = process.env.MCP_API_KEY ? { "x-api-key": process.env.MCP_API_KEY } : {};
          const r = await fetch(`${origin}/api/news?ticker=${ticker}&days=60&limit=20`, { headers: h, signal: AbortSignal.timeout(15_000) });
          return r.ok ? await r.json() : null;
        } catch { return null; }
      })(),
    ]);

    let profileJa: string | null = null;
    try {
      if (profileRes?.ok) {
        const pj = await profileRes.json();
        profileJa = trimToSentence(pj?.profile?.summaryJa ?? null);
      }
    } catch {}

    // ── ② どれくらい安いか: 金額で語る ──
    const cheapBullets: string[] = [];
    cheapBullets.push(`会社の値段 (時価総額) は ${oku(mcap)}。手元のネットキャッシュは ${oku(nc)}`);
    if (ncRatio != null && ncRatio >= 1) {
      cheapBullets.push(`株を全部買って会社をたたんでも、計算上 ${oku(nc - mcap)} 残る「ネットネット株」の水準 (NC比率 ${ncRatio.toFixed(2)})`);
    } else if (ncRatio != null) {
      cheapBullets.push(`時価総額の ${Math.round(ncRatio * 100)}% が現金の裏付け (NC比率 ${ncRatio.toFixed(2)})`);
    }
    if (realPer != null && netIncome != null && netIncome > 0) {
      cheapBullets.push(
        realPer < 0
          ? `年間 ${oku(netIncome)} 稼ぐ黒字事業なのに、事業部分の値段はマイナス (実質PER ${realPer.toFixed(1)}) — 現金がタダで付いてくるどころか、お金をもらって事業を引き取る計算`
          : `キャッシュを除いた事業の素の値段は利益の ${realPer.toFixed(1)}年分 (実質PER)。年間純利益は ${oku(netIncome)}`,
      );
    }

    // ── ③ なぜ安い可能性: データからの自動仮説 (断定しない) ──
    const whyBullets: string[] = [];
    if (market?.medianTurnover != null) {
      const t = market.medianTurnover;
      if (t < 5e7) whyBullets.push(`1日の売買代金の中央値は約 ${yen(t)} — 機関投資家がまとまった株数を売買できない「人が来ない土俵」。安く放置される最大の構造要因`);
      else if (t < 3e8) whyBullets.push(`1日の売買代金は約 ${yen(t)} と小さめ — 大口資金が入りにくく、割安が放置されやすい流動性`);
      else whyBullets.push(`1日の売買代金は約 ${yen(t)} と一定の流動性があり、「見えていないから安い」だけでは説明しにくい — 別の理由 (成長性への疑問など) を探すべき`);
    }
    if (trend.length >= 3) {
      const ni = trend.map((t) => t.netIncome).filter((v): v is number => v != null);
      const first = ni[0], last = ni[ni.length - 1];
      const lossYears = ni.filter((v) => v <= 0).length;
      if (lossYears > 0) whyBullets.push(`過去${ni.length}年のうち${lossYears}年が赤字 — 業績の不安定さが割安の一因の可能性`);
      else if (first != null && last != null && first > 0 && last < first * 0.8) whyBullets.push(`純利益は5年前 ${oku(first / 1e8)} → 直近 ${oku(last / 1e8)} と減少傾向 — 衰退を織り込んだ安さの可能性 (バリュートラップに注意)`);
      else if (first != null && last != null && last > first * 1.2) whyBullets.push(`純利益は5年前 ${oku(first / 1e8)} → 直近 ${oku(last / 1e8)} と増えている — 業績は伸びているのに株価が付いてきていない可能性`);
      else whyBullets.push(`純利益はここ${ni.length}年ほぼ横ばい (直近 ${oku((last ?? 0) / 1e8)}) — 成長物語がなく、市場の関心の外に置かれている典型パターン`);
    }
    if (market?.pos52w != null) {
      if (market.pos52w >= 70) whyBullets.push(`株価は52週レンジの上位 ${market.pos52w}% — 既に見直され始めている可能性もある`);
      else if (market.pos52w <= 30) whyBullets.push(`株価は52週レンジの下位 (${market.pos52w}%) — 市場はまだこの割安に反応していない`);
    }

    // ── ④ カタリスト: 直近60日の開示を突合 ──
    const catalystBullets: string[] = [];
    const CATALYST_LABEL: Record<string, string> = {
      buyback: "自社株買い",
      dividend_up: "増配",
      earnings_revision_up: "上方修正",
      split: "株式分割",
      ma_target: "買収の標的 (TOB等)",
      alliance: "業務提携",
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const item of ((newsRes?.items ?? newsRes?.news ?? []) as any[]).slice(0, 20)) {
        const headline: string = item.headline ?? item.title ?? "";
        if (!headline) continue;
        const cls = classifyHeadline(headline);
        if (cls && CATALYST_LABEL[cls.type]) {
          catalystBullets.push(`${(item.date ?? item.publishedAt ?? "").slice(0, 10)} ${CATALYST_LABEL[cls.type]}: ${headline.slice(0, 60)}`);
        }
      }
    } catch {}
    const hasCatalyst = catalystBullets.length > 0;

    // ── ⑤ リスク ──
    const riskBullets: string[] = [];
    if (market?.medianTurnover != null && market.medianTurnover < 5e7) {
      riskBullets.push("流動性が低い = 買うのは簡単でも「売りたい時にすぐ売れない」。ポジションは小さく、指値で");
    }
    if (!hasCatalyst) riskBullets.push("直近60日にカタリストとなる開示は見当たらない — 割安のまま何年も動かない可能性を受け入れられる場合のみ");
    if (ncRatio != null && ncRatio >= 2) riskBullets.push("NC比率が2を超える極端な数字は、時価総額や決算データの取得ミスの可能性もある。決算短信の原典で確認を");
    riskBullets.push("これは「割安の測定」であって「上がる予測」ではない。清原自身も『なぜ安いか、まず疑え』と言う");

    // ── Gemini で「読み物」の導入文を1段落だけ生成 (失敗時はルールベース) ──
    let intro: string | null = null;
    try {
      const facts = {
        name, ticker, mcapOku: mcap, ncOku: nc, ncRatio, realPer, netIncomeOku: netIncome,
        turnoverOku: market?.medianTurnover != null ? Math.round(market.medianTurnover / 1e7) / 10 : null,
        pos52w: market?.pos52w, hasCatalyst,
        profile: profileJa?.slice(0, 300) ?? null,
      };
      const g = await geminiGenerate(
        `あなたは投資初心者に寄り添う解説者です。以下の事実だけから、この銘柄が「清原式ネットキャッシュ投資」の候補に挙がった理由を、日本語2〜3文で平易に説明してください。\n` +
          `ルール: 事実にない話を創作しない / 推奨表現 (買うべき等) を使わない / 数字を1〜2個引用する / 「〜です・ます」調\n\n事実: ${JSON.stringify(facts)}`,
        // 2.5-flash は thinking にも出力トークンを使うため、512 だと本文が途中で切れる
        { model: "gemini-2.5-flash", temperature: 0.3, maxOutputTokens: 2048 },
      );
      intro = trimToSentence(g.text?.trim() || null);
      if (intro && intro.length < 20) intro = null;
    } catch {}
    if (!intro) {
      intro = `${name} は時価総額 ${oku(mcap)} に対しネットキャッシュ ${oku(nc)} を持つ資産割安株です。数字の裏側を順に見ていきます。`;
    }

    const story: NetCashStory = {
      ticker,
      name,
      date: sdata?.date ?? "",
      sections: [
        { icon: "🏔", title: "この銘柄が挙がった理由", body: intro, bullets: [] },
        ...(profileJa ? [{ icon: "🏢", title: "何の会社か", body: profileJa, bullets: [] }] : []),
        { icon: "💰", title: "どれくらい安いか (金額で見る)", body: null, bullets: cheapBullets },
        {
          icon: "🤔",
          title: "なぜ安い可能性があるか (仮説)",
          body: whyBullets.length === 0 ? "手元のデータからは仮説を立てる材料が不足しています。" : null,
          bullets: whyBullets,
        },
        {
          icon: "🎁",
          title: "動くきっかけ (カタリスト)",
          body: hasCatalyst
            ? "直近60日に、割安解消のきっかけになり得る開示がありました:"
            : "直近60日の開示にカタリスト事象は見当たりません。割安が割安のまま続く覚悟が要る、というのが正直なところです。",
          bullets: catalystBullets,
        },
        { icon: "⚠", title: "リスクと正直な注意", body: null, bullets: riskBullets },
      ],
      terms: ["ネットキャッシュ", "NC比率", "実質PER", "ネットネット株", "バリュートラップ", "カタリスト", "流動性", "TOB", "アクティビスト"],
      generatedAt: new Date().toISOString(),
    };

    try { await cacheRef.set(story); } catch {}
    return NextResponse.json({ ok: true, cached: false, story });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
