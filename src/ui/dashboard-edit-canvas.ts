/**
 * The desktop edit canvas: the dashboard, arranged in place.
 *
 * Three interactions, and what they have in common is that the grid answers *during*
 * the gesture rather than after it:
 *
 *   reorder  drag a card; every `dragover` moves the dragged node in the DOM, and CSS
 *            grid reflows for free. You watch the layout you are about to get.
 *   resize   drag the corner; the width is applied on every `pointermove`, so the card
 *            snaps between compact/wide/full under the pointer.
 *   add      a panel on the left holds a live, scaled-down clone of every hidden card.
 *            Drag one onto the grid to place it, or click to append it.
 *
 * The first version did none of that: it read the drop target on `drop` and applied
 * the width on `pointerup`. Both worked and both felt broken, because a direct
 * manipulation interface that does not move while you manipulate it reads as a dead one.
 *
 * ## The card stays readable
 *
 * The chrome is a strip *above* each card plus an outline around it, never a veil over
 * it. An earlier version covered each card with a translucent accent panel, which turned
 * the grid into a field of identical rectangles: you could not tell which card you were
 * dragging, which is the one thing you need to know.
 *
 * The strip is absolutely positioned above the card, and the grid's row gap is widened
 * to make room. That widening is an **inline style** rather than a class on purpose:
 * `gap:10px` in the markup already sets `row-gap`, so a second utility touching the same
 * property would have no defined winner (the one-property rule in CLAUDE.md). An inline
 * style always wins, and is cleared on exit.
 *
 * ## Previews are clones, and clones must not carry ids
 *
 * A preview is the real card, `cloneNode(true)`, scaled down: honest for free, with no
 * thumbnail to regenerate when a card changes. But a clone brings every `id` in the
 * subtree with it, and a duplicate id makes `document.getElementById` return whichever
 * comes first in the document: the panel's dead copy, not the live card. Every id is
 * stripped. `<canvas>` pixels do not survive cloning either, so chart-heavy cards
 * preview as empty frames: a known and accepted limit.
 */

import {
  type CardLayout,
  CARD_NAMES,
  cardNameText,
  CARD_WIDTH_LABELS,
  type CardWidth,
  widthForColumns,
  widthOf,
} from './card-layout';
import { icon, iconSolo } from './icons';
import { getCardLayout, updateCardLayout } from './settings';

/** Room for the chrome strip that sits above each card while editing. */
const EDIT_ROW_GAP = '2.4rem';

/** How far a preview is scaled down in the picker panel. */
const PREVIEW_SCALE = 0.34;

/** The card being dragged within the grid, or null. */
let dragging: string | null = null;
/** The card being dragged in from the panel, or null. Never set with `dragging`. */
let adding: string | null = null;
let refresh: () => void = () => {};

const isVisible = (layout: CardLayout, id: string) => !layout.hidden.includes(id);

/* ── Chrome on each card ─────────────────────────────────────────────── */

function decorate(card: HTMLElement, layout: CardLayout): void {
  card.classList.add('relative');
  card.style.outline = '2px dashed color-mix(in srgb, var(--accent) 45%, transparent)';
  card.style.outlineOffset = '2px';

  let strip = card.querySelector<HTMLElement>('.edit-strip');
  if (!strip) {
    strip = document.createElement('div');
    strip.className =
      'edit-strip absolute -top-[1.85rem] left-0 right-0 z-[6] flex items-center gap-1.5 h-6 px-1 text-[11px] font-medium text-fg-soft';
    card.append(strip);
  }

  const name = CARD_NAMES[card.id] ?? card.id;
  const plain = cardNameText(card.id);
  strip.innerHTML =
    `<span class="edit-grip cursor-grab select-none leading-none text-fg-muted" title="Drag to move">${icon('dragHandle')}</span>` +
    `<span class="truncate">${name}</span>` +
    `<span class="edit-width ml-auto rounded-md bg-accent px-1.5 py-0.5 text-[10px] text-white">${CARD_WIDTH_LABELS[widthOf(layout, card.id)]}</span>` +
    `<button class="edit-dismiss inline-flex h-5 w-5 items-center justify-center rounded-md border border-bad bg-bad-dim text-bad cursor-pointer transition-colors hover:bg-bad hover:text-white" data-card-id="${card.id}" title="Remove ${plain}" aria-label="Remove ${plain}">${iconSolo('close')}</button>`;

  if (!card.querySelector('.edit-size')) {
    const grip = document.createElement('div');
    grip.className =
      'edit-size absolute bottom-1 right-1 z-[6] h-4 w-4 cursor-nwse-resize rounded-br-lg border-b-2 border-r-2 border-accent';
    grip.title = 'Drag to resize';
    card.append(grip);
  }
}

