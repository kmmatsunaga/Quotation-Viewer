"use client";

/**
 * 🧭 現在地コンパス (トップページ常設)
 *
 * 「当ててほしいわけではない。大きな流れの中でそれを読む力が欲しい」という
 * 要望への回答。予測は出さず、5つの物差しで現在地だけを示す。
 * 折りたたみ時は1行、展開すると各物差しの意味まで読める。
 */

import { useEffect, useState } from "react";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface Gauge { key: string; emoji: string; label: string; value: string; state: string; color: string; detail: string }
interface Reading { date: string; headline: string; headlineNote: string; gauges: Gauge[] }

let cache: Reading | null = null;
let inflight: Promise<void> | null = null;

export default function MarketCompass() {
  const [reading, setReading] = useState<Reading | null>(cache);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (cache) { setReading(cache); return; }
    if (!inflight) {
      inflight = fetch("/api/market-compass")
        .then((r) => r.json())
        .then((j) => { if (j?.ok && j.compass) cache = j.compass as Reading; })
        .catch((e) => console.error("[compass]", e));
    }
    inflight.then(() => setReading(cache));
  }, []);

  if (!reading) return null;

  return (
    <div
      className="rounded-lg cursor-pointer select-none"
      style={{ background: "var(--bg-card)", border: "1px solid rgba(0,240,255,0.12)" }}
      onClick={() => setOpen((v) => !v)}
    >
      {/* 1行サマリ */}
      <div className="flex items-center gap-3 px-4 py-2.5 flex-wrap">
        <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] shrink-0" style={MONO}>
          🧭 現在地
        </span>
        <span className="text-[13px] font-bold">{reading.headline}</span>
        <div className="flex items-center gap-2 ml-auto flex-wrap">
          {reading.gauges.map((g) => (
            <span key={g.key} className="text-[11px] tabular-nums" style={MONO} title={`${g.label}: ${g.state}`}>
              <span className="opacity-70">{g.emoji}</span>
              <span className="ml-0.5 font-bold" style={{ color: g.color }}>{g.value}</span>
            </span>
          ))}
          <span className="text-[9px] text-[var(--color-text-secondary)]">{open ? "▼" : "▶"}</span>
        </div>
      </div>

      {open && (
        <div className="px-4 pb-3 space-y-2 border-t border-white/5 pt-2">
          <p className="text-[12px] leading-relaxed text-[var(--color-text-secondary)]">{reading.headlineNote}</p>
          <div className="space-y-1.5">
            {reading.gauges.map((g) => (
              <div key={g.key} className="text-[11px] leading-relaxed">
                <span className="mr-1">{g.emoji}</span>
                <span className="font-semibold">{g.label}</span>
                <span className="mx-1.5 font-bold tabular-nums" style={{ ...MONO, color: g.color }}>{g.value}</span>
                <span style={{ color: g.color }}>{g.state}</span>
                <div className="text-[10px] text-[var(--color-text-secondary)] pl-5">{g.detail}</div>
              </div>
            ))}
          </div>
          <div className="text-[9px] text-[var(--color-text-secondary)] opacity-70">
            基準日 {reading.date} · すべて実測値です。今後の値動きの予測ではありません
          </div>
        </div>
      )}
    </div>
  );
}
