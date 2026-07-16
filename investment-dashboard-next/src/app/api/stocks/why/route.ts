import { NextRequest, NextResponse } from "next/server";
import { getSectorsForTicker } from "@/lib/jp-themes";
import { classifyHeadline } from "@/lib/disclosure-events";
import { geminiGenerate } from "@/lib/gemini-client";
import { getCronOrigin } from "@/lib/cron-origin";

/**
 * GET /api/stocks/why?ticker=7203 — 🔬 なぜ動いたかエンジン (Phase 1)
 *
 * 当日リターンを3層に分解する:
 *   地合い要因   = β × 日経平均の当日騰落 (βは直近60日の回帰)
 *   セクター要因 = 同セクター平均の対日経超過分
 *   個別要因     = 残差 ← ここに「その銘柄固有の理由」がある
 *
 * 個別要因に対して証拠を自動収集 (ニュース+開示分類 / 出来高異常 / 決算位置)、
 * Gemini で1つの説明文に統合する。
 *
 * 誠実の原則: 個別要因が小さい時は「地合い/セクターに乗っただけ」と正直に言う。
 * 相場の日々の動きの大半はノイズであり、無理に物語を作ると占いになる。
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const YF = { "User-Agent": "Mozilla/5.0" };

interface DayBar { date: string; close: number; volume: number }

async function fetchDaily(symbol: string, range = "3mo"): Promise<DayBar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: YF, next: { revalidate: 300 } });
  if (!res.ok) return [];
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0];
  if (!ts.length || !q) return [];
  const out: DayBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (typeof c !== "number" || !isFinite(c)) continue;
    const jst = new Date(ts[i] * 1000 + 9 * 3600 * 1000);
    out.push({
      date: `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`,
      close: c,
      volume: typeof q.volume?.[i] === "number" ? q.volume[i] : 0,
    });
  }
  return out;
}

/** 日次リターン系列 (date → ret%) */
function toReturns(bars: DayBar[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].close > 0) m.set(bars[i].date, ((bars[i].close - bars[i - 1].close) / bars[i - 1].close) * 100);
  }
  return m;
}

