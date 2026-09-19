/**
 * Tools → Inventory.
 *
 * What is on the shelf (spools, with how much filament each has left) and a queue of
 * finished prints the service could not attribute to a spool on its own:
 * `workshop/inventory-core.ts` has the matching rules and why a queue beats a guess;
 * this file only draws it and saves what is typed.
 *
 * ## Three static siblings, not one re-rendered panel
 *
 * A finished print can add a queued item at any moment, so the whole panel refetches
 * on the `workshop_changed` frame. The add-spool form is bound once and never rebuilt
 * from fetched data: nothing in it reflects server state, so there is nothing for a
 * refetch to clobber. The spool list and the pending queue, which each hold their own
 * inline editing state, follow the same rule `workshop-cost.ts`'s settings form does:
 * a refetch always updates the data behind them, but only redraws while nothing inside
 * them is focused.
 */

import type { PendingUsage, Spool } from '../workshop/inventory-core';
import {
  BTN,
  BTN_ICON,
  BTN_ICON_DANGER,
  BTN_PRIMARY,
  EMPTY,
  FIELD,
  GAUGE,
  GAUGE_FILL,
  LABEL,
} from './design';
import { escapeAttr, escapeHtml, fetchTimeout } from './helpers';
import { icon, iconSolo } from './icons';
import { toast } from './toast';

const HOST_ID = 'workshop-inventory-content';

interface InventoryData {
  spools: Spool[];
  pending: PendingUsage[];
}

let loaded = false;
let mounted = false;
let data: InventoryData | null = null;
/** The spool currently shown as an inline edit form, if any. */
let editingId: string | null = null;

function fmtGrams(g: number): string {
  return `${Math.round(g)} g`;
}

function swatchHtml(color: string): string {
  return `<span class="inline-block w-4 h-4 rounded-full border border-line-soft shrink-0" style="background:${escapeAttr(color)}" aria-hidden="true"></span>`;
}

/**
 * A 3- or 6-digit hex expanded to the 6-digit form `<input type="color">` requires.
 * `null` for anything else, so the picker is left showing its last valid colour
 * rather than snapping to black while a #RGB shorthand or a partial value is typed.
 */
function toPickerHex(raw: string): string | null {
  const hex = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex.toLowerCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toLowerCase();
  }
  return null;
}

/**
 * Keeps a colour picker and its hex text field showing the same colour, in whichever
 * direction the person just edited. Called after every render that creates one of
 * these pairs: `addFormHtml`'s fields are replaced wholesale after a successful add,
 * so a listener bound once would be bound to elements no longer in the document.
 */
function bindColorFields(root: ParentNode): void {
  for (const wrap of root.querySelectorAll<HTMLElement>('[data-color-field]')) {
    const picker = wrap.querySelector<HTMLInputElement>('[data-spool-color-picker]');
    const text = wrap.querySelector<HTMLInputElement>('[data-spool-color]');
    if (!picker || !text) continue;
    picker.addEventListener('input', () => {
      text.value = picker.value.toUpperCase();
    });
    text.addEventListener('input', () => {
      const hex = toPickerHex(text.value);
      if (hex) picker.value = hex;
    });
  }
}

function spoolFieldsHtml(s?: Spool): string {
  const pickerHex = toPickerHex(s?.color ?? '') ?? '#888888';
  return `
    <div class="flex flex-wrap items-end gap-2">
      <div class="flex flex-col gap-1">
        <label class="${LABEL}">Name</label>
        <input type="text" data-spool-name value="${escapeAttr(s?.name ?? '')}"
          placeholder="e.g. the blue one" class="${FIELD} w-36">
      </div>
      <div class="flex flex-col gap-1">
        <label class="${LABEL}">Material</label>
        <input type="text" data-spool-material data-material-picker value="${escapeAttr(s?.material ?? '')}"
          placeholder="PLA" class="${FIELD} w-32">
      </div>
      <div class="flex flex-col gap-1">
        <label class="${LABEL}">Colour</label>
        <div class="flex items-center gap-1.5" data-color-field>
          <input type="color" data-spool-color-picker value="${pickerHex}" aria-label="Pick a colour"
            class="h-8 w-10 rounded-lg border border-line bg-input cursor-pointer p-0.5">
          <input type="text" data-spool-color value="${escapeAttr(s?.color ?? '')}"
            placeholder="#RRGGBB or #RGB" maxlength="7" class="${FIELD} w-28 font-mono">
        </div>
      </div>
      <div class="flex flex-col gap-1">
        <label class="${LABEL}">Full weight</label>
        <div class="flex items-center gap-1.5">
          <input type="number" data-spool-net min="1" max="100000" step="1"
            value="${s?.netGrams ?? 1000}" class="${FIELD} w-20">
          <span class="${LABEL}">g</span>
        </div>
      </div>
      <div class="flex flex-col gap-1">
        <label class="${LABEL}">Remaining</label>
        <div class="flex items-center gap-1.5">
          <input type="number" data-spool-remaining min="0" max="100000" step="1"
            value="${s?.remainingGrams ?? ''}" placeholder="full" class="${FIELD} w-20">
          <span class="${LABEL}">g</span>
        </div>
      </div>
      <div class="flex flex-col gap-1">
        <label class="${LABEL}">Price per kg</label>
        <input type="number" data-spool-price min="0" max="10000" step="0.01"
          value="${s?.pricePerKg ?? ''}" placeholder="uses Cost" class="${FIELD} w-24">
      </div>
    </div>`;
}

