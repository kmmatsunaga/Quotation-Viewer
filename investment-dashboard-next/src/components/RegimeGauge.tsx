"use client";

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { regimeLevel, REGIME_META, type RegimeGaugeDoc } from "@/lib/regime-gauge";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

/**
 * 🌊 レジーム測定器 (トップページ常設)
 * 「市場の何%が60日安値か」で洗い流しの深さを毎晩測定。
 * 底の予測はしない — 深さは今この瞬間に測れる、が思想 (清原『わが投資術』)。
 */

let cache: RegimeGaugeDoc | null = null;
let inflight: Promise<void> | null = null;

export function useRegimeGauge(): RegimeGaugeDoc | null {
  const [, setReady] = useState(cache != null);
  useEffect(() => {
    if (cache) return;
    if (!inflight) {
      inflight = getDoc(doc(db, "meta", "regime_gauge"))
        .then((snap) => {
          if (snap.exists()) cache = snap.data() as RegimeGaugeDoc;
        })
        .catch(() => {});
    }
    inflight.then(() => setReady(true));
  }, []);
  return cache;
}

/** 履歴スパークライン (low60Pct, 0-80%スケール固定で日々の比較を可能に) */
function Spark({ history, color }: { history: { low60Pct: number }[]; color: string }) {
  if (history.length < 5) return null;
  const W = 120, H = 28, MAX = 80;
  const pts = history.map((p, i) => {
    const x = (i / (history.length - 1)) * W;
    const y = H - Math.min(p.low60Pct, MAX) / MAX * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={W} height={H} className="shrink-0 opacity-80">
      {/* レジーム級(40%)の基準線 */}
      <line x1={0} x2={W} y1={H - (40 / MAX) * H} y2={H - (40 / MAX) * H} stroke="#4ade80" strokeWidth={0.5} strokeDasharray="2,3" opacity={0.5} />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

export default function RegimeGauge() {
  const g = useRegimeGauge();
  const [open, setOpen] = useState(false);
  if (!g) return null;

  const level = regimeLevel(g.low60Pct);
  const meta = REGIME_META[level];
  const hot = level === "historic" || level === "regime" || level === "washing";
  const barPct = Math.min(g.low60Pct, 80) / 80 * 100;

  return (
    <div
      className="rounded-lg px-4 py-3 cursor-pointer select-none"
      style={{
        background: hot ? `${meta.color}14` : "var(--bg-card)",
        border: `1px solid ${hot ? meta.color : "rgba(0,240,255,0.08)"}`,
        boxShadow: hot ? `0 0 16px ${meta.color}33` : "none",
      }}
      onClick={() => setOpen((v) => !v)}
      title="クリックで解説"
    >
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base leading-none">{meta.emoji}</span>
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>
            レジーム測定器
          </span>
          <span className="text-xs font-semibold" style={{ color: meta.color }}>
            {meta.label}
          </span>
        </div>

        {/* ゲージバー: 市場の何%が60日安値か */}
        <div className="flex items-center gap-2 flex-1 min-w-[140px]">
          <div className="relative h-1.5 flex-1 rounded-full overflow-hidden" style={{ background: "rgba(148,163,184,0.15)" }}>
            <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${barPct}%`, background: meta.color }} />
            {/* 洗い流し(25%)/レジーム級(40%)/歴史的(60%) の目盛 */}
            {[25, 40, 60].map((m) => (
              <div key={m} className="absolute inset-y-0 w-px bg-white/25" style={{ left: `${(m / 80) * 100}%` }} />
            ))}
          </div>
          <span className="text-sm font-bold tabular-nums" style={{ ...MONO, color: meta.color }}>
            {g.low60Pct}%
          </span>
        </div>

        <Spark history={g.history ?? []} color={meta.color} />
        <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>{g.date}</span>
      </div>

      {open && (
        <div className="mt-2 pt-2 border-t border-white/5 space-y-1.5 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
          <div>
            流動銘柄 (売買代金1億円以上, {g.n}銘柄) のうち <b className="text-[var(--color-text)]">{g.low60Pct}%</b> が60日安値。
            20日安値は {g.low20Pct}%、60日高値 (過熱側) は {g.high60Pct}%。
          </div>
          <div>{meta.note}</div>
          {meta.warChest && (
            <div className="font-semibold" style={{ color: meta.color }}>💰 弾薬庫: {meta.warChest}</div>
          )}
          <div className="opacity-70">
            底の予測はしない。「どれだけ洗い流されたか」は今この瞬間に測れる — 深いほど、その後60日のリターンが実測で単調に大きかった
            (74.6%の日→+25.6% / ベースライン+5.3%。2年で2〜3エピソードの観察であり統計的確定ではない)。
          </div>
        </div>
      )}
    </div>
  );
}
