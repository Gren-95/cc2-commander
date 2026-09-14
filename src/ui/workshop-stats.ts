/**
 * Tools → Statistics.
 *
 * Read-only, and computed by the service (`workshop/stats-core.ts`) from the print
 * ledger. This file only draws it.
 *
 * ## Form, per the data's job
 *
 * - **Headline numbers are stat tiles, not a chart.** Four numbers do not need axes.
 * - **Finish rate is a meter** — a ratio against a fixed limit — in the series hue, not
 *   green. It is a measurement rather than a verdict, and the status colours are
 *   reserved for status.
 * - **Machine hours by month is one series of columns.** One series needs no legend;
 *   the title names it. Values are labelled on the peak and the current month only —
 *   a number on every column is a number nobody reads — and every value is reachable
 *   from the tooltip and from the table beneath, so the tooltip is never the only way in.
 *
 * The column colour is `--chart-series`, the theme's generic series hue, deliberately
 * not the accent: the accent means "this control is engaged" and nothing else. Checked
 * with the palette validator in both themes (#8e24aa on #ffffff, #ab47bc on #1c1917):
 * lightness band, chroma floor and contrast all pass.
 */

import type { Stats } from '../workshop/stats-core';
import { EMPTY, GAUGE, GAUGE_FILL, LABEL, READOUT, READOUT_ROW, SUBHEAD, UNIT } from './design';
import { escapeHtml, fetchTimeout, formatTime } from './helpers';
import { icon, iconSolo } from './icons';

const HOST_ID = 'workshop-stats-content';

/** Shown on the first load only. A refetch keeps the last figures until new ones land. */
let loaded = false;

function fmtHours(h: number): string {
  return h >= 100 ? String(Math.round(h)) : h.toFixed(1);
}

function fmtGrams(g: number): { value: string; unit: string } {
  return g >= 1000 ? { value: (g / 1000).toFixed(2), unit: 'kg' } : { value: String(g), unit: 'g' };
}

