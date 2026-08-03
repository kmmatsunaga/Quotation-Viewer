/**
 * 🌡 「今日の主語」エンジン — 過去60日リプレイ (統計判定)
 *
 *   npx tsx scripts/replay-theme-radar-multi.mts
 *
 * 7/31 単日では「9:05に半導体を名指しでき、引けまで+4.74%」だったが n=1。
 * Yahoo の5分足が約60日遡れることを利用し、全営業日で同じ手続きを回して
 * 「寄り直後のテーマ検出は一般に効くのか」を判定する。
 *
 * 統計設計 (パターン工場・場中の法則と同じ規律):
 *   ・統計単位は「営業日」(同じ日の25テーマは独立でないため)
 *   ・地合い交絡を消すため、必ず日経225を引いた【超過リターン】で測る
 *     (上げ相場ではどのテーマを買っても上がるので、絶対リターンは無意味)
 *   ・「1位を買う価値」と「最下位を避ける価値」を別々に測る
 *   ・帰無仮説は「超過=0」。日次系列の t 検定 (|t|>=2 でまず有意)
 */

import { ALL_SECTORS } from "../src/lib/jp-themes";

const YF = { "User-Agent": "Mozilla/5.0" };
const SLOTS = ["09:05", "09:15", "09:30", "10:00", "11:00", "13:00"];
const CLOSE = "15:25";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ticker → date → { prevClose, 各slotの価格, 引け価格 } */
type DayRec = { prevClose: number; at: Record<string, number>; close: number };

async function fetch60d(symbol: string, tries = 3): Promise<Map<string, DayRec> | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=60d&interval=5m`;
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(url, { headers: YF });
      if (res.status === 429) { await sleep(2000 * (a + 1)); continue; }
      if (!res.ok) return null;
      const j = await res.json();
      const r = j?.chart?.result?.[0];
      const ts: number[] = r?.timestamp ?? [];
      const q = r?.indicators?.quote?.[0];
      if (!ts.length || !q) return null;

      // 日付ごとに (JST時刻, 価格) を集める
      const byDate = new Map<string, { jst: string; price: number }[]>();
      for (let i = 0; i < ts.length; i++) {
        const c = q.close?.[i];
        if (typeof c !== "number" || !isFinite(c)) continue;
        const d = new Date(ts[i] * 1000 + 9 * 3600 * 1000);
        const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
        const jst = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
        if (jst < "09:00" || jst > "15:30") continue; // 場外のバーは捨てる
        if (!byDate.has(day)) byDate.set(day, []);
        byDate.get(day)!.push({ jst, price: c });
      }

      const dates = Array.from(byDate.keys()).sort();
      const out = new Map<string, DayRec>();
      for (let i = 1; i < dates.length; i++) { // i=0 は前日終値が無いので除外
        const bars = byDate.get(dates[i])!.sort((a, b) => a.jst.localeCompare(b.jst));
        const prevBars = byDate.get(dates[i - 1])!;
        const prevClose = prevBars[prevBars.length - 1].price; // 前営業日の最終価格
        if (!(prevClose > 0) || bars.length < 30) continue;    // 半日立会等は除外
        const at: Record<string, number> = {};
        for (const slot of SLOTS) {
          let last: number | null = null;
          for (const b of bars) { if (b.jst <= slot) last = b.price; else break; }
          if (last != null) at[slot] = last;
        }
        let cl: number | null = null;
        for (const b of bars) { if (b.jst <= CLOSE) cl = b.price; }
        if (cl == null) continue;
        out.set(dates[i], { prevClose, at, close: cl });
      }
      return out;
    } catch { await sleep(800); }
  }
  return null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function tStat(xs: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const m = mean(xs)!;
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1));
  return sd > 0 ? m / (sd / Math.sqrt(n)) : null;
}

// ── データ取得 ──
const tickers = Array.from(new Set(ALL_SECTORS.flatMap((s) => s.tickers)));
const all = [...tickers, "^N225"];
console.log(`取得中: ${all.length}銘柄 × 60営業日の5分足…`);
const data = new Map<string, Map<string, DayRec>>();
const CONC = 6;
for (let i = 0; i < all.length; i += CONC) {
  const batch = all.slice(i, i + CONC);
  const res = await Promise.all(batch.map((t) => fetch60d(t.startsWith("^") ? t : `${t}.T`)));
  batch.forEach((t, k) => { if (res[k]) data.set(t, res[k]!); });
  await sleep(150);
  if (i % 30 === 0) process.stdout.write(`\r  ${i + batch.length}/${all.length}`);
}
console.log(`\n取得完了: ${data.size}/${all.length}銘柄`);

const nk = data.get("^N225");
if (!nk) throw new Error("日経225が取得できませんでした");

// 共通の営業日 (日経にある日)
const days = Array.from(nk.keys()).sort();
console.log(`対象営業日: ${days.length}日 (${days[0]} 〜 ${days[days.length - 1]})\n`);

/** ある日・ある時刻のテーマ別平均騰落 (前日終値比%) */
function sectorAgg(day: string, slot: string | "close"): { name: string; agg: number }[] {
  const out: { name: string; agg: number }[] = [];
  for (const sec of ALL_SECTORS) {
    const chs: number[] = [];
    for (const t of sec.tickers) {
      const rec = data.get(t)?.get(day);
      if (!rec) continue;
      const p = slot === "close" ? rec.close : rec.at[slot];
      if (p == null) continue;
      chs.push(((p - rec.prevClose) / rec.prevClose) * 100);
    }
    if (chs.length >= 3) out.push({ name: sec.name, agg: mean(chs)! });
  }
  return out.sort((a, b) => b.agg - a.agg);
}
function nikkeiAt(day: string, slot: string | "close"): number | null {
  const rec = nk.get(day);
  if (!rec) return null;
  const p = slot === "close" ? rec.close : rec.at[slot];
  return p == null ? null : ((p - rec.prevClose) / rec.prevClose) * 100;
}

// ── 判定 ──
console.log("━━━ 寄り直後のテーマ検出は一般に効くのか (日経を引いた超過リターン) ━━━");
console.log("基準時刻  n   1位を買う     t値    最下位を買う   t値    | 1位が引けもTop3");
interface Row { day: string; slot: string; topEx: number; worstEx: number; top3Ex: number; stayTop3: boolean; topName: string }
const rowsBySlot = new Map<string, Row[]>();

for (const slot of SLOTS) {
  const rows: Row[] = [];
  for (const day of days) {
    const at = sectorAgg(day, slot);
    const cl = sectorAgg(day, "close");
    const nkAt = nikkeiAt(day, slot), nkCl = nikkeiAt(day, "close");
    if (at.length < 15 || cl.length < 15 || nkAt == null || nkCl == null) continue;
    const clMap = new Map(cl.map((s) => [s.name, s.agg]));
    const nkMove = nkCl - nkAt;
    const after = (name: string) => {
      const c = clMap.get(name); const a = at.find((x) => x.name === name)?.agg;
      return c == null || a == null ? null : c - a - nkMove; // 超過
    };
    const topName = at[0].name, worstName = at[at.length - 1].name;
    const topEx = after(topName), worstEx = after(worstName);
    const t3 = at.slice(0, 3).map((s) => after(s.name)).filter((v): v is number => v != null);
    if (topEx == null || worstEx == null || t3.length === 0) continue;
    const clTop3 = new Set(cl.slice(0, 3).map((s) => s.name));
    rows.push({ day, slot, topEx, worstEx, top3Ex: mean(t3)!, stayTop3: clTop3.has(topName), topName });
  }
  rowsBySlot.set(slot, rows);
  const topT = tStat(rows.map((r) => r.topEx)), worstT = tStat(rows.map((r) => r.worstEx));
  const stay = rows.filter((r) => r.stayTop3).length / rows.length * 100;
  const f = (v: number | null) => (v == null ? "  -  " : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`).padStart(7);
  const ft = (v: number | null) => (v == null ? " - " : v.toFixed(2)).padStart(6);
  console.log(`${slot}    ${String(rows.length).padStart(2)}  ${f(mean(rows.map((r) => r.topEx)))} ${ft(topT)}  ${f(mean(rows.map((r) => r.worstEx)))} ${ft(worstT)}  |  ${stay.toFixed(0)}%`);
}

