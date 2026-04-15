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
      className={`bg-card rounded-xl p-3 md:p-4 border transition-all duration-200 text-left w-full ${
        selected
          ? "border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]/40"
          : "border-[var(--color-border)] hover:border-[var(--color-accent)]/30"
      }`}
    >
      <div className="flex items-start justify-between mb-2">
        <span className="text-xs text-[var(--color-text-secondary)] truncate">
          {name}
        </span>
        <span
          className="text-xs font-medium px-1.5 py-0.5 rounded"
          style={{
            color,
            backgroundColor: isUp
              ? "rgba(255,82,82,0.15)"
              : "rgba(68,138,255,0.15)",
          }}
        >
          {arrow}
          {safeChange.toFixed(2)}%
        </span>
      </div>
      <div className="text-lg md:text-xl font-bold mb-2" style={{ color }}>
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
