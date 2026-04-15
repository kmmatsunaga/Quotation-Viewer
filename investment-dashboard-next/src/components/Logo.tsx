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
        {/* Angular C bracket */}
        <path
          d="M32 8 L14 8 L6 16 L6 24 L14 32 L32 32"
          stroke="url(#cavka-stroke)"
          strokeWidth="3"
          strokeLinecap="square"
          strokeLinejoin="miter"
          fill="none"
        />
        {/* Inner notch — circuit accent */}
        <path
          d="M22 18 L18 18 L18 22 L22 22"
          stroke="#ff2bd6"
          strokeWidth="2"
          strokeLinecap="square"
          fill="none"
        />
        {/* Pixel dot */}
        <rect x="28" y="19" width="3" height="3" fill="#00f0ff" />
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
