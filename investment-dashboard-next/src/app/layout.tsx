"use client";

import { Noto_Sans_JP } from "next/font/google";
import "./globals.css";
import { TopNav } from "@/components/TopNav";
import { BottomNav } from "@/components/BottomNav";
import { usePathname } from "next/navigation";

const notoSansJP = Noto_Sans_JP({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

const navItems = [
  { href: "/", label: "マーケット概況", shortLabel: "概況", icon: "chart" },
  { href: "/favorites", label: "お気に入り", shortLabel: "お気に入り", icon: "star" },
  { href: "/analysis", label: "銘柄分析", shortLabel: "分析", icon: "search" },
  { href: "/portfolio", label: "ポートフォリオ", shortLabel: "資産", icon: "wallet" },
  { href: "/alerts", label: "価格アラート", shortLabel: "アラート", icon: "bell" },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <html lang="ja" className={notoSansJP.className}>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#0f1117" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <link rel="manifest" href="/manifest.json" />
        <title>投資ダッシュボード</title>
      </head>
      <body className="min-h-dvh bg-[var(--bg-primary)]">
        <TopNav navItems={navItems} currentPath={pathname} />
        <main className="pt-0 md:pt-[var(--nav-height)] pb-[calc(var(--bottom-nav-height)+env(safe-area-inset-bottom,0px))] md:pb-0">
          <div className="max-w-7xl mx-auto px-3 md:px-6 py-4">
            {children}
          </div>
        </main>
        <BottomNav navItems={navItems} currentPath={pathname} />
      </body>
    </html>
  );
}
