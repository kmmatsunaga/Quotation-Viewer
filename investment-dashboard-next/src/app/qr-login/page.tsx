"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

function QrLoginInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("ログイン処理中...");

  useEffect(() => {
    const token = params.get("token");
    if (!token) {
      setStatus("error");
      setMessage("トークンが指定されていません");
      return;
    }

    (async () => {
      try {
        // 1. token → custom token を取得
        const res = await fetch("/api/auth/qr/redeem", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error ?? "ログイン失敗");

        // 2. Firebase Auth に custom token でサインイン
        const [{ auth }, { signInWithCustomToken }] = await Promise.all([
          import("@/lib/firebase"),
          import("firebase/auth"),
        ]);
        await signInWithCustomToken(auth, json.customToken);

        setStatus("success");
        setMessage(`${json.email} としてログインしました`);

        // 1.5秒後にホームへ
        setTimeout(() => router.push("/"), 1500);
      } catch (e) {
        setStatus("error");
        setMessage((e as Error).message);
      }
    })();
  }, [params, router]);

  return (
    <div className="min-h-dvh flex items-center justify-center p-6">
      <div
        className="max-w-sm w-full p-6 rounded text-center space-y-4"
        style={{
          border: `1px solid ${status === "success" ? "#22c55e" : status === "error" ? "#ef4444" : "var(--color-accent)"}`,
          background: "var(--bg-card)",
          boxShadow: "0 0 24px rgba(0,240,255,0.15)",
        }}
      >
        <div className="text-4xl">
          {status === "loading" && "🔐"}
          {status === "success" && "✅"}
          {status === "error" && "⚠️"}
        </div>
        <h1 className="text-lg font-bold text-[var(--color-accent)]" style={MONO}>
          {status === "loading" && "ログイン中..."}
          {status === "success" && "ログイン成功"}
          {status === "error" && "エラー"}
        </h1>
        <p className="text-sm" style={{ color: status === "error" ? "#ef4444" : "var(--color-text)", ...MONO }}>
          {message}
        </p>
        {status === "success" && (
          <p className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
            まもなくホーム画面に移動します...
          </p>
        )}
        {status === "error" && (
          <button
            onClick={() => router.push("/login")}
            className="px-4 py-2 text-sm"
            style={{
              border: "1px solid var(--color-accent)",
              color: "var(--color-accent)",
              ...MONO,
            }}
          >
            ログイン画面へ
          </button>
        )}
      </div>
    </div>
  );
}

export default function QrLoginPage() {
  return (
    <Suspense fallback={<div className="text-center py-8 text-xs text-[var(--color-text-secondary)]" style={MONO}>読み込み中...</div>}>
      <QrLoginInner />
    </Suspense>
  );
}
