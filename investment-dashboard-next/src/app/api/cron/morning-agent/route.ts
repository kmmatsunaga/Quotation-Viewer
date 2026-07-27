import { NextRequest, NextResponse } from "next/server";
import { getAdminDb, resolveUidByEmail, collectUserTickers } from "@/lib/firebase-admin";
import { sendLineMessage } from "@/lib/line-notify";
import { detectTransitions, type MacroSnapshot } from "@/lib/macro-transitions";
import { getCronOrigin } from "@/lib/cron-origin";
import { getCachedJpStocks } from "@/lib/jp-stocks-cache";
import { NIKKEI225 } from "@/lib/nikkei225";

/**
 * GET /api/cron/morning-agent — ☀ Cavka 番頭 (朝の作戦エージェント)
 *
 * 「朝のルーティン」を人間の代わりに実行して LINE に届ける:
 *   1. 🌍 マクロ遷移 (前日から変わったものだけ)
 *   2. ⚖ 保有/お気に入りの評決変化 + ⚡対立中
 *   3. ⚔ 今日のデイトレ候補 (理由付き)
 *   4. 🗓 決算接近 (7日以内)
 *
 * 変化ゼロの日は「平常運転」と1行だけ送る (沈黙より信頼できる)。
 * 発注や売買の指示は絶対にしない — 判断材料の給仕まで。
 *
 * 実行: 毎朝 JST 07:15 予定 (Vercel Hobby は最大1時間遅延するため前倒し設定。
 *       実際の配達は 07:15〜08:15 の間)。?dry=1 で送信せず本文を返す。
 * 観測性: 実行の開始/結果を meta/cron_status_morning_agent に記録 (不達時の即診断用)。
 */

const CRON_SECRET = process.env.CRON_SECRET;
const FALLBACK_EMAIL = "make.some.noise6984@gmail.com";
export const maxDuration = 120;

const STANCE_JA: Record<string, string> = {
  strong_bull: "強気", bull: "やや強気", neutral: "中立",
  bear: "やや弱気", strong_bear: "弱気", contested: "対立",
};
const TF_JA: Record<string, string> = { short: "短期", mid: "中期", long: "長期" };

function jstDateKey(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
}

async function findLatestDoc(db: FirebaseFirestore.Firestore, prefix: string, maxBack: number, beforeKey?: string) {
  for (let i = 0; i <= maxBack; i++) {
    const key = jstDateKey(new Date(Date.now() - i * 24 * 3600 * 1000));
    if (beforeKey && key >= beforeKey) continue;
    const snap = await db.collection("meta").doc(`${prefix}${key}`).get();
    if (snap.exists) return { key, data: snap.data() ?? {} };
  }
  return null;
}

