interface LogoProps {
  size?: number;
  showText?: boolean;
  className?: string;
}

/**
 * Cavka logo — Neo Tokyo / cyberpunk mark.
 * Angular bracket-style "C" with neon cyan stroke + magenta accent.
 */
export function Logo({ size = 28, showText = true, className = "" }: LogoProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ filter: "drop-shadow(0 0 6px rgba(0,240,255,0.55))" }}
      >
        <defs>
          <linearGradient id="cavka-stroke" x1="0" y1="0" x2="40" y2="40">
            <stop offset="0%" stopColor="#00f0ff" />
            <stop offset="100%" stopColor="#ff2bd6" />
          </linearGradient>
        </defs>
        {/* 7-segment LED「C」 — 4セグメント (上 / 左上縦 / 左下縦 / 下) */}
        <g fill="url(#cavka-stroke)">
          {/* 上水平 (segment a) */}
          <polygon points="13,6 31,6 33,8 31,10 13,10 11,8" />
          {/* 左上縦 (segment f) */}
          <polygon points="9,11 11,13 11,17 9,19 7,17 7,13" />
          {/* 左下縦 (segment e) */}
          <polygon points="9,21 11,23 11,27 9,29 7,27 7,23" />
          {/* 下水平 (segment d) */}
          <polygon points="13,30 31,30 33,32 31,34 13,34 11,32" />
        </g>
        {/* 小数点ドット (右下、電卓の「.」) */}
        <rect x="34" y="32" width="3" height="3" fill="#ff2bd6" />
      </svg>
      {showText && (
        <span
          className="font-bold tracking-[0.25em]"
          style={{
            fontFamily: "'Orbitron', 'Noto Sans JP', sans-serif",
            background: "linear-gradient(90deg, #00f0ff 0%, #ff2bd6 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
            fontSize: size * 0.7,
            textShadow: "0 0 12px rgba(0,240,255,0.4)",
          }}
        >
          CAVKA
        </span>
      )}
    </span>
  );
}
