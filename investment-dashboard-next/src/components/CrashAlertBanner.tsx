"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import type { CrashLevel, CrashSignal } from "@/lib/crash-sentinel";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

// 警報が古くなったら自動で消す (場中の警報が翌日まで残らないように)
const STALE_HOURS = 8;

export interface CrashAlertDoc {
  level: CrashLevel;
  headline: string;
  summary: string;
  advice: string;
  signals: CrashSignal[];
  affectedTickers: string[];
  signature: string;
  nikkeiChangePct: number | null;
  updatedAt: string; // ISO
}

/**
 * トップページ最上部の暴落緊急警報バナー。
 * Firestore users/{uid}/alerts/crash_current を購読し、level != none かつ
 * 直近 STALE_HOURS 以内・未 dismiss の時だけ表示する。
 */
export default function CrashAlertBanner() {
  const { user } = useAuth();
  const [alert, setAlert] = useState<CrashAlertDoc | null>(null);
  const [dismissedSig, setDismissedSig] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const ref = doc(db, "users", user.uid, "alerts", "crash_current");
    const unsub = onSnapshot(
      ref,
      (snap) => setAlert(snap.exists() ? (snap.data() as CrashAlertDoc) : null),
      () => setAlert(null)
    );
    // dismiss 状態は localStorage (端末ローカルで十分)
    try {
      setDismissedSig(localStorage.getItem("cavka_crash_dismissed") ?? null);
    } catch {}
    return () => unsub();
  }, [user]);

  if (!alert || alert.level === "none") return null;

  // 鮮度チェック
  const ageMs = Date.now() - new Date(alert.updatedAt).getTime();
  if (!(ageMs >= 0) || ageMs > STALE_HOURS * 3600 * 1000) return null;

  // dismiss 済み (同じ署名) は非表示。署名が変われば再表示。
  if (dismissedSig === alert.signature) return null;

  const dismiss = () => {
    setDismissedSig(alert.signature);
    try {
      localStorage.setItem("cavka_crash_dismissed", alert.signature);
    } catch {}
  };

  return <CrashBannerView alert={alert} onDismiss={dismiss} />;
}

/** バナーの表示部 (Firestore 非依存・プレビュー可能)。 */
export function CrashBannerView({ alert, onDismiss }: { alert: CrashAlertDoc; onDismiss?: () => void }) {
  const critical = alert.level === "critical";
  const accent = critical ? "#ef4444" : "#fbbf24";
  const bg = critical ? "rgba(239,68,68,0.12)" : "rgba(251,191,36,0.10)";

  // reactive(🔴) を先, predictive(🟡) を後
  const ordered = [...alert.signals].sort((a, b) => Number(b.reactive) - Number(a.reactive));

  return (
    <div
      className="relative rounded-lg overflow-hidden"
      style={{
        background: bg,
        border: `1.5px solid ${accent}`,
        boxShadow: critical ? `0 0 24px ${accent}44` : `0 0 14px ${accent}33`,
      }}
    >
      {/* 上部: 見出し + 閉じる */}
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
        <div className="min-w-0">
          <div
            className={`text-base font-black ${critical ? "animate-pulse" : ""}`}
            style={{ color: accent, ...MONO }}
          >
            {alert.headline}
          </div>
          <div className="text-[13px] text-[var(--color-text)] mt-1 leading-relaxed">{alert.summary}</div>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="shrink-0 text-[11px] px-2 py-1 rounded"
            style={{ color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", ...MONO }}
            aria-label="警報を閉じる"
          >
            ✕ 閉じる
          </button>
        )}
      </div>

      {/* シグナル一覧 */}
      <ul className="px-4 pb-2 space-y-1.5">
        {ordered.map((s, i) => (
          <li key={i} className="flex gap-2 text-[12px] leading-relaxed">
            <span className="shrink-0">{s.reactive ? "🔴" : "🟡"}</span>
            <span className="text-[var(--color-text)]">{s.text}</span>
          </li>
        ))}
      </ul>

      {/* 行動アドバイス */}
      {alert.advice && (
        <div
          className="mx-4 mb-3 px-3 py-2 rounded text-[12px] leading-relaxed"
          style={{ background: "rgba(0,0,0,0.25)", color: "var(--color-text)", borderLeft: `3px solid ${accent}` }}
        >
          💡 {alert.advice}
        </div>
      )}

      {/* フッタ */}
      <div
        className="flex items-center justify-between px-4 py-1.5 text-[10px]"
        style={{ background: "rgba(0,0,0,0.2)", color: "var(--color-text-secondary)", ...MONO }}
      >
        <span>
          🔴 今まさに / 🟡 予兆 · 日経 {alert.nikkeiChangePct != null ? `${alert.nikkeiChangePct >= 0 ? "+" : ""}${alert.nikkeiChangePct}%` : "—"}
        </span>
        <a href="/portfolio" className="underline" style={{ color: accent }}>
          ポートフォリオを見る →
        </a>
      </div>
    </div>
  );
}
