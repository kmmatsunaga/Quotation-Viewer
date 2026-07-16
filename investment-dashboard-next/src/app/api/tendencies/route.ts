import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { NIKKEI225 } from "@/lib/nikkei225";

/**
 * GET /api/tendencies
 *
 * デイトレ法則発見エンジン (Phase A):
 * 日経225 主要50銘柄 × 直近60日の5分足で、古典的なデイトレ仮説を検証する。
 *
 *   H1. 時間帯ボラティリティ (U字カーブ) — いつ戦うべきか
 *   H2. ギャップアップ (+1.5%以上) の寄り買いは有効か / 寄り天か
 *   H3. ギャップダウン (-1.5%以下) の続落は取れるか
 *   H4. ORB30 (寄り後30分レンジブレイク) の順張りは有効か
 *   H5. VWAP -1% 乖離からの回帰 — レンジ日とトレンド日で分けて検証
 *
 * 結果は「勝率とnを添えて正直に」。効かない仮説は効かないと表示する。
 * 計算は重いので Firestore に24時間キャッシュ (?fresh=1 で再計算)。
 */

export const maxDuration = 300;

const YF_HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };
const CACHE_KEY = "tendency_report_v1";
const CACHE_HOURS = 24;
const UNIVERSE = NIKKEI225.slice(0, 50).map((s) => s.ticker);

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

/** JST の (dateKey, minutes) を返す */
function jstParts(epochSec: number): { date: string; mins: number } {
  const d = new Date((epochSec + 9 * 3600) * 1000);
  return {
    date: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`,
    mins: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

async function fetchDays(ticker: string): Promise<Map<string, Bar[]>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}.T?range=60d&interval=5m`;
  const res = await fetch(url, { headers: YF_HEADERS });
  if (!res.ok) return new Map();
  const j = await res.json();
  const r = j.chart?.result?.[0];
  const ts = (r?.timestamp ?? []) as number[];
  const q = r?.indicators?.quote?.[0] ?? {};
  const days = new Map<string, Bar[]>();
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    const { date, mins } = jstParts(ts[i]);
    if (mins < 9 * 60 || mins > 15 * 60 + 30) continue; // 場中のみ
    const arr = days.get(date) ?? [];
    arr.push({ t: mins, o, h, l, c, v: v ?? 0 });
    days.set(date, arr);
  }
  // バーが少なすぎる日 (半休日など) は除外
  for (const [k, arr] of days) if (arr.length < 30) days.delete(k);
  return days;
}

interface Agg { n: number; wins: number; sumRet: number }
const agg = (): Agg => ({ n: 0, wins: 0, sumRet: 0 });
const add = (a: Agg, ret: number) => { a.n++; a.sumRet += ret; if (ret > 0) a.wins++; };
const fmt = (a: Agg) => ({
  n: a.n,
  winRate: a.n > 0 ? Math.round((a.wins / a.n) * 1000) / 10 : null,
  avgRetPct: a.n > 0 ? Math.round((a.sumRet / a.n) * 10000) / 100 : null,
});

