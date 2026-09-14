import { useId } from "react";

type Variant = "active" | "breached" | "defaulted" | "closed" | "proven" | "clear" | "none";

const COLORS: Record<Variant, string> = {
  active: "#1F5C42",
  breached: "#7A2331",
  defaulted: "#11150C",
  closed: "#5F6B4A",
  proven: "#1F5C42",
  clear: "#5F6B4A",
  none: "#9C8F63"
};

interface Props {
  word: string;
  ring: string;
  variant: Variant;
  size?: number;
  sub?: string;
}

/** Circular banknote seal: ring text on a path, a starburst of engraved ticks, and the status word across the middle. */
export function Seal({ word, ring, variant, size = 150, sub }: Props) {
  const id = useId().replace(/:/g, "");
  const color = COLORS[variant];
  const ticks = Array.from({ length: 72 }, (_, i) => i);
  const wordSize = word.length > 10 ? 11.5 : word.length > 8 ? 13 : word.length > 6 ? 15 : 17;
  return (
    <svg
      className={`seal seal-${variant}`}
      width={size}
      height={size}
      viewBox="0 0 160 160"
      role="img"
      aria-label={`${word}${sub ? `, ${sub}` : ""}`}
    >
      <defs>
        <path id={`ring-${id}`} d="M80,80 m-58,0 a58,58 0 1,1 116,0 a58,58 0 1,1 -116,0" />
      </defs>
      <g fill="none" stroke={color}>
        <circle cx="80" cy="80" r="76" strokeWidth="2.2" />
        <circle cx="80" cy="80" r="71" strokeWidth="0.8" />
        <circle cx="80" cy="80" r="46" strokeWidth="1" />
        <circle cx="80" cy="80" r="42" strokeWidth="0.6" strokeDasharray="1.5 2" />
        {ticks.map((i) => {
          const a = (i / ticks.length) * Math.PI * 2;
          const r1 = 47;
          const r2 = i % 2 ? 50 : 52;
          return (
            <line
              key={i}
              x1={80 + Math.cos(a) * r1}
              y1={80 + Math.sin(a) * r1}
              x2={80 + Math.cos(a) * r2}
              y2={80 + Math.sin(a) * r2}
              strokeWidth="0.6"
            />
          );
        })}
      </g>
      <text fill={color} fontFamily="'Cormorant SC', serif" fontSize="10.5" letterSpacing="1.6" fontWeight="600">
        <textPath href={`#ring-${id}`} startOffset="0">
          {ring}
        </textPath>
      </text>
      <rect x="18" y={80 - 12} width="124" height="24" fill="#F2ECD9" stroke={color} strokeWidth="1.2" />
      <text
        x="80"
        y="80"
        dy="0.36em"
        textAnchor="middle"
        fill={color}
        fontFamily="'Cormorant SC', serif"
        fontWeight="700"
        fontSize={wordSize}
        letterSpacing="1.5"
      >
        {word}
      </text>
      {sub && (
        <text x="80" y="108" textAnchor="middle" fill={color} fontFamily="'EB Garamond', serif" fontSize="10.5" fontStyle="italic">
          {sub}
        </text>
      )}
    </svg>
  );
}
