"use client";

import { useAuth } from "@/lib/auth-context";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function LoginPage() {
  const { user, loading, error, signInWithGoogle } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user) {
      router.push("/");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[var(--bg-primary)]">
        <div className="text-[var(--color-text-secondary)]">読み込み中...</div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-[var(--bg-primary)] px-4">
      <div className="w-full max-w-sm space-y-8 text-center">
        {/* ブランド */}
        <div>
          <h1 className="text-3xl font-bold text-[var(--color-accent)]">
            投資ダッシュボード
          </h1>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
            ポートフォリオを一元管理
          </p>
        </div>

        {/* エラー表示 */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* ログインボタン */}
        <div className="space-y-4">
          <button
            onClick={signInWithGoogle}
            className="w-full flex items-center justify-center gap-3 px-6 py-3.5 bg-white text-gray-800 font-medium rounded-xl hover:bg-gray-100 transition-all duration-200 shadow-lg min-h-[48px]"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            Googleでログイン
          </button>
        </div>

        <p className="text-xs text-[var(--color-text-secondary)]">
          ログインすると、ポートフォリオやお気に入りが<br />
          デバイス間で同期されます
        </p>
      </div>
    </div>
  );
}
