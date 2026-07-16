"use client";

/**
 * /pattern-factory — 🏭 パターン工場
 *
 * Cavka が市場全体 (全JP銘柄×2年) から自動採掘した「翌日の値動きの型」の生態系。
 *   - 昇格: 発見後のライブ検証でもエッジが生存した本物
 *   - 検証中: 発見したばかり / ライブ実績を蓄積中
 *   - 墓場: ライブでエッジが崩れた (幻だった) 型
 *
 * 人間の直感ではなく統計が選んだ型。悪い型はシステムが自分で見限る。
 */

import { useEffect, useState } from "react";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };
const UP = "var(--color-up)";
const DOWN = "var(--color-down)";

interface Pattern {
  id: string;
  labels: string[];
  direction: "long" | "short";
  status: "promoted" | "incubating" | "retired";
  n: number; winPct: number; avgRet: number;
  winFirst: number; winSecond: number;
  edge: number; z: number; baseline: number;
  liveN: number | null; liveDays: number | null; liveWinPct: number | null; liveAvgRet: number | null;
  discoveredDate: string | null; lastFired: string | null;
}

interface MidPattern extends Pattern {
  horizonDays: number;
  nEff: number;
  medRet: number;
}

interface SurgePattern {
  id: string;
  labels: string[];
  status: "promoted" | "incubating" | "retired";
  n: number; surges: number;
  surgeRate: number; crashRate: number; baseRate: number;
  lift: number; z: number; avgRet: number; medRet: number;
  rateFirst: number; rateSecond: number;
  liveN: number | null; liveDays: number | null; liveSurges: number | null; liveRate: number | null;
  discoveredDate: string | null;
}

interface Resp {
  ok: boolean;
  counts: { promoted: number; incubating: number; retired: number };
  patterns: Pattern[];
  midCounts?: { promoted: number; incubating: number; retired: number };
  midPatterns?: MidPattern[];
  surgeCounts?: { promoted: number; incubating: number; retired: number };
  surgePatterns?: SurgePattern[];
  error?: string;
}

const STATUS_META: Record<string, { label: string; color: string; emoji: string; desc: string }> = {
  promoted: { label: "昇格", color: "#4ade80", emoji: "🏅", desc: "発見後のライブ検証でもエッジが生存した本物" },
  incubating: { label: "検証中", color: "#facc15", emoji: "🔬", desc: "発見したばかり / ライブ実績を蓄積中" },
  retired: { label: "墓場", color: "#6b7280", emoji: "⚰️", desc: "ライブでエッジが崩れた (幻だった型)" },
};

