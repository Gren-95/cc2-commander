/**
 * The dashboard's visual system, as Tailwind class strings.
 *
 * There is no stylesheet to put this in — see the note at the top of
 * `src/styles/main.css` — so the shared vocabulary lives here as strings, imported by
 * the markup that needs it. Tailwind can see these literals, so the utilities are
 * generated.
 *
 * ## The idea: this is an instrument panel, not a dashboard of cards
 *
 * A machine panel separates two things, and so does this one:
 *
 *   READOUT    what the machine tells you. Borderless, sitting directly on the card
 *              ground, set large in a fixed-width face with `tabular-nums` so the
 *              digits do not jitter as they tick. Units are smaller and lighter than
 *              the value — the number is the content, the unit is a footnote.
 *   ACTUATOR   what you tell the machine. Bordered, tactile, grouped together.
 *
 * The split is structural rather than decorative: it is what makes it obvious at a
 * glance which parts of a card are safe to prod, on a page whose buttons heat a nozzle
 * and move a gantry.
 *
 * Two rules follow from it:
 *
 * - **The accent colour means "this control is engaged", and nothing else.** It used to
 *   be on progress bars, sliders and gauges as well, which left "selected" meaning
 *   nothing. Gauges and bars use the quantity's own colour instead.
 * - **A physical quantity keeps the printer's own colour.** Nozzle red, bed amber.
 *   Those tokens already existed because the machine uses them; the readouts inherit
 *   them rather than inventing a palette.
 *
 * ## Type
 *
 * One sans for language, one mono for measured values, on Tailwind's scale rather than
 * the ad-hoc 10/11/12/13/22px the old stylesheet had accumulated. Card titles are
 * sentence case — the old sheet upper-cased them, which shouted every heading at the
 * same volume and made the hierarchy flat.
 */

/* ── Card shells ─────────────────────────────────────────────────────── */

/**
 * The ordinary card. Quiet by design: a hairline border, no shadow, and a title that
 * recedes. Fifteen of these compete for attention if each one insists.
 */
export const CARD = [
  'bg-card rounded-xl border border-line p-4 min-w-0',
  // Title: sentence case, aligned with its icon, and a size below the body text.
  '[&_h3]:mb-3 [&_h3]:flex [&_h3]:items-center [&_h3]:gap-2',
  '[&_h3]:text-xs [&_h3]:font-semibold [&_h3]:tracking-wide [&_h3]:text-fg-muted',
].join(' ');

/**
 * The print status card. The one thing the page exists to answer, so it is the one
 * card allowed to look different: no border, a raised ground, and room to breathe.
 */
export const CARD_HERO = [
  'bg-raised rounded-xl border border-transparent p-5 min-w-0',
  '[&_h3]:mb-3 [&_h3]:flex [&_h3]:items-center [&_h3]:gap-2',
  '[&_h3]:text-xs [&_h3]:font-semibold [&_h3]:tracking-wide [&_h3]:text-fg-muted',
].join(' ');

/* ── Readouts ────────────────────────────────────────────────────────── */

/** The label above a readout. Sentence case, quiet, never shouting. */
export const LABEL = 'text-xs text-fg-muted';

/** A measured value. `tabular-nums` is the point: digits must not shift width. */
export const READOUT = 'font-mono text-2xl font-semibold tabular-nums leading-none text-fg';

/** A secondary value — a target, a maximum, the other half of a pair. */
export const READOUT_SM = 'font-mono text-base tabular-nums leading-none text-fg-soft';

/** The unit after a value. Deliberately smaller and lighter; it is a footnote. */
export const UNIT = 'text-xs text-fg-muted font-normal';

/** A row of readouts that should share a baseline. */
export const READOUT_ROW = 'flex items-baseline gap-1.5';

/* ── Gauges ──────────────────────────────────────────────────────────── */

/**
 * A gauge track. The fill carries the quantity's own colour, passed by the caller —
 * never the accent, which is reserved for controls.
 */
export const GAUGE = 'h-1 w-full rounded-full bg-line-soft overflow-hidden';
export const GAUGE_FILL = 'h-full rounded-full transition-[width] duration-500';

