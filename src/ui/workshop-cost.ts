/**
 * Tools → Cost.
 *
 * A settings form (currency, electricity price, printer draw, filament prices) and a
 * read-only list of every file on the printer priced against it. `workshop/cost-core.ts`
 * has the maths and the reasoning for why there are no default prices; this file only
 * draws it and saves what is typed.
 *
 * ## Two static siblings, not one re-rendered panel
 *
 * The file list refetches on every `workshop_changed` frame — a print finishing changes
 * nothing here, but another browser tab saving new prices does, and there is no way to
 * tell those apart from this side. If the settings form were rebuilt along with it, a
 * price half-typed into a field would vanish out from under whoever was typing it, same
 * as the hazard `list-controls.ts` exists to avoid. So the form and the list are two
 * separate elements; a refetch always redraws the list, but only rebuilds the form when
 * no field in it is focused.
 */

import {
  type CostedPrint,
  type CostSettings,
  type FileCost,
  materialKey,
} from '../workshop/cost-core';
import { BTN, BTN_ICON, BTN_PRIMARY, EMPTY, FIELD, LABEL } from './design';
import { escapeAttr, escapeHtml, fetchTimeout, formatTime } from './helpers';
import { icon, iconSolo } from './icons';
import { type ListControls, createListControls } from './list-controls';
import { nonZero } from './list-sort';
import { toast } from './toast';

const HOST_ID = 'workshop-cost-content';

interface CostData {
  settings: CostSettings;
  priced: boolean;
  files: FileCost[];
  history: CostedPrint[];
}

/** Shown on the first load only. A refetch keeps the last figures until new ones land. */
let loaded = false;
let mounted = false;
let data: CostData | null = null;

function money(v: number | null, currency: string): string {
  return v === null ? '—' : `${escapeHtml(currency)}${v.toFixed(2)}`;
}

function materialRowHtml(name: string, price: number | ''): string {
  return `
    <div class="flex items-center gap-2" data-material-row>
      <input type="text" data-material-name data-material-picker value="${escapeAttr(name)}" aria-label="Material name"
        placeholder="Material, e.g. PLA" class="${FIELD} flex-1 min-w-0">
      <input type="number" data-material-price min="0" max="10000" step="0.01" value="${price}"
        aria-label="Price per kg" placeholder="Price/kg" class="${FIELD} w-24">
      <button type="button" data-remove-material class="${BTN_ICON}"
        aria-label="Remove ${escapeAttr(name) || 'material'} price">${iconSolo('trash')}</button>
    </div>`;
}

function settingsFormHtml(s: CostSettings): string {
  const materials = Object.entries(s.materialPerKg).sort(([a], [b]) => a.localeCompare(b));
  return `
    <div class="flex flex-col gap-4 rounded-xl border border-line bg-card p-4 mb-5">
      <h3 class="text-xs font-semibold tracking-wide text-fg-muted">${icon('cost')}Prices</h3>

      <div class="flex flex-wrap gap-4">
        <div class="flex flex-col gap-1">
          <label for="cost-currency" class="${LABEL}">Currency</label>
          <input id="cost-currency" type="text" maxlength="4" value="${escapeAttr(s.currency)}"
            class="${FIELD} w-16">
        </div>
        <div class="flex flex-col gap-1">
          <label for="cost-elec-price" class="${LABEL}">Electricity price per kWh</label>
          <input id="cost-elec-price" type="number" min="0" max="10000" step="0.01"
            value="${s.electricityPerKwh ?? ''}" placeholder="not set" class="${FIELD} w-28">
        </div>
        <div class="flex flex-col gap-1">
          <label for="cost-watts" class="${LABEL}">Printer draw while printing</label>
          <div class="flex items-center gap-2">
            <input id="cost-watts" type="number" min="0" max="5000" step="1"
              value="${s.printerWatts ?? ''}" placeholder="not set" class="${FIELD} w-24">
            <span class="${LABEL}">W</span>
          </div>
        </div>
        <div class="flex flex-col gap-1">
          <label for="cost-filament-price" class="${LABEL}">Default filament price per kg</label>
          <input id="cost-filament-price" type="number" min="0" max="10000" step="0.01"
            value="${s.filamentPerKg ?? ''}" placeholder="not set" class="${FIELD} w-28">
        </div>
      </div>

      <div class="flex flex-col gap-2">
        <span class="${LABEL}">Per-material prices, used instead of the default above</span>
        <div id="cost-materials" class="flex flex-col gap-2">
          ${materials.map(([name, price]) => materialRowHtml(name, price)).join('')}
        </div>
        <button type="button" id="cost-add-material" class="${BTN} self-start">${icon('add')}Add material</button>
      </div>

      <div class="flex items-center gap-3">
        <button type="button" id="cost-save" class="${BTN_PRIMARY}">${icon('save')}Save prices</button>
      </div>
    </div>`;
}

