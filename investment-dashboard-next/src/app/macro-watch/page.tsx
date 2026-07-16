"use client";

/**
 * /macro-watch - マクロ予兆ダッシュボード
 *
 * 主要マクロテーマの「織り込み度・予兆」を一画面で見渡す:
 *   - 🇺🇸 FRB 政策方向 (利上げ/据置/利下げ確率, Cavka 独自モデル)
 *   - 📉 米景気後退確率 (逆イールド + Sahm Rule)
 *   - 💴 USD/JPY 為替動向
 */

import { useEffect, useState } from "react";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface FredObs { date: string; value: number | null }

interface FedPolicy {
  currentRate: number | null;
  recentChangeBps: number | null;
  cpiYoY: number | null;
  coreCpiYoY: number | null;
  unemploymentRate: number | null;
  unemploymentTrend: "improving" | "stable" | "worsening" | null;
  probRateCut: number;
  probRateHold: number;
  probRateHike: number;
  rationale: string[];
}

interface Recession {
  yieldCurveT10Y3M: number | null;
  yieldCurveT10Y2Y: number | null;
  isInverted: boolean;
  monthsSinceInversion: number | null;
  unemploymentRise: number | null;
  sahmRuleTriggered: boolean;
  probRecession12m: number;
  signals: string[];
}

interface Fx {
  usdJpy: number | null;
  changeFrom30d: number | null;
  near155: boolean;
  signals: string[];
}

interface Snapshot {
  fedFundsRate: FredObs | null;
  cpi: FredObs | null;
  coreCpi: FredObs | null;
  unemployment: FredObs | null;
  yieldCurveT10Y3M: FredObs | null;
  yieldCurveT10Y2Y: FredObs | null;
  dgs10: FredObs | null;
  dgs2: FredObs | null;
  usdJpy: FredObs | null;
  wti: FredObs | null;
  brent: FredObs | null;
  copper: FredObs | null;
  ironOre: FredObs | null;
  semiProduction: FredObs | null;
  semiPPI: FredObs | null;
  jpCallRate: FredObs | null;
  jpCpi: FredObs | null;
  jpUnemployment: FredObs | null;
  jpJgb10y: FredObs | null;
}

interface BojPolicy {
  currentRate: number | null;
  recentChangeBps: number | null;
  cpiYoY: number | null;
  unemploymentRate: number | null;
  jgb10y: number | null;
  jgb10yChange3m: number | null;
  usdJpy: number | null;
  probRateCut: number;
  probRateHold: number;
  probRateHike: number;
  rationale: string[];
}

interface SemiCycle {
  productionIndex: number | null;
  productionYoY: number | null;
  ppi: number | null;
  ppiYoY: number | null;
  smhPrice: number | null;
  smhChange3m: number | null;
  smhChange1y: number | null;
  cycleStage: "boom" | "expansion" | "peak" | "contraction" | "trough" | "neutral";
  cycleScore: number;
  signals: string[];
}

interface Oil {
  wti: number | null;
  brent: number | null;
  wtiChange30d: number | null;
  wtiChange90d: number | null;
  spread: number | null;
  direction: "up" | "down" | "sideways";
  highPrice: boolean;
  lowPrice: boolean;
  signals: string[];
}

interface China {
  copper: number | null;
  copperChange3m: number | null;
  ironOre: number | null;
  ironOreChange3m: number | null;
  demandScore: number;
  demandLabel: "expansion" | "neutral" | "contraction";
  signals: string[];
}

interface Response {
  ok: boolean;
  cached?: boolean;
  ageHours?: number;
  snapshot: Snapshot;
  fedPolicy: FedPolicy;
  recession: Recession;
  fx: Fx;
  oil: Oil;
  china: China;
  semi: SemiCycle;
  bojPolicy: BojPolicy;
  computedAtIso: string;
  elapsedMs: number;
  error?: string;
}

function color(score: number, reverse = false): string {
  const s = reverse ? 100 - score : score;
  if (s >= 70) return "#ef4444";
  if (s >= 50) return "#fb923c";
  if (s >= 30) return "#facc15";
  return "#7fffd4";
}

