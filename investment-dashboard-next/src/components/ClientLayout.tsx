"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { TopNav } from "@/components/TopNav";
import { BottomNav } from "@/components/BottomNav";

const navItems = [
  { href: "/", label: "マーケット概況", shortLabel: "概況", icon: "chart" },
  { href: "/favorites", label: "お気に入り", shortLabel: "お気に入り", icon: "star" },
  { href: "/analysis", label: "銘柄分析", shortLabel: "分析", icon: "search" },
  { href: "/portfolio", label: "ポートフォリオ", shortLabel: "資産", icon: "wallet" },
  { href: "/alerts", label: "価格アラート", shortLabel: "アラート", icon: "bell" },
];

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user && pathname !== "/login") {
      router.push("/login");
    }
  }, [user, loading, pathname, router]);

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <div className="text-[var(--color-text-secondary)]">読み込み中...</div>
      </div>
    );
  }

  // ログインページはナビなしで表示
  if (pathname === "/login") {
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
