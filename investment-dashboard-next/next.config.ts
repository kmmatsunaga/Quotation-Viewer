import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    // ローカル開発時のみFastAPIに転送（Vercel上ではvercel.jsonが処理）
    // Next.js App Router の API ルート（/api/stocks/search 等）は
    // rewrite より優先されるので、それ以外を FastAPI に fallback する
    if (process.env.NODE_ENV === "development") {
      return {
        beforeFiles: [],
        afterFiles: [],
        fallback: [
          {
            source: "/api/:path*",
            destination: "http://localhost:8000/api/:path*",
          },
        ],
      };
    }
    return [];
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
