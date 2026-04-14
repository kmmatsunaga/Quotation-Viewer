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
      className="flex gap-3 p-3 bg-card rounded-lg border border-[var(--color-border)] hover:border-[var(--color-accent)]/30 transition-all duration-200 min-h-[44px]"
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
          <span className="text-xs text-[var(--color-text-secondary)] truncate">
            {publisher}
          </span>
          <span className="text-xs text-[var(--color-text-secondary)]">
            {formatDate(publishedAt)}
          </span>
        </div>
      </div>
    </a>
  );
}
