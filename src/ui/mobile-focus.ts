/**
 * Mobile focus rail: one dashboard card at a time.
 *
 * On a phone the dashboard is one column, so fifteen cards become a very long scroll
 * and reaching the MQTT log means passing everything above it. The alternative used to
 * be hiding cards in Settings, which is a permanent decision made for a temporary need.
 *
 * This is the temporary version of that decision: a vertical rail down the right edge
 * with one glyph per visible card, showing exactly one card at a time. `All` is the
 * first entry and restores the scrolling dashboard, so nothing is taken away.
 *
 * Phone only, dashboard only. Above the breakpoint the rail is not rendered and the
 * focus is not applied: a desktop shows the grid it always did.
 */

import {
  CARD_ACCENTS,
  CARD_ICONS,
  type CardLayout,
  CARD_NAMES,
  FOCUS_ALL,
  focusableCards,
  resolveFocus,
} from './card-layout';
import { ICONS } from './icons';
import { loadUISettings, saveUISettings } from './ui-settings';
import { isSignedOut } from './auth';

/** Must match the `max-[700px]` / `min-[701px]` variants used throughout the markup. */
const PHONE = '(max-width: 700px)';

const RAIL_ID = 'mobile-focus-rail';

let onChange: (() => void) | null = null;
let mediaBound = false;

export function isPhone(): boolean {
  return typeof matchMedia === 'function' && matchMedia(PHONE).matches;
}

/** The focused card id, or `FOCUS_ALL`. Always `FOCUS_ALL` on a desktop. */
export function currentFocus(layout: CardLayout): string {
  if (!isPhone()) return FOCUS_ALL;
  return resolveFocus(layout, loadUISettings().mobileFocus);
}

/**
 * Should this card render?
 *
 * Asked by `applyCardLayout`, which owns visibility: putting the decision here rather
 * than letting this module set `style.display` itself means there is still exactly one
 * place that decides whether a card is on screen, and a layout change cannot silently
 * undo a focus (or the other way round).
 */
export function isCardVisible(layout: CardLayout, id: string): boolean {
  if (layout.hidden.includes(id)) return false;
  const focus = currentFocus(layout);
  return focus === FOCUS_ALL || focus === id;
}

/** Text for the rail's tooltip and accessible name, from the settings display name. */
function labelFor(id: string): string {
  const html = CARD_NAMES[id] ?? id;
  return html.replace(/<[^>]*>/g, '').trim() || id;
}

/**
 * A rail button, tinted with its card's hue.
 *
 * Colour is set inline rather than as a utility because the hue is per card and read
 * from a map at runtime: Tailwind only generates the classes it can see in the source,
 * so `bg-[${accent}]` would produce nothing at all.
 *
 * Idle is the hue at 18% over the card background with a coloured glyph; focused is the
 * hue solid with a white one. Colour is never the only signal: the focused button is
 * also the only one with a filled background, carries `aria-pressed`, and the glyph
 * itself differs per card.
 */
function button(
  id: string,
  iconName: string,
  label: string,
  active: boolean,
  accent: string,
): string {
  // Idle buttons carry their hue on the icon only, on the same neutral button as the rest
  // of the app. Each used to get a tinted fill and a tinted border as well, and fourteen of
  // those stacked down the edge of a phone read as a wall of colour rather than as a rail.
  // The focused one is still filled, so the choice stands out.
  const style = active
    ? `background:${accent};border-color:${accent};color:#fff`
    : `background:var(--bg-card);border-color:var(--border);color:${accent}`;
  return `
    <button
      type="button"
      class="mobile-focus-btn flex items-center justify-center w-11 h-11 shrink-0 rounded-chip border"
      style="${style}"
      data-focus="${id}"
      title="${label}"
      aria-label="${label}"
      aria-pressed="${active}"
    ><i class="bi bi-${iconName}" aria-hidden="true"></i></button>`;
}

/**
 * Draw (or remove) the rail.
 *
 * Rebuilt wholesale on every call: it is fifteen buttons and it has to track the
 * layout's order, hides and focus. Cheap enough not to warrant diffing.
 */
export function renderFocusRail(layout: CardLayout, visible: boolean): void {
  let rail = document.getElementById(RAIL_ID);

  // Signed out, the rail is thirteen buttons to places you cannot go, and on a phone it
  // sits on top of the sign-in card and clips the password field.
  if (!visible || !isPhone() || isSignedOut()) {
    rail?.remove();
    const grid = document.getElementById('dashboard-grid');
    if (grid) grid.style.paddingRight = '';
    return;
  }

  if (!rail) {
    rail = document.createElement('nav');
    rail.id = RAIL_ID;
    rail.setAttribute('aria-label', 'Focus a dashboard card');
    document.body.appendChild(rail);
  }

  /*
   * Fixed to the right edge and scrollable on its own: fifteen 44px targets plus gaps
   * is taller than a short phone in landscape, and the rail must not push the grid or
   * grow the page. It clears the bottom nav the same way the grid does.
   */
  rail.className =
    'fixed right-0 top-[var(--header-height)] z-[150] flex flex-col gap-1 p-1 overflow-y-auto ' +
    'bg-surface/95 border-l border-line rounded-l-card ' +
    '[max-height:calc(100vh_-_var(--header-height)_-_var(--bottom-nav-height))]';

  const focus = currentFocus(layout);
  rail.innerHTML = [
    /*
     * `All` gets the app accent and a grid glyph, not a card, so it should look like
     * neither one. It also must not reuse `dashboard`, which is the same printer glyph
     * the Print Status card already has: two identical buttons at the top of the rail.
     */
    button(FOCUS_ALL, ICONS.showAll, 'Show all cards', focus === FOCUS_ALL, 'var(--accent)'),
    ...focusableCards(layout).map((id) =>
      button(
        id,
        ICONS[CARD_ICONS[id] ?? 'print'],
        labelFor(id),
        focus === id,
        CARD_ACCENTS[id] ?? 'var(--accent)',
      ),
    ),
  ].join('');

  /*
   * The rail floats over the grid, so the grid needs room for it, without this the
   * right-hand edge of every card (the camera's Expand button, a chart's last label)
   * sits underneath and cannot be reached.
   *
   * Set inline, and measured from the rail itself rather than hardcoded. A utility
   * class does not work here: the grid already carries a `padding` SHORTHAND from the
   * 480px breakpoint, and a shorthand beats a longhand `pr-*` whenever Tailwind emits
   * it later, which it did, leaving the padding at 6px and the cards still under the
   * rail. An inline style has no such argument to lose.
   */
  const grid = document.getElementById('dashboard-grid');
  if (grid) grid.style.paddingRight = `${Math.ceil(rail.getBoundingClientRect().width) + 4}px`;

  for (const btn of rail.querySelectorAll('.mobile-focus-btn')) {
    btn.addEventListener('click', () => {
      const target = (btn as HTMLElement).dataset.focus;
      if (!target) return;
      saveUISettings({ mobileFocus: target });
      onChange?.();
      // A focused card is a new screenful; start it at the top.
      document.getElementById('dashboard-grid')?.scrollTo({ top: 0 });
    });
  }
}

/**
 * Re-apply the layout when the viewport crosses the phone breakpoint.
 *
 * Without this, rotating a phone or dragging a desktop window narrow leaves the rail
 * absent while the focus is still hiding fourteen cards: a dashboard with one card on
 * it and no way to get the rest back.
 */
export function watchBreakpoint(reapply: () => void): void {
  onChange = reapply;
  if (mediaBound || typeof matchMedia !== 'function') return;
  mediaBound = true;
  matchMedia(PHONE).addEventListener('change', () => reapply());
}
