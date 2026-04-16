"use client";

interface IndexCardProps {
  name: string;
  value: number;
  change: number;
  chartData?: number[];
  selected?: boolean;
  onClick?: () => void;
}

export function IndexCard({
  name,
  value,
  change,
  chartData,
  selected = false,
  onClick,
}: IndexCardProps) {
  const safeValue = value ?? 0;
  const safeChange = change ?? 0;
  const isUp = safeChange >= 0;
  const color = isUp ? "var(--color-up)" : "var(--color-down)";
  const arrow = isUp ? "+" : "";

  // Mini bar chart
  const bars = chartData ?? [];
  const maxBar = Math.max(...bars, 1);

  const Tag = onClick ? "button" : "div";

  return (
    <Tag
      onClick={onClick}
      className={`relative bg-card p-3 md:p-4 transition-all duration-200 group text-left w-full ${
        selected ? "ring-2 ring-[var(--color-accent)]/60" : ""
      }`}
      style={{
        border: `1px solid ${
          selected ? "var(--color-accent)" : "var(--color-border)"
        }`,
        clipPath:
          "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)",
        boxShadow: selected
          ? "0 0 18px rgba(0,240,255,0.35), inset 0 0 0 1px rgba(0,240,255,0.15)"
          : "inset 0 0 0 1px rgba(0,240,255,0.04)",
      }}
    >
      {/* corner ticks */}
      <span className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-accent)] opacity-60" />
      <span className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[var(--color-accent-2)] opacity-60" />
      <div className="flex items-start justify-between mb-2">
        <span
          className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] truncate"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          {name}
        </span>
        <span
          className="text-xs font-bold px-1.5 py-0.5"
          style={{
            color,
            border: `1px solid ${color}`,
            backgroundColor: isUp
              ? "rgba(255,59,107,0.10)"
              : "rgba(0,217,255,0.10)",
            boxShadow: `0 0 8px ${isUp ? "rgba(255,59,107,0.35)" : "rgba(0,217,255,0.35)"}`,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {arrow}
          {safeChange.toFixed(2)}%
        </span>
      </div>
      <div
        className="text-lg md:text-xl font-bold mb-2"
        style={{
          color,
          fontFamily: "'JetBrains Mono', monospace",
          textShadow: `0 0 10px ${isUp ? "rgba(255,59,107,0.45)" : "rgba(0,217,255,0.45)"}`,
        }}
      >
        {safeValue.toLocaleString("ja-JP", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </div>
      {/* Mini bar chart */}
      {bars.length > 0 && (
        <div className="flex items-end gap-px h-8">
          {bars.map((v, i) => (
            <div
              key={i}
              className="flex-1 rounded-t-sm transition-all duration-300"
              style={{
                height: `${(v / maxBar) * 100}%`,
                backgroundColor: color,
                opacity: 0.4 + (i / bars.length) * 0.6,
              }}
            />
          ))}
        </div>
      )}
    </Tag>
  );
}
