"use client";

/**
 * 🏔 ネットキャッシュ比率スクリーナー — 清原達郎『わが投資術』の中核指標
 *
 * meta/net_cash_screener (週次 cron 更新) を読むだけの軽いページ。
 * 「割安の測定」であり「上がる予測」ではない、を UI でも誠実に言う。
 */

import { Fragment, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { netCashTier, NET_CASH_TIER_META } from "@/lib/net-cash";
import NetCashStory from "@/components/NetCashStory";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface Entry {
  ticker: string;
  name: string;
  ncRatio: number | null;
  realPer: number | null;
  marketCapOku: number;
  ncOku: number;
  netIncomeOku: number | null;
  asOfDate: string | null;
}

interface ScreenerDoc {
  date: string;
  entries: Entry[];
  count: number;
  universe: number;
}

export default function NetCashPage() {
  const router = useRouter();
  const [data, setData] = useState<ScreenerDoc | null>(null);
  const [loading, setLoading] = useState(true);
  // 取得失敗を「0件」と混同しないための状態 (無言の空表示は最悪のバグ)
  const [fetchError, setFetchError] = useState<string | null>(null);
  // フィルタ: 小さすぎる会社と赤字は初期状態では隠す (清原も流動性と事業の質は別途見る)
  const [minCap, setMinCap] = useState<number>(30);
  const [profitOnly, setProfitOnly] = useState(true);
  const [showGuide, setShowGuide] = useState(false);
  const [openTicker, setOpenTicker] = useState<string | null>(null); // 行クリックで読み解きを展開

  useEffect(() => {
    // meta はクライアントから直接読めない (ルールが users/ 配下のみ) → API経由
    fetch("/api/meta/net_cash_screener")
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error(`API ${r.status}${j?.error ? `: ${j.error}` : ""}`);
        if (!j?.ok) throw new Error(j?.error ?? "APIがエラーを返しました");
        if (!j.data) throw new Error("スクリーナーのデータがまだ作られていません (週次cron未実行)");
        setData(j.data as ScreenerDoc);
      })
      .catch((e) => {
        console.error("[net-cash] スクリーナー取得失敗:", e);
        setFetchError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    return data.entries.filter((e) => {
      if (e.marketCapOku < minCap) return false;
      if (profitOnly && (e.netIncomeOku == null || e.netIncomeOku <= 0)) return false;
      return true;
    });
  }, [data, minCap, profitOnly]);

  // 決算データの鮮度: 15か月以上前の BS は警告
  const staleCut = useMemo(() => {
    const d = new Date(Date.now() - 15 * 30 * 86400 * 1000);
    return d.toISOString().slice(0, 10);
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h1 className="text-lg font-bold" style={MONO}>🏔 ネットキャッシュ比率スクリーナー</h1>
        {data && (
          <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
            {data.date} 更新 · 全{data.universe}銘柄中 NC比率0.25以上 {data.count}銘柄
          </span>
        )}
      </div>

      {/* 解説 (初心者前提 + 用語) */}
      <div
        className="rounded-lg px-4 py-3 text-[12px] leading-relaxed text-[var(--color-text-secondary)] cursor-pointer"
        style={{ background: "var(--bg-card)", border: "1px solid rgba(0,240,255,0.08)" }}
        onClick={() => setShowGuide((v) => !v)}
      >
        <b className="text-[var(--color-text)]">「会社の値段」から「持っている現金」を引いて、事業の素の値段を見る指標。</b>
        {" "}清原達郎『わが投資術』の中核。{showGuide ? "▲" : "▼ クリックで解説"}
        {showGuide && (
          <div className="mt-2 space-y-1.5">
            <div>📐 <b>ネットキャッシュ</b> = 流動資産 + 投資有価証券×70% − 負債(全部)。「会社をたたんだら手元に残る現金」のざっくり見積り。有価証券を70%掛けするのは売却時の税金・値下がりを見込むため。</div>
            <div>📐 <b>NC比率</b> = ネットキャッシュ ÷ 時価総額。<b>1以上 = 会社を丸ごと買収してもお釣りが来る</b>水準 (株価がタダ以下)。現在の日本市場には約{data ? data.entries.filter((e) => (e.ncRatio ?? 0) >= 1).length : "—"}銘柄ある。</div>
            <div>📐 <b>実質PER</b> = (時価総額 − ネットキャッシュ) ÷ 純利益。見た目のPERが15倍でも、時価総額の半分がキャッシュなら事業は実質7.5倍で買える、という考え方。</div>
            <div className="pt-1" style={{ color: "#facc15" }}>
              ⚠ <b>これは「割安の測定」であって「上がる予測」ではない。</b>安いまま放置される株 (バリュートラップ) が大半で、清原自身も「なぜ安いのか、まず疑え」と言う。動くには何かの変化 (カタリスト) が要る。このリストは狩り場の地図であり、買い推奨リストではない。
            </div>
          </div>
        )}
      </div>

      {/* フィルタ */}
      <div className="flex items-center gap-3 flex-wrap text-[11px]" style={MONO}>
        <label className="flex items-center gap-1.5">
          <span className="text-[var(--color-text-secondary)]">時価総額</span>
          <select
            value={minCap}
            onChange={(e) => setMinCap(Number(e.target.value))}
            className="bg-[var(--bg-card)] border border-[var(--color-border)] rounded px-1.5 py-1"
          >
            <option value={0}>指定なし</option>
            <option value={30}>30億円以上</option>
            <option value={100}>100億円以上</option>
            <option value={300}>300億円以上</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={profitOnly} onChange={(e) => setProfitOnly(e.target.checked)} />
          <span className="text-[var(--color-text-secondary)]">黒字のみ (実質PERが計算できる)</span>
        </label>
        <span className="text-[var(--color-text-secondary)]">→ {rows.length}銘柄</span>
      </div>

      {/* テーブル */}
      {loading ? (
        <div className="text-sm text-[var(--color-text-secondary)]">読み込み中…</div>
      ) : fetchError ? (
        // 「データが0件」と「取得に失敗」を区別して出す (前者はフィルタ、後者は不具合)
        <div
          className="rounded-lg px-4 py-3 text-[12px] leading-relaxed"
          style={{ background: "rgba(239,68,68,0.10)", border: "1px solid #ef4444" }}
        >
          <div className="font-bold" style={{ color: "#ef4444" }}>⚠ データの取得に失敗しました (0件ではありません)</div>
          <div className="mt-1 text-[var(--color-text-secondary)]" style={MONO}>{fetchError}</div>
          <button
            onClick={() => location.reload()}
            className="mt-2 text-[11px] px-2.5 py-1 rounded"
            style={{ color: "#ef4444", border: "1px solid #ef4444", ...MONO }}
          >
            再読み込み
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-[var(--color-text-secondary)]">
          {data
            ? `フィルタ条件に合う銘柄がありません (全${data.count}銘柄中0件)。時価総額や黒字条件をゆるめてください`
            : "スクリーナーのデータがありません (週次cron未実行の可能性)"}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg" style={{ border: "1px solid var(--color-border)" }}>
          <table className="w-full text-[12px]" style={MONO}>
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-[var(--color-text-secondary)]" style={{ background: "rgba(0,240,255,0.04)" }}>
                <th className="text-left px-3 py-2">銘柄</th>
                <th className="text-right px-3 py-2">NC比率</th>
                <th className="text-right px-3 py-2">実質PER</th>
                <th className="text-right px-3 py-2">時価総額</th>
                <th className="text-right px-3 py-2">ネットキャッシュ</th>
                <th className="text-right px-3 py-2">純利益</th>
                <th className="text-right px-3 py-2">決算基準</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((e) => {
                const tier = netCashTier(e.ncRatio);
                const meta = tier ? NET_CASH_TIER_META[tier] : null;
                const suspicious = (e.ncRatio ?? 0) >= 3;
                const stale = e.asOfDate != null && e.asOfDate < staleCut;
                const isOpen = openTicker === e.ticker;
                return (
                  <Fragment key={e.ticker}>
                  <tr
                    className="cursor-pointer hover:bg-white/[0.03] border-t border-white/5"
                    onClick={() => setOpenTicker(isOpen ? null : e.ticker)}
                  >
                    <td className="px-3 py-2">
                      <span className="text-[9px] mr-1.5 text-[var(--color-accent)]">{isOpen ? "▼" : "▶"}</span>
                      <span className="text-[var(--color-text)]">{e.name}</span>
                      <span className="ml-1.5 text-[10px] text-[var(--color-text-secondary)]">{e.ticker}</span>
                      {suspicious && (
                        <span className="ml-1.5 text-[10px]" style={{ color: "#facc15" }} title="NC比率3以上は時価総額かBSの取得ミスの可能性が高い。原典 (決算短信) で確認を">
                          ⚠データ疑義
                        </span>
                      )}
                      {stale && (
                        <span className="ml-1.5 text-[10px]" style={{ color: "#94a3b8" }} title="決算データが15か月以上前">
                          ⏳古い
                        </span>
                      )}
                    </td>
                    <td className="text-right px-3 py-2 font-bold" style={{ color: meta?.color ?? "inherit" }}>
                      {meta && <span className="mr-1">{meta.emoji}</span>}
                      {e.ncRatio?.toFixed(2) ?? "—"}
                    </td>
                    <td className="text-right px-3 py-2">
                      {e.realPer == null ? "—" : e.realPer < 0 ? (
                        <span style={{ color: "#22c55e" }} title="時価総額がネットキャッシュより小さい = 事業をマイナスの値段で買える状態">
                          {e.realPer.toFixed(1)}
                        </span>
                      ) : (
                        `${e.realPer.toFixed(1)}倍`
                      )}
                    </td>
                    <td className="text-right px-3 py-2">{e.marketCapOku.toLocaleString("ja-JP")}億</td>
                    <td className="text-right px-3 py-2">{e.ncOku.toLocaleString("ja-JP")}億</td>
                    <td className="text-right px-3 py-2">{e.netIncomeOku != null ? `${e.netIncomeOku.toLocaleString("ja-JP")}億` : "—"}</td>
                    <td className="text-right px-3 py-2 text-[10px] text-[var(--color-text-secondary)]">{e.asOfDate ?? "—"}</td>
                  </tr>
                  {isOpen && (
                    <tr className="border-t border-white/5">
                      <td colSpan={7} className="p-0" style={{ background: "rgba(0,240,255,0.02)" }}>
                        <NetCashStory ticker={e.ticker} />
                        <div className="px-4 pb-3">
                          <button
                            onClick={() => router.push(`/stock/${e.ticker}`)}
                            className="text-[11px] px-2.5 py-1 rounded"
                            style={{ color: "var(--color-accent)", border: "1px solid var(--color-accent)", ...MONO }}
                          >
                            銘柄ページで詳しく見る →
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {rows.length > 200 && (
            <div className="px-3 py-2 text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
              上位200件を表示 (全{rows.length}件)。フィルタで絞り込んでください
            </div>
          )}
        </div>
      )}

      {/* 段階の凡例 */}
      <div className="flex flex-wrap gap-3 text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
        {(["fortress", "deep", "cheap"] as const).map((t) => {
          const m = NET_CASH_TIER_META[t];
          return (
            <span key={t} title={m.note}>
              <span style={{ color: m.color }}>{m.emoji} {m.label}</span>
              {t === "fortress" ? " (NC比率1以上)" : t === "deep" ? " (0.5以上)" : " (0.25以上)"}
            </span>
          );
        })}
      </div>
    </div>
  );
}
