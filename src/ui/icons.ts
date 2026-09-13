/**
 * Bootstrap Icons, in one place.
 *
 * Every glyph the UI draws is named here rather than written inline, for the reason the
 * emoji this replaced were a problem in the first place: an emoji is rendered by
 * whatever font the *viewer's* OS supplies, so the same markup was a flat monochrome
 * pictogram on one machine, a full-colour cartoon on another, and a tofu box on the
 * Linux boxes this service is most often opened from. A webfont we ship ourselves
 * (see the @import at the top of src/styles/main.css) renders identically everywhere
 * and inherits `currentColor`, so icons finally match the text beside them.
 *
 * Two call shapes, and picking the wrong one is a security bug rather than a cosmetic
 * one:
 *
 *   `icon(name)`         returns an HTML string, for the `innerHTML` template literals
 *                        that most of src/ui renders through.
 *   `iconText(el, …)`    sets an element's content **without** innerHTML, for the many
 *                        `el.textContent = \`✓ ${userSuppliedThing}\`` sites. Those
 *                        interpolate filenames, error strings and printer status text;
 *                        rewriting them as innerHTML to fit an icon in would turn a
 *                        crafted filename into script execution.
 */

/** The subset of Bootstrap Icons this UI uses. Add here, not inline at the call site. */
export const ICONS = {
  // ── Navigation / chrome ──
  dashboard: 'printer',
  tools: 'calculator',
  settings: 'gear',
  debug: 'bug',
  help: 'question-circle',
  sidebar: 'layout-sidebar',
  close: 'x-lg',
  editLayout: 'grid-1x2',
  add: 'plus-lg',
  moveUp: 'chevron-up',
  moveDown: 'chevron-down',

  // ── Print control ──
  pause: 'pause-fill',
  resume: 'play-fill',
  play: 'play-fill',
  stop: 'stop-fill',
  estop: 'exclamation-octagon-fill',
  print: 'printer',
  home: 'house',

  // ── Cards ──
  temperature: 'thermometer-half',
  canvas: 'palette',
  camera: 'camera-video',
  ai: 'robot',
  eventLog: 'journal-text',
  gcode: 'bounding-box',
  toolhead: 'crosshair',
  fans: 'fan',
  speed: 'lightning-charge',
  files: 'folder',
  history: 'clock-history',
  reports: 'bar-chart',
  timelapse: 'film',
  mqttLog: 'list-columns',

  // ── Actions ──
  snapshot: 'camera',
  overlay: 'bar-chart-line',
  follow: 'geo-alt',
  singleLayer: 'search',
  load: 'folder2-open',
  reset: 'arrow-counterclockwise',
  upload: 'upload',
  download: 'download',
  exportFile: 'box-arrow-up',
  capture: 'record-circle',
  trash: 'trash',
  preview: 'image',
  pdf: 'file-earmark-pdf',
  pin: 'pin-angle',
  pinned: 'pin-angle-fill',
  refresh: 'arrow-repeat',
  expand: 'arrows-angle-expand',
  collapse: 'arrows-angle-contract',
  vibration: 'activity',
  minus: 'dash-lg',
  plus: 'plus-lg',
  dragHandle: 'grip-vertical',
  info: 'info-circle-fill',
  printing: 'arrow-repeat',
  printerOk: 'printer-fill',
  printerOff: 'plug',
  showAll: 'grid-3x3-gap',
  clipboard: 'clipboard',

  // ── Status ──
  ok: 'check-circle-fill',
  check: 'check-lg',
  cross: 'x-lg',
  error: 'x-circle-fill',
  warning: 'exclamation-triangle-fill',
  critical: 'exclamation-octagon-fill',
  unknown: 'question-circle',
  pending: 'hourglass-split',
  idle: 'circle',
  watching: 'eye',
  unwatched: 'circle',
  connected: 'circle-fill',
  disconnected: 'circle',
  powerLoss: 'lightning-charge-fill',
  heartbeat: 'activity',
  filament: 'bezier2',
  layer: 'layers',
  ruler: 'rulers',
  firstLayer: 'award',
  zone: 'arrow-return-right',
  link: 'link-45deg',
  unplug: 'plug',
  clock: 'clock',
  duration: 'stopwatch',
  cached: 'lightning-charge',
  folder: 'folder-fill',
  file: 'file-earmark',
  extruder: 'hexagon',
  cool: 'snow',
  heat: 'brightness-high',
  inspect: 'search',
  calibrate: 'rulers',

  // ── Direction ──
  sent: 'arrow-right',
  received: 'arrow-left',
  up: 'arrow-up',
  down: 'arrow-down',
  expanded: 'caret-down-fill',
  collapsed: 'caret-right-fill',
  sortAsc: 'sort-up',
  sortDesc: 'sort-down',
  changeTo: 'arrow-right-short',
} as const;

export type IconName = keyof typeof ICONS;

/**
 * An icon as an HTML string, for the `innerHTML` templates — for the common case where
 * a label follows it.
 *
 * Carries the gap between glyph and text as a UTILITY, plus `bi-lead` as an inert
 * marker for anything that wants to find these.
 *
 * It was a bare `bi-lead` class until the Tailwind conversion, which moved
 * `.bi-lead { margin-inline-end: 0.4em }` onto the elements that carried it in
 * index.html — and left the ones built here at runtime with a class that styles
 * nothing. Every icon rendered from TypeScript lost its gap: toasts, list rows, the
 * About panel. The utility has to be in the string Tailwind can see, which is this one.
 *
 * A gap and not a blanket `.bi { margin-inline-end }` because the same element is used
 * both ways: `button.btn.btn-sm` is an icon-with-label in the camera card and an
 * icon-only button in the settings list, and no selector can tell them apart. Use
 * `iconSolo()` when the glyph stands alone, or the button ends up visibly off-centre.
 *
 * `aria-hidden` because the glyph never carries the accessible name — the button or the
 * text beside it does. A screen reader announcing "private use character" helps nobody.
 */
export function icon(name: IconName, extraClass = ''): string {
  const cls = extraClass ? ` ${extraClass}` : '';
  return `<i class="bi bi-${ICONS[name]} bi-lead [margin-inline-end:0.4em]${cls}" aria-hidden="true"></i>`;
}

/** An icon that is the whole content of its element — no trailing gap. */
export function iconSolo(name: IconName, extraClass = ''): string {
  const cls = extraClass ? ` ${extraClass}` : '';
  return `<i class="bi bi-${ICONS[name]}${cls}" aria-hidden="true"></i>`;
}

/**
 * Set an element to an icon followed by plain text, without going through innerHTML.
 *
 * This is the safe replacement for `el.textContent = '✗ ' + somethingUntrusted`. The
 * text is appended as a text node, so a filename containing `<script>` stays a
 * filename. Pass `label` to give the element an accessible name where the text alone
 * would not be enough.
 */
export function iconText(el: HTMLElement, name: IconName, text: string, label?: string): void {
  const i = document.createElement('i');
  // The gap only when something follows it — see `icon()`.
  i.className = text
    ? `bi bi-${ICONS[name]} bi-lead [margin-inline-end:0.4em]`
    : `bi bi-${ICONS[name]}`;
  i.setAttribute('aria-hidden', 'true');
  el.replaceChildren(i, document.createTextNode(text));
  if (label) el.setAttribute('aria-label', label);
}

/** The same, for an element that should show only the glyph. */
export function iconOnly(el: HTMLElement, name: IconName, label: string): void {
  iconText(el, name, '', label);
}
