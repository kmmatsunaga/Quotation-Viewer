"use client";

/**
 * 暴落警報のグローバルコンテキスト。
 * users/{uid}/alerts/crash_current を1箇所で購読し、アプリ全体に配る。
 * ここでの alert は「鮮度内 (8h) かつ level != none」のものだけ。
 * 消費者: トップページの大バナー / 全ページ帯 / 銘柄ページゲート / 約定割り込み。
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import type { CrashLevel, CrashSignal } from "@/lib/crash-sentinel";

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

interface CrashAlertState {
  /** 鮮度内かつ level != none の警報。無ければ null */
  alert: CrashAlertDoc | null;
  active: boolean;
  affectedTickers: string[];
}

const Ctx = createContext<CrashAlertState>({ alert: null, active: false, affectedTickers: [] });

export function CrashAlertProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [raw, setRaw] = useState<CrashAlertDoc | null>(null);
  const [, setTick] = useState(0); // 鮮度の定期再評価 (警報が古くなったら自然に消えるように)

  useEffect(() => {
    if (!user) {
      setRaw(null);
      return;
    }
    const ref = doc(db, "users", user.uid, "alerts", "crash_current");
    const unsub = onSnapshot(
      ref,
      (snap) => setRaw(snap.exists() ? (snap.data() as CrashAlertDoc) : null),
      () => setRaw(null)
    );
    return () => unsub();
  }, [user]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  let alert: CrashAlertDoc | null = null;
  if (raw && raw.level !== "none" && raw.updatedAt) {
    const age = Date.now() - new Date(raw.updatedAt).getTime();
    if (age >= 0 && age <= STALE_HOURS * 3600 * 1000) alert = raw;
  }

  return (
    <Ctx.Provider value={{ alert, active: alert != null, affectedTickers: alert?.affectedTickers ?? [] }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCrashAlert(): CrashAlertState {
  return useContext(Ctx);
}
