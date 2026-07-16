import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { tachibanaLogin, tachibanaLogout, getMarketQuotes } from "@/lib/tachibana";

/**
 * GET /api/daytrade-candidates (v2)
 *
 * ☀ 朝のデイトレ候補: 「今日どれを監視するか」を自動生成する。
 *
 * v2 の設計思想 (実戦フィードバック反映):
 *   - ロング適性で採点。方向の「一貫性」を評価し、矛盾する材料は減点
 *     (買い目線なのに前日大陰線 → 加点でなく減点)
 *   - 場が近い時間帯 (JST 8:20〜15:30) は立花の寄り気配/板と照合し、
 *     「✓今朝の気配も同方向」で昇格 / 「⚠気配は逆方向」で降格+明示
 *   - 買い候補と売り候補を分離 (現物デイトレは買いが主戦場)
 *
 * 発掘源:
 *   1. スコア急変 (±6pt 以上、日本株)
 *   2. 熱いセクター上位 (Hot Top5 × 各4銘柄)
 * 肉付け:
 *   3. 前日出来高 (燃料) / 4. 前日足形 (一貫性判定に使用) / 5. 今朝の気配
 */

export const maxDuration = 60;

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

interface RankEntry {
  ticker: string;
  name: string;
  market: string;
  price: number | null;
  overall: number;
  short: number;
}

interface Candidate {
  ticker: string;
  name: string;
  weight: number;
  reasons: string[];
  dirSum: number;          // 方向の証拠合計 (+ = ロング材料)
  dirEvidence: number;     // 方向つき証拠の数
  hint: "long" | "short" | "both";
  consistency: number;     // 0-100 方向の一貫性
  boardCheck: "agree" | "conflict" | null;  // 今朝の気配との整合
  lastPrice: number | null;
}

function jstDateKey(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
}

/** 今朝の気配照合をやる時間帯か (平日 8:20-15:30 JST) */
function boardCheckWindow(): boolean {
  const now = new Date();
  const jst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60 * 1000);
  const day = jst.getDay();
  if (day === 0 || day === 6) return false;
  const mins = jst.getHours() * 60 + jst.getMinutes();
  return mins >= 8 * 60 + 20 && mins <= 15 * 60 + 30;
}

async function findRankDoc(db: FirebaseFirestore.Firestore, beforeKey?: string) {
  for (let i = 0; i <= 7; i++) {
    const key = jstDateKey(new Date(Date.now() - i * 24 * 3600 * 1000));
    if (beforeKey && key >= beforeKey) continue;
    const snap = await db.collection("meta").doc(`score_rankings_${key}`).get();
    if (snap.exists) return { key, entries: (snap.data()?.entries ?? []) as RankEntry[] };
  }
  return null;
}