export default function PatternFactoryPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"promoted" | "incubating" | "retired">("incubating");
  const [scope, setScope] = useState<"day" | "mid" | "surge">("day");

  useEffect(() => {
    fetch("/api/patterns/factory")
      .then((r) => r.json())
      .then((j: Resp) => {
        setData(j);
        setLoading(false);
        // 昇格があれば昇格タブを初期表示
        if (j.counts?.promoted > 0) setTab("promoted");
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-center py-20 text-sm" style={MONO}>パターン生態系を読み込み中...</div>;
  if (!data?.ok) return <div className="text-center py-20 text-sm text-red-400" style={MONO}>⚠ {data?.error ?? "取得失敗"}</div>;

  const isMid = scope === "mid";
  const isSurge = scope === "surge";
  const counts = isSurge
    ? (data.surgeCounts ?? { promoted: 0, incubating: 0, retired: 0 })
    : isMid
      ? (data.midCounts ?? { promoted: 0, incubating: 0, retired: 0 })
      : data.counts;
  const shown = isSurge
    ? (data.surgePatterns ?? []).filter((p) => p.status === tab)
    : isMid
      ? (data.midPatterns ?? []).filter((p) => p.status === tab)
      : data.patterns.filter((p) => p.status === tab);
  const baseline = data.patterns[0]?.baseline ?? 48.3;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">🏭 パターン工場</h1>
        <p className="text-[14px] text-[var(--color-text-secondary)] mt-1.5 leading-relaxed">
          市場全体 (全JP銘柄×2年) から自動採掘した「値動きの型」。
          人間の直感ではなく統計が選ぶ。悪い型はシステムが自分で見限る。
        </p>
        {!isMid && (
          <p className="text-[10px] text-[var(--color-text-secondary)] mt-1" style={MONO}>
            ベースライン (無条件の翌日上昇率): {baseline}% ／ これを有意に超える/下回る型だけが生き残る
          </p>
        )}
        {isMid && (
          <p className="text-[10px] text-[var(--color-text-secondary)] mt-1" style={MONO}>
            重複補正済み (保有期間が重なるサンプルは割引)。🔴売り型は現物では「この状況で買わない」の見送りシグナル
          </p>
        )}
        {isSurge && (
          <p className="text-[10px] text-[var(--color-text-secondary)] mt-1" style={MONO}>
            翌日+8%急騰の前兆 (ベース率 ~1%)。急騰を「当てる」装置ではなく、候補を急騰しやすい地形に寄せるバイアス。暴落率も必ず見ること
          </p>
        )}
        <p className="text-[10px] mt-1 leading-relaxed" style={{ ...MONO, color: "#fbbf24" }}>
          ⚠ 過去データは現在の上場銘柄のみ (期間中の上場廃止銘柄を含まない = 生存者バイアス)。
          発見時の勝率は1割引いて読むこと。信じてよいのは「発見後ライブ」の数字だけ。
        </p>
      </div>

      {/* 時間軸切替 */}
      <div className="flex gap-2 flex-wrap">
        {([["day", "⚔ 翌日 (デイトレ)"], ["mid", "🌱 中長期 (5〜60日)"], ["surge", "🚀 急騰前兆"]] as const).map(([s, label]) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            className="px-4 py-2 text-sm border min-h-[44px] font-bold"
            style={{
              borderColor: scope === s ? "var(--color-accent)" : "var(--color-border)",
              color: scope === s ? "var(--color-accent)" : "var(--color-text-secondary)",
              background: scope === s ? "rgba(0,240,255,0.08)" : "transparent",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* status タブ */}
      <div className="flex gap-2 flex-wrap">
        {(["promoted", "incubating", "retired"] as const).map((s) => {
          const meta = STATUS_META[s];
          const active = tab === s;
          return (
            <button
              key={s}
              onClick={() => setTab(s)}
              className="px-3 py-2 text-xs border min-h-[44px]"
              style={{
                ...MONO,
                borderColor: active ? meta.color : "var(--color-border)",
                color: active ? meta.color : "var(--color-text-secondary)",
                background: active ? `${meta.color}14` : "transparent",
              }}
            >
              {meta.emoji} {meta.label} <span className="opacity-70">{counts[s]}</span>
            </button>
          );
        })}
      </div>

      <div className="text-[11px] text-[var(--color-text-secondary)] px-1" style={MONO}>
        {STATUS_META[tab].desc}
      </div>

      {shown.length === 0 ? (
        <div className="p-6 border text-center text-sm text-[var(--color-text-secondary)]" style={{ borderColor: "var(--color-border)", ...MONO }}>
          {tab === "promoted"
            ? "まだ昇格した型はありません。発見後のライブ検証 (最短2週間) を待っています。"
            : tab === "retired"
            ? "まだ墓場行きの型はありません。"
            : "検証中の型がありません。"}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {isSurge
            ? (shown as SurgePattern[]).map((p) => <SurgeCard key={p.id} p={p} />)
            : shown.map((p) => (
                <PatternCard key={p.id} p={p as Pattern} mid={isMid ? (p as MidPattern) : null} />
              ))}
        </div>
      )}
    </div>
  );
}

function PatternCard({ p, mid }: { p: Pattern; mid: MidPattern | null }) {
  const dirColor = p.direction === "long" ? UP : DOWN;
  const hasLive = p.liveN !== null && p.liveN >= 1;
  const dirLabel = mid
    ? p.direction === "long"
      ? `🟢${mid.horizonDays}日後 買い`
      : `⛔${mid.horizonDays}日後 見送り`
    : p.direction === "long"
      ? "🟢翌日買い"
      : "🔴翌日売り";
  return (
    <div className="p-4 border space-y-3" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
      {/* 型名 + 方向 */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {p.labels.map((l, i) => (
            <span key={i} className="text-[10px] px-1.5 py-0.5" style={{ ...MONO, background: "rgba(255,255,255,0.05)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}>
              {l}
            </span>
          ))}
        </div>
        <span className="text-xs font-bold whitespace-nowrap" style={{ color: mid && p.direction === "short" ? "#94a3b8" : dirColor, ...MONO }}>
          {dirLabel}
        </span>
      </div>

      {/* 発見時 (in-sample) */}
      <div className="flex items-baseline gap-4" style={MONO}>
        <div>
          <span className="text-[9px] text-[var(--color-text-secondary)] block">発見時 (過去2年)</span>
          <span className="text-3xl font-black" style={{ color: dirColor }}>{p.winPct}%</span>
          <span className="text-[10px] text-[var(--color-text-secondary)] ml-1">
            {mid ? `実効n=${mid.nEff}` : `n=${p.n}`} / edge{p.edge >= 0 ? "+" : ""}{p.edge}pt
          </span>
        </div>
        <div className="text-[10px] text-[var(--color-text-secondary)]">
          前半{p.winFirst}% / 後半{p.winSecond}%<br />
          z={p.z} {mid ? `中央値${mid.medRet >= 0 ? "+" : ""}${mid.medRet}%` : `平均${p.avgRet >= 0 ? "+" : ""}${p.avgRet}%`}
        </div>
      </div>

      {/* 発見後 (live) */}
      <div className="pt-2 border-t border-[var(--color-border)]" style={MONO}>
        <span className="text-[9px] text-[var(--color-text-secondary)] block">発見後ライブ (out-of-sample)</span>
        {hasLive ? (
          <div className="flex items-baseline gap-3">
            <span className="text-xl font-black" style={{ color: (p.liveWinPct ?? 0) >= p.baseline === (p.direction === "long") ? dirColor : "#6b7280" }}>
              {p.liveWinPct}%
            </span>
            <span className="text-[10px] text-[var(--color-text-secondary)]">
              n={p.liveN}{p.liveDays !== null && ` / ${p.liveDays}営業日`} 平均{(p.liveAvgRet ?? 0) >= 0 ? "+" : ""}{p.liveAvgRet}%
              {p.lastFired && ` / 直近 ${p.lastFired}`}
            </span>
          </div>
        ) : (
          <span className="text-xs text-[var(--color-text-secondary)]">
            蓄積中 (発見 {p.discoveredDate} 〜、まだ発火なし)
          </span>
        )}
      </div>
    </div>
  );
}

/** 🚀 急騰前兆カード: 急騰率と暴落率を並べて「宝くじ地形」を正直に見せる */
function SurgeCard({ p }: { p: SurgePattern }) {
  const hasLive = p.liveN !== null && p.liveN >= 1;
  return (
    <div className="p-4 border space-y-3" style={{ borderColor: "var(--color-border)", background: "var(--bg-card)" }}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {p.labels.map((l, i) => (
            <span key={i} className="text-[10px] px-1.5 py-0.5" style={{ ...MONO, background: "rgba(255,255,255,0.05)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}>
              {l}
            </span>
          ))}
        </div>
        <span className="text-xs font-bold whitespace-nowrap" style={{ color: UP, ...MONO }}>🚀 翌日+8%狙い</span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center" style={MONO}>
        <div className="p-2 border" style={{ borderColor: "rgba(255,59,107,0.4)" }}>
          <div className="text-[9px] text-[var(--color-text-secondary)]">急騰率</div>
          <div className="text-xl font-black" style={{ color: UP }}>{p.surgeRate}%</div>
          <div className="text-[9px] text-[var(--color-text-secondary)]">ベース{p.baseRate}%の{p.lift}倍</div>
        </div>
        <div className="p-2 border" style={{ borderColor: "rgba(239,68,68,0.4)" }}>
          <div className="text-[9px] text-[var(--color-text-secondary)]">暴落率(-8%)</div>
          <div className="text-xl font-black" style={{ color: "#ef4444" }}>{p.crashRate}%</div>
          <div className="text-[9px] text-[var(--color-text-secondary)]">ここも必ず見る</div>
        </div>
        <div className="p-2 border" style={{ borderColor: "var(--color-border)" }}>
          <div className="text-[9px] text-[var(--color-text-secondary)]">翌日 平均/中央値</div>
          <div className="text-sm font-black text-[var(--color-text)]">{p.avgRet >= 0 ? "+" : ""}{p.avgRet}%</div>
          <div className="text-[9px]" style={{ color: p.medRet >= 0 ? UP : DOWN }}>{p.medRet >= 0 ? "+" : ""}{p.medRet}%</div>
        </div>
      </div>

      <div className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
        n={p.n.toLocaleString()} 急騰{p.surges}件 z={p.z} / 前半{p.rateFirst}% 後半{p.rateSecond}%
      </div>

      <div className="pt-2 border-t border-[var(--color-border)]" style={MONO}>
        <span className="text-[9px] text-[var(--color-text-secondary)] block">発見後ライブ (out-of-sample)</span>
        {hasLive ? (
          <span className="text-xs text-[var(--color-text)]">
            ライブ急騰率 <strong style={{ color: UP }}>{p.liveRate}%</strong> (発火{p.liveN} / 急騰{p.liveSurges} / {p.liveDays}営業日)
          </span>
        ) : (
          <span className="text-xs text-[var(--color-text-secondary)]">蓄積中 (発見 {p.discoveredDate} 〜)</span>
        )}
      </div>
    </div>
  );
}
