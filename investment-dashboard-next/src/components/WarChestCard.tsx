"use client";

import { useRegimeGauge } from "@/components/RegimeGauge";
import { regimeLevel, REGIME_META } from "@/lib/regime-gauge";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

/**
 * 💰 弾薬庫 (war chest) — ポートフォリオページ常設
 *
 * 清原『わが投資術』の核心: 暴落 (レジーム級の洗い流し) はボーナスだが、
 * それを拾える弾 (現金) は暴落時には作れない。平時の「政策」でしか作れない。
 * このカードは「今の現金比率」と「レジーム測定器が示す投入の目安」を並べて、
 * 平時は貯める規律・洗い流し時は使う勇気の両方を支える。
 */
export default function WarChestCard({ cashJpy, totalAssets }: { cashJpy: number; totalAssets: number }) {
  const g = useRegimeGauge();
  if (totalAssets <= 0) return null;

  const cashPct = Math.round((cashJpy / totalAssets) * 1000) / 10;
  const level = g ? regimeLevel(g.low60Pct) : null;
  const meta = level ? REGIME_META[level] : null;
  const hot = level === "historic" || level === "regime" || level === "washing";

  // 平時の政策目安: 総資産の15%を弾薬として維持 (洗い流しが来た時に動ける最低限)
  const POLICY_PCT = 15;
  const short = cashPct < POLICY_PCT;

  return (
    <div
      className="rounded-lg px-4 py-3"
      style={{
        background: hot && meta ? `${meta.color}0d` : "var(--bg-card)",
        border: `1px solid ${hot && meta ? meta.color : "rgba(0,240,255,0.08)"}`,
      }}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>
          💰 弾薬庫
        </span>
        <span className="text-sm font-bold tabular-nums" style={MONO}>
          現金 ¥{Math.round(cashJpy).toLocaleString("ja-JP")}
          <span className="ml-1.5 text-xs font-semibold" style={{ color: short ? "#facc15" : "#22c55e" }}>
            ({cashPct}%)
          </span>
        </span>
        <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
          政策目安 {POLICY_PCT}%
        </span>
        {/* 現金比率バー (政策ラインの目盛付き) */}
        <div className="relative h-1.5 flex-1 min-w-[100px] rounded-full overflow-hidden" style={{ background: "rgba(148,163,184,0.15)" }}>
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${Math.min(cashPct, 40) / 40 * 100}%`, background: short ? "#facc15" : "#22c55e" }}
          />
          <div className="absolute inset-y-0 w-px bg-white/40" style={{ left: `${(POLICY_PCT / 40) * 100}%` }} />
        </div>
      </div>

      <div className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
        {hot && meta && meta.warChest ? (
          <span style={{ color: meta.color }} className="font-semibold">
            {meta.emoji} {meta.label} (60日安値 {g!.low60Pct}%) — {meta.warChest}
          </span>
        ) : short ? (
          <>洗い流し (レジーム測定器 25%超) が来た時に動けるのは平時に貯めた弾だけ。新規買いは慎重に、弾薬の回復を優先。</>
        ) : (
          <>弾薬は政策水準を確保。平常時はこの規律を維持し、レジーム測定器が洗い流しを示した時に段階投入する。</>
        )}
      </div>
    </div>
  );
}
