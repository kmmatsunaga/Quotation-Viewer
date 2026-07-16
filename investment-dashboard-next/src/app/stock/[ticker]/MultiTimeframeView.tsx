"use client";

import { useEffect, useState } from "react";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface MultiTimeframeData {
  daily: { candles: Candle[]; price: number };
  weekly: { candles: Candle[]; price: number };
  monthly: { candles: Candle[]; price: number };
}

interface PatternInfo {
  label: string;
  direction: string;
  signal: string;
  confidence: number;
  strength: number;
}

interface PatternsResponse {
  patterns: Record<
    string,
    {
      name?: string;
      patterns?: {
        daily: PatternInfo[];
        weekly: PatternInfo[];
        monthly: PatternInfo[];
      };
    }
  >;
}

/**
 * 同じ銘柄を日足・週足・月足で並べて表示する小型チャートビュー。
 * 短期トレンドと長期トレンドの不一致を一目で把握する用途。
 */
export default function MultiTimeframeView({
  ticker,
  breakeven,
  targetPrice,
  stopLoss,
}: {
  ticker: string;
  breakeven?: number;
  targetPrice?: number;
  stopLoss?: number;
}) {
  const [data, setData] = useState<MultiTimeframeData | null>(null);
  const [patterns, setPatterns] = useState<PatternsResponse["patterns"][string] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    (async () => {
      try {
        // 日足 (6mo), 週足 (2y), 月足 (5y) を並列取得
        const [dailyRes, weeklyRes, monthlyRes, patternRes] = await Promise.all([
          fetch(`/api/stock/${ticker}?range=6mo&interval=1d`).then((r) => r.json()),
          fetch(`/api/stock/${ticker}?range=2y&interval=1wk`).then((r) => r.json()),
          fetch(`/api/stock/${ticker}?range=5y&interval=1mo`).then((r) => r.json()),
          fetch(`/api/stocks/patterns?tickers=${ticker}`).then((r) => r.json()),
        ]);

        setData({
          daily: { candles: dailyRes.candles ?? [], price: dailyRes.price },
          weekly: { candles: weeklyRes.candles ?? [], price: weeklyRes.price },
          monthly: { candles: monthlyRes.candles ?? [], price: monthlyRes.price },
        });
        setPatterns(patternRes.patterns?.[ticker] ?? null);
      } catch (err) {
        console.error("MultiTimeframe load error:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, [ticker]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-48 rounded animate-pulse"
            style={{ background: "rgba(0,240,255,0.05)" }}
          />
        ))}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-8 text-sm text-[var(--color-text-secondary)]" style={MONO}>
        データを取得できませんでした
      </div>
    );
  }

  const frames = [
    { key: "monthly" as const, label: "月足 (5年)", candles: data.monthly.candles, patterns: patterns?.patterns?.monthly ?? [] },
    { key: "weekly" as const, label: "週足 (2年)", candles: data.weekly.candles, patterns: patterns?.patterns?.weekly ?? [] },
    { key: "daily" as const, label: "日足 (6か月)", candles: data.daily.candles, patterns: patterns?.patterns?.daily ?? [] },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h3 className="text-sm font-medium text-[var(--color-accent)]" style={MONO}>
          📊 マルチタイムフレーム
        </h3>
        <p className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
          長期 ← 月 / 週 / 日 → 短期
        </p>
      </div>

      {/* トレンド比較サマリ */}
      <div className="grid grid-cols-3 gap-2">
        {frames.map((f) => {
          const top = f.patterns[0];
          if (!top) {
            return (
              <div
                key={f.key}
                className="p-2 rounded text-center text-[10px] text-[var(--color-text-secondary)]"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--color-border)", ...MONO }}
              >
                {f.label}
                <br />
                <span className="opacity-60">パターンなし</span>
              </div>
            );
          }
          const sigColor =
            top.signal === "buy" ? "#22c55e" : top.signal === "sell" ? "#ef4444" : "#fbbf24";
          const sigLabel = top.signal === "buy" ? "🟢 買い" : top.signal === "sell" ? "🔴 売り" : "🟡 中立";
          return (
            <div
              key={f.key}
              className="p-2 rounded text-center"
              style={{
                background: `${sigColor}10`,
                border: `1px solid ${sigColor}40`,
                ...MONO,
              }}
            >
              <div className="text-[9px] text-[var(--color-text-secondary)] mb-1">{f.label}</div>
              <div className="text-[10px] font-medium" style={{ color: sigColor }}>
                {sigLabel}
              </div>
              <div className="text-[10px] mt-0.5 truncate" title={top.label}>
                {top.label}
              </div>
              <div className="text-[9px] text-[var(--color-text-secondary)] mt-0.5">
                信頼度{top.confidence}% / 強度{top.strength}/5
              </div>
            </div>
          );
        })}
      </div>

      {/* ミニチャート */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {frames.map((f) => (
          <MiniChart
            key={f.key}
            label={f.label}
            candles={f.candles}
            breakeven={breakeven}
            targetPrice={targetPrice}
            stopLoss={stopLoss}
          />
        ))}
      </div>

      {/* トレンド一致判定 */}
      <TrendAlignment frames={frames.map((f) => ({ tf: f.label, p: f.patterns[0] }))} />
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ミニSVGチャート (軽量、依存なし)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function MiniChart({
  label,
  candles,
  breakeven,
  targetPrice,
  stopLoss,
}: {
  label: string;
  candles: Candle[];
  breakeven?: number;
  targetPrice?: number;
  stopLoss?: number;
}) {
  if (candles.length === 0) {
    return (
      <div className="h-40 rounded flex items-center justify-center text-xs text-[var(--color-text-secondary)]" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--color-border)", ...MONO }}>
        {label}: データなし
      </div>
    );
  }

  const W = 280;
  const H = 140;
  const PAD = { top: 8, right: 8, bottom: 18, left: 4 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const closes = candles.map((c) => c.close);
  let yMin = Math.min(...candles.map((c) => c.low));
  let yMax = Math.max(...candles.map((c) => c.high));
  // breakeven/target/stop を表示するために range を広げる
  for (const p of [breakeven, targetPrice, stopLoss]) {
    if (p && p > 0) {
      yMin = Math.min(yMin, p);
      yMax = Math.max(yMax, p);
    }
  }
  const yRange = yMax - yMin || 1;

  const xStep = innerW / candles.length;
  const yScale = (v: number) => PAD.top + (1 - (v - yMin) / yRange) * innerH;

  // ライン (close)
  const pathPoints = candles
    .map((c, i) => `${i === 0 ? "M" : "L"} ${PAD.left + i * xStep} ${yScale(c.close)}`)
    .join(" ");

  // 直近の値
  const last = closes[closes.length - 1];
  const first = closes[0];
  const change = ((last - first) / first) * 100;

  const lineColor = change >= 0 ? "#00d9ff" : "#ff4d6d";
  const fillColor = change >= 0 ? "rgba(0,217,255,0.08)" : "rgba(255,77,109,0.08)";

  // SMA25 を簡易表示 (要素数が25以上のとき)
  let ma25Path = "";
  if (candles.length >= 25) {
    const points: string[] = [];
    for (let i = 24; i < candles.length; i++) {
      const avg = closes.slice(i - 24, i + 1).reduce((a, b) => a + b, 0) / 25;
      points.push(`${i === 24 ? "M" : "L"} ${PAD.left + i * xStep} ${yScale(avg)}`);
    }
    ma25Path = points.join(" ");
  }

  const lines: { y: number; color: string; label: string }[] = [];
  if (breakeven && breakeven > 0) lines.push({ y: yScale(breakeven), color: "#fbbf24", label: `取得¥${breakeven}` });
  if (targetPrice && targetPrice > 0) lines.push({ y: yScale(targetPrice), color: "#22c55e", label: `🎯¥${targetPrice}` });
  if (stopLoss && stopLoss > 0) lines.push({ y: yScale(stopLoss), color: "#ef4444", label: `⚠¥${stopLoss}` });

  return (
    <div className="p-2 rounded" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid var(--color-border)" }}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] text-[var(--color-text-secondary)]" style={MONO}>
          {label}
        </span>
        <span className="text-[10px]" style={{ color: lineColor, ...MONO }}>
          {change >= 0 ? "+" : ""}{change.toFixed(1)}%
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
        {/* 塗りつぶし */}
        <path
          d={`${pathPoints} L ${PAD.left + (candles.length - 1) * xStep} ${PAD.top + innerH} L ${PAD.left} ${PAD.top + innerH} Z`}
          fill={fillColor}
        />
        {/* 価格線 */}
        <path d={pathPoints} stroke={lineColor} strokeWidth={1.5} fill="none" />
        {/* SMA25 */}
        {ma25Path && <path d={ma25Path} stroke="rgba(255,43,214,0.5)" strokeWidth={1} fill="none" strokeDasharray="2,2" />}
        {/* オーバーレイライン */}
        {lines.map((l, i) => (
          <g key={i}>
            <line x1={PAD.left} y1={l.y} x2={PAD.left + innerW} y2={l.y} stroke={l.color} strokeWidth={1} strokeDasharray="3,2" opacity={0.7} />
            <text x={PAD.left + 3} y={l.y - 2} fontSize="8" fill={l.color} style={MONO}>
              {l.label}
            </text>
          </g>
        ))}
        {/* 直近値ラベル */}
        <text x={PAD.left + (candles.length - 1) * xStep - 2} y={yScale(last) - 3} fontSize="9" fill={lineColor} textAnchor="end" style={MONO}>
          ¥{Math.round(last).toLocaleString()}
        </text>
      </svg>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// トレンド一致判定
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function TrendAlignment({ frames }: { frames: { tf: string; p?: PatternInfo }[] }) {
  const validFrames = frames.filter((f) => f.p);
  if (validFrames.length < 2) return null;

  // 方向のスコア化
  const score = (dir: string): number => {
    if (dir === "strong_up") return 2;
    if (dir === "mild_up") return 1;
    if (dir === "sideways") return 0;
    if (dir === "mild_down") return -1;
    if (dir === "strong_down") return -2;
    return 0;
  };

  const scores: number[] = validFrames.map((f) => score(f.p!.direction));
  const sum = scores.reduce((a, b) => a + b, 0);
  const avg = sum / scores.length;
  const allBull = scores.every((s) => s > 0);
  const allBear = scores.every((s) => s < 0);
  const mixed = !allBull && !allBear;

  let verdict = "";
  let color = "";
  if (allBull) {
    verdict = "✨ 全タイムフレーム上昇 - 強い買いシグナル";
    color = "#22c55e";
  } else if (allBear) {
    verdict = "⚠️ 全タイムフレーム下降 - 強い売りシグナル / 様子見";
    color = "#ef4444";
  } else if (mixed && avg > 0.5) {
    verdict = "📈 短期と長期がやや上向き - 押し目買いの好機かも";
    color = "#22c55e";
  } else if (mixed && avg < -0.5) {
    verdict = "📉 短期と長期がやや下向き - 反発待ちか様子見";
    color = "#ef4444";
  } else {
    verdict = "🤔 トレンド不一致 - 判断が難しいタイミング";
    color = "#fbbf24";
  }

  return (
    <div
      className="p-2.5 rounded text-xs"
      style={{
        background: `${color}10`,
        border: `1px solid ${color}40`,
        color,
        ...MONO,
      }}
    >
      {verdict}
    </div>
  );
}
