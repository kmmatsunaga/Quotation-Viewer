"use client";

/**
 * /accuracy — Cavka 自身の答え合わせダッシュボード
 *
 * 「Cavka の短期強気は過去N日で何%当たったのか」を表示する。
 * 検証データは日次 cron (verdict-track) が蓄積。
 * サンプルが少ないうちは正直に「まだ信頼できる数字ではない」と表示する。
 */

import { useEffect, useState } from "react";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface AccRow {
  tf: string;
  group: string;
  n: number;
  judged: number;
  hitRate: number | null;   // %
  avgRet: number | null;    // %
}

interface CandEntry {
  ticker: string;
  name: string;
  hint: string;
  hit: boolean;
  signedPct: number;
  consistency: number | null;
}

interface CandDay {
  date: string;
  n: number;
  hitRate: number | null;
  avgSignedPct: number | null;
  entries: CandEntry[];
}

interface AccResp {
  ok: boolean;
  evalDays: number;
  firstDate: string | null;
  lastDate: string | null;
  verdict: AccRow[];
  tech: AccRow[];
  candidates?: {
    days: CandDay[];
    total: { n: number; hitRate: number | null; avgSignedPct: number | null };
  };
  error?: string;
}

const TF_LABEL: Record<string, string> = {
  short: "短期 (7日後)",
  mid: "中期 (30日後)",
  long: "長期 (90日後)",
};

const STANCE_LABEL: Record<string, { label: string; color: string }> = {
  strong_bull: { label: "🟢 強気", color: "#22c55e" },
  bull: { label: "🟢 やや強気", color: "#86efac" },
  neutral: { label: "🟡 中立", color: "#facc15" },
  bear: { label: "🔴 やや弱気", color: "#fb923c" },
  strong_bear: { label: "🔴 弱気", color: "#ef4444" },
  contested: { label: "⚡ 見解対立", color: "#a78bfa" },
};

const BUCKET_LABEL: Record<string, { label: string; color: string }> = {
  bull: { label: "🟢 スコア65以上 (強気)", color: "#22c55e" },
  neutral: { label: "🟡 スコア46-64 (中立)", color: "#facc15" },
  bear: { label: "🔴 スコア45以下 (弱気)", color: "#ef4444" },
};

function hitColor(rate: number | null): string {
  if (rate === null) return "var(--color-text-secondary)";
  if (rate >= 60) return "#22c55e";
  if (rate >= 50) return "#facc15";
  return "#ef4444";
}

interface RecoSummary {
  horizon: "short" | "mid" | "long" | "kiyohara";
  evaluatedDays: number;
  maturingDays: number;
  meanPickExcess: number | null;
  medianPickExcess: number | null;
  meanControlExcess: number | null;
  meanEdge: number | null;
  edgeT: number | null;
  gateT: number | null;
  winRate: number | null;
  ready: boolean;
  verdict: "logic_works" | "gate_only" | "no_edge" | "pending";
  message: string;
}
interface RecoResp {
  ok: boolean;
  windows: Record<string, number>;
  summaries: RecoSummary[];
}

const H_META: Record<string, { label: string; icon: string }> = {
  short: { label: "短期", icon: "⚡" },
  mid: { label: "中期", icon: "🌱" },
  long: { label: "長期", icon: "🏔" },
  kiyohara: { label: "清原式 (長期レース)", icon: "🏔" },
};

const VERDICT_META: Record<RecoSummary["verdict"], { color: string; label: string }> = {
  logic_works: { color: "#22c55e", label: "✅ 順位付けに価値あり" },
  gate_only: { color: "#facc15", label: "⚠ 関門のみ有効" },
  no_edge: { color: "#fb923c", label: "❌ 優位を確認できず" },
  pending: { color: "#6b7280", label: "⏳ 判定不能 (熟成中)" },
};

