"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { NIKKEI225 } from "@/lib/nikkei225";
import { SP500 } from "@/lib/sp500";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface MomentumResult {
  ticker: string;
  name: string;
  market: "JP" | "US";
  finalScore: number;
  passes: boolean;
  excludeReason: string | null;
  p1Growth: number;
  p2Estimate: number;
  p3Margin: number;
  p4Pricing: number;
  tTechnical: number;
  softPenalty: number;
  flags: string[];
  diagnostics: {
    revYoyQ0: number | null;
    consEpsRev: number | null;
    surpriseStreak: number;
    opMargin: number | null;
    extFromMa200: number | null;
    return12m: number | null;
    marketCap: number | null;
    numberOfAnalysts: number | null;
  };
}

const SS_RESULTS = "cavka_momentum_results";

type Scope = "nikkei225" | "sp500" | "both";

export default function MomentumScreenerPanel() {
  const router = useRouter();
  const [scope, setScope] = useState<Scope>("nikkei225");
  const [results, setResults] = useState<MomentumResult[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [showExcluded, setShowExcluded] = useState(false);
  const [showAllPassed, setShowAllPassed] = useState(false);
  const [minScore, setMinScore] = useState(40);
  const TOP_N = 50;
  const abortRef = useRef(false);

  // Restore from sessionStorage
  useEffect(() => {
    try {
      const cached = sessionStorage.getItem(SS_RESULTS);
      if (cached) {
        const parsed = JSON.parse(cached) as MomentumResult[];
        if (parsed.length > 0) {
          setResults(parsed);
          setProgress({ done: parsed.length, total: parsed.length });
        }
      }
    } catch {}
  }, []);

  const scan = useCallback(async () => {
    setScanning(true);
    setResults([]);
    abortRef.current = false;

    // ユニバース構築
    let tickers: string[] = [];
    if (scope === "nikkei225" || scope === "both") {
      tickers.push(...NIKKEI225.map((s) => s.ticker));
    }
    if (scope === "sp500" || scope === "both") {
      tickers.push(...SP500.map((s) => s.ticker));
    }

    setProgress({ done: 0, total: tickers.length });
    const collected: MomentumResult[] = [];
    const BATCH = 5;

    for (let i = 0; i < tickers.length; i += BATCH) {
      if (abortRef.current) break;
      const batch = tickers.slice(i, i + BATCH);
      const batchResults = await Promise.all(
        batch.map(async (t) => {
          try {
            const res = await fetch(`/api/stocks/momentum-score?ticker=${t}`);
            if (!res.ok) return null;
            const j = await res.json();
            if (!j.ok) return null;
            return j as MomentumResult;
          } catch {
            return null;
          }
        })
      );
      for (const r of batchResults) {
        if (r) collected.push(r);
      }
      setProgress({ done: Math.min(i + BATCH, tickers.length), total: tickers.length });
      setResults([...collected]);
      // 軽いレート制限
      if (i + BATCH < tickers.length && !abortRef.current) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    setScanning(false);
    try {
      sessionStorage.setItem(SS_RESULTS, JSON.stringify(collected));
    } catch {}
  }, [scope]);

  // 通過候補のみ抽出 + スコア降順
  const passedAll = results
    .filter((r) => r.passes)
    .sort((a, b) => b.finalScore - a.finalScore);
  // 最低スコアで足切り
  const passed = passedAll.filter((r) => r.finalScore >= minScore);
  const passedDisplay = showAllPassed ? passed : passed.slice(0, TOP_N);
  const lowScore = passedAll.filter((r) => r.finalScore < minScore);

  // 除外 (理由別カウント)
  const excluded = results.filter((r) => !r.passes);
  const excludeBreakdown: Record<string, number> = {};
  for (const e of excluded) {
    const gate = (e.excludeReason ?? "").split(":")[0] || "unknown";
    excludeBreakdown[gate] = (excludeBreakdown[gate] ?? 0) + 1;
  }

  const fmtCap = (cap: number | null, market: "JP" | "US"): string => {
    if (cap === null) return "—";
    if (market === "JP") return `¥${(cap / 1e12).toFixed(1)}T`;
    return `$${(cap / 1e9).toFixed(0)}B`;
  };

  return (
    <div className="space-y-4">
      {/* 概要 */}
      <div
        className="p-3 text-xs"
        style={{ background: "var(--bg-card)", border: "1px solid var(--color-border)", color: "var(--color-text)", ...MONO }}
      >
        🚀 <strong>モメンタム・グロース・スクリーニング</strong> — 「未発見の主役候補」を業績加速 × 連続上方修正 × 利益率拡大 × テクニカル確認 × 後期除外 で抽出。
        <span className="opacity-60 ml-1">(NVDA/AAPL のような巨大株はメガキャップで除外、走り切った株はパラボリック除外)</span>
      </div>

      {/* ヘッダ: スコープ + スキャンボタン */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-1">
          {([
            { id: "nikkei225", label: "日経225", count: NIKKEI225.length },
            { id: "sp500", label: "S&P500", count: SP500.length },
            { id: "both", label: "両方", count: NIKKEI225.length + SP500.length },
          ] as const).map((s) => (
            <button
              key={s.id}
              onClick={() => setScope(s.id)}
              disabled={scanning}
              className="px-3 py-1.5 text-xs disabled:opacity-50"
              style={{
                border: `1px solid ${scope === s.id ? "var(--color-accent-magenta)" : "var(--color-border)"}`,
                color: scope === s.id ? "var(--color-accent-magenta)" : "var(--color-text-secondary)",
                background: scope === s.id ? "rgba(255,0,255,0.08)" : "transparent",
                ...MONO,
              }}
            >
              {s.label} <span className="opacity-60">({s.count})</span>
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { abortRef.current = true; }}
            disabled={!scanning}
            className="px-3 py-1.5 text-xs disabled:opacity-30"
            style={{ border: "1px solid var(--color-up)", color: "var(--color-up)", ...MONO }}
          >
            ABORT
          </button>
          <button
            onClick={scan}
            disabled={scanning}
            className="px-4 py-2 text-sm font-medium min-h-[40px] disabled:opacity-50"
            style={{ border: "1px solid var(--color-accent)", background: scanning ? "rgba(0,240,255,0.1)" : "rgba(0,240,255,0.15)", color: "var(--color-accent)", ...MONO, boxShadow: "0 0 12px rgba(0,240,255,0.2)" }}
          >
            {scanning ? `SCANNING... ${progress.done}/${progress.total}` : "🚀 SCAN"}
          </button>
        </div>
      </div>

      {/* プログレスバー */}
      {scanning && progress.total > 0 && (
        <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--color-border)" }}>
          <div
            className="h-full transition-all"
            style={{ width: `${(progress.done / progress.total) * 100}%`, background: "var(--color-accent)", boxShadow: "0 0 8px var(--color-accent)" }}
          />
        </div>
      )}

      {/* サマリ + スコア足切り */}
      {results.length > 0 && (
        <div className="flex items-center gap-4 flex-wrap text-xs" style={MONO}>
          <span className="text-[var(--color-accent)] font-bold">
            候補 {passed.length}件
            {passed.length > TOP_N && !showAllPassed && (
              <span className="text-[var(--color-text-secondary)] ml-1">(上位{TOP_N}件を表示)</span>
            )}
          </span>
          <span className="text-[var(--color-text-secondary)]">低スコア {lowScore.length}件</span>
          <span className="text-[var(--color-text-secondary)]">除外 {excluded.length}件</span>
          <span className="text-[var(--color-text-secondary)]">処理済 {results.length}/{progress.total}</span>
          <label className="flex items-center gap-1 text-[var(--color-text-secondary)]">
            最低スコア:
            <input
              type="number"
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              min={0}
              max={100}
              className="w-14 bg-[var(--bg-input)] border border-[var(--color-border)] px-1.5 py-0.5 text-xs text-[var(--color-text)]"
              style={MONO}
            />
          </label>
          {Object.entries(excludeBreakdown).length > 0 && (
            <span className="text-[10px] text-[var(--color-text-secondary)]">
              [{Object.entries(excludeBreakdown).map(([k, v]) => `${k}:${v}`).join(", ")}]
            </span>
          )}
        </div>
      )}

      {/* 候補テーブル */}
      {passed.length > 0 && (
        <div className="rounded overflow-hidden" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px]" style={MONO}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--color-border)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-secondary)" }}>
                  <th className="px-2 py-2 text-right w-10">#</th>
                  <th className="px-3 py-2 text-left">銘柄</th>
                  <th className="px-3 py-2 text-right">Score</th>
                  <th className="px-3 py-2 text-right">P1<br/>成長</th>
                  <th className="px-3 py-2 text-right">P2<br/>改定</th>
                  <th className="px-3 py-2 text-right">P3<br/>利益率</th>
                  <th className="px-3 py-2 text-right">P4<br/>競争力</th>
                  <th className="px-3 py-2 text-right">T<br/>テク</th>
                  <th className="px-3 py-2 text-right">時価総額</th>
                  <th className="px-3 py-2 text-right">アナ</th>
                  <th className="px-3 py-2 text-right">12M</th>
                  <th className="px-3 py-2 text-right">サプ連</th>
                </tr>
              </thead>
              <tbody>
                {passedDisplay.map((r, i) => {
                  const scoreColor = r.finalScore >= 70 ? "#22c55e" : r.finalScore >= 50 ? "var(--color-accent)" : r.finalScore >= 30 ? "#fbbf24" : "var(--color-text-secondary)";
                  return (
                    <tr
                      key={r.ticker}
                      className="cursor-pointer transition-colors hover:bg-[rgba(0,240,255,0.04)]"
                      style={{ borderBottom: "1px solid var(--color-border)" }}
                      onClick={() => router.push(`/stock/${r.ticker}`)}
                    >
                      <td className="px-2 py-2.5 text-right text-xs text-[var(--color-text-secondary)]">{i + 1}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] px-1 py-0.5" style={{ background: r.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)", color: r.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)" }}>{r.market}</span>
                          <div>
                            <div className="text-xs text-[var(--color-accent)] font-bold">{r.ticker}</div>
                            <div className="text-[10px] text-[var(--color-text-secondary)] max-w-[180px] truncate">{r.name}</div>
                          </div>
                          {r.flags.length > 0 && (
                            <span className="text-[10px] px-1 py-0.5" title={r.flags.join(" / ")} style={{ background: "rgba(251,191,36,0.15)", color: "#fbbf24" }}>⚠</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <span className="text-lg font-black" style={{ color: scoreColor }}>{r.finalScore}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-xs">{r.p1Growth}</td>
                      <td className="px-3 py-2.5 text-right text-xs">{r.p2Estimate}</td>
                      <td className="px-3 py-2.5 text-right text-xs">{r.p3Margin}</td>
                      <td className="px-3 py-2.5 text-right text-xs">{r.p4Pricing}</td>
                      <td className="px-3 py-2.5 text-right text-xs">{r.tTechnical}</td>
                      <td className="px-3 py-2.5 text-right text-xs text-[var(--color-text-secondary)]">{fmtCap(r.diagnostics.marketCap, r.market)}</td>
                      <td className="px-3 py-2.5 text-right text-xs text-[var(--color-text-secondary)]">{r.diagnostics.numberOfAnalysts ?? "—"}</td>
                      <td className="px-3 py-2.5 text-right text-xs" style={{ color: r.diagnostics.return12m !== null && r.diagnostics.return12m > 0 ? "#22c55e" : "#ef4444" }}>
                        {r.diagnostics.return12m !== null ? `${r.diagnostics.return12m > 0 ? "+" : ""}${Math.round(r.diagnostics.return12m * 100)}%` : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right text-xs">
                        {r.diagnostics.surpriseStreak > 0 ? `${r.diagnostics.surpriseStreak}Q` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {passed.length > TOP_N && (
            <div className="p-2 text-center border-t border-[var(--color-border)]">
              <button
                onClick={() => setShowAllPassed(!showAllPassed)}
                className="text-xs text-[var(--color-accent)] hover:underline"
                style={MONO}
              >
                {showAllPassed ? `▲ 上位${TOP_N}件のみ表示に戻す` : `▼ 残り ${passed.length - TOP_N} 件も表示`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* 低スコア候補 (折りたたみ) */}
      {lowScore.length > 0 && (
        <div>
          <span className="text-xs text-[var(--color-text-secondary)]" style={MONO}>
            📉 除外ゲートは通過したがスコア &lt; {minScore} の {lowScore.length} 件は候補外
          </span>
        </div>
      )}

      {/* 除外リスト (折りたたみ) */}
      {excluded.length > 0 && (
        <div>
          <button
            onClick={() => setShowExcluded(!showExcluded)}
            className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]"
            style={MONO}
          >
            {showExcluded ? "▼" : "▶"} 除外された {excluded.length} 銘柄を表示
          </button>
          {showExcluded && (
            <div className="mt-2 rounded overflow-hidden" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}>
              <div className="overflow-x-auto max-h-96">
                <table className="w-full min-w-[700px] text-xs" style={MONO}>
                  <thead>
                    <tr className="text-[var(--color-text-secondary)] border-b border-[var(--color-border)]">
                      <th className="px-3 py-1.5 text-left">銘柄</th>
                      <th className="px-3 py-1.5 text-left">除外理由</th>
                    </tr>
                  </thead>
                  <tbody>
                    {excluded.map((r) => (
                      <tr key={r.ticker} className="border-b border-[var(--color-border)]/50 cursor-pointer hover:bg-[rgba(0,240,255,0.02)]" onClick={() => router.push(`/stock/${r.ticker}`)}>
                        <td className="px-3 py-1.5">
                          <span className="text-[var(--color-accent)] font-bold mr-2">{r.ticker}</span>
                          <span className="text-[var(--color-text-secondary)]">{r.name}</span>
                        </td>
                        <td className="px-3 py-1.5 text-[var(--color-text-secondary)] text-[10px]">{r.excludeReason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 注意書き */}
      {results.length === 0 && !scanning && (
        <div className="text-center py-12 text-sm text-[var(--color-text-secondary)]" style={MONO}>
          🚀 SCAN ボタンで開始 (日経225 約3分、両方 約8分)
        </div>
      )}

      {results.length > 0 && (
        <div className="text-[10px] text-[var(--color-text-secondary)] opacity-60 leading-relaxed" style={MONO}>
          ※ 「未発見の主役候補」を狙う設計です。NVDA・AAPL のような巨大株はメガキャップで除外、走り切った株はパラボリックで除外。<br/>
          ※ サブスコア: P1=成長加速(30) / P2=コンセンサス改定+サプライズ連続(25) / P3=利益率拡大(20) / P4=価格決定力(10) / T=テクニカル確認(15)<br/>
          ※ アナリスト数が25超の銘柄は「市場発見済み」として除外。閾値は src/lib/momentum-params.ts で調整可能。
        </div>
      )}
    </div>
  );
}
