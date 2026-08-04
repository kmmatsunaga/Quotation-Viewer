import { NextRequest, NextResponse } from "next/server";
import { getAdminDb, resolveUidByEmail } from "@/lib/firebase-admin";
import { sendLineMessage } from "@/lib/line-notify";
import { getCronOrigin } from "@/lib/cron-origin";

/**
 * GET /api/cron/evening-preview — 🌙 明日の候補 (第一陣)
 *
 * 引け後に翌営業日ぶんの候補を生成して LINE に届ける。
 * 朝 07:00 の生成と【同じ入力・同じ結果】になる:
 *   日本市場は 15:30 に閉まり、候補生成は前日引け値ベースの
 *   daily_features (17:00 更新) と score_rankings (17:30 更新) しか見ていない。
 *   米国市場もニュースも入力に含まれないため、夜に出しても中身は変わらない。
 *
 * ⚠ 位置づけ (2026-08-04 の実測に基づく):
 *   「早く買うため」ではなく「前夜に落ち着いて調べるため」。
 *   候補の翌朝ギャップは 平均+0.06% / 中央値0% / 市場平均に対しては-0.05% (t=-2.0)。
 *   +2%以上で寄るのが5.4%、-2%以下で寄るのも5.0% とほぼ対称。
 *   つまり前日に買っても平均的な優位はない。文面でもそれを明示する。
 *
 * 実行: 平日 JST 17:45 (daily-features 17:00 → score-rankings 17:30 の後)
 */

const CRON_SECRET = process.env.CRON_SECRET;
const FALLBACK_EMAIL = "make.some.noise6984@gmail.com";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** 次の営業日 (土日はスキップ。祝日は考慮しない — 休場なら翌朝の生成が上書きする) */
function nextBusinessDay(from: Date): string {
  const d = new Date(from.getTime() + 9 * 3600 * 1000); // JST
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

interface Pick { ticker: string; name: string; score: number; reasons: string[]; caution: string | null }

function buildMessage(dateStr: string, horizons: Record<string, Pick[]>): string {
  const lines: string[] = [`🌙 明日 (${dateStr}) の候補 — 第一陣`, ""];
  const sections: [string, string][] = [
    ["short", "⚡短期"], ["mid", "🌱中期"], ["long", "🏔長期"], ["kiyohara", "🏔清原式"],
  ];
  for (const [key, label] of sections) {
    const list = horizons[key] ?? [];
    if (list.length === 0) continue;
    lines.push(`${label} (${list.length}件)`);
    for (const p of list.slice(0, 5)) {
      lines.push(`  ${p.name} (${p.ticker})`);
      if (p.reasons?.[0]) lines.push(`    ${p.reasons[0]}`);
    }
    if (list.length > 5) lines.push(`  ほか${list.length - 5}件`);
    lines.push("");
  }
  lines.push(
    "──────────",
    "※ これは「今晩買うため」の通知ではありません。",
    "候補の翌朝の寄りは平均+0.06%・中央値0%で、",
    "前日に買う優位は実測されていません",
    "(+2%以上で寄るのが5.4%、-2%以下も5.0%)。",
    "落ち着いて材料を確認する時間のための第一陣です。",
    "明朝、更新があれば第二陣をお送りします。",
  );
  return lines.join("\n");
}

export async function GET(req: NextRequest) {
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const authHeader = req.headers.get("authorization");
  if (!dry && CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const origin = getCronOrigin(req);
  const db = getAdminDb();
  const targetDate = nextBusinessDay(new Date());
  const emails = (process.env.CAVKA_CRON_EMAILS ?? FALLBACK_EMAIL).split(",").map((e) => e.trim()).filter(Boolean);
  const results: Record<string, unknown>[] = [];

  for (const email of emails) {
    try {
      const uid = await resolveUidByEmail(email);
      if (!uid) { results.push({ email, ok: false, error: "user not found" }); continue; }

      // 候補生成 (翌営業日ぶん・第一陣として保存)
      const genRes = await fetch(
        `${origin}/api/agent/daily-recommend?email=${encodeURIComponent(email)}&for=${targetDate}&wave=evening`,
        { method: "POST", headers: { "x-api-key": process.env.MCP_API_KEY ?? "" }, signal: AbortSignal.timeout(240_000) },
      );
      if (!genRes.ok) {
        results.push({ email, ok: false, error: `generate failed: ${genRes.status}` });
        continue;
      }
      const gen = await genRes.json();
      const horizons = (gen.horizons ?? {}) as Record<string, Pick[]>;
      const total = Object.values(horizons).reduce((s, l) => s + (l?.length ?? 0), 0);
      if (total === 0) {
        results.push({ email, ok: true, note: "候補ゼロ — 通知しません", targetDate });
        continue;
      }

      const message = buildMessage(targetDate, horizons);
      let sent = false;
      if (!dry) {
        const settings = (await db.collection("users").doc(uid).collection("settings").doc("line").get()).data();
        const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
        const lineUserId = (settings?.userId as string) ?? process.env.LINE_USER_ID;
        if (token && lineUserId) {
          const r = await sendLineMessage(token, lineUserId, message);
          sent = r.ok;
        }
      }
      results.push({ email, ok: true, targetDate, counts: Object.fromEntries(Object.entries(horizons).map(([k, v]) => [k, v?.length ?? 0])), lineSent: sent, ...(dry ? { message } : {}) });
    } catch (e) {
      results.push({ email, ok: false, error: (e as Error).message });
    }
  }

  return NextResponse.json({ ok: true, targetDate, results });
}
