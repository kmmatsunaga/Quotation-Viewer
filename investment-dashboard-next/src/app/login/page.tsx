"use client";

import { useAuth } from "@/lib/auth-context";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo } from "@/components/Logo";

export default function LoginPage() {
  const { user, loading, error, info, signInWithGoogle, sendEmailLink } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);

  const handleSendLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setSending(true);
    await sendEmailLink(email.trim());
    setSending(false);
  };

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
    <div className="relative min-h-dvh flex items-center justify-center bg-[var(--bg-primary)] px-4 overflow-hidden">
      {/* ネオンの輪郭 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 20% 20%, rgba(0,240,255,0.15), transparent 40%), radial-gradient(circle at 80% 80%, rgba(255,43,214,0.15), transparent 40%)",
        }}
      />
      <div className="relative w-full max-w-sm space-y-10 text-center">
        {/* ブランド */}
        <div className="flex flex-col items-center gap-3">
          <Logo size={56} showText={false} />
          <h1
            className="text-4xl font-black tracking-[0.35em]"
            style={{
              fontFamily: "'Orbitron', sans-serif",
              background: "linear-gradient(90deg, #00f0ff 0%, #ff2bd6 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              textShadow: "0 0 20px rgba(0,240,255,0.4)",
            }}
          >
            CAVKA
          </h1>
          <p
            className="text-[10px] uppercase tracking-[0.5em] text-[var(--color-text-secondary)]"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            // Neo Tokyo Trading Terminal
          </p>
        </div>

        {/* エラー / 情報表示 */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}
        {info && (
          <div
            className="border px-4 py-3 text-sm"
            style={{
              background: "rgba(0,240,255,0.08)",
              borderColor: "var(--color-accent)",
              color: "var(--color-accent)",
              boxShadow: "0 0 14px rgba(0,240,255,0.25)",
            }}
          >
            {info}
          </div>
        )}

        {/* ログインボタン */}
        <div className="space-y-4">
          <button
            onClick={signInWithGoogle}
            className="w-full flex items-center justify-center gap-3 px-6 py-3.5 bg-[var(--bg-card)] text-[var(--color-text)] font-medium hover:bg-[var(--bg-card-hover)] transition-all duration-200 min-h-[48px]"
            style={{
              border: "1px solid var(--color-accent)",
              boxShadow: "0 0 18px rgba(0,240,255,0.35), inset 0 0 12px rgba(0,240,255,0.08)",
              clipPath: "polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)",
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: "0.1em",
            }}
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            &gt; SIGN IN WITH GOOGLE
          </button>

          {/* 区切り */}
          <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">
            <span className="flex-1 h-px bg-[var(--color-border)]" />
            <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>OR</span>
            <span className="flex-1 h-px bg-[var(--color-border)]" />
          </div>

          {/* メールリンク */}
          <form onSubmit={handleSendLink} className="space-y-2">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] focus:border-[var(--color-accent-2)] focus:outline-none px-3 py-3 text-sm text-[var(--color-text)] min-h-[48px] text-center"
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: "0.05em",
              }}
            />
            <button
              type="submit"
              disabled={sending}
              className="w-full px-6 py-3.5 bg-[var(--bg-card)] text-[var(--color-text)] font-medium hover:bg-[var(--bg-card-hover)] transition-all duration-200 min-h-[48px] disabled:opacity-50"
              style={{
                border: "1px solid var(--color-accent-2)",
                boxShadow: "0 0 18px rgba(255,43,214,0.35), inset 0 0 12px rgba(255,43,214,0.08)",
                clipPath:
                  "polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)",
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: "0.1em",
              }}
            >
              {sending ? "> SENDING..." : "✉ > SEND MAGIC LINK"}
            </button>
          </form>
        </div>

        <p className="text-xs text-[var(--color-text-secondary)]">
          PCはGoogle、iPhoneのホーム画面アプリは<br />
          メールリンクでのログインがおすすめです
        </p>
      </div>
    </div>
  );
}
