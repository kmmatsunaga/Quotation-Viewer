"use client";

/**
 * /earnings-guard — 🛡 決算またぎの判断支援
 *
 * 設計思想 (2026-07 116決算イベントの実証に基づく):
 *   - 跨いだ瞬間の「方向」は予測できない (イベントリスク)。予測できるのは「変動の大きさ」だけ
 *   - だからこれは方向を当てる装置ではなく、リスクを測って持ち高を調整する装置
 *   - 「この銘柄は過去の決算で平均±X%動いた。今の持ち高だと想定損失¥Y = 総資産のZ%。
 *      リスクルール (1.5%) を超える分は決算前に減らす」
 *   - 跨いだ後のドリフト (PEAD: 上振れ後は追い風) は弱い傾向として参考表示に留める
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { getAccountBalance, getHoldings, type Holding } from "@/lib/firestore";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };
const UP = "var(--color-up)";
const DANGER = "#ef4444";
const RISK_PCT = 1.5; // 1イベントの許容リスク (総資産%)
const HORIZON_DAYS = 21; // この日数以内の決算を「接近」とみなす

interface EarningsEventLite {
  date: string;
  dayOf: number | null;
  post7d: number | null;
  surprisePercent: number | null;
}

interface GuardRow {
  holding: Holding;
  price: number | null;          // 現在値
  daysToNext: number | null;
  nextDate: string | null;
  events: EarningsEventLite[];
  expMovePct: number | null;     // 過去の |当日反応| 平均
  worstMovePct: number | null;   // 過去の最大逆風 (最小 dayOf)
  posValue: number | null;
  expLoss: number | null;        // 想定変動での損失額
  worstLoss: number | null;
  keepShares: number | null;     // 1.5%ルール内に収まる株数
  verdict: "ok" | "trim" | "danger" | "unknown";
  peadNote: string | null;
}

export default function EarningsGuardPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [rows, setRows] = useState<GuardRow[] | null>(null);
  const [totalAssets, setTotalAssets] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [noEarnings, setNoEarnings] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [bal, holdings] = await Promise.all([getAccountBalance(user.uid), getHoldings(user.uid)]);
      const jpHoldings = holdings.filter((h) => /^\d{3,4}[A-Z0-9]?$/.test(h.ticker));
      const assets = bal.cashJpy + holdings.reduce((s, h) => s + h.shares * h.avgCost, 0);
      setTotalAssets(assets);
      if (jpHoldings.length === 0) { setRows([]); return; }

      // 現在値 + 次回決算日 (バッチ)
      const tickers = jpHoldings.map((h) => h.ticker).join(",");
      const [pricesRes, nextRes] = await Promise.all([
        fetch(`/api/stocks/prices?tickers=${tickers}`).then((r) => r.json()).catch(() => ({})),
        fetch(`/api/stocks/next-earnings?tickers=${tickers}`).then((r) => r.json()).catch(() => ({})),
      ]);
      const prices = pricesRes.prices ?? {};
      const earnings = nextRes.earnings ?? {};

      const riskBudget = (RISK_PCT / 100) * assets;
      const out: GuardRow[] = [];
      const skipped: string[] = [];

      for (const h of jpHoldings) {
        const daysToNext: number | null = earnings[h.ticker]?.daysToNext ?? null;
        const nextDate: string | null = earnings[h.ticker]?.date ?? null;
        if (daysToNext === null || daysToNext < 0 || daysToNext > HORIZON_DAYS) {
          skipped.push(`${h.name || h.ticker}${daysToNext !== null && daysToNext > HORIZON_DAYS ? ` (${daysToNext}日後)` : " (予定不明)"}`);
          continue;
        }
        // 過去の決算反応
        let events: EarningsEventLite[] = [];
        try {
          const ep = await fetch(`/api/stocks/earnings-pattern?ticker=${h.ticker}`).then((r) => r.json());
          events = (ep.events ?? []).map((e: EarningsEventLite) => ({
            date: e.date, dayOf: e.dayOf, post7d: e.post7d, surprisePercent: e.surprisePercent,
          }));
        } catch {}

        const dayOfs = events.map((e) => e.dayOf).filter((v): v is number => v !== null);
        const expMovePct = dayOfs.length > 0 ? dayOfs.reduce((s, v) => s + Math.abs(v), 0) / dayOfs.length : null;
        const worstMovePct = dayOfs.length > 0 ? Math.min(...dayOfs) : null; // 最大の下落
        const price = prices[h.ticker]?.price ?? null;
        const posValue = price !== null ? price * h.shares : null;
        const expLoss = posValue !== null && expMovePct !== null ? (expMovePct / 100) * posValue : null;
        const worstLoss = posValue !== null && worstMovePct !== null ? Math.abs(Math.min(0, worstMovePct) / 100) * posValue : null;
        // 1.5%ルール内に収まる株数 (想定変動ベース)
        const keepShares = price !== null && expMovePct !== null && expMovePct > 0
          ? Math.floor(riskBudget / (price * (expMovePct / 100)))
          : null;

        let verdict: GuardRow["verdict"] = "unknown";
        if (expLoss !== null) {
          if (expLoss <= riskBudget && (worstLoss === null || worstLoss <= riskBudget * 1.6)) verdict = "ok";
          else if (expLoss <= riskBudget) verdict = "trim";
          else verdict = "danger";
        }

        // PEAD 参考: 過去にサプライズ+が多く、その後7日が伸びる傾向なら一言
        const posSurp = events.filter((e) => (e.surprisePercent ?? 0) > 0);
        const posDrift = posSurp.map((e) => e.post7d).filter((v): v is number => v !== null);
        const peadNote =
          posSurp.length >= 3 && posDrift.length >= 3 && posDrift.filter((v) => v > 0).length / posDrift.length >= 0.7
            ? `参考: 過去${posSurp.length}回中、上振れ後の7日は伸びる傾向 (弱い追い風)`
            : null;

        out.push({ holding: h, price, daysToNext, nextDate, events, expMovePct, worstMovePct, posValue, expLoss, worstLoss, keepShares, verdict, peadNote });
      }
      out.sort((a, b) => (a.daysToNext ?? 99) - (b.daysToNext ?? 99));
      setRows(out);
      setNoEarnings(skipped);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const riskBudget = totalAssets !== null ? (RISK_PCT / 100) * totalAssets : null;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">🛡 決算またぎ</h1>
        <p className="text-[14px] text-[var(--color-text-secondary)] mt-1.5 leading-relaxed">
          決算の方向は誰にも当てられない。当てられるのは「どれくらい動くか」だけ。
          過去の決算反応から想定変動を測り、リスクルールを超える分だけ減らす。
        </p>
        {riskBudget !== null && (
          <p className="text-[12px] text-[var(--color-text-secondary)] mt-1" style={MONO}>
            許容リスク: 1決算あたり 総資産の{RISK_PCT}% = ¥{Math.round(riskBudget).toLocaleString()}
          </p>
        )}
      </div>

      {loading ? (
        <div className="text-center py-16 text-[15px] text-[var(--color-text-secondary)]">保有銘柄の決算日を確認中...</div>
      ) : !rows || rows.length === 0 ? (
        <div className="p-6 border text-center" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
          <div className="text-4xl mb-2">😌</div>
          <div className="text-[15px] text-[var(--color-text)]">今後{HORIZON_DAYS}日以内に決算を迎える保有銘柄はありません。</div>
          {noEarnings.length > 0 && (
            <div className="text-[12px] text-[var(--color-text-secondary)] mt-2">対象外: {noEarnings.join(" / ")}</div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => <GuardCard key={r.holding.ticker} r={r} riskBudget={riskBudget} onOpen={() => router.push(`/stock/${r.holding.ticker}`)} />)}
          {noEarnings.length > 0 && (
            <div className="text-[11px] text-[var(--color-text-secondary)] opacity-70">決算が{HORIZON_DAYS}日超先 or 不明: {noEarnings.join(" / ")}</div>
          )}
        </div>
      )}

      <div className="text-[11px] text-[var(--color-text-secondary)] opacity-70 leading-relaxed">
        ※ 想定変動は過去の決算当日反応の平均 (サンプルが少ない銘柄は精度が粗い)。<br />
        ※ 「上振れ後は7日ほど追い風」という弱い傾向 (PEAD) はあるが、跨ぐ判断の主役はあくまでリスク量。<br />
        ※ 売買の実行は楽天証券で手動。これは判断材料であり売買指示ではない。
      </div>
    </div>
  );
}

function GuardCard({ r, riskBudget, onOpen }: { r: GuardRow; riskBudget: number | null; onOpen: () => void }) {
  const V = {
    ok: { label: "✅ そのまま跨いでOK", color: "#4ade80", desc: "想定変動は許容リスク内" },
    trim: { label: "⚠ 最悪ケースは超過", color: "#facc15", desc: "平常変動なら許容内だが、過去最大級の下げが来ると超える" },
    danger: { label: "🚨 減らしてから跨ぐ", color: DANGER, desc: "想定変動だけで許容リスクを超えている" },
    unknown: { label: "❓ データ不足", color: "#94a3b8", desc: "過去の決算反応データが取れない (慎重に)" },
  }[r.verdict];

  const h = r.holding;
  const trimTo = r.keepShares !== null ? Math.min(h.shares, Math.max(0, r.keepShares)) : null;

  return (
    <div className="p-4 border space-y-3" style={{ borderColor: `${V.color}66`, background: "var(--bg-card)" }}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <button onClick={onOpen} className="flex items-baseline gap-2 text-left min-w-0">
          <span className="text-[16px] font-bold text-[var(--color-text)] truncate">{h.name || h.ticker}</span>
          <span className="text-[11px] text-[var(--color-accent)]" style={MONO}>{h.ticker}</span>
        </button>
        <span className="text-[13px] font-bold" style={{ color: DANGER, ...MONO }}>
          決算まで {r.daysToNext === 0 ? "本日!" : `${r.daysToNext}日`}{r.nextDate ? ` (${r.nextDate.slice(5)})` : ""}
        </span>
      </div>

      <div className="text-[15px] font-bold" style={{ color: V.color }}>{V.label}</div>
      <div className="text-[12px] text-[var(--color-text-secondary)]">{V.desc}</div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-center" style={MONO}>
        <div className="p-2 border" style={{ borderColor: "var(--color-border)" }}>
          <div className="text-[9px] text-[var(--color-text-secondary)]">持ち高</div>
          <div className="text-[14px] font-bold text-[var(--color-text)]">{h.shares}株</div>
          <div className="text-[10px] text-[var(--color-text-secondary)]">{r.posValue !== null ? `¥${Math.round(r.posValue).toLocaleString()}` : "—"}</div>
        </div>
        <div className="p-2 border" style={{ borderColor: "var(--color-border)" }}>
          <div className="text-[9px] text-[var(--color-text-secondary)]">想定変動 (過去平均)</div>
          <div className="text-[14px] font-bold text-[var(--color-text)]">{r.expMovePct !== null ? `±${r.expMovePct.toFixed(1)}%` : "—"}</div>
          <div className="text-[10px] text-[var(--color-text-secondary)]">最大下落 {r.worstMovePct !== null ? `${r.worstMovePct.toFixed(1)}%` : "—"}</div>
        </div>
        <div className="p-2 border" style={{ borderColor: "var(--color-border)" }}>
          <div className="text-[9px] text-[var(--color-text-secondary)]">想定損失</div>
          <div className="text-[14px] font-bold" style={{ color: r.verdict === "danger" ? DANGER : "var(--color-text)" }}>
            {r.expLoss !== null ? `¥${Math.round(r.expLoss).toLocaleString()}` : "—"}
          </div>
          <div className="text-[10px] text-[var(--color-text-secondary)]">最悪 {r.worstLoss !== null ? `¥${Math.round(r.worstLoss).toLocaleString()}` : "—"}</div>
        </div>
        <div className="p-2 border" style={{ borderColor: "var(--color-border)" }}>
          <div className="text-[9px] text-[var(--color-text-secondary)]">ルール内で持てる株数</div>
          <div className="text-[14px] font-bold" style={{ color: trimTo !== null && trimTo < h.shares ? "#facc15" : "#4ade80" }}>
            {trimTo !== null ? `${trimTo}株` : "—"}
          </div>
          {trimTo !== null && trimTo < h.shares && (
            <div className="text-[10px]" style={{ color: "#facc15" }}>→ {h.shares - trimTo}株 減らす</div>
          )}
        </div>
      </div>

      {/* 過去の決算反応 */}
      {r.events.length > 0 && (
        <div className="flex flex-wrap gap-1.5" style={MONO}>
          <span className="text-[10px] text-[var(--color-text-secondary)] mr-1">過去の当日反応:</span>
          {r.events.slice(0, 6).map((e, i) => (
            <span key={i} className="text-[10px] px-1.5 py-0.5 border" style={{
              borderColor: "var(--color-border)",
              color: e.dayOf === null ? "var(--color-text-secondary)" : e.dayOf >= 0 ? UP : "var(--color-down)",
            }}>
              {e.date.slice(2, 7)}: {e.dayOf !== null ? `${e.dayOf > 0 ? "+" : ""}${e.dayOf.toFixed(1)}%` : "?"}
            </span>
          ))}
        </div>
      )}

      {r.peadNote && <div className="text-[11px] text-[var(--color-text-secondary)]">{r.peadNote}</div>}
      {riskBudget !== null && r.expLoss !== null && (
        <div className="text-[10px] text-[var(--color-text-secondary)] opacity-70" style={MONO}>
          判定: 想定損失 ¥{Math.round(r.expLoss).toLocaleString()} vs 許容 ¥{Math.round(riskBudget).toLocaleString()}
        </div>
      )}
    </div>
  );
}
