/**
 * 楽天約定メール → Cavka 同期 (クライアント共通処理)
 *
 * /journal と /portfolio の両方から呼ぶ。1回の同期で:
 *   - トレードジャーナル (trades): 買い/売りを FIFO ペアリングして記録
 *   - ポートフォリオ (holdings): メール全約定の正味保有を反映 (持ち越しのみ)
 *
 * サーバ (/api/journal/sync-mail) は fills を返すだけ。書き込みは全てここ (client SDK)。
 */

import type { User } from "firebase/auth";
import {
  getTrades, addTrade, updateTrade, computeTradePnl,
  getHoldings, addHolding, updateHolding, deleteHolding,
} from "./firestore";
import { pairFillsIntoTrades, computeMailHoldings, type MailHolding } from "./trade-pairing";
import type { RakutenFill } from "./rakuten-mail";

export interface RakutenSyncResult {
  ok: boolean;
  imported: number;
  skipped: number;
  tradesCreated: number;
  tradesClosed: number;
  tradesAttached: number;
  holdingsUpserted: number;
  holdingsRemoved: number;
  holdings: MailHolding[];   // メール由来の現在の正味保有 (warroom 建玉自動投入用)
  changed: number;
  message: string;
  error?: string;
}

const fail = (message: string, error?: string): RakutenSyncResult => ({
  ok: false, imported: 0, skipped: 0, tradesCreated: 0, tradesClosed: 0,
  tradesAttached: 0, holdingsUpserted: 0, holdingsRemoved: 0, holdings: [], changed: 0, message, error,
});

export async function syncRakutenMail(user: User, sinceDays = 120): Promise<RakutenSyncResult> {
  let fills: RakutenFill[] = [];
  try {
    const idToken = await user.getIdToken();
    const res = await fetch("/api/journal/sync-mail", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ sinceDays }),
    });
    const data = await res.json();
    if (!res.ok) return fail(`同期失敗: ${data.error ?? res.status}`, data.error);
    fills = data.fills ?? [];
  } catch (e) {
    return fail(`同期エラー: ${(e as Error).message}`);
  }

  // ── 1. トレードジャーナル ──
  const currentTrades = await getTrades(user.uid);
  const { creates, closes, attaches, imported, skipped } = pairFillsIntoTrades(currentTrades, fills);
  for (const c of creates) await addTrade(user.uid, c);
  for (const a of attaches) {
    const t = currentTrades.find((x) => x.id === a.tradeId);
    if (t) await updateTrade(user.uid, a.tradeId, { sourceKeys: [...(t.sourceKeys ?? []), ...a.appendSourceKeys] });
  }
  for (const cl of closes) {
    if (cl.reduceToQty !== undefined) {
      await updateTrade(user.uid, cl.tradeId, { qty: cl.reduceToQty });
    } else {
      const t = currentTrades.find((x) => x.id === cl.tradeId);
      if (!t) continue;
      const { pnl, pnlPct } = computeTradePnl(t, cl.exitPrice);
      await updateTrade(user.uid, cl.tradeId, {
        exitPrice: cl.exitPrice, exitAt: cl.exitAt, status: "closed", pnl, pnlPct,
        sourceKeys: [...(t.sourceKeys ?? []), ...cl.appendSourceKeys],
      });
    }
  }

  // ── 2. ポートフォリオ (正味保有) ──
  const mailHoldings = computeMailHoldings(fills);
  const existingH = await getHoldings(user.uid);
  const mailTickers = new Set(mailHoldings.map((h) => h.ticker));
  let holdingsUpserted = 0;
  let holdingsRemoved = 0;

  for (const mh of mailHoldings) {
    const ex = existingH.find((h) => h.ticker === mh.ticker);
    if (ex) {
      const changed =
        ex.shares !== mh.shares ||
        Math.abs((ex.avgCost ?? 0) - mh.avgCost) > 0.05 ||
        ex.source !== "mail";
      if (changed) {
        await updateHolding(user.uid, ex.id!, {
          shares: mh.shares, avgCost: mh.avgCost, source: "mail",
          sourceKeys: mh.sourceKeys, name: ex.name || mh.name, market: ex.market || "JP",
        });
        holdingsUpserted++;
      }
    } else {
      await addHolding(user.uid, {
        ticker: mh.ticker, name: mh.name, shares: mh.shares, avgCost: mh.avgCost,
        market: "JP", memo: "楽天約定メールより自動反映", purchaseDate: mh.lastDate,
        source: "mail", sourceKeys: mh.sourceKeys,
      });
      holdingsUpserted++;
    }
  }
  // メール由来で売り切った保有を削除 (手動保有は触らない)
  for (const ex of existingH) {
    if (ex.source === "mail" && !mailTickers.has(ex.ticker)) {
      await deleteHolding(user.uid, ex.id!);
      holdingsRemoved++;
    }
  }

  const changed = creates.length + closes.length + attaches.length + holdingsUpserted + holdingsRemoved;
  const message =
    changed > 0
      ? `取込${imported}件 → 取引(新規${creates.length}/決済${closes.length}) 保有(更新${holdingsUpserted}/削除${holdingsRemoved})`
      : skipped > 0
        ? `新しい約定はありません (取込済 ${skipped}件)`
        : "約定メールが見つかりません";

  return {
    ok: true, imported, skipped,
    tradesCreated: creates.length, tradesClosed: closes.length, tradesAttached: attaches.length,
    holdingsUpserted, holdingsRemoved, holdings: mailHoldings, changed, message,
  };
}
