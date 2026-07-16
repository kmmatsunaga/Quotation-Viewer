"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  getHoldings,
  getAlerts,
  addAlert,
  deleteAlert as deleteAlertFS,
  toggleAlert,
  getPatternAlertSettings,
  savePatternAlertSettings,
  type PatternAlertSettings,
  type Holding,
  type PriceAlert,
} from "@/lib/firestore";
import { NIKKEI225 } from "@/lib/nikkei225";

/* ── Style helpers ── */
const mono = { fontFamily: "'JetBrains Mono', monospace" } as const;
const clip = (px = 6) =>
  `polygon(${px}px 0, 100% 0, 100% calc(100% - ${px}px), calc(100% - ${px}px) 100%, 0 100%, 0 ${px}px)`;

type TabId = "price" | "pattern" | "screener" | "settings";

/* ── Screener types ── */
interface ScreenerResult {
  ticker: string;
  name: string;
  currentPattern: string;
  signal: string;
  direction: string;
  confidence: number;
  transitions: { toLabel: string; proximity: number; signal: string }[];
  maxProximity: number;
}

type ScreenerSource = "nikkei225" | "portfolio" | "favorites";
type ScreenerFilter = "all" | "buy" | "sell" | "watch" | "high-proximity";
type ScreenerSort = "proximity-desc" | "ticker-asc" | "name-asc" | "signal";