export default function AccuracyPage() {
  const [data, setData] = useState<AccResp | null>(null);
  const [reco, setReco] = useState<RecoResp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/accuracy")
      .then((r) => r.json())
      .then((j: AccResp) => { setData(j); setLoading(false); })
      .catch(() => setLoading(false));

    // おすすめv2 の答え合わせ (認証必要)
    (async () => {
      try {
        const { auth } = await import("@/lib/firebase");
        const token = await auth.currentUser?.getIdToken();
        if (!token) return;
        const res = await fetch("/api/recommend-accuracy", { headers: { Authorization: `Bearer ${token}` } });
        const j = (await res.json()) as RecoResp;
        if (j.ok) setReco(j);
      } catch {}
    })();
  }, []);

  if (loading) {
    return <div className="text-center py-20 text-sm text-[var(--color-text)]" style={MONO}>検証データを読み込み中...</div>;
  }
  if (!data?.ok) {
    return <div className="text-center py-20 text-sm text-red-400" style={MONO}>⚠ {data?.error ?? "取得失敗"}</div>;
  }

  const noData = data.evalDays === 0;
  const lowSample = !noData && data.evalDays < 30;

  return (
    <div className="space-y-6">
      {/* ヘッダ */}
      <div>
        <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">
          🎯 検証 — Cavka の答え合わせ
        </h1>
        <p className="text-[14px] text-[var(--color-text-secondary)] mt-1.5 leading-relaxed">
          Cavka 自身の予測 (評決・テクニカルスコア) が実際にどれだけ当たったかの記録。
          {data.firstDate && ` 収集期間: ${fmtDate(data.firstDate)} 〜 ${fmtDate(data.lastDate)} (${data.evalDays}日分)`}
        </p>
      </div>

      {noData && (
        <div className="p-4 border text-sm" style={{ borderColor: "#facc15", background: "rgba(250,204,21,0.06)", color: "var(--color-text)", ...MONO }}>
          📭 まだ検証データがありません。日次 cron (JST 01:30) が評決を記録し始めてから、
          最短でも7日後 (短期の初回答え合わせ) に最初の数字が出ます。<br />
          <span className="opacity-70">中期は30日後、長期は90日後から。数字が出るまでは待つしかない — それが正直な検証です。</span>
        </div>
      )}

      {lowSample && (
        <div className="p-3 border text-xs" style={{ borderColor: "#facc15", background: "rgba(250,204,21,0.06)", color: "var(--color-text)", ...MONO }}>
          ⚠ 収集{data.evalDays}日分。サンプルが少ないうちの勝率は偶然に左右されます。30日分たまるまでは参考程度に。
        </div>
      )}

      {/* 🌟 おすすめv2 の答え合わせ (時間軸ごとに選定ロジックが効いているか) */}
      {reco && (
        <section className="space-y-2">
          <h2 className="text-[17px] font-bold text-[var(--color-text)]">
            🌟 おすすめの答え合わせ <span className="opacity-60 font-normal">(推薦日の寄りで買い、満期の引けで売った場合)</span>
          </h2>
          <p className="text-[11px] text-[var(--color-text-secondary)] leading-relaxed" style={MONO}>
            主指標は「市場 (日経/S&P500) を何%上回ったか」= 超過リターン。上げ相場で全部上がるのを的中と呼ばないため。<br />
            さらに<strong className="text-[var(--color-text)]">統制群</strong> (同じ関門を通ったランダム銘柄) と比べる。
            これが無いと「関門を通れば何でも良かった」を否定できない。<br />
            統計単位は<strong className="text-[var(--color-text)]">営業日</strong> (同じ日の8銘柄は同じ地合いを共有していて独立ではないため)。
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {reco.summaries.map((s) => {
              const m = H_META[s.horizon];
              const v = VERDICT_META[s.verdict];
              return (
                <div key={s.horizon} className="p-3 border space-y-2" style={{ borderColor: v.color + "66", background: "var(--bg-card)" }}>
                  <div className="flex items-baseline justify-between">
                    <span className="text-[14px] font-bold text-[var(--color-text)]">
                      {m.icon} {m.label}
                    </span>
                    <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
                      +{reco.windows[s.horizon]}営業日で判定
                    </span>
                  </div>
                  <div className="text-[11px] font-bold" style={{ color: v.color, ...MONO }}>{v.label}</div>

                  {s.ready ? (
                    <div className="space-y-1" style={MONO}>
                      <Row label="ロジックの価値 (対統制群)" value={s.meanEdge != null ? `${s.meanEdge >= 0 ? "+" : ""}${s.meanEdge}%` : "—"} strong color={s.meanEdge != null && s.meanEdge > 0 ? "#22c55e" : "#fb923c"} />
                      <Row label="　t値 (2以上で有意)" value={s.edgeT != null ? `${s.edgeT}` : "—"} />
                      <Row label="おすすめの超過 (対市場)" value={s.meanPickExcess != null ? `${s.meanPickExcess >= 0 ? "+" : ""}${s.meanPickExcess}%` : "—"} />
                      <Row label="統制群の超過 (対市場)" value={s.meanControlExcess != null ? `${s.meanControlExcess >= 0 ? "+" : ""}${s.meanControlExcess}%` : "—"} />
                      <Row label="市場に勝った割合" value={s.winRate != null ? `${s.winRate}%` : "—"} />
                    </div>
                  ) : (
                    <div className="text-[10px] text-[var(--color-text-secondary)] leading-relaxed">
                      評価済み <strong className="text-[var(--color-text)]">{s.evaluatedDays}営業日</strong> / 熟成中 {s.maturingDays}日
                    </div>
                  )}

                  <div className="text-[10px] text-[var(--color-text-secondary)] leading-relaxed pt-1.5 border-t border-[var(--color-border)]">
                    {s.message}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* デイトレ候補の答え合わせ (朝の候補は実際どう動いたか) */}
      {data.candidates && data.candidates.days.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[17px] font-bold text-[var(--color-text)]">
            ⚔ デイトレ候補の答え合わせ <span className="opacity-60 font-normal">(朝の候補に寄りで乗って引けまで持った場合)</span>
          </h2>
          <div className="p-4 border flex items-baseline gap-6 flex-wrap" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
            <div style={MONO}>
              <span className="text-3xl font-black" style={{ color: hitColor(data.candidates.total.hitRate) }}>
                {data.candidates.total.hitRate ?? "—"}%
              </span>
              <span className="text-xs text-[var(--color-text-secondary)] ml-1.5">方向的中 (n={data.candidates.total.n})</span>
            </div>
            <div className="text-xs" style={MONO}>
              平均{" "}
              <span className="text-lg font-bold" style={{ color: (data.candidates.total.avgSignedPct ?? 0) >= 0 ? "var(--color-up)" : "var(--color-down)" }}>
                {(data.candidates.total.avgSignedPct ?? 0) >= 0 ? "+" : ""}{data.candidates.total.avgSignedPct ?? "—"}%
              </span>
              <span className="text-[var(--color-text-secondary)] ml-1">/銘柄</span>
            </div>
          </div>
          <div className="space-y-1.5">
            {data.candidates.days.map((d) => (
              <details key={d.date} className="border" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
                <summary className="px-3 py-2 cursor-pointer flex items-center justify-between text-xs" style={MONO}>
                  <span className="text-[var(--color-text)]">{fmtDate(d.date)}</span>
                  <span>
                    <span className="font-bold" style={{ color: hitColor(d.hitRate) }}>{d.hitRate}%</span>
                    <span className="text-[var(--color-text-secondary)] ml-2">n={d.n}</span>
                    <span className="ml-2 font-bold" style={{ color: (d.avgSignedPct ?? 0) >= 0 ? "var(--color-up)" : "var(--color-down)" }}>
                      {(d.avgSignedPct ?? 0) >= 0 ? "+" : ""}{d.avgSignedPct}%
                    </span>
                  </span>
                </summary>
                <div className="px-3 pb-2 space-y-0.5">
                  {d.entries.map((e) => (
                    <div key={`${d.date}_${e.ticker}`} className="flex items-center justify-between text-[11px]" style={MONO}>
                      <span className="text-[var(--color-text)]">
                        {e.hit ? "✓" : "✗"} {e.hint === "short" ? "🔴空売" : "🟢買い"} {e.ticker} {e.name}
                        {e.consistency !== null && <span className="opacity-50 ml-1">一貫{e.consistency}%</span>}
                      </span>
                      <span className="font-bold" style={{ color: e.signedPct >= 0 ? "var(--color-up)" : "var(--color-down)" }}>
                        {e.signedPct >= 0 ? "+" : ""}{e.signedPct}%
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
          <p className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
            ※ 候補が悪いのか、乗り方が悪いのかを切り分けるための数字。ここが50%未満なら候補ロジック自体を疑う。
          </p>
        </section>
      )}

      {/* テクニカルスコアの検証 (サンプル多い方を先に) */}
      {data.tech.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[17px] font-bold text-[var(--color-text)]">
            📊 テクニカルスコアの的中率 <span className="opacity-60 font-normal">(日経225 + S&P500 全銘柄 = 統計的に有意になりやすい)</span>
          </h2>
          <AccuracyGrid rows={data.tech} labels={BUCKET_LABEL} />
          <p className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
            ※ 「スコア65以上の銘柄がN日後に上昇していた率」。中立バケットは判定対象外 (平均リターンのみ)。
          </p>
        </section>
      )}

      {/* 評決の検証 */}
      {data.verdict.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[17px] font-bold text-[var(--color-text)]">
            ⚖ 評決 (Verdict) の的中率 <span className="opacity-60 font-normal">(ポートフォリオ + お気に入り銘柄)</span>
          </h2>
          <AccuracyGrid rows={data.verdict} labels={STANCE_LABEL} />
          <p className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
            ※ 強気評決→上昇 / 弱気評決→下落 で的中。中立・見解対立は判定対象外だが、平均リターンは記録
            (対立局面の値動きの荒さを見るため)。
          </p>
        </section>
      )}

      {/* 使い方の考え方 */}
      <div className="text-[10px] text-[var(--color-text-secondary)] opacity-60 leading-relaxed" style={MONO}>
        ※ 勝率 50% は「コイン投げと同じ」。55%を安定して超えて初めて意味がある。<br />
        ※ 勝率だけでなく平均リターンも見る (勝率48%でも勝ちが大きければ有効)。<br />
        ※ この数字が悪い時間軸・スタンスは、Cavka の言うことを信じすぎない。それがこのページの目的。
      </div>
    </div>
  );
}

function fmtDate(d: string | null): string {
  if (!d || d.length !== 8) return "—";
  return `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;
}

function AccuracyGrid({ rows, labels }: { rows: AccRow[]; labels: Record<string, { label: string; color: string }> }) {
  const tfs = ["short", "mid", "long"];
  const groups = Object.keys(labels);
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {tfs.map((tf) => {
        const tfRows = rows.filter((r) => r.tf === tf);
        return (
          <div key={tf} className="p-4 border space-y-3" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
            <div className="text-xs font-bold text-[var(--color-text)]" style={MONO}>{TF_LABEL[tf] ?? tf}</div>
            {tfRows.length === 0 ? (
              <div className="text-xs text-[var(--color-text-secondary)]" style={MONO}>データ収集中...</div>
            ) : (
              groups.map((g) => {
                const row = tfRows.find((r) => r.group === g);
                if (!row) return null;
                const meta = labels[g];
                const judgeable = row.judged > 0;
                return (
                  <div key={g} className="flex items-center justify-between gap-2">
                    <span className="text-xs" style={{ color: meta.color, ...MONO }}>{meta.label}</span>
                    <span className="text-right" style={MONO}>
                      {judgeable ? (
                        <>
                          <span className="text-2xl font-black" style={{ color: hitColor(row.hitRate) }}>
                            {row.hitRate}%
                          </span>
                          <span className="text-[10px] text-[var(--color-text-secondary)] ml-1.5">
                            n={row.judged}
                          </span>
                        </>
                      ) : (
                        <span className="text-xs text-[var(--color-text-secondary)]">
                          平均 {row.avgRet !== null ? `${row.avgRet > 0 ? "+" : ""}${row.avgRet}%` : "—"} (n={row.n})
                        </span>
                      )}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        );
      })}
    </div>
  );
}

/** おすすめ答え合わせカードの1行 */
function Row({ label, value, strong, color }: { label: string; value: string; strong?: boolean; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] text-[var(--color-text-secondary)]">{label}</span>
      <span
        className={strong ? "text-[13px] font-black" : "text-[11px]"}
        style={{ color: color ?? "var(--color-text)" }}
      >
        {value}
      </span>
    </div>
  );
}
