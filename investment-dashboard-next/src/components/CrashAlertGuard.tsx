"use client";

/**
 * 暴落警報の「明確に止める」3点セット。ClientLayout に常駐。
 *  ① GlobalCrashStrip — 警報発令中は全ページ下部に赤帯 (どのメニューにいても分かる)
 *  ② StockPageGate  — 警報対象の銘柄ページを開いた瞬間、チャートより先に画面中央へ危険モーダル
 *  ③ NewFillGate    — 新しい約定 (買い) が記録された瞬間、開いている画面に関係なく中央へ割り込み警報
 */

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { useCrashAlert, type CrashAlertDoc } from "@/lib/crash-alert-context";
import type { Trade } from "@/lib/firestore";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

export default function CrashAlertGuard() {
  return (
    <>
      <GlobalCrashStrip />
      <StockPageGate />
      <NewFillGate />
    </>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ① 全ページ帯: 警報発令中を常時表示 (トップは大バナーがあるので除外)
function GlobalCrashStrip() {
  const { alert, active } = useCrashAlert();
  const pathname = usePathname();
  const router = useRouter();

  if (!active || !alert || pathname === "/") return null;

  const critical = alert.level === "critical";
  const accent = critical ? "#ef4444" : "#fbbf24";

  return (
    <button
      onClick={() => router.push("/")}
      className="fixed left-0 right-0 z-[85] flex items-center justify-center gap-2 py-1.5 px-3 text-[12px] font-bold"
      style={{
        bottom: "calc(var(--bottom-nav-height, 0px) + env(safe-area-inset-bottom, 0px))",
        background: critical ? "rgba(127,10,20,0.96)" : "rgba(120,80,5,0.96)",
        color: "#fff",
        borderTop: `2px solid ${accent}`,
        boxShadow: `0 -4px 20px ${accent}55`,
        ...MONO,
      }}
    >
      <span className={critical ? "animate-pulse" : ""}>{critical ? "🚨" : "⚠"}</span>
      <span>
        {critical ? "暴落警報 発令中" : "下落警戒 発令中"} — サイン{alert.signals.length}件
        {alert.affectedTickers.length > 0 && ` (${alert.affectedTickers.join(", ")})`}
      </span>
      <span className="opacity-80">タップで詳細 →</span>
    </button>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 中央モーダルの共通ガワ (export はデモ/検証用)
export function CenterAlertModal({
  alert,
  title,
  subtitle,
  signals,
  onAck,
  ackLabel,
}: {
  alert: CrashAlertDoc;
  title: string;
  subtitle: string;
  signals: string[];
  onAck: () => void;
  ackLabel: string;
}) {
  const critical = alert.level === "critical";
  const accent = critical ? "#ef4444" : "#fbbf24";
  const router = useRouter();

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4"
      style={{ background: "rgba(3,5,15,0.85)", backdropFilter: "blur(4px)" }}
    >
      <div
        className="w-full max-w-md rounded-lg overflow-hidden"
        style={{
          background: "rgba(13,16,36,0.98)",
          border: `2px solid ${accent}`,
          boxShadow: `0 0 40px ${accent}66`,
        }}
      >
        <div className="px-5 pt-5 pb-3 text-center">
          <div className={`text-2xl font-black ${critical ? "animate-pulse" : ""}`} style={{ color: accent, ...MONO }}>
            {title}
          </div>
          <div className="text-[13px] text-[var(--color-text)] mt-2 leading-relaxed">{subtitle}</div>
        </div>

        <ul className="px-5 pb-3 space-y-1.5">
          {signals.slice(0, 4).map((t, i) => (
            <li key={i} className="flex gap-2 text-[12px] leading-relaxed text-[var(--color-text)]">
              <span className="shrink-0" style={{ color: accent }}>▸</span>
              <span>{t}</span>
            </li>
          ))}
        </ul>

        {alert.advice && (
          <div
            className="mx-5 mb-4 px-3 py-2 rounded text-[11.5px] leading-relaxed"
            style={{ background: "rgba(0,0,0,0.35)", color: "var(--color-text)", borderLeft: `3px solid ${accent}` }}
          >
            💡 {alert.advice}
          </div>
        )}

        <div className="flex gap-2 px-5 pb-5">
          <button
            onClick={onAck}
            className="flex-1 py-2.5 text-[13px] font-bold rounded"
            style={{ border: `1px solid ${accent}`, color: accent, background: `${accent}15`, ...MONO }}
          >
            {ackLabel}
          </button>
          <button
            onClick={() => router.push("/portfolio")}
            className="px-4 py-2.5 text-[13px] rounded text-[var(--color-text-secondary)]"
            style={{ border: "1px solid var(--color-border)", ...MONO }}
          >
            🛡 資産を確認
          </button>
        </div>
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ② 銘柄ページゲート: 警報対象銘柄を開いたら、内容より先に中央警告
function StockPageGate() {
  const { alert, active, affectedTickers } = useCrashAlert();
  const pathname = usePathname();
  const [acked, setAcked] = useState<string | null>(null);

  const m = pathname.match(/^\/stock\/([^/]+)/);
  const ticker = m ? decodeURIComponent(m[1]) : null;

  if (!active || !alert || !ticker || !affectedTickers.includes(ticker)) return null;

  // ページを開き直すたびに再表示 (同一表示中の再レンダーでは出しっぱなしにしない)
  const gateKey = `${pathname}|${alert.signature}`;
  if (acked === gateKey) return null;

  const relevant = alert.signals
    .filter((s) => s.ticker === ticker || s.scope === "market" || s.scope === "portfolio")
    .map((s) => s.text);

  return (
    <CenterAlertModal
      alert={alert}
      title="🚨 この銘柄に暴落警報"
      subtitle={`${ticker} は現在、暴落警報の対象銘柄です。チャートを見る前に状況を確認してください。`}
      signals={relevant}
      onAck={() => setAcked(gateKey)}
      ackLabel="⚠ 理解した — 表示する"
    />
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ③ 約定割り込み: 新しい買い約定が記録された瞬間、警報対象なら画面中央に割り込む
function NewFillGate() {
  const { user } = useAuth();
  const { alert, active, affectedTickers } = useCrashAlert();
  const [fill, setFill] = useState<{ ticker: string; name: string; qty: number; price: number } | null>(null);
  const firstSnapRef = useRef(true);
  const seenRef = useRef(new Set<string>());

  useEffect(() => {
    if (!user) return;
    firstSnapRef.current = true;
    const q = query(collection(db, "users", user.uid, "trades"), orderBy("entryAt", "desc"), limit(10));
    const unsub = onSnapshot(q, (snap) => {
      if (firstSnapRef.current) {
        // 初回スナップショットは既存分 — 記憶だけして鳴らさない
        firstSnapRef.current = false;
        snap.docs.forEach((d) => seenRef.current.add(d.id));
        return;
      }
      for (const ch of snap.docChanges()) {
        if (ch.type !== "added" || seenRef.current.has(ch.doc.id)) continue;
        seenRef.current.add(ch.doc.id);
        const t = ch.doc.data() as Trade;
        if (t.side !== "long" || t.status !== "open") continue; // 新規の買いだけ対象
        setFill({ ticker: t.ticker, name: t.name || t.ticker, qty: t.qty, price: t.entryPrice });
      }
    });
    return () => unsub();
  }, [user]);

  if (!fill || !active || !alert || !affectedTickers.includes(fill.ticker)) return null;

  const relevant = alert.signals
    .filter((s) => s.ticker === fill.ticker || s.scope === "market" || s.scope === "portfolio")
    .map((s) => s.text);

  return (
    <CenterAlertModal
      alert={alert}
      title="🚨 いま買った銘柄に警報"
      subtitle={`いましがた約定した ${fill.name}(${fill.ticker}) ${fill.qty}株 @¥${fill.price.toLocaleString()} は、暴落警報の対象銘柄です。`}
      signals={relevant}
      onAck={() => setFill(null)}
      ackLabel="⚠ 確認した"
    />
  );
}
