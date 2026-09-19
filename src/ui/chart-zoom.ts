/**
 * Zooming a chart — the decisions, without the DOM.
 *
 * ## The wheel belongs to the page unless a modifier says otherwise
 *
 * Charts used to zoom on any wheel movement over them, and swallowed the event to do it. On
 * a dashboard made of charts that meant an ordinary scroll of the page stopped dead the
 * moment the pointer crossed one, and instead silently zoomed that chart as far as 10× (or
 * squashed it to 0.1×) — with nothing on screen to say why the data had gone strange. Ctrl
 * (or ⌘) plus the wheel is the convention for "zoom this, not the page", and it is also what
 * a trackpad pinch is reported as, so pinching still works.
 */

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 10;
const ZOOM_STEP = 1.25;

export interface WheelLike {
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * The zoom a wheel event asks for, or `null` when it is not a zoom gesture — in which case
 * the caller must leave the event alone so the page scrolls.
 */
export function wheelZoom(current: number, e: WheelLike): number | null {
  if (!e.ctrlKey && !e.metaKey) return null;
  // Sideways movement is not up or down; it used to count as "zoom in".
  if (e.deltaY === 0) return null;
  const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP; // down zooms out, up zooms in
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current * factor));
}

/**
 * The line drawn on a zoomed or panned chart.
 *
 * Plain text, on purpose: it is painted with `fillText` on a canvas, which draws exactly
 * the characters it is given. It used to be built with `icon()`, which returns HTML, so the
 * chart showed `<i class="bi bi-search …">` across its top edge.
 */
export function zoomIndicator(zoomFactor: number, panOffsetMs: number): string {
  const pan = panOffsetMs === 0 ? '' : ` · ${Math.round(-panOffsetMs / 1000)}s back`;
  return `${zoomFactor.toFixed(1)}x${pan} · double-click to reset`;
}
