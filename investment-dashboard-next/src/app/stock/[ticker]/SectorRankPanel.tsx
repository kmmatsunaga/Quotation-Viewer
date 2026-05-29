"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface RankInfo {
  rank: number;
  total: number;
  avg: number;
  topName: string;
  pct: number;
}

interface SectorRankResp {
  ok: boolean;
  ticker: string;
  sector: string;
  sectorEntries: number;
  target: { short: number; mid: number; long: number; overall: number };
  ranks: Record<string, RankInfo>;
  sectorTop: { ticker: string; name: string; overall: number; short: number; mid: number; long: number }[];
  error?: string;
}

const TF_LABELS: Record<string, { icon: string; label: string }> = {
  overall: { icon: "📊", label: "総合" },
  short: { icon: "🔥", label: "短期" },
  mid: { icon: "📈", label: "中期" },
  long: { icon: "🏛", label: "長期" },
};

export default function SectorRankPanel({ ticker }: { ticker: string }) {
  const router = useRouter();
  const [data, setData] = useState<SectorRankResp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/stocks/sector-rank/${encodeURIComponent(ticker)}`)
      .then((r) => r.json())
      .then((j: SectorRankResp) => {
        if (cancelled) return;
        if (j.ok) setData(j);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  if (loading) {
    return (
      <div className="p-4 border" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
        <div className="text-xs text-[var(--color-text-secondary)]" style={MONO}>
          // SECTOR_RANK.LOADING ...
        </div>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div
      className="p-4 border space-y-3"
      style={{ ...MONO, borderColor: "var(--color-border)", background: "var(--bg-card)" }}
    >
      <div>
        <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--color-text-secondary)]">
          // SECTOR_RANK
        </div>
        <div className="text-sm font-bold text-[var(--color-accent)] mt-1">
          🏷 業種内ポジション · {data.sector} ({data.sectorEntries}社)
        </div>
      </div>

      {/* ランク 4軸 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        {(Object.keys(TF_LABELS) as (keyof typeof TF_LABELS)[]).map((k) => {
          const r = data.ranks[k];
          if (!r) return null;
          const isStrong = r.pct > 5;
          const isWeak = r.pct < -5;
          return (
            <div
              key={k}
              style={{ background: "rgba(0,0,0,0.3)", padding: "8px 10px" }}
            >
              <div className="text-[9px] uppercase text-[var(--color-text-secondary)]">
                {TF_LABELS[k].icon} {TF_LABELS[k].label}
              </div>
              <div className="text-base font-bold mt-1" style={{ color: isStrong ? "#22c55e" : isWeak ? "#fb923c" : "var(--color-text)" }}>
                #{r.rank}/{r.total}
              </div>
              <div className="text-[10px] mt-0.5" style={{ color: isStrong ? "#22c55e" : isWeak ? "#fb923c" : "var(--color-text-secondary)" }}>
                {r.pct >= 0 ? "+" : ""}{r.pct} vs 平均{r.avg}
              </div>
            </div>
          );
        })}
      </div>

      {/* セクター Top 10 */}
      <div>
        <div className="text-[10px] uppercase text-[var(--color-text-secondary)] mb-1">
          // セクター内 Top 10 (総合順)
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <tbody>
              {data.sectorTop.map((e, i) => {
                const isTarget = e.ticker === ticker;
                return (
                  <tr
                    key={e.ticker}
                    onClick={() => router.push(`/stock/${e.ticker}`)}
                    className="border-b border-[var(--color-border)]/30 hover:bg-[var(--color-accent)]/5 cursor-pointer"
                    style={{
                      background: isTarget ? "rgba(0,240,255,0.08)" : undefined,
                    }}
                  >
                    <td className="py-1 pr-1 text-[var(--color-text-secondary)] w-6 text-right">
                      #{i + 1}
                    </td>
                    <td className="px-2 text-[var(--color-accent)] font-bold w-12">
                      {e.ticker}
                    </td>
                    <td className="px-2 text-[var(--color-text)] truncate max-w-[120px]">
                      {e.name}
                    </td>
                    <td className="text-right px-2 font-bold">
                      {e.overall}
                    </td>
                    <td className="text-right px-2 text-[var(--color-text-secondary)]">
                      S{e.short}
                    </td>
                    <td className="text-right px-2 text-[var(--color-text-secondary)]">
                      M{e.mid}
                    </td>
                    <td className="text-right px-2 text-[var(--color-text-secondary)]">
                      L{e.long}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
