/**
 * Dashboard card layout — the pure half.
 *
 * Deliberately free of DOM and localStorage so it can be unit-tested directly (the
 * test runner here is `bun test`, which has no document). `ui/settings.ts` owns the
 * storage and the rendering; everything that decides *what the layout is* lives here.
 *
 * THE SIDEBAR IS GONE
 *
 * This used to be two lists, `sidebar` and `main`, mirroring a fixed left rail and a
 * content area. That put the layout question in the wrong place: which cards you want
 * near the top is a per-user, per-printer choice, but "sidebar" also meant "narrow" and
 * "always visible", so choosing a position also chose a width and vice versa.
 *
 * Now there is ONE ordered list and a width per card. Order is order; width is width.
 * The old two-panel layouts are migrated rather than discarded — see
 * `normaliseCardLayout`.
 */

import { type IconName, icon } from './icons';

/**
 * How much of the grid a card takes.
 *
 * Named rather than numeric because the column count changes with the viewport (see
 * the `.card-w-*` rules in main.css): `compact` is a quarter of a wide desktop and a
 * half of a laptop, and everything is full width on a phone. A stored `3` would have
 * to mean one of those and be wrong on the others.
 */
export type CardWidth = 'compact' | 'wide' | 'full';

export const CARD_WIDTHS: readonly CardWidth[] = ['compact', 'wide', 'full'] as const;

export const CARD_WIDTH_LABELS: Record<CardWidth, string> = {
  compact: 'Compact',
  wide: 'Wide',
  full: 'Full width',
};

export interface CardLayout {
  /** Every known card, in the order it appears on the dashboard. */
  order: string[];
  hidden: string[];
  collapsed: string[];
  /** Width per card. Missing entries fall back to `defaultWidthFor`. */
  width: Record<string, CardWidth>;
  /** Schema version; see `LAYOUT_VERSION`. Absent on anything saved before widths
   *  became uniform. */
  v?: number;
}

/**
 * Bumped when a stored layout needs rewriting rather than merely reading.
 *
 * 2: widths became uniform. Cards used to default to three different spans by identity —
 * the old sidebar six were quarters, two log cards were full width, everything else a
 * half — which made a fresh dashboard look arbitrary rather than designed: at 1600px
 * that is 387px, 783px and 1576px cards in the same grid. A layout from before this
 * has its widths dropped once, so the uniform default applies; anything resized after
 * the reset is kept.
 */
const LAYOUT_VERSION = 2;

/**
 * The shipped order.
 *
 * Deliberately the old sidebar cards first, then the old main ones: that is the reading
 * order people already have, and a migration that reshuffles someone's dashboard is a
 * worse greeting than one that keeps it.
 */
export const DEFAULT_ORDER = [
  // The print status card. It lived at the top of the old sidebar and was never part
  // of the layout model, which in a single grid meant no width class and a card
  // rendered 1/12 of a screen wide. Managed like everything else now.
  'print-status-bar',
  'temps-card',
  'canvas-card',
  'fans-card',
  'toolhead-card',
  'speed-flow-card',
  'camera-card',
  'gcode-preview-card',
  'files-card',
  'print-history-card',
  'print-reports-card',
  'timelapse-card',
  'event-log-card',
  'log-card',
];

/** All known card IDs. */
export const ALL_CARD_IDS = [...DEFAULT_ORDER];

/**
 * The width every card gets unless it has been resized.
 *
 * One bucket, not three. `compact` is a quarter above 1500px, a third from 1101, a half
 * from 701 and full width below — so the grid is regular at every breakpoint instead of
 * only at the one it was tuned for. Cards that genuinely want the room (the MQTT log,
 * the event log) can still be widened in edit mode; the point is that the *default* is
 * uniform rather than a table of exceptions nobody can predict.
 */
const UNIFORM_WIDTH: CardWidth = 'compact';

/**
 * The grid span each width means, mobile-first.
 *
 * Written with `min-[…]` rather than `max-[…]` deliberately. Tailwind does not order
 * overlapping arbitrary max-width variants by breakpoint, so `max-[1100px]:col-[span_6]`
 * and `max-[700px]:col-[span_12]` both applied at 390px and the WIDER one won — every
 * card came out half-width on a phone, overlapping its neighbour. Ascending `min-*`
 * variants have an unambiguous order: the largest matching one wins, which is the
 * cascade this needs.
 *
 * Breakpoints match the rules this replaced: ≤700 one column, 701–1100 halves,
 * 1101–1500 thirds, wider still quarters.
 */
export const CARD_WIDTH_UTILITIES: Record<CardWidth, string> = {
  compact:
    'col-[span_12] min-[701px]:col-[span_6] min-[1101px]:col-[span_4] min-[1501px]:col-[span_3]',
  wide: 'col-[span_12] min-[1101px]:col-[span_6]',
  full: 'col-[span_12]',
};

export function defaultWidthFor(_id: string): CardWidth {
  return UNIFORM_WIDTH;
}

