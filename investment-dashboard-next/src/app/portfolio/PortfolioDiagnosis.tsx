"use client";

/**
 * 🩺 ポートフォリオ診断パネル
 *
 * 既存パネル (将来性ヘルス / 地形 / マクロ感応度) は「銘柄ごとの評価」だが、
 * ここは「ポートフォリオを一つの塊として見たときの数学」を出す。
 * 過去250営業日の実リターンから計算した事実のみ。予測は含まない。
 */

import { useEffect, useState } from "react";
import { GlossaryBox } from "@/components/CommentaryPanel";
import { useAuth } from "@/lib/auth-context";
import { getInvestorProfile } from "@/lib/firestore";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface Diagnosis {
  totalValue: number;
  holdingCount: number;
  topWeightPct: number;
  top3WeightPct: number;
  effectiveStocks: number;
  industryTop: { industry: string; weightPct: number; tickers: string[] }[];
  avgCorrelation: number | null;
  diversificationRatio: number | null;
  effectiveIndependent: number | null;
  portfolioVolPct: number | null;
  annualVolPct: number | null;
  beta: number | null;
  riskContrib: { ticker: string; name: string; weightPct: number; riskPct: number }[];
  downCapturePct: number | null;
  upCapturePct: number | null;
  worstDay: { date: string; portPct: number; nikkeiPct: number } | null;
  maxDrawdownPct: number | null;
  bigDropDays: { date: string; portPct: number; nikkeiPct: number }[];
  winners: number;
  losers: number;
  avgWinPct: number | null;
  avgLossPct: number | null;
  findings: { level: "critical" | "warn" | "info" | "good"; text: string }[];
  daysUsed: number;
}

const LEVEL: Record<string, { color: string; icon: string }> = {
  critical: { color: "#ef4444", icon: "🔴" },
  warn: { color: "#facc15", icon: "🟡" },
  info: { color: "#38bdf8", icon: "ℹ" },
  good: { color: "#22c55e", icon: "✓" },
};

interface GapFinding { level: "critical" | "warn" | "info" | "good"; declared: string; measured: string; comment: string }
interface GoalCalc { targetAmount: number; months: number; monthlyAdd: number; currentTotal: number; requiredCagrPct: number | null; note: string; expired: boolean }

export interface DiagInput { ticker: string; name: string; value: number; pnlPct: number | null }

