"use client";

/**
 * Cavka Verdict Cockpit — 見解の合議を「見る」パネル
 *
 * Master Score (加重平均で1つの数字) と違い、こちらは:
 *   - 短期/中期/長期で別々の評決
 *   - 証人 (各データソース) の賛否を明示
 *   - 対立している時は「対立している」と堂々と表示
 *
 * 証人収集は verdict-witnesses (cron と共用)。
 * 需給 (立花 snapshot) はブラウザ限定なのでここで追加する。
 */

import { useEffect, useMemo, useState } from "react";
import {
  aggregateVerdicts,
  STANCE_META,
  TF_LABELS,
  type Witness,
  type Timeframe,
  type TimeframeVerdict,
} from "@/lib/verdict-engine";
import { collectWitnesses } from "@/lib/verdict-witnesses";
import { useTachibanaSnapshot } from "./TachibanaSnapshotContext";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

const clip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

interface MarginLike {
  margin: { ratioTotal: number | null; shortTotal: number | null; longTotal: number | null } | null;
  hibu: { rate: number | null } | null;
}

export default function VerdictCockpit({ ticker }: { ticker: string }) {
  const snapshot = useTachibanaSnapshot();
  const [witnesses, setWitnesses] = useState<Witness[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedTf, setExpandedTf] = useState<Timeframe | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    collectWitnesses(ticker, "").then(({ witnesses: ws }) => {
      if (cancelled) return;
      setWitnesses(ws);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [ticker]);

  // ── 需給 (立花 snapshot、遅延到着するので別管理) ──
  const supplyWitness = useMemo<Witness | null>(() => {
    const d = snapshot.margin as MarginLike | null;
    const ratio = d?.margin?.ratioTotal ?? null;
    const hibu = d?.hibu?.rate ?? null;
    if (ratio === null) return null;
    let dir = 0;
    let reason = `信用倍率 ${ratio.toFixed(1)}倍`;
    if (ratio < 1) { dir = 0.5; reason += " (売残>買残、踏み上げ余地)"; }
    else if (ratio < 3) { dir = 0.2; reason += " (需給締まり気味)"; }
    else if (ratio > 20) { dir = -0.4; reason += " (買い偏重、利食い圧力)"; }
    else { dir = 0; reason += " (中立)"; }
    if (hibu !== null && hibu > 0) { dir = clip(dir + 0.2, -1, 1); reason += ` + 逆日歩発生`; }
    return {
      id: "supply", label: "需給 (信用残)", emoji: "🏦",
      direction: dir, confidence: 0.8, weight: 2,
      timeframes: ["short"], reason,
    };
  }, [snapshot.margin]);

  const result = useMemo(() => {
    if (!witnesses) return null;
    const all = supplyWitness ? [...witnesses, supplyWitness] : witnesses;
    if (all.length === 0) return null;
    return aggregateVerdicts(all);
  }, [witnesses, supplyWitness]);

  if (loading) {
    return (
      <div className="p-5 border" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
        <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--color-text-secondary)]" style={MONO}>
          // CAVKA_VERDICT.CONVENING ... 証人を招集中
        </div>
      </div>
    );
  }

  if (!result) return null;

  const hasContested = Object.values(result.verdicts).some((v) => v.stance === "contested");

  return (
    <div
      className="p-5 border space-y-4"
      style={{
        borderColor: hasContested ? "#a78bfa" : "var(--color-accent)",
        background: "linear-gradient(180deg, rgba(0,240,255,0.05) 0%, rgba(0,0,0,0.15) 100%)",
        boxShadow: hasContested ? "0 0 24px rgba(167,139,250,0.25)" : "0 0 24px rgba(0,240,255,0.15)",
      }}
    >
      {/* ヘッダ + 総括 */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--color-text-secondary)]" style={MONO}>
            // CAVKA_VERDICT — 見解の合議
          </div>
          <div className="text-base font-bold text-[var(--color-text)] mt-1" style={MONO}>
            {result.overallNote}
          </div>
        </div>
        <div className="text-xs text-[var(--color-text-secondary)]" style={MONO}>
          証人 {result.witnessCount} 名
        </div>
      </div>

      {/* 時間軸 3 カード */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {(["short", "mid", "long"] as Timeframe[]).map((tf) => (
          <VerdictCard
            key={tf}
            v={result.verdicts[tf]}
            expanded={expandedTf === tf}
            onToggle={() => setExpandedTf(expandedTf === tf ? null : tf)}
          />
        ))}
      </div>
    </div>
  );
}