export async function GET(req: NextRequest) {
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  const db = getAdminDb();
  const startedAt = Date.now();

  if (!fresh) {
    try {
      const snap = await db.collection("meta").doc(CACHE_KEY).get();
      if (snap.exists) {
        const data = snap.data();
        const age = (Date.now() - new Date(data?.computedAtIso ?? 0).getTime()) / 3600000;
        if (age < CACHE_HOURS) return NextResponse.json({ ok: true, cached: true, ...data });
      }
    } catch {}
  }

  // ── 集計器 ──
  const hourBuckets = ["9時台", "10時台", "11時台", "後場前半", "後場後半"];
  const bucketOf = (mins: number) =>
    mins < 10 * 60 ? 0 : mins < 11 * 60 ? 1 : mins < 12 * 60 + 30 ? 2 : mins < 14 * 60 ? 3 : 4;
  const volaSum = [0, 0, 0, 0, 0];
  const volaN = [0, 0, 0, 0, 0];
  const volSum = [0, 0, 0, 0, 0];

  const guTo10 = agg(), guToClose = agg();       // H2: GU +1.5% で寄り買い
  const gdTo10 = agg(), gdToClose = agg();       // H3: GD -1.5% で寄り売り (ショート表現: 下落分がプラス)
  const orbUp = agg(), orbDown = agg();          // H4: ORB30 順張り → 大引け
  let vwapRevRange = { n: 0, reverted: 0 };      // H5: レンジ日の VWAP -1% 回帰
  let vwapRevTrend = { n: 0, reverted: 0 };      //     トレンド日の同
  let dayCount = 0;

  // ── 並列取得 + 集計 ──
  const PARALLEL = 8;
  for (let i = 0; i < UNIVERSE.length; i += PARALLEL) {
    if (Date.now() - startedAt > 240_000) break;
    const batch = UNIVERSE.slice(i, i + PARALLEL);
    const results = await Promise.all(batch.map((t) => fetchDays(t).catch(() => new Map<string, Bar[]>())));
    for (const days of results) {
      const keys = Array.from(days.keys()).sort();
      for (let d = 1; d < keys.length; d++) {
        const bars = days.get(keys[d])!;
        const prevBars = days.get(keys[d - 1])!;
        const prevClose = prevBars[prevBars.length - 1].c;
        const open = bars[0].o;
        const close = bars[bars.length - 1].c;
        if (prevClose <= 0 || open <= 0) continue;
        dayCount++;

        // H1: 時間帯ボラ + 出来高
        for (let b = 1; b < bars.length; b++) {
          const bi = bucketOf(bars[b].t);
          if (bars[b - 1].c > 0) {
            volaSum[bi] += Math.abs(bars[b].c / bars[b - 1].c - 1);
            volaN[bi]++;
          }
          volSum[bi] += bars[b].v;
        }

        // H2/H3: ギャップ
        const gap = open / prevClose - 1;
        const at10 = bars.find((b) => b.t >= 10 * 60)?.c ?? close;
        if (gap >= 0.015) {
          add(guTo10, at10 / open - 1);
          add(guToClose, close / open - 1);
        } else if (gap <= -0.015) {
          // ショート想定: open で売り → 下がった分が利益
          add(gdTo10, -(at10 / open - 1));
          add(gdToClose, -(close / open - 1));
        }

        // H4: ORB30 (9:00-9:30 のレンジを、その後どちらに先に抜けたか → 大引けまで順張り)
        const orbBars = bars.filter((b) => b.t < 9 * 60 + 30);
        const rest = bars.filter((b) => b.t >= 9 * 60 + 30);
        if (orbBars.length >= 4 && rest.length > 5) {
          const orbH = Math.max(...orbBars.map((b) => b.h));
          const orbL = Math.min(...orbBars.map((b) => b.l));
          for (const b of rest) {
            if (b.h > orbH) { add(orbUp, close / orbH - 1); break; }
            if (b.l < orbL) { add(orbDown, -(close / orbL - 1)); break; }
          }
        }

        // H5: VWAP -1% 乖離からの回帰 (60分以内に -0.5% まで戻すか)。日タイプ別。
        const range = Math.max(...bars.map((b) => b.h)) - Math.min(...bars.map((b) => b.l));
        const isTrend = range > 0 && Math.abs(close - open) / range >= 0.6;
        let cumPV = 0, cumV = 0;
        const devs: number[] = [];
        for (const b of bars) {
          cumPV += ((b.h + b.l + b.c) / 3) * b.v;
          cumV += b.v;
          devs.push(cumV > 0 ? b.c / (cumPV / cumV) - 1 : 0);
        }
        for (let b = 6; b < bars.length; b++) {
          if (devs[b] <= -0.01) {
            const horizon = devs.slice(b + 1, b + 13);
            const reverted = horizon.some((x) => x >= -0.005);
            if (isTrend) { vwapRevTrend.n++; if (reverted) vwapRevTrend.reverted++; }
            else { vwapRevRange.n++; if (reverted) vwapRevRange.reverted++; }
            break; // 1日1イベント (独立性確保)
          }
        }
      }
    }
  }

  // ── レポート組み立て ──
  const totalVol = volSum.reduce((s, v) => s + v, 0) || 1;
  const volaPct = volaSum.map((s, i) => (volaN[i] > 0 ? Math.round((s / volaN[i]) * 100000) / 1000 : 0));
  const maxVola = Math.max(...volaPct);

  const judge = (winRate: number | null, n: number, edgeAt = 55, deadAt = 48): string =>
    n < 30 ? "❓ サンプル不足" : winRate === null ? "—" : winRate >= edgeAt ? "✅ 傾向あり" : winRate <= deadAt ? "❌ 効かない (逆張り検討)" : "➖ エッジなし";

  const revRateRange = vwapRevRange.n > 0 ? Math.round((vwapRevRange.reverted / vwapRevRange.n) * 1000) / 10 : null;
  const revRateTrend = vwapRevTrend.n > 0 ? Math.round((vwapRevTrend.reverted / vwapRevTrend.n) * 1000) / 10 : null;

  const report = {
    universe: UNIVERSE.length,
    dayCount,
    hypotheses: [
      {
        id: "u_curve",
        title: "H1. 時間帯ボラティリティ (いつ戦うか)",
        lines: hourBuckets.map((b, i) => ({
          label: b,
          value: `平均5分値動き ${volaPct[i].toFixed(3)}% / 出来高シェア ${Math.round((volSum[i] / totalVol) * 100)}%`,
          strength: maxVola > 0 ? volaPct[i] / maxVola : 0,
        })),
        verdict: volaPct[0] === maxVola
          ? "✅ 9時台のボラが最大 — 値幅を取るなら朝。昼 (11時台) は最も静か"
          : "⚠ 直近60日はU字が崩れている。時間帯別の値動きを確認して戦う時間を選ぶこと",
      },
      {
        id: "gap_up",
        title: "H2. GU +1.5%以上を寄りで買う",
        lines: [
          { label: "→ 10:00まで", value: `勝率 ${fmt(guTo10).winRate}% / 平均 ${fmt(guTo10).avgRetPct}% (n=${guTo10.n})` },
          { label: "→ 大引けまで", value: `勝率 ${fmt(guToClose).winRate}% / 平均 ${fmt(guToClose).avgRetPct}% (n=${guToClose.n})` },
        ],
        verdict: judge(fmt(guToClose).winRate, guToClose.n),
      },
      {
        id: "gap_down",
        title: "H3. GD -1.5%以下を寄りで売る (空売り)",
        lines: [
          { label: "→ 10:00まで", value: `勝率 ${fmt(gdTo10).winRate}% / 平均 ${fmt(gdTo10).avgRetPct}% (n=${gdTo10.n})` },
          { label: "→ 大引けまで", value: `勝率 ${fmt(gdToClose).winRate}% / 平均 ${fmt(gdToClose).avgRetPct}% (n=${gdToClose.n})` },
        ],
        verdict: judge(fmt(gdToClose).winRate, gdToClose.n),
      },
      {
        id: "orb",
        title: "H4. ORB30 — 寄り後30分レンジのブレイク順張り",
        lines: [
          { label: "上抜け→大引け", value: `勝率 ${fmt(orbUp).winRate}% / 平均 ${fmt(orbUp).avgRetPct}% (n=${orbUp.n})` },
          { label: "下抜け→大引け(売り)", value: `勝率 ${fmt(orbDown).winRate}% / 平均 ${fmt(orbDown).avgRetPct}% (n=${orbDown.n})` },
        ],
        verdict: judge(Math.max(fmt(orbUp).winRate ?? 0, fmt(orbDown).winRate ?? 0), orbUp.n + orbDown.n),
      },
      {
        id: "vwap_reversion",
        title: "H5. VWAP -1%乖離からの回帰 (60分以内に半値戻し)",
        lines: [
          { label: "レンジ日", value: `回帰率 ${revRateRange}% (n=${vwapRevRange.n})` },
          { label: "トレンド日", value: `回帰率 ${revRateTrend}% (n=${vwapRevTrend.n})` },
        ],
        verdict:
          revRateRange !== null && revRateTrend !== null && vwapRevRange.n >= 30 && vwapRevTrend.n >= 30
            ? revRateRange - revRateTrend >= 10
              ? `✅ レンジ日は回帰が効く (${revRateRange}%)、トレンド日は逆張り危険 (${revRateTrend}%) — 「今日はどっちの日か」の識別が全て`
              : "➖ 日タイプによる差が小さい。VWAP回帰は単独では使いにくい"
            : "❓ サンプル不足",
      },
    ],
    note: "日経225主要50銘柄 × 直近60日 (5分足)。手数料・スリッページ・板の厚み未考慮 — 実弾はこの数字より必ず悪化する。",
    computedAtIso: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
  };

  try {
    await db.collection("meta").doc(CACHE_KEY).set(report);
  } catch {}

  return NextResponse.json({ ok: true, cached: false, ...report });
}
