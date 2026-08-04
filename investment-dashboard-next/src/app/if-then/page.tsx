"use client";

/**
 * 🎯 if-then ルールページ
 *
 * 「こうなったら、こうする」を平常時に書いておき、条件成立時に
 * 【本人の言葉がそのまま】LINEで返ってくる。Cavka は指示しない。
 * 焦った瞬間の判断を、冷静だった日の自分に代行させるための場所。
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  getIfThenRules, addIfThenRule, updateIfThenRule, deleteIfThenRule, getHoldings,
  type Holding,
} from "@/lib/firestore";
import { KIND_META, describeCondition, type ConditionKind, type Direction, type IfThenRule } from "@/lib/if-then";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

const PRESETS: { label: string; rule: Partial<IfThenRule> }[] = [
  { label: "日経が急落したら", rule: { kind: "index_change", direction: "below", threshold: -3, thenText: "その日は新規で買わない。翌日の寄りまで待つ。" } },
  { label: "洗い流しが来たら (買い場側)", rule: { kind: "regime", direction: "above", threshold: 25, thenText: "弾薬の1/3までを分割で投じる。焦って全部使わない。" } },
  { label: "現金が減りすぎたら", rule: { kind: "cash_ratio", direction: "below", threshold: 10, thenText: "弾切れ。次の暴落で動けなくなるので、新規買いを止める。" } },
];

export default function IfThenPage() {
  const { user } = useAuth();
  const [rules, setRules] = useState<IfThenRule[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<Partial<IfThenRule>>({
    kind: "index_change", direction: "below", threshold: -3, thenText: "", whyText: "", active: true,
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const [r, h] = await Promise.all([getIfThenRules(user.uid), getHoldings(user.uid)]);
      setRules(r as IfThenRule[]);
      setHoldings(h);
    } catch (e) {
      console.error("[if-then] load", e);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const meta = KIND_META[form.kind as ConditionKind];

  const save = async () => {
    if (!user || !form.thenText?.trim()) { setMsg("「そうなったらどうするか」を書いてください"); return; }
    if (meta.needsTicker && !form.ticker) { setMsg("銘柄を選んでください"); return; }
    setSaving(true);
    try {
      await addIfThenRule(user.uid, {
        kind: form.kind, direction: form.direction, threshold: Number(form.threshold),
        ticker: form.ticker ?? null,
        tickerName: holdings.find((h) => h.ticker === form.ticker)?.name ?? null,
        thenText: form.thenText.trim(), whyText: form.whyText?.trim() ?? "",
        active: true, once: false, cooldownHours: 24,
      });
      setForm({ kind: "index_change", direction: "below", threshold: -3, thenText: "", whyText: "", active: true });
      setMsg("登録しました。条件が成立したらLINEでお知らせします");
      await load();
    } catch (e) {
      setMsg(`保存に失敗: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  if (!user) return <div className="text-sm text-[var(--color-text-secondary)]">ログインしてください</div>;

  return (
    <div className="space-y-4 pb-24">
      <div>
        <h1 className="text-lg font-bold" style={MONO}>🎯 if-then ルール</h1>
        <p className="text-[12px] text-[var(--color-text-secondary)] mt-1 leading-relaxed">
          「こうなったら、こうする」を<b className="text-[var(--color-text)]">落ち着いている今のうちに</b>書いておきます。
          条件が成立した瞬間、Cavka は指示を出しません — <b className="text-[var(--color-text)]">あなたが書いた言葉をそのまま送り返します</b>。
          焦っている自分より、冷静だった自分の方が正しいことは多いからです。
        </p>
      </div>

      {/* プリセット */}
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => { setForm({ ...form, ...p.rule }); setMsg(null); }}
            className="px-2.5 py-1 text-[11px] rounded"
            style={{ color: "var(--color-accent)", border: "1px solid var(--color-border)", ...MONO }}
          >
            + {p.label}
          </button>
        ))}
      </div>

      {/* 新規登録 */}
      <div className="rounded-lg px-4 py-3 space-y-3" style={{ background: "var(--bg-card)", border: "1px solid rgba(0,240,255,0.10)" }}>
        <div className="text-[11px] font-bold">もし…</div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as ConditionKind, ticker: null })}
            className="bg-[var(--bg-card)] border border-[var(--color-border)] rounded px-2 py-1.5 text-[12px]"
          >
            {(Object.keys(KIND_META) as ConditionKind[]).map((k) => (
              <option key={k} value={k}>{KIND_META[k].label}</option>
            ))}
          </select>

          {meta.needsTicker && (
            <select
              value={form.ticker ?? ""}
              onChange={(e) => setForm({ ...form, ticker: e.target.value })}
              className="bg-[var(--bg-card)] border border-[var(--color-border)] rounded px-2 py-1.5 text-[12px]"
            >
              <option value="">銘柄を選択</option>
              {holdings.map((h) => <option key={h.ticker} value={h.ticker}>{h.name} ({h.ticker})</option>)}
            </select>
          )}

          <input
            type="number"
            value={form.threshold ?? ""}
            onChange={(e) => setForm({ ...form, threshold: Number(e.target.value) })}
            className="bg-transparent border-b border-[var(--color-border)] px-1 py-1 text-[12px] outline-none w-24"
            style={MONO}
          />
          <span className="text-[11px] text-[var(--color-text-secondary)]">{meta.unit}</span>

          <select
            value={form.direction}
            onChange={(e) => setForm({ ...form, direction: e.target.value as Direction })}
            className="bg-[var(--bg-card)] border border-[var(--color-border)] rounded px-2 py-1.5 text-[12px]"
          >
            <option value="below">を下回ったら</option>
            <option value="above">を超えたら</option>
          </select>
        </div>
        <div className="text-[10px] text-[var(--color-text-secondary)]">{meta.help}</div>

        <div className="text-[11px] font-bold pt-1">そのとき、こうする</div>
        <textarea
          value={form.thenText ?? ""}
          onChange={(e) => setForm({ ...form, thenText: e.target.value })}
          rows={2}
          placeholder="例: 何もしない。翌日の寄りまで判断を保留する。"
          className="w-full bg-transparent border border-[var(--color-border)] rounded px-2 py-1.5 text-[12px] outline-none resize-y"
        />
        <input
          value={form.whyText ?? ""}
          onChange={(e) => setForm({ ...form, whyText: e.target.value })}
          placeholder="そう決めた理由 (任意) — 発火時に一緒に送られます"
          className="w-full bg-transparent border-b border-[var(--color-border)] px-1 py-1.5 text-[12px] outline-none"
        />

        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-[12px] font-bold rounded"
            style={{ background: "var(--color-accent)", color: "#001", opacity: saving ? 0.6 : 1, ...MONO }}
          >
            {saving ? "登録中…" : "ルールを登録"}
          </button>
          {msg && <span className="text-[11px]" style={{ color: "#22c55e" }}>{msg}</span>}
        </div>
      </div>

      {/* 登録済み */}
      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>
          監視中のルール ({rules.filter((r) => r.active).length})
        </div>
        {loading && <div className="text-[11px] text-[var(--color-text-secondary)]">読み込み中…</div>}
        {!loading && rules.length === 0 && (
          <div className="text-[11px] text-[var(--color-text-secondary)]">
            まだルールがありません。上のプリセットから始めるのが簡単です
          </div>
        )}
        {rules.map((r) => (
          <div
            key={r.id}
            className="rounded-lg px-3 py-2.5"
            style={{ background: "var(--bg-card)", border: `1px solid ${r.active ? "rgba(0,240,255,0.12)" : "var(--color-border)"}`, opacity: r.active ? 1 : 0.5 }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[12px] font-semibold">もし {describeCondition(r)}</div>
                <div className="text-[12px] mt-0.5 whitespace-pre-wrap">{r.thenText}</div>
                {r.whyText && <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">理由: {r.whyText}</div>}
                <div className="text-[9px] text-[var(--color-text-secondary)] mt-1" style={MONO}>
                  {r.fireCount ? `発火 ${r.fireCount}回` : "未発火"}
                  {r.lastFiredAt ? ` · 最終 ${new Date(r.lastFiredAt).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" })}` : ""}
                </div>
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                <button
                  onClick={async () => { if (user && r.id) { await updateIfThenRule(user.uid, r.id, { active: !r.active }); await load(); } }}
                  className="text-[10px] px-2 py-1 rounded"
                  style={{ color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", ...MONO }}
                >
                  {r.active ? "停止" : "再開"}
                </button>
                <button
                  onClick={async () => { if (user && r.id && confirm("このルールを削除しますか?")) { await deleteIfThenRule(user.uid, r.id); await load(); } }}
                  className="text-[10px] px-2 py-1 rounded"
                  style={{ color: "#ef4444", border: "1px solid rgba(239,68,68,0.3)", ...MONO }}
                >
                  削除
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="text-[10px] text-[var(--color-text-secondary)] leading-relaxed">
        判定は暴落警報と同じ巡回 (平日 1日4回) に相乗りしています。同じルールは24時間に1回までしか通知しません。
        日経の「水準」による判定は現在の巡回では取得していないため、騰落率・レジーム・銘柄価格・含み損益・現金比率が使えます。
      </div>
    </div>
  );
}
