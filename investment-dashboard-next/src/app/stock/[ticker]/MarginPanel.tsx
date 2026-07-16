"use client";

import { useTachibanaSnapshot } from "./TachibanaSnapshotContext";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface MarginData {
  ticker: string;
  date: string;
  longTotal: number | null;
  longChangeTotal: number | null;
  shortTotal: number | null;
  shortChangeTotal: number | null;
  ratioTotal: number | null;
}

interface HibuData {
  ticker: string;
  rate: number | null;
}

interface SyoukinData {
  ticker: string;
  date: string;
  status: string | null;
  loan: number | null;
  loanChangePrev: number | null;
  stockLent: number | null;
  stockLentChangePrev: number | null;
  ratio: number | null;
  rotationDays: number | null;
}

/**
 * 信用残・証金残・逆日歩の総合表示パネル。
 * Snapshot Context から取得 (複数 panel での同時ログイン衝突を避ける)。
 */
export default function MarginPanel({ ticker }: { ticker: string }) {
  void ticker;
  const snapshot = useTachibanaSnapshot();
  const loading = snapshot.loading;
  const error = snapshot.error;
  // SnapshotMargin → 旧 MarginResponse 形式へ変換
  const d = snapshot.margin as ({ margin: MarginData | null; hibu: HibuData | null; syoukin: SyoukinData | null } | null);

  if (loading) {
    return (
      <div className="p-4 rounded text-xs text-[var(--color-text-secondary)] text-center" style={{ background: "var(--bg-card)", border: "1px solid var(--color-border)", ...MONO }}>
        信用残情報を取得中...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 rounded text-xs text-red-400 text-center" style={{ background: "var(--bg-card)", border: "1px solid var(--color-border)", ...MONO }}>
        ⚠ {error}
      </div>
    );
  }

  if (!d) return null;

  const m = d.margin;
  const h = d.hibu;
  const s = d.syoukin;

  // 判定ロジック
  const interpretations: { color: string; text: string }[] = [];
  if (m?.ratioTotal !== null && m?.ratioTotal !== undefined) {
    if (m.ratioTotal < 1) {
      interpretations.push({ color: "#ef4444", text: "🔥 売残>買残 (踏み上げ候補)" });
    } else if (m.ratioTotal < 3) {
      interpretations.push({ color: "#f97316", text: "⚠ やや売り偏重" });
    } else if (m.ratioTotal > 20) {
      interpretations.push({ color: "#fbbf24", text: "💰 買い偏重 (利食い圧力)" });
    } else {
      interpretations.push({ color: "#22c55e", text: "✓ バランスよし" });
    }
  }
  if (h?.rate !== null && h?.rate !== undefined && h.rate > 0) {
    interpretations.push({ color: "#ef4444", text: `🔥 逆日歩発生 ¥${h.rate}/株/日` });
  }
  if (s?.ratio !== null && s?.ratio !== undefined && s.ratio > 0 && s.ratio < 3) {
    interpretations.push({ color: "#ef4444", text: "⚠ 貸借倍率 < 3 (株不足の兆候)" });
  }
  // 売残急増
  if (m?.shortChangeTotal && m?.shortTotal && m.shortChangeTotal / Math.max(m.shortTotal, 1) > 0.2) {
    interpretations.push({ color: "#f97316", text: "📈 売残が前週比+20%以上で急増" });
  }
  // 買残急減
  if (m?.longChangeTotal && m?.longTotal && m.longChangeTotal / Math.max(m.longTotal, 1) < -0.1) {
    interpretations.push({ color: "#fbbf24", text: "📉 買残が前週比10%以上で減少 (利食い?)" });
  }

  return (
    <div className="p-4 rounded space-y-3" style={{ background: "var(--bg-card)", border: "1px solid var(--color-border)" }}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-medium text-[var(--color-accent)]" style={MONO}>
          🏦 信用残・需給情報
        </h3>
        <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
          信用残: {m?.date ?? "?"} / 証金: {s?.date ?? "?"} {s?.status === "1" ? "(速報)" : s?.status === "2" ? "(確報)" : ""}
        </span>
      </div>

      {/* 解釈タグ */}
      {interpretations.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {interpretations.map((i, idx) => (
            <span
              key={idx}
              className="text-[10px] px-2 py-1"
              style={{
                background: `${i.color}15`,
                color: i.color,
                border: `1px solid ${i.color}40`,
                ...MONO,
              }}
            >
              {i.text}
            </span>
          ))}
        </div>
      )}

      {/* 信用残メイン */}
      {m && (
        <div className="space-y-2">
          <div className="text-[10px] text-[var(--color-text-secondary)] uppercase" style={MONO}>
            信用残 (一般+制度の合計)
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs" style={MONO}>
            <div>
              <div className="text-[9px] text-[var(--color-text-secondary)]">買残</div>
              <div className="text-[#22c55e]">{m.longTotal?.toLocaleString()}株</div>
              {m.longChangeTotal !== null && (
                <div className="text-[9px]" style={{ color: m.longChangeTotal >= 0 ? "#22c55e" : "#9ca3af" }}>
                  前週比: {m.longChangeTotal >= 0 ? "+" : ""}{m.longChangeTotal?.toLocaleString()}
                </div>
              )}
            </div>
            <div>
              <div className="text-[9px] text-[var(--color-text-secondary)]">売残</div>
              <div className="text-[#ef4444]">{m.shortTotal?.toLocaleString()}株</div>
              {m.shortChangeTotal !== null && (
                <div className="text-[9px]" style={{ color: m.shortChangeTotal >= 0 ? "#ef4444" : "#9ca3af" }}>
                  前週比: {m.shortChangeTotal >= 0 ? "+" : ""}{m.shortChangeTotal?.toLocaleString()}
                </div>
              )}
            </div>
            <div>
              <div className="text-[9px] text-[var(--color-text-secondary)]">信用倍率</div>
              <div
                className="text-base font-bold"
                style={{
                  color: !m.ratioTotal ? "var(--color-text)" :
                    m.ratioTotal < 1 ? "#ef4444" :
                    m.ratioTotal < 3 ? "#f97316" :
                    m.ratioTotal > 20 ? "#fbbf24" : "#22c55e",
                }}
              >
                {m.ratioTotal?.toFixed(2)}倍
              </div>
            </div>
          </div>

          {/* 比率 (数字大表示、補助バーは薄く) */}
          {m.longTotal !== null && m.shortTotal !== null && (m.longTotal + m.shortTotal) > 0 && (() => {
            const total = (m.longTotal ?? 0) + (m.shortTotal ?? 0);
            const longPct = ((m.longTotal ?? 0) / total) * 100;
            return (
              <div>
                <div className="flex justify-between items-baseline" style={MONO}>
                  <span className="text-2xl font-black text-[#22c55e]">買 {longPct.toFixed(0)}%</span>
                  <span className="text-2xl font-black text-[#ef4444]">売 {(100 - longPct).toFixed(0)}%</span>
                </div>
                <div className="h-1 rounded-full overflow-hidden flex mt-2 opacity-50" style={{ background: "rgba(255,255,255,0.05)" }}>
                  <div style={{ width: `${longPct}%`, background: "#22c55e" }} />
                  <div style={{ width: `${100 - longPct}%`, background: "#ef4444" }} />
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* 証金残 */}
      {s && (
        <div className="space-y-2 pt-2 border-t border-[var(--color-border)]">
          <div className="text-[10px] text-[var(--color-text-secondary)] uppercase" style={MONO}>
            証金残 (証券金融会社)
          </div>
          <div className="grid grid-cols-4 gap-2 text-[10px]" style={MONO}>
            <div>
              <div className="text-[9px] text-[var(--color-text-secondary)]">融資残</div>
              <div className="text-[#22c55e]">{s.loan?.toLocaleString()}</div>
              {s.loanChangePrev !== null && (
                <div className="text-[8px]" style={{ color: s.loanChangePrev >= 0 ? "#22c55e" : "#9ca3af" }}>
                  {s.loanChangePrev >= 0 ? "+" : ""}{s.loanChangePrev?.toLocaleString()}
                </div>
              )}
            </div>
            <div>
              <div className="text-[9px] text-[var(--color-text-secondary)]">貸株残</div>
              <div className="text-[#ef4444]">{s.stockLent?.toLocaleString()}</div>
              {s.stockLentChangePrev !== null && (
                <div className="text-[8px]" style={{ color: s.stockLentChangePrev >= 0 ? "#ef4444" : "#9ca3af" }}>
                  {s.stockLentChangePrev >= 0 ? "+" : ""}{s.stockLentChangePrev?.toLocaleString()}
                </div>
              )}
            </div>
            <div>
              <div className="text-[9px] text-[var(--color-text-secondary)]">貸借倍率</div>
              <div style={{
                color: !s.ratio ? "var(--color-text)" :
                  s.ratio < 1 ? "#ef4444" : s.ratio < 3 ? "#f97316" : "var(--color-text)",
              }}>
                {s.ratio?.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-[9px] text-[var(--color-text-secondary)]">回転日数</div>
              <div>{s.rotationDays?.toFixed(1)}日</div>
            </div>
          </div>
        </div>
      )}

      {/* 逆日歩 */}
      <div className="pt-2 border-t border-[var(--color-border)] flex items-center justify-between text-[11px]" style={MONO}>
        <span className="text-[var(--color-text-secondary)]">逆日歩</span>
        <span style={{ color: (h?.rate ?? 0) > 0 ? "#ef4444" : "var(--color-text-secondary)" }}>
          {h?.rate === null || h?.rate === undefined ? "なし" : `¥${h.rate}/株/日`}
        </span>
      </div>
    </div>
  );
}
