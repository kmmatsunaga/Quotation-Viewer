"use client";

/**
 * 📅 イベント地平線 — 確定した未来だけを並べる
 *
 * 「先読み」の第一の形。予測はできないが、日程はもう決まっている。
 * 各イベントには過去の実測反応幅だけを添える (確率は出さない)。
 */

import { useEffect, useState } from "react";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface Reaction { name: string; samples: number; meanAbsMovePct: number; maxUpPct: number; maxDownPct: number; upRate: number; note: string }
interface MacroItem { date: string; releaseDate: string; name: string; daysAhead: number; reaction: Reaction | null }
interface EarningsItem { ticker: string; name: string; date: string; daysAhead: number; held: boolean }
interface Horizon { generatedAt: string; windowDays: number; macro: MacroItem[]; earnings: EarningsItem[]; note: string }

export default function EventHorizon({ tickers = [], heldTickers = [] }: { tickers?: string[]; heldTickers?: string[] }) {
  const [h, setH] = useState<Horizon | null>(null);
  const [open, setOpen] = useState(false);

  const key = tickers.join(",");
  useEffect(() => {
    const qs = new URLSearchParams({ days: "21" });
    if (tickers.length) qs.set("tickers", tickers.join(","));
    if (heldTickers.length) qs.set("held", heldTickers.join(","));
    fetch(`/api/events/horizon?${qs}`)
      .then((r) => r.json())
      .then((j) => { if (j?.ok) setH(j.horizon as Horizon); })
      .catch((e) => console.error("[event-horizon]", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!h || (h.macro.length === 0 && h.earnings.length === 0)) return null;

  const next = h.macro[0];
  const soonEarnings = h.earnings.filter((e) => e.daysAhead <= 7);

  return (
    <div
      className="rounded-lg cursor-pointer select-none"
      style={{ background: "var(--bg-card)", border: "1px solid rgba(0,240,255,0.10)" }}
      onClick={() => setOpen((v) => !v)}
    >
      <div className="flex items-center gap-3 px-4 py-2.5 flex-wrap">
        <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] shrink-0" style={MONO}>
          📅 確定した未来
        </span>
        {next && (
          <span className="text-[12px]">
            次は <b>{next.name}</b>
            <span className="ml-1.5 text-[var(--color-text-secondary)]" style={MONO}>
              あと{next.daysAhead}日 ({next.date})
            </span>
            {next.reaction && (
              <span className="ml-2 text-[11px]" style={{ color: next.reaction.meanAbsMovePct >= 1.5 ? "#facc15" : "var(--color-text-secondary)" }}>
                過去平均 ±{next.reaction.meanAbsMovePct}%
              </span>
            )}
          </span>
        )}
        {soonEarnings.length > 0 && (
          <span className="text-[11px]" style={{ color: "#facc15" }}>
            🗓 7日以内の決算 {soonEarnings.length}件
          </span>
        )}
        <span className="text-[9px] text-[var(--color-text-secondary)] ml-auto">{open ? "▼" : "▶"}</span>
      </div>

      {open && (
        <div className="px-4 pb-3 space-y-2 border-t border-white/5 pt-2">
          {h.macro.length > 0 && (
            <div>
              <div className="text-[10px] text-[var(--color-text-secondary)] mb-1" style={MONO}>マクロ日程 (今後{h.windowDays}日)</div>
              {h.macro.map((m, i) => (
                <div key={i} className="text-[11px] leading-relaxed mb-1">
                  <span className="tabular-nums text-[var(--color-text-secondary)]" style={MONO}>{m.date}</span>
                  <span className="ml-2 font-semibold">{m.name}</span>
                  <span className="ml-1.5 text-[var(--color-text-secondary)]">あと{m.daysAhead}日</span>
                  {m.reaction && (
                    <div className="text-[10px] text-[var(--color-text-secondary)] pl-1">{m.reaction.note}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {h.earnings.length > 0 && (
            <div>
              <div className="text-[10px] text-[var(--color-text-secondary)] mb-1" style={MONO}>決算予定</div>
              {h.earnings.map((e) => (
                <div key={e.ticker} className="text-[11px]">
                  <span className="tabular-nums text-[var(--color-text-secondary)]" style={MONO}>{e.date}</span>
                  <span className="ml-2">{e.name}</span>
                  <span className="ml-1 text-[10px] text-[var(--color-text-secondary)]">{e.ticker}</span>
                  <span className="ml-1.5 text-[var(--color-text-secondary)]">あと{e.daysAhead}日</span>
                  {e.held && <span className="ml-1.5" style={{ color: "#facc15" }}>保有中</span>}
                </div>
              ))}
            </div>
          )}

          <div className="text-[9px] text-[var(--color-text-secondary)] opacity-70 leading-relaxed">{h.note}</div>
        </div>
      )}
    </div>
  );
}
