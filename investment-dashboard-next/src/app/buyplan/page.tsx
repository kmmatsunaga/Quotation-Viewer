"use client";

/**
 * /buyplan — 🧭 買い方の設計 (ポジション構築プラン)
 *
 * 覚悟を仕組みに変換する装置:
 *   1. プランは買う前に作る (買った後に理屈をつけない)
 *   2. リスクは金額で先に決める (損切りまでの損失 ≤ 総資産の1.5%)
 *   3. 「なぜ買うか」を書かないと保存できない
 *   4. 保存されたプランは残る — 守れたかどうかも記録になる
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  getAccountBalance, getHoldings,
  getPositionPlans, addPositionPlan, updatePositionPlan, deletePositionPlan,
  type PositionPlan,
} from "@/lib/firestore";
import { computePositionPlan, type PositionPlanCalc } from "@/lib/position-plan";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };
const UP = "var(--color-up)";
const DANGER = "#ef4444";

interface PlanInputsResp {
  ticker: string; name: string; price: number;
  atr: number; atrPct: number; low20: number; low60: number;
  error?: string;
}

const STATUS_META: Record<PositionPlan["status"], { label: string; color: string }> = {
  planned: { label: "📋 計画中", color: "#facc15" },
  executing: { label: "⚔ 執行中", color: "#ff3b6b" },
  done: { label: "✅ 完了", color: "#4ade80" },
  cancelled: { label: "✕ 取消", color: "#6b7280" },
};

export default function BuyPlanPage() {
  const { user } = useAuth();
  const [totalAssets, setTotalAssets] = useState<number | null>(null);
  const [cash, setCash] = useState<number | null>(null);
  const [plans, setPlans] = useState<PositionPlan[]>([]);

  // 入力
  const [ticker, setTicker] = useState("");
  const [lotSize, setLotSize] = useState<1 | 100>(100);
  const [riskPct, setRiskPct] = useState("1.5");
  const [maxPosPct, setMaxPosPct] = useState("25");
  const [memo, setMemo] = useState("");

  const [inputs, setInputs] = useState<PlanInputsResp | null>(null);
  const [earnings, setEarnings] = useState<{ date: string | null; daysToNext: number | null } | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    const [bal, holdings, pl] = await Promise.all([
      getAccountBalance(user.uid),
      getHoldings(user.uid),
      getPositionPlans(user.uid),
    ]);
    // 保有評価は取得単価ベースの近似 (現値取得は保有画面の役目)
    const holdingsValue = holdings.reduce((s, h) => s + h.shares * h.avgCost, 0);
    setCash(bal.cashJpy);
    setTotalAssets(bal.cashJpy + holdingsValue);
    setPlans(pl);
  }, [user]);

  useEffect(() => { load(); }, [load]);

  // 銘柄ページからの導線: /buyplan?ticker=7203 で自動設計
  useEffect(() => {
    try {
      const t = new URLSearchParams(window.location.search).get("ticker");
      if (t && /^\d{3,4}[A-Z0-9]?$/i.test(t)) {
        setTicker(t.toUpperCase());
        fetchInputsFor(t.toUpperCase());
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchInputs = async () => fetchInputsFor(ticker.trim().toUpperCase());

  const fetchInputsFor = async (t: string) => {
    if (!t) return;
    setFetching(true);
    setError(null);
    setInputs(null);
    setEarnings(null);
    setSavedMsg(null);
    try {
      const [res, earnRes] = await Promise.all([
        fetch(`/api/stocks/plan-inputs?ticker=${encodeURIComponent(t)}`),
        fetch(`/api/stocks/next-earnings?tickers=${encodeURIComponent(t)}`).then((r) => r.json()).catch(() => null),
      ]);
      const j: PlanInputsResp = await res.json();
      if (!res.ok) { setError(j.error ?? `HTTP ${res.status}`); return; }
      setInputs(j);
      setEarnings(earnRes?.earnings?.[t] ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFetching(false);
    }
  };

  const calc: PositionPlanCalc | null = useMemo(() => {
    if (!inputs || totalAssets === null || cash === null) return null;
    return computePositionPlan({
      ticker: inputs.ticker, name: inputs.name,
      price: inputs.price, atr: inputs.atr, low20: inputs.low20, low60: inputs.low60,
      totalAssets, cash,
      riskPct: Number(riskPct) || 1.5,
      maxPosPct: Number(maxPosPct) || 25,
      lotSize,
    });
  }, [inputs, totalAssets, cash, riskPct, maxPosPct, lotSize]);

  const save = async () => {
    if (!user || !inputs || !calc?.ok) return;
    if (memo.trim().length < 8) {
      setError("「なぜ買うか」を8文字以上で書いてください — これが無いプランは規律になりません");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await addPositionPlan(user.uid, {
        ticker: inputs.ticker, name: inputs.name, createdPrice: inputs.price,
        entries: calc.entries, totalShares: calc.totalShares, totalAmount: calc.totalAmount,
        avgEntry: calc.avgEntry, stop: calc.stop, target: calc.target,
        riskAmount: calc.riskAmount, riskPctOfAssets: calc.riskPctOfAssets,
        positionPctOfAssets: calc.positionPctOfAssets, lotSize,
        memo: memo.trim(), status: "planned",
      });
      setSavedMsg(`✅ ${inputs.name} のプランを保存しました。あとは設計どおりに執行するだけ。`);
      setMemo("");
      setInputs(null);
      setTicker("");
      await load();
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (p: PositionPlan, status: PositionPlan["status"]) => {
    if (!user || !p.id) return;
    await updatePositionPlan(user.uid, p.id, { status });
    await load();
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">🧭 買い方の設計</h1>
        <p className="text-[14px] text-[var(--color-text-secondary)] mt-1.5 leading-relaxed">
          ここは<strong className="text-[var(--color-text)]">「買うと決めた銘柄」</strong>の設計場所。迷っている段階なら、まず銘柄ページで判断を。
          決めたら、入り方・損切り・リスク額をここで固めて保存する。買った後に理屈をつけない。
        </p>
        {totalAssets !== null && (
          <p className="text-[12px] text-[var(--color-text-secondary)] mt-1" style={MONO}>
            総資産 ¥{Math.round(totalAssets).toLocaleString()} (現金 ¥{Math.round(cash ?? 0).toLocaleString()})
            {" "}/ ルール: 1トレードのリスク ≤ {riskPct}% ・ 1銘柄 ≤ {maxPosPct}%
          </p>
        )}
      </div>

      {/* 設計フォーム */}
      <div className="p-4 border space-y-3" style={{ borderColor: "var(--color-accent)", background: "rgba(0,240,255,0.04)" }}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <label className="text-[11px] text-[var(--color-text-secondary)]">銘柄コード
            <input value={ticker} onChange={(e) => setTicker(e.target.value)} onKeyDown={(e) => e.key === "Enter" && fetchInputs()}
              placeholder="7203" className="w-full mt-1 bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-2 text-sm text-[var(--color-text)]" style={MONO} />
          </label>
          <label className="text-[11px] text-[var(--color-text-secondary)]">買い方
            <div className="flex gap-1 mt-1">
              {([[100, "単元(100株)"], [1, "かぶミニ(1株)"]] as const).map(([v, l]) => (
                <button key={v} onClick={() => setLotSize(v)} className="flex-1 py-2 text-[11px] border"
                  style={{ borderColor: lotSize === v ? "var(--color-accent)" : "var(--color-border)", color: lotSize === v ? "var(--color-accent)" : "var(--color-text-secondary)" }}>
                  {l}
                </button>
              ))}
            </div>
          </label>
          <label className="text-[11px] text-[var(--color-text-secondary)]">リスク上限 (総資産%)
            <input value={riskPct} onChange={(e) => setRiskPct(e.target.value)} type="number" step="0.5"
              className="w-full mt-1 bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-2 text-sm text-[var(--color-text)]" style={MONO} />
          </label>
          <label className="text-[11px] text-[var(--color-text-secondary)]">1銘柄上限 (総資産%)
            <input value={maxPosPct} onChange={(e) => setMaxPosPct(e.target.value)} type="number" step="5"
              className="w-full mt-1 bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-2 text-sm text-[var(--color-text)]" style={MONO} />
          </label>
        </div>
        <button onClick={fetchInputs} disabled={fetching || !ticker.trim()}
          className="w-full py-2.5 text-sm font-bold disabled:opacity-50"
          style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)", background: "rgba(0,240,255,0.08)" }}>
          {fetching ? "計算材料を取得中…" : "プランを設計する"}
        </button>
        {error && <div className="text-[13px] p-2 border-l-2" style={{ borderColor: DANGER, color: DANGER }}>{error}</div>}
        {savedMsg && <div className="text-[13px] p-2 border-l-2" style={{ borderColor: "#4ade80", color: "#4ade80" }}>{savedMsg}</div>}
      </div>

      {/* 設計結果 */}
      {inputs && calc && (
        <div className="p-4 border space-y-4" style={{ borderColor: calc.ok ? "var(--color-border)" : DANGER, background: "var(--bg-card)" }}>
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <div>
              <span className="text-[17px] font-bold text-[var(--color-text)]">{inputs.name}</span>
              <span className="text-[11px] text-[var(--color-accent)] ml-2" style={MONO}>{inputs.ticker}</span>
            </div>
            <span className="text-[12px] text-[var(--color-text-secondary)]" style={MONO}>
              現在値 ¥{inputs.price.toLocaleString()} / ATR ¥{inputs.atr} ({inputs.atrPct}%)
            </span>
          </div>

          {/* 決算接近の警告 — 「上がってて良さそうと思ったら決算直前」事故の防止 */}
          {earnings?.daysToNext !== null && earnings?.daysToNext !== undefined && earnings.daysToNext >= 0 && earnings.daysToNext <= 21 && (
            <div className="text-[13px] p-2.5 border-l-4 leading-relaxed" style={{
              borderColor: earnings.daysToNext <= 7 ? DANGER : "#facc15",
              background: earnings.daysToNext <= 7 ? "rgba(239,68,68,0.08)" : "rgba(250,204,21,0.06)",
              color: "var(--color-text)",
            }}>
              {earnings.daysToNext <= 7 ? "🚨" : "⚠"} <strong>決算が{earnings.daysToNext === 0 ? "本日" : `${earnings.daysToNext}日後`}</strong>
              {earnings.date && ` (${Number(earnings.date.slice(5, 7))}/${Number(earnings.date.slice(8, 10))})`} —
              {earnings.daysToNext <= 7
                ? " 直前です。この設計はギャップリスクを含みません。跨ぐ覚悟が無いなら決算後に設計し直すのが安全"
                : " 全ロット約定前に決算が来る可能性。跨ぐ前提かどうかを「なぜ買うか」に書いてください"}
            </div>
          )}

          {!calc.ok ? (
            <div className="text-[14px] leading-relaxed" style={{ color: DANGER }}>⚠ {calc.reason}</div>
          ) : (
            <>
              {/* 分割エントリー */}
              <div className="space-y-1.5">
                {calc.entries.map((e, i) => (
                  <div key={i} className="flex items-center justify-between p-2.5 border" style={{ borderColor: "var(--color-border)" }}>
                    <span className="text-[13px] text-[var(--color-text)]">{e.label}</span>
                    <span className="text-[14px]" style={MONO}>
                      ¥{e.price.toLocaleString()} × <strong>{e.shares.toLocaleString()}株</strong>
                      <span className="text-[var(--color-text-secondary)] ml-2">= ¥{e.amount.toLocaleString()}</span>
                    </span>
                  </div>
                ))}
              </div>

              {/* 損切り / 利確 / リスク */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-center" style={MONO}>
                <div className="p-2.5 border" style={{ borderColor: "rgba(239,68,68,0.4)" }}>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">損切り (厳守)</div>
                  <div className="text-lg font-black" style={{ color: DANGER }}>¥{calc.stop.toLocaleString()}</div>
                  <div className="text-[10px]" style={{ color: DANGER }}>{calc.stopPct}%</div>
                </div>
                <div className="p-2.5 border" style={{ borderColor: "rgba(255,59,107,0.4)" }}>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">利確目安 (RRR 2:1)</div>
                  <div className="text-lg font-black" style={{ color: UP }}>¥{calc.target.toLocaleString()}</div>
                </div>
                <div className="p-2.5 border" style={{ borderColor: "var(--color-border)" }}>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">最大損失</div>
                  <div className="text-lg font-black text-[var(--color-text)]">¥{calc.riskAmount.toLocaleString()}</div>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">総資産の{calc.riskPctOfAssets}%</div>
                </div>
                <div className="p-2.5 border" style={{ borderColor: "var(--color-border)" }}>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">投資額 (全約定時)</div>
                  <div className="text-lg font-black text-[var(--color-text)]">¥{calc.totalAmount.toLocaleString()}</div>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">総資産の{calc.positionPctOfAssets}% / 平均 ¥{calc.avgEntry.toLocaleString()}</div>
                </div>
              </div>

              {calc.notes.length > 0 && (
                <ul className="text-[12px] text-[var(--color-text-secondary)] space-y-1 leading-relaxed">
                  {calc.notes.map((n, i) => <li key={i}>・{n}</li>)}
                </ul>
              )}

              {/* テーゼ (必須) + 保存 */}
              <div className="pt-2 border-t border-[var(--color-border)] space-y-2">
                <label className="text-[12px] text-[var(--color-text)]">
                  なぜ買うか (必須 — これが崩れたら売る基準にもなる)
                  <textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2}
                    placeholder="例: 20日-10%の投げ売り反発型が発火。半導体の在庫調整も底打ち報道。20日以内の戻りを狙う"
                    className="w-full mt-1 bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-2 text-[13px] text-[var(--color-text)]" />
                </label>
                <button onClick={save} disabled={saving}
                  className="w-full py-2.5 text-sm font-bold disabled:opacity-50"
                  style={{ border: `1px solid ${UP}`, color: UP, background: "rgba(255,59,107,0.08)" }}>
                  {saving ? "保存中…" : "このプランで行く (保存)"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* 保存済みプラン */}
      {plans.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[17px] font-bold text-[var(--color-text)]">📋 プラン一覧</h2>
          {plans.map((p) => {
            const sm = STATUS_META[p.status];
            return (
              <div key={p.id} className="p-3 border space-y-2" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="min-w-0">
                    <span className="text-[15px] font-bold text-[var(--color-text)]">{p.name}</span>
                    <span className="text-[11px] text-[var(--color-accent)] ml-2" style={MONO}>{p.ticker}</span>
                    <span className="text-[11px] ml-2" style={{ color: sm.color }}>{sm.label}</span>
                  </div>
                  <span className="text-[12px]" style={MONO}>
                    {p.totalShares}株 / 損切 <span style={{ color: DANGER }}>¥{p.stop.toLocaleString()}</span> / 目標 <span style={{ color: UP }}>¥{p.target.toLocaleString()}</span>
                  </span>
                </div>
                <div className="text-[12px] text-[var(--color-text-secondary)] leading-relaxed">{p.memo}</div>
                <div className="flex gap-1.5 flex-wrap" style={MONO}>
                  {p.status === "planned" && (
                    <button onClick={() => setStatus(p, "executing")} className="px-2.5 py-1 text-[11px] border" style={{ borderColor: UP, color: UP }}>執行開始</button>
                  )}
                  {p.status === "executing" && (
                    <button onClick={() => setStatus(p, "done")} className="px-2.5 py-1 text-[11px] border" style={{ borderColor: "#4ade80", color: "#4ade80" }}>完了</button>
                  )}
                  {(p.status === "planned" || p.status === "executing") && (
                    <button onClick={() => setStatus(p, "cancelled")} className="px-2.5 py-1 text-[11px] border" style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>取消</button>
                  )}
                  {(p.status === "done" || p.status === "cancelled") && (
                    <button onClick={() => user && p.id && deletePositionPlan(user.uid, p.id).then(load)} className="px-2.5 py-1 text-[11px] border" style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>削除</button>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      )}

      <div className="text-[11px] text-[var(--color-text-secondary)] opacity-70 leading-relaxed">
        ※ 執行は楽天証券で手動 (Cavka は発注しません)。2〜3段目は指値で置き、埋まらなければ追いかけない。<br />
        ※ 損切りラインだけは絶対に動かさない — 動かした瞬間、この設計は無意味になります。
      </div>
    </div>
  );
}
