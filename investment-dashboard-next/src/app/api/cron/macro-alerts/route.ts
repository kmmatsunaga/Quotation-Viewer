import { NextRequest, NextResponse } from "next/server";
import { getAdminDb, resolveUidByEmail, collectUserTickers } from "@/lib/firebase-admin";
import { sendLineMessage } from "@/lib/line-notify";
import { getCronOrigin } from "@/lib/cron-origin";
import { ALL_SECTORS, MACRO_DRIVER_LABELS } from "@/lib/jp-themes";
import { detectTransitions, type MacroSnapshot, type Transition } from "@/lib/macro-transitions";

/**
 * GET /api/cron/macro-alerts
 *
 * 日次マクロ予兆アラート (連携の完成形)
 *   1. 当日のマクロスナップショット (FRED + 半導体 + BOJ) を取得
 *   2. 前日スナップショットを meta/macro_fred_watch_history/{yesterday} から取得
 *   3. 状態遷移を検知 (例: semi boom→peak、BOJ 据置→利上げ寄り、FRB 利上げ→利下げ寄り)
 *   4. 遷移ごとに影響を受けるセクター (macroDrivers) → ポートフォリオ/お気に入り銘柄を突合
 *   5. 該当銘柄を LINE で通知 + Firestore に通知済記録
 *
 * 毎朝 JST 07:00 (UTC 22:00) に実行 (米市場引け後 ~ 日本市場前)。
 *
 * 認証: Vercel Cron は Authorization: Bearer ${CRON_SECRET}
 */

const CRON_SECRET = process.env.CRON_SECRET;
const FALLBACK_EMAIL = "make.some.noise6984@gmail.com";

export const maxDuration = 120;

interface AlertItem {
  ticker: string;
  name: string;
  sectorEmoji: string;
  sectorName: string;
  transitions: Transition[];
  notifyKey: string;           // 重複防止用
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const origin = getCronOrigin(req);
  const db = getAdminDb();
  const startedAt = Date.now();