export async function GET(req: NextRequest) {
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  // dry (本文プレビューのみ・送信なし) は認証不要。実送信は CRON_SECRET 必須。
  const authHeader = req.headers.get("authorization");
  if (!dry && CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getAdminDb();
  const origin = getCronOrigin(req);
  const startedAt = Date.now();
  const sections: string[] = [];

  // 観測性: 実行開始を記録 (不達時に「そもそも起動したか」を即断できる)
  if (!dry) {
    try {
      await db.collection("meta").doc("cron_status_morning_agent").set({
        status: "running",
        startedAtIso: new Date().toISOString(),
      });
    } catch {}
  }

  // ── 1. マクロ遷移 ──
  try {
    const today = await findLatestDoc(db, "macro_fred_watch_history_", 3);
    const prev = today ? await findLatestDoc(db, "macro_fred_watch_history_", 7, today.key) : null;
    if (today && prev) {
      const transitions = detectTransitions(prev.data as Partial<MacroSnapshot>, today.data as MacroSnapshot);
      if (transitions.length > 0) {
        sections.push(["🌍 マクロ遷移", ...transitions.map((t) => `${t.emoji} ${t.message}`)].join("\n"));
      }
    }
  } catch {}

  // ── 2. 評決の変化 + 対立中 ──
  try {
    // 銘柄名リゾルバ (評決エントリは ticker のみなので日本語名を引く)
    const nameMap = new Map<string, string>(NIKKEI225.map((s) => [s.ticker, s.name]));
    try {
      for (const s of await getCachedJpStocks()) if (s.name) nameMap.set(s.ticker, s.name);
    } catch {}
    const labelOf = (ticker: string) => {
      const nm = nameMap.get(ticker);
      return nm ? `${nm}(${ticker})` : ticker;
    };

    const vToday = await findLatestDoc(db, "verdict_history_", 3);
    const vPrev = vToday ? await findLatestDoc(db, "verdict_history_", 7, vToday.key) : null;
    const lines: string[] = [];
    if (vToday) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entries = (vToday.data.entries ?? []) as any[];
      if (vPrev) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const prevMap = new Map(((vPrev.data.entries ?? []) as any[]).map((e) => [e.ticker, e]));
        for (const cur of entries) {
          const p = prevMap.get(cur.ticker);
          if (!p) continue;
          for (const tf of ["short", "mid", "long"] as const) {
            if (p[tf]?.stance && cur[tf]?.stance && p[tf].stance !== cur[tf].stance) {
              const worse = ["bear", "strong_bear"].includes(cur[tf].stance);
              lines.push(`${worse ? "🚨" : "🔄"} ${labelOf(cur.ticker)}: ${TF_JA[tf]}が ${STANCE_JA[p[tf].stance]}→${STANCE_JA[cur[tf].stance]}`);
            }
          }
        }
      }
      for (const cur of entries) {
        if (["short", "mid", "long"].some((tf) => cur[tf]?.stance === "contested")) {
          lines.push(`⚡ ${labelOf(cur.ticker)}: 見解対立中 — Verdict を確認`);
        }
      }
    }
    if (lines.length > 0) sections.push(["⚖ 監視銘柄の評決", ...Array.from(new Set(lines)).slice(0, 8)].join("\n"));
  } catch {}

  // ── 3. デイトレ候補 ──
  // 内部フェッチにも必ずタイムアウトを付ける (朝のコールドキャッシュで候補APIが長考すると
  // 関数ごと maxDuration で死に、LINE 未送信 + status=running のまま残る)
  try {
    const res = await fetch(`${origin}/api/daytrade-candidates`, { next: { revalidate: 1800 }, signal: AbortSignal.timeout(45_000) });
    if (res.ok) {
      const j = await res.json();
      // 答え合わせ用スナップショット (candidates-eval cron が引け後に評価する)
      if (!dry) {
        try {
          const snapKey = jstDateKey(new Date());
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pick = (arr: any[]) => (arr ?? []).map((c) => ({
            ticker: c.ticker, name: c.name ?? c.ticker, hint: c.hint ?? "long",
            weight: c.weight ?? null, consistency: c.consistency ?? null,
            reasons: (c.reasons ?? []).slice(0, 3),
          }));
          await db.collection("meta").doc(`candidate_snapshot_${snapKey}`).set({
            date: snapKey,
            snappedAtIso: new Date().toISOString(),
            longs: pick(j.longs ?? []),
            shorts: pick(j.shorts ?? []),
          });
        } catch {}
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cands = ((j.candidates ?? []) as any[]).slice(0, 5);
      if (cands.length > 0) {
        sections.push([
          "⚔ 今日のデイトレ候補",
          ...cands.map((c) => `${c.hint === "long" ? "🟢" : c.hint === "short" ? "🔴" : "🟡"} ${c.ticker} ${c.name}\n   ${c.reasons.slice(0, 2).join(" / ")}`),
        ].join("\n"));
      }
    }
  } catch {}

  // ── 4. 決算接近 (監視銘柄、7日以内) ──
  try {
    const emails = (process.env.CAVKA_CRON_EMAILS ?? FALLBACK_EMAIL).split(",").map((e) => e.trim()).filter(Boolean);
    const uid0 = emails.length > 0 ? await resolveUidByEmail(emails[0]) : null;
    if (uid0) {
      const tickers = (await collectUserTickers(uid0)).slice(0, 30);
      if (tickers.length > 0) {
        const res = await fetch(`${origin}/api/stocks/next-earnings?tickers=${tickers.join(",")}`, { next: { revalidate: 21600 }, signal: AbortSignal.timeout(30_000) });
        if (res.ok) {
          const j = await res.json();
          const lines: string[] = [];
          for (const [t, e] of Object.entries((j.earnings ?? {}) as Record<string, { daysToNext: number | null }>)) {
            if (e.daysToNext !== null && e.daysToNext >= 0 && e.daysToNext <= 7) {
              lines.push(`🗓 ${t}: 決算${e.daysToNext === 0 ? "本日" : `${e.daysToNext}日後`}`);
            }
          }
          if (lines.length > 0) sections.push(["🗓 決算接近 (ボラ警戒)", ...lines].join("\n"));
        }
      }
    }
  } catch {}

  // ── メッセージ組み立て ──
  const header = `☀ Cavka 番頭 — 朝の作戦 (${jstDateKey(new Date()).replace(/^(\d{4})(\d{2})(\d{2})$/, "$2/$3")})`;
  const body =
    sections.length > 0
      ? sections.join("\n\n")
      : "😌 前日から大きな変化なし。平常運転の日です。\n無理にトレードを探さないのも戦略。";
  const footer = "⚠ これは判断材料であり売買指示ではない\n📱 https://quotation-viewer.vercel.app/briefing";
  const message = [header, "", body, "", footer].join("\n");

  if (dry) {
    return NextResponse.json({ ok: true, dry: true, message, sections: sections.length, elapsedMs: Date.now() - startedAt });
  }

  // ── LINE 送信 + 状態記録 ──
  // 何が起きても status を "running" のまま放置しない (done か error を必ず書く)。
  const results: { email: string; sent: boolean; error?: string }[] = [];
  try {
    const emails = (process.env.CAVKA_CRON_EMAILS ?? FALLBACK_EMAIL).split(",").map((e) => e.trim()).filter(Boolean);
    for (const email of emails) {
      const uid = await resolveUidByEmail(email);
      if (!uid) { results.push({ email, sent: false, error: "user not found" }); continue; }
      const tokenSnap = await db.collection("users").doc(uid).collection("settings").doc("lineChannelAccessToken").get();
      const userIdSnap = await db.collection("users").doc(uid).collection("settings").doc("lineUserId").get();
      const token = tokenSnap.exists ? (tokenSnap.data()?.value as string) : null;
      const lineUserId = userIdSnap.exists ? (userIdSnap.data()?.value as string) : null;
      if (!token || !lineUserId) { results.push({ email, sent: false, error: "no LINE credentials in settings" }); continue; }
      const r = await sendLineMessage(token, lineUserId, message);
      results.push({ email, sent: r.ok, error: r.ok ? undefined : r.message });
    }

    await db.collection("meta").doc("cron_status_morning_agent").set({
      status: "done",
      startedAtIso: new Date(startedAt).toISOString(),
      finishedAtIso: new Date().toISOString(),
      sections: sections.length,
      results,
      elapsedMs: Date.now() - startedAt,
    });
    return NextResponse.json({ ok: true, sections: sections.length, results, elapsedMs: Date.now() - startedAt });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    try {
      await db.collection("meta").doc("cron_status_morning_agent").set({
        status: "error",
        startedAtIso: new Date(startedAt).toISOString(),
        finishedAtIso: new Date().toISOString(),
        error: errMsg,
        results,
        elapsedMs: Date.now() - startedAt,
      });
    } catch {}
    return NextResponse.json({ ok: false, error: errMsg, results }, { status: 500 });
  }
}
