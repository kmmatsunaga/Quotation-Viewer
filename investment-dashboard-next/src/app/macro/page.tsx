"use client";

import { useEffect, useState, useCallback } from "react";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface MacroItem {
  key: string;
  label: string;
  category: string;
  unit: string;
  symbol: string;
  price: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  ts: number | null;
}

interface MacroResp {
  ok: boolean;
  computedAt: string;
  categories: Record<string, MacroItem[]>;
}

const CATEGORY_INFO: Record<string, { label: string; icon: string; description: string }> = {
  index: { label: "主要指数", icon: "📈", description: "株式市場の地合い" },
  fx: { label: "為替", icon: "💱", description: "通貨ペア" },
  rate: { label: "金利", icon: "📊", description: "国債利回り" },
  commodity: { label: "コモディティ", icon: "🛢", description: "資源価格" },
  fear: { label: "恐怖指数", icon: "😱", description: "市場ボラティリティ" },
};

const CATEGORY_ORDER = ["index", "fx", "rate", "commodity", "fear"];

export default function MacroPage() {
  const [data, setData] = useState<MacroResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/macro");
      const j = await res.json();
      setData(j);
      setLastUpdate(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);  // 1分ごと自動更新
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-[var(--color-accent)]" style={MONO}>
          🌐 マクロダッシュボード
        </h1>
        <p className="text-xs text-[var(--color-text-secondary)] mt-1" style={MONO}>
          指数 / 為替 / 金利 / コモディティ / 恐怖指数を 1 画面で · 60秒ごと更新
        </p>
        {lastUpdate && (
          <p className="text-[10px] text-[var(--color-text-secondary)] mt-1" style={MONO}>
            最終更新: {lastUpdate.toLocaleTimeString("ja-JP", { hour12: false })}
          </p>
        )}
      </div>

      {loading && !data ? (
        <div className="text-center py-12 text-[var(--color-text-secondary)] text-sm" style={MONO}>
          読み込み中...
        </div>
      ) : !data ? (
        <div className="text-center py-12 text-red-400 text-sm" style={MONO}>
          データ取得失敗
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {CATEGORY_ORDER.map((cat) => {
            const items = data.categories[cat];
            if (!items || items.length === 0) return null;
            const info = CATEGORY_INFO[cat];
            return (
              <div
                key={cat}
                className="p-3 border"
                style={{ ...MONO, borderColor: "var(--color-border)", background: "rgba(0,0,0,0.25)" }}
              >
                <div className="mb-2">
                  <div className="text-sm font-bold text-[var(--color-accent)]">
                    {info.icon} {info.label}
                  </div>
                  <div className="text-[9px] uppercase text-[var(--color-text-secondary)]">
                    {info.description}
                  </div>
                </div>
                <div className="space-y-1">
                  {items.map((item) => (
                    <MacroRow key={item.key} item={item} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MacroRow({ item }: { item: MacroItem }) {
  const isUp = (item.changePct ?? 0) >= 0;
  const color =
    item.changePct === null
      ? "var(--color-text-secondary)"
      : isUp
      ? "#22c55e"
      : "#fb923c";

  return (
    <div className="flex items-center justify-between py-1.5 border-b border-[var(--color-border)]/30 last:border-0">
      <div>
        <div className="text-xs text-[var(--color-text)]">{item.label}</div>
        <div className="text-[9px] text-[var(--color-text-secondary)]">{item.symbol}</div>
      </div>
      <div className="text-right">
        <div className="text-sm font-bold text-[var(--color-text)]">
          {item.price !== null ? formatPrice(item.price, item.category) : "—"}
          {item.unit && <span className="text-[9px] text-[var(--color-text-secondary)] ml-1">{item.unit}</span>}
        </div>
        <div className="text-[10px]" style={{ color }}>
          {item.changePct !== null
            ? `${isUp ? "+" : ""}${item.changePct.toFixed(2)}% (${isUp ? "+" : ""}${item.change?.toFixed(item.category === "rate" ? 3 : 2)})`
            : "—"}
        </div>
      </div>
    </div>
  );
}

function formatPrice(p: number, category: string): string {
  if (category === "rate") return p.toFixed(3);
  if (category === "fear") return p.toFixed(2);
  if (category === "fx") return p.toFixed(2);
  if (p >= 10000) return p.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return p.toFixed(2);
}
