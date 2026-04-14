"use client";

interface StockRowProps {
  code: string;
  name: string;
  price: number;
  changePct: number;
}

export function StockRow({ code, name, price, changePct }: StockRowProps) {
  const safePrice = price ?? 0;
  const safePct = changePct ?? 0;
  const isUp = safePct >= 0;
  const color = isUp ? "var(--color-up)" : "var(--color-down)";
  const arrow = isUp ? "+" : "";

  return (
    <div className="flex items-center justify-between py-2.5 px-3 border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--bg-card-hover)] transition-colors duration-150 min-h-[44px]">
      <div className="flex flex-col min-w-0">
        <span className="text-xs text-[var(--color-text-secondary)] font-mono">
          {code ?? ""}
        </span>
        <span className="text-sm text-[var(--color-text)] truncate">
          {name ?? ""}
        </span>
      </div>
      <div className="flex flex-col items-end shrink-0 ml-3">
        <span className="text-sm font-medium" style={{ color }}>
          {safePrice.toLocaleString("ja-JP", {
            minimumFractionDigits: 1,
            maximumFractionDigits: 2,
          })}
        </span>
        <span
          className="text-xs font-medium px-1.5 py-0.5 rounded mt-0.5"
          style={{
            color,
            backgroundColor: isUp
              ? "rgba(255,82,82,0.15)"
              : "rgba(68,138,255,0.15)",
          }}
        >
          {arrow}
          {safePct.toFixed(2)}%
        </span>
      </div>
    </div>
  );
}