/** Display names for cards, as **HTML fragments** — each carries a Bootstrap Icon. */
export const CARD_NAMES: Record<string, string> = {
  'print-status-bar': `${icon('print')} Print Status`,
  'temps-card': `${icon('temperature')} Temperatures`,
  'canvas-card': `${icon('canvas')} Canvas / AMS`,
  'camera-card': `${icon('camera')} Camera`,
  'event-log-card': `${icon('eventLog')} Event Log`,
  'gcode-preview-card': `${icon('gcode')} Layer Preview`,
  'toolhead-card': `${icon('toolhead')} Toolhead`,
  'fans-card': `${icon('fans')} Fans`,
  'speed-flow-card': `${icon('speed')} Speed & Flow`,
  'files-card': `${icon('files')} Files`,
  'print-history-card': `${icon('history')} Print History`,
  'print-reports-card': `${icon('reports')} Print Reports`,
  'timelapse-card': `${icon('timelapse')} Timelapse`,
  'log-card': `${icon('mqttLog')} MQTT Log`,
};

/**
 * One glyph per card, for the mobile focus rail — where there is no room for a label.
 *
 * Separate from `CARD_NAMES` because that is an HTML fragment (icon **and** text) meant
 * for the settings list; the rail needs the icon's NAME so it can size and colour it
 * itself. Keep the two in step: a card added to one belongs in the other.
 */
/**
 * The card's name as plain text.
 *
 * `CARD_NAMES` values are **HTML** — each is an `<i>` glyph followed by the words — so
 * they are safe to drop into an element's contents and actively unsafe anywhere else.
 * Interpolated into `title="…"` or `aria-label="…"` the tag closes the attribute and the
 * rest of the markup lands on screen as text, which is exactly what edit mode's first
 * build did: every card grew a stray `label="Remove` beside it.
 */
export function cardNameText(id: string): string {
  return (CARD_NAMES[id] ?? id).replace(/<[^>]*>/g, '').trim();
}

export const CARD_ICONS: Record<string, IconName> = {
  'print-status-bar': 'print',
  'temps-card': 'temperature',
  'canvas-card': 'canvas',
  'camera-card': 'camera',
  'event-log-card': 'eventLog',
  'gcode-preview-card': 'gcode',
  'toolhead-card': 'toolhead',
  'fans-card': 'fans',
  'speed-flow-card': 'speed',
  'files-card': 'files',
  'print-history-card': 'history',
  'print-reports-card': 'reports',
  'timelapse-card': 'timelapse',
  'log-card': 'mqttLog',
};

/**
 * A hue per card, for the mobile focus rail.
 *
 * Fifteen identical grey buttons are a memory test — the rail is used by reaching for
 * a position, and colour is what makes that reachable without reading fifteen
 * tooltips. Each card keeps its hue wherever it sits in the order.
 *
 * Chosen at a single saturation and lightness so they read as one set rather than a
 * ransom note, and so each stays legible on both themes: the rail tints the button at
 * low alpha when idle and fills it solid when focused, and a mid-lightness hue has
 * enough contrast either way. Related cards share a family — the two logs are both
 * violet, the print-history/reports pair both teal — so the rail groups by eye.
 */
export const CARD_ACCENTS: Record<string, string> = {
  'print-status-bar': '#3b82f6', // blue — the job itself
  'temps-card': '#ef4444', // red — heat
  'canvas-card': '#f97316', // orange — filament
  'fans-card': '#06b6d4', // cyan — air
  'toolhead-card': '#8b5cf6', // violet — motion
  'speed-flow-card': '#eab308', // amber — rate
  'camera-card': '#ec4899', // pink — vision
  'gcode-preview-card': '#22c55e', // green — geometry
  'files-card': '#0ea5e9', // sky — storage
  'print-history-card': '#14b8a6', // teal — records
  'print-reports-card': '#10b981', // emerald — records
  'timelapse-card': '#a855f7', // purple — media
  'event-log-card': '#6366f1', // indigo — logs
  'log-card': '#7c3aed', // violet — logs
};

/** Shown when every card is visible at once, i.e. the scrolling dashboard. */
export const FOCUS_ALL = 'all';

/** The cards a user can actually focus: layout order, minus the hidden ones. */
export function focusableCards(layout: CardLayout): string[] {
  return layout.order.filter((id) => !layout.hidden.includes(id));
}

/**
 * Which card the focus rail should show.
 *
 * A saved choice can go stale — the card may have been hidden in Settings since, or
 * removed from the app entirely — and silently showing an empty dashboard would look
 * like a bug. So a stale choice falls back to the first visible card rather than being
 * honoured or cleared.
 *
 * `FOCUS_ALL` always passes through: it cannot go stale, and it is the escape hatch
 * back to the scrolling dashboard.
 */
export function resolveFocus(layout: CardLayout, saved: string | null | undefined): string {
  if (saved === FOCUS_ALL) return FOCUS_ALL;
  const focusable = focusableCards(layout);
  if (saved && focusable.includes(saved)) return saved;
  return focusable[0] ?? FOCUS_ALL;
}