export default function PortfolioDiagnosis({ holdings, cashJpy = 0 }: { holdings: DiagInput[]; cashJpy?: number }) {
  const { user } = useAuth();
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const [gaps, setGaps] = useState<GapFinding[]>([]);
  const [goal, setGoal] = useState<GoalCalc | null>(null);
  const [hasProfile, setHasProfile] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const key = holdings.map((h) => `${h.ticker}:${Math.round(h.value)}`).join(",");
  useEffect(() => {
    if (holdings.length === 0) return;
    let cancelled = false;
    setLoading(true); setError(null);
    (async () => {
      // 問診票があれば一緒に送る (宣言と実測の照合用)
      let profile: Record<string, unknown> | null = null;
      if (user) {
        try {
          const p = await getInvestorProfile(user.uid);
          profile = (p?.answers as Record<string, unknown>) ?? null;
        } catch { /* 未回答でも診断自体は動く */ }
      }
      if (cancelled) return;
      setHasProfile(!!profile && Object.keys(profile).length > 0);
      return fetch("/api/portfolio/diagnose", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holdings, profile, cashJpy }),
      })
        .then(async (r) => {
          const j = await r.json().catch(() => null);
          if (cancelled) return;
          if (!r.ok || !j?.ok) throw new Error(j?.error ?? `API ${r.status}`);
          setDiag(j.diagnosis ?? null);
          setGaps(j.gaps ?? []);
          setGoal(j.goal ?? null);
          if (!j.diagnosis) setError(j.reason ?? "診断できませんでした");
        });
    })()
      .catch((e) => { if (!cancelled) { console.error("[diagnose]", e); setError(e.message); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, user, cashJpy]);

  if (holdings.length === 0) return null;

  const Card = ({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) => (
    <div className="px-2.5 py-2 rounded" style={{ background: "rgba(0,240,255,0.03)", border: "1px solid rgba(0,240,255,0.08)" }}>
      <div className="text-[9px] text-[var(--color-text-secondary)] mb-0.5" style={MONO}>{label}</div>
      <div className="text-sm font-bold" style={{ ...MONO, color: color ?? "var(--color-text)" }}>{value}</div>
      {sub && <div className="text-[9px] text-[var(--color-text-secondary)] mt-0.5">{sub}</div>}
    </div>
  );

  return (
    <div className="rounded-lg" style={{ background: "var(--bg-card)", border: "1px solid rgba(0,240,255,0.10)" }}>
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>
          🩺 ポートフォリオ診断
        </span>
        {diag && (
          <span className="text-[9px] text-[var(--color-text-secondary)]" style={MONO}>
            過去{diag.daysUsed}営業日の実データ
          </span>
        )}
      </div>

      {loading && <div className="px-4 pb-3 text-[11px] text-[var(--color-text-secondary)]" style={MONO}>計算中…</div>}
      {error && !loading && (
        <div className="px-4 pb-3 text-[11px]" style={{ ...MONO, color: "#facc15" }}>⚠ {error}</div>
      )}

      {diag && !loading && (
        <>
          {/* 🪞 宣言と実測の照合 (問診票がある時だけ。ここが一番効く) */}
          {gaps.length > 0 && (
            <div className="mx-4 mb-3 rounded" style={{ background: "rgba(0,240,255,0.04)", border: "1px solid rgba(0,240,255,0.15)" }}>
              <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>
                🪞 あなたの宣言 ↔ 実測
              </div>
              <div className="px-3 pb-2 space-y-2">
                {gaps.map((g, i) => (
                  <div key={i} className="text-[12px] leading-relaxed">
                    <div className="flex gap-1.5">
                      <span className="shrink-0">{LEVEL[g.level].icon}</span>
                      <div>
                        <span className="text-[var(--color-text-secondary)]">宣言: </span>
                        <span>{g.declared}</span>
                        <span className="mx-1.5" style={{ color: LEVEL[g.level].color }}>→</span>
                        <span className="text-[var(--color-text-secondary)]">実測: </span>
                        <span className="font-bold" style={{ color: LEVEL[g.level].color }}>{g.measured}</span>
                        <div className="text-[11px] text-[var(--color-text-secondary)]">{g.comment}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {goal && (
                <div className="px-3 pb-2 text-[11px] border-t border-white/5 pt-1.5"
                  style={{ color: goal.expired ? "#facc15" : "var(--color-text-secondary)" }}>
                  🎯 {goal.expired ? "" : `目標 ${goal.targetAmount.toLocaleString("ja-JP")}円 まで残り約${goal.months}ヶ月 — `}{goal.note}
                  {goal.requiredCagrPct != null && diag.annualVolPct != null && (
                    <span>
                      {" "}(この構成の年率ボラは {diag.annualVolPct}% — 必要リターンに対して振れ幅がどれくらいかの目安)
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
          {hasProfile === false && (
            <div className="mx-4 mb-3 px-3 py-2 rounded text-[11px]" style={{ background: "rgba(0,240,255,0.03)", border: "1px dashed rgba(0,240,255,0.2)" }}>
              🩺 <a href="/profile" className="underline" style={{ color: "var(--color-accent)" }}>投資家問診票</a> に答えると、
              ここに「自分で決めたルールを守れているか」の照合が追加されます
            </div>
          )}

          {/* 所見 (最重要。ここだけ読めば要点が分かる) */}
          <div className="px-4 pb-2 space-y-1">
            {diag.findings.map((f, i) => (
              <div key={i} className="flex gap-1.5 text-[12px] leading-relaxed">
                <span className="shrink-0">{LEVEL[f.level].icon}</span>
                <span style={{ color: f.level === "good" ? "var(--color-text-secondary)" : "var(--color-text)" }}>{f.text}</span>
              </div>
            ))}
          </div>

          {/* 主要指標 */}
          <div className="px-4 pb-3 grid grid-cols-2 md:grid-cols-5 gap-1.5">
            <Card
              label="実質的な分散"
              value={diag.effectiveIndependent != null ? `${diag.effectiveIndependent}銘柄分` : "—"}
              sub={`保有${diag.holdingCount}銘柄`}
              color={diag.effectiveIndependent != null && diag.effectiveIndependent < 2 ? "#facc15" : undefined}
            />
            <Card
              label="年率ボラティリティ"
              value={diag.annualVolPct != null ? `${diag.annualVolPct}%` : "—"}
              sub="値動きの荒さ"
              color={diag.annualVolPct != null && diag.annualVolPct >= 35 ? "#facc15" : undefined}
            />
            <Card
              label="β (日経感応度)"
              value={diag.beta != null ? `${diag.beta}` : "—"}
              sub={diag.beta != null ? `日経-5%で ${(diag.beta * -5).toFixed(1)}%` : undefined}
              color={diag.beta != null && diag.beta >= 1.4 ? "#facc15" : undefined}
            />
            <Card
              label="上げ / 下げ捕捉"
              value={diag.upCapturePct != null && diag.downCapturePct != null ? `${diag.upCapturePct} / ${diag.downCapturePct}` : "—"}
              sub="下げ<上げ が理想"
              color={diag.downCapturePct != null && diag.upCapturePct != null && diag.downCapturePct > diag.upCapturePct ? "#ef4444" : "#22c55e"}
            />
            <Card
              label="最大ドローダウン"
              value={diag.maxDrawdownPct != null ? `${diag.maxDrawdownPct}%` : "—"}
              sub="この構成の過去実績"
              color={diag.maxDrawdownPct != null && diag.maxDrawdownPct <= -25 ? "#ef4444" : undefined}
            />
          </div>

          <button
            onClick={() => setOpen((v) => !v)}
            className="w-full text-left px-4 py-1.5 text-[11px]"
            style={{ color: "var(--color-accent)", ...MONO, borderTop: "1px solid rgba(255,255,255,0.05)" }}
          >
            {open ? "▼" : "▶"} 内訳を見る (業種構成 / リスクの出どころ / 暴落日の実績)
          </button>

          {open && (
            <div className="px-4 pb-3 space-y-3">
              {/* 業種構成 */}
              <div>
                <div className="text-[10px] text-[var(--color-text-secondary)] mb-1" style={MONO}>業種構成</div>
                {diag.industryTop.map((s) => (
                  <div key={s.industry} className="flex items-center gap-2 mb-0.5">
                    <div className="text-[11px] w-52 truncate" title={s.tickers.join(", ")}>{s.industry}</div>
                    <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(148,163,184,0.15)" }}>
                      <div className="h-full rounded-full" style={{ width: `${Math.min(s.weightPct, 100)}%`, background: s.weightPct >= 50 ? "#ef4444" : s.weightPct >= 35 ? "#facc15" : "var(--color-accent)" }} />
                    </div>
                    <div className="text-[11px] w-12 text-right tabular-nums" style={MONO}>{s.weightPct}%</div>
                  </div>
                ))}
              </div>

              {/* リスク寄与 */}
              {diag.riskContrib.length > 0 && (
                <div>
                  <div className="text-[10px] text-[var(--color-text-secondary)] mb-1" style={MONO}>
                    リスクの出どころ (資産比率 → 値動きへの寄与)
                  </div>
                  {diag.riskContrib.map((r) => {
                    const gap = r.riskPct - r.weightPct;
                    return (
                      <div key={r.ticker} className="flex items-center gap-2 text-[11px] mb-0.5">
                        <span className="w-40 truncate">{r.name}</span>
                        <span className="tabular-nums text-[var(--color-text-secondary)]" style={MONO}>{r.weightPct}%</span>
                        <span className="text-[var(--color-text-secondary)]">→</span>
                        <span className="tabular-nums font-bold" style={{ ...MONO, color: gap >= 10 ? "#facc15" : "var(--color-text)" }}>{r.riskPct}%</span>
                        {gap >= 10 && <span className="text-[9px]" style={{ color: "#facc15" }}>比率以上にリスクを作っている</span>}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 暴落日の実績 */}
              {diag.bigDropDays.length > 0 && (
                <div>
                  <div className="text-[10px] text-[var(--color-text-secondary)] mb-1" style={MONO}>
                    日経が-2%以上下げた日、この構成はどうなったか (実測)
                  </div>
                  {diag.bigDropDays.map((d) => (
                    <div key={d.date} className="flex items-center gap-3 text-[11px]" style={MONO}>
                      <span className="text-[var(--color-text-secondary)] w-20">{d.date}</span>
                      <span className="w-24">日経 {d.nikkeiPct}%</span>
                      <span style={{ color: d.portPct < d.nikkeiPct ? "#ef4444" : "#22c55e" }}>
                        自分 {d.portPct}%
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* 損益構造 */}
              {(diag.winners > 0 || diag.losers > 0) && (
                <div className="text-[11px] text-[var(--color-text-secondary)]">
                  含み益 {diag.winners}銘柄 (平均 {diag.avgWinPct != null ? `+${diag.avgWinPct}%` : "—"}) /
                  含み損 {diag.losers}銘柄 (平均 {diag.avgLossPct != null ? `${diag.avgLossPct}%` : "—"})
                </div>
              )}

              <GlossaryBox terms={["実質的な分散", "加重平均相関", "ボラティリティ", "β", "下げ捕捉率", "最大ドローダウン", "リスク寄与"]} />

              <div className="text-[9px] text-[var(--color-text-secondary)] opacity-70">
                すべて過去{diag.daysUsed}営業日の実リターンから計算した事実です。将来の予測ではありません。
                現在の保有比率を過去に当てはめた「もしこの構成で持っていたら」の再現値である点にご注意ください。
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
