"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { NIKKEI225 } from "@/lib/nikkei225";
import type { FundamentalData } from "@/app/api/stocks/fundamentals/route";
import MomentumScreenerPanel from "./MomentumScreenerPanel";

type ScreenerMode = "fundamental" | "momentum";
const SS_MODE = "cavka_screener_mode";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

// フィルタ条件の型
interface FilterCriteria {
  // ① バリュエーション
  perMax: number | null;
  pbrMax: number | null;
  pegMax: number | null;
  evEbitdaMax: number | null;

  // ② 収益性
  roeMin: number | null;
  operatingMarginMin: number | null;

  // ③ 財務健全性
  debtToEquityMax: number | null;
  currentRatioMin: number | null;
  netCashOnly: boolean;

  // ④ 成長性
  revenueGrowthMin: number | null;
  earningsGrowthMin: number | null;

  // ⑤ 株主還元
  dividendYieldMin: number | null;
  payoutRatioMin: number | null;
  payoutRatioMax: number | null;
}

const DEFAULT_FILTER: FilterCriteria = {
  perMax: null,
  pbrMax: null,
  pegMax: null,
  evEbitdaMax: null,
  roeMin: null,
  operatingMarginMin: null,
  debtToEquityMax: null,
  currentRatioMin: null,
  netCashOnly: false,
  revenueGrowthMin: null,
  earningsGrowthMin: null,
  dividendYieldMin: null,
  payoutRatioMin: null,
  payoutRatioMax: null,
};

// プリセット
const PRESETS: { label: string; emoji: string; category: string; desc: string; filter: Partial<FilterCriteria> }[] = [
  // ── 王道バリュー ──
  {
    label: "バフェット流バリュー",
    emoji: "💎",
    category: "バリュー",
    desc: "PER≤15 × PBR≤1.5 × ROE≥10% × 配当≥3%",
    filter: { perMax: 15, pbrMax: 1.5, roeMin: 10, dividendYieldMin: 3 },
  },
  {
    label: "ネットキャッシュ割安",
    emoji: "💰",
    category: "バリュー",
    desc: "PBR≤1 × ネットキャッシュ × PER≤15",
    filter: { pbrMax: 1, netCashOnly: true, perMax: 15 },
  },
  {
    label: "割安＋高収益",
    emoji: "🎯",
    category: "バリュー",
    desc: "PER≤12 × ROE≥12% × 営業利益率≥10%",
    filter: { perMax: 12, roeMin: 12, operatingMarginMin: 10 },
  },

  // ── インカム/配当 ──
  {
    label: "高配当・財務健全",
    emoji: "🏦",
    category: "配当",
    desc: "配当≥3.5% × 配当性向30-60% × D/E≤100",
    filter: { dividendYieldMin: 3.5, payoutRatioMin: 30, payoutRatioMax: 60, debtToEquityMax: 100 },
  },
  {
    label: "ディフェンシブ高配当",
    emoji: "🛡️",
    category: "配当",
    desc: "配当≥4% × 配当性向40-70% × D/E≤80",
    filter: { dividendYieldMin: 4, payoutRatioMin: 40, payoutRatioMax: 70, debtToEquityMax: 80 },
  },

  // ── 成長株 ──
  {
    label: "成長株（GARP）",
    emoji: "📈",
    category: "成長",
    desc: "PEG≤1 × 利益成長≥10% × ROE≥12%",
    filter: { pegMax: 1, earningsGrowthMin: 10, roeMin: 12 },
  },
  {
    label: "テンバガー候補",
    emoji: "🚀",
    category: "成長",
    desc: "売上成長≥20% × 利益成長≥25% × ROE≥15%",
    filter: { revenueGrowthMin: 20, earningsGrowthMin: 25, roeMin: 15 },
  },
  {
    label: "業績ターンアラウンド",
    emoji: "🔄",
    category: "成長",
    desc: "利益成長≥50% × 売上成長≥5% (急回復銘柄)",
    filter: { earningsGrowthMin: 50, revenueGrowthMin: 5 },
  },

  // ── 質 ──
  {
    label: "Quality Factor",
    emoji: "⭐",
    category: "質",
    desc: "ROE≥15% × 営業利益率≥15% × D/E≤50",
    filter: { roeMin: 15, operatingMarginMin: 15, debtToEquityMax: 50 },
  },
  {
    label: "スーパー優良企業",
    emoji: "👑",
    category: "質",
    desc: "ROE≥20% × 営業利益率≥20% × ネットキャッシュ",
    filter: { roeMin: 20, operatingMarginMin: 20, netCashOnly: true },
  },

  // ── モメンタム ──
  {
    label: "モメンタム成長",
    emoji: "⚡",
    category: "モメンタム",
    desc: "売上成長≥15% × 利益成長≥20% × ROE≥10%",
    filter: { revenueGrowthMin: 15, earningsGrowthMin: 20, roeMin: 10 },
  },
];

