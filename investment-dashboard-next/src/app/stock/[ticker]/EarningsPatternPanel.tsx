"use client";

import { useState, useEffect, useCallback } from "react";
import type { EarningsPatternResult } from "@/app/api/stocks/earnings-pattern/route";
import { GlossaryBox } from "@/components/CommentaryPanel";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

/**
 * 過去の決算前後パターンを可視化するパネル。
 * 「決算前◯日に売却が勝率N%」みたいな実用情報を提供する。
 */
export default function EarningsPatternPanel({ ticker }: { ticker: string }) {
  const [data, setData] = useState<EarningsPatternResult | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/stocks/earnings-pattern?ticker=${ticker}`);
      if (!res.ok) return;
      setData(await res.json());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [ticker]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="p-4 rounded text-center text-xs text-[var(--color-text-secondary)]" style={{ background: "var(--bg-card)", border: "1px solid var(--color-border)", ...MONO }}>
        📊 過去の決算パターンを分析中...
      </div>
    );
  }

  // 決算日情報のみあれば表示する: stats.sampleSize=0 でも nextEarningsDate があれば見せる
  if (!data || (data.stats.sampleSize === 0 && !data.nextEarningsDate && !data.lastEarningsDate)) {
    return null;
  }

  const { events, stats, insights, nextEarningsDate, daysToNext, lastEarningsDate, daysSinceLast } = data;

  return (
    <div className="p-4 rounded space-y-4" style={{ background: "var(--bg-card)", border: "1px solid var(--color-border)" }}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-[var(--color-accent)]" style={MONO}>
          📊 決算前後パターン分析
        </h3>
        <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
          過去 {stats.sampleSize} 回の決算から学習
        </span>
      </div>

      {/* 決算日サマリ (次回 / 直近) */}
      {(nextEarningsDate || lastEarningsDate) && (
        <div className="grid grid-cols-2 gap-2">
          {/* 次回決算 */}
          {nextEarningsDate ? (
            <div
              className="p-3 rounded"
              style={{
                background: daysToNext !== null && daysToNext <= 7
                  ? "rgba(251,191,36,0.10)"
                  : "rgba(0,240,255,0.06)",
                border: daysToNext !== null && daysToNext <= 7
                  ? "1px solid rgba(251,191,36,0.40)"
                  : "1px solid rgba(0,240,255,0.30)",
              }}
            >
              <div className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
                🗓 次回決算 (予定)
              </div>
              <div
                className="text-lg font-black mt-1"
                style={{ color: daysToNext !== null && daysToNext <= 7 ? "#fbbf24" : "var(--color-accent)", ...MONO }}
              >
                {nextEarningsDate}
              </div>
              {daysToNext !== null && (
                <div className="text-[10px] text-[var(--color-text)] mt-0.5" style={MONO}>
                  {daysToNext > 0
                    ? `あと ${daysToNext} 日`
                    : daysToNext === 0
                    ? "本日"
                    : `${Math.abs(daysToNext)} 日前 (更新待ち)`}
                </div>
              )}
            </div>
          ) : (
            <div className="p-3 rounded" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--color-border)" }}>
              <div className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>🗓 次回決算</div>
              <div className="text-sm text-[var(--color-text-secondary)] mt-1" style={MONO}>未公表</div>
            </div>
          )}

          {/* 直近決算 */}
          {lastEarningsDate ? (
            <div
              className="p-3 rounded"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--color-border)" }}
            >
              <div className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
                📅 直近決算
              </div>
              <div className="text-lg font-black text-[var(--color-text)] mt-1" style={MONO}>
                {lastEarningsDate}
              </div>
              {daysSinceLast !== null && (
                <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5" style={MONO}>
                  {daysSinceLast} 日前
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}

      {/* インサイト (推奨売り/買い) */}
      {(insights.bestSellTiming || insights.bestBuyTiming) && (
        <div className="space-y-1.5">
          {insights.bestSellTiming && (
            <div
              className="p-2.5 rounded text-xs flex items-start gap-2"
              style={{
                background: "rgba(34,197,94,0.08)",
                border: "1px solid rgba(34,197,94,0.3)",
                ...MONO,
              }}
            >
              <span className="text-base">💰</span>
              <div>
                <div className="text-[9px] text-[#22c55e]">推奨売り時</div>
                <div className="text-[#22c55e]">{insights.bestSellTiming}</div>
              </div>
            </div>
          )}
          {insights.bestBuyTiming && (
            <div
              className="p-2.5 rounded text-xs flex items-start gap-2"
              style={{
                background: "rgba(0,240,255,0.08)",
                border: "1px solid rgba(0,240,255,0.3)",
                ...MONO,
              }}
            >
              <span className="text-base">🎯</span>
              <div>
                <div className="text-[9px] text-[var(--color-accent)]">推奨買い時</div>
                <div className="text-[var(--color-accent)]">{insights.bestBuyTiming}</div>
              </div>
            </div>
          )}
        </div>
      )}

      <div
        className="p-2.5 rounded text-[11px]"
        style={{ background: "rgba(255,255,255,0.03)", color: "var(--color-text-secondary)", ...MONO }}
      >
        💡 {insights.summary}
      </div>

      {/* 平均値動きテーブル */}
      <div>
        <div className="text-[10px] text-[var(--color-text-secondary)] uppercase mb-2" style={MONO}>
          平均値動き (過去 {stats.sampleSize} 回)
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-7 gap-1">
          <StatCell label="14日前→" value={stats.avgPre14d} suffix="%" />
          <StatCell label="7日前→" value={stats.avgPre7d} suffix="%" winRate={stats.winRatePre7d} />
          <StatCell label="3日前→" value={stats.avgPre3d} suffix="%" />
          <StatCell label="当日" value={stats.avgDayOf} suffix="%" winRate={stats.winRateDayOf} bigBg />
          <StatCell label="→1日後" value={stats.avgPost1d} suffix="%" volatility={stats.volatilityPost1d} />
          <StatCell label="→3日後" value={stats.avgPost3d} suffix="%" />
          <StatCell label="→7日後" value={stats.avgPost7d} suffix="%" winRate={stats.winRatePost7d} />
        </div>
        <div className="text-[9px] text-[var(--color-text-secondary)] mt-2 text-center" style={MONO}>
          ※ 「7日前→」=決算7日前→決算当日の変化率 / 「→7日後」=決算当日→7日後の変化率
        </div>
      </div>

      {/* 持ち越しリスクの読み解き */}
      {stats.volatilityPost1d !== null && stats.sampleSize >= 3 && (
        <div
          className="p-2.5 rounded text-[11px] leading-relaxed"
          style={{
            background: "rgba(251,191,36,0.06)",
            border: "1px solid rgba(251,191,36,0.3)",
            color: "var(--color-text)",
          }}
        >
          🌡 この銘柄は決算翌日に <strong style={{ color: "#fbbf24", ...MONO }}>±{stats.volatilityPost1d.toFixed(1)}%</strong> 程度動くのが常連
          (過去{stats.sampleSize}回のバラつき)。
          決算をまたいで持つ = この変動をまるごと受け入れる行為。
          持ち越すなら「翌日この幅で逆に動いても耐えられる株数か」を先に確認。
        </div>
      )}

      {/* 📖 用語メモ */}
      <GlossaryBox terms={["勝率", "σ (標準偏差)", "EPS", "決算サプライズ"]} />

      {/* 過去イベント詳細 (折りたたみ) */}
      <details className="text-xs" style={MONO}>
        <summary className="cursor-pointer text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]">
          ▶ 過去 {events.length} 回の決算詳細を表示
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-[var(--color-text-secondary)] border-b border-[var(--color-border)]">
                <th className="text-left px-1.5 py-1">日付</th>
                <th className="text-right px-1.5 py-1">予想</th>
                <th className="text-right px-1.5 py-1">実績</th>
                <th className="text-right px-1.5 py-1">サプライズ</th>
                <th className="text-right px-1.5 py-1">7日前→当日</th>
                <th className="text-right px-1.5 py-1">当日→1日後</th>
                <th className="text-right px-1.5 py-1">当日→7日後</th>
              </tr>
            </thead>
            <tbody>
              {[...events].reverse().map((e) => (
                <tr key={e.date} className="border-b border-[var(--color-border)]/50">
                  <td className="px-1.5 py-1">{e.date}</td>
                  <td className="text-right px-1.5 py-1">{e.epsEstimate?.toFixed(2) ?? "-"}</td>
                  <td className="text-right px-1.5 py-1">{e.epsActual?.toFixed(2) ?? "-"}</td>
                  <td className="text-right px-1.5 py-1" style={{ color: surpriseColor(e.surprisePercent) }}>
                    {e.surprisePercent !== null ? `${e.surprisePercent >= 0 ? "+" : ""}${(e.surprisePercent * 100).toFixed(1)}%` : "-"}
                  </td>
                  <td className="text-right px-1.5 py-1" style={{ color: changeColor(e.pre7d) }}>
                    {e.pre7d !== null ? `${e.pre7d >= 0 ? "+" : ""}${e.pre7d.toFixed(1)}%` : "-"}
                  </td>
                  <td className="text-right px-1.5 py-1" style={{ color: changeColor(e.post1d) }}>
                    {e.post1d !== null ? `${e.post1d >= 0 ? "+" : ""}${e.post1d.toFixed(1)}%` : "-"}
                  </td>
                  <td className="text-right px-1.5 py-1" style={{ color: changeColor(e.post7d) }}>
                    {e.post7d !== null ? `${e.post7d >= 0 ? "+" : ""}${e.post7d.toFixed(1)}%` : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function changeColor(v: number | null): string {
  if (v === null) return "var(--color-text-secondary)";
  if (v >= 1) return "#22c55e";
  if (v <= -1) return "#ef4444";
  return "var(--color-text)";
}

function surpriseColor(v: number | null): string {
  if (v === null) return "var(--color-text-secondary)";
  // surprisePercent は 0.05 = 5%
  if (v >= 0.05) return "#22c55e";
  if (v <= -0.05) return "#ef4444";
  return "var(--color-text)";
}

function StatCell({
  label,
  value,
  suffix,
  winRate,
  volatility,
  bigBg,
}: {
  label: string;
  value: number | null;
  suffix: string;
  winRate?: number | null;
  volatility?: number | null;
  bigBg?: boolean;
}) {
  const color = value === null ? "var(--color-text-secondary)" :
    value >= 1 ? "#22c55e" : value <= -1 ? "#ef4444" : "var(--color-text)";
  return (
    <div
      className="p-1.5 rounded text-center"
      style={{
        background: bigBg ? "rgba(0,240,255,0.05)" : "rgba(0,0,0,0.2)",
        border: bigBg ? "1px solid rgba(0,240,255,0.3)" : "1px solid var(--color-border)",
        ...MONO,
      }}
    >
      <div className="text-[9px] text-[var(--color-text-secondary)]">{label}</div>
      <div className="text-xs font-bold mt-0.5" style={{ color }}>
        {value !== null ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}${suffix}` : "-"}
      </div>
      {winRate !== null && winRate !== undefined && (
        <div className="text-[8px] text-[var(--color-text-secondary)] mt-0.5">
          勝率 {winRate.toFixed(0)}%
        </div>
      )}
      {volatility !== null && volatility !== undefined && (
        <div className="text-[8px] text-[var(--color-text-secondary)] mt-0.5">
          σ±{volatility.toFixed(1)}%
        </div>
      )}
    </div>
  );
}