/** β (直近 maxN 個の共通日で回帰)。異常値はクリップ */
function beta(stock: Map<string, number>, mkt: Map<string, number>, maxN = 60): number {
  const xs: number[] = [], ys: number[] = [];
  const dates = Array.from(stock.keys()).filter((d) => mkt.has(d)).slice(-maxN);
  for (const d of dates) { xs.push(mkt.get(d)!); ys.push(stock.get(d)!); }
  if (xs.length < 20) return 1;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0, varx = 0;
  for (let i = 0; i < xs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); varx += (xs[i] - mx) ** 2; }
  if (varx === 0) return 1;
  return Math.max(0.2, Math.min(2.5, cov / varx));
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") ?? "").trim().toUpperCase();
  // light=1: Gemini を呼ばず分解事実だけ返す (毎日の蓄積 cron 用。コスト削減)
  const light = req.nextUrl.searchParams.get("light") === "1";
  if (!/^\d{3,4}[A-Z0-9]?$/.test(ticker)) {
    return NextResponse.json({ error: "日本株の ticker を指定してください" }, { status: 400 });
  }
  const origin = getCronOrigin(req);

  try {
    // ── 1. 価格データ (銘柄 + 日経 + セクター代表) ──
    const sectors = getSectorsForTicker(ticker);
    const sector = sectors[0] ?? null;
    const peers = (sector?.tickers ?? []).filter((t) => t !== ticker).slice(0, 10);

    const [stockBars, nikkeiBars, ...peerBars] = await Promise.all([
      fetchDaily(`${ticker}.T`),
      fetchDaily("^N225"),
      ...peers.map((p) => fetchDaily(`${p}.T`, "5d")),
    ]);
    if (stockBars.length < 25 || nikkeiBars.length < 25) {
      return NextResponse.json({ error: "価格データ不足" }, { status: 404 });
    }

    const sRet = toReturns(stockBars);
    const nRet = toReturns(nikkeiBars);
    const lastDate = stockBars[stockBars.length - 1].date;
    const todayRet = sRet.get(lastDate);
    if (todayRet === undefined) {
      return NextResponse.json({ error: "当日リターンを計算できません" }, { status: 404 });
    }
    // ^N225 の日足は当日バーの反映が遅い。無ければリアルタイム quote から当日騰落を取る
    let nikkeiToday = nRet.get(lastDate) ?? null;
    if (nikkeiToday === null) {
      try {
        const qres = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EN225?range=1d&interval=5m", { headers: YF, cache: "no-store" });
        const qj = await qres.json();
        const meta = qj?.chart?.result?.[0]?.meta;
        const p = meta?.regularMarketPrice, pc = meta?.chartPreviousClose;
        if (typeof p === "number" && typeof pc === "number" && pc > 0) {
          nikkeiToday = ((p - pc) / pc) * 100;
        }
      } catch {}
    }
    if (nikkeiToday === null) nikkeiToday = 0;

    // ── 2. 3層分解 ──
    const b = beta(sRet, nRet);
    const marketPart = b * nikkeiToday;

    let sectorPart = 0;
    let sectorAvgToday: number | null = null;
    if (peers.length >= 3) {
      const peerRets = peerBars
        .map((bars) => toReturns(bars).get(lastDate))
        .filter((v): v is number => v !== undefined);
      if (peerRets.length >= 3) {
        sectorAvgToday = peerRets.reduce((a, c) => a + c, 0) / peerRets.length;
        sectorPart = sectorAvgToday - nikkeiToday; // 対日経の超過分をセクター固有とみなす (簡易)
      }
    }
    const idio = todayRet - marketPart - sectorPart;

    // 主因ラベル (誠実の原則: 個別要因が小さければ連動、全部小さければ「小動き」と言い切る)
    const absIdio = Math.abs(idio);
    const dominant =
      Math.abs(todayRet) < 1 && absIdio < 0.6 && Math.abs(marketPart) < 0.6 && Math.abs(sectorPart) < 0.6
        ? "noise"
        : absIdio >= Math.max(1.0, Math.abs(todayRet) * 0.5)
          ? "individual"
          : Math.abs(sectorPart) > Math.abs(marketPart)
            ? "sector"
            : "market";

    // ── 3. 証拠収集 ──
    // 出来高
    const vols = stockBars.slice(-21, -1).map((x) => x.volume).filter((v) => v > 0);
    const avgVol = vols.length >= 10 ? vols.reduce((a, c) => a + c, 0) / vols.length : null;
    const todayVol = stockBars[stockBars.length - 1].volume;
    const volumeRatio = avgVol && avgVol > 0 && todayVol > 0 ? r2(todayVol / avgVol) : null;

    // ニュース (直近3日) + 開示分類。eventType (上方修正/自社株買い等) を保持し、
    // イベント効果測定 (Phase 2) の材料として蓄積できるようにする。
    interface Evidence { kind: string; label: string; detail: string; impact?: "positive" | "negative" | "neutral"; eventType?: string }
    const evidence: Evidence[] = [];
    const eventTypes: string[] = []; // この銘柄の当日に付いた開示イベント種別 (蓄積用)
    try {
      const nres = await fetch(`${origin}/api/news?ticker=${ticker}&days=3&limit=10`, { signal: AbortSignal.timeout(15_000) });
      if (nres.ok) {
        const nj = await nres.json();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const item of ((nj.items ?? nj.news ?? []) as any[]).slice(0, 8)) {
          const headline: string = item.headline ?? item.title ?? "";
          if (!headline) continue;
          const cls = classifyHeadline(headline);
          if (cls) eventTypes.push(cls.type);
          evidence.push({
            kind: cls ? "disclosure" : "news",
            label: cls ? `開示/材料 (${cls.type})` : "ニュース",
            detail: `${(item.date ?? item.publishedAt ?? "").slice(5, 16)} ${headline}`.trim(),
            impact: cls?.impact,
            eventType: cls?.type,
          });
        }
      }
    } catch {}

    // 決算位置
    let earningsNote: string | null = null;
    try {
      const eres = await fetch(`${origin}/api/stocks/next-earnings?tickers=${ticker}`, { signal: AbortSignal.timeout(10_000) });
      if (eres.ok) {
        const ej = await eres.json();
        const d = ej.earnings?.[ticker]?.daysToNext;
        if (typeof d === "number" && d >= 0 && d <= 3) earningsNote = `決算${d === 0 ? "当日" : `${d}日前`}`;
        else if (typeof d === "number" && d < 0 && d >= -3) earningsNote = `決算${-d}日後 (決算反応の可能性)`;
      }
    } catch {}
    if (earningsNote) evidence.unshift({ kind: "earnings", label: "決算イベント", detail: earningsNote });
    if (volumeRatio !== null && volumeRatio >= 2) {
      evidence.unshift({ kind: "volume", label: "出来高異常", detail: `平常の${volumeRatio}倍 — 何かに反応した可能性が高い` });
    }

    // ── 4. Gemini で説明文を統合 (失敗時はルールベース) ──
    const facts = {
      ticker, date: lastDate,
      todayRetPct: r2(todayRet), nikkeiPct: r2(nikkeiToday), beta: r2(b),
      breakdown: { market: r2(marketPart), sector: r2(sectorPart), individual: r2(idio) },
      sector: sector?.name ?? null, sectorAvgPct: sectorAvgToday !== null ? r2(sectorAvgToday) : null,
      volumeRatio, dominant,
      eventTypes: Array.from(new Set(eventTypes)), // 当日付いた開示イベント種別 (重複排除)
      evidence: evidence.map((e) => `[${e.label}] ${e.detail}`).slice(0, 8),
    };

    // light モード: Gemini/ルール説明をスキップして事実だけ返す (蓄積 cron 用)
    if (light) {
      return NextResponse.json({ ok: true, ...facts, evidenceDetail: evidence, narrative: null });
    }

    let narrative: string | null = null;
    try {
      const prompt = `あなたは株式アナリストです。以下の事実だけから、この銘柄の当日の値動きの理由を日本語3文以内で説明してください。
重要なルール:
- 事実にない理由を創作しない。個別要因(individual)が±1%未満なら「地合い/セクター連動が主で、銘柄固有の材料は確認できない」と正直に言う
- 数字を1〜2個引用して具体的に
- 断定を避け「〜とみられる」調で

事実: ${JSON.stringify(facts, null, 0)}`;
      const g = await geminiGenerate(prompt, { model: "gemini-2.5-flash", maxOutputTokens: 1024 });
      narrative = g.text?.trim() || null;
      // 途切れた文章 (句点で終わらない) はフォールバックに回す
      if (narrative && !/[。.!?！？)」]$/.test(narrative)) narrative = null;
    } catch {}
    if (!narrative) {
      // ルールベースのフォールバック
      const dir = todayRet >= 0 ? "上昇" : "下落";
      if (dominant === "noise") {
        narrative = `本日は ${r2(todayRet)}% の小動き。地合い・セクター・個別いずれも目立った動きはなく、特段の材料がない平常日とみられる。`;
      } else if (dominant === "individual") {
        narrative = `本日の${dir} ${r2(todayRet)}% のうち個別要因が ${r2(idio)}% と主因。${evidence.length > 0 ? `${evidence[0].label}: ${evidence[0].detail} が影響したとみられる。` : "ただし明確な材料は確認できず、需給主導の可能性。"}`;
      } else if (dominant === "sector") {
        narrative = `${sector?.name ?? "セクター"}全体の動き (${sectorAvgToday !== null ? r2(sectorAvgToday) : "?"}%) に連動した${dir}が主で、銘柄固有の材料は小さい。`;
      } else {
        narrative = `日経平均 ${r2(nikkeiToday)}% への連動 (β=${r2(b)}) が主因の${dir}。銘柄固有の動きは ${r2(idio)}% に留まる。`;
      }
    }

    return NextResponse.json({
      ok: true,
      ...facts,
      evidenceDetail: evidence,
      narrative,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
