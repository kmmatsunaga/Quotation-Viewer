"use client";

import { useEffect, useState } from "react";
import CommentaryPanel from "@/components/CommentaryPanel";
import { assessLargeHoldings } from "@/lib/holdings-assess";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface Filer {
  filerName: string;
  edinetCode: string | null;
  docCount: number;
  latestSubmitDateTime: string | null;
  latestDocDescription: string | null;
  latestType: "initial" | "change" | "other";
  isIncrease: boolean;
  isReduce: boolean;
  latestDocID: string;
}

interface Summary {
  totalFilings: number;
  uniqueFilers: number;
  newFilers: number;
  changes: number;
  increasing: number;
  decreasing: number;
}

interface Response {
  ok: boolean;
  ticker: string;
  filers?: Filer[];
  summary?: Summary;
  cached?: boolean;
  computedAt?: string;
  error?: string;
}

const TYPE_LABEL: Record<Filer["latestType"], string> = {
  initial: "🆕 新規",
  change: "🔄 変更",
  other: "—",
};

export default function LargeHoldingsPanel({ ticker }: { ticker: string }) {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 日本株 (4桁) のみ
    if (!/^\d{3,4}[A-Z]?$/.test(ticker)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/edinet/large-holdings/${ticker}?days=60`)
      .then((r) => r.json())
      .then((j: Response) => {
        if (cancelled) return;
        if (!j.ok) setError(j.error ?? "取得失敗");
        setData(j);
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

  // 日本株でない or 取得失敗時は何も表示しない
  if (!/^\d{3,4}[A-Z]?$/.test(ticker)) return null;
  if (loading) {
    return (
      <div className="p-4 border" style={{ borderColor: "var(--color-border)" }}>
        <div className="text-xs text-[var(--color-text-secondary)]" style={MONO}>
          // EDINET 大量保有報告 読み込み中...
        </div>
      </div>
    );
  }
  if (error || !data?.ok) return null;
  if (!data.summary || data.summary.totalFilings === 0) {
    return (
      <div className="p-4 border" style={{ borderColor: "var(--color-border)" }}>
        <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--color-text-secondary)] mb-2" style={MONO}>
          // EDINET_LARGE_HOLDINGS (60日)
        </div>
        <div className="text-xs text-[var(--color-text-secondary)]" style={MONO}>
          直近60日に大量保有報告書の提出はなし。
        </div>
      </div>
    );
  }

  const s = data.summary;
  const filers = data.filers ?? [];

  return (
    <div
      className="p-4 border space-y-3"
      style={{
        borderColor: "var(--color-accent)",
        background: "rgba(0,240,255,0.04)",
      }}
    >
      <div>
        <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--color-text-secondary)]" style={MONO}>
          // EDINET_LARGE_HOLDINGS (60日)
        </div>
        <div className="text-sm font-bold text-[var(--color-accent)] mt-1">
          🏛 機関投資家動向 (5%ルール大量保有報告)
        </div>
      </div>

      {/* サマリ */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs" style={MONO}>
        <Stat label="提出書類数" value={`${s.totalFilings}`} color="#7fffd4" />
        <Stat label="提出者数" value={`${s.uniqueFilers}`} color="#facc15" />
        <Stat
          label="🟢 買い増し"
          value={`${s.increasing}`}
          color={s.increasing > 0 ? "#22c55e" : "var(--color-text-secondary)"}
        />
        <Stat
          label="🔴 売り出し"
          value={`${s.decreasing}`}
          color={s.decreasing > 0 ? "#fb923c" : "var(--color-text-secondary)"}
        />
      </div>

      {/* 提出者リスト */}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]" style={MONO}>
          <thead>
            <tr className="border-b border-[var(--color-border)] text-[var(--color-text-secondary)] text-[10px] uppercase">
              <th className="text-left py-1.5 pr-2">提出日時</th>
              <th className="text-left px-1">提出者</th>
              <th className="text-left px-1">種類</th>
              <th className="text-left px-1">方向</th>
              <th className="text-left pl-2">概要</th>
            </tr>
          </thead>
          <tbody>
            {filers.slice(0, 20).map((f) => {
              const date = f.latestSubmitDateTime ?? "";
              const dir = f.isIncrease
                ? "🟢 買増"
                : f.isReduce
                ? "🔴 売却"
                : "—";
              return (
                <tr
                  key={f.latestDocID}
                  className="border-b border-[var(--color-border)]/30"
                >
                  <td className="py-1.5 pr-2 text-[var(--color-text)]">
                    {date.slice(5, 16)}
                  </td>
                  <td className="px-1 text-[var(--color-text)]">
                    {f.filerName.slice(0, 30)}
                    {f.docCount > 1 && (
                      <span className="text-[var(--color-text-secondary)] ml-1">
                        ×{f.docCount}
                      </span>
                    )}
                  </td>
                  <td className="px-1 text-[var(--color-text-secondary)]">
                    {TYPE_LABEL[f.latestType]}
                  </td>
                  <td className="px-1">{dir}</td>
                  <td className="pl-2 text-[10px] text-[var(--color-text-secondary)] truncate max-w-[400px]">
                    {f.latestDocDescription}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 🏛 大口動向の温度計 (自動解説) */}
      {(() => {
        const c = assessLargeHoldings({
          totalFilings: s.totalFilings,
          uniqueFilers: s.uniqueFilers,
          newFilers: s.newFilers,
          increasing: s.increasing,
          decreasing: s.decreasing,
          windowDays: 60,
        });
        return c ? <CommentaryPanel title="大口動向の温度計" c={c} /> : null;
      })()}

      <div className="text-[9px] text-[var(--color-text-secondary)]" style={MONO}>
        Source: EDINET (金融庁) · cached: {data.cached ? "yes" : "no"}
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: "rgba(0,0,0,0.3)", padding: "8px 10px" }}>
      <div className="text-[9px] uppercase text-[var(--color-text-secondary)]">{label}</div>
      <div className="text-base font-bold" style={{ color, ...MONO }}>
        {value}
      </div>
    </div>
  );
}
