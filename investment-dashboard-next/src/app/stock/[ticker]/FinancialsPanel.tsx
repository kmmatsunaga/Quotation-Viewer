"use client";

import { useEffect, useState } from "react";
import CommentaryPanel from "@/components/CommentaryPanel";
import { assessFinancials } from "@/lib/financials-assess";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface AnnualFinancial {
  fiscalYearEnd: string;
  revenue: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  eps: number | null;
  grossProfit: number | null;
  ebitda: number | null;
  totalAssets: number | null;
  totalEquity: number | null;
  totalDebt: number | null;
  cash: number | null;
  operatingCashflow: number | null;
  freeCashflow: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  equityRatio: number | null;
  roe: number | null;
  roa: number | null;
}

interface QuarterlyFinancial {
  quarter: string;
  date: string;
  revenue: number | null;
  netIncome: number | null;
  eps: number | null;
  epsEstimate: number | null;
  surprise: number | null;
}

interface HistoryResp {
  ok: boolean;
  ticker: string;
  currency: string | null;
  annual: AnnualFinancial[];
  quarterly: QuarterlyFinancial[];
  _meta: { annualCount: number; quarterlyCount: number };
}

function formatLarge(n: number | null, currency: string | null): string {
  if (n === null) return "—";
  const abs = Math.abs(n);
  if (currency === "JPY") {
    if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}兆`;
    if (abs >= 1e8) return `${(n / 1e8).toFixed(0)}億`;
    if (abs >= 1e4) return `${(n / 1e4).toFixed(0)}万`;
  } else {
    if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  }
  return n.toLocaleString();
}

function yoyChange(curr: number | null, prev: number | null): { pct: number; color: string } | null {
  if (curr === null || prev === null || prev === 0) return null;
  const pct = ((curr - prev) / Math.abs(prev)) * 100;
  const color = pct >= 10 ? "#22c55e" : pct >= 0 ? "#7fffd4" : pct >= -10 ? "#facc15" : "#fb923c";
  return { pct, color };
}

export default function FinancialsPanel({ ticker }: { ticker: string }) {
  const [data, setData] = useState<HistoryResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"annual" | "quarterly">("annual");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/stocks/history/${encodeURIComponent(ticker)}`)
      .then((r) => r.json())
      .then((j: HistoryResp) => {
        if (cancelled) return;
        if (!j.ok) setError("業績データ取得失敗");
        else setData(j);
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  if (loading) {
    return (
      <div className="p-4 border" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
        <div className="text-xs text-[var(--color-text-secondary)]" style={MONO}>
          // FINANCIALS_HISTORY.LOADING ...
        </div>
      </div>
    );
  }
  if (error || !data || !data.ok) {
    return null; // データ無い銘柄は黙って非表示
  }

  return (
    <div
      className="p-4 border space-y-3"
      style={{ ...MONO, borderColor: "var(--color-border)", background: "var(--bg-card)" }}
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--color-text-secondary)]">
            // FINANCIALS_HISTORY
          </div>
          <div className="text-sm font-bold text-[var(--color-accent)] mt-1">
            📊 業績推移 ({data.currency ?? ""})
          </div>
        </div>
        <div className="flex gap-1">
          {(["annual", "quarterly"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="px-3 py-1 text-[11px]"
              style={{
                border: `1px solid ${tab === t ? "var(--color-accent)" : "var(--color-border)"}`,
                color: tab === t ? "var(--color-accent)" : "var(--color-text-secondary)",
                background: tab === t ? "rgba(0,240,255,0.08)" : "transparent",
              }}
            >
              {t === "annual" ? `年次 (${data.annual.length}年)` : `四半期 (${data.quarterly.length}Q)`}
            </button>
          ))}
        </div>
      </div>

      {/* 📊 業績の温度計 (自動解説) */}
      {(() => {
        const fin = assessFinancials({
          currency: data.currency,
          annual: data.annual.map((a) => ({
            fiscalYearEnd: a.fiscalYearEnd,
            revenue: a.revenue,
            operatingIncome: a.operatingIncome,
            netIncome: a.netIncome,
            operatingMargin: a.operatingMargin,
            netMargin: a.netMargin,
            equityRatio: a.equityRatio,
            roe: a.roe,
            freeCashflow: a.freeCashflow,
          })),
          quarterly: data.quarterly.map((q) => ({
            quarter: q.quarter,
            date: q.date,
            revenue: q.revenue,
            netIncome: q.netIncome,
            surprise: q.surprise,
          })),
        });
        return fin ? <CommentaryPanel title="業績の温度計" c={fin} /> : null;
      })()}

      {tab === "annual" && <AnnualTable annual={data.annual} currency={data.currency} />}
      {tab === "quarterly" && <QuarterlyTable quarterly={data.quarterly} currency={data.currency} />}

      <div className="text-[10px] text-[var(--color-text-secondary)] pt-1 border-t border-[var(--color-border)]">
        出典: Yahoo Finance v10 quoteSummary. 日本株は一部指標 (営業利益・営業利益率等) が欠落することあり。
      </div>
    </div>
  );
}

