"use client";

/**
 * PortfolioIntel — 保有銘柄のインテリジェンス層
 *
 * A. ⚠ 要注意の保有銘柄
 *    - 🚨 弱気転換 (保有中の評決が弱気側に変わった — favorites より一段重い)
 *    - ⚡ 見解対立中
 *    - 🧊 塩漬け疑い (含み損 × 評決弱気 × 90日以上保有)
 *    - 🗓 決算接近 (7日以内)
 *
 * B. 🧭 マクロ感応度マップ
 *    - セクター集中度 (評価額加重、jp-themes 連携)
 *    - マクロ要因への感応度 + 現在 追い風/不発 (fred-watch 連携)
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getSectorsForTicker, MACRO_DRIVER_LABELS } from "@/lib/jp-themes";
import { isDriverActive } from "@/lib/macro-drivers";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

export interface IntelGroup {
  ticker: string;
  name: string;
  valueJpy: number;            // 評価額 (円)
  pnlPct: number | null;       // 含み損益率 %
  oldestPurchaseDate: string | null; // YYYY-MM-DD
}

interface Stances { short: string; mid: string; long: string }

const STANCE_JA: Record<string, string> = {
  strong_bull: "強気", bull: "やや強気", neutral: "中立",
  bear: "やや弱気", strong_bear: "弱気", contested: "対立",
};
const TF_JA: Record<string, string> = { short: "短期", mid: "中期", long: "長期" };
const isBearish = (s?: string) => s === "bear" || s === "strong_bear";

interface Warning {
  level: 1 | 2 | 3;   // 1=🚨赤, 2=⚡紫, 3=🟡黄
  ticker: string;
  name: string;
  text: string;
}

export default function PortfolioIntel({ groups }: { groups: IntelGroup[] }) {
  const router = useRouter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [brief, setBrief] = useState<any>(null);
  const [stances, setStances] = useState<Record<string, Stances>>({});
  const [earnings, setEarnings] = useState<Record<string, { daysToNext: number | null }>>({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [macro, setMacro] = useState<any>(null);

  useEffect(() => {
    if (groups.length === 0) return;
    const tickers = groups.map((g) => g.ticker).join(",");
    fetch("/api/briefing").then((r) => (r.ok ? r.json() : null)).then(setBrief).catch(() => {});
    fetch("/api/verdict-latest").then((r) => (r.ok ? r.json() : null)).then((j) => setStances(j?.stances ?? {})).catch(() => {});
    fetch(`/api/stocks/next-earnings?tickers=${tickers}`).then((r) => (r.ok ? r.json() : null)).then((j) => setEarnings(j?.earnings ?? {})).catch(() => {});
    fetch("/api/macro/fred-watch").then((r) => (r.ok ? r.json() : null)).then(setMacro).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.map((g) => g.ticker).join(",")]);

  // ── A. 警告の組み立て ──
  const warnings = useMemo<Warning[]>(() => {
    const out: Warning[] = [];
    const nameOf = (t: string) => groups.find((g) => g.ticker === t)?.name ?? t;
    const held = new Set(groups.map((g) => g.ticker));

    // 評決変化 (保有銘柄のみ)
    const changes = (brief?.verdicts?.changes ?? []) as { ticker: string; tf: string; from: string; to: string }[];
    for (const c of changes) {
      if (!held.has(c.ticker)) continue;
      const text = `${TF_JA[c.tf] ?? c.tf}評決が ${STANCE_JA[c.from] ?? c.from} → ${STANCE_JA[c.to] ?? c.to} に変化`;
      if (isBearish(c.to)) {
        out.push({ level: 1, ticker: c.ticker, name: nameOf(c.ticker), text: `🚨 保有中に弱気転換: ${text}` });
      } else {
        out.push({ level: 3, ticker: c.ticker, name: nameOf(c.ticker), text: `🔄 ${text}` });
      }
    }

    // 対立中
    for (const g of groups) {
      const st = stances[g.ticker];
      if (st && [st.short, st.mid, st.long].includes("contested")) {
        out.push({ level: 2, ticker: g.ticker, name: g.name, text: "⚡ 見解対立中 — 証人が割れている。Verdict の中身を確認" });
      }
    }

    // 塩漬け疑い: 含み損 -10%超 × 中期or長期が弱気 × 90日以上保有
    const now = Date.now();
    for (const g of groups) {
      const st = stances[g.ticker];
      const daysHeld = g.oldestPurchaseDate ? (now - new Date(g.oldestPurchaseDate).getTime()) / 86400000 : null;
      if (
        g.pnlPct !== null && g.pnlPct <= -10 &&
        st && (isBearish(st.mid) || isBearish(st.long)) &&
        daysHeld !== null && daysHeld >= 90
      ) {
        out.push({
          level: 1,
          ticker: g.ticker,
          name: g.name,
          text: `🧊 塩漬け疑い: 含み損 ${g.pnlPct.toFixed(1)}% × 評決弱気 × ${Math.round(daysHeld)}日保有 — 「戻るはず」は根拠ですか?`,
        });
      }
    }

    // 決算接近
    for (const g of groups) {
      const d = earnings[g.ticker]?.daysToNext;
      if (d !== null && d !== undefined && d >= 0 && d <= 7) {
        out.push({ level: 3, ticker: g.ticker, name: g.name, text: `🗓 決算${d === 0 ? "本日" : `${d}日後`} — ボラティリティ警戒` });
      }
    }

    return out.sort((a, b) => a.level - b.level);
  }, [groups, brief, stances, earnings]);

  // ── B. マクロ感応度 ──
  const sensitivity = useMemo(() => {
    const totalValue = groups.reduce((s, g) => s + g.valueJpy, 0);
    if (totalValue <= 0) return null;

    const sectorExposure = new Map<string, { name: string; emoji: string; value: number }>();
    const driverExposure = new Map<string, number>();

    for (const g of groups) {
      const sectors = getSectorsForTicker(g.ticker);
      const seenDrivers = new Set<string>();
      for (const s of sectors) {
        const cur = sectorExposure.get(s.id) ?? { name: s.name, emoji: s.emoji, value: 0 };
        cur.value += g.valueJpy;
        sectorExposure.set(s.id, cur);
        for (const d of s.macroDrivers) seenDrivers.add(d);
      }
      // driver は銘柄単位で重複計上しない
      for (const d of seenDrivers) {
        driverExposure.set(d, (driverExposure.get(d) ?? 0) + g.valueJpy);
      }
    }

    const sectors = Array.from(sectorExposure.entries())
      .map(([id, s]) => ({ id, ...s, pct: (s.value / totalValue) * 100 }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 6);
    const drivers = Array.from(driverExposure.entries())
      .map(([d, v]) => ({ driver: d, pct: (v / totalValue) * 100, active: isDriverActive(d, macro) }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 8);
    const unclassified = groups
      .filter((g) => getSectorsForTicker(g.ticker).length === 0)
      .reduce((s, g) => s + g.valueJpy, 0);

    return { totalValue, sectors, drivers, unclassifiedPct: (unclassified / totalValue) * 100 };
  }, [groups, macro]);

  if (groups.length === 0) return null;

  return (
    <div className="space-y-3">
      {/* ── A. 要注意の保有銘柄 ── */}
      <div className="p-4 border space-y-2" style={{ borderColor: warnings.some((w) => w.level === 1) ? "rgba(239,68,68,0.5)" : "var(--color-border)", background: "var(--bg-card)" }}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-[var(--color-text)]" style={MONO}>
            ⚠ 要注意の保有銘柄
          </h3>
          <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
            評決・需給・イベントから自動検出
          </span>
        </div>
        {warnings.length === 0 ? (
          <div className="text-xs text-[var(--color-text-secondary)]" style={MONO}>
            ✓ 現時点で警告なし (評決データは日次更新)
          </div>
        ) : (
          <div className="space-y-1.5">
            {warnings.map((w, i) => (
              <button
                key={i}
                onClick={() => router.push(`/stock/${w.ticker}`)}
                className="w-full text-left p-2.5 border flex items-start gap-2 hover:brightness-110 transition-all"
                style={{
                  borderColor: w.level === 1 ? "rgba(239,68,68,0.45)" : w.level === 2 ? "rgba(167,139,250,0.45)" : "rgba(251,191,36,0.35)",
                  background: w.level === 1 ? "rgba(239,68,68,0.06)" : w.level === 2 ? "rgba(167,139,250,0.06)" : "rgba(251,191,36,0.05)",
                }}
              >
                <span className="text-xs font-bold text-[var(--color-accent)] shrink-0" style={MONO}>{w.ticker}</span>
                <span className="text-xs text-[var(--color-text-secondary)] shrink-0 max-w-[100px] truncate">{w.name}</span>
                <span className="text-xs text-[var(--color-text)]" style={MONO}>{w.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── B. マクロ感応度マップ ── */}
      {sensitivity && (
        <div className="p-4 border space-y-3" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
          <div className="flex items-center justify-between flex-wrap gap-1">
            <h3 className="text-sm font-bold text-[var(--color-text)]" style={MONO}>
              🧭 ポートフォリオのマクロ感応度
            </h3>
            <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
              評価額 ¥{Math.round(sensitivity.totalValue / 10000).toLocaleString()}万 を加重
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* セクター集中 */}
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-secondary)]" style={MONO}>
                セクター構成 (重複計上あり)
              </div>
              {sensitivity.sectors.length === 0 ? (
                <div className="text-xs text-[var(--color-text-secondary)]" style={MONO}>分類対象なし</div>
              ) : (
                sensitivity.sectors.map((s) => (
                  <div key={s.id} className="flex items-center justify-between" style={MONO}>
                    <span className="text-xs text-[var(--color-text)]">
                      {s.emoji} {s.name}
                      {s.pct >= 35 && <span className="text-[9px] ml-1.5 px-1 py-0.5" style={{ background: "rgba(239,68,68,0.12)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.4)" }}>⚠集中</span>}
                    </span>
                    <span className="text-lg font-black" style={{ color: s.pct >= 35 ? "#ef4444" : s.pct >= 20 ? "#fbbf24" : "var(--color-text)" }}>
                      {s.pct.toFixed(0)}%
                    </span>
                  </div>
                ))
              )}
              {sensitivity.unclassifiedPct > 5 && (
                <div className="text-[9px] text-[var(--color-text-secondary)] opacity-60" style={MONO}>
                  ※ 未分類 {sensitivity.unclassifiedPct.toFixed(0)}% (セクター定義外の銘柄)
                </div>
              )}
            </div>

            {/* マクロ要因の感応度 */}
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-secondary)]" style={MONO}>
                マクロ要因への露出 × 現在の状態
              </div>
              {sensitivity.drivers.length === 0 ? (
                <div className="text-xs text-[var(--color-text-secondary)]" style={MONO}>該当なし</div>
              ) : (
                sensitivity.drivers.map((d) => (
                  <div key={d.driver} className="flex items-center justify-between gap-2" style={MONO}>
                    <span className="text-xs text-[var(--color-text)] truncate">
                      {MACRO_DRIVER_LABELS[d.driver] ?? d.driver}
                    </span>
                    <span className="flex items-center gap-2 shrink-0">
                      <span
                        className="text-[9px] px-1.5 py-0.5"
                        style={{
                          background: d.active ? "rgba(34,197,94,0.12)" : "rgba(255,255,255,0.05)",
                          color: d.active ? "#22c55e" : "var(--color-text-secondary)",
                          border: `1px solid ${d.active ? "rgba(34,197,94,0.4)" : "var(--color-border)"}`,
                        }}
                      >
                        {d.active ? "🟢 追い風中" : "⚪ 不発"}
                      </span>
                      <span className="text-lg font-black text-[var(--color-text)]">{d.pct.toFixed(0)}%</span>
                    </span>
                  </div>
                ))
              )}
              <div className="text-[9px] text-[var(--color-text-secondary)] opacity-60" style={MONO}>
                ※ 「露出%」= その要因に連動するセクターの保有銘柄が資産に占める割合。
                🔮予兆でこの要因が動くと、その割合の資産が揺れる。
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
