/**
 * The phone edit interface: a reorder list, and nothing else.
 *
 * Below 700px the dashboard is a focus rail showing one card at a time
 * (`ui/mobile-focus.ts`), and the rail walks the cards in layout order. So order is the
 * one thing still worth changing on a phone, and it is the only thing this offers:
 *
 *   - ▲ / ▼ move a card one place. Buttons rather than drag, because a drag inside a
 *     scrolling list on a touchscreen fights the scroll: the gesture is ambiguous and
 *     the browser resolves it against you about half the time.
 *   - × takes a card off the dashboard, and hidden cards come back from chips below.
 *   - No resize at all. Every card on the rail is full width, so the three buckets have
 *     no meaning here and a control for them would be a lie.
 *
 * The list replaces the grid while it is open rather than floating over it. A phone has
 * no room for both, and arranging a list while a rail underneath re-renders on every
 * WebSocket frame is the kind of thing that scrolls itself out from under a thumb.
 */

import { type CardLayout, CARD_NAMES, cardNameText, reorder } from './card-layout';
import { icon, iconSolo } from './icons';
import { updateCardLayout } from './settings';

let refresh: () => void = () => {};

/** Ids in layout order that this build actually has a card for. */
function knownCards(layout: CardLayout): string[] {
  return layout.order.filter((id) => document.getElementById(id));
}

function rowHtml(id: string, index: number, total: number): string {
  const name = CARD_NAMES[id] ?? id;
  const plain = cardNameText(id);
  const nav = (dir: 'up' | 'down', disabled: boolean, glyph: 'moveUp' | 'moveDown') =>
    `<button class="edit-move inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-fg-soft cursor-pointer transition-colors hover:bg-hover disabled:opacity-35 disabled:cursor-not-allowed" data-card-id="${id}" data-dir="${dir}" ${disabled ? 'disabled' : ''} aria-label="Move ${plain} ${dir}">${iconSolo(glyph)}</button>`;

  return `<li class="flex items-center gap-2 rounded-xl border border-line bg-card p-2">
    <span class="text-fg-muted">${icon('dragHandle')}</span>
    <span class="min-w-0 flex-1 truncate text-sm text-fg">${name}</span>
    ${nav('up', index === 0, 'moveUp')}
    ${nav('down', index === total - 1, 'moveDown')}
    <button class="edit-dismiss inline-flex h-9 w-9 items-center justify-center rounded-lg border border-bad bg-bad-dim text-bad cursor-pointer transition-colors hover:bg-bad hover:text-white" data-card-id="${id}" aria-label="Remove ${plain}">${iconSolo('close')}</button>
  </li>`;
}

export function setListEditing(on: boolean, layout: CardLayout): void {
  const list = document.getElementById('dashboard-edit-list');
  const grid = document.getElementById('dashboard-grid');
  if (!list) return;

  list.classList.toggle('hidden', !on);
  // The rail and the list are alternatives, never both, and that means the rail's
  // *buttons* too. `#mobile-focus-rail` is `fixed … z-[150]`, so leaving it up puts a
  // column of 44px targets over the list's remove buttons: measured, every click on the
  // right-hand third of a row hit the rail instead.
  grid?.classList.toggle('hidden', on);
  document.getElementById('mobile-focus-rail')?.classList.toggle('hidden', on);
  if (!on) {
    list.innerHTML = '';
    return;
  }

  const known = knownCards(layout);
  const shown = known.filter((id) => !layout.hidden.includes(id));
  const hidden = known.filter((id) => layout.hidden.includes(id));

  const rows = shown.map((id, i) => rowHtml(id, i, shown.length)).join('');
  const chips = hidden
    .map(
      (id) =>
        `<button class="edit-restore inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-2 text-xs text-fg-soft cursor-pointer transition-colors hover:bg-hover hover:text-fg" data-card-id="${id}">${icon('add')}${CARD_NAMES[id] ?? id}</button>`,
    )
    .join('');

  list.innerHTML =
    `<ul class="flex flex-col gap-2">${rows}</ul>` +
    (hidden.length
      ? `<h3 class="mt-5 mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Hidden</h3><div class="flex flex-wrap gap-2">${chips}</div>`
      : '<p class="mt-5 text-xs text-fg-muted">Every card is on the dashboard.</p>');
}

export function bindListEdit(onChange: () => void): void {
  refresh = onChange;
  const list = document.getElementById('dashboard-edit-list');
  if (!list) return;

  list.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const move = target.closest<HTMLElement>('.edit-move');
    if (move?.dataset.cardId) {
      const id = move.dataset.cardId;
      const dir = move.dataset.dir;
      updateCardLayout((l) => {
        // Move relative to the cards actually on screen, not to raw `order`: `order`
        // also holds the hidden ones, so stepping through it would look like a button
        // that sometimes does nothing.
        const shown = knownCards(l).filter((c) => !l.hidden.includes(c));
        const at = shown.indexOf(id);
        const to = dir === 'up' ? at - 1 : at + 1;
        if (at === -1 || to < 0 || to >= shown.length) return;
        // Moving down means landing *after* the neighbour, which `reorder` expresses as
        // "before the one after it", or at the end when there is nothing after it.
        const anchor = dir === 'up' ? shown[to] : shown[to + 1];
        l.order = anchor ? reorder(l.order, id, anchor) : [...l.order.filter((c) => c !== id), id];
      });
      refresh();
      return;
    }

    const id =
      target.closest<HTMLElement>('.edit-dismiss')?.dataset.cardId ??
      target.closest<HTMLElement>('.edit-restore')?.dataset.cardId;
    if (!id) return;

    const restoring = Boolean(target.closest('.edit-restore'));
    updateCardLayout((l) => {
      l.hidden = restoring
        ? l.hidden.filter((h) => h !== id)
        : l.hidden.includes(id)
          ? l.hidden
          : [...l.hidden, id];
    });
    refresh();
  });
}
