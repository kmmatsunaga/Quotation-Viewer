/**
 * 楽天約定 (RakutenFill) を Trade へ組み立てるペアリングロジック。
 *
 * 現物のみ = すべて long。買付でポジションを建て、売付で古い建玉から FIFO 決済する。
 * 部分約定 (同一注文番号で複数通) は 1 レッグに集約 (数量加重平均単価)。
 *
 * 純関数。既存 trades と新規 fills を受け取り「作成すべき Trade」「決済すべき既存 Trade」を返す。
 * Firestore 書き込みは呼び出し側 (client SDK) が行う。
 */

import type { RakutenFill } from "./rakuten-mail";
import type { Trade } from "./firestore";

export type NewTrade = Omit<Trade, "id" | "createdAt" | "updatedAt">;

export interface CloseAction {
  tradeId: string;
  exitPrice: number;
  exitAt: string;
  /** 部分決済で既存建玉を分割した場合の残数量 (undefined = 全決済) */
  reduceToQty?: number;
  appendSourceKeys: string[];
}

export interface AttachAction {
  tradeId: string;
  appendSourceKeys: string[];
}

export interface PairingResult {
  creates: NewTrade[];
  closes: CloseAction[];
  attaches: AttachAction[]; // 既存の手動/warroom トレードにメールキーを付与 (重複回避)
  skipped: number;          // 重複でスキップした fill 数
  imported: number;         // 新規取込 fill 数
}

interface Leg {
  ticker: string;
  name: string;
  side: "buy" | "sell";
  price: number;
  qty: number;
  executedAt: string;
  sourceKeys: string[];
}

/** 内部作業用ポジション */
interface Pos {
  id?: string;              // 既存 Trade の id (無ければ今回新規)
  ticker: string;
  name: string;
  qty: number;
  entryPrice: number;
  entryAt: string;
  reasonTags: string[];
  memo: string;
  sourceKeys: string[];
  // 決済状態
  exitPrice?: number;
  exitAt?: string;
  closedKeys: string[];     // 決済側 fill のキー
  dirty: boolean;           // 既存ポジションで変更が入ったか
  isNew: boolean;
}

/** 同一注文番号の部分約定を 1 レッグに集約 */
function aggregateFills(fills: RakutenFill[]): Leg[] {
  const byOrder = new Map<string, RakutenFill[]>();
  for (const f of fills) {
    const key = `${f.orderNo}|${f.side}|${f.ticker}`;
    (byOrder.get(key) ?? byOrder.set(key, []).get(key)!).push(f);
  }
  const legs: Leg[] = [];
  for (const group of byOrder.values()) {
    const totalQty = group.reduce((s, f) => s + f.qty, 0);
    const notional = group.reduce((s, f) => s + f.price * f.qty, 0);
    const avgPrice = totalQty > 0 ? notional / totalQty : group[0].price;
    // 最も早い約定時刻を代表に
    const executedAt = group.reduce((a, f) => (f.executedAt < a ? f.executedAt : a), group[0].executedAt);
    legs.push({
      ticker: group[0].ticker,
      name: group[0].name,
      side: group[0].side,
      price: Math.round(avgPrice * 10) / 10,
      qty: totalQty,
      executedAt,
      sourceKeys: group.map((f) => f.fillKey),
    });
  }
  legs.sort((a, b) => a.executedAt.localeCompare(b.executedAt));
  return legs;
}

export interface MailHolding {
  ticker: string;
  name: string;
  shares: number;      // 正味保有株数 (買い - 売り)
  avgCost: number;     // 残ロットの加重平均取得単価
  lastDate: string;    // 最新約定日 YYYY-MM-DD
  sourceKeys: string[];
}

/**
 * 全 fill から現在の正味保有 (現物=long のみ) を FIFO で算出する。
 * 買いでロットを積み、売りで古いロットから消す。残ロットの加重平均が取得単価。
 * 当日往復 (日計り) は正味ゼロになり保有に出ない。持ち越しだけが残る。
 */