function undecorate(card: HTMLElement): void {
  card.querySelector('.edit-strip')?.remove();
  card.querySelector('.edit-size')?.remove();
  card.style.outline = '';
  card.style.outlineOffset = '';
  card.style.opacity = '';
  card.removeAttribute('draggable');
}

/* ── The picker panel ────────────────────────────────────────────────── */

/** A scaled-down live clone of a card, for the panel. */
function previewOf(card: HTMLElement): HTMLElement {
  const clone = card.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  for (const el of clone.querySelectorAll('[id]')) el.removeAttribute('id');
  for (const el of clone.querySelectorAll('.edit-strip, .edit-size')) el.remove();
  clone.style.display = '';
  clone.style.outline = '';
  clone.style.width = `${100 / PREVIEW_SCALE}%`;
  clone.style.transform = `scale(${PREVIEW_SCALE})`;
  clone.style.transformOrigin = 'top left';

  const frame = document.createElement('div');
  frame.className = 'pointer-events-none h-24 overflow-hidden rounded-lg border border-line bg-app';
  frame.append(clone);
  return frame;
}

function renderPanel(layout: CardLayout): void {
  const panel = document.getElementById('dashboard-edit-panel');
  if (!panel) return;

  // `document.getElementById` rather than the layout alone: `normaliseCardLayout`
  // deliberately keeps an id it does not recognise, so a layout saved before a card was
  // removed still names it. Offering that here would be a preview of nothing.
  const hidden = layout.order.filter(
    (id) => layout.hidden.includes(id) && document.getElementById(id),
  );

  panel.innerHTML =
    '<h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Add a card</h3>';

  if (!hidden.length) {
    panel.insertAdjacentHTML(
      'beforeend',
      '<p class="text-xs text-fg-muted">Every card is on the dashboard. Drag one in here, or use its × to take it off.</p>',
    );
    return;
  }

  for (const id of hidden) {
    const card = document.getElementById(id);
    if (!card) continue;

    const item = document.createElement('div');
    item.className = 'edit-add mb-3 cursor-grab rounded-lg p-1 transition-colors hover:bg-hover';
    item.draggable = true;
    item.dataset.cardId = id;
    item.title = `Drag ${cardNameText(id)} onto the dashboard, or click to add it`;

    // Revealed so the clone has something to render, then hidden again: the card is
    // `display:none` between renders, and a hidden subtree clones as an empty box.
    const wasHidden = card.style.display === 'none';
    if (wasHidden) card.style.display = '';
    item.append(previewOf(card));
    if (wasHidden) card.style.display = 'none';

    const label = document.createElement('div');
    label.className = 'mt-1 flex items-center gap-1.5 px-0.5 text-[11px] text-fg-soft';
    label.innerHTML = `${icon('add')}<span class="truncate">${CARD_NAMES[id] ?? id}</span>`;
    item.append(label);
    panel.append(item);
  }
}

/* ── Mode ────────────────────────────────────────────────────────────── */

