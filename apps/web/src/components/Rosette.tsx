import { useEffect, useRef } from "react";

interface Props {
  seed: string;
  size?: number;
  interactive?: boolean;
  tone?: "default" | "proven" | "void";
}

/** Byte i of a hex seed as 0..1. */
function byte(seed: string, i: number): number {
  const hex = seed.replace(/^0x/, "").padEnd(64, "0");
  return parseInt(hex.slice((i * 2) % 62, ((i * 2) % 62) + 2), 16) / 255;
}

const PALETTES = {
  default: ["#1F5C42", "#7A2331", "#5F6B4A"],
  proven: ["#1F5C42", "#1F5C42", "#3C4A32"],
  void: ["#9C8F63", "#7A2331", "#C7B98D"]
};

/**
 * Guilloche rosette drawn from hypotrochoids whose parameters come from a hash,
 * the way an engraving lathe's cams set a banknote's security pattern. Pointer
 * movement nudges the cam offsets.
 */
export function Rosette({ seed, size = 220, interactive = true, tone = "default" }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = canvas.current;
    const el = wrap.current;
    if (!cv || !el) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let target = { x: 0, y: 0 };
    let cur = { x: 0, y: 0 };
    let raf = 0;
    let lastDrawn = { x: NaN, y: NaN };
    const colors = PALETTES[tone];

    const resize = () => {
      const w = el.getBoundingClientRect().width;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(w * dpr);
      lastDrawn = { x: NaN, y: NaN };
    };

    const draw = (ox: number, oy: number) => {
      const W = cv.width;
      const cx = W / 2;
      const rad = W * 0.47;
      ctx.clearRect(0, 0, W, W);
      ctx.fillStyle = "#F2ECD9";
      ctx.beginPath();
      ctx.arc(cx, cx, rad + 4, 0, Math.PI * 2);
      ctx.fill();
      for (let layer = 0; layer < 3; layer++) {
        const R = 38 + byte(seed, layer) * 14 + layer * 5 + ox * 7;
        const r = 11 + byte(seed, layer + 7) * 9 - layer * 1.5 + oy * 4;
        const d = 24 + byte(seed, layer + 13) * 18 + layer * 8;
        const turns = 5 + Math.round(byte(seed, layer + 21) * 6);
        const scale = (rad * (0.92 - layer * 0.19)) / (Math.abs(R - r) + d);
        ctx.beginPath();
        ctx.strokeStyle = colors[layer];
        ctx.globalAlpha = layer === 2 ? 0.45 : 0.55;
        ctx.lineWidth = (layer === 2 ? 0.7 : 0.9) * dpr;
        const steps = 1100;
        for (let i = 0; i <= steps; i++) {
          const t = (i / steps) * Math.PI * 2 * turns;
          const x = (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t);
          const y = (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t);
          const px = cx + x * scale;
          const py = cx + y * scale;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.fillStyle = "#11150C";
      ctx.arc(cx, cx, rad * 0.05, 0, Math.PI * 2);
      ctx.fill();
    };

    resize();
    draw(0, 0);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const loop = () => {
      cur = { x: cur.x + (target.x - cur.x) * 0.08, y: cur.y + (target.y - cur.y) * 0.08 };
      if (Math.abs(cur.x - lastDrawn.x) > 0.001 || Math.abs(cur.y - lastDrawn.y) > 0.001 || Number.isNaN(lastDrawn.x)) {
        draw(cur.x, cur.y);
        lastDrawn = { ...cur };
      }
      raf = requestAnimationFrame(loop);
    };
    if (interactive && !reduced) raf = requestAnimationFrame(loop);

    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      target = { x: ((e.clientX - r.left) / r.width - 0.5) * 2, y: ((e.clientY - r.top) / r.height - 0.5) * 2 };
    };
    const leave = () => (target = { x: 0, y: 0 });
    const onResize = () => {
      resize();
      draw(cur.x, cur.y);
    };
    if (interactive) {
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerleave", leave);
    }
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      window.removeEventListener("resize", onResize);
    };
  }, [seed, interactive, tone]);

  return (
    <div className="medallion" ref={wrap} style={{ width: size, height: size }} aria-hidden="true">
      <canvas ref={canvas} />
      <div className="medallion-ring" />
    </div>
  );
}