export default function MacroWatchPage() {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = (fresh = false) => {
    setLoading(true);
    setError(null);
    fetch(`/api/macro/fred-watch${fresh ? "?fresh=1" : ""}`)
      .then((r) => r.json())
      .then((j: Response) => {
        if (!j.ok) setError(j.error ?? "取得失敗");
        else setData(j);
        setLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchData();
  }, []);

  return (
    <div className="space-y-4">
      {/* ヘッダ */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">
            🌍 マクロ予兆ダッシュボード
          </h1>
          <p className="text-[14px] text-[var(--color-text-secondary)] mt-1.5 leading-relaxed">
            米FRB政策方向・景気後退確率・為替動向 (Source: FRED / St. Louis Fed)
          </p>
        </div>
        <div className="flex gap-2 items-center">
          {data && (
            <span className="text-xs text-[var(--color-text)]" style={MONO}>
              {data.cached ? `cached ${data.ageHours}h前` : "fresh"} · 取得 {data.elapsedMs}ms
            </span>
          )}
          <button
            onClick={() => fetchData(true)}
            className="px-3 py-1.5 text-xs"
            style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)", ...MONO }}
            disabled={loading}
          >
            {loading ? "..." : "🔄 最新取得"}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 border border-red-500/40 text-sm text-red-400" style={MONO}>
          ⚠ {error}
        </div>
      )}

      {loading && !data ? (
        <div className="text-center py-20 text-[var(--color-text)] text-sm" style={MONO}>
          読み込み中...
        </div>
      ) : data ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <FedPolicyCard fp={data.fedPolicy} snapshot={data.snapshot} />
          {data.bojPolicy && <BojPolicyCard bp={data.bojPolicy} snapshot={data.snapshot} />}
          <RecessionCard rc={data.recession} snapshot={data.snapshot} />
          <FxCard fx={data.fx} snapshot={data.snapshot} />
          <OilCard oil={data.oil} snapshot={data.snapshot} />
          <ChinaCard china={data.china} snapshot={data.snapshot} />
          {data.semi && <SemiCycleCard semi={data.semi} snapshot={data.snapshot} />}
        </div>
      ) : null}
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function FedPolicyCard({ fp, snapshot }: { fp: FedPolicy; snapshot: Snapshot }) {
  const cutColor = color(fp.probRateCut);
  const holdColor = "#7fffd4";
  const hikeColor = color(fp.probRateHike);
  const dominant = Math.max(fp.probRateCut, fp.probRateHold, fp.probRateHike);
  const dominantLabel = dominant === fp.probRateCut ? "🟢 利下げ寄り" : dominant === fp.probRateHike ? "🔴 利上げ寄り" : "🟡 据置";
  const dominantColor = dominant === fp.probRateCut ? cutColor : dominant === fp.probRateHike ? hikeColor : holdColor;

  return (
    <div
      className="p-5 border space-y-4"
      style={{ borderColor: dominantColor, background: `${dominantColor}10`, boxShadow: `0 0 16px ${dominantColor}25` }}
    >
      <div>
        <div className="text-sm font-bold text-[var(--color-text)]" style={MONO}>🇺🇸 FRB 政策方向</div>
        <div className="text-3xl font-black mt-1" style={{ color: dominantColor }}>{dominantLabel}</div>
        <div className="text-xs text-[var(--color-text)] mt-1" style={MONO}>
          現在 Fed Funds Rate <span className="font-black text-base text-[var(--color-text)]">{fp.currentRate?.toFixed(2) ?? "—"}%</span>
          {fp.recentChangeBps !== null && (
            <span style={{ marginLeft: 8, color: fp.recentChangeBps > 0 ? "#fb923c" : "#7fffd4" }}>
              直近3M {fp.recentChangeBps > 0 ? "+" : ""}{fp.recentChangeBps}bps
            </span>
          )}
        </div>
      </div>

      {/* 確率の3行表示 (バー無し、数字を主役) */}
      <div className="grid grid-cols-3 gap-2">
        <ProbBlock label="🟢 利下げ" pct={fp.probRateCut} color={cutColor} />
        <ProbBlock label="🟡 据置"  pct={fp.probRateHold} color={holdColor} />
        <ProbBlock label="🔴 利上げ" pct={fp.probRateHike} color={hikeColor} />
      </div>

      {/* 主要指標 */}
      <div className="grid grid-cols-2 gap-2 text-xs" style={MONO}>
        <MetricStat label="CPI YoY" value={fp.cpiYoY !== null ? `${fp.cpiYoY.toFixed(2)}%` : "—"} note={snapshot.cpi?.date} />
        <MetricStat label="Core CPI YoY" value={fp.coreCpiYoY !== null ? `${fp.coreCpiYoY.toFixed(2)}%` : "—"} note={snapshot.coreCpi?.date} />
        <MetricStat label="失業率" value={fp.unemploymentRate !== null ? `${fp.unemploymentRate.toFixed(1)}%` : "—"} note={fp.unemploymentTrend ?? undefined} />
        <MetricStat label="動向" value={dominantLabel} />
      </div>

      {/* 根拠 */}
      {fp.rationale.length > 0 && (
        <div className="pt-3 border-t border-[var(--color-border)]">
          <div className="text-xs font-bold text-[var(--color-text)] mb-2" style={MONO}>📊 判定根拠</div>
          <ul className="space-y-1 text-xs text-[var(--color-text)]" style={MONO}>
            {fp.rationale.map((r, i) => <li key={i}>▸ {r}</li>)}
          </ul>
        </div>
      )}

      {/* 投資への示唆 */}
      <div className="text-xs p-2 border-l-4 text-[var(--color-text)]" style={{ ...MONO, borderColor: dominantColor, background: `${dominantColor}10` }}>
        {dominant === fp.probRateCut ? "💡 利下げ寄り: ハイテク・グロース株追い風、銀行・保険は利ザヤ縮小注意" :
         dominant === fp.probRateHike ? "💡 利上げ寄り: 銀行株追い風、長期保有グロース注意、ドル高傾向で輸出株観察" :
         "💡 据置寄り: 大きな変化なし、銘柄選別の方が重要"}
      </div>
    </div>
  );
}

