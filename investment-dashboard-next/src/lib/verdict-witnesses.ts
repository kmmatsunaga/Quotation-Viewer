/**
 * 証人収集 (Witness Collection) — クライアント/サーバ共用
 *
 * VerdictCockpit (ブラウザ) と verdict-track cron (サーバ) の両方から使う。
 * baseUrl: ブラウザは "" (相対)、cron は getCronOrigin(req) を渡す。
 *
 * 需給 (立花 snapshot) はブラウザ専用のため、ここには含めない。
 * 呼び出し側で追加する。
 */

import { getSectorsForTicker } from "./jp-themes";
import { isDriverActive } from "./macro-drivers";
import type { Witness } from "./verdict-engine";

const clip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const toDir = (score: number) => clip((score - 50) / 50, -1, 1);

export interface CollectResult {
  witnesses: Witness[];
  price: number | null;   // momentum-score の latestClose (記録用)
}

export async function collectWitnesses(ticker: string, baseUrl = ""): Promise<CollectResult> {
  const tickerSectors = getSectorsForTicker(ticker);

  const get = async (path: string) => {
    try {
      const res = await fetch(`${baseUrl}${path}`);
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };

  const [f, ins, pRaw, st, mw, mo] = await Promise.all([
    get(`/api/stocks/future-score/${encodeURIComponent(ticker)}`),
    get(`/api/stocks/insights?ticker=${encodeURIComponent(ticker)}`),
    get(`/api/stocks/patterns?tickers=${encodeURIComponent(ticker)}`),
    tickerSectors.length > 0 ? get(`/api/sectors/trends`) : Promise.resolve(null),
    tickerSectors.length > 0 ? get(`/api/macro/fred-watch`) : Promise.resolve(null),
    get(`/api/stocks/momentum-score?ticker=${encodeURIComponent(ticker)}`),
  ]);

  const ws: Witness[] = [];

  // ── 1. 将来性ファンダ ──
  if (f?.overall?.raw !== undefined) {
    ws.push({
      id: "future", label: "将来性ファンダ", emoji: "🔮",
      direction: toDir(f.overall.raw), confidence: 0.9, weight: 4,
      timeframes: ["mid", "long"],
      reason: `Future Score ${f.overall.raw}点 (${f.overall.grade})`,
    });
    if (f.flags?.valueTrap) {
      ws.push({
        id: "value_trap", label: "バリュートラップ警告", emoji: "🪤",
        direction: -0.7, confidence: 0.85, weight: 3,
        timeframes: ["long"], reason: "割安に見えるが構造的な理由がある疑い",
      });
    }
    if (f.disclosures?.hasCriticalNegative) {
      ws.push({
        id: "disclosure", label: "重大開示", emoji: "🚨",
        direction: -0.8, confidence: 0.95, weight: 4,
        timeframes: ["short", "mid", "long"],
        reason: "不祥事/訴訟など重大なネガティブ開示あり",
      });
    }
    if (f.sentiment && typeof f.sentiment.finalScore === "number") {
      const s = f.sentiment.finalScore;
      const dir = Math.abs(s) <= 1 ? clip(s, -1, 1) : toDir(s);
      const conf = 0.7 * (f.sentiment.stale ? 0.5 : 1) * Math.min(1, (f.sentiment.articleCount ?? 0) / 5);
      if (conf > 0.05) {
        ws.push({
          id: "news", label: "ニュース感情", emoji: "📰",
          direction: dir, confidence: conf, weight: 2,
          timeframes: ["short", "mid"],
          reason: `${f.sentiment.label} (記事${f.sentiment.articleCount}件${f.sentiment.stale ? "・やや古い" : ""})`,
        });
      }
    }
  }

  // ── 2. テクニカル 3軸 ──
  if (ins?.short?.score !== undefined) {
    ws.push({
      id: "tech_short", label: "短期テクニカル", emoji: "📈",
      direction: toDir(ins.short.score), confidence: 0.85, weight: 4,
      timeframes: ["short"], reason: `シグナル${ins.short.score}点`,
    });
  }
  if (ins?.mid?.score !== undefined) {
    ws.push({
      id: "tech_mid", label: "中期テクニカル", emoji: "📊",
      direction: toDir(ins.mid.score), confidence: 0.85, weight: 4,
      timeframes: ["mid"], reason: `シグナル${ins.mid.score}点`,
    });
  }
  if (ins?.long?.score !== undefined) {
    ws.push({
      id: "tech_long", label: "長期テクニカル", emoji: "📉",
      direction: toDir(ins.long.score), confidence: 0.8, weight: 3,
      timeframes: ["long"], reason: `シグナル${ins.long.score}点`,
    });
  }

  // ── 3. チャートパターン ──
  const pats = pRaw?.patterns?.[ticker]?.patterns;
  const patDir = (p: { signal: string; strength: number } | undefined | null) =>
    !p ? null : (p.signal === "buy" ? 1 : p.signal === "sell" ? -1 : 0) * (0.3 + 0.14 * (p.strength ?? 3));
  const pd = pats?.daily?.[0];
  const pdDir = patDir(pd);
  if (pd && pdDir !== null) {
    ws.push({
      id: "pattern_daily", label: "日足パターン", emoji: "🕯",
      direction: clip(pdDir, -1, 1), confidence: (pd.confidence ?? 50) / 100, weight: 2,
      timeframes: ["short"], reason: pd.label ?? pd.direction,
    });
  }
  const pw = pats?.weekly?.[0];
  const pwDir = patDir(pw);
  if (pw && pwDir !== null) {
    ws.push({
      id: "pattern_weekly", label: "週足パターン", emoji: "🕯",
      direction: clip(pwDir, -1, 1), confidence: (pw.confidence ?? 50) / 100, weight: 2,
      timeframes: ["mid"], reason: pw.label ?? pw.direction,
    });
  }

  // ── 4. セクター + 5. マクロ ──
  if (st && st.ok !== false) {
    const all = [...(st.industries ?? []), ...(st.themes ?? [])];
    const matched = tickerSectors
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((ts) => all.find((a: any) => a.id === ts.id))
      .filter(Boolean);
    if (matched.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const best = matched.reduce((a: any, b: any) => (a.hotIndex >= b.hotIndex ? a : b));
      ws.push({
        id: "sector", label: `セクター (${best.name})`, emoji: best.emoji ?? "🏭",
        direction: toDir(best.hotIndex), confidence: 0.75, weight: 2,
        timeframes: ["mid", "long"], reason: `Hot Index ${best.hotIndex}`,
      });

      if (mw?.ok && Array.isArray(best.macroDrivers) && best.macroDrivers.length > 0) {
        let active = 0;
        for (const d of best.macroDrivers as string[]) {
          if (isDriverActive(d, mw)) active++;
        }
        const ratio = active / best.macroDrivers.length;
        ws.push({
          id: "macro", label: "マクロ環境", emoji: "🌐",
          direction: clip((ratio - 0.5) * 2, -1, 1), confidence: 0.7, weight: 2,
          timeframes: ["mid", "long"],
          reason: `連動要因 ${active}/${best.macroDrivers.length} が追い風`,
        });
      }
    }
  }

  // ── 6. モメンタム ──
  let price: number | null = null;
  if (mo?.ok) {
    price = mo.meta?.latestClose ?? null;
    if (mo.passes && typeof mo.finalScore === "number") {
      ws.push({
        id: "momentum", label: "業績モメンタム", emoji: "🚀",
        direction: clip((mo.finalScore - 40) / 40, -1, 1), confidence: 0.8, weight: 3,
        timeframes: ["mid", "long"],
        reason: `モメンタムスコア ${mo.finalScore} (成長加速${mo.p1Growth}/30)`,
      });
    } else if (typeof mo.excludeReason === "string" && /parabolic|runup/.test(mo.excludeReason)) {
      ws.push({
        id: "momentum", label: "業績モメンタム", emoji: "🚀",
        direction: -0.5, confidence: 0.75, weight: 2,
        timeframes: ["short", "mid"],
        reason: "急騰後の後期局面の疑い (パラボリック/走り切り)",
      });
    }
  }

  return { witnesses: ws, price };
}