// ── 09:05 の詳細 (最有望時刻) ──
const key = "09:05";
const rows = rowsBySlot.get(key) ?? [];
if (rows.length) {
  console.log(`\n━━━ ${key} の詳細 ━━━`);
  const wins = rows.filter((r) => r.topEx > 0).length;
  console.log(`1位テーマを買って引けまで: 勝率 ${(wins / rows.length * 100).toFixed(0)}% (${wins}/${rows.length}日)`);
  console.log(`  平均超過 ${mean(rows.map((r) => r.topEx))!.toFixed(2)}% / 中央値 ${[...rows.map((r) => r.topEx)].sort((a, b) => a - b)[Math.floor(rows.length / 2)].toFixed(2)}%`);
  console.log(`上位3テーマ平均: ${mean(rows.map((r) => r.top3Ex))!.toFixed(2)}% (t=${tStat(rows.map((r) => r.top3Ex))?.toFixed(2)})`);
  console.log(`最下位テーマ: ${mean(rows.map((r) => r.worstEx))!.toFixed(2)}% → 避ける価値 ${(-mean(rows.map((r) => r.worstEx))!).toFixed(2)}%`);
  const byTheme = new Map<string, number>();
  for (const r of rows) byTheme.set(r.topName, (byTheme.get(r.topName) ?? 0) + 1);
  console.log(`\n1位になった回数: ${Array.from(byTheme.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => `${n}${c}`).join(" / ")}`);
  console.log(`\n直近10日:`);
  for (const r of rows.slice(-10)) {
    console.log(`  ${r.day}  1位=${r.topName.padEnd(8)} → 引けまで超過 ${r.topEx >= 0 ? "+" : ""}${r.topEx.toFixed(2)}%  ${r.stayTop3 ? "(引けもTop3)" : ""}`);
  }
}