function BojPolicyCard({ bp, snapshot }: { bp: BojPolicy; snapshot: Snapshot }) {
  const cutColor = color(bp.probRateCut);
  const holdColor = "#7fffd4";
  const hikeColor = color(bp.probRateHike);
  const dominant = Math.max(bp.probRateCut, bp.probRateHold, bp.probRateHike);
  const dominantLabel = dominant === bp.probRateCut ? "🟢 緩和寄り" : dominant === bp.probRateHike ? "🔴 利上げ寄り" : "🟡 据置";
  const dominantColor = dominant === bp.probRateCut ? cutColor : dominant === bp.probRateHike ? hikeColor : holdColor;
  return (
    <div
      className="p-5 border space-y-4"
      style={{ borderColor: dominantColor, background: `${dominantColor}10`, boxShadow: `0 0 16px ${dominantColor}25` }}
    >
      <div>
        <div className="text-sm font-bold text-[var(--color-text)]" style={MONO}>🇯🇵 BOJ 政策方向</div>
        <div className="text-3xl font-black mt-1" style={{ color: dominantColor }}>{dominantLabel}</div>
        <div className="text-xs text-[var(--color-text)] mt-1" style={MONO}>
          短期金利 (3M Interbank) <span className="font-black text-base text-[var(--color-text)]">{bp.currentRate !== null ? `${bp.currentRate.toFixed(2)}%` : "—"}</span>
          {bp.recentChangeBps !== null && bp.recentChangeBps !== 0 && (
            <span style={{ marginLeft: 8, color: bp.recentChangeBps > 0 ? "#fb923c" : "#7fffd4" }}>
              直近12M {bp.recentChangeBps > 0 ? "+" : ""}{bp.recentChangeBps}bps
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <ProbBlock label="🟢 緩和" pct={bp.probRateCut} color={cutColor} />
        <ProbBlock label="🟡 据置" pct={bp.probRateHold} color={holdColor} />
        <ProbBlock label="🔴 利上げ" pct={bp.probRateHike} color={hikeColor} />
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs" style={MONO}>
        <MetricStat label="日本CPI YoY" value={bp.cpiYoY !== null ? `${bp.cpiYoY.toFixed(2)}%` : "—"} note={snapshot.jpCpi?.date} />
        <MetricStat label="日本失業率" value={bp.unemploymentRate !== null ? `${bp.unemploymentRate.toFixed(1)}%` : "—"} note={snapshot.jpUnemployment?.date} />
        <MetricStat
          label="10年JGB"
          value={bp.jgb10y !== null ? `${bp.jgb10y.toFixed(2)}%` : "—"}
          note={bp.jgb10yChange3m !== null ? `3M ${bp.jgb10yChange3m > 0 ? "+" : ""}${bp.jgb10yChange3m}bps` : snapshot.jpJgb10y?.date}
        />
        <MetricStat label="USD/JPY" value={bp.usdJpy !== null ? bp.usdJpy.toFixed(1) : "—"} note="円安は利上げ圧力" />
      </div>

      {bp.rationale.length > 0 && (
        <div className="pt-3 border-t border-[var(--color-border)]">
          <div className="text-xs font-bold text-[var(--color-text)] mb-2" style={MONO}>📊 判定根拠</div>
          <ul className="space-y-1 text-xs text-[var(--color-text)]" style={MONO}>
            {bp.rationale.map((r, i) => <li key={i}>▸ {r}</li>)}
          </ul>
        </div>
      )}

      <div className="text-xs p-2 border-l-4 text-[var(--color-text)]" style={{ ...MONO, borderColor: dominantColor, background: `${dominantColor}10` }}>
        {dominant === bp.probRateHike
          ? "💡 利上げ寄り: 銀行 (三菱UFJ/三井住友) ・保険 (東京海上/T&D) に追い風、不動産 (三井不動産/住友不動産) ・建設・ハイテクグロースに注意"
          : dominant === bp.probRateCut
          ? "💡 緩和寄り: 不動産・建設・REITに追い風、銀行・保険に逆風"
          : "💡 据置: 大きなテーマ性なし、円相場と日米金利差で個別判断"}
      </div>
    </div>
  );
}

function RecessionCard({ rc, snapshot }: { rc: Recession; snapshot: Snapshot }) {
  const probColor = color(rc.probRecession12m);
  return (
    <div
      className="p-5 border space-y-4"
      style={{ borderColor: probColor, background: `${probColor}10`, boxShadow: `0 0 16px ${probColor}25` }}
    >
      <div>
        <div className="text-sm font-bold text-[var(--color-text)]" style={MONO}>📉 米景気後退確率 (12ヶ月以内)</div>
        <div className="flex items-baseline gap-3 mt-1">
          <div className="text-6xl font-black leading-none" style={{ color: probColor, ...MONO }}>
            {rc.probRecession12m}
          </div>
          <div className="text-base font-bold text-[var(--color-text)]" style={MONO}>%</div>
        </div>
        <div className="text-xs text-[var(--color-text)] mt-1" style={MONO}>
          Yield Curve + Sahm Rule の簡易統合モデル
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs" style={MONO}>
        <MetricStat
          label="10y-3m スプレッド"
          value={rc.yieldCurveT10Y3M !== null ? `${rc.yieldCurveT10Y3M.toFixed(2)}%` : "—"}
          note={rc.isInverted ? "🚨 逆イールド" : "正常"}
          highlight={rc.isInverted}
        />
        <MetricStat
          label="10y-2y スプレッド"
          value={rc.yieldCurveT10Y2Y !== null ? `${rc.yieldCurveT10Y2Y.toFixed(2)}%` : "—"}
          note={snapshot.yieldCurveT10Y2Y?.date}
        />
        <MetricStat
          label="逆イールド継続"
          value={rc.monthsSinceInversion ? `${rc.monthsSinceInversion}ヶ月` : "—"}
        />
        <MetricStat
          label="Sahm Rule"
          value={rc.sahmRuleTriggered ? "🚨 発動" : `${rc.unemploymentRise?.toFixed(2) ?? "—"}pt`}
          note={rc.sahmRuleTriggered ? "景気後退入り高確率" : "閾値 +0.5pt"}
          highlight={rc.sahmRuleTriggered}
        />
      </div>

      {rc.signals.length > 0 && (
        <div className="pt-3 border-t border-[var(--color-border)]">
          <div className="text-xs font-bold text-[var(--color-text)] mb-2" style={MONO}>📊 検出シグナル</div>
          <ul className="space-y-1 text-xs text-[var(--color-text)]" style={MONO}>
            {rc.signals.map((s, i) => <li key={i}>▸ {s}</li>)}
          </ul>
        </div>
      )}

      <div className="text-xs p-2 border-l-4 text-[var(--color-text)]" style={{ ...MONO, borderColor: probColor, background: `${probColor}10` }}>
        {rc.probRecession12m >= 60 ? "💡 高確率: ディフェンシブ株シフト推奨、シクリカル銘柄注意" :
         rc.probRecession12m >= 35 ? "💡 中程度: ポートフォリオ分散度を点検、現金比率引上検討" :
         "💡 低確率: 通常運転、ただし指標変化は注視"}
      </div>
    </div>
  );
}

function FxCard({ fx, snapshot }: { fx: Fx; snapshot: Snapshot }) {
  const dir = (fx.changeFrom30d ?? 0) > 0 ? "weakYen" : "strongYen";
  const dirLabel = dir === "weakYen" ? "📈 円安方向" : "📉 円高方向";
  const dirColor = dir === "weakYen" ? "#fb923c" : "#7fffd4";
  return (
    <div
      className="p-5 border space-y-4"
      style={{ borderColor: dirColor, background: `${dirColor}10`, boxShadow: `0 0 16px ${dirColor}25` }}
    >
      <div>
        <div className="text-sm font-bold text-[var(--color-text)]" style={MONO}>💴 USD/JPY 為替</div>
        <div className="flex items-baseline gap-3 mt-1">
          <div className="text-6xl font-black leading-none" style={{ color: dirColor, ...MONO }}>
            {fx.usdJpy?.toFixed(1) ?? "—"}
          </div>
          <div className="text-base font-bold text-[var(--color-text)]" style={MONO}>円</div>
        </div>
        <div className="text-xs text-[var(--color-text)] mt-1" style={MONO}>
          {snapshot.usdJpy?.date} · 30日前比 <span className="font-black" style={{ color: dirColor }}>
            {fx.changeFrom30d !== null ? `${fx.changeFrom30d > 0 ? "+" : ""}${fx.changeFrom30d.toFixed(1)}%` : "—"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs" style={MONO}>
        <MetricStat label="方向感" value={dirLabel} />
        <MetricStat
          label="介入閾値接近"
          value={fx.near155 ? "🚨 接近中" : "余裕あり"}
          highlight={fx.near155}
        />
      </div>

      {fx.signals.length > 0 && (
        <div className="pt-3 border-t border-[var(--color-border)]">
          <div className="text-xs font-bold text-[var(--color-text)] mb-2" style={MONO}>📊 シグナル</div>
          <ul className="space-y-1 text-xs text-[var(--color-text)]" style={MONO}>
            {fx.signals.map((s, i) => <li key={i}>▸ {s}</li>)}
          </ul>
        </div>
      )}

      <div className="text-xs p-2 border-l-4 text-[var(--color-text)]" style={{ ...MONO, borderColor: dirColor, background: `${dirColor}10` }}>
        {dir === "weakYen"
          ? "💡 円安継続: 輸出株 (自動車/電機) に追い風、輸入企業 (小売/食品/エネルギー) コスト増"
          : "💡 円高方向: 輸出株に向かい風、輸入関連企業に追い風、海外資産は円建て目減り"}
      </div>
    </div>
  );
}

function OilCard({ oil, snapshot }: { oil: Oil; snapshot: Snapshot }) {
  const dirColor = oil.direction === "up" ? "#fb923c" : oil.direction === "down" ? "#7fffd4" : "#facc15";
  const dirLabel = oil.direction === "up" ? "📈 上昇トレンド" : oil.direction === "down" ? "📉 下落トレンド" : "🟡 横ばい";
  return (
    <div
      className="p-5 border space-y-4"
      style={{ borderColor: dirColor, background: `${dirColor}10`, boxShadow: `0 0 16px ${dirColor}25` }}
    >
      <div>
        <div className="text-sm font-bold text-[var(--color-text)]" style={MONO}>🛢 原油動向 (WTI/Brent)</div>
        <div className="flex items-baseline gap-3 mt-1">
          <div className="text-6xl font-black leading-none" style={{ color: dirColor, ...MONO }}>
            {oil.wti?.toFixed(1) ?? "—"}
          </div>
          <div className="text-base font-bold text-[var(--color-text)]" style={MONO}>$/bbl</div>
        </div>
        <div className="text-xs text-[var(--color-text)] mt-1" style={MONO}>
          WTI {snapshot.wti?.date} · 30日 <span className="font-black" style={{ color: dirColor }}>
            {oil.wtiChange30d !== null ? `${oil.wtiChange30d > 0 ? "+" : ""}${oil.wtiChange30d.toFixed(1)}%` : "—"}
          </span> · 90日 <span className="font-black" style={{ color: dirColor }}>
            {oil.wtiChange90d !== null ? `${oil.wtiChange90d > 0 ? "+" : ""}${oil.wtiChange90d.toFixed(1)}%` : "—"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs" style={MONO}>
        <MetricStat label="方向感" value={dirLabel} />
        <MetricStat label="Brent" value={oil.brent !== null ? `$${oil.brent.toFixed(1)}` : "—"} note={oil.spread !== null ? `スプレッド +$${oil.spread.toFixed(1)}` : undefined} />
      </div>

      {oil.signals.length > 0 && (
        <div className="pt-3 border-t border-[var(--color-border)]">
          <div className="text-xs font-bold text-[var(--color-text)] mb-2" style={MONO}>📊 シグナル</div>
          <ul className="space-y-1 text-xs text-[var(--color-text)]" style={MONO}>
            {oil.signals.map((s, i) => <li key={i}>▸ {s}</li>)}
          </ul>
        </div>
      )}

      <div className="text-xs p-2 border-l-4 text-[var(--color-text)]" style={{ ...MONO, borderColor: dirColor, background: `${dirColor}10` }}>
        {oil.highPrice
          ? "💡 高値圏: エネルギー株/総合商社 (INPEX/ENEOS/三井物産) 追い風、運輸・電力・化学にコスト圧"
          : oil.lowPrice
          ? "💡 安値圏: エネルギー株逆風、運輸・電力・化学にメリット"
          : "💡 通常圏: 大きなテーマ性なし、銘柄選別重視"}
      </div>
    </div>
  );
}

function ChinaCard({ china, snapshot }: { china: China; snapshot: Snapshot }) {
  const scoreColor =
    china.demandLabel === "expansion" ? "#7fffd4" :
    china.demandLabel === "contraction" ? "#fb923c" :
    "#facc15";
  const scoreLabel =
    china.demandLabel === "expansion" ? "🟢 拡大方向" :
    china.demandLabel === "contraction" ? "🟠 鈍化方向" :
    "🟡 中立";
  // demandScore は -100 〜 +100 → 視覚的に 0-100 マッピング
  const visScore = Math.max(0, Math.min(100, Math.round((china.demandScore + 100) / 2)));
  return (
    <div
      className="p-5 border space-y-4"
      style={{ borderColor: scoreColor, background: `${scoreColor}10`, boxShadow: `0 0 16px ${scoreColor}25` }}
    >
      <div>
        <div className="text-sm font-bold text-[var(--color-text)]" style={MONO}>🇨🇳 中国デマンド指標</div>
        <div className="flex items-baseline gap-3 mt-1">
          <div className="text-6xl font-black leading-none" style={{ color: scoreColor, ...MONO }}>
            {visScore}
          </div>
          <div className="text-base font-bold text-[var(--color-text)]" style={MONO}>/100</div>
        </div>
        <div className="text-xs text-[var(--color-text)] mt-1" style={MONO}>
          {scoreLabel} · 銅+鉄鉱石の3M変化から算出
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs" style={MONO}>
        <MetricStat
          label="銅 (Dr. Copper)"
          value={china.copper !== null ? `$${Math.round(china.copper).toLocaleString()}/t` : "—"}
          note={china.copperChange3m !== null ? `3M ${china.copperChange3m > 0 ? "+" : ""}${china.copperChange3m.toFixed(1)}%` : undefined}
        />
        <MetricStat
          label="鉄鉱石"
          value={china.ironOre !== null ? `${china.ironOre.toFixed(1)}` : "—"}
          note={china.ironOreChange3m !== null ? `3M ${china.ironOreChange3m > 0 ? "+" : ""}${china.ironOreChange3m.toFixed(1)}%` : undefined}
        />
      </div>

      {china.signals.length > 0 && (
        <div className="pt-3 border-t border-[var(--color-border)]">
          <div className="text-xs font-bold text-[var(--color-text)] mb-2" style={MONO}>📊 シグナル</div>
          <ul className="space-y-1 text-xs text-[var(--color-text)]" style={MONO}>
            {china.signals.map((s, i) => <li key={i}>▸ {s}</li>)}
          </ul>
        </div>
      )}

      <div className="text-xs p-2 border-l-4 text-[var(--color-text)]" style={{ ...MONO, borderColor: scoreColor, background: `${scoreColor}10` }}>
        {china.demandLabel === "expansion"
          ? "💡 中国需要拡大: 商社 (三菱/三井/伊藤忠)、機械 (コマツ/クボタ)、化学 (信越/三菱ケミ)、海運 (川崎汽船) に追い風"
          : china.demandLabel === "contraction"
          ? "💡 中国需要鈍化: 商社・機械・化学・海運に逆風、輸出依存度高い銘柄は要観察"
          : "💡 中立: 中国依存度の高い銘柄は他要因で判断"}
      </div>
    </div>
  );
}

function SemiCycleCard({ semi, snapshot }: { semi: SemiCycle; snapshot: Snapshot }) {
  const stageColor =
    semi.cycleStage === "boom" ? "#7fffd4" :
    semi.cycleStage === "expansion" ? "#86efac" :
    semi.cycleStage === "peak" ? "#facc15" :
    semi.cycleStage === "contraction" ? "#fb923c" :
    semi.cycleStage === "trough" ? "#a78bfa" :
    "#94a3b8";
  const stageLabel =
    semi.cycleStage === "boom" ? "🟢 ブーム (絶頂)" :
    semi.cycleStage === "expansion" ? "🟢 拡大" :
    semi.cycleStage === "peak" ? "🟡 ピーク懸念" :
    semi.cycleStage === "contraction" ? "🟠 縮小" :
    semi.cycleStage === "trough" ? "🟣 底入れ" :
    "🟡 中立";
  // cycleScore は -100〜+100 → 0-100
  const visScore = Math.max(0, Math.min(100, Math.round((semi.cycleScore + 100) / 2)));
  return (
    <div
      className="p-5 border space-y-4"
      style={{ borderColor: stageColor, background: `${stageColor}10`, boxShadow: `0 0 16px ${stageColor}25` }}
    >
      <div>
        <div className="text-sm font-bold text-[var(--color-text)]" style={MONO}>🔬 半導体サイクル</div>
        <div className="flex items-baseline gap-3 mt-1">
          <div className="text-6xl font-black leading-none" style={{ color: stageColor, ...MONO }}>
            {visScore}
          </div>
          <div className="text-base font-bold text-[var(--color-text)]" style={MONO}>/100</div>
        </div>
        <div className="text-xs text-[var(--color-text)] mt-1" style={MONO}>
          {stageLabel} · SMH ETF + 米半導体生産指数 + PPI から推計
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs" style={MONO}>
        <MetricStat
          label="SMH ETF"
          value={semi.smhPrice !== null ? `$${semi.smhPrice.toFixed(1)}` : "—"}
          note={semi.smhChange1y !== null ? `1Y ${semi.smhChange1y > 0 ? "+" : ""}${semi.smhChange1y.toFixed(1)}%` : undefined}
        />
        <MetricStat
          label="3Mモメンタム"
          value={semi.smhChange3m !== null ? `${semi.smhChange3m > 0 ? "+" : ""}${semi.smhChange3m.toFixed(1)}%` : "—"}
          note="SMH 3ヶ月変化"
        />
        <MetricStat
          label="米半導体生産"
          value={semi.productionIndex !== null ? semi.productionIndex.toFixed(1) : "—"}
          note={semi.productionYoY !== null ? `YoY ${semi.productionYoY > 0 ? "+" : ""}${semi.productionYoY.toFixed(1)}%` : snapshot.semiProduction?.date}
        />
        <MetricStat
          label="半導体PPI"
          value={semi.ppi !== null ? semi.ppi.toFixed(1) : "—"}
          note={semi.ppiYoY !== null ? `YoY ${semi.ppiYoY > 0 ? "+" : ""}${semi.ppiYoY.toFixed(1)}%` : snapshot.semiPPI?.date}
        />
      </div>

      {semi.signals.length > 0 && (
        <div className="pt-3 border-t border-[var(--color-border)]">
          <div className="text-xs font-bold text-[var(--color-text)] mb-2" style={MONO}>📊 シグナル</div>
          <ul className="space-y-1 text-xs text-[var(--color-text)]" style={MONO}>
            {semi.signals.map((s, i) => <li key={i}>▸ {s}</li>)}
          </ul>
        </div>
      )}

      <div className="text-xs p-2 border-l-4 text-[var(--color-text)]" style={{ ...MONO, borderColor: stageColor, background: `${stageColor}10` }}>
        {semi.cycleStage === "boom" || semi.cycleStage === "expansion"
          ? "💡 拡大局面: 東京エレク・SCREEN・アドバンテスト・信越化学・SUMCO・レーザーテック・ディスコに追い風、車載半導体含む電機にも波及"
          : semi.cycleStage === "peak"
          ? "💡 ピーク懸念: 半導体株は利益確定の動き出やすい、新規買いは慎重に、決算で在庫増/見通し下方修正を警戒"
          : semi.cycleStage === "contraction"
          ? "💡 縮小局面: 半導体製造装置・素材銘柄に逆風、在庫調整完了サイン待ち"
          : semi.cycleStage === "trough"
          ? "💡 底入れ局面: 半導体株の先回り買いの好機、業績悪化のうちが仕込み時"
          : "💡 中立: 個別決算と地政学リスクで判断"}
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function ProbBlock({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <div className="flex flex-col items-center p-2 border" style={{ borderColor: `${color}55`, background: `${color}0d` }}>
      <div className="text-xs font-bold text-[var(--color-text)]">{label}</div>
      <div className="flex items-baseline gap-1 mt-1">
        <div className="text-4xl font-black leading-none" style={{ color, ...MONO }}>{pct}</div>
        <div className="text-xs text-[var(--color-text)]" style={MONO}>%</div>
      </div>
    </div>
  );
}

function MetricStat({
  label,
  value,
  note,
  highlight,
}: {
  label: string;
  value: string;
  note?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className="p-2 border flex flex-col"
      style={{
        borderColor: highlight ? "rgba(239,68,68,0.5)" : "var(--color-border)",
        background: highlight ? "rgba(239,68,68,0.08)" : "rgba(0,0,0,0.25)",
      }}
    >
      <div className="text-xs font-bold text-[var(--color-text)]" style={MONO}>{label}</div>
      <div className={`text-lg font-black mt-1 ${highlight ? "text-red-400" : "text-[var(--color-text)]"}`} style={MONO}>{value}</div>
      {note && <div className="text-xs text-[var(--color-text)] mt-0.5" style={MONO}>{note}</div>}
    </div>
  );
}
