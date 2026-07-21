"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { TopNav } from "@/components/TopNav";
import { BottomNav } from "@/components/BottomNav";
import QuickNote from "@/components/QuickNote";
import TickerContextMenu from "@/components/TickerContextMenu";
import CrashAlertGuard from "@/components/CrashAlertGuard";
import { CrashAlertProvider } from "@/lib/crash-alert-context";

// ナビ構造: ☀玄関 → ⚔戦場 (場中) → 🔬研究所 (分析) → 📊資産と記録
// group が前項と変わる位置に区切りとグループ見出しが入る (TopNav)
const navItems = [
  { href: "/briefing", label: "☀今日", shortLabel: "☀", icon: "chart", group: "" },
  { href: "/", label: "概況", shortLabel: "概況", icon: "chart", group: "" },
  // ⚔ デイトレ — 一日の武器一式
  { href: "/briefing", label: "☀ 今日の候補 (作戦)", shortLabel: "☀", icon: "chart", group: "⚔デイトレ" },
  { href: "/warroom", label: "場中ウォールーム", shortLabel: "⚔", icon: "radio", group: "⚔デイトレ" },
  { href: "/journal", label: "ジャーナル (取引記録)", shortLabel: "📓", icon: "clipboard", group: "⚔デイトレ" },
  { href: "/tendencies", label: "デイトレ傾向 (法則)", shortLabel: "🔍", icon: "chart", group: "⚔デイトレ" },
  { href: "/pattern-factory", label: "パターン工場 (自動学習)", shortLabel: "🏭", icon: "grid", group: "⚔デイトレ" },
  { href: "/realtime", label: "リアルタイムスキャン", shortLabel: "⚡", icon: "radio", group: "⚔デイトレ" },
  { href: "/anomaly", label: "異常検知", shortLabel: "異常", icon: "fire", group: "⚔デイトレ" },
  { href: "/alerts", label: "価格アラート", shortLabel: "アラート", icon: "bell", group: "⚔デイトレ" },
  // 🔬 研究所 — 夜と週末の分析
  { href: "/analysis", label: "銘柄分析", shortLabel: "分析", icon: "search", group: "🔬研究所" },
  { href: "/screener", label: "スクリーナー", shortLabel: "スクリーナー", icon: "filter", group: "🔬研究所" },
  { href: "/sectors", label: "業界", shortLabel: "🏭", icon: "grid", group: "🔬研究所" },
  { href: "/macro-watch", label: "予兆", shortLabel: "🔮", icon: "chart", group: "🔬研究所" },
  { href: "/macro", label: "マクロ", shortLabel: "🌐", icon: "chart", group: "🔬研究所" },
  { href: "/patterns", label: "パターン", shortLabel: "パターン", icon: "grid", group: "🔬研究所" },
  { href: "/rankings", label: "ランキング", shortLabel: "ランキング", icon: "chart", group: "🔬研究所" },
  { href: "/recommendations", label: "おすすめ", shortLabel: "🌟", icon: "star", group: "🔬研究所" },
  { href: "/calendar", label: "決算カレンダー", shortLabel: "決算", icon: "calendar", group: "🔬研究所" },
  { href: "/news", label: "ニュース", shortLabel: "ニュース", icon: "newspaper", group: "🔬研究所" },
  { href: "/scenarios", label: "シナリオ", shortLabel: "シナリオ", icon: "clipboard", group: "🔬研究所" },
  { href: "/backtest", label: "検証", shortLabel: "🔬", icon: "chart", group: "🔬研究所" },
  { href: "/intraday-laws", label: "場中の法則 (板圧・成行)", shortLabel: "🔬場中", icon: "chart", group: "🔬研究所" },
  // 📊 資産と記録 — 自分のもの
  { href: "/portfolio", label: "ポートフォリオ", shortLabel: "資産", icon: "wallet", group: "📊資産" },
  { href: "/buyplan", label: "買い方の設計 (プラン)", shortLabel: "🧭", icon: "clipboard", group: "📊資産" },
  { href: "/earnings-guard", label: "決算またぎ (リスク管理)", shortLabel: "🛡", icon: "calendar", group: "📊資産" },
  { href: "/favorites", label: "お気に入り", shortLabel: "お気に入り", icon: "star", group: "📊資産" },
  { href: "/watchdog", label: "ウォッチドッグ (保有監視)", shortLabel: "監視", icon: "radio", group: "📊資産" },
  { href: "/accuracy", label: "的中率", shortLabel: "🎯", icon: "chart", group: "📊資産" },
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
    <CrashAlertProvider>
      <TopNav navItems={navItems} currentPath={pathname} />
      <main className="pt-0 md:pt-20 pb-[calc(var(--bottom-nav-height)+env(safe-area-inset-bottom,0px))] md:pb-0">
        <div className="max-w-7xl mx-auto px-6 md:px-10 lg:px-12 py-5">
          {children}
        </div>
      </main>
      <BottomNav navItems={navItems} currentPath={pathname} />
      <QuickNote />
      <TickerContextMenu />
      <CrashAlertGuard />
    </CrashAlertProvider>
  );
}

export function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AuthGuard>{children}</AuthGuard>
    </AuthProvider>
  );
}
