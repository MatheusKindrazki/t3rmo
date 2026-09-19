import { useMemo } from 'react';
import { mulberry32 } from '@arena/core';

/**
 * The crowd, rendered.
 *
 * The page used to *claim* that thousands of people play the same word at the
 * same second, in a sentence, above a form. This shows it instead: a field of
 * anonymous boards filling in with teal and sand at their own pace, which is
 * exactly what the room looks like from above. It is the one image that could
 * not belong to any other product, and it occupies the canvas that was
 * previously empty mauve.
 *
 * Built once from a seeded PRNG and animated entirely in CSS — every tile gets
 * its own delay and the whole field loops. No per-frame JavaScript, nothing
 * recalculated on resize, and it goes still under prefers-reduced-motion.
 */
const COLS = 5;
const ROWS = 6;

export function Crowd({ seed = 20260918 }: { seed?: number }) {
  const field = useMemo(() => {
    // Sized once from the viewport: the field has to OVERFLOW its column so the
    // mask crops it, otherwise the boards settle into a band across the middle
    // and the rest of the surface reads as empty ground again. Phones get far
    // fewer because there the field sits behind the desk at low opacity and
    // every node is pure cost.
    const w = typeof window === 'undefined' ? 1440 : window.innerWidth;
    const h = typeof window === 'undefined' ? 900 : window.innerHeight;
    // OVERSHOOT on purpose, and never cap into the visible area.
    //
    // The column count here is an estimate; the real one is decided by the CSS
    // (`auto-fill` over `minmax(68px, 1fr)` plus a clamped gap), so the two do
    // not agree. Capping the total at a round number therefore ended the field
    // on a half-empty row INSIDE the viewport — a stub of one or two boards
    // with blank ground beside it, which reads as the layout giving up. The fix
    // is to render more rows than can possibly fit and let the mask crop them,
    // so whatever row ends up partial is already off-screen.
    const cols = Math.ceil((w * (w > 880 ? 0.72 : 1)) / 84) + 2;
    const rows = Math.ceil(h / 84) + 2;
    const boards = Math.min(w > 880 ? 340 : 90, cols * rows);
    // ~15 of a board's 30 cells are filled on average.
    const liveFraction = Math.min(0.42, 1000 / Math.max(1, boards * 15));
    const rand = mulberry32(seed);
    return Array.from({ length: boards }, () => {
      // Most players are mid-round; a few have just started, a few are done.
      const filled = 1 + Math.floor(rand() * (ROWS - 1));
      const pace = 0.7 + rand() * 2.4;
      const offset = rand() * 9;
      // Density fills the surface; motion is what costs. So the animated
      // FRACTION shrinks as the field grows, holding the number of animating
      // cells roughly constant (~1000) no matter the screen. Measured: the
      // field went from 51 fps to 81 fps when the animation moved from
      // background-color to composited opacity, and this keeps that headroom
      // on a big display. A room where every player moves on the same beat is
      // not what a room looks like anyway.
      const live = rand() < liveFraction;
      const cells = Array.from({ length: ROWS * COLS }, (_, i) => {
        const row = Math.floor(i / COLS);
        if (row >= filled) return -1;
        const r = rand();
        // Later rows skew greener: that is what solving looks like.
        const luck = r + row * 0.12;
        return luck > 0.82 ? 2 : luck > 0.58 ? 1 : 0;
      });
      return { cells, pace, offset, live };
    });
  }, [seed]);

  return (
    <div className="crowd" aria-hidden="true">
      {field.map((b, i) => (
        <div className="cb" key={i}>
          {b.cells.map((s, j) => (
            <span
              className="cc"
              key={j}
              data-s={s >= 0 ? s : undefined}
              data-live={s >= 0 && b.live ? '' : undefined}
              // The delay rides a custom property because the animation now
              // lives on ::after, which cannot inherit animation-delay.
              style={{ ['--d' as string]: `${b.offset + (Math.floor(j / COLS) * b.pace) / 2}s` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
