/**
 * State classes, as utilities.
 *
 * A "state" used to be one class that the stylesheet reacted to — `.main-tab.active`
 * turned a tab blue. With the stylesheet gone the class name means nothing on its own,
 * so the utilities each state implies live here and `toggleState` applies them.
 *
 * The map is keyed state → base class → utilities, because the same state means
 * different things on different components: `active` is a filled blue pill on a tab
 * and an underline on a sub-tab. The base class is still on the element (the code
 * queries it), so the right entry can be found at runtime.
 *
 * GENERATED from the stylesheet this replaced. If a state needs new styling, edit it
 * here — there is no CSS file to go back to.
 */

export const STATE_UTILITIES: Record<string, Record<string, string>> = {
  active: {
    'chart-time-btn': 'bg-accent text-white',
    'dist-btn': 'bg-accent text-white border-accent',
    'file-source-tab': 'bg-accent text-white',
    'list-sort-btn': 'bg-accent-dim text-fg border-accent font-semibold',
    'log-tab': 'bg-accent text-white',
    'main-tab':
      'bg-accent text-white max-[700px]:bg-transparent max-[700px]:text-accent max-[700px]:[box-shadow:inset_0_2px_0_0_var(--accent)]',
    'print-bed-btn': 'bg-accent text-white',
    'progress-fill':
      "after:content-[''] after:absolute after:inset-0 after:[background:linear-gradient(_90deg,_transparent_0%,_rgba(255,_255,_255,_0.18)_40%,_rgba(255,_255,_255,_0.28)_50%,_rgba(255,_255,_255,_0.18)_60%,_transparent_100%_)] after:[animation:shimmer_2s_infinite]",
    'speed-btn': 'bg-accent text-white border-accent',
    subtab: 'text-accent [border-bottom-color:var(--accent)]',
  },
  'at-target': {
    'bed-bar': 'bg-ok',
    'nozzle-bar': 'bg-ok',
  },
  'capacity-high': {
    'capacity-fill': 'bg-warn',
  },
  'capacity-warn': {
    'capacity-fill': 'bg-[var(--error)]',
  },
  collapsed: {
    card: 'max-h-12 overflow-hidden [&>h3::after]:[transform:rotate(-90deg)] [&>.card-header_>_h3::after]:[transform:rotate(-90deg)] [&>.files-header_>_h3::after]:[transform:rotate(-90deg)] [&>.log-header_>_h3::after]:[transform:rotate(-90deg)]',
  },
  critical: {
    'exception-item': 'bg-[rgba(239,_83,_80,_0.15)] text-bad border-l-3 border-bad',
  },
  disabled: {
    'file-upload-label': 'opacity-[0.5] pointer-events-none',
  },
  expanded: {
    'log-payload':
      'whitespace-pre-wrap bg-surface [padding:6px_8px] rounded-[4px] [margin-top:2px] max-h-75 overflow-y-auto w-full',
  },
  heating: {
    'bed-bar': '[animation:pulse_1.5s_infinite]',
    'nozzle-bar': '[animation:pulse_1.5s_infinite]',
  },
  homed: {
    'home-dot': 'bg-[var(--success,_#2ecc71)]',
  },
  pinned: {
    'slog-pin-btn': 'opacity-[1]',
  },
  pulse: {
    'progress-fill': '[animation:progress-pulse_0.4s_ease-out]',
    'progress-text-lg': '[animation:progress-pulse_0.4s_ease-out]',
  },
  'svc-all-ok': {
    'svc-header-badge': 'border-[rgba(34,_197,_94,_0.3)]',
  },
  'svc-has-err': {
    'svc-header-badge': 'text-bad border-[rgba(239,_68,_68,_0.4)]',
  },
  'svc-printer-connecting': {
    'svc-header-badge': 'border-[rgba(234,_179,_8,_0.45)]',
  },
  'svc-printer-disconnected': {
    'svc-header-badge': 'border-[rgba(239,_68,_68,_0.45)]',
  },
  warning: {
    'exception-item': 'bg-[rgba(255,_167,_38,_0.12)] text-warn border-l-3 border-warn',
  },
};
/**
 * Turn a state on or off: the hook class plus everything it implies.
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
    for (const u of byBase[base].split(' ')) if (u) el.classList.toggle(u, on);
  }
}
