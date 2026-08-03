"use client";

/**
 * 🩺 投資家問診票ページ
 *
 * Cavka が「ツール」でなく「パートナー」であるために、相手を知るための場所。
 * ここに書かれるのは【本人が宣言した意図】。診断側はこれを実測と照合してズレを指摘する。
 * 私 (Cavka) が「こうすべき」と助言することはしない — 鏡として使う。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  SECTIONS, SCORE_META, computeScores, completeness, labelOf, questionById,
  type Answers, type ScoreKey, type Question,
} from "@/lib/investor-profile";
import {
  getInvestorProfile, saveInvestorProfile, getProfileHistory,
  type InvestorProfileDoc,
} from "@/lib/firestore";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

export default function InvestorProfilePage() {
  const { user } = useAuth();
  const [answers, setAnswers] = useState<Answers>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [history, setHistory] = useState<(InvestorProfileDoc & { id: string })[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [openSection, setOpenSection] = useState<string>(SECTIONS[0].id);

  const DRAFT_KEY = "cavka_profile_draft";
  const [hasDraft, setHasDraft] = useState(false);

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const p = await getInvestorProfile(user.uid);
        const saved = (p?.answers ?? {}) as Answers;
        // 未保存の下書きがあれば優先して復元 (24問書いて消えるのが最悪なので)
        let draft: Answers | null = null;
        try {
          const raw = localStorage.getItem(DRAFT_KEY);
          if (raw) {
            const d = JSON.parse(raw) as Answers;
            if (JSON.stringify(d) !== JSON.stringify(saved)) draft = d;
          }
        } catch {}
        setAnswers(draft ?? saved);
        setHasDraft(!!draft);
        setHistory(await getProfileHistory(user.uid, 30));
      } catch (e) {
        console.error("[profile] load failed", e);
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  // 入力のたびに下書きを localStorage へ (保存前にページを離れても消えない)
  useEffect(() => {
    if (loading) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(answers)); } catch {}
  }, [answers, loading]);

  const scores = useMemo(() => computeScores(answers), [answers]);
  const comp = useMemo(() => completeness(answers), [answers]);

  const set = useCallback((id: string, v: Answers[string]) => {
    setAnswers((a) => ({ ...a, [id]: v }));
    setSavedMsg(null);
  }, []);

  const save = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const res = await saveInvestorProfile(user.uid, answers, scores as Record<string, number>, note);
      setSavedMsg(
        res.historySaved
          ? `保存しました (${res.changedKeys.length}項目の変化を履歴に記録)`
          : "保存しました (変更なし)",
      );
      setNote("");
      setHasDraft(false);
      try { localStorage.removeItem(DRAFT_KEY); } catch {}
      setHistory(await getProfileHistory(user.uid, 30));
    } catch (e) {
      setSavedMsg(`保存に失敗しました: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  if (!user) return <div className="text-sm text-[var(--color-text-secondary)]">ログインしてください</div>;
  if (loading) return <div className="text-sm text-[var(--color-text-secondary)]" style={MONO}>読み込み中…</div>;

  return (
    <div className="space-y-4 pb-24">
      <div>
        <h1 className="text-lg font-bold" style={MONO}>🩺 投資家問診票</h1>
        <p className="text-[12px] text-[var(--color-text-secondary)] mt-1 leading-relaxed">
          正解のない質問だけです。ここに書いたことは、以後ポートフォリオ診断で
          <b className="text-[var(--color-text)]">「宣言と実測のズレ」</b>として照合されます。
          Cavka が「こうすべき」と助言することはありません — あなたの言葉を鏡として使います。
          すべて任意回答で、いつでも書き換えられます。
        </p>
      </div>

      {hasDraft && (
        <div className="rounded px-3 py-2 text-[11px]" style={{ background: "rgba(250,204,21,0.10)", border: "1px solid #facc15", color: "#facc15" }}>
          📝 保存されていない下書きを復元しました。内容を確認して「保存する」を押してください
        </div>
      )}

      {/* 現在のプロフィール (合成スコア) */}
      <div className="rounded-lg px-4 py-3" style={{ background: "var(--bg-card)", border: "1px solid rgba(0,240,255,0.10)" }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>
            いまのあなたの輪郭
          </span>
          <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
            回答 {comp.answered}/{comp.total} ({comp.pct}%)
          </span>
        </div>
        <div className="space-y-1.5">
          {(Object.keys(SCORE_META) as ScoreKey[]).map((k) => {
            const v = scores[k];
            const m = SCORE_META[k];
            return (
              <div key={k} className="flex items-center gap-2">
                <span className="text-[11px] w-24 shrink-0">{m.emoji} {m.label}</span>
                <span className="text-[9px] text-[var(--color-text-secondary)] w-16 text-right">{m.low}</span>
                <div className="relative flex-1 h-1.5 rounded-full" style={{ background: "rgba(148,163,184,0.15)" }}>
                  {v != null && (
                    <div className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full"
                      style={{ left: `calc(${v}% - 5px)`, background: "var(--color-accent)", boxShadow: "0 0 8px rgba(0,240,255,0.6)" }} />
                  )}
                </div>
                <span className="text-[9px] text-[var(--color-text-secondary)] w-16">{m.high}</span>
                <span className="text-[11px] w-8 text-right tabular-nums" style={MONO}>{v ?? "—"}</span>
              </div>
            );
          })}
        </div>
        {comp.pct < 60 && (
          <div className="mt-2 text-[10px] text-[var(--color-text-secondary)]">
            回答が増えるほど、診断での照合が具体的になります (現在 {comp.pct}%)
          </div>
        )}
      </div>

      {/* 質問セクション */}
      {SECTIONS.map((sec) => {
        const open = openSection === sec.id;
        const secAnswered = sec.questions.filter((q) => {
          const a = answers[q.id];
          return a != null && a !== "" && !(Array.isArray(a) && a.length === 0);
        }).length;
        return (
          <div key={sec.id} className="rounded-lg overflow-hidden" style={{ background: "var(--bg-card)", border: "1px solid rgba(0,240,255,0.08)" }}>
            <button
              onClick={() => setOpenSection(open ? "" : sec.id)}
              className="w-full flex items-center justify-between px-4 py-3 text-left"
            >
              <span className="text-[13px] font-bold">{sec.emoji} {sec.title}</span>
              <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
                {secAnswered}/{sec.questions.length} {open ? "▼" : "▶"}
              </span>
            </button>
            {open && (
              <div className="px-4 pb-4 space-y-4">
                <p className="text-[11px] text-[var(--color-text-secondary)] leading-relaxed">{sec.description}</p>
                {sec.questions.map((q) => (
                  <QuestionField key={q.id} q={q} value={answers[q.id]} onChange={(v) => set(q.id, v)} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* 保存 */}
      <div className="rounded-lg px-4 py-3 space-y-2" style={{ background: "var(--bg-card)", border: "1px solid rgba(0,240,255,0.10)" }}>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="この時点の一言 (任意) — 例: 大きく負けた翌日の気持ち"
          className="w-full bg-transparent border-b border-[var(--color-border)] px-1 py-1.5 text-[12px] outline-none"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-[12px] font-bold rounded"
            style={{ background: "var(--color-accent)", color: "#001", opacity: saving ? 0.6 : 1, ...MONO }}
          >
            {saving ? "保存中…" : "保存する"}
          </button>
          {savedMsg && <span className="text-[11px]" style={{ color: "#22c55e" }}>{savedMsg}</span>}
        </div>
      </div>

      {/* 履歴 */}
      <div className="rounded-lg" style={{ background: "var(--bg-card)", border: "1px solid rgba(0,240,255,0.08)" }}>
        <button onClick={() => setShowHistory((v) => !v)} className="w-full text-left px-4 py-3 text-[12px] font-bold">
          📚 これまでの記録 ({history.length}件) {showHistory ? "▼" : "▶"}
        </button>
        {showHistory && (
          <div className="px-4 pb-4 space-y-3">
            {history.length === 0 && <div className="text-[11px] text-[var(--color-text-secondary)]">まだ記録がありません</div>}

            {/* スコアの推移 */}
            {history.length >= 2 && (
              <div>
                <div className="text-[10px] text-[var(--color-text-secondary)] mb-1" style={MONO}>気持ちの推移 (古い→新しい)</div>
                {(Object.keys(SCORE_META) as ScoreKey[]).map((k) => {
                  const vals = [...history].reverse().map((h) => h.scores?.[k]).filter((v): v is number => typeof v === "number");
                  if (vals.length < 2) return null;
                  const first = vals[0], last = vals[vals.length - 1];
                  const diff = last - first;
                  return (
                    <div key={k} className="flex items-center gap-2 text-[11px] mb-0.5">
                      <span className="w-24">{SCORE_META[k].emoji} {SCORE_META[k].label}</span>
                      <Spark values={vals} />
                      <span className="tabular-nums" style={MONO}>{first} → {last}</span>
                      {Math.abs(diff) >= 8 && (
                        <span style={{ color: diff > 0 ? "#facc15" : "#38bdf8" }}>
                          {diff > 0 ? "▲" : "▼"}{Math.abs(diff)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* 各回の記録 */}
            {history.map((h) => (
              <div key={h.id} className="border-t border-white/5 pt-2">
                <div className="flex items-center gap-2 text-[11px]">
                  <span style={MONO} className="text-[var(--color-text-secondary)]">
                    {h.savedAt?.toDate?.().toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" }) ?? "—"}
                  </span>
                  {h.note && <span className="text-[var(--color-text)]">「{h.note}」</span>}
                </div>
                {h.changedKeys && h.changedKeys.length > 0 && (
                  <div className="mt-1 text-[10px] text-[var(--color-text-secondary)] leading-relaxed">
                    変更: {h.changedKeys.slice(0, 6).map((k) => questionById(k)?.label ?? k).join(" / ")}
                    {h.changedKeys.length > 6 && ` ほか${h.changedKeys.length - 6}件`}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 履歴スコアの簡易スパークライン */
function Spark({ values }: { values: number[] }) {
  const W = 70, H = 14;
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * W},${H - (v / 100) * H}`);
  return (
    <svg width={W} height={H} className="shrink-0 opacity-80">
      <polyline points={pts.join(" ")} fill="none" stroke="var(--color-accent)" strokeWidth={1.2} />
    </svg>
  );
}

function QuestionField({ q, value, onChange }: { q: Question; value: Answers[string]; onChange: (v: Answers[string]) => void }) {
  return (
    <div>
      <div className="text-[12px] font-semibold mb-0.5">
        {q.label}
        {q.mirrored && (
          <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded align-middle"
            style={{ color: "var(--color-accent)", border: "1px solid rgba(0,240,255,0.3)" }}
            title="この回答はポートフォリオ診断で実測データと突き合わせます">
            🪞 実測と照合
          </span>
        )}
      </div>
      {q.help && <div className="text-[10px] text-[var(--color-text-secondary)] mb-1.5 leading-relaxed">{q.help}</div>}

      {q.type === "single" && (
        <div className="space-y-1">
          {q.options?.map((o) => (
            <label key={o.value} className="flex items-start gap-2 cursor-pointer text-[12px]">
              <input type="radio" name={q.id} checked={value === o.value} onChange={() => onChange(o.value)} className="mt-0.5" />
              <span>{o.label}{o.note && <span className="text-[10px] text-[var(--color-text-secondary)]"> — {o.note}</span>}</span>
            </label>
          ))}
        </div>
      )}

      {q.type === "multi" && (
        <div className="flex flex-wrap gap-1.5">
          {q.options?.map((o) => {
            const arr = Array.isArray(value) ? value : [];
            const on = arr.includes(o.value);
            return (
              <button
                key={o.value}
                onClick={() => onChange(on ? arr.filter((v) => v !== o.value) : [...arr, o.value])}
                className="px-2.5 py-1 text-[11px] rounded"
                style={{
                  border: `1px solid ${on ? "var(--color-accent)" : "var(--color-border)"}`,
                  color: on ? "var(--color-accent)" : "var(--color-text-secondary)",
                  background: on ? "rgba(0,240,255,0.08)" : "transparent",
                }}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}

      {q.type === "scale" && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[var(--color-text-secondary)]">1</span>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onClick={() => onChange(String(n))}
              className="w-8 h-8 text-[12px] rounded-full"
              style={{
                border: `1px solid ${String(value) === String(n) ? "var(--color-accent)" : "var(--color-border)"}`,
                background: String(value) === String(n) ? "rgba(0,240,255,0.15)" : "transparent",
                color: String(value) === String(n) ? "var(--color-accent)" : "var(--color-text-secondary)",
                ...MONO,
              }}
            >
              {n}
            </button>
          ))}
          <span className="text-[10px] text-[var(--color-text-secondary)]">5</span>
        </div>
      )}

      {q.type === "number" && (
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            value={value == null ? "" : String(value)}
            onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
            placeholder={q.placeholder}
            className="bg-transparent border-b border-[var(--color-border)] px-1 py-1 text-[12px] outline-none w-40"
            style={MONO}
          />
          {q.unit && <span className="text-[11px] text-[var(--color-text-secondary)]">{q.unit}</span>}
        </div>
      )}

      {q.type === "month" && (
        <input
          type="month"
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          className="bg-transparent border-b border-[var(--color-border)] px-1 py-1 text-[12px] outline-none"
          style={MONO}
        />
      )}

      {q.type === "text" && (
        <textarea
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
          placeholder={q.placeholder}
          rows={2}
          className="w-full bg-transparent border border-[var(--color-border)] rounded px-2 py-1.5 text-[12px] outline-none resize-y"
        />
      )}

      {value != null && value !== "" && q.type !== "text" && (
        <div className="mt-1 text-[10px]" style={{ color: "var(--color-accent)" }}>
          → {labelOf(q.id, value)}
        </div>
      )}
    </div>
  );
}