/** `2026-09` → a month name, in the viewer's locale. */
function monthName(key: string, style: 'short' | 'long'): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString(undefined, {
    month: style,
    ...(style === 'long' ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

function tile(label: string, value: string, unit: string, sub: string, extra = ''): string {
  return `
    <div class="flex flex-col gap-2 rounded-xl border border-line bg-card p-4 min-w-0">
      <span class="${LABEL}">${label}</span>
      <span class="${READOUT_ROW}"><span class="${READOUT}">${value}</span><span class="${UNIT}">${unit}</span></span>
      ${extra}
      <span class="${LABEL}">${sub}</span>
    </div>`;
}

function tiles(s: Stats): string {
  const rate = s.finishRate === null ? null : Math.round(s.finishRate * 100);
  const meter =
    rate === null
      ? ''
      : `<div class="${GAUGE}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${rate}" aria-label="Finish rate">
           <div class="${GAUGE_FILL}" style="width:${rate}%;background:var(--chart-series)"></div>
         </div>`;
  const g = fmtGrams(s.grams);

  return `
    <div class="grid grid-cols-2 gap-3 min-[900px]:grid-cols-4">
      ${tile('Prints', String(s.prints), '', `${s.completed} finished · ${s.stopped} stopped`)}
      ${tile(
        'Finish rate',
        rate === null ? '—' : String(rate),
        rate === null ? '' : '%',
        'Stopped includes cancelled first layers',
        meter,
      )}
      ${tile(
        'Print time',
        fmtHours(s.hours),
        'h',
        s.averageSeconds
          ? `${formatTime(s.averageSeconds)} per finished print`
          : 'No finished prints yet',
      )}
      ${tile(
        'Filament',
        s.gramsKnownFor ? g.value : '—',
        s.gramsKnownFor ? g.unit : '',
        `Known for ${s.gramsKnownFor} of ${s.prints} prints`,
      )}
    </div>`;
}

function chart(s: Stats): string {
  const peak = Math.max(...s.months.map((m) => m.hours));
  if (peak <= 0) return '';
  const peakIndex = s.months.findIndex((m) => m.hours === peak);
  const last = s.months.length - 1;

  const columns = s.months
    .map((m, i) => {
      // 88%, not 100%: the column also holds the value label above its bar, and on the
      // peak month a full-height bar would push that label out through the top of the plot.
      const pct = (m.hours / peak) * 88;
      const labelled = (i === peakIndex || i === last) && m.hours > 0;
      const aria = `${monthName(m.month, 'long')}: ${m.prints} prints, ${fmtHours(m.hours)} hours`;
      // The whole band is the button, so the hit target is the column's slot rather than
      // a sliver of bar — a month with two hours of printing is otherwise unhoverable.
      return `
        <button type="button" class="stats-col group flex h-full flex-1 flex-col items-center justify-end gap-1 border-0 bg-transparent p-0 cursor-default focus:outline-none"
          data-i="${i}" aria-label="${escapeHtml(aria)}">
          <span class="text-[10px] leading-none text-fg-muted ${labelled ? '' : 'invisible'}">${fmtHours(m.hours)}</span>
          <span class="block w-full max-w-6 rounded-t-[4px] group-hover:brightness-110 group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-accent"
            style="height:${pct.toFixed(1)}%;background:var(--chart-series)"></span>
        </button>`;
    })
    .join('');

  const axis = s.months
    .map(
      (m) =>
        `<span class="flex-1 text-center text-[10px] text-fg-muted">${monthName(m.month, 'short')}</span>`,
    )
    .join('');

  return `
    <section class="flex flex-col gap-2">
      <h4 class="${SUBHEAD}">Print hours per month</h4>
      <div class="relative">
        <div class="stats-plot flex h-40 items-end gap-0.5 border-b border-line">${columns}</div>
        <div class="flex gap-0.5 pt-1">${axis}</div>
        <div id="stats-tip" role="tooltip" class="pointer-events-none absolute z-10 hidden rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs text-fg shadow-card"></div>
      </div>
      ${table(s)}
    </section>`;
}

function table(s: Stats): string {
  const rows = s.months
    .map(
      (m) => `<tr class="border-t border-line-soft">
        <td class="py-1 pr-4">${monthName(m.month, 'long')}</td>
        <td class="py-1 pr-4 text-right tabular-nums">${m.prints}</td>
        <td class="py-1 pr-4 text-right tabular-nums">${m.completed}</td>
        <td class="py-1 pr-4 text-right tabular-nums">${fmtHours(m.hours)}</td>
        <td class="py-1 text-right tabular-nums">${m.grams || '—'}</td>
      </tr>`,
    )
    .join('');
  return `
    <details class="text-xs text-fg-soft">
      <summary class="cursor-pointer select-none text-fg-muted">Show as a table</summary>
      <div class="overflow-x-auto">
        <table class="mt-2 w-full">
          <thead class="text-fg-muted"><tr>
            <th class="py-1 pr-4 text-left font-medium">Month</th>
            <th class="py-1 pr-4 text-right font-medium">Prints</th>
            <th class="py-1 pr-4 text-right font-medium">Finished</th>
            <th class="py-1 pr-4 text-right font-medium">Hours</th>
            <th class="py-1 text-right font-medium">Grams</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>`;
}

function topFiles(s: Stats): string {
  if (!s.topFiles.length) return '';
  const items = s.topFiles
    .map(
      (
        f,
      ) => `<li class="flex items-baseline justify-between gap-3 border-t border-line-soft py-1.5 first:border-t-0">
        <span class="truncate text-fg-soft" title="${escapeHtml(f.filename)}">${escapeHtml(f.filename)}</span>
        <span class="shrink-0 tabular-nums text-fg-muted">${f.prints}× <span class="text-fg-muted">(${f.completed} finished)</span></span>
      </li>`,
    )
    .join('');
  const longest = s.longest
    ? `<p class="${LABEL}">Longest finished print: <span class="text-fg-soft">${escapeHtml(s.longest.filename)}</span>, ${formatTime(s.longest.seconds)}</p>`
    : '';
  return `
    <section class="flex flex-col gap-2">
      <h4 class="${SUBHEAD}">Most printed</h4>
      <ol class="text-xs">${items}</ol>
      ${longest}
    </section>`;
}

function view(s: Stats): string {
  if (!s.prints) {
    return `<div class="${EMPTY}">${iconSolo('stats')}<p>No prints recorded yet.</p>
      <p>History is read from the printer each time the service connects to it.</p></div>`;
  }
  const since = s.since
    ? new Date(s.since).toLocaleDateString(undefined, { dateStyle: 'medium' })
    : '';
  return `
    <div class="flex flex-col gap-5">
      <p class="${LABEL}">Since ${escapeHtml(since)}. Filament weights are recorded from the file while it is still on the printer, so older prints mostly have none.</p>
      ${tiles(s)}
      ${chart(s)}
      ${topFiles(s)}
    </div>`;
}

/**
 * Tooltip for the monthly columns: one element, positioned over the hovered or focused
 * band, filled with `textContent` so a month label can never become markup.
 */
function bindTooltip(host: HTMLElement, s: Stats): void {
  const tip = host.querySelector<HTMLElement>('#stats-tip');
  const plot = host.querySelector<HTMLElement>('.stats-plot');
  if (!tip || !plot) return;

  const show = (btn: HTMLElement) => {
    const m = s.months[Number(btn.dataset.i)];
    if (!m) return;
    tip.replaceChildren();
    const value = document.createElement('strong');
    value.textContent = `${fmtHours(m.hours)} h`;
    const detail = document.createElement('div');
    detail.className = 'text-fg-muted';
    detail.textContent = `${monthName(m.month, 'long')} · ${m.prints} prints, ${m.completed} finished`;
    tip.append(value, detail);
    tip.classList.remove('hidden');
    const band = btn.getBoundingClientRect();
    const box = plot.getBoundingClientRect();
    const left = band.left - box.left + band.width / 2 - tip.offsetWidth / 2;
    tip.style.left = `${Math.max(0, Math.min(left, box.width - tip.offsetWidth))}px`;
    tip.style.top = `${-tip.offsetHeight - 6}px`;
  };
  const hide = () => tip.classList.add('hidden');

  for (const btn of host.querySelectorAll<HTMLElement>('.stats-col')) {
    btn.addEventListener('pointerenter', () => show(btn));
    btn.addEventListener('focus', () => show(btn));
    btn.addEventListener('pointerleave', hide);
    btn.addEventListener('blur', hide);
  }
}

export async function renderWorkshopStats(): Promise<void> {
  const host = document.getElementById(HOST_ID);
  if (!host) return;
  if (!loaded) host.innerHTML = `<p class="${LABEL}">Loading statistics…</p>`;

  try {
    const tz = new Date().getTimezoneOffset();
    const res = await fetchTimeout(`/api/workshop/stats?tz=${tz}`);
    const body = (await res.json()) as { data?: Stats };
    if (!res.ok || !body.data) throw new Error(String(res.status));
    host.innerHTML = view(body.data);
    bindTooltip(host, body.data);
    loaded = true;
  } catch {
    if (loaded) return; // keep the figures already on screen
    host.innerHTML = `<div class="${EMPTY}">${iconSolo('warning')}<p>Could not load statistics: the service did not answer.</p>
      <button type="button" id="stats-retry" class="text-accent underline">${icon('refresh')}Try again</button></div>`;
    host.querySelector('#stats-retry')?.addEventListener('click', () => void renderWorkshopStats());
  }
}
