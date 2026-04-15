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
    <div className="relative flex items-center justify-between py-2.5 px-3 border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--bg-card-hover)] hover:border-l-2 hover:border-l-[var(--color-accent)] transition-all duration-150 min-h-[44px]">
      <div className="flex flex-col min-w-0">
        <span
          className="text-[10px] text-[var(--color-accent)] tracking-[0.1em]"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          {code ?? ""}
        </span>
        <span className="text-sm text-[var(--color-text)] truncate">
          {name ?? ""}
        </span>
      </div>
      <div className="flex flex-col items-end shrink-0 ml-3">
        <span
          className="text-sm font-bold"
          style={{
            color,
            fontFamily: "'JetBrains Mono', monospace",
            textShadow: `0 0 6px ${isUp ? "rgba(255,59,107,0.4)" : "rgba(0,217,255,0.4)"}`,
          }}
        >
          {safePrice.toLocaleString("ja-JP", {
            minimumFractionDigits: 1,
            maximumFractionDigits: 2,
          })}
        </span>
        <span
          className="text-xs font-bold px-1.5 py-0.5 mt-0.5"
          style={{
            color,
            border: `1px solid ${color}`,
            backgroundColor: isUp
              ? "rgba(255,59,107,0.10)"
              : "rgba(0,217,255,0.10)",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {arrow}
          {safePct.toFixed(2)}%
        </span>
      </div>
    </div>
  );
}
