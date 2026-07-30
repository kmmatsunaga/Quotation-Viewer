"use client";

import { useEffect, useState } from "react";
import { GlossaryBox } from "@/components/CommentaryPanel";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

/**
 * 🏔 清原式の読み解きパネル (net-cash-story API の表示部)
 *
 * /net-cash の行展開と、おすすめ「🏔清原式」タブのカード下部の両方から使う。
 * 展開されて初めて fetch する (一覧表示を重くしない)。
 */

interface StorySection {
  icon: string;
  title: string;
  body: string | null;
  bullets: string[];
}

interface Story {
  ticker: string;
  name: string;
  date: string;
  sections: StorySection[];
  terms: string[];
  generatedAt: string;
}

export default function NetCashStory({ ticker }: { ticker: string }) {
  const [story, setStory] = useState<Story | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/stocks/net-cash-story/${ticker}`)
      .then(async (r) => {
        const j = await r.json();
        if (cancelled) return;
        if (r.ok && j.story) setStory(j.story as Story);
        else setError(j.error ?? "解説を生成できませんでした");
      })
      .catch(() => { if (!cancelled) setError("解説の取得に失敗しました"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ticker]);

  if (loading) {
    return (
      <div className="px-4 py-3 text-[11px] text-[var(--color-text-secondary)]" style={MONO}>
        🏔 読み解きを生成中… (初回は数秒かかります)
      </div>
    );
  }
  if (error || !story) {
    return (
      <div className="px-4 py-3 text-[11px] text-[var(--color-text-secondary)]" style={MONO}>
        {error ?? "解説なし"}
      </div>
    );
  }

  return (
    <div className="px-4 py-3 space-y-3">
      {story.sections.map((s, i) => (
        <div key={i}>
          <div className="text-[11px] font-bold text-[var(--color-text)] mb-1" style={MONO}>
            {s.icon} {s.title}
          </div>
          {s.body && (
            <p className="text-[12px] leading-relaxed text-[var(--color-text-secondary)] mb-1">{s.body}</p>
          )}
          {s.bullets.length > 0 && (
            <ul className="space-y-0.5">
              {s.bullets.map((b, k) => (
                <li key={k} className="text-[12px] leading-relaxed text-[var(--color-text-secondary)] pl-3 relative">
                  <span className="absolute left-0 text-[var(--color-accent)]">·</span>
                  {b}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      <GlossaryBox terms={story.terms} />
      <div className="text-[9px] text-[var(--color-text-secondary)] opacity-60" style={MONO}>
        データ基準日 {story.date} · 生成 {story.generatedAt.slice(0, 10)} · 割安の測定であり投資助言ではありません
      </div>
    </div>
  );
}
