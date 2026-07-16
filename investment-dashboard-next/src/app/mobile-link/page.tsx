"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import QRCode from "qrcode";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

/**
 * /mobile-link - PC でログイン中のユーザーが iPhone 用 QR を生成するページ。
 */
export default function MobileLinkPage() {
  const { user } = useAuth();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  void tick;

  // 1秒ごとに残り時間更新
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const generate = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const { auth } = await import("@/lib/firebase");
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error("ログインが必要です");

      const res = await fetch("/api/auth/qr/generate", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "QR生成失敗");

      // QR画像生成 (大きめ、Cavkaカラー)
      const dataUrl = await QRCode.toDataURL(json.url, {
        width: 380,
        margin: 2,
        color: {
          dark: "#00f0ff",      // シアン
          light: "#0a0c1a",     // ダーク背景
        },
        errorCorrectionLevel: "M",
      });
      setQrDataUrl(dataUrl);
      setUrl(json.url);
      setExpiresAt(new Date(json.expiresAt));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user]);

  const remainingSec = expiresAt ? Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) : 0;
  const expired = expiresAt && remainingSec <= 0;

  return (
    <div className="space-y-5 max-w-xl mx-auto">
      <div>
        <h1 className="text-[26px] font-bold text-[var(--color-text)] tracking-tight">
          📱 iPhoneでログイン
        </h1>
        <p className="text-xs text-[var(--color-text-secondary)] mt-1" style={MONO}>
          PCで生成したQRをiPhoneのカメラで読み取るだけで、自動ログインできます。
        </p>
      </div>

      <div
        className="p-6 rounded space-y-4 text-center"
        style={{ border: "1px solid var(--color-accent)", background: "var(--bg-card)" }}
      >
        {!qrDataUrl && !loading && (
          <>
            <p className="text-sm text-[var(--color-text)]" style={MONO}>
              QRコードを生成すると、5分間有効なログインリンクができます。
            </p>
            <button
              onClick={generate}
              className="px-6 py-3 text-sm font-medium"
              style={{
                border: "1px solid var(--color-accent)",
                color: "var(--color-accent)",
                background: "rgba(0,240,255,0.08)",
                boxShadow: "0 0 18px rgba(0,240,255,0.25)",
                ...MONO,
              }}
            >
              🔐 QRコードを生成
            </button>
          </>
        )}

        {loading && (
          <p className="text-sm text-[var(--color-text-secondary)]" style={MONO}>
            生成中...
          </p>
        )}

        {error && (
          <p className="text-sm text-red-400" style={MONO}>
            ⚠ {error}
          </p>
        )}

        {qrDataUrl && (
          <div className="space-y-3">
            <div className="inline-block p-2 rounded" style={{ background: "#0a0c1a" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrDataUrl} alt="QR Code" width={380} height={380} />
            </div>

            {expired ? (
              <div className="text-sm text-red-400" style={MONO}>
                ⏱ 有効期限切れ
              </div>
            ) : (
              <div className="text-sm text-[var(--color-accent)]" style={MONO}>
                ⏱ あと {Math.floor(remainingSec / 60)}:{String(remainingSec % 60).padStart(2, "0")}
              </div>
            )}

            <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed" style={MONO}>
              📷 iPhoneカメラで上のQRを読み取り → 表示されたリンクをタップ<br />
              → 自動ログイン → ホーム画面に追加で次回からタップ起動
            </p>

            <button
              onClick={generate}
              className="text-xs px-3 py-1.5"
              style={{
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
                ...MONO,
              }}
            >
              🔄 新しいQRを生成
            </button>

            {url && (
              <details className="text-left">
                <summary className="text-[10px] text-[var(--color-text-secondary)] cursor-pointer" style={MONO}>
                  ▶ URL を見る (QR が読めない時用)
                </summary>
                <input
                  type="text"
                  readOnly
                  value={url}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                  className="w-full mt-2 px-2 py-1 text-[10px] bg-[var(--bg-input)] border border-[var(--color-border)]"
                  style={MONO}
                />
              </details>
            )}
          </div>
        )}
      </div>

      <div
        className="p-3 rounded text-xs space-y-1"
        style={{
          background: "rgba(0,240,255,0.04)",
          border: "1px solid rgba(0,240,255,0.2)",
          ...MONO,
        }}
      >
        <div className="text-[10px] text-[var(--color-accent)] uppercase">セキュリティ</div>
        <div className="text-[var(--color-text-secondary)]">
          • トークン有効期限: 5分間<br />
          • 1回使用で自動無効化<br />
          • PCでログイン中のアカウントが iPhone に共有されます
        </div>
      </div>
    </div>
  );
}
