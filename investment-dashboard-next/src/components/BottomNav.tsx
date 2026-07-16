"use client";

import Link from "next/link";
import { useState, useEffect } from "react";

interface NavItem {
  href: string;
  label: string;
  shortLabel: string;
  icon: string;
  group: string;
}

interface BottomNavProps {
  navItems: NavItem[];
  currentPath: string;
}

const icons: Record<string, (active: boolean) => React.ReactNode> = {
  chart: (active) => (
    <svg className="w-6 h-6" fill="none" stroke={active ? "var(--color-accent)" : "currentColor"} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
    </svg>
  ),
  radio: (active) => (
    <svg className="w-6 h-6" fill="none" stroke={active ? "var(--color-accent)" : "currentColor"} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17l-5-5 5-5M9 17l-5-5 5-5M21 12h-9" />
    </svg>
  ),
  clipboard: (active) => (
    <svg className="w-6 h-6" fill="none" stroke={active ? "var(--color-accent)" : "currentColor"} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  ),
  wallet: (active) => (
    <svg className="w-6 h-6" fill="none" stroke={active ? "var(--color-accent)" : "currentColor"} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
    </svg>
  ),
  menu: (active) => (
    <svg className="w-6 h-6" fill="none" stroke={active ? "var(--color-accent)" : "currentColor"} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  ),
};

// 下部の主要タブ (毎日の流れ: 今日 → 場中 → 記録 → 資産)。5列固定・横スクロールなし。
const PRIMARY: { href: string; label: string; icon: string }[] = [
  { href: "/briefing", label: "今日", icon: "chart" },
  { href: "/warroom", label: "場中", icon: "radio" },
  { href: "/journal", label: "記録", icon: "clipboard" },
  { href: "/portfolio", label: "資産", icon: "wallet" },
];

// ドロワーのグループ表示順 (デスクトップと同じ階層)
const GROUP_ORDER = ["", "⚔デイトレ", "🔬研究所", "📊資産"];
const GROUP_TITLE: Record<string, string> = {
  "": "ホーム",
  "⚔デイトレ": "⚔ デイトレ",
  "🔬研究所": "🔬 研究所",
  "📊資産": "📊 資産と記録",
};

export function BottomNav({ navItems, currentPath }: BottomNavProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  // ルート変更やドロワー閉時に body スクロールを戻す
  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [menuOpen]);

  // 主要タブ以外にいる時は「メニュー」をアクティブ表示
  const onPrimary = PRIMARY.some((p) => p.href === currentPath);

  // ドロワー用: group ごとに整理し、href 重複を除去
  const grouped = GROUP_ORDER.map((g) => ({
    group: g,
    items: navItems.filter((it) => it.group === g),
  })).filter((sec) => sec.items.length > 0);
  const seen = new Set<string>();

  return (
    <>
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 pb-safe backdrop-blur-md"
        style={{
          background: "linear-gradient(0deg, rgba(13,16,36,0.95) 0%, rgba(5,6,13,0.85) 100%)",
          borderTop: "1px solid var(--color-accent)",
          boxShadow: "0 -4px 24px rgba(0,240,255,0.18)",
        }}
      >
        <div className="grid grid-cols-5 h-[var(--bottom-nav-height)]">
          {PRIMARY.map((item) => {
            const isActive = currentPath === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex flex-col items-center justify-center min-h-[44px] gap-0.5 transition-colors-custom ${
                  isActive ? "text-[var(--color-accent)]" : "text-[var(--color-text-secondary)]"
                }`}
              >
                <span style={isActive ? { filter: "drop-shadow(0 0 6px rgba(0,240,255,0.7))" } : undefined}>
                  {icons[item.icon]?.(isActive)}
                </span>
                <span className="text-[10px] tracking-[0.05em]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  {item.label}
                </span>
              </Link>
            );
          })}
          {/* メニュー (ドロワー起動) */}
          <button
            onClick={() => setMenuOpen(true)}
            className={`flex flex-col items-center justify-center min-h-[44px] gap-0.5 transition-colors-custom ${
              !onPrimary ? "text-[var(--color-accent)]" : "text-[var(--color-text-secondary)]"
            }`}
          >
            <span style={!onPrimary ? { filter: "drop-shadow(0 0 6px rgba(0,240,255,0.7))" } : undefined}>
              {icons.menu(!onPrimary)}
            </span>
            <span className="text-[10px] tracking-[0.05em]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              メニュー
            </span>
          </button>
        </div>
      </nav>

      {/* フルメニュー ドロワー */}
      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-[60]" role="dialog" aria-modal="true">
          {/* 背景 */}
          <div
            className="absolute inset-0"
            style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(2px)" }}
            onClick={() => setMenuOpen(false)}
          />
          {/* シート */}
          <div
            className="absolute bottom-0 left-0 right-0 max-h-[82vh] overflow-y-auto rounded-t-2xl pb-safe"
            style={{
              background: "linear-gradient(180deg, rgba(13,16,36,0.98) 0%, rgba(5,6,13,0.98) 100%)",
              borderTop: "1px solid var(--color-accent)",
              boxShadow: "0 -8px 40px rgba(0,240,255,0.25)",
            }}
          >
            {/* ハンドル + ヘッダ */}
            <div className="sticky top-0 z-10 px-4 pt-3 pb-2" style={{ background: "rgba(8,10,22,0.96)", backdropFilter: "blur(8px)", borderBottom: "1px solid var(--color-border)" }}>
              <div className="mx-auto mb-2 h-1 w-10 rounded-full" style={{ background: "var(--color-border)" }} />
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-[var(--color-accent)]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  MENU
                </span>
                <button
                  onClick={() => setMenuOpen(false)}
                  className="text-[var(--color-text-secondary)] text-xl leading-none px-2 py-1 min-h-[36px]"
                  aria-label="閉じる"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="px-3 py-3 space-y-4">
              {grouped.map((sec) => (
                <div key={sec.group}>
                  <div className="px-1 pb-1.5 text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-secondary)]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    {GROUP_TITLE[sec.group] ?? sec.group}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {sec.items.map((item) => {
                      if (seen.has(item.href)) return null;
                      seen.add(item.href);
                      const isActive = currentPath === item.href;
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={() => setMenuOpen(false)}
                          className="flex items-center px-3 min-h-[48px] rounded-lg border text-sm transition-colors-custom"
                          style={{
                            borderColor: isActive ? "var(--color-accent)" : "var(--color-border)",
                            background: isActive ? "rgba(0,240,255,0.08)" : "var(--bg-card)",
                            color: isActive ? "var(--color-accent)" : "var(--color-text)",
                          }}
                        >
                          <span className="leading-tight">{item.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
