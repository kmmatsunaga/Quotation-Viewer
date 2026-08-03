/**
 * 🌡 「今日の主語」エンジンのリプレイ検証 (ローカル実行、実装前の設計テスト)
 *
 *   npx tsx scripts/replay-theme-radar.mts [YYYY-MM-DD]
 *
 * 問い: 場中の各時点で「今日はどのテーマに金が来ているか」を機械的に言えたか?
 *       言えたなら、それは行動可能だったか (その後も続いたか)?
 *
 * 設計を都合よく歪めないため、セクター定義 (jp-themes) は一切いじらない。
 * 後知恵で銘柄を足せば何でも当たるので、既存の定義のままで通るかを見る。
 *
 * 検証は3本:
 *   ① 各時点のテーマ順位 — 注目すべきテーマを早い時間に名指しできたか
 *   ② 継続性 — 10時に上位だったテーマは、その後 (10時→引け) も上がったか
 *      (これが無いと「事後の追認」にしかならない)
 *   ③ テーマ内の出遅れ拾い — 10時時点の先行組 vs 出遅れ組、その後どちらが伸びたか
 */

import { ALL_SECTORS } from "../src/lib/jp-themes";

const YF = { "User-Agent": "Mozilla/5.0" };
const argDate = process.argv[2] ?? null;

// 観測時点 (JST)。昼休みは 11:30-12:30
const SLOTS = ["09:05", "09:30", "10:00", "10:30", "11:00", "11:30", "12:45", "13:30", "14:00", "14:30", "15:00", "15:25"];

