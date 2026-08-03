/**
 * 🏷 業種マスタの全銘柄化 (テーマ検証の前提条件)
 *
 *   npx tsx scripts/build-industry-map.mts
 *
 * 背景: 既存のテーマ定義 (jp-themes) は 25分類・139銘柄の大型株のみで、
 * 2026-07-31 に半導体テーマを牽引したキオクシア(+17.7%)・ディスコ(+12.7%) が
 * どちらも「半導体」に入っていなかった。この状態でテーマ検証をしても、
 * 走った銘柄を含まない別物を測ることになる。
 *
 * Yahoo summaryProfile の sector/industry (約150分類) を流動銘柄すべてに付与する。
 * ・粒度: 「Semiconductors (チップ)」と「Semiconductor Equipment (製造装置)」が
 *   別分類になるなど、25分類より遥かに細かい
 * ・冪等/再開可能: 既に BQ にある銘柄はスキップするので、何度でも再実行してよい
 *   (Yahooは連続アクセスで絞られるため、複数回に分けて埋めるのが前提)
 */

import { BigQuery } from "@google-cloud/bigquery";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { yfQuoteSummary } from "../src/lib/yahoo-finance";

const BQ_KEY = "C:/Users/matsunaga/Documents/key/booking-data-388605@appspot.gserviceaccount.com/booking-data-388605-ec9e7af2c0e1.json";
const BQ_PROJECT = "booking-data-388605";
const BQ_DATASET = "cavka";
const TABLE = "stock_industry";
const TURNOVER_MIN = 5e7; // 売買代金中央値5千万以上 = 1,922銘柄 (デイトレ可能な範囲を広めに)

const bq = new BigQuery({ projectId: BQ_PROJECT, keyFilename: BQ_KEY });
let raw = readFileSync("./.env.local", "utf-8").match(/FIREBASE_SERVICE_ACCOUNT_KEY=(.+)/)![1].trim();
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1);
initializeApp({ credential: cert(JSON.parse(raw)) });
const fsdb = getFirestore();

interface Row { ticker: string; name: string | null; sector: string | null; industry: string | null }

// ── テーブル (冪等) ──
const ds = bq.dataset(BQ_DATASET);
const [exists] = await ds.table(TABLE).exists();
if (!exists) {
  await ds.createTable(TABLE, {
    schema: [
      { name: "ticker", type: "STRING", mode: "REQUIRED" },
      { name: "name", type: "STRING" },
      { name: "sector", type: "STRING" },
      { name: "industry", type: "STRING" },
    ],
  });
  console.log(`✅ テーブル作成: ${BQ_DATASET}.${TABLE}`);
}

// ── 対象: 流動銘柄 ──
const [uni] = await bq.query(`
  SELECT ticker FROM \`${BQ_PROJECT}.${BQ_DATASET}.daily_features\`
  WHERE date >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 90 DAY)
  GROUP BY ticker HAVING APPROX_QUANTILES(turnover, 2)[OFFSET(1)] >= ${TURNOVER_MIN}`);
const universe = (uni as { ticker: string }[]).map((r) => r.ticker);

// ── 既取得を除く (再開可能) ──
const existing = new Map<string, Row>();
if (exists) {
  const [got] = await bq.query(`SELECT ticker, name, sector, industry FROM \`${BQ_PROJECT}.${BQ_DATASET}.${TABLE}\``);
  for (const r of got as Row[]) existing.set(r.ticker, r);
}
const todo = universe.filter((t) => !existing.has(t));
console.log(`流動銘柄 ${universe.length} / 既取得 ${existing.size} → 今回取得 ${todo.length}`);

// ── 取得 ──
const fresh: Row[] = [];
let failed = 0;
const CONC = 6;
const t0 = Date.now();
for (let i = 0; i < todo.length; i += CONC) {
  const batch = todo.slice(i, i + CONC);
  const res = await Promise.all(batch.map(async (t) => {
    for (let a = 0; a < 3; a++) {
      try {
        const r = await yfQuoteSummary(`${t}.T`, "summaryProfile,price");
        if (r) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sp = r.summaryProfile as any, pr = r.price as any;
          if (sp?.sector || sp?.industry) {
            return { ticker: t, name: pr?.shortName ?? null, sector: sp?.sector ?? null, industry: sp?.industry ?? null } as Row;
          }
          return { ticker: t, name: pr?.shortName ?? null, sector: null, industry: null } as Row;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1200 * (a + 1)));
    }
    return null;
  }));
  for (const r of res) (r && r.industry ? fresh.push(r) : failed++);
  await new Promise((r) => setTimeout(r, 150));
  if ((i / CONC) % 25 === 0) {
    process.stdout.write(`\r  ${i + batch.length}/${todo.length} (ok=${fresh.length} fail=${failed}) ${Math.round((Date.now() - t0) / 1000)}s`);
  }
}
console.log(`\n取得: ok=${fresh.length} fail=${failed}`);

// ── 保存 (既存 + 新規を全置換) ──
const all = [...existing.values(), ...fresh];
if (fresh.length > 0) {
  const tmp = join(tmpdir(), `industry_${Date.now()}.ndjson`);
  writeFileSync(tmp, all.map((r) => JSON.stringify(r)).join("\n"));
  await ds.table(TABLE).load(tmp, { sourceFormat: "NEWLINE_DELIMITED_JSON", writeDisposition: "WRITE_TRUNCATE" });
  unlinkSync(tmp);
  console.log(`✅ BQ: ${all.length}銘柄`);
}

// ── Firestore にも軽量版 (ticker → industry) ──
const map: Record<string, string> = {};
for (const r of all) if (r.industry) map[r.ticker] = r.industry;
await fsdb.collection("meta").doc("industry_map").set({
  map, count: Object.keys(map).length, updatedAt: new Date().toISOString(),
});
console.log(`✅ meta/industry_map: ${Object.keys(map).length}銘柄`);

// ── 分布 ──
const dist = new Map<string, number>();
for (const r of all) if (r.industry) dist.set(r.industry, (dist.get(r.industry) ?? 0) + 1);
console.log(`\n業種数: ${dist.size}`);
console.log("上位20:");
for (const [k, v] of Array.from(dist.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${k}: ${v}銘柄`);
}
const semi = all.filter((r) => r.industry?.includes("Semiconductor"));
console.log(`\n半導体関連: ${semi.length}銘柄 — ${semi.slice(0, 12).map((r) => r.ticker).join(",")}`);