  // 1. 今日のマクロを取得 (fred-watch のキャッシュ経由でも、fresh でも可)
  let todaySnap: MacroSnapshot;
  try {
    const res = await fetch(`${origin}/api/macro/fred-watch`);
    if (!res.ok) return NextResponse.json({ ok: false, error: `fred-watch HTTP ${res.status}` }, { status: 500 });
    const j = await res.json();
    if (!j.ok) return NextResponse.json({ ok: false, error: j.error ?? "fred-watch failed" }, { status: 500 });
    todaySnap = {
      fedPolicy: j.fedPolicy,
      recession: j.recession,
      fx: j.fx,
      oil: j.oil,
      china: j.china,
      semi: j.semi,
      bojPolicy: j.bojPolicy,
    };
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  // 2. 履歴アーカイブ
  const todayKey = jstDateKey(new Date());
  const yesterdayKey = jstDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
  await db.collection("meta").doc(`macro_fred_watch_history_${todayKey}`).set({
    ...todaySnap,
    date: todayKey,
    savedAtIso: new Date().toISOString(),
  });

  // 3. 前日スナップショットを読む
  const ySnap = await db.collection("meta").doc(`macro_fred_watch_history_${yesterdayKey}`).get();
  const yData = ySnap.exists ? (ySnap.data() as Partial<MacroSnapshot>) : null;

  // 4. 状態遷移検知
  const transitions = detectTransitions(yData, todaySnap);

  // 履歴アーカイブだけして終了 (前日データがない初回 or 遷移なし)
  if (transitions.length === 0) {
    return NextResponse.json({
      ok: true,
      mode: yData ? "no-transitions" : "first-snapshot",
      todayKey,
      yesterdayKey,
      results: [],
      elapsedMs: Date.now() - startedAt,
    });
  }

  // 5. 影響を受ける driver の集合を求める
  const activeDriversToday = new Set(transitions.map((t) => t.driver));

  // 6. ユーザーごとにポートフォリオ + favorites を突合
  const emailsRaw = process.env.CAVKA_CRON_EMAILS ?? FALLBACK_EMAIL;
  const emails = emailsRaw.split(",").map((e) => e.trim()).filter(Boolean);
  const results: { email: string; sent: boolean; items: number; error?: string }[] = [];

  for (const email of emails) {
    try {
      // users doc に email フィールドは無いので Auth 経由で uid 解決
      const uid = await resolveUidByEmail(email);
      if (!uid) {
        results.push({ email, sent: false, items: 0, error: "user not found (auth)" });
        continue;
      }

      {
        // LINE トークンは users/{uid}/settings サブコレクションに格納されている
        const tokenSnap = await db.collection("users").doc(uid).collection("settings").doc("lineChannelAccessToken").get();
        const userIdSnap = await db.collection("users").doc(uid).collection("settings").doc("lineUserId").get();
        const channelAccessToken = tokenSnap.exists ? (tokenSnap.data()?.value as string | undefined) : undefined;
        const lineUserId = userIdSnap.exists ? (userIdSnap.data()?.value as string | undefined) : undefined;

        // お気に入り (watchlist) + 保有 (holdings)
        const tickerSet = new Set<string>(
          (await collectUserTickers(uid)).filter((t) => /^\d{3,4}[A-Z]?$/.test(t))
        );
        if (tickerSet.size === 0) continue;

        // 通知済記録
        const notifiedSnap = await db.collection("users").doc(uid).collection("alertNotified").get();
        const notifiedSet = new Set(notifiedSnap.docs.map((d) => d.id));

        // jp 株マスタ (名前解決用)
        const stockMaster = await db.collection("meta").doc("jpStockMaster").get();
        const nameByTicker = new Map<string, string>();
        const stocks = (stockMaster.data()?.stocks as { ticker: string; name: string }[]) ?? [];
        for (const s of stocks) nameByTicker.set(s.ticker, s.name);

        // 各 ticker について「所属セクターの macroDriver と今日の遷移」が交差するか確認
        const alertItems: AlertItem[] = [];
        for (const ticker of tickerSet) {
          const sectors = ALL_SECTORS.filter((s) => s.tickers.includes(ticker));
          for (const sector of sectors) {
            const matched = sector.macroDrivers.filter((d) => activeDriversToday.has(d));
            if (matched.length === 0) continue;
            const tx = transitions.filter((t) => matched.includes(t.driver));
            // 通知キー: 日次 + driver セット + ticker (同日同遷移は重複通知しない)
            const notifyKey = `macro_${todayKey}_${ticker}_${sector.id}_${tx.map((t) => t.driver).sort().join("-")}`;
            if (notifiedSet.has(notifyKey)) continue;
            alertItems.push({
              ticker,
              name: nameByTicker.get(ticker) ?? ticker,
              sectorEmoji: sector.emoji,
              sectorName: sector.name,
              transitions: tx,
              notifyKey,
            });
          }
        }

        if (alertItems.length === 0) {
          results.push({ email, sent: false, items: 0, error: "no fresh transitions matching portfolio" });
          continue;
        }

        // LINE 送信
        if (channelAccessToken && lineUserId) {
          const message = buildMessage(transitions, alertItems);
          const sendResult = await sendLineMessage(channelAccessToken, lineUserId, message);
          if (sendResult.ok) {
            const batch = db.batch();
            for (const item of alertItems) {
              const ref = db.collection("users").doc(uid).collection("alertNotified").doc(item.notifyKey);
              batch.set(ref, {
                type: "macro",
                ticker: item.ticker,
                drivers: item.transitions.map((t) => t.driver),
                date: todayKey,
                notifiedAt: new Date(),
              });
            }
            await batch.commit();
            results.push({ email, sent: true, items: alertItems.length });
          } else {
            results.push({ email, sent: false, items: alertItems.length, error: sendResult.message });
          }
        } else {
          results.push({ email, sent: false, items: alertItems.length, error: "no LINE credentials" });
        }
      }
    } catch (err) {
      results.push({ email, sent: false, items: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({
    ok: true,
    todayKey,
    yesterdayKey,
    transitions: transitions.length,
    transitionList: transitions,
    results,
    elapsedMs: Date.now() - startedAt,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function jstDateKey(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function buildMessage(transitions: Transition[], items: AlertItem[]): string {
  const lines: string[] = [`📡 Cavka マクロ予兆アラート`, ""];

  // 遷移サマリ
  lines.push(`【検出された遷移 ${transitions.length}件】`);
  for (const t of transitions) {
    lines.push(`${t.emoji} ${t.message}`);
  }
  lines.push("");

  // 影響を受ける銘柄
  lines.push(`【影響を受ける保有銘柄 ${items.length}件】`);

  // ticker でグルーピング (1銘柄が複数セクター/driver にまたがる場合)
  const byTicker = new Map<string, AlertItem[]>();
  for (const it of items) {
    if (!byTicker.has(it.ticker)) byTicker.set(it.ticker, []);
    byTicker.get(it.ticker)!.push(it);
  }
  for (const [ticker, list] of byTicker) {
    const name = list[0].name;
    lines.push(`▸ ${ticker} ${name}`);
    for (const it of list) {
      const drivers = it.transitions.map((t) => MACRO_DRIVER_LABELS[t.driver] ?? t.driver).join(" / ");
      lines.push(`    ${it.sectorEmoji} ${it.sectorName}: ${drivers}`);
    }
  }
  lines.push("");
  lines.push(`📱 詳細: https://quotation-viewer.vercel.app/macro-watch`);
  return lines.join("\n");
}
