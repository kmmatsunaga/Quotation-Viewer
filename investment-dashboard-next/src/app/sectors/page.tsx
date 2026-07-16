"use client";

/**
 * /sectors - 業界/テーマトレンド分析ダッシュボード
 *
 * 各セクター (18 業界 + 7 テーマ) の Hot Index を一覧、ヒートマップ表示。
 * クリックで詳細 (構成銘柄 Top Pick、Weakest、連動マクロ要因)。
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface SectorPick { ticker: string; name: string; overall: number; mid: number; long: number }

interface SectorTrend {
  id: string;
  name: string;
  emoji: string;
  category: "industry" | "theme";
  description: string;
  macroDrivers: string[];
  totalTickers: number;
  matchedTickers: number;
  coverage: number;
  avgOverall: number | null;
  avgShort: number | null;
  avgMid: number | null;
  avgLong: number | null;
  bullishRatio: number;
  bearishRatio: number;
  topPicks: SectorPick[];
  weakest: SectorPick[];
  hotIndex: number;
}

interface Response {
  ok: boolean;
  cached?: boolean;
  ageHours?: number;
  sourceDate?: string;
  sourceEntries?: number;
  industries: SectorTrend[];
  themes: SectorTrend[];
  hotTop10: SectorTrend[];
  coldTop10: SectorTrend[];
  computedAtIso: string;
  elapsedMs: number;
  error?: string;
}

const MACRO_DRIVER_LABELS: Record<string, string> = {
  fx_weak_yen: "💴 円安追風",
  fx_strong_yen: "💴 円高追風",
  fed_hike: "🇺🇸 FRB利上げ追風",
  fed_cut: "🇺🇸 FRB利下げ追風",
  boj_hike: "🇯🇵 日銀利上げ追風",
  boj_dovish: "🇯🇵 日銀緩和追風",
  china_demand: "🇨🇳 中国需要追風",
  oil_high: "🛢 原油高追風",
  oil_low: "🛢 原油安追風",
  recession_low: "📈 景気拡大追風",
  inbound: "✈ インバウンド追風",
  consumer_strong: "🛒 消費堅調追風",
};

function hotColor(hot: number): string {
  if (hot >= 75) return "#22c55e";
  if (hot >= 60) return "#7fffd4";
  if (hot >= 45) return "#facc15";
  if (hot >= 30) return "#fb923c";
  return "#ef4444";
}

function scoreColor(s: number | null): string {
  if (s === null) return "var(--color-text-secondary)";
  if (s >= 75) return "#22c55e";
  if (s >= 60) return "#7fffd4";
  if (s >= 45) return "#facc15";
  if (s >= 30) return "#fb923c";
  return "#ef4444";
}

export default function SectorsPage() {
  const router = useRouter();
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "industry" | "theme">("all");

  useEffect(() => {
    fetch(`/api/sectors/trends`)
      .then((r) => r.json())
      .then((j: Response) => {
        if (!j.ok) setError(j.error ?? "取得失敗");
        else setData(j);
        setLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, []);

  const visible = useMemo(() => {
    if (!data) return [];
    const all = [...data.industries, ...data.themes];
    return filter === "all" ? all : all.filter((s) => s.category === filter);
  }, [data, filter]);

  const selectedSector = useMemo(
    () => visible.find((s) => s.id === selected) ?? null,
    [visible, selected]
  );

  return (
    <div className="space-y-4">
      {/* ヘッダ */}
      <div>
        <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">
          🏭 業界/テーマトレンド
        </h1>
        <p className="text-[14px] text-[var(--color-text-secondary)] mt-1.5 leading-relaxed">
          18業界 + 7テーマの Hot Index・構成銘柄・連動マクロ要因
        </p>
      </div>

      {/* メタ */}
      {data && (
        <div
          className="p-3 border grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm"
          style={{ ...MONO, borderColor: "var(--color-border)", background: "rgba(0,0,0,0.25)" }}
        >
          <div>
            <div className="text-xs font-bold text-[var(--color-text)]">ソース</div>
            <div className="text-base font-black text-[var(--color-text)] mt-1">
              score_rankings {data.sourceDate}
            </div>
          </div>
          <div>
            <div className="text-xs font-bold text-[var(--color-text)]">対象銘柄</div>
            <div className="text-base font-black text-[var(--color-text)] mt-1">
              {data.sourceEntries} 銘柄
            </div>
          </div>
          <div>
            <div className="text-xs font-bold text-[var(--color-text)]">業界 / テーマ</div>
            <div className="text-base font-black text-[var(--color-text)] mt-1">
              {data.industries.length} / {data.themes.length}
            </div>
          </div>
          <div>
            <div className="text-xs font-bold text-[var(--color-text)]">取得</div>
            <div className="text-base font-black text-[var(--color-text)] mt-1">
              {data.cached ? `cached ${data.ageHours}h前` : "fresh"}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="p-3 border border-red-500/40 text-sm text-red-400" style={MONO}>⚠ {error}</div>
      )}

      {loading && !data ? (
        <div className="text-center py-20 text-[var(--color-text)] text-sm" style={MONO}>読み込み中...</div>
      ) : data ? (
        <>
          {/* Hot/Cold Top */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div
              className="p-4 border"
              style={{ borderColor: "rgba(34,197,94,0.4)", background: "rgba(34,197,94,0.05)" }}
            >
              <div className="text-sm font-bold text-[#22c55e] mb-3" style={MONO}>🔥 Hot Top 5 (熱い順)</div>
              <div className="space-y-2">
                {data.hotTop10.slice(0, 5).map((s, i) => (
                  <SectorRowCompact key={s.id} rank={i + 1} sector={s} onClick={() => setSelected(s.id)} />
                ))}
              </div>
            </div>
            <div
              className="p-4 border"
              style={{ borderColor: "rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.05)" }}
            >
              <div className="text-sm font-bold text-[#fb923c] mb-3" style={MONO}>❄ Cold Top 5 (冷たい順)</div>
              <div className="space-y-2">
                {data.coldTop10.slice(0, 5).map((s, i) => (
                  <SectorRowCompact key={s.id} rank={i + 1} sector={s} onClick={() => setSelected(s.id)} />
                ))}
              </div>
            </div>
          </div>

          {/* フィルタ */}
          <div className="flex gap-2 items-center text-sm" style={MONO}>
            <span className="text-[var(--color-text)] font-bold">表示:</span>
            {(["all", "industry", "theme"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className="px-3 py-1.5"
                style={{
                  border: `1px solid ${filter === f ? "var(--color-accent)" : "var(--color-border)"}`,
                  color: filter === f ? "var(--color-accent)" : "var(--color-text)",
                  background: filter === f ? "rgba(0,240,255,0.08)" : "transparent",
                }}
              >
                {f === "all" ? "全部" : f === "industry" ? "業界" : "テーマ"}
              </button>
            ))}
          </div>

          {/* ヒートマップ */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {visible.map((s) => {
              const c = hotColor(s.hotIndex);
              return (
                <button
                  key={s.id}
                  onClick={() => setSelected(s.id)}
                  className="p-3 border text-left transition-all hover:scale-[1.03]"
                  style={{
                    borderColor: c,
                    background: `${c}15`,
                    boxShadow: selected === s.id ? `0 0 16px ${c}90` : `0 0 4px ${c}30`,
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-bold text-[var(--color-text)]">
                      {s.emoji} {s.name}
                    </div>
                  </div>
                  <div className="flex items-baseline gap-1 mt-1">
                    <div className="text-3xl font-black leading-none" style={{ color: c, ...MONO }}>
                      {s.hotIndex}
                    </div>
                    <div className="text-xs text-[var(--color-text)]" style={MONO}>/100</div>
                  </div>
                  <div className="text-xs text-[var(--color-text)] mt-1" style={MONO}>
                    avg <span className="font-bold" style={{ color: scoreColor(s.avgOverall) }}>{s.avgOverall ?? "—"}</span>
                    <span className="ml-2">{s.matchedTickers}/{s.totalTickers}銘柄</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* 詳細パネル */}
          {selectedSector && (
            <SectorDetail
              sector={selectedSector}
              onClose={() => setSelected(null)}
              onTickerClick={(t) => router.push(`/stock/${t}`)}
            />
          )}
        </>
      ) : null}
    </div>
  );
}

function SectorRowCompact({
  rank, sector, onClick,
}: { rank: number; sector: SectorTrend; onClick: () => void }) {
  const c = hotColor(sector.hotIndex);
  return (
    <button onClick={onClick} className="w-full p-2 flex items-center gap-3 text-left hover:bg-white/5">
      <div className="text-base font-black w-6 text-right" style={{ color: c, ...MONO }}>#{rank}</div>
      <div className="text-xl">{sector.emoji}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold text-[var(--color-text)]">{sector.name}</div>
        <div className="text-xs text-[var(--color-text)]" style={MONO}>
          avg {sector.avgOverall ?? "—"} · bull {Math.round(sector.bullishRatio * 100)}% / bear {Math.round(sector.bearishRatio * 100)}%
        </div>
      </div>
      <div className="text-2xl font-black" style={{ color: c, ...MONO }}>{sector.hotIndex}</div>
    </button>
  );
}

function SectorDetail({
  sector, onClose, onTickerClick,
}: { sector: SectorTrend; onClose: () => void; onTickerClick: (t: string) => void }) {
  const c = hotColor(sector.hotIndex);
  return (
    <div
      className="p-5 border space-y-4"
      style={{ borderColor: c, background: `${c}10`, boxShadow: `0 0 24px ${c}40` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-3xl font-black" style={{ color: c }}>
            {sector.emoji} {sector.name}
          </div>
          <div className="text-sm text-[var(--color-text)] mt-1" style={MONO}>
            {sector.description}
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-sm text-[var(--color-text)] hover:text-[var(--color-accent)] px-2 py-1"
          style={MONO}
        >
          ✕ 閉じる
        </button>
      </div>

      {/* スコア・統計 */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Stat label="🔥 Hot Index" value={String(sector.hotIndex)} color={c} big />
        <Stat label="平均スコア" value={sector.avgOverall !== null ? String(sector.avgOverall) : "—"} color={scoreColor(sector.avgOverall)} />
        <Stat label="🟢 強気率" value={`${Math.round(sector.bullishRatio * 100)}%`} color="#7fffd4" />
        <Stat label="🟠 弱気率" value={`${Math.round(sector.bearishRatio * 100)}%`} color="#fb923c" />
        <Stat label="カバー" value={`${sector.matchedTickers}/${sector.totalTickers}`} color="var(--color-text)" />
      </div>

      {/* 時間軸別平均 */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="🔥 短期平均" value={sector.avgShort !== null ? String(sector.avgShort) : "—"} color={scoreColor(sector.avgShort)} />
        <Stat label="📈 中期平均" value={sector.avgMid !== null ? String(sector.avgMid) : "—"} color={scoreColor(sector.avgMid)} />
        <Stat label="🏛 長期平均" value={sector.avgLong !== null ? String(sector.avgLong) : "—"} color={scoreColor(sector.avgLong)} />
      </div>

      {/* マクロ要因 */}
      {sector.macroDrivers.length > 0 && (
        <div>
          <div className="text-sm font-bold text-[var(--color-text)] mb-2" style={MONO}>🌐 連動マクロ要因</div>
          <div className="flex flex-wrap gap-2">
            {sector.macroDrivers.map((d) => (
              <span
                key={d}
                className="text-xs px-2 py-1 border"
                style={{ ...MONO, borderColor: "var(--color-accent)", color: "var(--color-accent)" }}
              >
                {MACRO_DRIVER_LABELS[d] ?? d}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 構成銘柄 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <div className="text-sm font-bold text-[#7fffd4] mb-2" style={MONO}>🟢 Top Picks (スコア上位)</div>
          <div className="space-y-1">
            {sector.topPicks.map((p) => (
              <button
                key={p.ticker}
                onClick={() => onTickerClick(p.ticker)}
                className="w-full p-2 flex items-center gap-2 text-left hover:bg-white/5 border border-[var(--color-border)]"
              >
                <span className="text-sm font-bold text-[var(--color-accent)]" style={MONO}>{p.ticker}</span>
                <span className="text-sm text-[var(--color-text)] flex-1 truncate">{p.name}</span>
                <span className="text-base font-black" style={{ ...MONO, color: scoreColor(p.overall) }}>{p.overall}</span>
                <span className="text-xs text-[var(--color-text)]" style={MONO}>S{p.mid}/L{p.long}</span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-sm font-bold text-[#fb923c] mb-2" style={MONO}>🟠 Weakest (要注意 or 押し目候補)</div>
          <div className="space-y-1">
            {sector.weakest.map((p) => (
              <button
                key={p.ticker}
                onClick={() => onTickerClick(p.ticker)}
                className="w-full p-2 flex items-center gap-2 text-left hover:bg-white/5 border border-[var(--color-border)]"
              >
                <span className="text-sm font-bold text-[var(--color-accent)]" style={MONO}>{p.ticker}</span>
                <span className="text-sm text-[var(--color-text)] flex-1 truncate">{p.name}</span>
                <span className="text-base font-black" style={{ ...MONO, color: scoreColor(p.overall) }}>{p.overall}</span>
                <span className="text-xs text-[var(--color-text)]" style={MONO}>S{p.mid}/L{p.long}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color, big }: { label: string; value: string; color: string; big?: boolean }) {
  return (
    <div className="p-2 border flex flex-col items-center text-center" style={{ borderColor: `${color}55`, background: `${color}0d` }}>
      <div className="text-xs font-bold text-[var(--color-text)]">{label}</div>
      <div className={`${big ? "text-3xl" : "text-2xl"} font-black mt-1`} style={{ color, ...MONO }}>{value}</div>
    </div>
  );
}
