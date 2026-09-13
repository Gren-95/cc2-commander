/**
 * Edit mode: arrange the dashboard on the dashboard.
 *
 * This module owns the *mode* — entering, leaving, undo, and the two pure decisions
 * (where a dragged card lands, which width bucket a drag means). The two interfaces
 * live beside it, because they share almost nothing beyond the layout they write:
 *
 *   `dashboard-edit-canvas.ts`  desktop. Drag to reorder with the grid reflowing under
 *                               the pointer, drag a corner to resize, and a side panel
 *                               of live previews to drag cards in from.
 *   `dashboard-edit-list.ts`    phone. A plain reorder list, and no resize at all.
 *
 * ## Why the phone gets a different interface rather than a smaller one
 *
 * Below 700px the dashboard shows ONE card at a time through the focus rail
 * (`ui/mobile-focus.ts`), and every card is full width. Resizing therefore means
 * nothing there, and dragging a grid you can see one cell of means little more. What
 * *does* still matter is order, because the rail walks the cards in layout order — so
 * the phone gets a reorder list, and the three width buckets are simply absent.
 *
 * ## All writes go through `updateCardLayout`
 *
 * Neither this module nor its two interfaces touches localStorage. `ui/settings.ts`
 * owns the key and the redraw; these decide what the new arrangement is and hand it
 * over. Two writers to one layout is how the grid and the mobile rail would come to
 * disagree about which cards exist — `applyCardLayout` already redraws both from one
 * source.
 *
 * ## Undo is a snapshot, not a command log
 *
 * Entering edit mode deep-copies the layout; **Cancel** writes that copy back. Every
 * intermediate change is still persisted as it happens, deliberately: a tab closed
 * mid-arrange should not lose the work, and the alternative — buffering and committing
 * on Done — means the grid you are looking at is not the layout that is saved, which is
 * the exact confusion this feature exists to remove.
 */

import type { CardLayout } from './card-layout';
import { bindCanvasEdit, setCanvasEditing } from './dashboard-edit-canvas';
import { bindListEdit, setListEditing } from './dashboard-edit-list';
import { getCardLayout, updateCardLayout } from './settings';

/** The viewport below which the focus rail owns the dashboard instead. */
const PHONE_MAX = 700;

let editing = false;
/** The layout as it was when edit mode was entered, for Cancel. */
let snapshot: CardLayout | null = null;

export function isEditingDashboard(): boolean {
  return editing;
}

export function isPhoneWidth(): boolean {
  return window.innerWidth <= PHONE_MAX;
}

/* ── Mode ────────────────────────────────────────────────────────────── */

/** Re-render whichever interface belongs at this width, from the saved layout. */
export function refreshEditUi(): void {
  const layout = getCardLayout();
  const phone = isPhoneWidth();
  setCanvasEditing(editing && !phone, layout);
  setListEditing(editing && phone, layout);
}

export function setDashboardEditing(on: boolean): void {
  if (on !== editing) {
    editing = on;
    snapshot = on ? structuredClone(getCardLayout()) : null;
  }

  const toggle = document.getElementById('btn-edit-dashboard');
  toggle?.classList.toggle('bg-accent', editing);
  toggle?.classList.toggle('text-white', editing);
  toggle?.setAttribute('aria-pressed', String(editing));
  if (toggle) toggle.title = editing ? 'Done editing' : 'Edit layout';

  document.getElementById('dashboard-edit-bar')?.classList.toggle('hidden', !editing);

  refreshEditUi();
  // Restores display/width/order for anything edit mode revealed.
  if (!editing) updateCardLayout(() => {});
}

/** Discard everything done since edit mode was entered. */
function cancelEditing(): void {
  const before = snapshot;
  if (before) {
    updateCardLayout((l) => {
      l.order = [...before.order];
      l.hidden = [...before.hidden];
      l.collapsed = [...before.collapsed];
      l.width = { ...before.width };
    });
  }
  setDashboardEditing(false);
}

/* ── Wiring ──────────────────────────────────────────────────────────── */

export function initDashboardEdit(): void {
  const grid = document.getElementById('dashboard-grid');
  const toggle = document.getElementById('btn-edit-dashboard');
  if (!grid || !toggle) return;

  toggle.addEventListener('click', () => setDashboardEditing(!editing));
  document
    .getElementById('btn-edit-done')
    ?.addEventListener('click', () => setDashboardEditing(false));
  document.getElementById('btn-edit-cancel')?.addEventListener('click', cancelEditing);

  // Crossing the breakpoint swaps which interface is mounted. Without this, a rotate
  // into phone width leaves the desktop chrome decorating cards the focus rail is about
  // to take over, and the picker panel covering a third of the screen.
  let wasPhone = isPhoneWidth();
  window.addEventListener('resize', () => {
    const nowPhone = isPhoneWidth();
    if (nowPhone !== wasPhone) {
      wasPhone = nowPhone;
      if (editing) refreshEditUi();
    }
  });

  bindCanvasEdit(grid, refreshEditUi);
  bindListEdit(refreshEditUi);
}
