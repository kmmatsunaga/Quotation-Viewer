"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { Logo } from "./Logo";

interface NavItem {
  href: string;
  label: string;
  shortLabel: string;
  icon: string;
}

interface TopNavProps {
  navItems: NavItem[];
  currentPath: string;
}

export function TopNav({ navItems, currentPath }: TopNavProps) {
  const { user, signOut } = useAuth();
  const [time, setTime] = useState("");

  useEffect(() => {
    const update = () => {
      const now = new Date();
      setTime(
        now.toLocaleTimeString("ja-JP", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      );
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  const handleRefresh = () => {
    window.location.reload();
  };

  return (
    <nav
      className="hidden md:flex fixed top-0 left-0 right-0 z-50 h-[var(--nav-height)] items-center justify-between px-6 backdrop-blur-md"
      style={{
        background: "linear-gradient(180deg, rgba(13,16,36,0.92) 0%, rgba(5,6,13,0.85) 100%)",
        borderBottom: "1px solid var(--color-border)",
        boxShadow: "0 0 24px rgba(0,240,255,0.12), inset 0 -1px 0 rgba(0,240,255,0.4)",
      }}
    >
      {/* Brand */}
      <div className="flex items-center shrink-0">
        <Logo size={26} />
      </div>

      {/* Nav links — 改行禁止 + 横スクロール (ホイール→水平、スクロールバー薄表示) */}
      <div
        className="flex items-center gap-0.5 flex-1 mx-3 overflow-x-auto nav-scroll min-w-0"
        style={{ flexWrap: "nowrap" }}
        onWheel={(e) => {
          // 縦スクロールを横にリダイレクト (デスクトップでマウスホイールで横スクロール可能に)
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.currentTarget.scrollLeft += e.deltaY;
          }
        }}
      >
        {navItems.map((item) => {
          const isActive = currentPath === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className={`shrink-0 px-2 lg:px-3 py-2 text-xs lg:text-sm font-medium rounded-t transition-colors-custom relative ${
                isActive
                  ? "text-[var(--color-accent)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              }`}
              style={{ whiteSpace: "nowrap", wordBreak: "keep-all" }}
            >
              {/* 1536px(2xl)以上は label, 未満は shortLabel */}
              <span className="hidden 2xl:inline">{item.label}</span>
              <span className="inline 2xl:hidden">{item.shortLabel}</span>
              {isActive && (
                <span className="absolute bottom-0 left-1 right-1 h-0.5 bg-[var(--color-accent)] rounded-t" />
              )}
            </Link>
          );
        })}
      </div>

      {/* Time & Refresh */}
      <div className="flex items-center gap-3 shrink-0 text-sm text-[var(--color-text-secondary)]">
        <span className="font-mono">{time}</span>
        <button
          onClick={handleRefresh}
          className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-[var(--bg-card)] transition-colors-custom"
          aria-label="更新"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
        {/* ユーザーアイコン */}
        {user && (
          <div className="relative group">
            <button className="w-8 h-8 rounded-full overflow-hidden border-2 border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors">
              {user.photoURL ? (
                <img src={user.photoURL} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-[var(--color-accent)] flex items-center justify-center text-white text-xs font-bold">
                  {user.displayName?.[0] ?? "U"}
                </div>
              )}
            </button>
            <div className="absolute right-0 top-full mt-1 w-52 bg-[var(--bg-card)] border border-[var(--color-border)] rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50">
              <div className="px-3 py-2 border-b border-[var(--color-border)]">
                <p className="text-xs text-[var(--color-text)] truncate">{user.displayName}</p>
                <p className="text-xs text-[var(--color-text-secondary)] truncate">{user.email}</p>
              </div>
              <Link
                href="/mobile-link"
                className="block w-full px-3 py-2 text-left text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:bg-[var(--bg-card-hover)] transition-colors border-b border-[var(--color-border)]"
              >
                📱 iPhoneでログイン (QR)
              </Link>
              <button
                onClick={signOut}
                className="w-full px-3 py-2 text-left text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-up)] hover:bg-[var(--bg-card-hover)] transition-colors rounded-b-lg"
              >
                ログアウト
              </button>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