export function computeMailHoldings(fills: RakutenFill[]): MailHolding[] {
  const byTicker = new Map<string, RakutenFill[]>();
  for (const f of fills) {
    (byTicker.get(f.ticker) ?? byTicker.set(f.ticker, []).get(f.ticker)!).push(f);
  }
  const result: MailHolding[] = [];
  for (const [ticker, fs] of byTicker) {
    fs.sort((a, b) => a.executedAt.localeCompare(b.executedAt));
    const lots: { qty: number; price: number }[] = [];
    let name = fs[0].name;
    const keys: string[] = [];
    for (const f of fs) {
      keys.push(f.fillKey);
      name = f.name;
      if (f.side === "buy") {
        lots.push({ qty: f.qty, price: f.price });
      } else {
        let rem = f.qty;
        while (rem > 0 && lots.length > 0) {
          if (lots[0].qty <= rem) {
            rem -= lots[0].qty;
            lots.shift();
          } else {
            lots[0].qty -= rem;
            rem = 0;
          }
        }
      }
    }
    const shares = lots.reduce((s, l) => s + l.qty, 0);
    if (shares > 0) {
      const cost = lots.reduce((s, l) => s + l.qty * l.price, 0);
      result.push({
        ticker,
        name,
        shares,
        avgCost: Math.round((cost / shares) * 10) / 10,
        lastDate: fs[fs.length - 1].executedAt.slice(0, 10),
        sourceKeys: keys,
      });
    }
  }
  return result;
}

