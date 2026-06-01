"use client";

import Link from "next/link";

interface NavItem {
  href: string;
  label: string;
  shortLabel: string;
  icon: string;
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
  star: (active) => (
    <svg className="w-6 h-6" fill={active ? "var(--color-accent)" : "none"} stroke={active ? "var(--color-accent)" : "currentColor"} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
    </svg>
  ),
  search: (active) => (
    <svg className="w-6 h-6" fill="none" stroke={active ? "var(--color-accent)" : "currentColor"} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  ),
  wallet: (active) => (
    <svg className="w-6 h-6" fill="none" stroke={active ? "var(--color-accent)" : "currentColor"} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
    </svg>
  ),
  grid: (active) => (
    <svg className="w-6 h-6" fill="none" stroke={active ? "var(--color-accent)" : "currentColor"} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
    </svg>
  ),
  filter: (active) => (
    <svg className="w-6 h-6" fill="none" stroke={active ? "var(--color-accent)" : "currentColor"} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
    </svg>
  ),
  clipboard: (active) => (
    <svg className="w-6 h-6" fill="none" stroke={active ? "var(--color-accent)" : "currentColor"} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  ),
  radio: (active) => (
    <svg className="w-6 h-6" fill="none" stroke={active ? "var(--color-accent)" : "currentColor"} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17l-5-5 5-5M9 17l-5-5 5-5M21 12h-9" />
    </svg>
  ),
  fire: (active) => (
    <svg className="w-6 h-6" fill={active ? "var(--color-accent)" : "none"} stroke={active ? "var(--color-accent)" : "currentColor"} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.24 17 7.346c1.367 3.158-.5 6.654-1 7.654-.18.36-.342.69-.486 1z" />
    </svg>
  ),
  newspaper: (active) => (
    <svg className="w-6 h-6" fill="none" stroke={active ? "var(--color-accent)" : "currentColor"} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
    </svg>
  ),
  calendar: (active) => (
    <svg className="w-6 h-6" fill="none" stroke={active ? "var(--color-accent)" : "currentColor"} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  ),
  bell: (active) => (
    <svg className="w-6 h-6" fill={active ? "var(--color-accent)" : "none"} stroke={active ? "var(--color-accent)" : "currentColor"} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
    </svg>
  ),
};

export function BottomNav({ navItems, currentPath }: BottomNavProps) {
  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-50 pb-safe backdrop-blur-md"
      style={{
        background: "linear-gradient(0deg, rgba(13,16,36,0.95) 0%, rgba(5,6,13,0.85) 100%)",
        borderTop: "1px solid var(--color-accent)",
        boxShadow: "0 -4px 24px rgba(0,240,255,0.18)",
      }}
    >
      <div
        className="flex items-center h-[var(--bottom-nav-height)] overflow-x-auto nav-scroll px-1"
        style={{ scrollSnapType: "x mandatory" }}
      >
        {navItems.map((item) => {
          const isActive = currentPath === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center justify-center min-w-[58px] shrink-0 min-h-[44px] gap-0.5 px-1.5 transition-colors-custom ${
                isActive
                  ? "text-[var(--color-accent)]"
                  : "text-[var(--color-text-secondary)]"
              }`}
              style={{ scrollSnapAlign: "start" }}
            >
              <span
                style={
                  isActive
                    ? { filter: "drop-shadow(0 0 6px rgba(0,240,255,0.7))" }
                    : undefined
                }
              >
                {icons[item.icon]?.(isActive)}
              </span>
              <span
                className="text-[9px] uppercase tracking-[0.1em]"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                {item.shortLabel}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
