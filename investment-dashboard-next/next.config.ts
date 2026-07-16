import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    // Firebase 認証ハンドラを自分のドメインからプロキシ（iOS ITP対策）
    // これで認証Cookieが同一オリジン扱いになり、Safariで保持される
    const firebaseAuthRewrites = [
      {
        source: "/__/auth/:path*",
        destination: "https://cavka-79d45.firebaseapp.com/__/auth/:path*",
      },
      {
        source: "/__/firebase/:path*",
        destination: "https://cavka-79d45.firebaseapp.com/__/firebase/:path*",
      },
    ];

    if (process.env.NODE_ENV === "development") {
      return {
        beforeFiles: firebaseAuthRewrites,
        afterFiles: [],
        fallback: [
          {
            source: "/api/:path*",
            destination: "http://localhost:8000/api/:path*",
          },
        ],
      };
    }
    return firebaseAuthRewrites;
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-XSS-Protection",
            value: "1; mode=block",
          },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache",
          },
          {
            key: "Service-Worker-Allowed",
            value: "/",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
