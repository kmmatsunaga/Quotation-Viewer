"use client";

import { useState } from "react";
import { type Commentary, TONE_COLOR } from "@/lib/commentary";
import { resolveTerms } from "@/lib/glossary";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

/**
 * 自動解説の共通パネル (◯◯の温度計)。
 * 板・テクニカル・業績など、各アセッサが返す Commentary を統一デザインで描画。
 * 折りたたみ可 (デフォルト開)。
 */
export default function CommentaryPanel({
  title,
  c,
  defaultOpen = true,
}: {
  title: string;
  c: Commentary;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const glossary = resolveTerms(c.terms);
  return (
    <div
      className="rounded overflow-hidden"
      style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--color-border)" }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
        style={MONO}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-sm">{c.temp.emoji}</span>
          <span className="text-xs font-bold" style={{ color: c.temp.color }}>
            {title}: {c.temp.label}
          </span>
        </span>
        <span className="text-[10px] text-[var(--color-text-secondary)] shrink-0">
          {open ? "▲ 閉じる" : "▼ 読み解く"}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2.5">
          <div
            className="px-3 py-2 rounded text-xs leading-relaxed"
            style={{ background: `${c.temp.color}12`, border: `1px solid ${c.temp.color}55`, color: "var(--color-text)" }}
          >
            <span className="font-bold" style={{ color: c.temp.color }}>スタンス: </span>
            {c.stance}
          </div>

          <ul className="space-y-1.5">
            {c.lines.map((l, i) => (
              <li key={i} className="flex gap-2 text-[11px] leading-relaxed">
                <span className="shrink-0" style={{ color: TONE_COLOR[l.tone] }}>{l.icon}</span>
                <span className="text-[var(--color-text)]">{l.text}</span>
              </li>
            ))}
          </ul>

          {/* 📖 用語メモ (専門用語の注釈・学習用) */}
          {glossary.length > 0 && (
            <GlossaryList
              glossary={glossary}
              open={glossaryOpen}
              onToggle={() => setGlossaryOpen((o) => !o)}
            />
          )}

          <div
            className="text-[10px] leading-relaxed text-[var(--color-text-secondary)] pt-1.5 border-t border-[var(--color-border)]"
            style={MONO}
          >
            ⚠ {c.caveat}
          </div>
        </div>
      )}
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/** 用語メモの共通リスト表示 */
function GlossaryList({
  glossary,
  open,
  onToggle,
}: {
  glossary: { term: string; note: string }[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded" style={{ background: "rgba(0,240,255,0.03)", border: "1px solid var(--color-border)" }}>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left"
        style={MONO}
      >
        <span className="text-[11px] font-bold text-[var(--color-accent)]">📖 用語メモ ({glossary.length})</span>
        <span className="text-[10px] text-[var(--color-text-secondary)]">{open ? "▲ 閉じる" : "▼ 開く"}</span>
      </button>
      {open && (
        <dl className="px-2.5 pb-2.5 space-y-2">
          {glossary.map((g) => (
            <div key={g.term}>
              <dt className="text-[11px] font-bold" style={{ color: "var(--color-accent)", ...MONO }}>{g.term}</dt>
              <dd className="text-[10.5px] leading-relaxed text-[var(--color-text)] opacity-80 mt-0.5">{g.note}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * 温度計 (Commentary) を持たないパネル向けの、用語メモ単体ボックス。
 * terms に glossary.ts のキーを渡すだけで注釈が出る。
 */
export function GlossaryBox({ terms, defaultOpen = false }: { terms: string[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const glossary = resolveTerms(terms);
  if (glossary.length === 0) return null;
  return <GlossaryList glossary={glossary} open={open} onToggle={() => setOpen((o) => !o)} />;
}
