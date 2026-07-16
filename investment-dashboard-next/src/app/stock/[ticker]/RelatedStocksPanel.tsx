"use client";

/**
 * 🤝 関連銘柄パネル — 同業界・同テーマの銘柄を相対パフォーマンスで比較。
 *
 * matsunaga さんの「盲点発見」コンセプト:
 *   - 「みんな上がってるのにこれだけ動かない → 押し目 or ワケあり」
 *   - 「みんな下がってるのにこれだけ強い → 何かある」
 *
 * 銘柄詳細ページの下部に表示。所属セクターごとに peers を並べる。
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getSectorsForTicker, MACRO_DRIVER_LABELS } from "@/lib/jp-themes";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface Peer {
  ticker: string;
  name: string;
  overall: number;
  short: number;
  mid: number;
  long: number;
  price: number | null;
}

interface SectorTrend {
  id: string;
  name: string;
  emoji: string;
  category: "industry" | "theme";
  description: string;
  macroDrivers: string[];
  hotIndex: number;
  avgOverall: number | null;
  bullishRatio: number;
  bearishRatio: number;
  peers: Peer[];
}

interface Response {
  ok: boolean;
  industries: SectorTrend[];
  themes: SectorTrend[];
  error?: string;
}

function scoreColor(s: number): string {
  if (s >= 75) return "#22c55e";
  if (s >= 60) return "#7fffd4";
  if (s >= 45) return "#facc15";
  if (s >= 30) return "#fb923c";
  return "#ef4444";
}

interface SectorAnalysis {
  sector: SectorTrend;
  selfRank: number | null;        // ピア内順位 (1-N)、自分が peers にいなければ null
  selfPeer: Peer | null;          // 自分の peer エントリ
  selfVsAvg: number | null;       // 自分のスコア - セクター平均 (差分)
  diagnosis: "outperformer" | "in_line" | "underperformer" | "blind_spot" | "warning_sign" | null;
  diagnosisLabel: string;
  diagnosisDetail: string;
  diagnosisColor: string;
}

function analyzeSector(ticker: string, sector: SectorTrend): SectorAnalysis {
  const selfIdx = sector.peers.findIndex((p) => p.ticker === ticker);
  const selfPeer = selfIdx >= 0 ? sector.peers[selfIdx] : null;
  const selfRank = selfIdx >= 0 ? selfIdx + 1 : null;
  const selfVsAvg = selfPeer && sector.avgOverall !== null
    ? selfPeer.overall - sector.avgOverall
    : null;

  let diagnosis: SectorAnalysis["diagnosis"] = null;
  let diagnosisLabel = "";
  let diagnosisDetail = "";
  let diagnosisColor = "var(--color-text)";

  if (selfPeer === null || selfVsAvg === null) {
    diagnosisLabel = "—";
  } else {
    // セクターが追い風 (hot >= 60) なのに自分は弱い (vs avg -10pt以下) → 盲点 or ワケあり
    if (sector.hotIndex >= 60 && selfVsAvg <= -10) {
      diagnosis = "blind_spot";
      diagnosisLabel = "🔍 セクター追い風だが取り残されている";
      diagnosisDetail = `セクター ${sector.name} は Hot ${sector.hotIndex} だが、自分は平均より ${selfVsAvg.toFixed(0)}pt 下。押し目チャンス or 個別要因 (ワケあり) の可能性。要調査。`;
      diagnosisColor = "#facc15";
    }
    // セクターが逆風 (hot < 40) なのに自分は強い (vs avg +10pt以上) → 個別優位
    else if (sector.hotIndex < 40 && selfVsAvg >= 10) {
      diagnosis = "outperformer";
      diagnosisLabel = "🌟 セクター逆風でも逆行高";
      diagnosisDetail = `セクター ${sector.name} は Hot ${sector.hotIndex} と弱いが、自分は平均より +${selfVsAvg.toFixed(0)}pt 高い。個別要因の強さあり。`;
      diagnosisColor = "#22c55e";
    }
    // セクターが追い風 + 自分も強い → セクターの中の優等生
    else if (sector.hotIndex >= 60 && selfVsAvg >= 5) {
      diagnosis = "outperformer";
      diagnosisLabel = "🟢 セクター内優等生";
      diagnosisDetail = `セクター ${sector.name} (Hot ${sector.hotIndex}) の中でも平均より +${selfVsAvg.toFixed(0)}pt と上位。追い風 + 個別力の両方。`;
      diagnosisColor = "#22c55e";
    }
    // セクターが逆風 + 自分も弱い → ダブルパンチ
    else if (sector.hotIndex < 40 && selfVsAvg <= -5) {
      diagnosis = "warning_sign";
      diagnosisLabel = "⚠ セクター逆風 + 自身も弱い";
      diagnosisDetail = `セクター ${sector.name} (Hot ${sector.hotIndex}) も自分も弱い。新規エントリー慎重に。`;
      diagnosisColor = "#fb923c";
    }
    // それ以外は平均的
    else {
      diagnosis = "in_line";
      diagnosisLabel = "🟡 セクター平均並み";
      diagnosisDetail = `セクター ${sector.name} (Hot ${sector.hotIndex}) と並走、平均差 ${selfVsAvg >= 0 ? "+" : ""}${selfVsAvg.toFixed(0)}pt。`;
      diagnosisColor = "var(--color-text)";
    }
  }

  return { sector, selfRank, selfPeer, selfVsAvg, diagnosis, diagnosisLabel, diagnosisDetail, diagnosisColor };
}

export default function RelatedStocksPanel({ ticker }: { ticker: string }) {
  const router = useRouter();
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const tickerSectors = useMemo(() => getSectorsForTicker(ticker), [ticker]);

  useEffect(() => {
    if (tickerSectors.length === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetch(`/api/sectors/trends`)
      .then((r) => r.json())
      .then((j: Response) => {
        if (cancelled) return;
        setData(j);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [ticker, tickerSectors.length]);

  if (tickerSectors.length === 0) {
    return (
      <div className="p-4 border" style={{ borderColor: "var(--color-border)" }}>
        <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--color-text)] mb-2" style={MONO}>
          // RELATED_STOCKS
        </div>
        <div className="text-sm text-[var(--color-text)]" style={MONO}>
          この銘柄はCavkaのテーマ定義にまだ含まれていません。
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-4 border" style={{ borderColor: "var(--color-border)" }}>
        <div className="text-xs text-[var(--color-text)]" style={MONO}>// RELATED_STOCKS.loading ...</div>
      </div>
    );
  }
  if (!data?.ok) return null;

  const all = [...(data.industries ?? []), ...(data.themes ?? [])];
  const analyses = tickerSectors
    .map((ts) => all.find((s) => s.id === ts.id))
    .filter((x): x is SectorTrend => !!x)
    .map((s) => analyzeSector(ticker, s));

  if (analyses.length === 0) return null;

  return (
    <div
      className="p-5 border space-y-4"
      style={{ borderColor: "var(--color-accent)", background: "rgba(0,240,255,0.04)" }}
    >
      <div>
        <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--color-text)]" style={MONO}>
          // RELATED_STOCKS
        </div>
        <div className="text-xl font-bold text-[var(--color-accent)] mt-1">
          🤝 関連銘柄 (盲点発見)
        </div>
        <div className="text-sm text-[var(--color-text)] mt-1" style={MONO}>
          所属セクター: {analyses.length} ヶ所 · 同業他社との相対パフォーマンス比較
        </div>
      </div>

      {analyses.map((a) => (
        <SectorPeerBlock
          key={a.sector.id}
          analysis={a}
          currentTicker={ticker}
          onClickTicker={(t) => router.push(`/stock/${t}`)}
        />
      ))}
    </div>
  );
}

function SectorPeerBlock({
  analysis, currentTicker, onClickTicker,
}: {
  analysis: SectorAnalysis;
  currentTicker: string;
  onClickTicker: (ticker: string) => void;
}) {
  const { sector, selfRank, selfVsAvg, diagnosisLabel, diagnosisDetail, diagnosisColor } = analysis;
  const hotC = scoreColor(sector.hotIndex);

  return (
    <div className="border p-4 space-y-3" style={{ borderColor: hotC, background: `${hotC}08` }}>
      {/* ヘッダ: セクター名 + Hot Index */}
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <div className="text-2xl font-black text-[var(--color-text)]">
            {sector.emoji} {sector.name}
          </div>
          <div className="text-xs text-[var(--color-text)] mt-1" style={MONO}>
            {sector.description}
          </div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-black" style={{ color: hotC, ...MONO }}>
            Hot {sector.hotIndex}
          </div>
          <div className="text-xs text-[var(--color-text)]" style={MONO}>
            avg {sector.avgOverall ?? "—"} · {sector.peers.length}銘柄
          </div>
        </div>
      </div>

      {/* 診断 */}
      <div
        className="p-3 border-l-4"
        style={{ borderColor: diagnosisColor, background: `${diagnosisColor}10` }}
      >
        <div className="text-base font-bold mb-1" style={{ color: diagnosisColor }}>
          {diagnosisLabel}
        </div>
        <div className="text-sm text-[var(--color-text)]">
          {diagnosisDetail}
        </div>
        {selfRank !== null && (
          <div className="text-xs text-[var(--color-text)] mt-1" style={MONO}>
            セクター内順位: <span className="font-bold text-[var(--color-text)]">{selfRank} / {sector.peers.length}</span>
            {selfVsAvg !== null && (
              <span className="ml-2">
                平均差: <span className="font-bold" style={{ color: selfVsAvg >= 0 ? "#22c55e" : "#fb923c" }}>
                  {selfVsAvg >= 0 ? "+" : ""}{selfVsAvg.toFixed(0)}pt
                </span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* マクロ要因 */}
      {sector.macroDrivers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
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
      )}

      {/* peers リスト (自分をハイライト) */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={MONO}>
          <thead>
            <tr className="border-b border-[var(--color-border)] text-xs text-[var(--color-text)]">
              <th className="text-left py-2 px-2 font-bold">#</th>
              <th className="text-left px-2 font-bold">銘柄</th>
              <th className="text-center px-2 font-bold">総合</th>
              <th className="text-center px-2 font-bold">短期</th>
              <th className="text-center px-2 font-bold">中期</th>
              <th className="text-center px-2 font-bold">長期</th>
            </tr>
          </thead>
          <tbody>
            {sector.peers.map((p, i) => {
              const isSelf = p.ticker === currentTicker;
              return (
                <tr
                  key={p.ticker}
                  onClick={() => !isSelf && onClickTicker(p.ticker)}
                  className={`border-b border-[var(--color-border)]/30 ${!isSelf ? "cursor-pointer hover:bg-white/5" : ""}`}
                  style={isSelf ? { background: "rgba(0,240,255,0.15)" } : undefined}
                >
                  <td className={`py-2 px-2 text-base font-black ${isSelf ? "text-[var(--color-accent)]" : "text-[var(--color-text)]"}`}>
                    {i + 1}
                  </td>
                  <td className="px-2">
                    <span className={`font-bold ${isSelf ? "text-[var(--color-accent)]" : "text-[var(--color-text)]"}`}>
                      {p.ticker}
                    </span>
                    <span className="ml-2 text-[var(--color-text)]">{p.name}</span>
                    {isSelf && <span className="ml-2 text-xs text-[var(--color-accent)]">← この銘柄</span>}
                  </td>
                  <td className="text-center px-2">
                    <span className="text-xl font-black" style={{ color: scoreColor(p.overall) }}>
                      {p.overall}
                    </span>
                  </td>
                  <td className="text-center px-2" style={{ color: scoreColor(p.short) }}>{p.short}</td>
                  <td className="text-center px-2" style={{ color: scoreColor(p.mid) }}>{p.mid}</td>
                  <td className="text-center px-2" style={{ color: scoreColor(p.long) }}>{p.long}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
