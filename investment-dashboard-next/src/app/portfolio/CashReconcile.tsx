"use client";

/**
 * 💴 預り金の検算パネル
 *
 * 2026-08-03 に発覚した不整合への対策:
 *   ・保存されていた残高 863,129円 に対し、取引履歴からの計算値は 556,589円
 *   ・差額 306,540円 は「記録はされたが残高に反映されなかった買付+出金」と一致
 *   ・原因は画面 state の古い残高を上書きしていたこと (修正済み)
 *   ・さらに楽天メール取込の買付は取引記録も現金減算も作らないため、
 *     取引履歴からの計算値もまた実態とは一致しない
 *
 * そこで「黙って合わせる」のではなく、3つの数字を並べて食い違いを見せる。
 * 合わせ方も本人に選ばせる (証券口座の実額を正とするのが最も確実)。
 */

import { useMemo, useState } from "react";
import type { Transaction, AccountBalance, Holding } from "@/lib/firestore";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };
const yen = (v: number) => `${Math.round(v).toLocaleString("ja-JP")}円`;

export interface CashReconcileProps {
  balance: AccountBalance;
  transactions: Transaction[];
  holdings: Holding[];
  onAdjust: (actualCashJpy: number, diff: number) => Promise<void>;
}

export default function CashReconcile({ balance, transactions, holdings, onAdjust }: CashReconcileProps) {
  const [open, setOpen] = useState(false);
  const [actual, setActual] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const calc = useMemo(() => {
    let fromTx = 0;
    const byType: Record<string, { n: number; amt: number }> = {};
    for (const t of transactions) {
      if (t.currency === "USD") continue;
      const amt = Number(t.amount ?? 0);
      const e = byType[t.type] ?? { n: 0, amt: 0 };
      e.n++; e.amt += amt; byType[t.type] = e;
      if (t.type === "buy") fromTx -= amt;
      else if (t.type === "sell" || t.type === "deposit" || t.type === "dividend") fromTx += amt;
      else if (t.type === "withdraw") fromTx -= amt;
    }
    // 取引記録が存在しない保有 (メール取込など) — 買付代金が現金から引かれていない
    const txTickers = new Set(transactions.filter((t) => t.type === "buy").map((t) => t.ticker));
    const untracked = holdings.filter((h) => h.market !== "US" && !txTickers.has(h.ticker));
    const untrackedCost = untracked.reduce((s, h) => s + h.shares * h.avgCost, 0);
    return {
      fromTx,
      byType,
      diff: balance.cashJpy - fromTx,
      untracked,
      untrackedCost,
    };
  }, [transactions, holdings, balance.cashJpy]);

  const hasIssue = Math.abs(calc.diff) >= 1 || calc.untracked.length > 0;
  if (!hasIssue) return null;

  const submit = async () => {
    const v = Number(actual);
    if (!isFinite(v) || v < 0) { setMsg("金額を正しく入力してください"); return; }
    setBusy(true);
    try {
      await onAdjust(v, v - balance.cashJpy);
      setMsg(`預り金を ${yen(v)} に修正し、差額を調整記録として残しました`);
      setActual("");
    } catch (e) {
      setMsg(`失敗しました: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg" style={{ background: "rgba(250,204,21,0.06)", border: "1px solid #facc15" }}>
      <button onClick={() => setOpen((v) => !v)} className="w-full text-left px-4 py-2.5">
        <span className="text-[12px] font-bold" style={{ color: "#facc15" }}>
          ⚠ 預り金の記録に食い違いがあります
        </span>
        <span className="ml-2 text-[11px] text-[var(--color-text-secondary)]" style={MONO}>
          {open ? "▼" : "▶"} 詳細と修正
        </span>
      </button>

      {open && (
        <div className="px-4 pb-3 space-y-3">
          <div className="space-y-1 text-[12px]">
            <Row label="いま表示している預り金" value={yen(balance.cashJpy)} />
            <Row label="取引履歴から計算した預り金" value={yen(calc.fromTx)} sub="入金 − 出金 − 買付 + 売却" />
            <Row label="差額" value={yen(calc.diff)} highlight={Math.abs(calc.diff) >= 1} />
          </div>

          {calc.untracked.length > 0 && (
            <div className="text-[11px] leading-relaxed rounded px-2.5 py-2" style={{ background: "rgba(0,0,0,0.2)" }}>
              <b>取引記録の無い保有が {calc.untracked.length}件</b> あります (取得額 合計 {yen(calc.untrackedCost)})。
              <div className="mt-0.5 text-[var(--color-text-secondary)]" style={MONO}>
                {calc.untracked.map((h) => `${h.ticker} ${h.name}`).join(" / ")}
              </div>
              <div className="mt-1 text-[var(--color-text-secondary)]">
                楽天の約定メールから自動反映された保有は、取引記録と預り金の減算を作りません。
                そのため「買ったのに現金が減らない」状態になり、総資産が実態より大きく見えます。
              </div>
            </div>
          )}

          <div className="rounded px-2.5 py-2" style={{ background: "rgba(0,240,255,0.04)", border: "1px solid rgba(0,240,255,0.15)" }}>
            <div className="text-[11px] mb-1.5">
              <b>証券口座の実際の預り金</b>を入力してください。差額は「残高調整」として取引履歴に記録します
              (黙って書き換えず、あとから追えるようにするため)。
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={actual}
                onChange={(e) => { setActual(e.target.value); setMsg(null); }}
                placeholder={String(Math.round(calc.fromTx))}
                className="bg-transparent border-b border-[var(--color-border)] px-1 py-1 text-[12px] outline-none w-40"
                style={MONO}
              />
              <span className="text-[11px] text-[var(--color-text-secondary)]">円</span>
              <button
                onClick={submit}
                disabled={busy || actual === ""}
                className="px-3 py-1.5 text-[11px] font-bold rounded"
                style={{ background: "#facc15", color: "#001", opacity: busy || actual === "" ? 0.5 : 1, ...MONO }}
              >
                {busy ? "修正中…" : "この金額に修正"}
              </button>
              <button
                onClick={() => setActual(String(Math.round(calc.fromTx)))}
                className="px-2 py-1.5 text-[10px] rounded"
                style={{ color: "var(--color-accent)", border: "1px solid var(--color-border)", ...MONO }}
              >
                取引履歴の値を使う
              </button>
            </div>
            {msg && <div className="mt-1.5 text-[11px]" style={{ color: "#22c55e" }}>{msg}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[var(--color-text-secondary)]">
        {label}
        {sub && <span className="ml-1 text-[10px] opacity-70">({sub})</span>}
      </span>
      <span className="tabular-nums font-bold" style={{ ...MONO, color: highlight ? "#facc15" : "var(--color-text)" }}>
        {value}
      </span>
    </div>
  );
}
