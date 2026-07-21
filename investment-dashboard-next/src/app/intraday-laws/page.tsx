"use client";

import { useEffect, useState } from "react";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface BucketStat {
  label: string;
  nObs: number;
  nDays: number;
  meanRet: number | null;
  dayMeanRet: number | null;
  upRate: number | null;
  t: number | null;
}
interface Law {
  signal: string;
  note: string;
  buckets: BucketStat[];
  totalDays: number;
  ready: boolean;
}
interface Resp {
  ok: boolean;
  range: { from: string; to: string; days: number; rows: number };
  laws: Law[];
  error?: string;
}

/** t値の強さで色付け (探索中は灰) */
function retColor(t: number | null, ready: boolean): string {
  if (!ready || t == null) return "var(--color-text-secondary)";
  if (Math.abs(t) < 2) return "var(--color-text)";
  return t > 0 ? "#22c55e" : "#ef4444";
}

export default function IntradayLawsPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/intraday-laws")
      .then((r) => r.json())
      .then((j: Resp) => { setData(j); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-center py-20 text-sm text-[var(--color-text)]" style={MONO}>場中データを集計中...</div>;
  }
  if (!data?.ok) {
    return <div className="text-center py-20 text-sm text-red-400" style={MONO}>⚠ {data?.error ?? "取得失敗"}</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">🔬 場中の法則 (探索)</h1>
        <p className="text-[14px] text-[var(--color-text-secondary)] mt-1.5 leading-relaxed">
          板圧・成行の偏りは Yahoo に存在しない、Cavka だけが場中5分刻みで蓄積しているデータ。
          「場中のこの状態は、その後どう動くか」を反証可能に集計する。
        </p>
        <p className="text-[11px] mt-1" style={{ ...MONO, color: "var(--color-text-secondary)" }}>
          収集: {data.range.from}〜{data.range.to} ({data.range.days}営業日 / {data.range.rows.toLocaleString()}行)
        </p>
      </div>

      {/* 読み方の約束 */}
      <div className="p-3 border text-[11px] leading-relaxed" style={{ borderColor: "var(--color-border)", background: "rgba(0,240,255,0.03)", color: "var(--color-text)", ...MONO }}>
        📐 <strong>読み方</strong>:
        統計単位は<strong className="text-[var(--color-accent)]">営業日</strong> (同じ日の複数銘柄は同じ地合いを共有していて独立でないため、銘柄数で数えると幻の有意が出る)。<br />
        「日平均」= 日ごとの平均リターンをさらに平均した値 (クラスタ補正済み)。t は日次系列の検定値で、
        <strong className="text-[var(--color-accent)]">|t|≥2 で初めて色</strong>が付く。<br />
        <strong className="text-[#fbbf24]">20営業日たまるまでは全て「探索中」= 灰色</strong>。まだ何も断定しない — それが正直な検証。
      </div>

      {data.laws.map((law) => (
        <section key={law.signal} className="space-y-2">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <h2 className="text-[16px] font-bold text-[var(--color-text)]">{law.signal}</h2>
            <span
              className="text-[10px] px-2 py-0.5 shrink-0"
              style={{
                ...MONO,
                background: law.ready ? "rgba(34,197,94,0.15)" : "rgba(107,114,128,0.15)",
                color: law.ready ? "#22c55e" : "#9ca3af",
                border: `1px solid ${law.ready ? "#22c55e" : "#6b7280"}66`,
              }}
            >
              {law.ready ? `判定可 (${law.totalDays}営業日)` : `探索中 (${law.totalDays}/20営業日)`}
            </span>
          </div>
          <p className="text-[11px] text-[var(--color-text-secondary)] leading-relaxed">{law.note}</p>

          <div className="overflow-x-auto">
            <table className="w-full text-[11px]" style={MONO}>
              <thead>
                <tr className="text-[var(--color-text-secondary)] text-[10px] uppercase border-b border-[var(--color-border)]">
                  <th className="text-left py-1.5 pr-2">状態</th>
                  <th className="text-right px-2">日平均リターン</th>
                  <th className="text-right px-2">上昇率</th>
                  <th className="text-right px-2">t値</th>
                  <th className="text-right px-2">観測 (日数)</th>
                </tr>
              </thead>
              <tbody>
                {law.buckets.map((b) => (
                  <tr key={b.label} className="border-b border-[var(--color-border)]/30">
                    <td className="py-1.5 pr-2 text-[var(--color-text)]">{b.label}</td>
                    <td className="text-right px-2 font-bold" style={{ color: retColor(b.t, law.ready) }}>
                      {b.dayMeanRet != null ? `${b.dayMeanRet >= 0 ? "+" : ""}${b.dayMeanRet}%` : "—"}
                    </td>
                    <td className="text-right px-2 text-[var(--color-text-secondary)]">
                      {b.upRate != null ? `${b.upRate}%` : "—"}
                    </td>
                    <td className="text-right px-2" style={{ color: retColor(b.t, law.ready) }}>
                      {b.t != null ? b.t : "—"}
                    </td>
                    <td className="text-right px-2 text-[var(--color-text-secondary)]">
                      {b.nObs} <span className="opacity-50">({b.nDays}日)</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <div className="text-[10px] text-[var(--color-text-secondary)] leading-relaxed pt-2 border-t border-[var(--color-border)]" style={MONO}>
        ※ これは法則の「探索」であって確定した法則でも投資助言でもない。データが増えるほど信頼度が上がる設計。<br />
        ※ 成行偏りはザラ場では板に残らず、引けの板寄せ (15:25頃) でだけ観測できる = 引け専用の信号として扱う。
      </div>
    </div>
  );
}