/* ── Actuators ───────────────────────────────────────────────────────── */

/** The ordinary button: bordered, so it reads as something to press. */
export const BTN = [
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap',
  'rounded-lg border border-line bg-surface px-3 py-1.5',
  'text-xs font-medium text-fg cursor-pointer',
  'transition-colors hover:bg-hover hover:border-fg-muted',
  'disabled:opacity-50 disabled:cursor-not-allowed',
].join(' ');

/** A button that does the main thing in its group. */
export const BTN_PRIMARY = [
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap',
  'rounded-lg border border-accent bg-accent px-3 py-1.5',
  'text-xs font-semibold text-white cursor-pointer',
  'transition-[filter] hover:brightness-110',
  'disabled:opacity-50 disabled:cursor-not-allowed',
].join(' ');

/** A square button carrying only a glyph. */
export const BTN_ICON = [
  'inline-flex items-center justify-center shrink-0',
  'h-8 w-8 rounded-lg border border-line bg-surface',
  'text-fg cursor-pointer transition-colors hover:bg-hover hover:border-fg-muted',
  'disabled:opacity-50 disabled:cursor-not-allowed',
].join(' ');

/**
 * The destructive icon button — emergency stop.
 *
 * Spelled out rather than `BTN_ICON + 'text-bad'`: both would set a colour, and two
 * utilities for one property have no defined winner. The neutral one won, and the stop
 * button came out the same grey as everything else.
 */
export const BTN_ICON_DANGER = [
  'inline-flex items-center justify-center shrink-0',
  'h-8 w-8 rounded-lg border border-bad bg-bad-dim',
  'text-bad cursor-pointer transition-colors hover:bg-bad hover:text-white',
].join(' ');

/** A text field or select. Matches the buttons so a control row lines up. */
export const FIELD = [
  'rounded-lg border border-line bg-input px-2.5 py-1.5',
  'text-xs text-fg tabular-nums',
  'focus:outline-none focus:border-accent',
].join(' ');

/** A row of controls: the actuator half of a card. */
export const CONTROL_ROW = 'flex flex-wrap items-center gap-2';

/** Separates the readout half of a card from the actuator half. */
export const DIVIDER = 'border-t border-line-soft my-3';

/**
 * A chip in a segmented picker — jog step, speed mode, chart range.
 *
 * The base must carry `bg-surface` and `border-line`, because `toggleState(el,
 * 'active')` swaps exactly those two for the accent and swaps them back. A chip
 * missing them renders correctly until the first click and then cannot return.
 */
export const CHIP = [
  'inline-flex items-center justify-center whitespace-nowrap',
  'rounded-full border border-line bg-surface px-3 py-1',
  'text-[11px] font-medium text-fg-soft cursor-pointer',
  'transition-colors hover:bg-hover',
  'pointer-coarse:min-h-9 pointer-coarse:px-3.5',
].join(' ');

/** A segmented picker. `LABEL` sits before it on the same line. */
/**
 * A segmented picker: one track, one fill that slides to the choice.
 *
 * The alternative — and what this replaced — is N separate chips with one filled. That
 * reads as N buttons that happen to be adjacent rather than as one control with N
 * positions, and it gives no sense of moving between settings. The fill is a single
 * element positioned by `ui/segmented.ts`, so the label widths can differ ("0.1mm" and
 * "Ludicrous" are not the same size) without the track needing equal columns.
 *
 * The edge is a **ring, not a border**. A ring is a box-shadow: it draws the hairline
 * without adding a border box, and an absolutely positioned child is offset from its
 * container's padding box while `offsetLeft` measures from the border box — so a real
 * 1px border would put the fill 1px out of step with the label it sits under.
 *
 * The hairline is not decoration. `--bg-input` and `--bg-card` are both #ffffff in the
 * light theme, so a track filled with `bg-input` on a card is invisible there and the
 * control reads as a stray blue pill with loose words beside it. Two tokens that happen
 * to be equal in one theme is a recurring trap in this palette.
 */
export const SEGMENTED =
  'segmented relative inline-flex items-center rounded-full bg-input ring-1 ring-line p-0.5';

