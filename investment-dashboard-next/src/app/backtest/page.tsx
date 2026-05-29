"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

type Signal = "overall" | "short" | "mid" | "long";

const SIGNAL_LABELS: Record<Signal, { label: string; icon: string }> = {
  overall: { label: "総合", icon: "📊" },
  short: { label: "短期", icon: "🔥" },
  mid: { label: "中期", icon: "📈" },
  long: { label: "長期", icon: "🏛" },
};

const HOLD_DAYS = [1, 3, 5, 10, 20, 60];

interface BacktestResp {
  ok: boolean;
  summary: {
    sampleCount: number;
    avgReturn: number;
    median: number;
    winRate: number;
    stdDev: number;
    sharpe: number;
    p10: number;
    p90: number;
    minReturn: number;
    maxReturn: number;
  } | null;
  topTickers: { ticker: string; name: string; count: number; avgReturn: number }[];
  results: {
    entryDate: string;
    exitDate: string;
    ticker: string;
    name: string;
    market: string;
    entryScore: number;
    entryPrice: number;
    exitPrice: number;
    returnPct: number;
  }[];
  meta: {
    signal: string;
    holdDays: number;
    topN: number;
    minScore: number;
    availableDates: number;
    dateRange?: string;
  };
  error?: string;
}

export default function BacktestPage() {
  const router = useRouter();
  const [data, setData] = useState<BacktestResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [signal, setSignal] = useState<Signal>("overall");
  const [holdDays, setHoldDays] = useState<number>(5);
  const [topN, setTopN] = useState<number>(20);
  const [minScore, setMinScore] = useState<number>(60);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = `/api/backtest/score-rankings?signal=${signal}&holdDays=${holdDays}&topN=${topN}&minScore=${minScore}`;
      const res = await fetch(url);
      const json: BacktestResp = await res.json();
      setData(json);
    } finally {
      setLoading(false);
    }
  }, [signal, holdDays, topN, minScore]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-[var(--color-accent)]" style={MONO}>
          🔬 シグナル精度検証 (バックテスト)
        </h1>
        <p className="text-xs text-[var(--color-text-secondary)] mt-1" style={MONO}>
          過去スコアスナップショットから「Top N 銘柄を N日保有」した場合のリターン分布を集計
        </p>
      </div>

      {/* 設定 */}
      <div
        className="p-3 border space-y-3"
        style={{ ...MONO, borderColor: "var(--color-border)", background: "rgba(0,0,0,0.25)" }}
      >
        {/* シグナル選択 */}
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-[var(--color-text-secondary)]">対象シグナル:</span>
          {(Object.keys(SIGNAL_LABELS) as Signal[]).map((s) => (
            <button
              key={s}
              onClick={() => setSignal(s)}
              className="px-3 py-1.5"
              style={{
                border: `1px solid ${signal === s ? "var(--color-accent)" : "var(--color-border)"}`,
                color: signal === s ? "var(--color-accent)" : "var(--color-text-secondary)",
                background: signal === s ? "rgba(0,240,255,0.08)" : "transparent",
              }}
            >
              {SIGNAL_LABELS[s].icon} {SIGNAL_LABELS[s].label}
            </button>
          ))}
        </div>

        {/* 保有期間 */}
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-[var(--color-text-secondary)]">保有期間:</span>
          {HOLD_DAYS.map((d) => (
            <button
              key={d}
              onClick={() => setHoldDays(d)}
              className="px-3 py-1.5"
              style={{
                border: `1px solid ${holdDays === d ? "var(--color-accent)" : "var(--color-border)"}`,
                color: holdDays === d ? "var(--color-accent)" : "var(--color-text-secondary)",
                background: holdDays === d ? "rgba(0,240,255,0.08)" : "transparent",
              }}
            >
              {d}日
            </button>
          ))}
        </div>

        {/* Top N, MinScore */}
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <span className="text-[var(--color-text-secondary)]">Top N:</span>
          <input
            type="number"
            value={topN}
            onChange={(e) => setTopN(Number(e.target.value) || 20)}
            min={1}
            max={50}
            className="w-16 px-2 py-1 bg-[var(--bg-input)] border border-[var(--color-border)]"
          />
          <span className="text-[var(--color-text-secondary)]">MinScore:</span>
          <input
            type="number"
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value) || 60)}
            min={0}
            max={100}
            className="w-16 px-2 py-1 bg-[var(--bg-input)] border border-[var(--color-border)]"
          />
          <button
            onClick={load}
            className="ml-auto px-3 py-1.5"
            style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)" }}
          >
            🔄 再計算
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-[var(--color-text-secondary)] text-sm" style={MONO}>
          計算中...
        </div>
      ) : !data || !data.ok ? (
        <div className="p-3 border border-red-500/30 text-xs text-red-400" style={MONO}>
          ⚠ {data?.error ?? "データ無し"}
          <div className="mt-2 text-[var(--color-text-secondary)]">
            スナップショットが {data?.meta?.availableDates ?? 0} 日分しかありません。複数日分溜まると統計的に有意になります。
          </div>
        </div>
      ) : (
        <>
          {/* サマリ */}
          {data.summary && (
            <div
              className="p-4 border"
              style={{
                ...MONO,
                borderColor: data.summary.avgReturn >= 0 ? "rgba(127,255,212,0.5)" : "rgba(251,146,60,0.5)",
                background: data.summary.avgReturn >= 0 ? "rgba(127,255,212,0.08)" : "rgba(251,146,60,0.08)",
              }}
            >
              <div className="text-[10px] uppercase text-[var(--color-text-secondary)] mb-2">
                // BACKTEST_SUMMARY · {data.meta.dateRange} · N={data.summary.sampleCount}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <Stat label="平均リターン" value={`${data.summary.avgReturn >= 0 ? "+" : ""}${data.summary.avgReturn}%`} color={data.summary.avgReturn >= 0 ? "#22c55e" : "#fb923c"} big />
                <Stat label="勝率" value={`${data.summary.winRate}%`} color={data.summary.winRate >= 50 ? "#22c55e" : "#fb923c"} big />
                <Stat label="中央値" value={`${data.summary.median >= 0 ? "+" : ""}${data.summary.median}%`} color="#7fffd4" big />
                <Stat label="Sharpe風" value={`${data.summary.sharpe}`} color={data.summary.sharpe >= 0.5 ? "#22c55e" : data.summary.sharpe >= 0 ? "#facc15" : "#fb923c"} big />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs mt-3 pt-3 border-t border-[var(--color-border)]">
                <Stat label="標準偏差" value={`±${data.summary.stdDev}%`} color="var(--color-text-secondary)" />
                <Stat label="P10 (下振れ)" value={`${data.summary.p10 >= 0 ? "+" : ""}${data.summary.p10}%`} color="var(--color-text-secondary)" />
                <Stat label="P90 (上振れ)" value={`${data.summary.p90 >= 0 ? "+" : ""}${data.summary.p90}%`} color="var(--color-text-secondary)" />
                <Stat label="最小〜最大" value={`${data.summary.minReturn}% ~ ${data.summary.maxReturn}%`} color="var(--color-text-secondary)" />
              </div>
            </div>
          )}

          {/* 勝ち銘柄 Top */}
          {data.topTickers.length > 0 && (
            <div
              className="p-3 border"
              style={{ ...MONO, borderColor: "var(--color-border)", background: "rgba(0,0,0,0.25)" }}
            >
              <div className="text-[10px] uppercase text-[var(--color-text-secondary)] mb-2">
                // 銘柄別 平均リターン Top 20
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-[11px]">
                {data.topTickers.map((t, i) => (
                  <button
                    key={t.ticker}
                    onClick={() => router.push(`/stock/${t.ticker}`)}
                    className="flex items-center gap-2 p-1.5 hover:bg-[var(--color-accent)]/5 text-left"
                  >
                    <span className="text-[var(--color-text-secondary)] w-6 text-right">#{i + 1}</span>
                    <span className="text-[var(--color-accent)] font-bold w-12">{t.ticker}</span>
                    <span className="text-[var(--color-text)] flex-1 truncate">{t.name}</span>
                    <span className="text-[10px] text-[var(--color-text-secondary)]">×{t.count}</span>
                    <span
                      className="font-bold w-16 text-right"
                      style={{ color: t.avgReturn >= 0 ? "#22c55e" : "#fb923c" }}
                    >
                      {t.avgReturn >= 0 ? "+" : ""}{t.avgReturn}%
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 個別シグナル一覧 (最新順) */}
          {data.results.length > 0 && (
            <div
              className="p-3 border"
              style={{ ...MONO, borderColor: "var(--color-border)", background: "rgba(0,0,0,0.25)" }}
            >
              <div className="text-[10px] uppercase text-[var(--color-text-secondary)] mb-2">
                // 個別シグナル (最新 100件)
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-[var(--color-text-secondary)] text-[10px] uppercase">
                      <th className="text-left py-1.5 pr-2">エントリ</th>
                      <th className="text-left px-2">イグジット</th>
                      <th className="text-left px-2">銘柄</th>
                      <th className="text-right px-2">スコア</th>
                      <th className="text-right px-2">入値</th>
                      <th className="text-right px-2">出値</th>
                      <th className="text-right px-2">リターン</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.results
                      .sort((a, b) => b.entryDate.localeCompare(a.entryDate))
                      .slice(0, 50)
                      .map((r, i) => (
                        <tr
                          key={i}
                          className="border-b border-[var(--color-border)]/30 hover:bg-[var(--color-accent)]/5 cursor-pointer"
                          onClick={() => router.push(`/stock/${r.ticker}`)}
                        >
                          <td className="py-1 pr-2 text-[var(--color-text-secondary)]">{r.entryDate}</td>
                          <td className="px-2 text-[var(--color-text-secondary)]">{r.exitDate}</td>
                          <td className="px-2">
                            <span className="text-[var(--color-accent)] font-bold">{r.ticker}</span>
                            <span className="text-[var(--color-text)] ml-2">{r.name}</span>
                          </td>
                          <td className="text-right px-2 text-[var(--color-text)]">{r.entryScore}</td>
                          <td className="text-right px-2 text-[var(--color-text-secondary)]">{r.entryPrice.toLocaleString()}</td>
                          <td className="text-right px-2 text-[var(--color-text-secondary)]">{r.exitPrice.toLocaleString()}</td>
                          <td
                            className="text-right px-2 font-bold"
                            style={{ color: r.returnPct >= 0 ? "#22c55e" : "#fb923c" }}
                          >
                            {r.returnPct >= 0 ? "+" : ""}{r.returnPct}%
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, color, big }: { label: string; value: string; color: string; big?: boolean }) {
  return (
    <div style={{ background: "rgba(0,0,0,0.3)", padding: "8px 10px" }}>
      <div className="text-[9px] uppercase text-[var(--color-text-secondary)]">{label}</div>
      <div
        className={big ? "text-xl font-black" : "text-sm font-bold"}
        style={{ color, ...MONO }}
      >
        {value}
      </div>
    </div>
  );
}
