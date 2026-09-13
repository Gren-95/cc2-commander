/**
 * State classes, as utilities.
 *
 * A "state" used to be one class that the stylesheet reacted to — `.main-tab.active`
 * turned a tab blue. With the stylesheet gone the class name means nothing on its own,
 * so the utilities each state implies live here and `toggleState` applies them.
 *
 * ## Why each entry has a `remove` as well as an `add`
 *
 * Two utilities setting the same property on one element have no defined winner:
 * Tailwind orders its own output, and the source cascade that used to decide is gone.
 * Adding `bg-accent text-white` on top of the base `bg-transparent text-fg-muted` is
 * therefore a coin toss — measured, it left the active tab with a near-transparent
 * background and dark text, i.e. invisible.
 *
 * So each entry also names what the state OVERRIDES, taken from the old stylesheet by
 * resolving the base alone and the base-plus-state and diffing both ways. Turning a
 * state on removes those; turning it off puts them back.
 *
 * The map is keyed state → base class → delta, because the same state means different
 * things on different components: `active` is a filled blue pill on a tab and an
 * underline on a sub-tab. The base class is still on the element (the code queries it),
 * so the right entry can be found at runtime.
 *
 * GENERATED from the stylesheet this replaced. If a state needs new styling, edit it
 * here — there is no CSS file to go back to.
 */

/** What a state adds, and what it overrides on the way. Both are class lists. */
export interface StateDelta {
  add: string;
  remove: string;
}

/**
 * What "selected" looks like on a chip, for every segmented picker in the app.
 *
 * There used to be five of these, one per hook, differing in which neutral classes they
 * removed — because each was generated from whatever the old stylesheet happened to say
 * for that one selector. They all mean the same thing, so they are now one delta against
 * one base (`CHIP` in `design.ts`). `remove` must name every neutral the base sets for a
 * property `add` also sets, or the two fight and the winner is undefined.
 */
const CHIP_ACTIVE: StateDelta = {
  add: 'bg-accent text-white border-accent',
  remove: 'bg-surface text-fg-soft border-line',
};

/**
 * Selected, on a segmented picker.
 *
 * Only the text colour, because the fill behind the label supplies the background —
 * adding `bg-accent` here would paint a second pill on top of the sliding one and the
 * slide would be invisible under it.
 */
const SEGMENT_ACTIVE: StateDelta = {
  add: 'text-white',
  remove: 'text-fg-soft',
};

export const STATE_UTILITIES: Record<string, Record<string, StateDelta>> = {
  active: {
    'chart-time-btn': CHIP_ACTIVE,
    'dist-btn': SEGMENT_ACTIVE,
    'file-source-tab': CHIP_ACTIVE,
    'list-sort-btn': CHIP_ACTIVE,
    'log-tab': CHIP_ACTIVE,
    'print-bed-btn': CHIP_ACTIVE,
    'speed-btn': SEGMENT_ACTIVE,
    'temp-preset-btn': CHIP_ACTIVE,
    'timelapse-play-btn': CHIP_ACTIVE,
    'main-tab': {
      add: 'bg-accent text-white max-[700px]:bg-transparent max-[700px]:text-accent max-[700px]:[box-shadow:inset_0_2px_0_0_var(--accent)]',
      remove: 'bg-transparent text-fg-muted',
    },
    'progress-fill': {
      add: "after:content-[''] after:absolute after:inset-0 after:[background:linear-gradient(_90deg,_transparent_0%,_rgba(255,_255,_255,_0.18)_40%,_rgba(255,_255,_255,_0.28)_50%,_rgba(255,_255,_255,_0.18)_60%,_transparent_100%_)] after:[animation:shimmer_2s_infinite]",
      remove: '',
    },
    subtab: { add: 'text-accent [border-bottom-color:var(--accent)]', remove: 'text-fg-muted' },
  },
  'at-target': {
    'bed-bar': { add: 'bg-ok', remove: 'bg-bed' },
    'nozzle-bar': { add: 'bg-ok', remove: 'bg-nozzle' },
  },
  collapsed: {
    card: {
      add: 'max-h-12 overflow-hidden [&>h3::after]:[transform:rotate(-90deg)] [&>.card-header_>_h3::after]:[transform:rotate(-90deg)] [&>.files-header_>_h3::after]:[transform:rotate(-90deg)] [&>.log-header_>_h3::after]:[transform:rotate(-90deg)]',
      remove: '',
    },
  },
  critical: {
    'exception-item': {
      add: 'bg-[rgba(239,_83,_80,_0.15)] text-bad border-l-3 border-bad',
      remove: '',
    },
  },
  disabled: {
    'file-upload-label': { add: 'opacity-[0.5] pointer-events-none', remove: '' },
  },
  heating: {
    'bed-bar': { add: '[animation:pulse_1.5s_infinite]', remove: '' },
    'nozzle-bar': { add: '[animation:pulse_1.5s_infinite]', remove: '' },
  },
  homed: {
    'home-dot': { add: 'bg-[var(--success,_#2ecc71)]', remove: 'bg-[var(--danger,_#e74c3c)]' },
  },
  pinned: {
    'slog-pin-btn': { add: 'opacity-[1]', remove: 'opacity-[0.3]' },
  },
  pulse: {
    'progress-fill': { add: '[animation:progress-pulse_0.4s_ease-out]', remove: '' },
    'progress-text-lg': { add: '[animation:progress-pulse_0.4s_ease-out]', remove: '' },
  },
  'svc-all-ok': {
    'svc-header-badge': { add: 'border-[rgba(34,_197,_94,_0.3)]', remove: '' },
  },
  'svc-has-err': {
    'svc-header-badge': { add: 'text-bad border-[rgba(239,_68,_68,_0.4)]', remove: 'text-fg-soft' },
  },
  'svc-printer-connecting': {
    'svc-header-badge': { add: 'border-[rgba(234,_179,_8,_0.45)]', remove: '' },
  },
  'svc-printer-disconnected': {
    'svc-header-badge': { add: 'border-[rgba(239,_68,_68,_0.45)]', remove: '' },
  },
  warning: {
    'exception-item': {
      add: 'bg-[rgba(255,_167,_38,_0.12)] text-warn border-l-3 border-warn',
      remove: '',
    },
  },
};
/**
 * Turn a state on or off: the hook class, what it implies, and what it overrides.
 *
 * The hook is kept because `classList.contains`, `querySelector` and the delegated
 * click handlers still look for it — only the styling moved.
 */
export function toggleState(el: Element, state: string, on: boolean): void {
  el.classList.toggle(state, on);
  const byBase = STATE_UTILITIES[state];
  if (!byBase) return;
  for (const base of Object.keys(byBase)) {
    if (!el.classList.contains(base)) continue;
    const { add, remove } = byBase[base];
    const applied = add.split(' ').filter(Boolean);
    const overridden = remove.split(' ').filter(Boolean);
    for (const u of applied) el.classList.toggle(u, on);
    // The mirror image: what the state overrides comes off with it, and back when it
    // goes. Without this the two fight and Tailwind's ordering picks the winner.
    for (const u of overridden) el.classList.toggle(u, !on);
  }
}