export function setCanvasEditing(on: boolean, layout: CardLayout): void {
  const grid = document.getElementById('dashboard-grid');
  const panel = document.getElementById('dashboard-edit-panel');
  if (!grid) return;

  panel?.classList.toggle('hidden', !on);
  grid.style.rowGap = on ? EDIT_ROW_GAP : '';
  // The first row has no gap above it, only the grid's own padding, without this its
  // strips render behind the edit bar.
  grid.style.paddingTop = on ? EDIT_ROW_GAP : '';
  grid.style.paddingLeft = on && panel ? `${panel.offsetWidth + 20}px` : '';
  // The panel is fixed, so it would otherwise cover the left half of the bar that tells
  // you how to leave edit mode.
  const bar = document.getElementById('dashboard-edit-bar');
  if (bar) bar.style.marginLeft = on && panel ? `${panel.offsetWidth + 8}px` : '';

  for (const child of [...grid.children] as HTMLElement[]) {
    if (!child.id || !child.classList.contains('card')) continue;
    if (on && isVisible(layout, child.id)) {
      child.setAttribute('draggable', 'true');
      decorate(child, layout);
    } else {
      undecorate(child);
    }
  }

  if (on) renderPanel(layout);
}

/* ── Reorder, with the grid moving under the pointer ─────────────────── */

/** The visible card nearest the pointer, so a drop in a gap still lands predictably. */
function dropTargetFor(grid: HTMLElement, e: DragEvent): HTMLElement | null {
  const over = (e.target as HTMLElement | null)?.closest<HTMLElement>('.card') ?? null;
  if (over?.parentElement === grid && over.style.display !== 'none') return over;

  let best: HTMLElement | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const child of [...grid.children] as HTMLElement[]) {
    if (!child.classList.contains('card') || child.style.display === 'none') continue;
    const r = child.getBoundingClientRect();
    const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
    const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) {
      bestDist = dist;
      best = child;
    }
  }
  return best;
}

/** The DOM is the order while dragging; this is where it becomes the saved layout. */
function commitOrderFromDom(grid: HTMLElement): void {
  const order = [...grid.children]
    .map((c) => (c as HTMLElement).id)
    .filter((id): id is string => Boolean(id));
  updateCardLayout((l) => {
    // Ids the DOM does not carry (one from a newer build, which `normaliseCardLayout`
    // deliberately keeps) hold their relative order at the end rather than vanishing.
    const seen = new Set(order);
    l.order = [...order, ...l.order.filter((id) => !seen.has(id))];
  });
}

/* ── Wiring ──────────────────────────────────────────────────────────── */

export function bindCanvasEdit(grid: HTMLElement, onChange: () => void): void {
  refresh = onChange;

  grid.addEventListener('dragstart', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
    if (!card || card.parentElement !== grid || !card.querySelector('.edit-strip')) return;
    dragging = card.id;
    adding = null;
    card.style.opacity = '0.55';
    e.dataTransfer?.setData('text/plain', card.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });

  grid.addEventListener('dragend', () => {
    if (dragging) {
      const card = document.getElementById(dragging);
      if (card) card.style.opacity = '';
      commitOrderFromDom(grid);
      dragging = null;
      refresh();
    }
  });

  grid.addEventListener('dragover', (e) => {
    const id = dragging ?? adding;
    if (!id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = adding ? 'copy' : 'move';

    const moved = document.getElementById(id);
    const over = dropTargetFor(grid, e);
    if (!moved || !over || over === moved) return;

    // The whole trick: move the node now and let CSS grid reflow. There is no separate
    // placeholder to keep in sync, because the dragged card *is* the placeholder.
    const r = over.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    grid.insertBefore(moved, after ? over.nextSibling : over);
  });

  grid.addEventListener('drop', (e) => {
    const id = adding;
    if (!id) return;
    e.preventDefault();
    updateCardLayout((l) => {
      l.hidden = l.hidden.filter((h) => h !== id);
    });
    commitOrderFromDom(grid);
    adding = null;
    refresh();
  });

  grid.addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('.edit-dismiss')?.dataset.cardId;
    if (!id) return;
    updateCardLayout((l) => {
      if (!l.hidden.includes(id)) l.hidden.push(id);
    });
    refresh();
  });

  bindResize(grid);
  bindPanel(grid);
}