type SortKey = "ticker" | "per" | "pbr" | "roe" | "dividendYield" | "marketCap" | "operatingMargin" | "earningsGrowth";

// sessionStorage keys
const SS_RESULTS = "cavka_screener_results";
const SS_FILTER = "cavka_screener_filter";

export default function ScreenerPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [mode, setMode] = useState<ScreenerMode>("fundamental");
  // モード永続化
  useEffect(() => {
    try {
      const cached = sessionStorage.getItem(SS_MODE);
      if (cached === "fundamental" || cached === "momentum") setMode(cached);
    } catch {}
  }, []);
  useEffect(() => {
    try { sessionStorage.setItem(SS_MODE, mode); } catch {}
  }, [mode]);
  const [filter, setFilter] = useState<FilterCriteria>(DEFAULT_FILTER);
  const [allResults, setAllResults] = useState<FundamentalData[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ done: 0, total: 0 });
  const [scannedAll, setScannedAll] = useState(false);
  const [scanScope, setScanScope] = useState<"nikkei225" | "full">("nikkei225");
  const [sortKey, setSortKey] = useState<SortKey>("roe");
  const [sortAsc, setSortAsc] = useState(false);
  const [showFilters, setShowFilters] = useState(true);
  const abortRef = useRef(false);
  const [cacheInfo, setCacheInfo] = useState<{ updatedAt: string | null; source: "session" | "firestore" | "fresh" } | null>(null);

  // Restore: 優先順位 [sessionStorage → Firestore キャッシュ → 空]
  useEffect(() => {
    try {
      const cachedFilter = sessionStorage.getItem(SS_FILTER);
      if (cachedFilter) setFilter({ ...DEFAULT_FILTER, ...JSON.parse(cachedFilter) });
    } catch {}

    (async () => {
      // 1. sessionStorage
      try {
        const cachedResults = sessionStorage.getItem(SS_RESULTS);
        if (cachedResults) {
          const parsed = JSON.parse(cachedResults) as FundamentalData[];
          if (parsed.length > 0) {
            setAllResults(parsed);
            setScannedAll(true);
            setScanProgress({ done: parsed.length, total: parsed.length });
            setCacheInfo({ updatedAt: null, source: "session" });
            return;
          }
        }
      } catch {}

      // 2. Firestore キャッシュ
      try {
        const res = await fetch(`/api/screener/cache?scope=${scanScope}`);
        if (res.ok) {
          const data = await res.json();
          if (data.ok && data.results?.length > 0) {
            setAllResults(data.results);
            setScannedAll(true);
            setScanProgress({ done: data.results.length, total: data.results.length });
            setCacheInfo({ updatedAt: data.updatedAt, source: "firestore" });
          }
        }
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scan
  const scanStocks = useCallback(async () => {
    setScanning(true);
    setAllResults([]);
    setScannedAll(false);
    abortRef.current = false;

    // スコープに応じて対象を変える
    let allTickers: string[] = NIKKEI225.map((s) => s.ticker);
    if (scanScope === "full") {
      try {
        const res = await fetch("/api/stocks/master");
        if (res.ok) {
          const data = await res.json();
          if (data.ok && data.stocks?.length > 0) {
            allTickers = (data.stocks as { ticker: string }[]).map((s) => s.ticker);
          }
        }
      } catch {}
    }
    const batchSize = 5;
    const results: FundamentalData[] = [];
    setScanProgress({ done: 0, total: allTickers.length });

    for (let i = 0; i < allTickers.length; i += batchSize) {
      if (abortRef.current) break;

      const batch = allTickers.slice(i, i + batchSize);
      try {
        const res = await fetch(
          `/api/stocks/fundamentals?tickers=${encodeURIComponent(batch.join(","))}`
        );
        if (res.ok) {
          const data = await res.json();
          for (const [, info] of Object.entries(data.fundamentals ?? {})) {
            results.push(info as FundamentalData);
          }
        }
      } catch {}

      setScanProgress({ done: Math.min(i + batchSize, allTickers.length), total: allTickers.length });
      const snapshot = [...results];
      setAllResults(snapshot);

      // Rate limiting
      if (i + batchSize < allTickers.length && !abortRef.current) {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }

    setScannedAll(true);
    setScanning(false);
    setCacheInfo({ updatedAt: new Date().toISOString(), source: "fresh" });

    // Save to sessionStorage
    try {
      sessionStorage.setItem(SS_RESULTS, JSON.stringify(results));
    } catch {}

    // Save to Firestore (全ユーザー共有キャッシュ)
    if (!abortRef.current && results.length > 0) {
      try {
        const { auth } = await import("@/lib/firebase");
        const token = await auth.currentUser?.getIdToken();
        if (token) {
          await fetch(`/api/screener/cache?scope=${scanScope}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ results }),
          });
        }
      } catch (e) {
        console.error("Cache save failed:", e);
      }
    }
  }, [scanScope]);

  // Save filter to sessionStorage
  useEffect(() => {
    try {
      sessionStorage.setItem(SS_FILTER, JSON.stringify(filter));
    } catch {}
  }, [filter]);

  // Apply filter
  const filtered = allResults.filter((d) => {
    if (filter.perMax !== null && (d.trailingPE === null || d.trailingPE > filter.perMax || d.trailingPE <= 0)) return false;
    if (filter.pbrMax !== null && (d.pbr === null || d.pbr > filter.pbrMax || d.pbr <= 0)) return false;
    if (filter.pegMax !== null && (d.pegRatio === null || d.pegRatio > filter.pegMax || d.pegRatio <= 0)) return false;
    if (filter.evEbitdaMax !== null && (d.evToEbitda === null || d.evToEbitda > filter.evEbitdaMax || d.evToEbitda <= 0)) return false;
    if (filter.roeMin !== null && (d.roe === null || d.roe < filter.roeMin)) return false;
    if (filter.operatingMarginMin !== null && (d.operatingMargin === null || d.operatingMargin < filter.operatingMarginMin)) return false;
    if (filter.debtToEquityMax !== null && (d.debtToEquity === null || d.debtToEquity > filter.debtToEquityMax)) return false;
    if (filter.currentRatioMin !== null && (d.currentRatio === null || d.currentRatio < filter.currentRatioMin)) return false;
    if (filter.netCashOnly && (d.netCash === null || d.netCash <= 0)) return false;
    if (filter.revenueGrowthMin !== null && (d.revenueGrowth === null || d.revenueGrowth < filter.revenueGrowthMin)) return false;
    if (filter.earningsGrowthMin !== null && (d.earningsGrowth === null || d.earningsGrowth < filter.earningsGrowthMin)) return false;
    if (filter.dividendYieldMin !== null && (d.dividendYield === null || d.dividendYield < filter.dividendYieldMin)) return false;
    if (filter.payoutRatioMin !== null && (d.payoutRatio === null || d.payoutRatio < filter.payoutRatioMin)) return false;
    if (filter.payoutRatioMax !== null && (d.payoutRatio !== null && d.payoutRatio > filter.payoutRatioMax)) return false;
    return true;
  });

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    let va: number | null = 0, vb: number | null = 0;
    switch (sortKey) {
      case "ticker": return sortAsc ? a.ticker.localeCompare(b.ticker) : b.ticker.localeCompare(a.ticker);
      case "per": va = a.trailingPE; vb = b.trailingPE; break;
      case "pbr": va = a.pbr; vb = b.pbr; break;
      case "roe": va = a.roe; vb = b.roe; break;
      case "dividendYield": va = a.dividendYield; vb = b.dividendYield; break;
      case "marketCap": va = a.marketCap; vb = b.marketCap; break;
      case "operatingMargin": va = a.operatingMargin; vb = b.operatingMargin; break;
      case "earningsGrowth": va = a.earningsGrowth; vb = b.earningsGrowth; break;
    }
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return sortAsc ? va - vb : vb - va;
  });

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  };

  const applyPreset = (preset: Partial<FilterCriteria>) => {
    setFilter({ ...DEFAULT_FILTER, ...preset });
  };

  const fmtNum = (v: number | null, digits = 1, suffix = "") => {
    if (v === null) return "—";
    return `${v.toFixed(digits)}${suffix}`;
  };

  const fmtBig = (v: number | null) => {
    if (v === null) return "—";
    if (v >= 1e12) return `${(v / 1e12).toFixed(1)}兆`;
    if (v >= 1e8) return `${(v / 1e8).toFixed(0)}億`;
    if (v >= 1e4) return `${(v / 1e4).toFixed(0)}万`;
    return v.toLocaleString();
  };

  const activeFilterCount = Object.entries(filter).filter(([k, v]) => {
    if (k === "netCashOnly") return v === true;
    return v !== null;
  }).length;

  return (
    <div className="space-y-6">
      {/* モード切替タブ */}
      <div className="flex gap-1 border-b border-[var(--color-border)]">
        {([
          { id: "fundamental" as const, label: "📊 ファンダメンタル", desc: "バフェット流など13プリセット" },
          { id: "momentum" as const, label: "🚀 モメンタム", desc: "未発見の主役候補スクリーニング" },
        ]).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setMode(tab.id)}
            className="px-4 py-2 text-sm transition-all"
            style={{
              ...MONO,
              color: mode === tab.id ? "var(--color-accent)" : "var(--color-text-secondary)",
              borderBottom: mode === tab.id ? "2px solid var(--color-accent)" : "2px solid transparent",
              fontWeight: mode === tab.id ? 700 : 400,
            }}
            title={tab.desc}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {mode === "momentum" && <MomentumScreenerPanel />}

      {mode === "fundamental" && (
        <div className="space-y-6">
      {/* ヘッダ */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">
          🔍 スクリーナー <span className="text-[12px] text-[var(--color-accent)] font-normal align-middle" style={MONO}>// FUNDAMENTAL</span>
        </h1>
        <div className="flex items-center gap-2 flex-wrap">
          {scannedAll && (
            <span className="text-xs text-[var(--color-text-secondary)]" style={MONO}>
              {filtered.length} / {allResults.length} 銘柄
              {cacheInfo?.source === "firestore" && cacheInfo.updatedAt && (
                <span className="ml-2 text-[10px] text-[var(--color-accent)]" title={cacheInfo.updatedAt}>
                  📦 共有キャッシュ ({new Date(cacheInfo.updatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })})
                </span>
              )}
              {cacheInfo?.source === "fresh" && (
                <span className="ml-2 text-[10px] text-[var(--color-accent-magenta)]">
                  🆕 最新
                </span>
              )}
            </span>
          )}
          {/* スコープ切替 */}
          <div className="flex gap-1">
            {[
              { id: "nikkei225" as const, label: "日経225", desc: "高速 (約1分)" },
              { id: "full" as const, label: "全銘柄", desc: "立花API全銘柄 (約15分)" },
            ].map((s) => (
              <button
                key={s.id}
                onClick={() => setScanScope(s.id)}
                disabled={scanning}
                className="px-2.5 py-1 text-[11px] disabled:opacity-50"
                style={{
                  border: `1px solid ${scanScope === s.id ? "var(--color-accent-magenta)" : "var(--color-border)"}`,
                  color: scanScope === s.id ? "var(--color-accent-magenta)" : "var(--color-text-secondary)",
                  background: scanScope === s.id ? "rgba(255,0,255,0.08)" : "transparent",
                  ...MONO,
                }}
                title={s.desc}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => { abortRef.current = true; }}
            disabled={!scanning}
            className="px-3 py-1.5 text-xs disabled:opacity-30"
            style={{ border: "1px solid var(--color-up)", color: "var(--color-up)", ...MONO }}
          >
            ABORT
          </button>
          <button
            onClick={scanStocks}
            disabled={scanning}
            className="px-4 py-2 text-sm font-medium min-h-[40px] disabled:opacity-50"
            style={{ border: "1px solid var(--color-accent)", background: scanning ? "rgba(0,240,255,0.1)" : "rgba(0,240,255,0.15)", color: "var(--color-accent)", ...MONO, boxShadow: "0 0 12px rgba(0,240,255,0.2)" }}
          >
            {scanning ? `SCANNING... ${scanProgress.done}/${scanProgress.total}` : `SCAN ${scanScope === "full" ? "全銘柄" : "日経225"}`}
          </button>
        </div>
      </div>

      {/* プログレスバー */}
      {scanning && (
        <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--color-border)" }}>
          <div
            className="h-full transition-all"
            style={{ width: `${scanProgress.total > 0 ? (scanProgress.done / scanProgress.total) * 100 : 0}%`, background: "var(--color-accent)", boxShadow: "0 0 8px var(--color-accent)" }}
          />
        </div>
      )}

      {/* プリセット (カテゴリ別) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>
            プリセット ({PRESETS.length}個)
          </span>
          <button
            onClick={() => setFilter(DEFAULT_FILTER)}
            className="px-2 py-1 text-[10px]"
            style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", ...MONO }}
          >
            RESET
          </button>
        </div>
        {(["バリュー", "配当", "成長", "質", "モメンタム"] as const).map((cat) => {
          const presets = PRESETS.filter((p) => p.category === cat);
          if (presets.length === 0) return null;
          return (
            <div key={cat}>
              <div className="text-[9px] uppercase tracking-[0.1em] text-[var(--color-accent-magenta)] mb-1.5" style={MONO}>
                {cat}
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {presets.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => applyPreset(p.filter)}
                    className="px-2.5 py-1.5 text-[11px] transition-all hover:shadow-[0_0_8px_rgba(0,240,255,0.2)] hover:border-[var(--color-accent)]"
                    style={{ border: "1px solid var(--color-border)", color: "var(--color-text)", background: "var(--bg-card)", ...MONO }}
                    title={p.desc}
                  >
                    {p.emoji} {p.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* フィルタパネル */}
      <div className="rounded" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className="w-full px-4 py-3 flex justify-between items-center text-left"
        >
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-accent)]" style={MONO}>
            Filter Criteria {activeFilterCount > 0 && `(${activeFilterCount})`}
          </span>
          <span className="text-xs text-[var(--color-text-secondary)]">{showFilters ? "▲" : "▼"}</span>
        </button>

        {showFilters && (
          <div className="px-4 pb-4 space-y-4" style={{ borderTop: "1px solid var(--color-border)" }}>
            {/* ① バリュエーション */}
            <FilterSection title="① 割安度（バリュエーション）" color="var(--color-accent)">
              <FilterInput label="PER ≤" value={filter.perMax} onChange={(v) => setFilter({ ...filter, perMax: v })} placeholder="15" />
              <FilterInput label="PBR ≤" value={filter.pbrMax} onChange={(v) => setFilter({ ...filter, pbrMax: v })} placeholder="1.5" step={0.1} />
              <FilterInput label="PEG ≤" value={filter.pegMax} onChange={(v) => setFilter({ ...filter, pegMax: v })} placeholder="1.0" step={0.1} />
              <FilterInput label="EV/EBITDA ≤" value={filter.evEbitdaMax} onChange={(v) => setFilter({ ...filter, evEbitdaMax: v })} placeholder="8" />
            </FilterSection>

            {/* ② 収益性 */}
            <FilterSection title="② 稼ぐ力（収益性）" color="var(--color-up)">
              <FilterInput label="ROE ≥" value={filter.roeMin} onChange={(v) => setFilter({ ...filter, roeMin: v })} placeholder="10" suffix="%" />
              <FilterInput label="営業利益率 ≥" value={filter.operatingMarginMin} onChange={(v) => setFilter({ ...filter, operatingMarginMin: v })} placeholder="10" suffix="%" />
            </FilterSection>

            {/* ③ 財務健全性 */}
            <FilterSection title="③ 財務健全性" color="#fbbf24">
              <FilterInput label="D/E比率 ≤" value={filter.debtToEquityMax} onChange={(v) => setFilter({ ...filter, debtToEquityMax: v })} placeholder="100" />
              <FilterInput label="流動比率 ≥" value={filter.currentRatioMin} onChange={(v) => setFilter({ ...filter, currentRatioMin: v })} placeholder="1.5" step={0.1} />
              <div className="flex items-center gap-2 pt-5">
                <input
                  type="checkbox"
                  checked={filter.netCashOnly}
                  onChange={(e) => setFilter({ ...filter, netCashOnly: e.target.checked })}
                  className="w-4 h-4 accent-[var(--color-accent)]"
                />
                <span className="text-xs text-[var(--color-text)]" style={MONO}>ネットキャッシュのみ</span>
              </div>
            </FilterSection>

            {/* ④ 成長性 */}
            <FilterSection title="④ 成長性" color="var(--color-accent-2)">
              <FilterInput label="売上成長率 ≥" value={filter.revenueGrowthMin} onChange={(v) => setFilter({ ...filter, revenueGrowthMin: v })} placeholder="5" suffix="%" />
              <FilterInput label="利益成長率 ≥" value={filter.earningsGrowthMin} onChange={(v) => setFilter({ ...filter, earningsGrowthMin: v })} placeholder="10" suffix="%" />
            </FilterSection>

            {/* ⑤ 株主還元 */}
            <FilterSection title="⑤ 株主還元" color="#a78bfa">
              <FilterInput label="配当利回り ≥" value={filter.dividendYieldMin} onChange={(v) => setFilter({ ...filter, dividendYieldMin: v })} placeholder="3.0" suffix="%" step={0.1} />
              <FilterInput label="配当性向 ≥" value={filter.payoutRatioMin} onChange={(v) => setFilter({ ...filter, payoutRatioMin: v })} placeholder="30" suffix="%" />
              <FilterInput label="配当性向 ≤" value={filter.payoutRatioMax} onChange={(v) => setFilter({ ...filter, payoutRatioMax: v })} placeholder="50" suffix="%" />
            </FilterSection>
          </div>
        )}
      </div>

      {/* 結果テーブル */}
      {allResults.length > 0 && (
        <div className="rounded overflow-hidden" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}>
          {/* ヘッダ */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]" style={MONO}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--color-border)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-secondary)" }}>
                  <SortHeader label="銘柄" sortKey="ticker" current={sortKey} asc={sortAsc} onClick={handleSort} />
                  <SortHeader label="PER" sortKey="per" current={sortKey} asc={sortAsc} onClick={handleSort} align="right" />
                  <SortHeader label="PBR" sortKey="pbr" current={sortKey} asc={sortAsc} onClick={handleSort} align="right" />
                  <SortHeader label="ROE" sortKey="roe" current={sortKey} asc={sortAsc} onClick={handleSort} align="right" />
                  <SortHeader label="営業利益率" sortKey="operatingMargin" current={sortKey} asc={sortAsc} onClick={handleSort} align="right" />
                  <SortHeader label="利益成長" sortKey="earningsGrowth" current={sortKey} asc={sortAsc} onClick={handleSort} align="right" />
                  <SortHeader label="配当利回り" sortKey="dividendYield" current={sortKey} asc={sortAsc} onClick={handleSort} align="right" />
                  <SortHeader label="時価総額" sortKey="marketCap" current={sortKey} asc={sortAsc} onClick={handleSort} align="right" />
                  <th className="px-3 py-2 text-right">PEG</th>
                  <th className="px-3 py-2 text-right">D/E</th>
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 && (
                  <tr>
                    <td colSpan={10} className="py-8 text-center text-sm text-[var(--color-text-secondary)]">
                      {activeFilterCount > 0 ? "条件に該当する銘柄がありません" : "スキャンを実行してください"}
                    </td>
                  </tr>
                )}
                {sorted.map((d) => {
                  const roeColor = d.roe !== null ? (d.roe >= 10 ? "var(--color-up)" : d.roe >= 5 ? "var(--color-text)" : "var(--color-down)") : "var(--color-text-secondary)";
                  const perColor = d.trailingPE !== null ? (d.trailingPE <= 15 ? "var(--color-accent)" : "var(--color-text)") : "var(--color-text-secondary)";
                  const divColor = d.dividendYield !== null ? (d.dividendYield >= 3 ? "var(--color-up)" : "var(--color-text)") : "var(--color-text-secondary)";
                  const growthColor = d.earningsGrowth !== null ? (d.earningsGrowth > 0 ? "var(--color-up)" : "var(--color-down)") : "var(--color-text-secondary)";

                  return (
                    <tr
                      key={d.ticker}
                      data-ticker={d.ticker}
                      className="cursor-pointer transition-colors hover:bg-[rgba(0,240,255,0.04)]"
                      style={{ borderBottom: "1px solid var(--color-border)" }}
                      onClick={() => router.push(`/stock/${d.ticker}`)}
                    >
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] px-1 py-0.5" style={{ background: d.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)", color: d.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)" }}>{d.market}</span>
                          <div className="min-w-0">
                            <div className="text-sm text-[var(--color-text)] font-medium leading-tight max-w-[200px] truncate" title={d.name}>
                              {d.name && d.name !== d.ticker ? d.name : "（社名未取得）"}
                            </div>
                            <div className="text-[10px] text-[var(--color-accent)] tracking-wide">{d.ticker}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right text-xs" style={{ color: perColor }}>{fmtNum(d.trailingPE, 1, "x")}</td>
                      <td className="px-3 py-2.5 text-right text-xs">{fmtNum(d.pbr, 2, "x")}</td>
                      <td className="px-3 py-2.5 text-right text-xs font-bold" style={{ color: roeColor }}>{fmtNum(d.roe, 1, "%")}</td>
                      <td className="px-3 py-2.5 text-right text-xs">{fmtNum(d.operatingMargin, 1, "%")}</td>
                      <td className="px-3 py-2.5 text-right text-xs" style={{ color: growthColor }}>{d.earningsGrowth !== null ? `${d.earningsGrowth >= 0 ? "+" : ""}${d.earningsGrowth.toFixed(1)}%` : "—"}</td>
                      <td className="px-3 py-2.5 text-right text-xs" style={{ color: divColor }}>{fmtNum(d.dividendYield, 2, "%")}</td>
                      <td className="px-3 py-2.5 text-right text-xs text-[var(--color-text-secondary)]">{fmtBig(d.marketCap)}</td>
                      <td className="px-3 py-2.5 text-right text-xs text-[var(--color-text-secondary)]">{fmtNum(d.pegRatio, 2)}</td>
                      <td className="px-3 py-2.5 text-right text-xs text-[var(--color-text-secondary)]">{fmtNum(d.debtToEquity, 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 注意書き */}
      <div className="text-[10px] text-[var(--color-text-secondary)] opacity-60 leading-relaxed" style={MONO}>
        ※ フィルタをパスした銘柄は「候補」であり、買い推奨ではありません。<br />
        ※ 業種で適正水準が異なるため、同業比較が基本です。<br />
        ※ 一時的な特益・特損で数字が歪んでいないか、IRや有報で確認してください。
      </div>
        </div>
      )}
    </div>
  );
}

// ========================================
// Sub-components
// ========================================

function FilterSection({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <div className="pt-3">
      <div className="text-[10px] font-bold mb-2" style={{ ...{ fontFamily: "'JetBrains Mono', monospace" }, color }}>{title}</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {children}
      </div>
    </div>
  );
}

function FilterInput({ label, value, onChange, placeholder, suffix, step }: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  suffix?: string;
  step?: number;
}) {
  return (
    <div>
      <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
        {label} {suffix && <span className="opacity-60">{suffix}</span>}
      </label>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        placeholder={placeholder}
        step={step ?? 1}
        className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[36px]"
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      />
    </div>
  );
}

function SortHeader({ label, sortKey, current, asc, onClick, align }: {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  asc: boolean;
  onClick: (key: SortKey) => void;
  align?: "right" | "left";
}) {
  const isActive = current === sortKey;
  return (
    <th
      className={`px-3 py-2 cursor-pointer select-none hover:text-[var(--color-accent)] transition-colors ${align === "right" ? "text-right" : "text-left"}`}
      onClick={() => onClick(sortKey)}
      style={{ color: isActive ? "var(--color-accent)" : undefined }}
    >
      {label} {isActive && (asc ? "↑" : "↓")}
    </th>
  );
}