function filesListHtml(d: CostData): string {
  if (!d.priced) {
    return `<div class="${EMPTY}">${iconSolo('cost')}<p>No prices set yet.</p>
      <p>Enter a filament price per kg above, or an electricity price and the printer's
      draw, to see what each file would cost.</p></div>`;
  }
  if (!d.files.length) {
    return `<div class="${EMPTY}">${iconSolo('files')}<p>No files on the printer.</p></div>`;
  }
  const rows = d.files
    .map(
      (f) => `<tr class="border-t border-line-soft">
        <td class="py-1.5 pr-4 max-w-60 truncate" title="${escapeAttr(f.filename)}">${escapeHtml(f.filename)}</td>
        <td class="py-1.5 pr-4 text-right tabular-nums">${f.grams !== null ? `${Math.round(f.grams)} g` : '—'}</td>
        <td class="py-1.5 pr-4 text-right tabular-nums">${f.seconds !== null ? formatTime(f.seconds) : '—'}</td>
        <td class="py-1.5 pr-4 text-right tabular-nums">${money(f.filament, d.settings.currency)}</td>
        <td class="py-1.5 text-right tabular-nums">${money(f.electricity, d.settings.currency)}</td>
      </tr>`,
    )
    .join('');
  return `
    <div class="overflow-x-auto">
      <table class="w-full text-xs">
        <thead class="text-fg-muted"><tr>
          <th class="py-1.5 pr-4 text-left font-medium">File</th>
          <th class="py-1.5 pr-4 text-right font-medium">Filament</th>
          <th class="py-1.5 pr-4 text-right font-medium">Print time</th>
          <th class="py-1.5 pr-4 text-right font-medium">Filament cost</th>
          <th class="py-1.5 text-right font-medium">Electricity cost</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/** Kept outside the render function — see `list-controls.ts` on why that matters. */
let historyControls: ListControls<CostedPrint> | null = null;

function ensureHistoryControls(): ListControls<CostedPrint> {
  if (historyControls) return historyControls;
  historyControls = createListControls<CostedPrint>({
    id: 'cost-history',
    container: document.getElementById('cost-history-controls') as HTMLElement,
    noun: 'prints',
    filterPlaceholder: 'Filter by job name…',
    filterText: (p) => p.filename,
    columns: [
      { key: 'name', label: 'Name', value: (p) => p.filename },
      {
        key: 'ended',
        label: 'Finished',
        value: (p) => nonZero(p.endedAt),
        initialDirection: 'desc',
      },
      {
        key: 'duration',
        label: 'Duration',
        value: (p) => nonZero(p.seconds),
        initialDirection: 'desc',
      },
      {
        key: 'weight',
        label: 'Weight',
        value: (p) => nonZero(p.grams ?? undefined),
        initialDirection: 'desc',
      },
      {
        key: 'filament-cost',
        label: 'Filament cost',
        value: (p) => nonZero(p.filament ?? undefined),
        initialDirection: 'desc',
      },
      {
        key: 'electricity-cost',
        label: 'Electricity cost',
        value: (p) => nonZero(p.electricity ?? undefined),
        initialDirection: 'desc',
      },
    ],
    defaultSort: { key: 'ended', dir: 'desc' },
    selects: [
      {
        id: 'outcome',
        label: 'Outcome',
        options: [
          { value: 'completed', label: 'completed' },
          { value: 'stopped', label: 'stopped' },
          { value: 'unknown', label: 'unknown' },
        ],
        match: (p, value) => p.outcome === value,
      },
    ],
    onChange: () => renderHistoryList(),
  });
  return historyControls;
}

function outcomeBadge(outcome: CostedPrint['outcome']): string {
  if (outcome === 'completed')
    return `<span class="text-ok" title="Completed">${icon('ok')}</span>`;
  if (outcome === 'stopped')
    return `<span class="text-warn" title="Stopped early">${icon('warning')}</span>`;
  return `<span class="text-fg-muted" title="Outcome unknown">${icon('unknown')}</span>`;
}

function historyListHtml(d: CostData, controls: ListControls<CostedPrint>): string {
  const prints = controls.apply(d.history);
  if (!d.history.length) {
    return `<div class="${EMPTY}">${iconSolo('history')}<p>No finished prints yet.</p></div>`;
  }
  if (!prints.length) {
    return controls.emptyHtml('No finished prints yet.');
  }
  const rows = prints
    .map((p) => {
      const when = new Date(p.endedAt).toLocaleString();
      const grams =
        p.grams !== null ? `${Math.round(p.grams)} g${p.gramsEstimated ? ' (est.)' : ''}` : '—';
      return `<tr class="border-t border-line-soft">
        <td class="py-1.5 pr-4 max-w-60 truncate" title="${escapeAttr(p.filename)}">${escapeHtml(p.filename)}</td>
        <td class="py-1.5 pr-4 whitespace-nowrap">${escapeHtml(when)}</td>
        <td class="py-1.5 pr-4 text-right tabular-nums">${grams}</td>
        <td class="py-1.5 pr-4 text-right tabular-nums">${formatTime(p.seconds)}</td>
        <td class="py-1.5 pr-4 text-center">${outcomeBadge(p.outcome)}</td>
        <td class="py-1.5 pr-4 text-right tabular-nums">${money(p.filament, d.settings.currency)}</td>
        <td class="py-1.5 text-right tabular-nums">${money(p.electricity, d.settings.currency)}</td>
      </tr>`;
    })
    .join('');
  return `
    <div class="overflow-x-auto">
      <table class="w-full text-xs">
        <thead class="text-fg-muted"><tr>
          <th class="py-1.5 pr-4 text-left font-medium">File</th>
          <th class="py-1.5 pr-4 text-left font-medium">Finished</th>
          <th class="py-1.5 pr-4 text-right font-medium">Weight</th>
          <th class="py-1.5 pr-4 text-right font-medium">Print time</th>
          <th class="py-1.5 pr-4 text-center font-medium">Outcome</th>
          <th class="py-1.5 pr-4 text-right font-medium">Filament cost</th>
          <th class="py-1.5 text-right font-medium">Electricity cost</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/** Read the material rows currently in the DOM, skipping any left with no name. */
function materialsFromForm(): Record<string, number> {
  const materialPerKg: Record<string, number> = {};
  for (const row of document.querySelectorAll<HTMLElement>('#cost-materials [data-material-row]')) {
    const name = row.querySelector<HTMLInputElement>('[data-material-name]')?.value.trim() ?? '';
    const price = row.querySelector<HTMLInputElement>('[data-material-price]')?.value ?? '';
    if (name && price !== '') materialPerKg[materialKey(name)] = Number(price);
  }
  return materialPerKg;
}

async function saveSettings(): Promise<void> {
  const num = (id: string): number | null => {
    const v = (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
    return v === '' ? null : Number(v);
  };
  const payload = {
    currency: (document.getElementById('cost-currency') as HTMLInputElement | null)?.value,
    electricityPerKwh: num('cost-elec-price'),
    printerWatts: num('cost-watts'),
    filamentPerKg: num('cost-filament-price'),
    materialPerKg: materialsFromForm(),
  };
  const btn = document.getElementById('cost-save') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    const res = await fetchTimeout('/api/workshop/cost/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as { data?: CostSettings; error?: { message?: string } };
    if (!res.ok) {
      toast(body.error?.message ?? 'Could not save prices', 'error');
      return;
    }
    toast('Prices saved', 'success');
    await fetchAndRender();
  } catch {
    toast('Not connected to the service', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function bindSettingsForm(): void {
  document.getElementById('cost-save')?.addEventListener('click', () => void saveSettings());

  document.getElementById('cost-add-material')?.addEventListener('click', () => {
    const container = document.getElementById('cost-materials');
    if (!container) return;
    container.insertAdjacentHTML('beforeend', materialRowHtml('', ''));
    const rows = container.querySelectorAll<HTMLInputElement>('[data-material-name]');
    rows[rows.length - 1]?.focus();
  });

  document.getElementById('cost-materials')?.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('[data-remove-material]')) return;
    (e.target as HTMLElement).closest('[data-material-row]')?.remove();
  });
}

function renderSettingsForm(): void {
  if (!data) return;
  const formHost = document.getElementById('cost-settings-form');
  if (!formHost) return;
  // Never redraw under someone's fingers — see the module comment.
  if (formHost.contains(document.activeElement) && document.activeElement !== document.body) return;
  formHost.innerHTML = settingsFormHtml(data.settings);
  bindSettingsForm();
}

function renderFilesList(): void {
  if (!data) return;
  const filesHost = document.getElementById('cost-files-list');
  if (filesHost) filesHost.innerHTML = filesListHtml(data);
}

function renderHistoryList(): void {
  if (!data) return;
  const historyHost = document.getElementById('cost-history-list');
  if (historyHost) historyHost.innerHTML = historyListHtml(data, ensureHistoryControls());
}

async function fetchAndRender(): Promise<void> {
  const host = document.getElementById(HOST_ID);
  if (!host) return;
  if (!mounted) {
    host.innerHTML = `
      <div id="cost-settings-form"></div>
      <h3 class="text-xs font-semibold tracking-wide text-fg-muted mb-2">${icon('files')}On the printer now</h3>
      <div id="cost-files-list" class="mb-6"></div>
      <h3 class="text-xs font-semibold tracking-wide text-fg-muted mb-2">${icon('history')}Print history</h3>
      <div id="cost-history-controls"></div>
      <div id="cost-history-list"></div>`;
    mounted = true;
  }
  if (!loaded) {
    const filesHost = document.getElementById('cost-files-list');
    if (filesHost) filesHost.innerHTML = `<p class="${LABEL}">Loading prices…</p>`;
  }

  try {
    const res = await fetchTimeout('/api/workshop/cost');
    const body = (await res.json()) as { data?: CostData };
    if (!res.ok || !body.data) throw new Error(String(res.status));
    data = body.data;
    renderSettingsForm();
    renderFilesList();
    renderHistoryList();
    loaded = true;
  } catch {
    if (loaded) return; // keep the figures already on screen
    const filesHost = document.getElementById('cost-files-list');
    if (filesHost) {
      filesHost.innerHTML = `<div class="${EMPTY}">${iconSolo('warning')}<p>Could not load prices: the service did not answer.</p>
        <button type="button" id="cost-retry" class="text-accent underline">${icon('refresh')}Try again</button></div>`;
      filesHost
        .querySelector('#cost-retry')
        ?.addEventListener('click', () => void fetchAndRender());
    }
  }
}

export async function renderWorkshopCost(): Promise<void> {
  await fetchAndRender();
}