function bindPanel(grid: HTMLElement): void {
  const panel = document.getElementById('dashboard-edit-panel');
  if (!panel) return;

  panel.addEventListener('dragstart', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('.edit-add')?.dataset.cardId;
    if (!id) return;
    adding = id;
    dragging = null;
    // Revealed so it can act as its own placeholder while being dragged in.
    const card = document.getElementById(id);
    if (card) {
      card.style.display = '';
      card.style.opacity = '0.55';
    }
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
  });

  panel.addEventListener('dragend', () => {
    // Only reached when the drop did NOT land on the grid; the grid's own drop handler
    // clears `adding` first. Put the card back where it was.
    if (adding) {
      adding = null;
      refresh();
    }
  });

  panel.addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('.edit-add')?.dataset.cardId;
    if (!id) return;
    updateCardLayout((l) => {
      l.hidden = l.hidden.filter((h) => h !== id);
    });
    refresh();
  });

  // Dragging a card onto the panel takes it off the dashboard: the inverse of dragging
  // one out, and the gesture people try first once they have seen the panel.
  panel.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    panel.classList.add('ring-2', 'ring-bad');
  });
  panel.addEventListener('dragleave', () => panel.classList.remove('ring-2', 'ring-bad'));
  panel.addEventListener('drop', (e) => {
    panel.classList.remove('ring-2', 'ring-bad');
    const id = dragging;
    if (!id) return;
    e.preventDefault();
    commitOrderFromDom(grid);
    updateCardLayout((l) => {
      if (!l.hidden.includes(id)) l.hidden.push(id);
    });
    dragging = null;
    refresh();
  });
}

/**
 * Drag the corner to resize.
 *
 * Pointer events rather than HTML5 drag: a drag operation cannot report intermediate
 * positions usefully, and the width has to snap live, the point is to watch the card
 * become the size you are choosing, not to read a label describing it.
 */
function bindResize(grid: HTMLElement): void {
  let card: HTMLElement | null = null;
  let columnPx = 0;

  grid.addEventListener('pointerdown', (e) => {
    const grip = (e.target as HTMLElement).closest<HTMLElement>('.edit-size');
    if (!grip) return;
    card = grip.closest<HTMLElement>('.card');
    if (!card) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    // One column including its share of the gap: measured rather than assumed, because
    // the column count changes with the breakpoint, and the grid carries a left inset
    // for the panel while editing.
    const style = getComputedStyle(grid);
    const inner =
      grid.clientWidth -
      Number.parseFloat(style.paddingLeft || '0') -
      Number.parseFloat(style.paddingRight || '0');
    columnPx = inner / 12;
  });

  grid.addEventListener('pointermove', (e) => {
    const target = card;
    if (!target || columnPx <= 0) return;
    const left = target.getBoundingClientRect().left;
    const columns = Math.round((e.clientX - left) / columnPx);
    const width: CardWidth = widthForColumns(Math.max(1, Math.min(12, columns)));
    if (widthOf(getCardLayout(), target.id) === width) return;
    updateCardLayout((l) => {
      l.width[target.id] = width;
    });
    // `applyCardLayout` rebuilt the class list but left the chrome in place, so only the
    // badge needs saying again.
    const label = target.querySelector('.edit-width');
    if (label) label.textContent = CARD_WIDTH_LABELS[width];
  });

  for (const ev of ['pointerup', 'pointercancel'] as const) {
    grid.addEventListener(ev, () => {
      if (!card) return;
      card = null;
      refresh();
    });
  }
}
