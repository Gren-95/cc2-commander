import { STATE_UTILITIES } from './state-utilities';

/**
 * Turn a state on or off: the hook class, what it implies, and what it overrides.
 *
 * The hook is kept because `classList.contains`, `querySelector` and the delegated
 * click handlers still look for it, only the styling moved.
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