export function pairFillsIntoTrades(existing: Trade[], fills: RakutenFill[]): PairingResult {
  // ── 重複排除: 既存 trades の sourceKeys に含まれる fill は無視 ──
  const seen = new Set<string>();
  for (const t of existing) for (const k of t.sourceKeys ?? []) seen.add(k);
  const fresh = fills.filter((f) => !seen.has(f.fillKey));
  const skipped = fills.length - fresh.length;

  const legs = aggregateFills(fresh);

  // ── 既存のオープン建玉 (現物=long) を作業ポジションに ──
  const positions: Pos[] = existing
    .filter((t) => t.status === "open" && t.side === "long")
    .map((t) => ({
      id: t.id,
      ticker: t.ticker,
      name: t.name,
      qty: t.qty,
      entryPrice: t.entryPrice,
      entryAt: t.entryAt,
      reasonTags: t.reasonTags ?? [],
      memo: t.memo ?? "",
      sourceKeys: t.sourceKeys ?? [],
      closedKeys: [],
      dirty: false,
      isNew: false,
    }))
    .sort((a, b) => a.entryAt.localeCompare(b.entryAt)); // FIFO

  const createdClosed: Pos[] = []; // 今回のバッチ内で建てて決済まで済んだもの

  for (const leg of legs) {
    if (leg.side === "buy") {
      positions.push({
        ticker: leg.ticker,
        name: leg.name,
        qty: leg.qty,
        entryPrice: leg.price,
        entryAt: leg.executedAt,
        reasonTags: [],
        memo: "楽天約定メールより自動取込",
        sourceKeys: [...leg.sourceKeys],
        closedKeys: [],
        dirty: false,
        isNew: true,
      });
      continue;
    }

    // sell: FIFO で同一 ticker のオープン建玉を決済
    let remaining = leg.qty;
    while (remaining > 0) {
      const idx = positions.findIndex((p) => p.ticker === leg.ticker && p.exitPrice === undefined);
      if (idx === -1) break; // 対応する建玉が無い (取込前の買い等) → 諦める
      const pos = positions[idx];

      if (leg.qty >= pos.qty && remaining >= pos.qty) {
        // 建玉を丸ごと決済
        pos.exitPrice = leg.price;
        pos.exitAt = leg.executedAt;
        pos.closedKeys.push(...leg.sourceKeys);
        pos.dirty = true;
        remaining -= pos.qty;
        if (pos.isNew) {
          createdClosed.push(pos);
          positions.splice(idx, 1);
        }
      } else {
        // 部分決済: 売数量 < 建玉数量 → 建玉を分割 (決済分 + 残オープン分)
        const soldQty = remaining;
        const closedPortion: Pos = {
          ...pos,
          id: undefined,      // 分割した決済分は常に新規 closed Trade
          qty: soldQty,
          exitPrice: leg.price,
          exitAt: leg.executedAt,
          sourceKeys: [...pos.sourceKeys],
          closedKeys: [...leg.sourceKeys],
          dirty: true,
          isNew: true,
        };
        createdClosed.push(closedPortion);
        // 元建玉を縮小
        pos.qty -= soldQty;
        pos.dirty = true;
        remaining = 0;
      }
    }
  }

  // ── アクションへ変換 ──
  const creates: NewTrade[] = [];
  const closes: CloseAction[] = [];

  const toNewTrade = (p: Pos): NewTrade => {
    const closed = p.exitPrice !== undefined;
    const diff = closed ? p.exitPrice! - p.entryPrice : 0;
    return {
      ticker: p.ticker,
      name: p.name,
      market: "JP",
      side: "long",
      qty: p.qty,
      entryPrice: p.entryPrice,
      entryAt: p.entryAt,
      exitPrice: closed ? p.exitPrice! : null,
      exitAt: closed ? p.exitAt! : null,
      status: closed ? "closed" : "open",
      pnl: closed ? Math.round(diff * p.qty) : null,
      pnlPct: closed && p.entryPrice > 0 ? Math.round((diff / p.entryPrice) * 10000) / 100 : null,
      reasonTags: p.reasonTags,
      memo: p.memo,
      source: "mail",
      sourceKeys: [...p.sourceKeys, ...p.closedKeys],
    };
  };

  // 新規に建てて未決済のまま残った建玉
  for (const p of positions) {
    if (p.isNew && p.exitPrice === undefined) creates.push(toNewTrade(p));
    // 既存建玉が部分決済で縮小 or 全決済された
    if (!p.isNew && p.dirty) {
      if (p.exitPrice !== undefined) {
        closes.push({
          tradeId: p.id!,
          exitPrice: p.exitPrice,
          exitAt: p.exitAt!,
          appendSourceKeys: p.closedKeys,
        });
      } else {
        // 部分決済で数量だけ減った (残オープン)
        closes.push({
          tradeId: p.id!,
          exitPrice: 0,
          exitAt: "",
          reduceToQty: p.qty,
          appendSourceKeys: [],
        });
      }
    }
  }
  // 今回のバッチ内で建てて決済まで済んだもの
  for (const p of createdClosed) creates.push(toNewTrade(p));

  // ── 既存の手動/warroom トレードとの突合 (重複回避) ──
  // メール由来キーを持たない既存トレードと ticker+建値+数量+建て日 が一致すれば、
  // 新規作成せず既存にキーだけ付与する (手動で付けた根拠タグを温存)。
  const sameDay = (a: string, b: string) => a.slice(0, 10) === b.slice(0, 10);
  const hasMailKey = (t: Trade) => (t.sourceKeys ?? []).some((k) => k.startsWith("rk:"));
  const usedIds = new Set<string>();
  const attaches: AttachAction[] = [];
  const finalCreates: NewTrade[] = [];

  for (const c of creates) {
    const match = existing.find(
      (t) =>
        !!t.id &&
        !usedIds.has(t.id) &&
        !hasMailKey(t) &&
        t.ticker === c.ticker &&
        t.side === "long" &&
        t.qty === c.qty &&
        c.entryPrice > 0 &&
        Math.abs(t.entryPrice - c.entryPrice) / c.entryPrice < 0.005 &&
        sameDay(t.entryAt, c.entryAt),
    );
    if (match) {
      usedIds.add(match.id!);
      attaches.push({ tradeId: match.id!, appendSourceKeys: c.sourceKeys ?? [] });
    } else {
      finalCreates.push(c);
    }
  }

  return { creates: finalCreates, closes, attaches, skipped, imported: fresh.length };
}
