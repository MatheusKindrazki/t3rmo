import { useEffect, useRef } from 'react';

/**
 * Canvas confetti for the podium.
 *
 * Canvas rather than DOM nodes: two hundred absolutely-positioned divs being
 * transformed every frame is a layout and paint cost on the one screen where
 * the machine is also animating a leaderboard, and this page already learned
 * that lesson once — the landing's crowd field went from 51 to 81 fps by moving
 * its animation off paint. One canvas is one composited layer.
 *
 * It runs for a fixed six seconds and then stops the loop for good, because a
 * match-end screen can sit open for minutes and a perpetual rAF on a phone is
 * a battery drain nobody asked for.
 */
const COLOURS = ['#1f7468', '#e8c88e', '#8fd3ff', '#fafaff', '#ff9d78'];
const LIFE_MS = 6000;

interface Bit {
  x: number; y: number; vx: number; vy: number;
  rot: number; vr: number; w: number; h: number; c: string;
}

export function Confetti({ count = 180 }: { count?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let w = 0, h = 0;
    const size = () => {
      w = cv.clientWidth; h = cv.clientHeight;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();

    // Two bursts from the lower corners, the way a real cannon is aimed at a
    // podium — a uniform rain from the top reads as weather, not celebration.
    const bits: Bit[] = Array.from({ length: count }, (_, i) => {
      const left = i % 2 === 0;
      const spread = (Math.random() - 0.5) * 1.1;
      const power = 9 + Math.random() * 9;
      return {
        x: left ? -10 : w + 10,
        y: h * (0.72 + Math.random() * 0.2),
        vx: (left ? 1 : -1) * power * (0.75 + Math.random() * 0.5),
        vy: -power * (1.05 + Math.random() * 0.55) + spread,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.28,
        w: 5 + Math.random() * 6,
        h: 8 + Math.random() * 8,
        c: COLOURS[Math.floor(Math.random() * COLOURS.length)]!,
      };
    });

    let raf = 0;
    const started = performance.now();
    const tick = (now: number) => {
      const age = now - started;
      ctx.clearRect(0, 0, w, h);
      // Fade the whole field out at the end instead of letting pieces vanish.
      const alpha = age > LIFE_MS - 900 ? Math.max(0, (LIFE_MS - age) / 900) : 1;
      ctx.globalAlpha = alpha;

      for (const b of bits) {
        b.vy += 0.34;           // gravity
        b.vx *= 0.992;          // drag
        b.x += b.vx; b.y += b.vy; b.rot += b.vr;
        if (b.y > h + 40) continue;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.rot);
        ctx.fillStyle = b.c;
        // Squashing on the rotation gives the flutter of a flat piece of paper
        // turning edge-on, which is most of what sells confetti.
        ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h * Math.abs(Math.cos(b.rot)));
        ctx.restore();
      }

      if (age < LIFE_MS) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, w, h);
    };
    raf = requestAnimationFrame(tick);

    const onResize = () => size();
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); };
  }, [count]);

  return <canvas className="confetti" ref={ref} aria-hidden="true" />;
}
