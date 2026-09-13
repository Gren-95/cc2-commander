/**
 * Edit mode: arrange the dashboard on the dashboard.
 *
 * Drag a card to reorder it, drag its bottom-right corner to resize, click the × to
 * dismiss it, and pick dismissed cards out of a tray to bring them back. This replaces
 * the list of checkboxes, dropdowns and up/down buttons that used to live in Settings —
 * the thing being arranged is right there, so arranging it somewhere else was making
 * people hold a mapping in their head.
 *
 * ## Desktop only, and that is a design decision rather than a limitation
 *
 * Below 700px the dashboard shows ONE card at a time through the focus rail
 * (`ui/mobile-focus.ts`). Reordering a list you can only see one item of is not useful,
 * and drag-to-resize has nothing to resize when every card is full width. So the toggle
 * is hidden on a phone and edit mode is force-exited if the viewport crosses down —
 * otherwise a rotate could strand someone in a mode with no way out.
 *
 * ## All writes go through `updateCardLayout`
 *
 * This module never touches localStorage. `ui/settings.ts` owns the key and the redraw;
 * this one decides what the new arrangement is and hands it over. Two writers to one
 * layout is how the grid and the mobile rail would come to disagree about which cards
 * exist — `applyCardLayout` already redraws both from one source.
 */

import {
  type CardLayout,
  CARD_NAMES,
  type CardWidth,
  CARD_WIDTHS,
  CARD_WIDTH_LABELS,
  widthOf,
} from './card-layout';
import { $ } from './helpers';
import { icon, iconSolo } from './icons';
import { getCardLayout, updateCardLayout } from './settings';

/** The viewport below which the focus rail owns the dashboard instead. */
const PHONE_MAX = 700;

/** How wide each width bucket is, as a fraction of the 12-column grid. */
const WIDTH_COLUMNS: Record<CardWidth, number> = { compact: 3, wide: 6, full: 12 };

let editing = false;
/** The card currently being dragged, or null. */
let dragging: string | null = null;

export function isEditingDashboard(): boolean {
  return editing;
}

function isPhone(): boolean {
  return window.innerWidth <= PHONE_MAX;
}

/* ── Reordering ──────────────────────────────────────────────────────── */

/**
 * Move `moved` so it sits before `target` in the order.
 *
 * Pure, and exported for the tests: the index arithmetic of "remove then insert" is
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

/* ── Chrome on each card ─────────────────────────────────────────────── */

/** The controls edit mode adds to a card, and removes again on exit. */
function decorate(card: HTMLElement): void {
  if (card.querySelector('.edit-chrome')) return;

  const chrome = document.createElement('div');
  chrome.className =
    'edit-chrome absolute inset-0 z-[5] cursor-grab rounded-xl border-2 border-dashed border-accent/40 bg-accent/[0.06]';

  const dismiss = document.createElement('button');
  dismiss.className =
    'edit-dismiss absolute right-2 top-2 z-[6] inline-flex h-7 w-7 items-center justify-center rounded-lg border border-bad bg-bad-dim text-bad cursor-pointer transition-colors hover:bg-bad hover:text-white';
  dismiss.title = `Hide ${CARD_NAMES[card.id] ?? card.id}`;
  dismiss.setAttribute('aria-label', dismiss.title);
  dismiss.innerHTML = iconSolo('close');

  const grip = document.createElement('div');
  grip.className =
    'edit-size absolute bottom-1 right-1 z-[6] h-5 w-5 cursor-nwse-resize rounded-br-lg border-b-2 border-r-2 border-accent';
  grip.title = 'Drag to resize';

  const label = document.createElement('div');
  // Bottom-left, beside the resize grip it describes. Top-left covered the card's own
  // title on every card — the one piece of text you need to identify what you are
  // dragging.
  label.className =
    'edit-label pointer-events-none absolute bottom-1.5 left-2 z-[6] rounded-md bg-accent px-2 py-0.5 text-[11px] font-medium text-white';
  label.textContent = CARD_WIDTH_LABELS[widthOf(getCardLayout(), card.id)];

  card.classList.add('relative');
  card.append(chrome, dismiss, grip, label);
}

function undecorate(card: HTMLElement): void {
  for (const sel of ['.edit-chrome', '.edit-dismiss', '.edit-size', '.edit-label']) {
    card.querySelector(sel)?.remove();
  }
  card.removeAttribute('draggable');
}

/* ── The tray of dismissed cards ─────────────────────────────────────── */

function renderTray(layout: CardLayout): void {
  const tray = $('dashboard-edit-tray');
  // `document.getElementById` rather than the layout alone: `normaliseCardLayout`
  // deliberately keeps an id it does not recognise, so a layout saved before a card was
  // removed still names it (every layout saved before the AI monitor was deleted names
  // `ai-card`). Offering it here would be a chip that restores nothing.
  const hidden = layout.order.filter(
    (id) => layout.hidden.includes(id) && document.getElementById(id),
  );

  tray.classList.toggle('hidden', !editing);
  if (!editing) return;

  tray.innerHTML = hidden.length
    ? `<span class="text-xs text-fg-muted mr-1">Hidden:</span>${hidden
        .map(
          (id) =>
            `<button class="edit-restore inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-[11px] text-fg-soft cursor-pointer transition-colors hover:bg-hover hover:text-fg" data-card-id="${id}">${icon('add')}${CARD_NAMES[id] ?? id}</button>`,
        )
        .join('')}`
    : '<span class="text-xs text-fg-muted">Every card is on the dashboard. Drag to reorder, drag a corner to resize, or use × to hide one.</span>';
}

/* ── Mode ────────────────────────────────────────────────────────────── */