/** 前日の完成した日足 + 出来高倍率 (Yahoo 1mo daily、15分キャッシュ) */
async function enrichYesterday(ticker: string): Promise<{ volRatio: number | null; candle: string | null; candleDir: 1 | 0 | -1 }> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}.T?range=1mo&interval=1d`;
    const res = await fetch(url, { headers: YF_HEADERS, next: { revalidate: 900 } });
    if (!res.ok) return { volRatio: null, candle: null, candleDir: 0 };
    const j = await res.json();
    const q = j.chart?.result?.[0]?.indicators?.quote?.[0];
    const opens = (q?.open ?? []) as (number | null)[];
    const highs = (q?.high ?? []) as (number | null)[];
    const lows = (q?.low ?? []) as (number | null)[];
    const closes = (q?.close ?? []) as (number | null)[];
    const vols = (q?.volume ?? []) as (number | null)[];

    let idx = closes.length - 1;
    const validVols = vols.filter((v): v is number => v !== null && v > 0);
    const avgVol = validVols.length > 5 ? validVols.slice(0, -1).slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, validVols.length - 1) : null;
    if (avgVol !== null && vols[idx] !== null && (vols[idx] as number) < avgVol * 0.1) idx -= 1;
    if (idx < 1) return { volRatio: null, candle: null, candleDir: 0 };

    const o = opens[idx], h = highs[idx], l = lows[idx], c = closes[idx], v = vols[idx];
    const prevC = closes[idx - 1];
    if (o == null || h == null || l == null || c == null || prevC == null || prevC <= 0) {
      return { volRatio: avgVol !== null && v != null ? v / avgVol : null, candle: null, candleDir: 0 };
    }
    const volRatio = avgVol !== null && v != null ? v / avgVol : null;
    const range = h - l;
    let candle: string | null = null;
    let candleDir: 1 | 0 | -1 = 0;
    if (range > 0) {
      const body = c - o;
      const bodyRatio = Math.abs(body) / range;
      const rangePct = (range / prevC) * 100;
      const upperWick = (h - Math.max(o, c)) / range;
      const lowerWick = (Math.min(o, c) - l) / range;
      if (bodyRatio >= 0.7 && body > 0 && rangePct >= 2) { candle = "前日大陽線"; candleDir = 1; }
      else if (bodyRatio >= 0.7 && body < 0 && rangePct >= 2) { candle = "前日大陰線"; candleDir = -1; }
      else if (lowerWick >= 0.5 && bodyRatio <= 0.4 && rangePct >= 2) { candle = "前日長い下ヒゲ"; candleDir = 1; }
      else if (upperWick >= 0.5 && bodyRatio <= 0.4 && rangePct >= 2) { candle = "前日長い上ヒゲ"; candleDir = -1; }
    }
    return { volRatio, candle, candleDir };
  } catch {
    return { volRatio: null, candle: null, candleDir: 0 };
  }
}

export async function GET() {
  const db = getAdminDb();
  const startedAt = Date.now();

  try {
    const candMap = new Map<string, Candidate>();
    const upsert = (ticker: string, name: string, price: number | null, weight: number, reason: string, dir: 1 | 0 | -1) => {
      const c = candMap.get(ticker) ?? {
        ticker, name, weight: 0, reasons: [], dirSum: 0, dirEvidence: 0,
        hint: "both" as const, consistency: 0, boardCheck: null, lastPrice: price,
      };
      c.weight += weight;
      c.reasons.push(reason);
      if (dir !== 0) { c.dirSum += dir; c.dirEvidence++; }
      if (price !== null) c.lastPrice = price;
      candMap.set(ticker, c);
    };

    // ── 1. スコア急変 (閾値 ±6 に緩和) ──
    const today = await findRankDoc(db);
    if (!today) {
      return NextResponse.json({ ok: false, error: "score_rankings がまだありません" }, { status: 503 });
    }
    const prev = await findRankDoc(db, today.key);
    if (prev) {
      const prevMap = new Map(prev.entries.map((e) => [e.ticker, e]));
      for (const cur of today.entries) {
        if (cur.market !== "JP" || !/^\d{3,4}[A-Z]?$/.test(cur.ticker)) continue;
        const p = prevMap.get(cur.ticker);
        if (!p) continue;
        const delta = cur.overall - p.overall;
        if (Math.abs(delta) >= 6) {
          upsert(
            cur.ticker, cur.name, cur.price,
            Math.min(6, Math.abs(delta) / 3),
            `スコア急変 ${delta > 0 ? "+" : ""}${delta} (${p.overall}→${cur.overall})`,
            delta > 0 ? 1 : -1
          );
        }
      }
    }

    // ── 2. 熱いセクター上位 (Top5 × 4銘柄に拡大) ──
    const st = await db.collection("meta").doc("sector_trends_latest").get();
    if (st.exists) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hot = ((st.data()?.hotTop10 ?? []) as any[]).slice(0, 5);
      for (const sector of hot) {
        if ((sector.hotIndex ?? 0) < 60) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const pick of ((sector.topPicks ?? []) as any[]).slice(0, 4)) {
          if (!/^\d{3,4}[A-Z]?$/.test(pick.ticker)) continue;
          upsert(pick.ticker, pick.name, null, 3, `🔥${sector.name} (Hot${sector.hotIndex}) の上位`, 1);
        }
      }
    }

    // ── 3+4. 前日出来高 + 足形 (一貫性を評価: 矛盾は減点) ──
    const shortlist = Array.from(candMap.values()).sort((a, b) => b.weight - a.weight).slice(0, 20);
    await Promise.all(
      shortlist.map(async (c) => {
        const e = await enrichYesterday(c.ticker);
        if (e.volRatio !== null && e.volRatio >= 1.5) {
          c.weight += e.volRatio >= 2.5 ? 4 : e.volRatio >= 2 ? 3 : 1.5;
          c.reasons.push(`前日出来高 平常の${e.volRatio.toFixed(1)}倍 (燃料あり)`);
        }
        if (e.candle && e.candleDir !== 0) {
          const tentativeDir = Math.sign(c.dirSum) || e.candleDir;
          if (e.candleDir === tentativeDir) {
            c.weight += 2;
            c.reasons.push(`${e.candle} (方向一致)`);
          } else {
            c.weight -= 2; // 矛盾は減点 (v2 の核心)
            c.reasons.push(`⚠${e.candle} — 他の材料と逆方向`);
          }
          c.dirSum += e.candleDir;
          c.dirEvidence++;
        }
      })
    );

    // ── 5. 今朝の気配照合 (場が近い時だけ、立花) ──
    if (boardCheckWindow() && shortlist.length > 0) {
      let session = null;
      try {
        session = await tachibanaLogin();
        const quotes = await getMarketQuotes(session, shortlist.map((c) => c.ticker).slice(0, 20));
        const qmap = new Map(quotes.map((q) => [q.ticker, q]));
        for (const c of shortlist) {
          const q = qmap.get(c.ticker);
          if (!q) continue;
          if (q.currentPrice !== null) c.lastPrice = q.currentPrice;
          // 気配の方向: 成行の偏り > 板圧 の順で判定
          let pressure: 1 | 0 | -1 = 0;
          const mo = q.marketBidQty !== null && q.marketAskQty !== null && q.marketAskQty > 0 ? q.marketBidQty / q.marketAskQty : null;
          const bid = q.bids.reduce((s, l) => s + (l.quantity ?? 0), 0);
          const ask = q.asks.reduce((s, l) => s + (l.quantity ?? 0), 0);
          const br = ask > 0 ? bid / ask : null;
          if (mo !== null && mo >= 1.5) pressure = 1;
          else if (mo !== null && mo <= 0.67) pressure = -1;
          else if (br !== null && br >= 1.3) pressure = 1;
          else if (br !== null && br <= 0.77) pressure = -1;

          const dir = Math.sign(c.dirSum);
          if (pressure !== 0 && dir !== 0) {
            if (pressure === dir) {
              c.weight += 2.5;
              c.boardCheck = "agree";
              c.reasons.push("✓ 今朝の気配も同方向");
            } else {
              c.weight -= 2.5;
              c.boardCheck = "conflict";
              c.reasons.push("⚠ 今朝の気配は逆方向 — 鵜呑みにしない");
            }
          }
        }
      } catch {
        // 立花セッション競合等は照合スキップ (候補自体は返す)
      } finally {
        if (session) await tachibanaLogout(session).catch(() => {});
      }
    }

    // ── 仕上げ: 方向・一貫性の確定、買い/売り分離 ──
    for (const c of shortlist) {
      c.hint = c.dirSum > 0 ? "long" : c.dirSum < 0 ? "short" : "both";
      c.consistency = c.dirEvidence > 0 ? Math.round((Math.abs(c.dirSum) / c.dirEvidence) * 100) : 0;
      // 一貫性でランキングを割り引く (材料が割れてる銘柄は上位に来させない)
      c.weight = Math.round(c.weight * (0.4 + 0.6 * (c.consistency / 100)) * 10) / 10;
      if (c.consistency < 60 && c.dirEvidence >= 2) {
        c.reasons.push(`⚠ 材料の方向が割れている (一貫性${c.consistency}%) — 監視のみ推奨`);
      }
    }
    const ranked = shortlist.filter((c) => c.weight > 0).sort((a, b) => b.weight - a.weight);
    const longs = ranked.filter((c) => c.hint === "long").slice(0, 12);
    const shorts = ranked.filter((c) => c.hint === "short").slice(0, 6);

    return NextResponse.json({
      ok: true,
      baseDate: today.key,
      boardChecked: boardCheckWindow(),
      longs,
      shorts,
      // 後方互換 (morning-agent 等)
      candidates: [...longs, ...shorts],
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
