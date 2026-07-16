"use client";

/**
 * 💭 気づきメモ — どの画面からも1タップで書けるフローティングメモ
 *
 * 使い込み中に「引っかかった瞬間」をその場で1行残す壁打ちの球。
 * 今いる画面のパスと銘柄を自動記録するので「どこで何に引っかかったか」が後で分かる。
 */

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { addNote, getNotes, updateNote, deleteNote, type Note, type NoteCategory } from "@/lib/firestore";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

const CATS: { key: NoteCategory; label: string; emoji: string; color: string }[] = [
  { key: "usability", label: "使いにくい", emoji: "🔧", color: "#facc15" },
  { key: "feature", label: "欲しい", emoji: "💡", color: "#4ade80" },
  { key: "trust", label: "信用できない", emoji: "❓", color: "#a78bfa" },
  { key: "bug", label: "バグ", emoji: "🐛", color: "#ef4444" },
];

export default function QuickNote() {
  const { user } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [cat, setCat] = useState<NoteCategory>("usability");
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState(false);
  const [showList, setShowList] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);

  // 銘柄詳細ページなら ticker を抽出
  const tickerMatch = pathname.match(/^\/stock\/([^/]+)/);
  const ticker = tickerMatch ? decodeURIComponent(tickerMatch[1]) : null;

  const loadNotes = async () => {
    if (!user) return;
    setNotes(await getNotes(user.uid));
  };

  useEffect(() => {
    if (showList) loadNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showList]);

  // ボタンのバッジ用に件数を先読み
  useEffect(() => {
    if (user) loadNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, flash]);

  // ログインページなどでは出さない
  if (!user || pathname === "/login" || pathname === "/qr-login") return null;

  const save = async () => {
    if (!text.trim() || saving) return;
    setSaving(true);
    try {
      await addNote(user.uid, { text: text.trim(), category: cat, path: pathname, ticker, status: "open" });
      setText("");
      setOpen(false);
      setFlash(true);
      setTimeout(() => setFlash(false), 1500);
    } finally {
      setSaving(false);
    }
  };

  const openCount = notes.filter((n) => n.status === "open").length;

  return (
    <>
      {/* フローティングボタン: ラベル付きピルで「押せるボタン」と一目で分かる形に */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="fixed z-40 right-3 bottom-[calc(var(--bottom-nav-height)+env(safe-area-inset-bottom,0px)+16px)] md:bottom-8 h-11 px-4 rounded-full flex items-center gap-1.5 transition-all font-bold"
        style={{
          background: flash ? "rgba(74,222,128,0.95)" : "rgba(0,240,255,0.14)",
          border: `1.5px solid ${flash ? "#4ade80" : "var(--color-accent)"}`,
          color: flash ? "#052" : "var(--color-accent)",
          boxShadow: "0 3px 18px rgba(0,240,255,0.35)",
          backdropFilter: "blur(6px)",
        }}
        aria-label="気づきメモ"
      >
        <span className="text-lg">{flash ? "✓" : "💭"}</span>
        <span className="text-[13px]">{flash ? "残した!" : "メモ"}{!flash && openCount > 0 && ` ${openCount}`}</span>
      </button>

      {/* 入力パネル */}
      {open && (
        <div
          className="fixed z-40 right-3 bottom-[calc(var(--bottom-nav-height)+env(safe-area-inset-bottom,0px)+72px)] md:bottom-24 w-[calc(100vw-24px)] max-w-[360px] p-3 rounded-lg space-y-2.5"
          style={{ background: "rgba(13,16,36,0.98)", border: "1px solid var(--color-accent)", boxShadow: "0 8px 32px rgba(0,0,0,0.5)" }}
        >
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-bold text-[var(--color-accent)]">💭 気づきメモ</span>
            <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
              {pathname}{ticker ? ` · ${ticker}` : ""}
            </span>
          </div>

          <div className="flex gap-1">
            {CATS.map((c) => (
              <button
                key={c.key}
                onClick={() => setCat(c.key)}
                className="flex-1 py-1.5 text-[10px] border rounded"
                style={{
                  borderColor: cat === c.key ? c.color : "var(--color-border)",
                  color: cat === c.key ? c.color : "var(--color-text-secondary)",
                  background: cat === c.key ? `${c.color}14` : "transparent",
                }}
              >
                {c.emoji}<br />{c.label}
              </button>
            ))}
          </div>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(); }}
            rows={2}
            autoFocus
            placeholder="1行でOK。例: warroomの評決、切替が速すぎて追えない"
            className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-2 text-[13px] text-[var(--color-text)] rounded"
          />
          <div className="flex gap-2">
            <button onClick={save} disabled={!text.trim() || saving}
              className="flex-1 py-2 text-[13px] font-bold rounded disabled:opacity-40"
              style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)", background: "rgba(0,240,255,0.08)" }}>
              {saving ? "保存中…" : "残す (⌘Enter)"}
            </button>
            <button onClick={() => { setShowList(true); setOpen(false); }}
              className="px-3 py-2 text-[12px] rounded" style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}>
              一覧 {openCount > 0 && <span className="text-[var(--color-accent)]">{openCount}</span>}
            </button>
          </div>
        </div>
      )}

      {/* 一覧モーダル */}
      {showList && (
        <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true">
          <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.6)" }} onClick={() => setShowList(false)} />
          <div className="absolute bottom-0 left-0 right-0 max-h-[80vh] overflow-y-auto rounded-t-2xl pb-safe"
            style={{ background: "rgba(8,10,22,0.98)", borderTop: "1px solid var(--color-accent)" }}>
            <div className="sticky top-0 px-4 py-3 flex items-center justify-between" style={{ background: "rgba(8,10,22,0.96)", borderBottom: "1px solid var(--color-border)" }}>
              <span className="text-[15px] font-bold text-[var(--color-text)]">💭 気づきメモ ({notes.length})</span>
              <button onClick={() => setShowList(false)} className="text-xl text-[var(--color-text-secondary)] px-2">✕</button>
            </div>
            <div className="px-3 py-3 space-y-2">
              {notes.length === 0 && <div className="text-center py-10 text-[13px] text-[var(--color-text-secondary)]">まだメモはありません</div>}
              {notes.map((n) => {
                const c = CATS.find((x) => x.key === n.category) ?? CATS[0];
                const done = n.status === "done";
                return (
                  <div key={n.id} className="p-2.5 border rounded flex items-start gap-2" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)", opacity: done ? 0.5 : 1 }}>
                    <span className="text-sm shrink-0">{c.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] text-[var(--color-text)]" style={{ textDecoration: done ? "line-through" : "none" }}>{n.text}</div>
                      <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5" style={MONO}>{n.path}{n.ticker ? ` · ${n.ticker}` : ""}</div>
                    </div>
                    <div className="flex flex-col gap-1 shrink-0">
                      <button onClick={async () => { await updateNote(user.uid, n.id!, { status: done ? "open" : "done" }); loadNotes(); }}
                        className="text-[10px] px-1.5 py-0.5 border rounded" style={{ borderColor: "var(--color-border)", color: done ? "#4ade80" : "var(--color-text-secondary)" }}>
                        {done ? "戻す" : "済"}
                      </button>
                      <button onClick={async () => { await deleteNote(user.uid, n.id!); loadNotes(); }}
                        className="text-[10px] px-1.5 py-0.5 text-[var(--color-text-secondary)]">✕</button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="px-4 pb-4 text-[11px] text-[var(--color-text-secondary)] opacity-70 leading-relaxed">
              ※ 次に開発する時、私 (Cavka) がこの一覧を読んで「機械のループ行き / UI修正 / 仕様相談」に仕分けします。
            </div>
          </div>
        </div>
      )}
    </>
  );
}
