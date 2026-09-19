/**
 * Lift a color's minimum brightness so the gcode preview's lighting can actually show
 * on it.
 *
 * The gcode-preview library's tube shader is purely multiplicative:
 * `finalColor = uColor * (diff + ambient) * brightness` (its fragment shader, in
 * node_modules/gcode-preview/dist/gcode-preview.es.js), so a channel that is exactly 0
 * stays exactly 0 under any of the three light values `ui/gcode-preview.ts` can tune. A
 * black or near-black filament therefore rendered as a flat, shapeless silhouette no
 * matter how that lighting was set: there is nothing for it to multiply. Scaling every
 * channel up so the brightest one reaches MIN_PEAK gives the shader something non-zero
 * to work with while keeping the color's own hue.
 *
 * True black gets its own, more generous floor: there is no hue to preserve for it, so
 * it can go all the way to a plainly visible mid grey rather than the subtler lift a
 * colored filament gets, the model should read as grey, not as a slightly-less-black
 * black.
 *
 * Its own module, not part of gcode-preview.ts, so a test can import this pure function
 * without also importing that file's top-level `localStorage.getItem(...)` reads, which
 * throw outside a browser.
 */
export function ensureShadable(hex: string): string {
  const clean = hex.replace(/^#/, '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const MIN_PEAK = 0.22;
  const BLACK_GREY = 0.4;
  const peak = Math.max(r, g, b);
  if (peak === 0) {
    const v = Math.round(BLACK_GREY * 255)
      .toString(16)
      .padStart(2, '0');
    return `#${v}${v}${v}`;
  }
  if (peak >= MIN_PEAK) return `#${clean}`;
  const scale = MIN_PEAK / peak;
  const lift = (c: number) =>
    Math.round(Math.min(c * scale, 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${lift(r)}${lift(g)}${lift(b)}`;
}