interface Bar { jst: string; price: number; volume: number }
interface StockDay { ticker: string; prevClose: number; bars: Bar[] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 当日の5分足を取得 (JST HH:MM キー付き) */
async function fetchIntraday(symbol: string, tries = 3): Promise<StockDay | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(url, { headers: YF });
      if (res.status === 429) { await sleep(1500 * (a + 1)); continue; }
      if (!res.ok) return null;
      const j = await res.json();
      const r = j?.chart?.result?.[0];
      const prevClose = r?.meta?.chartPreviousClose;
      const ts: number[] = r?.timestamp ?? [];
      const q = r?.indicators?.quote?.[0];
      if (typeof prevClose !== "number" || !ts.length || !q) return null;
      const bars: Bar[] = [];
      for (let i = 0; i < ts.length; i++) {
        const c = q.close?.[i];
        if (typeof c !== "number" || !isFinite(c)) continue;
        const d = new Date(ts[i] * 1000 + 9 * 3600 * 1000);
        const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
        if (argDate && day !== argDate) continue;
        bars.push({
          jst: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`,
          price: c,
          volume: typeof q.volume?.[i] === "number" ? q.volume[i] : 0,
        });
      }
      if (bars.length === 0) return null;
      return { ticker: symbol, prevClose, bars };
    } catch { await sleep(800); }
  }
  return null;
}

/** 指定時刻「以前で最も近い」バーの騰落率 (前日終値比 %) */
function changeAt(s: StockDay, slot: string): number | null {
  let last: Bar | null = null;
  for (const b of s.bars) { if (b.jst <= slot) last = b; else break; }
  if (!last || !(s.prevClose > 0)) return null;
  return ((last.price - s.prevClose) / s.prevClose) * 100;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);

// ── ユニバース: 既存セクター定義の全銘柄 (改変なし) ──
const tickers = Array.from(new Set(ALL_SECTORS.flatMap((s) => s.tickers)));
console.log(`ユニバース: ${ALL_SECTORS.length}セクター / ${tickers.length}銘柄 (jp-themes 定義そのまま)`);

// 参考: キオクシア (セクター定義に無いが今日の主役) と日経
const EXTRA = ["285A", "^N225"];

const data = new Map<string, StockDay>();
const all = [...tickers, ...EXTRA];
const CONC = 8;
for (let i = 0; i < all.length; i += CONC) {
  const batch = all.slice(i, i + CONC);
  const res = await Promise.all(batch.map((t) => fetchIntraday(t.startsWith("^") ? t : `${t}.T`)));
  batch.forEach((t, k) => { if (res[k]) data.set(t, res[k]!); });
  await sleep(120);
}
console.log(`取得: ${data.size}/${all.length}\n`);

const nikkei = data.get("^N225");
const dayLabel = argDate ?? "(直近営業日)";

// ── ① 各時点のテーマ順位 ──
interface SectorSnap { name: string; emoji: string; agg: number; up: number; n: number }
function snapshot(slot: string): SectorSnap[] {
  const out: SectorSnap[] = [];
  for (const sec of ALL_SECTORS) {
    const chs = sec.tickers.map((t) => { const s = data.get(t); return s ? changeAt(s, slot) : null; })
      .filter((v): v is number => v != null);
    if (chs.length < 3) continue;
    out.push({
      name: sec.name, emoji: sec.emoji,
      agg: mean(chs)!,
      up: chs.filter((v) => v > 0).length / chs.length * 100,
      n: chs.length,
    });
  }
  return out.sort((a, b) => b.agg - a.agg);
}

console.log(`━━━ ① 各時点のテーマ順位 (${dayLabel}) ━━━`);
console.log("時刻   日経      1位                    2位                    3位                   | 最下位");
for (const slot of SLOTS) {
  const snap = snapshot(slot);
  if (snap.length === 0) continue;
  const nk = nikkei ? changeAt(nikkei, slot) : null;
  const f = (s: SectorSnap | undefined) => s ? `${s.emoji}${s.name} ${s.agg >= 0 ? "+" : ""}${s.agg.toFixed(2)}%`.padEnd(22) : "".padEnd(22);
  const last = snap[snap.length - 1];
  console.log(
    `${slot}  ${nk != null ? (nk >= 0 ? "+" : "") + nk.toFixed(2) + "%" : "  -  "}   ${f(snap[0])} ${f(snap[1])} ${f(snap[2])}| ${last.emoji}${last.name} ${last.agg.toFixed(2)}%`,
  );
}

// 半導体の順位推移 (今日の主役だったはずのテーマを追跡)
console.log(`\n━━━ 半導体テーマの順位推移 ━━━`);
for (const slot of SLOTS) {
  const snap = snapshot(slot);
  const idx = snap.findIndex((s) => s.name === "半導体");
  if (idx < 0) continue;
  const s = snap[idx];
  const kioxia = data.get("285A") ? changeAt(data.get("285A")!, slot) : null;
  console.log(`${slot}  ${idx + 1}位/${snap.length}  平均${s.agg >= 0 ? "+" : ""}${s.agg.toFixed(2)}%  上昇率${s.up.toFixed(0)}%   [参考] キオクシア285A ${kioxia != null ? (kioxia >= 0 ? "+" : "") + kioxia.toFixed(2) + "%" : "-"}`);
}

// ── ② 継続性: 10時の順位 → その後 (10時→引け) の伸び ──
console.log(`\n━━━ ② 継続性の検証: 10:00時点の順位は「その後」を当てたか ━━━`);
for (const baseSlot of ["10:00", "11:00"]) {
  const base = snapshot(baseSlot);
  const close = snapshot("15:25");
  const closeMap = new Map(close.map((s) => [s.name, s.agg]));
  const rows = base.map((s, i) => ({
    rank: i + 1, name: s.name, at: s.agg,
    after: (closeMap.get(s.name) ?? s.agg) - s.agg, // 基準時刻→引け の追加上昇
  }));
  const top3 = rows.slice(0, 3), bottom3 = rows.slice(-3);
  const topAfter = mean(top3.map((r) => r.after))!;
  const botAfter = mean(bottom3.map((r) => r.after))!;
  const allAfter = mean(rows.map((r) => r.after))!;
  console.log(`\n[${baseSlot} 基準] ${baseSlot}→引け の追加リターン`);
  console.log(`  上位3テーマ: ${topAfter >= 0 ? "+" : ""}${topAfter.toFixed(2)}%   (${top3.map((r) => r.name).join("/")})`);
  console.log(`  全テーマ平均: ${allAfter >= 0 ? "+" : ""}${allAfter.toFixed(2)}%`);
  console.log(`  下位3テーマ: ${botAfter >= 0 ? "+" : ""}${botAfter.toFixed(2)}%   (${bottom3.map((r) => r.name).join("/")})`);
  console.log(`  → 上位が全体を ${(topAfter - allAfter >= 0 ? "+" : "")}${(topAfter - allAfter).toFixed(2)}% 上回った`);
}

// ── ③ テーマ内: 10時の先行組 vs 出遅れ組 ──
console.log(`\n━━━ ③ 上位テーマ内で「先行組」と「出遅れ組」どちらが伸びたか (10:00→引け) ━━━`);
const base10 = snapshot("10:00");
for (const sec of ALL_SECTORS.filter((s) => base10.slice(0, 3).some((b) => b.name === s.name))) {
  const members = sec.tickers.map((t) => {
    const s = data.get(t); if (!s) return null;
    const at10 = changeAt(s, "10:00"), atCl = changeAt(s, "15:25");
    if (at10 == null || atCl == null) return null;
    return { ticker: t, at10, after: atCl - at10 };
  }).filter((v): v is { ticker: string; at10: number; after: number } => v != null)
    .sort((a, b) => b.at10 - a.at10);
  if (members.length < 4) continue;
  const half = Math.floor(members.length / 2);
  const lead = members.slice(0, half), lag = members.slice(-half);
  console.log(`\n${sec.emoji}${sec.name}`);
  console.log(`  先行組 (10時に強い ${lead.map((m) => m.ticker).join(",")}): その後 ${(mean(lead.map((m) => m.after))! >= 0 ? "+" : "")}${mean(lead.map((m) => m.after))!.toFixed(2)}%`);
  console.log(`  出遅れ組 (${lag.map((m) => m.ticker).join(",")}): その後 ${(mean(lag.map((m) => m.after))! >= 0 ? "+" : "")}${mean(lag.map((m) => m.after))!.toFixed(2)}%`);
}

// ── ④ 実効性: 「その時点の1位テーマを買って引けまで持つ」と何%だったか ──
// これが本丸。事後の追認ではなく、その時刻に行動できたかを測る。
console.log(`\n━━━ ④ 「T時点の1位テーマを買って引けまで保有」したら ━━━`);
console.log("時刻   1位テーマ        その時点   引け      T→引け");
const closeSnap = new Map(snapshot("15:25").map((s) => [s.name, s.agg]));
for (const slot of SLOTS) {
  const snap = snapshot(slot);
  if (!snap.length) continue;
  const top = snap[0];
  const cl = closeSnap.get(top.name);
  if (cl == null) continue;
  const after = cl - top.agg;
  const mark = after > 1 ? "◎" : after > 0 ? "○" : after > -1 ? "△" : "✗";
  console.log(`${slot}  ${(top.emoji + top.name).padEnd(14)}  ${(top.agg >= 0 ? "+" : "") + top.agg.toFixed(2)}%   ${(cl >= 0 ? "+" : "") + cl.toFixed(2)}%   ${(after >= 0 ? "+" : "") + after.toFixed(2)}% ${mark}`);
}

// ── ⑤ 最下位テーマ (触ってはいけない場所) を避けられたか ──
console.log(`\n━━━ ⑤ 最下位テーマの推移 (「避ける」判断の価値) ━━━`);
const worstName = snapshot("09:30")[snapshot("09:30").length - 1].name;
const worstSec = ALL_SECTORS.find((s) => s.name === worstName)!;
console.log(`09:30時点の最下位: ${worstSec.emoji}${worstName}`);
for (const slot of ["09:30", "10:00", "11:00", "13:30", "15:25"]) {
  const snap = snapshot(slot);
  const s = snap.find((x) => x.name === worstName)!;
  console.log(`  ${slot}  ${s.agg.toFixed(2)}%  (順位 ${snap.findIndex((x) => x.name === worstName) + 1}/${snap.length})`);
}
console.log(`  構成銘柄の引け: ${worstSec.tickers.map((t) => { const s = data.get(t); const c = s ? changeAt(s, "15:25") : null; return c == null ? null : `${t} ${c >= 0 ? "+" : ""}${c.toFixed(1)}%`; }).filter(Boolean).join(" / ")}`);

console.log(`\n(注) セクター定義は既存 ${ALL_SECTORS.length}分類・${tickers.length}銘柄 (大型中心)。中小型テーマは検出範囲外。`);
