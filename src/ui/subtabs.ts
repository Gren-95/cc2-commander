/**
 * Sub-tabs: a strip of buttons that swap sibling panels within one main tab.
 *
 * Extracted when Tools gained a second tool. The original version queried `.subtab`
 * across the whole document, which was fine while About was the only strip and wrong
 * the moment there were two — clicking a tool would have deactivated Help and Debug.
 * Every lookup here is scoped to a group.
 *
 * ## Markup contract
 *
 *   <nav class="subtab-strip" data-subtab-group="tools">
 *     <button class="subtab" data-subtab="dryer">…</button>
 *   </nav>
 *   <section id="tools-subtab-dryer">…</section>
 *
 * The panel id is `${group}-subtab-${name}`, so a strip and its panels need no wiring
 * beyond matching names.
 */

import { toggleState } from './state-classes';
import { loadUISettings, saveUISettings } from './ui-settings';

const bound = new Set<string>();
const listeners = new Map<string, (name: string) => void>();

function strip(group: string): HTMLElement | null {
  return document.querySelector(`[data-subtab-group="${group}"]`);
}

function buttons(group: string): HTMLElement[] {
  return [...(strip(group)?.querySelectorAll('.subtab') ?? [])] as HTMLElement[];
}

/** The names a group offers, in markup order. */
export function subtabNames(group: string): string[] {
  return buttons(group)
    .map((b) => b.dataset.subtab ?? '')
    .filter(Boolean);
}

/**
 * Show one panel of a group.
 *
 * Hides by name rather than by "everything except": a panel whose button was removed
 * would otherwise stay on screen forever.
 */
export function switchSubtab(group: string, name: string): void {
  const names = subtabNames(group);
  const target = names.includes(name) ? name : (names[0] ?? name);

  for (const btn of buttons(group)) {
    const on = btn.dataset.subtab === target;
    toggleState(btn, 'active', on);
    btn.setAttribute('aria-selected', String(on));
  }
  for (const n of names) {
    document.getElementById(`${group}-subtab-${n}`)?.classList.toggle('hidden', n !== target);
  }

  const saved = { ...loadUISettings().subtabs, [group]: target };
  saveUISettings({ subtabs: saved });
  listeners.get(group)?.(target);
}

/** The remembered choice for a group, falling back to the first button. */
export function savedSubtab(group: string): string {
  const saved = loadUISettings().subtabs?.[group];
  const names = subtabNames(group);
  return saved && names.includes(saved) ? saved : (names[0] ?? '');
}

/**
 * Wire a group's buttons and show its remembered panel.
 *
 * Idempotent — called every time the parent tab opens, because the panels may not have
 * existed when the page loaded.
 */
export function bindSubtabs(group: string, onSwitch?: (name: string) => void): void {
  if (onSwitch) listeners.set(group, onSwitch);
  if (!bound.has(group)) {
    if (!strip(group)) return; // not in the DOM yet; try again on the next open
    bound.add(group);
    for (const btn of buttons(group)) {
      btn.addEventListener('click', () => switchSubtab(group, btn.dataset.subtab ?? ''));
    }
  }
  switchSubtab(group, savedSubtab(group));
}
