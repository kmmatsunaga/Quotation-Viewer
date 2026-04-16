"use client";

interface NewsCardProps {
  title: string;
  url: string;
  publisher: string;
  publishedAt: string;
  thumbnail?: string;
}

export function NewsCard({
  title,
  url,
  publisher,
  publishedAt,
  thumbnail,
}: NewsCardProps) {
  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString("ja-JP", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="relative flex gap-3 p-3 bg-card border-l-2 border-l-[var(--color-accent)] border-y border-r border-[var(--color-border)] hover:border-y-[var(--color-accent)]/40 hover:border-r-[var(--color-accent)]/40 hover:bg-[var(--bg-card-hover)] transition-all duration-200 min-h-[44px]"
    >
      {thumbnail && (
        <div className="shrink-0 w-16 h-16 md:w-20 md:h-20 rounded overflow-hidden bg-[var(--bg-input)]">
          <img
            src={thumbnail}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
          />
        </div>
      )}
      <div className="flex flex-col justify-between flex-1 min-w-0">
        <h3 className="text-sm font-medium leading-snug line-clamp-2 text-[var(--color-text)]">
          {title}
        </h3>
        <div className="flex items-center gap-2 mt-1">
          <span
            className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-accent)] truncate"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {publisher}
          </span>
          <span
            className="text-[10px] text-[var(--color-text-secondary)]"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {formatDate(publishedAt)}
          </span>
        </div>
      </div>
    </a>
  );
}
