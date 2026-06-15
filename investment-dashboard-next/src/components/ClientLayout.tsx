"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { TopNav } from "@/components/TopNav";
import { BottomNav } from "@/components/BottomNav";

const navItems = [
  { href: "/", label: "マーケット概況", shortLabel: "概況", icon: "chart" },
  { href: "/macro", label: "🌐マクロ", shortLabel: "🌐", icon: "chart" },
  { href: "/macro-watch", label: "🔮予兆", shortLabel: "🔮", icon: "chart" },
  { href: "/sectors", label: "🏭業界", shortLabel: "🏭", icon: "grid" },
  { href: "/favorites", label: "お気に入り", shortLabel: "お気に入り", icon: "star" },
  { href: "/analysis", label: "銘柄分析", shortLabel: "分析", icon: "search" },
  { href: "/patterns", label: "パターン", shortLabel: "パターン", icon: "grid" },
  { href: "/screener", label: "スクリーナー", shortLabel: "スクリーナー", icon: "filter" },
  { href: "/rankings", label: "ランキング", shortLabel: "ランキング", icon: "chart" },
  { href: "/realtime", label: "⚡リアルタイム", shortLabel: "⚡", icon: "radio" },
  { href: "/backtest", label: "🔬検証", shortLabel: "🔬", icon: "chart" },
  { href: "/portfolio", label: "ポートフォリオ", shortLabel: "資産", icon: "wallet" },
  { href: "/scenarios", label: "シナリオ", shortLabel: "シナリオ", icon: "clipboard" },
  { href: "/calendar", label: "決算カレンダー", shortLabel: "決算", icon: "calendar" },
  { href: "/news", label: "ニュース", shortLabel: "ニュース", icon: "newspaper" },
  { href: "/recommendations", label: "おすすめ", shortLabel: "🌟", icon: "star" },
  { href: "/anomaly", label: "異常検知", shortLabel: "異常検知", icon: "fire" },
  { href: "/watchdog", label: "ウォッチドッグ", shortLabel: "監視", icon: "radio" },
  { href: "/alerts", label: "価格アラート", shortLabel: "アラート", icon: "bell" },
];

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  // 認証不要ページ
  const publicPaths = ["/login", "/qr-login"];
  const isPublic = publicPaths.includes(pathname);

  useEffect(() => {
    if (!loading && !user && !isPublic) {
      router.push("/login");
    }
  }, [user, loading, pathname, router, isPublic]);

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <div className="text-[var(--color-text-secondary)]">読み込み中...</div>
      </div>
    );
  }

  // 認証不要ページはナビなしで表示
  if (isPublic) {
    return <>{children}</>;
  }

  if (!user) return null;

  return (
    <>
      <TopNav navItems={navItems} currentPath={pathname} />
      <main className="pt-0 md:pt-20 pb-[calc(var(--bottom-nav-height)+env(safe-area-inset-bottom,0px))] md:pb-0">
        <div className="max-w-7xl mx-auto px-6 md:px-10 lg:px-12 py-5">
          {children}
        </div>
      </main>
      <BottomNav navItems={navItems} currentPath={pathname} />
    </>
  );
}

export function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AuthGuard>{children}</AuthGuard>
    </AuthProvider>
  );
}