export function setDashboardEditing(on: boolean): void {
  // Guard rather than assert: the breakpoint watcher calls this on rotate, and a phone
  // must never be left in a mode whose controls are hidden.
  editing = on && !isPhone();

  const grid = document.getElementById('dashboard-grid');
  const toggle = document.getElementById('btn-edit-dashboard');
  if (!grid) return;

  grid.classList.toggle('is-editing', editing);
  toggle?.classList.toggle('bg-accent', editing);
  toggle?.classList.toggle('text-white', editing);
  toggle?.setAttribute('aria-pressed', String(editing));
  if (toggle) toggle.title = editing ? 'Done editing' : 'Edit layout';

  const layout = getCardLayout();
  for (const child of [...grid.children] as HTMLElement[]) {
    if (!child.id || !child.classList.contains('card')) continue;
    if (editing) {
      // Hidden cards are shown greyed while editing, so "add it back" and "it is off"
      // are the same picture rather than two different screens.
      if (layout.hidden.includes(child.id)) {
        child.style.display = '';
        child.classList.add('opacity-40');
      }
      child.setAttribute('draggable', 'true');
      decorate(child);
    } else {
      child.classList.remove('opacity-40');
      undecorate(child);
    }
  }

  renderTray(layout);
  // Restores display/width/order for anything edit mode revealed.
  if (!editing) updateCardLayout(() => {});
}

/* ── Wiring ──────────────────────────────────────────────────────────── */

export function initDashboardEdit(): void {
  const grid = document.getElementById('dashboard-grid');
  const toggle = document.getElementById('btn-edit-dashboard');
  if (!grid || !toggle) return;

  toggle.classList.toggle('hidden', isPhone());
  toggle.addEventListener('click', () => setDashboardEditing(!editing));

  // A rotate into phone width must not strand someone in a mode with no visible exit.
  window.addEventListener('resize', () => {
    toggle.classList.toggle('hidden', isPhone());
    if (editing && isPhone()) setDashboardEditing(false);
  });

  grid.addEventListener('dragstart', (e) => {
    if (!editing) return;
    const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
    if (!card) return;
    dragging = card.id;
    card.classList.add('opacity-60');
    e.dataTransfer?.setData('text/plain', card.id);
  });

  grid.addEventListener('dragend', () => {
    if (dragging) document.getElementById(dragging)?.classList.remove('opacity-60');
    dragging = null;
  });

  grid.addEventListener('dragover', (e) => {
    if (editing && dragging) e.preventDefault();
  });

  grid.addEventListener('drop', (e) => {
    if (!editing || !dragging) return;
    e.preventDefault();
    const over = (e.target as HTMLElement).closest<HTMLElement>('.card');
    const moved = dragging;
    if (!over || over.id === moved) return;
    updateCardLayout((l) => {
      l.order = reorder(l.order, moved, over.id);
    });
    setDashboardEditing(true);
  });

  grid.addEventListener('click', (e) => {
    if (!editing) return;
    const target = e.target as HTMLElement;

    const dismiss = target.closest<HTMLElement>('.edit-dismiss');
    if (dismiss) {
      const card = dismiss.closest<HTMLElement>('.card');
      if (card) {
        updateCardLayout((l) => {
          if (!l.hidden.includes(card.id)) l.hidden.push(card.id);
        });
        setDashboardEditing(true);
      }
      return;
    }

    // Clicking a greyed-out card brings it back — the inverse of ×, in the same place.
    const card = target.closest<HTMLElement>('.card');
    if (card && getCardLayout().hidden.includes(card.id)) {
      updateCardLayout((l) => {
        l.hidden = l.hidden.filter((id) => id !== card.id);
      });
      setDashboardEditing(true);
    }
  });

  $('dashboard-edit-tray').addEventListener('click', (e) => {
    const restore = (e.target as HTMLElement).closest<HTMLElement>('.edit-restore');
    const id = restore?.dataset.cardId;
    if (!id) return;
    updateCardLayout((l) => {
      l.hidden = l.hidden.filter((h) => h !== id);
    });
    setDashboardEditing(true);
  });

  bindResize(grid);
}

/**
 * Drag the corner to resize.
 *
 * Pointer events rather than HTML5 drag: a drag operation cannot report intermediate
 * positions usefully, and the width needs to snap live so the label reads the bucket
 * you are about to get rather than the one you had.
 */
function bindResize(grid: HTMLElement): void {
  let card: HTMLElement | null = null;
  let columnPx = 0;

  grid.addEventListener('pointerdown', (e) => {
    if (!editing) return;
    const grip = (e.target as HTMLElement).closest<HTMLElement>('.edit-size');
    if (!grip) return;
    card = grip.closest<HTMLElement>('.card');
    if (!card) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    // One column, including its share of the gap — measured rather than assumed,
    // because the column count changes with the breakpoint.
    columnPx = grid.getBoundingClientRect().width / 12;
  });

  grid.addEventListener('pointermove', (e) => {
    if (!card) return;
    const left = card.getBoundingClientRect().left;
    const columns = Math.round((e.clientX - left) / columnPx);
    const width = widthForColumns(Math.max(1, Math.min(12, columns)));
    const label = card.querySelector('.edit-label');
    if (label) label.textContent = CARD_WIDTH_LABELS[width];
    card.dataset.pendingWidth = width;
  });

  grid.addEventListener('pointerup', () => {
    const target = card;
    card = null;
    const width = target?.dataset.pendingWidth as CardWidth | undefined;
    if (!target || !width) return;
    delete target.dataset.pendingWidth;
    updateCardLayout((l) => {
      l.width[target.id] = width;
    });
    setDashboardEditing(true);
  });
}
