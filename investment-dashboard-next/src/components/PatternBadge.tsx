"use client";

/**
 * PatternBadge — iSpeed-style chart pattern tag component.
 * Displays the detected pattern as a compact, color-coded badge.
 */

export interface PatternData {
  id: string;
  label: string;
  labelEn: string;
  description: string;
  signal: "buy" | "sell" | "neutral" | "watch";
  strength: number;
  direction: string;
  phase: string;
  confidence: number;
  timeframe: string;
  summary?: {
    maOrder: string;
    maSlopes: { ma5Slope: number; ma25Slope: number; ma75Slope: number };
    roc5: number;
    roc20: number;
    close: number;
  };
}

const SIGNAL_STYLES: Record<string, { bg: string; border: string; text: string; glow: string }> = {
  buy: {
    bg: "rgba(255, 59, 107, 0.15)",
    border: "rgba(255, 59, 107, 0.5)",
    text: "#ff3b6b",
    glow: "0 0 8px rgba(255, 59, 107, 0.3)",
  },
  sell: {
    bg: "rgba(0, 217, 255, 0.15)",
    border: "rgba(0, 217, 255, 0.5)",
    text: "#00d9ff",
    glow: "0 0 8px rgba(0, 217, 255, 0.3)",
  },
  watch: {
    bg: "rgba(255, 176, 0, 0.15)",
    border: "rgba(255, 176, 0, 0.5)",
    text: "#ffb000",
    glow: "0 0 8px rgba(255, 176, 0, 0.3)",
  },
  neutral: {
    bg: "rgba(106, 122, 154, 0.15)",
    border: "rgba(106, 122, 154, 0.4)",
    text: "#8a9aba",
    glow: "none",
  },
};

const SIGNAL_LABELS: Record<string, string> = {
  buy: "買",
  sell: "売",
  watch: "注目",
  neutral: "中立",
};

const DIRECTION_ARROWS: Record<string, string> = {
  strong_up: "⬆",
  mild_up: "↗",
  sideways: "→",
  mild_down: "↘",
  strong_down: "⬇",
};

interface PatternBadgeProps {
  pattern: PatternData;
  size?: "sm" | "md";
  showTimeframe?: boolean;
  showConfidence?: boolean;
  onClick?: () => void;
}

export default function PatternBadge({
  pattern,
  size = "sm",
  showTimeframe = false,
  showConfidence = false,
  onClick,
}: PatternBadgeProps) {
  const style = SIGNAL_STYLES[pattern.signal] ?? SIGNAL_STYLES.neutral;
  const arrow = DIRECTION_ARROWS[pattern.direction] ?? "•";
  const signalLabel = SIGNAL_LABELS[pattern.signal] ?? "";

  const TIMEFRAME_LABELS: Record<string, string> = {
    daily: "日",
    weekly: "週",
    monthly: "月",
  };

  const isSm = size === "sm";

  return (
    <button
      onClick={onClick}
      className={`
        inline-flex items-center gap-1 rounded-md border
        transition-all duration-200 hover:brightness-125
        ${isSm ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-xs"}
        ${onClick ? "cursor-pointer" : "cursor-default"}
      `}
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        backgroundColor: style.bg,
        borderColor: style.border,
        color: style.text,
        boxShadow: style.glow,
      }}
      title={`${pattern.label} — ${pattern.description}`}
    >
      {showTimeframe && (
        <span style={{ opacity: 0.7 }}>
          {TIMEFRAME_LABELS[pattern.timeframe] ?? pattern.timeframe}
        </span>
      )}
      <span>{arrow}</span>
      <span className="font-bold">{pattern.label}</span>
      {pattern.confidence > 0 && showConfidence && (
        <span style={{ opacity: 0.6 }}>{pattern.confidence}</span>
      )}
      <span
        className={`${isSm ? "text-[9px]" : "text-[10px]"} font-bold`}
        style={{
          backgroundColor: style.text,
          color: "#05060d",
          borderRadius: "3px",
          padding: "0 3px",
          marginLeft: "2px",
        }}
      >
        {signalLabel}
      </span>
    </button>
  );
}

/**
 * PatternBadgeGroup — Shows multiple pattern badges (e.g., daily + weekly).
 */
interface PatternBadgeGroupProps {
  patterns: Record<string, PatternData[]>; // { daily: [...], weekly: [...] }
  maxPerTimeframe?: number;
  size?: "sm" | "md";
  onClick?: (pattern: PatternData) => void;
}

export function PatternBadgeGroup({
  patterns,
  maxPerTimeframe = 1,
  size = "sm",
  onClick,
}: PatternBadgeGroupProps) {
  const timeframes = ["daily", "weekly", "monthly"];
  const badges: PatternData[] = [];

  for (const tf of timeframes) {
    const pats = patterns[tf];
    if (pats && pats.length > 0) {
      badges.push(...pats.slice(0, maxPerTimeframe));
    }
  }

  if (badges.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {badges.map((p, i) => (
        <PatternBadge
          key={`${p.timeframe}-${p.id}-${i}`}
          pattern={p}
          size={size}
          showTimeframe={true}
          onClick={onClick ? () => onClick(p) : undefined}
        />
      ))}
    </div>
  );
}
