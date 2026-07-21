"use client";

import { TIER_META, tierOf } from "@/lib/fragile-terrain";

/**
 * 地形バッジ (score>=25 のときだけ表示)。
 * 安定 (84%) は出さない — 全銘柄に付くとノイズになるため (Phase2 実測の判断)。
 */
export default function TerrainBadge({ score, size = "sm" }: { score: number | null; size?: "sm" | "xs" }) {
  if (score == null || score < 25) return null;
  const meta = TIER_META[tierOf(score)];
  const px = size === "xs" ? "text-[8px] px-1 py-0" : "text-[9px] px-1.5 py-0.5";
  return (
    <span
      className={`${px} shrink-0 rounded`}
      style={{ background: `${meta.color}20`, color: meta.color, border: `1px solid ${meta.color}55`, fontFamily: "'JetBrains Mono', monospace" }}
      title={`地形リスク ${score} — ${meta.label}`}
    >
      {meta.emoji}{meta.short}
    </span>
  );
}