function AnnualTable({ annual, currency }: { annual: AnnualFinancial[]; currency: string | null }) {
  if (annual.length === 0) {
    return <div className="text-xs text-[var(--color-text-secondary)]">年次データなし</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-[var(--color-text-secondary)] text-[10px] uppercase">
            <th className="text-left py-1.5 pr-2">期末</th>
            <th className="text-right px-2">売上</th>
            <th className="text-right px-2">YoY</th>
            <th className="text-right px-2">営業利益</th>
            <th className="text-right px-2">純利益</th>
            <th className="text-right px-2">YoY</th>
            <th className="text-right px-2">OM%</th>
            <th className="text-right px-2">ROE%</th>
            <th className="text-right px-2">自己資本%</th>
            <th className="text-right px-2">FCF</th>
          </tr>
        </thead>
        <tbody>
          {annual.map((a, i) => {
            const prevRev = i > 0 ? annual[i - 1].revenue : null;
            const prevNi = i > 0 ? annual[i - 1].netIncome : null;
            const yoyRev = yoyChange(a.revenue, prevRev);
            const yoyNi = yoyChange(a.netIncome, prevNi);
            return (
              <tr key={a.fiscalYearEnd} className="border-b border-[var(--color-border)]/30">
                <td className="py-1.5 pr-2 text-[var(--color-accent)]">
                  {a.fiscalYearEnd}
                </td>
                <td className="text-right px-2 text-[var(--color-text)] font-bold">
                  {formatLarge(a.revenue, currency)}
                </td>
                <td className="text-right px-2" style={{ color: yoyRev?.color ?? "var(--color-text-secondary)" }}>
                  {yoyRev ? `${yoyRev.pct >= 0 ? "+" : ""}${yoyRev.pct.toFixed(1)}%` : "—"}
                </td>
                <td className="text-right px-2 text-[var(--color-text)]">
                  {formatLarge(a.operatingIncome, currency)}
                </td>
                <td className="text-right px-2 text-[var(--color-text)] font-bold">
                  {formatLarge(a.netIncome, currency)}
                </td>
                <td className="text-right px-2" style={{ color: yoyNi?.color ?? "var(--color-text-secondary)" }}>
                  {yoyNi ? `${yoyNi.pct >= 0 ? "+" : ""}${yoyNi.pct.toFixed(1)}%` : "—"}
                </td>
                <td className="text-right px-2 text-[var(--color-text-secondary)]">
                  {a.operatingMargin !== null ? `${a.operatingMargin}` : "—"}
                </td>
                <td className="text-right px-2 text-[var(--color-text-secondary)]">
                  {a.roe !== null ? `${a.roe}` : "—"}
                </td>
                <td className="text-right px-2 text-[var(--color-text-secondary)]">
                  {a.equityRatio !== null ? `${a.equityRatio}` : "—"}
                </td>
                <td className="text-right px-2 text-[var(--color-text-secondary)]">
                  {formatLarge(a.freeCashflow, currency)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function QuarterlyTable({ quarterly, currency }: { quarterly: QuarterlyFinancial[]; currency: string | null }) {
  if (quarterly.length === 0) {
    return <div className="text-xs text-[var(--color-text-secondary)]">四半期データなし</div>;
  }
  // 日付順にソート (新しい順)
  const sorted = [...quarterly].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-[var(--color-text-secondary)] text-[10px] uppercase">
            <th className="text-left py-1.5 pr-2">四半期</th>
            <th className="text-left px-2">期末</th>
            <th className="text-right px-2">売上</th>
            <th className="text-right px-2">純利益</th>
            <th className="text-right px-2">EPS実績</th>
            <th className="text-right px-2">EPS予想</th>
            <th className="text-right px-2">サプライズ</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((q) => {
            const surpColor =
              q.surprise === null
                ? "var(--color-text-secondary)"
                : q.surprise >= 10
                ? "#22c55e"
                : q.surprise >= 0
                ? "#7fffd4"
                : q.surprise >= -10
                ? "#facc15"
                : "#fb923c";
            return (
              <tr key={q.date + q.quarter} className="border-b border-[var(--color-border)]/30">
                <td className="py-1.5 pr-2 text-[var(--color-accent)]">{q.quarter}</td>
                <td className="px-2 text-[var(--color-text-secondary)]">{q.date}</td>
                <td className="text-right px-2 text-[var(--color-text)]">
                  {formatLarge(q.revenue, currency)}
                </td>
                <td className="text-right px-2 text-[var(--color-text)]">
                  {formatLarge(q.netIncome, currency)}
                </td>
                <td className="text-right px-2 text-[var(--color-text)] font-bold">
                  {q.eps !== null ? q.eps.toFixed(2) : "—"}
                </td>
                <td className="text-right px-2 text-[var(--color-text-secondary)]">
                  {q.epsEstimate !== null ? q.epsEstimate.toFixed(2) : "—"}
                </td>
                <td className="text-right px-2 font-bold" style={{ color: surpColor }}>
                  {q.surprise !== null ? `${q.surprise >= 0 ? "+" : ""}${q.surprise.toFixed(1)}%` : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