export default function AlertsPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<TabId>("price");

  // ── LINE settings (shared) ──
  const [settings, setSettings] = useState<PatternAlertSettings>({
    channelAccessToken: "",
    lineUserId: "",
    enabled: false,
    threshold: 40,
  });
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSaving] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [userIdInput, setUserIdInput] = useState("");

  // ── Price alerts ──
  const [priceAlerts, setPriceAlerts] = useState<PriceAlert[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [formTicker, setFormTicker] = useState("");
  const [formName, setFormName] = useState("");
  const [formPrice, setFormPrice] = useState("");
  const [formCondition, setFormCondition] = useState<"above" | "below">("above");
  const [formAlertType, setFormAlertType] = useState<"price" | "earnings_days_before">("price");
  const [formDaysBefore, setFormDaysBefore] = useState("3");
  const [submitting, setSubmitting] = useState(false);
  const [priceChecking, setPriceChecking] = useState(false);
  const [priceCheckResult, setPriceCheckResult] = useState<{
    triggered: { id: string; ticker: string; name: string; currentPrice: number; targetPrice: number; condition: string }[];
    lineNotified: boolean;
  } | null>(null);
  const [livePrices, setLivePrices] = useState<Record<string, { price: number; changePct: number }>>({});

  // ── Pattern alerts ──
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [patternChecking, setPatternChecking] = useState(false);
  const [patternResult, setPatternResult] = useState<{
    checked: number;
    alertsFound: number;
    alerts: { ticker: string; name: string; currentPattern: string; nextPattern: string; signal: string; proximity: number; triggers: string[] }[];
    results: Record<string, { name: string; currentPattern: string; transitions: { to: string; proximity: number; signal: string }[]; alertTriggered: boolean }>;
    lineNotified: boolean;
  } | null>(null);
  const [lastPatternCheck, setLastPatternCheck] = useState<string | null>(null);

  // ── Screener ──
  const [screenerSource, setScreenerSource] = useState<ScreenerSource>("nikkei225");
  const [screenerScanning, setScreenerScanning] = useState(false);
  const [screenerProgress, setScreenerProgress] = useState({ done: 0, total: 0, failed: 0 });
  const [screenerResults, setScreenerResults] = useState<ScreenerResult[]>([]);
  const [screenerFilter, setScreenerFilter] = useState<ScreenerFilter>("all");
  const [screenerSort, setScreenerSort] = useState<ScreenerSort>("proximity-desc");
  const [screenerLastScan, setScreenerLastScan] = useState<string | null>(null);
  const screenerAbortRef = useRef(false);

  // ── Load data ──
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const [s, a, h] = await Promise.all([
          getPatternAlertSettings(user.uid),
          getAlerts(user.uid),
          getHoldings(user.uid),
        ]);
        setSettings(s);
        setTokenInput(s.channelAccessToken);
        setUserIdInput(s.lineUserId);
        setPriceAlerts(a);
        setHoldings(h);
      } catch (err) {
        console.error("Load error:", err);
      } finally {
        setSettingsLoading(false);
      }
    })();
  }, [user]);

  // Fetch live prices for price alerts
  useEffect(() => {
    if (priceAlerts.length === 0) return;
    const tickers = [...new Set(priceAlerts.map((a) => a.ticker))];
    fetch(`/api/stocks/prices?tickers=${tickers.join(",")}`)
      .then((r) => r.json())
      .then((d) => setLivePrices(d.prices ?? {}))
      .catch(() => {});
  }, [priceAlerts]);

  // ── Settings handlers ──
  const handleSaveSettings = useCallback(
    async (s: PatternAlertSettings) => {
      if (!user) return;
      setSaving(true);
      try { await savePatternAlertSettings(user.uid, s); setSettings(s); } catch {}
      setSaving(false);
    },
    [user]
  );

  // ── Price alert handlers ──
  const handleAddAlert = useCallback(async () => {
    if (!user || !formTicker.trim()) return;
    if (formAlertType === "price" && !formPrice) return;
    setSubmitting(true);
    try {
      const ticker = formTicker.trim().toUpperCase();
      const name = formName.trim() || ticker;

      let addPayload: Parameters<typeof addAlert>[1];
      let localEntry: PriceAlert;

      if (formAlertType === "earnings_days_before") {
        const daysBefore = Math.max(1, Math.min(30, Number(formDaysBefore) || 3));
        addPayload = {
          ticker, name,
          type: "earnings_days_before",
          params: { daysBefore },
        } as Parameters<typeof addAlert>[1];
        localEntry = { ticker, name, type: "earnings_days_before", params: { daysBefore }, active: true, triggered: false };
      } else {
        addPayload = {
          ticker, name,
          condition: formCondition,
          targetPrice: Number(formPrice),
        };
        localEntry = { ticker, name, condition: formCondition, targetPrice: Number(formPrice), active: true, triggered: false };
      }

      const ref = await addAlert(user.uid, addPayload);
      setPriceAlerts((prev) => [{ ...localEntry, id: ref.id }, ...prev]);
      setFormTicker(""); setFormName(""); setFormPrice(""); setFormDaysBefore("3"); setShowAddForm(false);
    } catch (err) { console.error(err); }
    setSubmitting(false);
  }, [user, formTicker, formName, formPrice, formCondition, formAlertType, formDaysBefore]);

  const handleDeleteAlert = useCallback(async (id: string) => {
    if (!user) return;
    try {
      await deleteAlertFS(user.uid, id);
      setPriceAlerts((prev) => prev.filter((a) => a.id !== id));
    } catch {}
  }, [user]);

  const handleToggleAlert = useCallback(async (id: string, active: boolean) => {
    if (!user) return;
    try {
      await toggleAlert(user.uid, id, active);
      setPriceAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, active } : a)));
    } catch {}
  }, [user]);

  const handlePriceCheck = useCallback(async () => {
    const active = priceAlerts.filter((a) => a.active && !a.triggered);
    if (active.length === 0) return;
    setPriceChecking(true);
    try {
      const res = await fetch("/api/alerts/price-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alerts: active.map((a) => ({ id: a.id, ticker: a.ticker, name: a.name, condition: a.condition, targetPrice: a.targetPrice })),
          channelAccessToken: settings.enabled ? settings.channelAccessToken : null,
          lineUserId: settings.enabled ? settings.lineUserId : null,
        }),
      });
      const data = await res.json();
      setPriceCheckResult(data);
      if (data.prices) setLivePrices(data.prices);
      if (data.triggered?.length > 0) {
        const trigIds = new Set(data.triggered.map((t: { id: string }) => t.id));
        setPriceAlerts((prev) => prev.map((a) => trigIds.has(a.id) ? { ...a, triggered: true } : a));
      }
    } catch {}
    setPriceChecking(false);
  }, [priceAlerts, settings]);

  // ── Pattern alert handlers ──
  const handlePatternCheck = useCallback(async () => {
    if (holdings.length === 0) return;
    setPatternChecking(true);
    setPatternResult(null);
    try {
      const res = await fetch("/api/alerts/pattern-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tickers: holdings.map((h) => ({ ticker: h.ticker, name: h.name })),
          channelAccessToken: settings.enabled ? settings.channelAccessToken : null,
          lineUserId: settings.enabled ? settings.lineUserId : null,
          threshold: settings.threshold,
        }),
      });
      const data = await res.json();
      setPatternResult(data);
      setLastPatternCheck(new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }));
    } catch {}
    setPatternChecking(false);
  }, [holdings, settings]);

  // ── Screener handler ──
  const handleScreenerScan = useCallback(async () => {
    // Determine target tickers
    let targets: { ticker: string; name: string }[] = [];
    if (screenerSource === "nikkei225") {
      targets = NIKKEI225;
    } else if (screenerSource === "portfolio") {
      targets = holdings.map((h) => ({ ticker: h.ticker, name: h.name }));
    }

    if (targets.length === 0) return;

    screenerAbortRef.current = false;
    setScreenerScanning(true);
    setScreenerResults([]);
    setScreenerProgress({ done: 0, total: targets.length, failed: 0 });

    const BATCH_SIZE = 10;
    const allResults: ScreenerResult[] = [];
    let failCount = 0;

    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      if (screenerAbortRef.current) break;

      const batch = targets.slice(i, i + BATCH_SIZE);
      const tickerStr = batch.map((t) => t.ticker).join(",");

      try {
        const res = await fetch(`/api/stocks/patterns?tickers=${tickerStr}`);
        if (res.ok) {
          const data = await res.json();
          const patterns = data.patterns ?? {};

          for (const item of batch) {
            const p = patterns[item.ticker];
            if (!p?.patterns?.daily?.length) {
              failCount++;
              continue;
            }

            const topDaily = p.patterns.daily[0];
            const transitions = (p.transitions ?? []).map((t: { toLabel: string; proximity: number; signal: string }) => ({
              toLabel: t.toLabel,
              proximity: t.proximity,
              signal: t.signal,
            }));

            const maxProximity = transitions.length > 0
              ? Math.max(...transitions.map((t: { proximity: number }) => t.proximity))
              : 0;

            allResults.push({
              ticker: item.ticker,
              name: p.name ?? item.name,
              currentPattern: topDaily.label,
              signal: topDaily.signal,
              direction: topDaily.direction,
              confidence: topDaily.confidence,
              transitions,
              maxProximity,
            });
          }
        } else {
          failCount += batch.length;
        }
      } catch {
        failCount += batch.length;
      }

      const done = Math.min(i + BATCH_SIZE, targets.length);
      setScreenerProgress({ done, total: targets.length, failed: failCount });
      // Update results incrementally
      setScreenerResults([...allResults]);

      // Rate limiting: wait between batches
      if (i + BATCH_SIZE < targets.length && !screenerAbortRef.current) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    setScreenerScanning(false);
    setScreenerLastScan(new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }));
  }, [screenerSource, holdings]);

  const handleScreenerStop = useCallback(() => {
    screenerAbortRef.current = true;
  }, []);

  // Test LINE
  const handleTestLine = useCallback(async () => {
    if (!settings.channelAccessToken || !settings.lineUserId) return;
    try {
      const res = await fetch("/api/line/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelAccessToken: settings.channelAccessToken,
          userId: settings.lineUserId,
          message: "🧪 テスト通知\nCavka パターンアラートの接続テストです。\n正常に受信できました！",
        }),
      });
      const data = await res.json();
      alert(data.ok ? "LINE通知テスト成功！" : `失敗: ${data.message}`);
    } catch { alert("テスト失敗"); }
  }, [settings]);

  const isLineConfigured = Boolean(settings.channelAccessToken && settings.lineUserId);

  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: "price", label: "価格アラート", icon: "💰" },
    { id: "pattern", label: "パターン監視", icon: "📊" },
    { id: "screener", label: "スクリーナー", icon: "📡" },
    { id: "settings", label: "LINE設定", icon: "⚙️" },
  ];

  const signalColor = (s: string) => s === "buy" ? "var(--color-danger)" : s === "sell" ? "var(--color-accent)" : s === "watch" ? "#ff9500" : "var(--color-text-secondary)";
  const signalLabel = (s: string) => s === "buy" ? "買" : s === "sell" ? "売" : s === "watch" ? "注目" : "中立";
  const directionIcon = (d: string) => d === "up" ? "📈" : d === "down" ? "📉" : d === "sideways" ? "➡️" : "🔄";

  // ── Screener filtering & sorting ──
  const filteredResults = screenerResults
    .filter((r) => {
      if (screenerFilter === "all") return true;
      if (screenerFilter === "high-proximity") return r.maxProximity >= settings.threshold;
      return r.signal === screenerFilter;
    })
    .sort((a, b) => {
      switch (screenerSort) {
        case "proximity-desc": return b.maxProximity - a.maxProximity;
        case "ticker-asc": return a.ticker.localeCompare(b.ticker);
        case "name-asc": return a.name.localeCompare(b.name);
        case "signal": {
          const order: Record<string, number> = { buy: 0, sell: 1, watch: 2, neutral: 3 };
          return (order[a.signal] ?? 4) - (order[b.signal] ?? 4);
        }
        default: return 0;
      }
    });

  return (
    <div className="space-y-6">
      {/* Header */}
      <h1 className="text-[26px] font-bold tracking-tight text-[var(--color-text)]">🔔 アラート</h1>

      {/* Tabs */}
      <div className="flex gap-1 flex-wrap">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className="px-3 py-2 text-sm min-h-[40px] transition-all"
            style={{
              ...mono,
              clipPath: clip(),
              border: activeTab === t.id ? "1px solid var(--color-accent)" : "1px solid var(--color-border)",
              background: activeTab === t.id ? "rgba(0,240,255,0.08)" : "transparent",
              color: activeTab === t.id ? "var(--color-accent)" : "var(--color-text-secondary)",
              boxShadow: activeTab === t.id ? "0 0 15px rgba(0,240,255,0.2)" : "none",
            }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* ============================================================ */}
      {/* TAB: Price Alerts */}
      {/* ============================================================ */}
      {activeTab === "price" && (
        <div className="space-y-4">
          {/* Controls */}
          <div className="flex items-center gap-3 justify-end flex-wrap">
            <button
              onClick={handlePriceCheck}
              disabled={priceChecking || priceAlerts.filter((a) => a.active).length === 0}
              className="px-4 py-2 text-sm min-h-[44px] uppercase tracking-wider disabled:opacity-50"
              style={{ ...mono, clipPath: clip(), border: "1px solid var(--color-accent-2)", color: "var(--color-accent-2)", background: priceChecking ? "rgba(255,43,214,0.1)" : "transparent", boxShadow: "0 0 18px rgba(255,43,214,0.35)" }}
            >
              {priceChecking ? "チェック中..." : "価格チェック"}
            </button>
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className="px-4 py-2 text-sm min-h-[44px] uppercase tracking-wider"
              style={{ ...mono, clipPath: clip(), border: "1px solid var(--color-accent)", color: "var(--color-accent)", background: "transparent", boxShadow: "0 0 18px rgba(0,240,255,0.35)" }}
            >
              {showAddForm ? "キャンセル" : "+ アラート追加"}
            </button>
          </div>

          {/* Check result banner */}
          {priceCheckResult && (
            <div className="flex items-center gap-3 text-sm" style={mono}>
              <span style={{ color: priceCheckResult.triggered.length > 0 ? "var(--color-danger)" : "var(--color-text-secondary)" }}>
                発動: {priceCheckResult.triggered.length}件
              </span>
              {priceCheckResult.lineNotified && (
                <span className="text-[10px] px-2 py-0.5" style={{ ...mono, border: "1px solid var(--color-success)", color: "var(--color-success)", clipPath: clip(4) }}>
                  LINE送信済
                </span>
              )}
            </div>
          )}

          {/* Add form */}
          {showAddForm && (
            <div className="relative bg-card p-4 border border-[var(--color-accent)]" style={{ clipPath: clip(10), boxShadow: "0 0 20px rgba(0,240,255,0.15)" }}>
              {/* アラート種別 */}
              <div className="mb-3">
                <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-1" style={mono}>アラート種別</label>
                <div className="flex gap-1.5 flex-wrap">
                  {[
                    { id: "price", label: "💹 価格" },
                    { id: "earnings_days_before", label: "📅 決算 N日前" },
                  ].map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setFormAlertType(t.id as "price" | "earnings_days_before")}
                      className="px-3 py-1.5 text-xs"
                      style={{
                        border: `1px solid ${formAlertType === t.id ? "var(--color-accent)" : "var(--color-border)"}`,
                        color: formAlertType === t.id ? "var(--color-accent)" : "var(--color-text-secondary)",
                        background: formAlertType === t.id ? "rgba(0,240,255,0.1)" : "transparent",
                        ...mono,
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-1" style={mono}>銘柄コード</label>
                  <input type="text" value={formTicker} onChange={(e) => setFormTicker(e.target.value)} placeholder="7203" className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]" style={{ ...mono, clipPath: clip() }} />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-1" style={mono}>銘柄名（任意）</label>
                  <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="トヨタ自動車" className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]" style={{ ...mono, clipPath: clip() }} />
                </div>
                {formAlertType === "price" && (
                  <>
                    <div>
                      <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-1" style={mono}>目標価格</label>
                      <input type="number" value={formPrice} onChange={(e) => setFormPrice(e.target.value)} placeholder="3500" min="0" step="0.01" className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]" style={{ ...mono, clipPath: clip() }} />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-1" style={mono}>条件</label>
                      <select value={formCondition} onChange={(e) => setFormCondition(e.target.value as "above" | "below")} className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]" style={{ ...mono, clipPath: clip() }}>
                        <option value="above">以上になったら</option>
                        <option value="below">以下になったら</option>
                      </select>
                    </div>
                  </>
                )}
                {formAlertType === "earnings_days_before" && (
                  <div className="md:col-span-2">
                    <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-1" style={mono}>
                      決算何日前に通知?
                    </label>
                    <select value={formDaysBefore} onChange={(e) => setFormDaysBefore(e.target.value)} className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]" style={{ ...mono, clipPath: clip() }}>
                      <option value="1">1日前</option>
                      <option value="3">3日前</option>
                      <option value="7">7日前</option>
                      <option value="14">14日前</option>
                    </select>
                    <p className="text-[10px] text-[var(--color-text-secondary)] mt-1" style={mono}>
                      ※ 決算予定日を Yahoo Finance から取得。日々の cron で監視。
                    </p>
                  </div>
                )}
              </div>
              <button
                onClick={handleAddAlert}
                disabled={submitting || !formTicker.trim() || (formAlertType === "price" && !formPrice)}
                className="mt-3 px-6 py-2 text-sm min-h-[44px] uppercase tracking-wider disabled:opacity-50"
                style={{ ...mono, clipPath: clip(), border: "1px solid var(--color-accent)", color: "var(--color-accent)", background: "transparent" }}
              >
                {submitting ? "追加中..." : "追加する"}
              </button>
            </div>
          )}

          {/* Alert list */}
          {priceAlerts.length === 0 && !settingsLoading && (
            <div className="text-center py-12 text-[var(--color-text-secondary)]">
              <p className="text-sm">価格アラートがありません</p>
              <p className="text-xs mt-1">「+ アラート追加」からアラートを設定してください</p>
            </div>
          )}

          <div className="space-y-2">
            {priceAlerts.map((alert) => {
              const p = livePrices[alert.ticker];
              // 新式/旧式どちらでも targetPrice を取得
              const targetPrice = alert.targetPrice ?? alert.params?.targetPrice ?? 0;
              const cond = alert.condition ?? (alert.type === "price_above" ? "above" : alert.type === "price_below" ? "below" : "above");
              const dirLabel = cond === "above" ? "以上" : "以下";
              const dirIcon = cond === "above" ? "📈" : "📉";

              // 新型アラートの説明
              let alertDescription = `${dirIcon} 目標: ¥${targetPrice.toLocaleString()} ${dirLabel}`;
              if (alert.type === "earnings_days_before") {
                alertDescription = `📅 決算 ${alert.params?.daysBefore ?? 3}日前に通知`;
              } else if (alert.type === "earnings_post_move") {
                alertDescription = `📊 決算後の値動きが ±${alert.params?.movePct ?? 5}% 超えたら通知`;
              } else if (alert.type === "volume_anomaly") {
                alertDescription = `🔥 出来高が普段の ${alert.params?.movePct ?? 3}倍 超えたら通知`;
              } else if (alert.type === "margin_squeeze") {
                alertDescription = `⚡ 信用倍率 < 1 (踏み上げ候補) になったら通知`;
              }

              return (
                <div
                  key={alert.id}
                  className="relative bg-card p-4 border transition-all"
                  style={{
                    clipPath: clip(10),
                    borderColor: alert.triggered ? "var(--color-danger)" : alert.active ? "var(--color-border)" : "var(--color-border)",
                    opacity: alert.active ? 1 : 0.5,
                    boxShadow: alert.triggered ? "0 0 18px rgba(255,59,107,0.3), inset 0 0 0 1px rgba(255,59,107,0.15)" : "inset 0 0 0 1px rgba(0,240,255,0.04)",
                  }}
                >
                  <span className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-accent)] opacity-60" />
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-[var(--color-accent)] font-medium" style={mono}>{alert.ticker}</span>
                        <span className="text-sm">{alert.name}</span>
                        {alert.triggered && (
                          <span className="text-[10px] px-2 py-0.5 font-medium" style={{ ...mono, border: "1px solid var(--color-danger)", color: "var(--color-danger)", clipPath: clip(4), boxShadow: "0 0 12px rgba(255,59,107,0.3)" }}>
                            発動済
                          </span>
                        )}
                        {!alert.triggered && alert.active && (
                          <span className="text-[10px] px-2 py-0.5 font-medium" style={{ ...mono, border: "1px solid var(--color-success)", color: "var(--color-success)", clipPath: clip(4) }}>
                            監視中
                          </span>
                        )}
                        {!alert.active && !alert.triggered && (
                          <span className="text-[10px] px-2 py-0.5 text-[var(--color-text-secondary)]" style={{ ...mono, border: "1px solid var(--color-border)", clipPath: clip(4) }}>
                            停止中
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 flex items-center gap-4 text-sm" style={mono}>
                        <span className="text-[var(--color-text-secondary)]">
                          {alertDescription}
                        </span>
                        {p && (
                          <span style={{ color: p.changePct >= 0 ? "var(--color-up)" : "var(--color-down)" }}>
                            現在: ¥{p.price.toLocaleString()}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {!alert.triggered && (
                        <button
                          onClick={() => handleToggleAlert(alert.id!, !alert.active)}
                          className="text-[10px] px-2 py-1 min-h-[32px]"
                          style={{ ...mono, clipPath: clip(4), border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", background: "transparent" }}
                        >
                          {alert.active ? "停止" : "再開"}
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteAlert(alert.id!)}
                        className="text-[10px] px-2 py-1 min-h-[32px] hover:text-[var(--color-danger)]"
                        style={{ ...mono, clipPath: clip(4), border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", background: "transparent" }}
                      >
                        削除
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* TAB: Pattern Monitor */}
      {/* ============================================================ */}
      {activeTab === "pattern" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              {lastPatternCheck && (
                <span className="text-[10px] text-[var(--color-text-secondary)]" style={mono}>最終: {lastPatternCheck}</span>
              )}
            </div>
            <button
              onClick={handlePatternCheck}
              disabled={patternChecking || holdings.length === 0}
              className="px-5 py-2.5 text-sm font-medium min-h-[44px] disabled:opacity-50 uppercase tracking-wider"
              style={{ ...mono, clipPath: clip(), border: "1px solid var(--color-accent-2)", color: "var(--color-accent-2)", background: patternChecking ? "rgba(255,43,214,0.1)" : "transparent", boxShadow: "0 0 18px rgba(255,43,214,0.35)" }}
            >
              {patternChecking ? "スキャン中..." : "パターンチェック実行"}
            </button>
          </div>

          {holdings.length === 0 && !settingsLoading && (
            <div className="text-sm text-[var(--color-text-secondary)] py-6 text-center">
              ポートフォリオに銘柄を追加するとパターン遷移を監視できます
            </div>
          )}

          {holdings.length > 0 && !patternResult && !patternChecking && (
            <div className="text-sm text-[var(--color-text-secondary)] py-4">
              ポートフォリオの {holdings.length} 銘柄のパターン遷移を監視（閾値: {settings.threshold}%）
            </div>
          )}

          {patternResult && (
            <div className="space-y-4">
              <div className="flex items-center gap-4 text-sm" style={mono}>
                <span className="text-[var(--color-text-secondary)]">チェック: {patternResult.checked}銘柄</span>
                <span style={{ color: patternResult.alertsFound > 0 ? "var(--color-accent-2)" : "var(--color-text-secondary)" }}>アラート: {patternResult.alertsFound}件</span>
                {patternResult.lineNotified && (
                  <span className="text-[10px] px-2 py-0.5" style={{ ...mono, border: "1px solid var(--color-success)", color: "var(--color-success)", clipPath: clip(4) }}>LINE送信済</span>
                )}
              </div>

              {patternResult.alerts.length > 0 && (
                <div className="space-y-2">
                  {patternResult.alerts.map((a, i) => (
                    <div key={i} className="relative bg-[rgba(255,43,214,0.05)] p-4 border border-[rgba(255,43,214,0.3)]" style={{ clipPath: clip(8), boxShadow: "0 0 15px rgba(255,43,214,0.15)" }}>
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm font-bold text-[var(--color-accent)]" style={mono}>{a.ticker}</span>
                            <span className="text-sm">{a.name}</span>
                            <span className="text-[10px] px-1.5 py-0.5 font-bold" style={{ ...mono, border: `1px solid ${signalColor(a.signal)}`, color: signalColor(a.signal), clipPath: clip(3) }}>{signalLabel(a.signal)}</span>
                          </div>
                          <div className="text-sm text-[var(--color-text-secondary)]" style={mono}>{a.currentPattern} → {a.nextPattern}</div>
                          <div className="mt-1 text-[10px] text-[var(--color-text-secondary)] space-y-0.5">
                            {a.triggers.map((t, j) => <div key={j}>▸ {t}</div>)}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-2xl font-bold" style={{ fontFamily: "'Orbitron', sans-serif", color: a.proximity >= 60 ? "var(--color-danger)" : a.proximity >= 40 ? "#ff9500" : "var(--color-accent)" }}>{a.proximity}%</div>
                          <div className="text-[9px] uppercase text-[var(--color-text-secondary)]" style={mono}>proximity</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* All results grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-4">
                {Object.entries(patternResult.results).map(([ticker, r]) => (
                  <div key={ticker} className="bg-card p-3 border flex items-center justify-between" style={{ clipPath: clip(), borderColor: r.alertTriggered ? "rgba(255,43,214,0.4)" : "var(--color-border)" }}>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-[var(--color-accent)]" style={mono}>{ticker}</span>
                        <span className="text-xs">{r.name}</span>
                      </div>
                      <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5" style={mono}>{r.currentPattern}</div>
                    </div>
                    <div className="flex items-center gap-1 flex-wrap justify-end">
                      {r.transitions.slice(0, 2).map((t, i) => (
                        <span key={i} className="text-[9px] px-1.5 py-0.5" style={{ ...mono, border: `1px solid ${t.proximity >= settings.threshold ? "rgba(255,43,214,0.5)" : "var(--color-border)"}`, color: t.proximity >= settings.threshold ? "var(--color-accent-2)" : "var(--color-text-secondary)", clipPath: clip(3) }}>
                          →{t.to.replace(/^.*[→]/, "")} {t.proximity}%
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* TAB: Screener */}
      {/* ============================================================ */}
      {activeTab === "screener" && (
        <div className="space-y-4">
          {/* Screener Controls */}
          <div className="relative bg-card p-4 border border-[var(--color-border)]" style={{ clipPath: clip(10), boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)" }}>
            <span className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-accent)] opacity-60" />
            <div className="flex items-center gap-4 flex-wrap">
              {/* Source selector */}
              <div className="flex items-center gap-2">
                <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={mono}>対象</label>
                <select
                  value={screenerSource}
                  onChange={(e) => setScreenerSource(e.target.value as ScreenerSource)}
                  disabled={screenerScanning}
                  className="bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[36px]"
                  style={{ ...mono, clipPath: clip(4) }}
                >
                  <option value="nikkei225">日経225 ({NIKKEI225.length}銘柄)</option>
                  <option value="portfolio">ポートフォリオ ({holdings.length}銘柄)</option>
                </select>
              </div>

              {/* Scan button */}
              {!screenerScanning ? (
                <button
                  onClick={handleScreenerScan}
                  className="px-5 py-2 text-sm font-medium min-h-[40px] uppercase tracking-wider"
                  style={{
                    ...mono,
                    clipPath: clip(),
                    border: "1px solid var(--color-accent)",
                    color: "#000",
                    background: "linear-gradient(135deg, #00f0ff, #00d4e0)",
                    boxShadow: "0 0 20px rgba(0,240,255,0.4), 0 0 40px rgba(0,240,255,0.15)",
                  }}
                >
                  スキャン開始
                </button>
              ) : (
                <button
                  onClick={handleScreenerStop}
                  className="px-5 py-2 text-sm font-medium min-h-[40px] uppercase tracking-wider"
                  style={{
                    ...mono,
                    clipPath: clip(),
                    border: "1px solid var(--color-danger)",
                    color: "var(--color-danger)",
                    background: "rgba(255,59,107,0.1)",
                    boxShadow: "0 0 18px rgba(255,59,107,0.3)",
                  }}
                >
                  中断
                </button>
              )}

              {screenerLastScan && !screenerScanning && (
                <span className="text-[10px] text-[var(--color-text-secondary)]" style={mono}>
                  最終: {screenerLastScan}
                </span>
              )}
            </div>

            {/* Progress bar */}
            {screenerScanning && (
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between text-[10px]" style={mono}>
                  <span className="text-[var(--color-text-secondary)]">
                    スキャン中... {screenerProgress.done}/{screenerProgress.total}
                    {screenerProgress.failed > 0 && <span className="text-[var(--color-danger)] ml-2">({screenerProgress.failed}失敗)</span>}
                  </span>
                  <span className="text-[var(--color-accent)]">
                    {screenerProgress.total > 0 ? Math.round((screenerProgress.done / screenerProgress.total) * 100) : 0}%
                  </span>
                </div>
                <div className="w-full h-2 bg-[var(--color-border)] overflow-hidden" style={{ clipPath: clip(2) }}>
                  <div
                    className="h-full transition-all duration-500"
                    style={{
                      width: `${screenerProgress.total > 0 ? (screenerProgress.done / screenerProgress.total) * 100 : 0}%`,
                      background: "linear-gradient(90deg, #00f0ff, #ff2bd6)",
                      boxShadow: "0 0 10px rgba(0,240,255,0.5)",
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Filters & Sort (show when results exist) */}
          {screenerResults.length > 0 && (
            <div className="flex items-center gap-3 flex-wrap">
              {/* Signal filters */}
              <div className="flex gap-1">
                {([
                  { id: "all", label: "全て", color: "var(--color-text-secondary)" },
                  { id: "high-proximity", label: "転換接近", color: "var(--color-accent-2)" },
                  { id: "buy", label: "買", color: "var(--color-danger)" },
                  { id: "sell", label: "売", color: "var(--color-accent)" },
                  { id: "watch", label: "注目", color: "#ff9500" },
                ] as { id: ScreenerFilter; label: string; color: string }[]).map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setScreenerFilter(f.id)}
                    className="text-[10px] px-2.5 py-1 min-h-[28px] transition-all"
                    style={{
                      ...mono,
                      clipPath: clip(3),
                      border: `1px solid ${screenerFilter === f.id ? f.color : "var(--color-border)"}`,
                      color: screenerFilter === f.id ? f.color : "var(--color-text-secondary)",
                      background: screenerFilter === f.id ? `${f.color}15` : "transparent",
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              {/* Sort */}
              <select
                value={screenerSort}
                onChange={(e) => setScreenerSort(e.target.value as ScreenerSort)}
                className="bg-[var(--bg-input)] border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[28px]"
                style={{ ...mono, clipPath: clip(3) }}
              >
                <option value="proximity-desc">転換proximity順</option>
                <option value="signal">シグナル順</option>
                <option value="ticker-asc">コード順</option>
                <option value="name-asc">名前順</option>
              </select>

              {/* Count */}
              <span className="text-[10px] text-[var(--color-text-secondary)]" style={mono}>
                {filteredResults.length}/{screenerResults.length}件
              </span>
            </div>
          )}

          {/* Results */}
          {screenerResults.length === 0 && !screenerScanning && (
            <div className="text-center py-16 text-[var(--color-text-secondary)]">
              <div className="text-4xl mb-4">📡</div>
              <p className="text-sm">パターンスクリーナー</p>
              <p className="text-xs mt-1">日経225全銘柄のチャートパターンを一括スキャン</p>
              <p className="text-xs mt-1">転換が近い銘柄を自動検出します</p>
            </div>
          )}

          {filteredResults.length > 0 && (
            <div className="space-y-1.5">
              {filteredResults.map((r) => {
                const topTransition = r.transitions[0];
                return (
                  <div
                    key={r.ticker}
                    className="relative bg-card p-3 border transition-all cursor-pointer hover:border-[var(--color-accent)]"
                    style={{
                      clipPath: clip(8),
                      borderColor: r.maxProximity >= 60 ? "rgba(255,43,214,0.4)" : r.maxProximity >= settings.threshold ? "rgba(255,43,214,0.2)" : "var(--color-border)",
                      boxShadow: r.maxProximity >= 60 ? "0 0 12px rgba(255,43,214,0.15)" : "inset 0 0 0 1px rgba(0,240,255,0.03)",
                    }}
                    onClick={() => window.open(`/stock/${r.ticker}`, "_blank")}
                  >
                    <div className="flex items-center justify-between gap-3">
                      {/* Left: Stock info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-bold text-[var(--color-accent)]" style={mono}>{r.ticker}</span>
                          <span className="text-sm truncate">{r.name}</span>
                          <span className="text-[9px] px-1.5 py-0.5 font-bold" style={{
                            ...mono,
                            border: `1px solid ${signalColor(r.signal)}`,
                            color: signalColor(r.signal),
                            clipPath: clip(3),
                          }}>
                            {signalLabel(r.signal)}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-[10px] text-[var(--color-text-secondary)]" style={mono}>
                            {directionIcon(r.direction)} {r.currentPattern}
                          </span>
                          {topTransition && (
                            <span className="text-[10px]" style={{
                              ...mono,
                              color: topTransition.proximity >= settings.threshold ? "var(--color-accent-2)" : "var(--color-text-secondary)",
                            }}>
                              → {topTransition.toLabel}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Right: Proximity indicators */}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {r.transitions.slice(0, 2).map((t, i) => (
                          <div key={i} className="text-center">
                            <div
                              className="text-sm font-bold"
                              style={{
                                ...mono,
                                color: t.proximity >= 60 ? "var(--color-danger)" : t.proximity >= settings.threshold ? "var(--color-accent-2)" : "var(--color-text-secondary)",
                              }}
                            >
                              {t.proximity}%
                            </div>
                            <div className="text-[8px] text-[var(--color-text-secondary)] truncate max-w-[60px]" style={mono}>
                              {t.toLabel.length > 6 ? t.toLabel.slice(0, 6) + "…" : t.toLabel}
                            </div>
                          </div>
                        ))}

                        {/* Proximity (数字大表示) */}
                        <div
                          className="text-base font-black"
                          style={{
                            ...mono,
                            color: r.maxProximity >= 60 ? "var(--color-danger)" : r.maxProximity >= settings.threshold ? "var(--color-accent-2)" : "var(--color-accent)",
                          }}
                        >
                          {r.maxProximity}%
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Summary stats */}
          {screenerResults.length > 0 && !screenerScanning && (
            <div className="relative bg-card p-4 border border-[var(--color-border)]" style={{ clipPath: clip(10), boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)" }}>
              <h3 className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-accent)] mb-3" style={mono}>スキャン結果サマリー</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: "総銘柄", value: screenerResults.length, color: "var(--color-text)" },
                  { label: "転換接近", value: screenerResults.filter((r) => r.maxProximity >= settings.threshold).length, color: "var(--color-accent-2)" },
                  { label: "買シグナル", value: screenerResults.filter((r) => r.signal === "buy").length, color: "var(--color-danger)" },
                  { label: "売シグナル", value: screenerResults.filter((r) => r.signal === "sell").length, color: "var(--color-accent)" },
                ].map((s) => (
                  <div key={s.label} className="text-center">
                    <div className="text-2xl font-bold" style={{ fontFamily: "'Orbitron', sans-serif", color: s.color }}>{s.value}</div>
                    <div className="text-[9px] uppercase tracking-wider text-[var(--color-text-secondary)] mt-1" style={mono}>{s.label}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* TAB: LINE Settings */}
      {/* ============================================================ */}
      {activeTab === "settings" && (
        <div className="space-y-6">
          {/* LINE Connection */}
          <section className="relative bg-card p-5 border border-[var(--color-border)]" style={{ clipPath: clip(10), boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)" }}>
            <span className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-accent)] opacity-60" />
            <h2 className="text-[11px] uppercase tracking-[0.2em] text-[var(--color-accent)] mb-4" style={mono}>LINE Messaging API 接続</h2>

            {settingsLoading ? (
              <div className="text-sm text-[var(--color-text-secondary)]">読み込み中...</div>
            ) : !showSetup ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: isLineConfigured ? "var(--color-success)" : "var(--color-text-secondary)", boxShadow: isLineConfigured ? "0 0 8px rgba(0,255,136,0.5)" : "none" }} />
                  <span className="text-sm" style={{ ...mono, color: isLineConfigured ? "var(--color-success)" : "var(--color-text-secondary)" }}>
                    {isLineConfigured ? "LINE接続済み" : "LINE未接続"}
                  </span>
                  <button onClick={() => setShowSetup(true)} className="text-xs px-3 py-1.5 min-h-[36px]" style={{ ...mono, clipPath: clip(4), border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", background: "transparent" }}>
                    {isLineConfigured ? "再設定" : "セットアップ"}
                  </button>
                  {isLineConfigured && (
                    <button onClick={handleTestLine} className="text-xs px-3 py-1.5 min-h-[36px]" style={{ ...mono, clipPath: clip(4), border: "1px solid var(--color-accent-2)", color: "var(--color-accent-2)", background: "transparent" }}>
                      テスト送信
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-6 flex-wrap">
                  <label className="flex items-center gap-2 cursor-pointer min-h-[44px]">
                    <div className="relative w-12 h-6 rounded-full transition-colors" style={{ background: settings.enabled ? "linear-gradient(90deg, rgba(0,240,255,0.6), rgba(255,43,214,0.6))" : "var(--color-border)" }} onClick={() => handleSaveSettings({ ...settings, enabled: !settings.enabled })}>
                      <div className="absolute top-0.5 w-5 h-5 rounded-full transition-transform bg-white" style={{ transform: settings.enabled ? "translateX(26px)" : "translateX(2px)", boxShadow: settings.enabled ? "0 0 8px rgba(0,240,255,0.5)" : "none" }} />
                    </div>
                    <span className="text-sm" style={{ ...mono, color: settings.enabled ? "var(--color-accent)" : "var(--color-text-secondary)" }}>
                      {settings.enabled ? "通知ON" : "通知OFF"}
                    </span>
                  </label>

                  <div className="flex items-center gap-2">
                    <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={mono}>パターン閾値</label>
                    <select value={settings.threshold} onChange={(e) => handleSaveSettings({ ...settings, threshold: Number(e.target.value) })} className="bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[36px]" style={{ ...mono, clipPath: clip(4) }}>
                      {[20, 30, 40, 50, 60, 70, 80].map((v) => <option key={v} value={v}>{v}%</option>)}
                    </select>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3 p-4 border border-[var(--color-border)]" style={{ clipPath: clip(8), background: "rgba(0,240,255,0.02)" }}>
                <div className="text-[10px] text-[var(--color-text-secondary)] space-y-1 mb-3" style={mono}>
                  <p className="text-[var(--color-accent)]">セットアップ手順:</p>
                  <p>1. <a href="https://manager.line.biz/" target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] underline">LINE Official Account Manager</a> で公式アカウント作成</p>
                  <p>2. <a href="https://developers.line.biz/" target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] underline">LINE Developers</a> でMessaging APIチャネル作成</p>
                  <p>3. チャネルアクセストークン（長期）を発行</p>
                  <p>4. 基本設定の「あなたのユーザーID」をコピー</p>
                  <p>5. 作成した公式アカウントを友だち追加</p>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-1" style={mono}>Channel Access Token</label>
                  <input type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]" style={{ ...mono, clipPath: clip() }} placeholder="Channel Access Token を入力" />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-1" style={mono}>Your User ID</label>
                  <input type="text" value={userIdInput} onChange={(e) => setUserIdInput(e.target.value)} className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]" style={{ ...mono, clipPath: clip() }} placeholder="U1234abcd..." />
                </div>
                <div className="flex gap-2">
                  <button onClick={() => { handleSaveSettings({ ...settings, channelAccessToken: tokenInput, lineUserId: userIdInput }); setShowSetup(false); }} disabled={settingsSaving || !tokenInput || !userIdInput} className="px-5 py-2 text-sm min-h-[44px] uppercase disabled:opacity-50" style={{ ...mono, clipPath: clip(), border: "1px solid var(--color-accent)", color: "var(--color-accent)", background: "transparent" }}>
                    保存
                  </button>
                  <button onClick={() => { setShowSetup(false); setTokenInput(settings.channelAccessToken); setUserIdInput(settings.lineUserId); }} className="px-4 py-2 text-sm min-h-[44px]" style={{ ...mono, clipPath: clip(), border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", background: "transparent" }}>
                    キャンセル
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Cron info */}
          <section className="relative bg-card p-5 border border-[var(--color-border)]" style={{ clipPath: clip(10), boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.04)" }}>
            <h2 className="text-[11px] uppercase tracking-[0.2em] text-[var(--color-accent)] mb-3" style={mono}>自動監視</h2>
            <div className="text-sm text-[var(--color-text-secondary)] space-y-1">
              <p>Vercel Cron で毎日 JST <span className="text-[var(--color-accent)]" style={mono}>08:00</span> にパターンチェックを自動実行</p>
              <p className="text-[10px]" style={mono}>※ LINE設定完了 + 通知ONで有効</p>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full" style={{ background: settings.enabled && isLineConfigured ? "var(--color-success)" : "var(--color-text-secondary)", boxShadow: settings.enabled && isLineConfigured ? "0 0 8px rgba(0,255,136,0.5)" : "none" }} />
              <span className="text-[10px] uppercase tracking-wider" style={{ ...mono, color: settings.enabled && isLineConfigured ? "var(--color-success)" : "var(--color-text-secondary)" }}>
                {settings.enabled && isLineConfigured ? "自動監視 active" : "自動監視 inactive"}
              </span>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
