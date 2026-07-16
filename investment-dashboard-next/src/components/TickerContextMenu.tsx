"use client";

/**
 * 銘柄コンテキストメニュー — 右クリック / 長押し で Cavka 専用アクションを出す。
 *
 * 使い方: どのページでも `data-ticker="7203"` 属性を要素に付けるだけ。
 * このプロバイダを ClientLayout に置いておけば、全ページの data-ticker 要素で発火する。
 * ブラウザ標準の右クリックメニューは data-ticker 要素上では抑止する。
 *
 * 拡張前提: ACTIONS 配列に1行足すだけで機能追加できる。
 * スマホは長押し (500ms) で同じメニュー。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { NIKKEI225 } from "@/lib/nikkei225";
import { STOCK_LIST } from "@/lib/stock-list";

const NAME_MAP = new Map<string, string>([
  ...NIKKEI225.map((s) => [s.ticker, s.name] as const),
  ...STOCK_LIST.map((s) => [s.ticker, s.name] as const),
]);

const LS_WARROOM_WATCHLIST = "cavka_warroom_watchlist";
const LS_WARROOM_PINNED = "cavka_warroom_pinned";

interface MenuAction {
  key: string;
  label: (ticker: string) => string;
  run: (ticker: string, ctx: { router: ReturnType<typeof useRouter> }) => void;
  toast?: (ticker: string) => string;
}

// ── アクション定義 (ここに1行足すだけで機能追加) ──
const ACTIONS: MenuAction[] = [
  {
    key: "warroom",
    label: () => "⚔ ウォールームへ送る",
    toast: (t) => `${NAME_MAP.get(t) ?? t} をウォールームへ`,
    run: (t) => {
      try {
        const saved: string[] = JSON.parse(localStorage.getItem(LS_WARROOM_WATCHLIST) ?? "[]");
        if (!saved.includes(t)) localStorage.setItem(LS_WARROOM_WATCHLIST, JSON.stringify([...saved, t]));
      } catch {}
    },
  },
  {
    key: "warroom-pin",
    label: () => "📌 ウォールームに固定",
    toast: (t) => `${NAME_MAP.get(t) ?? t} を固定 (翌日も残る)`,
    run: (t) => {
      try {
        const w: string[] = JSON.parse(localStorage.getItem(LS_WARROOM_WATCHLIST) ?? "[]");
        if (!w.includes(t)) localStorage.setItem(LS_WARROOM_WATCHLIST, JSON.stringify([...w, t]));
        const p: string[] = JSON.parse(localStorage.getItem(LS_WARROOM_PINNED) ?? "[]");
        if (!p.includes(t)) localStorage.setItem(LS_WARROOM_PINNED, JSON.stringify([...p, t]));
      } catch {}
    },
  },
  {
    key: "detail",
    label: () => "🔍 銘柄ページを開く",
    run: (t, { router }) => router.push(`/stock/${t}`),
  },
  {
    key: "buyplan",
    label: () => "🧭 買い方を設計",
    run: (t, { router }) => router.push(`/buyplan?ticker=${t}`),
  },
];

export default function TickerContextMenu() {
  const router = useRouter();
  const [menu, setMenu] = useState<{ x: number; y: number; ticker: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // data-ticker 要素を探す
  const findTicker = (el: EventTarget | null): string | null => {
    let node = el as HTMLElement | null;
    while (node && node !== document.body) {
      const t = node.dataset?.ticker;
      if (t && /^\d{3,4}[A-Z0-9]?$/.test(t)) return t;
      node = node.parentElement;
    }
    return null;
  };

  const openMenu = useCallback((x: number, y: number, ticker: string) => {
    // 画面端で切れないよう調整 (メニュー幅~220 高さ~200)
    const vw = window.innerWidth, vh = window.innerHeight;
    setMenu({ x: Math.min(x, vw - 230), y: Math.min(y, vh - 210), ticker });
  }, []);

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      const t = findTicker(e.target);
      if (!t) return; // 銘柄要素以外は標準メニューのまま
      e.preventDefault();
      openMenu(e.clientX, e.clientY, t);
    };
    const onTouchStart = (e: TouchEvent) => {
      const t = findTicker(e.target);
      if (!t) return;
      const touch = e.touches[0];
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };
      longPressRef.current = setTimeout(() => {
        // 長押し成立 → メニュー (スクロール中は touchmove でキャンセル済み)
        if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
        openMenu(touch.clientX, touch.clientY, t);
      }, 500);
    };
    const cancelLong = () => { if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; } };
    const onTouchMove = (e: TouchEvent) => {
      // 少しでも動いたらスクロール扱いで長押しキャンセル
      const s = touchStartRef.current;
      if (s && e.touches[0]) {
        const dx = Math.abs(e.touches[0].clientX - s.x), dy = Math.abs(e.touches[0].clientY - s.y);
        if (dx > 8 || dy > 8) cancelLong();
      }
    };
    document.addEventListener("contextmenu", onContext);
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", cancelLong);
    document.addEventListener("touchcancel", cancelLong);
    return () => {
      document.removeEventListener("contextmenu", onContext);
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", cancelLong);
      document.removeEventListener("touchcancel", cancelLong);
    };
  }, [openMenu]);

  const close = () => setMenu(null);
  const runAction = (a: MenuAction) => {
    if (!menu) return;
    a.run(menu.ticker, { router });
    if (a.toast) { setToast(a.toast(menu.ticker)); setTimeout(() => setToast(null), 1800); }
    close();
  };

  return (
    <>
      {menu && (
        <>
          <div className="fixed inset-0 z-[90]" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
          <div
            className="fixed z-[91] min-w-[210px] py-1 rounded-lg overflow-hidden"
            style={{ left: menu.x, top: menu.y, background: "rgba(13,16,36,0.98)", border: "1px solid var(--color-accent)", boxShadow: "0 8px 32px rgba(0,0,0,0.6)", backdropFilter: "blur(8px)" }}
          >
            <div className="px-3 py-1.5 text-[11px] border-b" style={{ borderColor: "var(--color-border)", color: "var(--color-accent)", fontFamily: "'JetBrains Mono', monospace" }}>
              {menu.ticker} {NAME_MAP.get(menu.ticker) ?? ""}
            </div>
            {ACTIONS.map((a) => (
              <button
                key={a.key}
                onClick={() => runAction(a)}
                className="w-full text-left px-3 py-2.5 text-[13px] text-[var(--color-text)] hover:bg-[rgba(0,240,255,0.08)] transition-colors"
              >
                {a.label(menu.ticker)}
              </button>
            ))}
          </div>
        </>
      )}
      {toast && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-[95] px-4 py-2 rounded-full text-[13px] font-bold pointer-events-none"
          style={{ bottom: "calc(var(--bottom-nav-height) + env(safe-area-inset-bottom,0px) + 76px)", background: "rgba(74,222,128,0.95)", color: "#052", boxShadow: "0 4px 20px rgba(0,0,0,0.4)" }}
        >
          ✓ {toast}
        </div>
      )}
    </>
  );
}
