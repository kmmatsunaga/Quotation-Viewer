import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ClientLayout } from "@/components/ClientLayout";

export const metadata: Metadata = {
  title: "Cavka — Neo Tokyo Trading Terminal",
  description: "Cavka: あなたの投資を、ネオ東京の速度で。",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#05060d",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=Orbitron:wght@500;700;900&family=JetBrains+Mono:wght@400;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body
        className="min-h-dvh bg-[var(--bg-primary)]"
        style={{ fontFamily: "'Noto Sans JP', sans-serif" }}
      >
        <ClientLayout>{children}</ClientLayout>
      </body>
    </html>
  );
}
