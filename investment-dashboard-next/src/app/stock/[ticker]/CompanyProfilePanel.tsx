"use client";

import { useEffect, useState } from "react";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

interface Profile {
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  employees: number | null;
  website: string | null;
  city: string | null;
  country: string | null;
  summaryOriginal: string | null;
  summaryJa: string | null;
  generatedAt: string | null;
}

/**
 * 会社概要パネル — 「この銘柄はどんな会社か」。
 * 日本語要約 (Gemini) を主役に、業種・従業員・本社・サイトを添える。
 */
export default function CompanyProfilePanel({ ticker }: { ticker: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [showOriginal, setShowOriginal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/stocks/company-profile/${encodeURIComponent(ticker)}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) { setProfile(j.profile ?? null); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ticker]);

  if (loading) {
    return (
      <div className="p-4 rounded text-xs text-[var(--color-text-secondary)]" style={{ background: "var(--bg-card)", border: "1px solid var(--color-border)", ...MONO }}>
        会社概要を読み込み中...
      </div>
    );
  }
  if (!profile || (!profile.summaryJa && !profile.sector && !profile.employees)) {
    return null; // 情報が無い銘柄は非表示
  }

  const facts: { label: string; value: string }[] = [];
  if (profile.sector) facts.push({ label: "セクター", value: profile.sector });
  if (profile.industry) facts.push({ label: "業種", value: profile.industry });
  if (profile.employees != null) facts.push({ label: "従業員", value: `${profile.employees.toLocaleString()}名` });
  if (profile.city || profile.country) facts.push({ label: "本社", value: [profile.city, profile.country].filter(Boolean).join(", ") });

  return (
    <div className="p-4 rounded space-y-3" style={{ background: "var(--bg-card)", border: "1px solid var(--color-border)" }}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-[var(--color-accent)]" style={MONO}>
          🏢 会社概要
        </h3>
        {profile.website && (
          <a
            href={profile.website.startsWith("http") ? profile.website : `https://${profile.website}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-[var(--color-accent)] hover:underline shrink-0"
            style={MONO}
          >
            🌐 公式サイト ↗
          </a>
        )}
      </div>

      {/* 事業内容 (日本語) */}
      {profile.summaryJa && (
        <p className="text-[13px] leading-relaxed text-[var(--color-text)]">
          {profile.summaryJa}
        </p>
      )}

      {/* ファクト */}
      {facts.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {facts.map((f) => (
            <div key={f.label} className="text-xs" style={MONO}>
              <span className="text-[var(--color-text-secondary)]">{f.label}: </span>
              <span className="text-[var(--color-text)]">{f.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* 原文 (英語) を折りたたみで */}
      {profile.summaryOriginal && profile.summaryOriginal !== profile.summaryJa && (
        <div>
          <button
            onClick={() => setShowOriginal((v) => !v)}
            className="text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]"
            style={MONO}
          >
            {showOriginal ? "▲ 原文を閉じる" : "▼ 原文 (英語) を見る"}
          </button>
          {showOriginal && (
            <p className="text-[11px] leading-relaxed text-[var(--color-text-secondary)] mt-1.5">
              {profile.summaryOriginal}
            </p>
          )}
        </div>
      )}

      <div className="text-[9px] text-[var(--color-text-secondary)] pt-1 border-t border-[var(--color-border)]" style={MONO}>
        出典: Yahoo Finance summaryProfile{profile.summaryJa && profile.summaryJa !== profile.summaryOriginal ? " · 日本語要約は Gemini 生成" : ""}
      </div>
    </div>
  );
}