function addFormHtml(): string {
  return `
    <div class="flex flex-col gap-3 rounded-xl border border-line bg-card p-4 mb-5">
      <h3 class="text-xs font-semibold tracking-wide text-fg-muted">${icon('add')}Add a spool</h3>
      <div id="inventory-add-fields">${spoolFieldsHtml()}</div>
      <button type="button" id="inventory-add-save" class="${BTN_PRIMARY} self-start">${icon('save')}Add spool</button>
    </div>`;
}

function readSpoolFields(root: ParentNode): Record<string, unknown> | null {
  const material =
    root.querySelector<HTMLInputElement>('[data-spool-material]')?.value.trim() ?? '';
  const color = root.querySelector<HTMLInputElement>('[data-spool-color]')?.value.trim() ?? '';
  const net = root.querySelector<HTMLInputElement>('[data-spool-net]')?.value ?? '';
  if (!material || !color || !net) return null;
  const name = root.querySelector<HTMLInputElement>('[data-spool-name]')?.value.trim() ?? '';
  const remaining = root.querySelector<HTMLInputElement>('[data-spool-remaining]')?.value ?? '';
  const price = root.querySelector<HTMLInputElement>('[data-spool-price]')?.value ?? '';
  return {
    name: name || material,
    material,
    color,
    netGrams: Number(net),
    remainingGrams: remaining === '' ? Number(net) : Number(remaining),
    pricePerKg: price === '' ? null : Number(price),
  };
}