function VerdictCard({ v, expanded, onToggle }: { v: TimeframeVerdict; expanded: boolean; onToggle: () => void }) {
  const meta = STANCE_META[v.stance];
  return (
    <button
      onClick={onToggle}
      className="text-left p-4 border space-y-3 transition-all hover:brightness-110"
      style={{
        borderColor: `${meta.color}66`,
        background: `${meta.color}0d`,
        boxShadow: v.stance === "contested" ? `0 0 14px ${meta.color}30` : undefined,
      }}
    >
      {/* 時間軸ラベル */}
      <div className="text-xs font-bold text-[var(--color-text)]" style={MONO}>
        {TF_LABELS[v.timeframe]}
      </div>

      {/* スタンス (主役表示) */}
      <div className="flex items-baseline gap-3">
        <span className="text-3xl font-black leading-none" style={{ color: meta.color }}>
          {meta.emoji} {meta.label}
        </span>
      </div>

      {/* 確信度 + 合意度 */}
      <div className="flex items-baseline gap-4" style={MONO}>
        <div>
          <span className="text-4xl font-black leading-none" style={{ color: meta.color }}>{v.conviction}</span>
          <span className="text-xs text-[var(--color-text)] ml-1">% 確信</span>
        </div>
        <div className="text-xs text-[var(--color-text)]">
          合意 {Math.round(v.consensus * 100)}%
        </div>
      </div>

      {/* 賛否チップ */}
      <div className="flex flex-wrap gap-1">
        {v.bulls.map((w) => (
          <span key={w.id} title={w.reason} className="text-[10px] px-1.5 py-0.5" style={{ background: "rgba(255,59,107,0.12)", color: "#ff3b6b", border: "1px solid rgba(255,59,107,0.35)", ...MONO }}>
            {w.emoji} {w.label}
          </span>
        ))}
        {v.bears.map((w) => (
          <span key={w.id} title={w.reason} className="text-[10px] px-1.5 py-0.5" style={{ background: "rgba(0,217,255,0.12)", color: "#00d9ff", border: "1px solid rgba(0,217,255,0.35)", ...MONO }}>
            {w.emoji} {w.label}
          </span>
        ))}
        {v.neutrals.map((w) => (
          <span key={w.id} title={w.reason} className="text-[10px] px-1.5 py-0.5 opacity-60" style={{ background: "rgba(250,204,21,0.08)", color: "#facc15", border: "1px solid rgba(250,204,21,0.25)", ...MONO }}>
            {w.emoji} {w.label}
          </span>
        ))}
      </div>

      {/* 対立バッジ */}
      {v.conflicts.length > 0 && (
        <div className="text-[11px] p-2 border-l-4" style={{ borderColor: "#a78bfa", background: "rgba(167,139,250,0.08)", color: "var(--color-text)", ...MONO }}>
          ⚡ {v.conflicts[0].bullLabel} vs {v.conflicts[0].bearLabel}
          {expanded && <div className="mt-1 opacity-80">{v.conflicts[0].note}</div>}
        </div>
      )}

      {/* 評決文 */}
      <div className="text-xs leading-relaxed text-[var(--color-text)]" style={MONO}>
        {v.narrative}
      </div>

      {/* 展開時: 全証言の詳細 */}
      {expanded && (
        <div className="pt-2 border-t border-[var(--color-border)] space-y-1">
          {[...v.bulls, ...v.bears, ...v.neutrals].map((w) => (
            <div key={w.id} className="text-[10px] flex items-start gap-1.5" style={MONO}>
              <span style={{ color: w.direction >= 0.15 ? "#ff3b6b" : w.direction <= -0.15 ? "#00d9ff" : "#facc15" }}>
                {w.direction >= 0.15 ? "▲" : w.direction <= -0.15 ? "▼" : "─"}
              </span>
              <span className="text-[var(--color-text)]">
                {w.emoji} <strong>{w.label}</strong>: {w.reason}
              </span>
            </div>
          ))}
        </div>
      )}
    </button>
  );
}