/** A fresh copy of the shipped layout. Fresh, because callers mutate what they get. */
export function defaultCardLayout(): CardLayout {
  return {
    order: [...DEFAULT_ORDER],
    hidden: [],
    collapsed: [],
    width: Object.fromEntries(DEFAULT_ORDER.map((id) => [id, defaultWidthFor(id)])),
    v: LAYOUT_VERSION,
  };
}

/** Strings only — a hand-edited or half-written layout should not poison the DOM pass. */
function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === 'string');
}

function isCardWidth(value: unknown): value is CardWidth {
  return typeof value === 'string' && (CARD_WIDTHS as readonly string[]).includes(value);
}

/** Only recognised widths survive; anything else falls back to the card's default. */
function widthMap(value: unknown): Record<string, CardWidth> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, CardWidth> = {};
  for (const [id, w] of Object.entries(value as Record<string, unknown>)) {
    if (isCardWidth(w)) out[id] = w;
  }
  return out;
}

/**
 * Turn whatever was in storage into a layout that is safe to apply.
 *
 * Four jobs, and the last two both have history behind them:
 *
 * 1. Defaults for anything absent, and non-strings dropped.
 * 2. **Two older formats migrated** — `{ order, hidden }` from before panels existed,
 *    and `{ sidebar, main, … }` from while they did. A two-panel layout becomes
 *    sidebar-then-main in one list, with the sidebar half defaulting to `compact`, so
 *    an existing dashboard comes back looking like itself.
 * 3. **Every known card placed.** A card added to the app after a user last saved their
 *    layout is in no list, and before ELEG-44 this backfill lived in `applyCardLayout`
 *    — which mutated its in-memory copy but never saved it, while the settings panel
 *    re-read straight from storage. So the new card rendered on the dashboard but was
 *    missing from the settings list, and the next reorder saved a layout that still did
 *    not mention it. Doing it here means both paths see the same layout.
 * 4. No card listed twice, whatever storage claimed.
 */
export function normaliseCardLayout(parsed: unknown): CardLayout {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return defaultCardLayout();
  }
  const fields = parsed as Record<string, unknown>;

  // The two-panel format: concatenated, sidebar first, so the dashboard reads the same
  // way it did before the panels were removed.
  const sidebar = stringArray(fields.sidebar);
  const main = stringArray(fields.main);
  const twoPanel = sidebar !== null || main !== null;

  const order = twoPanel
    ? [...(sidebar ?? []), ...(main ?? [])]
    : (stringArray(fields.order) ?? [...DEFAULT_ORDER]);

  // A layout from before widths were uniform keeps its order, its hidden set and its
  // collapsed set — only the widths go, because those were assigned by card identity
  // rather than chosen by anyone. Resizing after the reset is recorded normally and
  // survives, since the version is stamped below.
  const stale = fields.v !== LAYOUT_VERSION;

  const layout: CardLayout = {
    order,
    hidden: stringArray(fields.hidden) ?? [],
    collapsed: stringArray(fields.collapsed) ?? [],
    width: stale ? {} : widthMap(fields.width),
    v: LAYOUT_VERSION,
  };

  const seen = new Set<string>();
  layout.order = layout.order.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  for (const id of ALL_CARD_IDS) {
    if (seen.has(id)) continue;
    layout.order.push(id);
    seen.add(id);
  }

  // Anything without a width of its own takes the uniform default.
  for (const id of layout.order) {
    if (!layout.width[id]) layout.width[id] = defaultWidthFor(id);
  }

  return layout;
}

/** The width to render a card at, whatever the stored layout does or does not say. */
/** How wide each width bucket is, as a fraction of the 12-column grid. */
const WIDTH_COLUMNS: Record<CardWidth, number> = { compact: 3, wide: 6, full: 12 };

/**
 * Move `moved` so it sits before `target` in the order.
 *
 * Pure, and here rather than in `dashboard-edit.ts` so both edit interfaces can reach
 * it without importing each other. The index arithmetic of "remove then insert" is
 * off-by-one in one direction only — removing an earlier element shifts the target
 * index down — and that is exactly the kind of bug that looks like a flaky drag.
 */
export function reorder(order: string[], moved: string, target: string): string[] {
  if (moved === target) return [...order];
  const next = order.filter((id) => id !== moved);
  const at = next.indexOf(target);
  if (at === -1) return [...order];
  next.splice(at, 0, moved);
  return next;
}

/**
 * The width bucket closest to a dragged pixel width.
 *
 * Snapping rather than free resize keeps the saved layout in the three named buckets
 * the rest of the app already understands — `compact` is a quarter of a wide desktop
 * and a half of a laptop, so a stored pixel width would be wrong at every other size.
 */
export function widthForColumns(columns: number): CardWidth {
  let best: CardWidth = 'compact';
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const w of CARD_WIDTHS) {
    const delta = Math.abs(WIDTH_COLUMNS[w] - columns);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = w;
    }
  }
  return best;
}

export function widthOf(layout: CardLayout, id: string): CardWidth {
  return layout.width[id] ?? defaultWidthFor(id);
}