/** One position in the track. Transparent: the fill behind it supplies the colour. */
export const SEGMENTED_BTN = [
  'segmented-btn relative z-[1]',
  'inline-flex items-center justify-center whitespace-nowrap',
  'rounded-full px-3 py-1',
  'text-[11px] font-medium text-fg-soft cursor-pointer',
  'transition-colors',
  'pointer-coarse:min-h-9 pointer-coarse:px-3.5',
].join(' ');

/** The fill. Width and X are set from the selected button; everything else is here. */
export const SEGMENTED_FILL = [
  'segmented-fill pointer-events-none absolute inset-y-0.5 left-0',
  'rounded-full bg-accent',
  '[transition:transform_180ms_ease,width_180ms_ease]',
  'motion-reduce:[transition:none]',
].join(' ');

export const CHIP_ROW = 'flex flex-wrap items-center gap-1.5';

/** A jog-pad key. Square, so the pad reads as a directional cross. */
export const JOG = [
  'inline-flex items-center justify-center',
  'h-10 w-full rounded-lg border border-line bg-surface',
  'font-mono text-xs font-semibold text-fg cursor-pointer',
  'transition-colors hover:bg-hover hover:border-fg-muted',
  'disabled:opacity-40 disabled:cursor-not-allowed',
].join(' ');

/** The home key, at the centre of the pad. Filled, because it is the pad's anchor. */
export const JOG_HOME = [
  'inline-flex items-center justify-center',
  'h-10 w-full rounded-lg border border-line bg-hover',
  'text-base text-fg cursor-pointer',
  'transition-colors hover:bg-surface hover:border-fg-muted',
  'disabled:opacity-40 disabled:cursor-not-allowed',
].join(' ');

/**
 * The homed/not-homed dot beside an axis readout.
 *
 * `toggleState(el, 'homed')` swaps the background, so the base carries the unhomed
 * colour and the element must keep its `home-dot` class — that class is the key the
 * state table is looked up by, not a style.
 */
export const DOT =
  'home-dot inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-bad transition-colors';

/** An on/off switch: the track, with the knob as its only child. */
export const SWITCH_TRACK = [
  // `toggle` is a hook, not a style — see the drag guard in `ui/settings.ts`.
  'toggle relative inline-block h-5 w-9 shrink-0 cursor-pointer rounded-full',
  'bg-line transition-colors',
  'has-[:checked]:bg-accent',
].join(' ');
export const SWITCH_KNOB = [
  'pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white',
  'transition-transform peer-checked:translate-x-4',
].join(' ');

/* ── Empty states ────────────────────────────────────────────────────── */

/**
 * What a card says when it has nothing to show.
 *
 * These were italic grey text floating in whatever height the card happened to have —
 * the Canvas card reserved 500px for one line of "No Canvas/AMS detected". An empty
 * state is a real state of the card, so it gets a shape: centred, bounded, with the
 * glyph carrying the recognition and the sentence carrying the explanation.
 */
export const EMPTY = [
  'flex flex-col items-center justify-center gap-2',
  'px-4 py-8 text-center text-xs text-fg-muted',
  '[&>i]:text-2xl [&>i]:opacity-40',
].join(' ');

/**
 * A subhead inside a card — the section titles under AI monitor, the chart pair's
 * names. Quieter than the card's own `h3`, and sentence case like it: the old sheet
 * upper-cased and letter-spaced every one of these, which gave a section label inside a
 * card the same visual weight as the card's title.
 */
export const SUBHEAD = 'text-xs font-medium text-fg-muted mb-1.5';

/**
 * A range slider — the g-code layer scrubber.
 *
 * `accent-color` alone leaves the browser's own control, which renders as a thick white
 * slab on a dark card. The track and thumb are styled explicitly instead; both vendor
 * prefixes are needed because neither browser accepts the other's pseudo-element, and a
 * selector list containing an unknown pseudo-element is dropped whole.
 */
export const RANGE = [
  'w-full cursor-pointer appearance-none bg-transparent',
  '[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full',
  '[&::-webkit-slider-runnable-track]:bg-line',
  '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:-mt-1.5',
  '[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4',
  '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent',
  '[&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-line',
  '[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:border-0',
  '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-accent',
].join(' ');
