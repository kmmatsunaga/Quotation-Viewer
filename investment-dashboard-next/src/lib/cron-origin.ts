import type { NextRequest } from "next/server";

/**
 * Vercel cron 内部 fetch 用 origin。
 *
 * Vercel cron は host ヘッダにデプロイ固有 URL
 * (例: quotation-viewer-xxxxx-hirokis-projects-5f220237.vercel.app) を送ってくるが、
 * このURLは Deployment Protection で 401 になる。
 * 一方、production alias (quotation-viewer.vercel.app) は保護対象外。
 *
 * よって VERCEL_PROJECT_PRODUCTION_URL を最優先で使う。
 */
export function getCronOrigin(req: NextRequest): string {
  const prodHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prodHost) return `https://${prodHost}`;
  const host = req.headers.get("host") ?? "localhost:3000";
  const proto = host.includes("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}
