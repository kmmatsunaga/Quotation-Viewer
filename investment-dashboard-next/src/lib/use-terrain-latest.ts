"use client";

/**
 * 全銘柄の最新地形スコア (meta/terrain_latest) を1回だけ読んで共有するフック。
 * score>=25 の銘柄のみ入っている (安定84%はバッジ不要なので保存されない)。
 * スクリーナー/ランキング/briefing のバッジ・フィルタが安価に使う。
 */

import { useEffect, useState } from "react";
import { tierOf, type TerrainTier } from "@/lib/fragile-terrain";

let cache: { date: string | null; scores: Record<string, number> } | null = null;
let inflight: Promise<void> | null = null;

export interface TerrainLatest {
  date: string | null;
  scoreOf: (ticker: string) => number | null;
  tierOf: (ticker: string) => TerrainTier | null;
  ready: boolean;
}

export function useTerrainLatest(): TerrainLatest {
  const [ready, setReady] = useState(cache != null);

  useEffect(() => {
    if (cache) { setReady(true); return; }
    if (!inflight) {
      // meta はクライアントから直接読めない (ルールが users/ 配下のみ) → API経由
      inflight = fetch("/api/meta/terrain_latest")
        .then((r) => r.json())
        .then((j) => {
          const d = j?.data;
          cache = { date: d?.date ?? null, scores: (d?.scores as Record<string, number>) ?? {} };
        })
        .catch(() => { cache = { date: null, scores: {} }; });
    }
    inflight.then(() => setReady(true));
  }, []);

  return {
    date: cache?.date ?? null,
    scoreOf: (t) => cache?.scores[t] ?? null,
    tierOf: (t) => {
      const s = cache?.scores[t];
      return s != null ? tierOf(s) : null;
    },
    ready,
  };
}