async function addSpool(): Promise<void> {
  const fields = document.getElementById('inventory-add-fields');
  const payload = fields && readSpoolFields(fields);
  if (!payload) {
    toast('A spool needs at least a material, a colour and a full weight', 'error');
    return;
  }
  const btn = document.getElementById('inventory-add-save') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    const res = await fetchTimeout('/api/workshop/inventory/spools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as { data?: Spool; error?: { message?: string } };
    if (!res.ok) {
      toast(body.error?.message ?? 'Could not add the spool', 'error');
      return;
    }
    toast('Spool added', 'success');
    if (fields) {
      fields.innerHTML = spoolFieldsHtml();
      bindColorFields(fields);
    }
    await fetchAndRender();
  } catch {
    toast('Not connected to the service', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function saveSpoolEdit(id: string, root: HTMLElement): Promise<void> {
  const payload = readSpoolFields(root);
  if (!payload) {
    toast('A spool needs at least a material, a colour and a full weight', 'error');
    return;
  }
  try {
    const res = await fetchTimeout(`/api/workshop/inventory/spools/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as { error?: { message?: string } };
    if (!res.ok) {
      toast(body.error?.message ?? 'Could not save the spool', 'error');
      return;
    }
    toast('Spool saved', 'success');
    editingId = null;
    await fetchAndRender();
  } catch {
    toast('Not connected to the service', 'error');
  }
}

async function deleteSpool(id: string, name: string): Promise<void> {
  if (!confirm(`Delete ${name}?\n\nThis cannot be undone.`)) return;
  try {
    const res = await fetchTimeout(`/api/workshop/inventory/spools/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    const body = (await res.json()) as { error?: { message?: string } };
    if (!res.ok) {
      toast(body.error?.message ?? 'Could not delete the spool', 'error');
      return;
    }
    toast('Spool deleted', 'success');
    await fetchAndRender();
  } catch {
    toast('Not connected to the service', 'error');
  }
}

/** Price per kg has no currency symbol here: the Cost tab owns that setting. */
function fmtPricePerKg(pricePerKg: number): string {
  return `${pricePerKg.toFixed(2)}/kg`;
}

function spoolRowHtml(s: Spool): string {
  if (s.id === editingId) {
    return `
      <div class="flex flex-col gap-3 rounded-xl border border-accent bg-card p-4" data-spool-row="${escapeAttr(s.id)}">
        ${spoolFieldsHtml(s)}
        <div class="flex items-center gap-2">
          <button type="button" data-save-spool="${escapeAttr(s.id)}" class="${BTN_PRIMARY}">${icon('save')}Save</button>
          <button type="button" data-cancel-edit class="${BTN}">Cancel</button>
        </div>
      </div>`;
  }

  const pct = s.netGrams > 0 ? Math.min(100, Math.round((s.remainingGrams / s.netGrams) * 100)) : 0;
  const price = s.pricePerKg !== null ? fmtPricePerKg(s.pricePerKg) : '';
  return `
    <div class="flex flex-col gap-2 rounded-xl border border-line bg-card p-4" data-spool-row="${escapeAttr(s.id)}">
      <div class="flex items-center gap-2">
        ${swatchHtml(s.color)}
        <div class="flex-1 min-w-0">
          <div class="font-medium text-fg truncate">${escapeHtml(s.name)}</div>
          <div class="${LABEL}">${escapeHtml(s.material)}${price ? ` · ${price}` : ''}</div>
        </div>
        <button type="button" data-edit-spool="${escapeAttr(s.id)}" class="${BTN_ICON}" aria-label="Edit ${escapeAttr(s.name)}">${iconSolo('edit')}</button>
        <button type="button" data-delete-spool="${escapeAttr(s.id)}" class="${BTN_ICON_DANGER}" aria-label="Delete ${escapeAttr(s.name)}">${iconSolo('trash')}</button>
      </div>
      <div class="${GAUGE}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Filament remaining">
        <div class="${GAUGE_FILL}" style="width:${pct}%;background:${escapeAttr(s.color)}"></div>
      </div>
      <div class="${LABEL} tabular-nums">${fmtGrams(s.remainingGrams)} of ${fmtGrams(s.netGrams)} left</div>
    </div>`;
}

function spoolListHtml(d: InventoryData): string {
  if (!d.spools.length) {
    return `<div class="${EMPTY}">${iconSolo('inventory')}<p>No spools on the shelf yet.</p>
      <p>Add one above to start tracking how much filament is left.</p></div>`;
  }
  return `<div class="grid grid-cols-1 min-[700px]:grid-cols-2 gap-3">${d.spools.map(spoolRowHtml).join('')}</div>`;
}

function spoolOptionsHtml(spools: readonly Spool[]): string {
  return spools
    .map(
      (s) =>
        `<option value="${escapeAttr(s.id)}">${escapeHtml(s.name)} (${escapeHtml(s.material)})</option>`,
    )
    .join('');
}

function pendingRowHtml(p: PendingUsage, spools: readonly Spool[]): string {
  const when = new Date(p.endedAt).toLocaleString();
  const colours = p.colours
    .map(
      (c) =>
        `<span class="inline-flex items-center gap-1">${swatchHtml(c.color)}${escapeHtml(c.material)}</span>`,
    )
    .join(' ');
  const assign = spools.length
    ? `<select data-assign-select class="${FIELD}">${spoolOptionsHtml(spools)}</select>
       <button type="button" data-assign="${escapeAttr(p.id)}" class="${BTN}">${icon('done')}Assign</button>`
    : `<span class="${LABEL}">Add a spool above to assign this</span>`;
  return `
    <div class="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-card p-3" data-pending-row="${escapeAttr(p.id)}">
      <div class="flex-1 min-w-0">
        <div class="font-medium text-fg truncate">${escapeHtml(p.filename)}</div>
        <div class="${LABEL}">${fmtGrams(p.grams)}${p.estimated ? ' (estimated)' : ''} · ${escapeHtml(when)} · ${colours}</div>
      </div>
      <div class="flex items-center gap-2">
        ${assign}
        <button type="button" data-dismiss="${escapeAttr(p.id)}" class="${BTN_ICON}" aria-label="Dismiss">${iconSolo('close')}</button>
      </div>
    </div>`;
}

function pendingListHtml(d: InventoryData): string {
  if (!d.pending.length) return '';
  return `
    <h3 class="text-xs font-semibold tracking-wide text-fg-muted mt-6 mb-2">${icon('warning')}Needs a spool (${d.pending.length})</h3>
    <div class="flex flex-col gap-2">${d.pending.map((p) => pendingRowHtml(p, d.spools)).join('')}</div>`;
}

async function assignPending(id: string, spoolId: string): Promise<void> {
  if (!spoolId) {
    toast('Pick a spool first', 'error');
    return;
  }
  try {
    const res = await fetchTimeout(
      `/api/workshop/inventory/pending/${encodeURIComponent(id)}/assign`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spoolId }),
      },
    );
    const body = (await res.json()) as { error?: { message?: string } };
    if (!res.ok) {
      toast(body.error?.message ?? 'Could not assign this print', 'error');
      return;
    }
    toast('Assigned', 'success');
    await fetchAndRender();
  } catch {
    toast('Not connected to the service', 'error');
  }
}

async function dismissPending(id: string): Promise<void> {
  try {
    const res = await fetchTimeout(`/api/workshop/inventory/pending/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    const body = (await res.json()) as { error?: { message?: string } };
    if (!res.ok) {
      toast(body.error?.message ?? 'Could not dismiss this print', 'error');
      return;
    }
    await fetchAndRender();
  } catch {
    toast('Not connected to the service', 'error');
  }
}

function bindPanel(host: HTMLElement): void {
  host.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const editId = target.closest<HTMLElement>('[data-edit-spool]')?.dataset.editSpool;
    if (editId) {
      editingId = editId;
      renderSpoolList();
      return;
    }
    if (target.closest('[data-cancel-edit]')) {
      editingId = null;
      renderSpoolList();
      return;
    }
    const saveId = target.closest<HTMLElement>('[data-save-spool]')?.dataset.saveSpool;
    if (saveId) {
      const row = target.closest<HTMLElement>('[data-spool-row]');
      if (row) void saveSpoolEdit(saveId, row);
      return;
    }
    const deleteId = target.closest<HTMLElement>('[data-delete-spool]')?.dataset.deleteSpool;
    if (deleteId) {
      const spool = data?.spools.find((s) => s.id === deleteId);
      if (spool) void deleteSpool(spool.id, spool.name);
      return;
    }
    const assignId = target.closest<HTMLElement>('[data-assign]')?.dataset.assign;
    if (assignId) {
      const row = target.closest<HTMLElement>('[data-pending-row]');
      const spoolId = row?.querySelector<HTMLSelectElement>('[data-assign-select]')?.value ?? '';
      void assignPending(assignId, spoolId);
      return;
    }
    const dismissId = target.closest<HTMLElement>('[data-dismiss]')?.dataset.dismiss;
    if (dismissId) void dismissPending(dismissId);
  });
}

function renderAddForm(): void {
  const host = document.getElementById('inventory-add');
  if (!host) return;
  host.innerHTML = addFormHtml();
  bindColorFields(host);
  document.getElementById('inventory-add-save')?.addEventListener('click', () => void addSpool());
}

/**
 * Whether `host` holds a field with typed or selected state worth protecting. A
 * *button* inside it (Edit, Cancel, Save, Delete) can be the active element too
 * (clicking one can focus it, in some browsers), but a button carries nothing a
 * redraw would lose, and guarding on it would make those very clicks appear to do
 * nothing: the guard would block the redraw the click was meant to trigger.
 */
function hasFocusedField(host: HTMLElement): boolean {
  const el = document.activeElement;
  return !!el && host.contains(el) && (el.tagName === 'INPUT' || el.tagName === 'SELECT');
}

function renderSpoolList(): void {
  if (!data) return;
  const host = document.getElementById('inventory-spool-list');
  if (!host) return;
  // Never redraw under someone's fingers, mid-edit, see the module comment.
  if (hasFocusedField(host)) return;
  host.innerHTML = spoolListHtml(data);
  bindColorFields(host);
}

function renderPendingList(): void {
  if (!data) return;
  const host = document.getElementById('inventory-pending-list');
  if (!host) return;
  if (hasFocusedField(host)) return;
  host.innerHTML = pendingListHtml(data);
}

async function fetchAndRender(): Promise<void> {
  const host = document.getElementById(HOST_ID);
  if (!host) return;
  if (!mounted) {
    host.innerHTML = `
      <div id="inventory-add"></div>
      <div id="inventory-spool-list"></div>
      <div id="inventory-pending-list"></div>`;
    mounted = true;
    renderAddForm();
    bindPanel(host);
  }
  if (!loaded) {
    const listHost = document.getElementById('inventory-spool-list');
    if (listHost) listHost.innerHTML = `<p class="${LABEL}">Loading inventory…</p>`;
  }

  try {
    const res = await fetchTimeout('/api/workshop/inventory');
    const body = (await res.json()) as { data?: InventoryData };
    if (!res.ok || !body.data) throw new Error(String(res.status));
    data = body.data;
    renderSpoolList();
    renderPendingList();
    loaded = true;
  } catch {
    if (loaded) return; // keep the figures already on screen
    const listHost = document.getElementById('inventory-spool-list');
    if (listHost) {
      listHost.innerHTML = `<div class="${EMPTY}">${iconSolo('warning')}<p>Could not load inventory: the service did not answer.</p>
        <button type="button" id="inventory-retry" class="text-accent underline">${icon('refresh')}Try again</button></div>`;
      listHost
        .querySelector('#inventory-retry')
        ?.addEventListener('click', () => void fetchAndRender());
    }
  }
}

export async function renderWorkshopInventory(): Promise<void> {
  await fetchAndRender();
}
