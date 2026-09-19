import { reapplyBusyGuard } from './busy-guard';
import { iconSolo } from './icons';
import { EMPTY, SWITCH_KNOB, SWITCH_TRACK } from './design';
import type { CanvasTray } from '../types';
import type { PrinterState } from '../printer-state';
import type { CommandSender } from '../ws-client';
import { $, escapeHtml, escapeAttr } from './helpers';
import { openFilamentEditor } from './filament-editor';

let canvasClient: CommandSender | null = null;
let canvasDelegationBound = false;

export function setCanvasClient(client: CommandSender): void {
  canvasClient = client;
}

/** The icon-only load/unload control on a tile. */
const SLOT_ACTION = [
  'inline-flex items-center justify-center shrink-0 h-7 w-7 rounded-md',
  'border border-line bg-card text-fg-soft cursor-pointer',
  'transition-colors hover:bg-hover hover:text-fg',
].join(' ');

/**
 * One spool slot.
 *
 * A tile, not a bare ring. The ring carried the whole slot (colour, number and the
 * click target) so an empty Canvas rendered as four anonymous circles with nothing
 * saying they could be clicked, and a full one said nothing about what it held without
 * hovering for the `title`.
 *
 * Two real buttons side by side rather than one nested inside the other: the body edits
 * what the slot holds, load/unload is its own control. Nesting them would be invalid
 * HTML, and it is the same mistake the auto-refill row made with nested `<label>`s.
 */
export function spoolTile(unitId: number, tray: CanvasTray, isActive: boolean): string {
  const isEmpty = tray.status === 0;
  const color = `#${(tray.filament_color || '434343').replace(/^#/, '')}`;
  const stateClass = isActive ? 'spool-active' : isEmpty ? 'spool-empty' : 'spool-loaded';

  const typeLabel = isEmpty ? 'Empty' : tray.filament_type || 'Unknown';
  const sub = isEmpty
    ? 'Tap to set'
    : tray.min_nozzle_temp
      ? `${tray.min_nozzle_temp}–${tray.max_nozzle_temp}°C`
      : tray.brand || '';

  // The ring keeps the filament's own colour. The accent means "engaged" and nothing
  // else, so an active spool says so with the tile's border instead.
  const ring = isEmpty
    ? '<span class="block h-9 w-9 rounded-full border-2 border-dashed border-line"></span>'
    : `<span class="grid h-9 w-9 place-items-center rounded-full border-[6px]" style="border-color:${escapeAttr(color)}">
         <span class="h-2 w-2 rounded-full border border-line bg-card"></span>
       </span>`;

  const action = isActive
    ? `<button type="button" data-requires-idle class="spool-unload-btn ${SLOT_ACTION}" data-canvas-id="${unitId}" data-tray-id="${tray.tray_id}" title="Unload this spool" aria-label="Unload spool ${tray.tray_id + 1}">${iconSolo('filamentUnload')}</button>`
    : isEmpty
      ? ''
      : `<button type="button" data-requires-idle class="spool-load-btn ${SLOT_ACTION}" data-canvas-id="${unitId}" data-tray-id="${tray.tray_id}" title="Load this spool" aria-label="Load spool ${tray.tray_id + 1}">${iconSolo('filamentLoad')}</button>`;

  return `<div class="${stateClass} flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface p-2 [&.spool-active]:border-accent">
    <button type="button" class="canvas-spool-slot flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 border-0 bg-transparent p-0 text-left"
      data-canvas-id="${unitId}" data-tray-id="${tray.tray_id}"
      data-type="${escapeAttr(tray.filament_type || '')}" data-color="${escapeAttr(tray.filament_color || '')}"
      data-brand="${escapeAttr(tray.brand || 'ELEGOO')}" data-name="${escapeAttr(tray.filament_name || '')}"
      data-min-temp="${tray.min_nozzle_temp || ''}" data-max-temp="${tray.max_nozzle_temp || ''}"
      title="${escapeAttr(tray.filament_name || typeLabel)}: click to edit">
      <span class="relative shrink-0">
        ${ring}
        <span class="absolute -top-1 -left-1 grid h-4 w-4 place-items-center rounded-full bg-fg-muted text-[10px] font-bold text-app [.spool-active_&]:bg-accent">${tray.tray_id + 1}</span>
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-xs font-medium text-fg">${escapeHtml(typeLabel)}</span>
        <span class="block truncate text-[11px] text-fg-muted">${escapeHtml(sub)}</span>
      </span>
    </button>
    ${action}
  </div>`;
}

export function renderCanvas(state: PrinterState): void {
  const container = $('canvas-status');
  const canvas = state.canvas;

  if (!canvas || !canvas.canvas_list?.length) {
    // Show mono filament info if available (printers without Canvas/AMS)
    if (state.monoFilament) {
      renderMonoFilament(container, state.monoFilament);
    } else {
      container.innerHTML = `<div class="${EMPTY}"><i class="bi bi-palette" aria-hidden="true"></i>No Canvas or AMS detected</div>`;
    }
    return;
  }

  let html = '';
  for (const unit of canvas.canvas_list) {
    const connected = !!unit.connected;
    html += `<div class="flex flex-col gap-2.5 ${connected ? '' : 'opacity-50'}">`;

    // The state was a dot plus a word, and the dot carried `canvas-state-ok` /
    // `canvas-state-off`: classes that appear at that one call site and in no
    // stylesheet, so both rendered in the same grey and connected differed from
    // disconnected by the word alone. A coloured chip carries it now.
    html += `<div class="flex items-center justify-between gap-2">
      <span class="text-[13px] font-semibold text-fg-soft">Canvas ${unit.canvas_id + 1}</span>
      <span class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        connected ? 'bg-ok-dim text-ok' : 'bg-bad-dim text-bad'
      }">${iconSolo(connected ? 'connected' : 'disconnected')} ${connected ? 'Connected' : 'Disconnected'}</span>
    </div>`;

    // Physical layout is counter-clockwise from top-left: 0=TL, 1=BL, 2=BR, 3=TR, while
    // a CSS grid fills row-major, hence the reorder rather than a plain map.
    const gridOrder = [0, 3, 1, 2];
    const orderedTrays = gridOrder
      .filter((i) => i < unit.tray_list.length)
      .map((i) => unit.tray_list[i]);

    // Keyed on the CARD. This card can be narrowed to a third of the dashboard in edit
    // mode, where two tiles do not fit whatever the window is doing, which is what the
    // `max-[800px]:` gap it replaces could not express.
    html += '<div class="grid grid-cols-1 gap-2 @min-[340px]:grid-cols-2">';
    for (const tray of orderedTrays) {
      const isActive =
        tray.status === 2 ||
        (unit.canvas_id === canvas.active_canvas_id && tray.tray_id === canvas.active_tray_id);
      html += spoolTile(unit.canvas_id, tray, isActive);
    }
    html += '</div>';

    html += '</div>'; // canvas-unit
  }

  // One switch for the machine, not one per unit. `auto_refill` is a single field on the
  // canvas payload, so rendering it inside the loop gave a second Canvas a second switch
  // writing the same setting, and the row nested a <label> inside a <label>, which is
  // invalid and makes a click on the text toggle twice or not at all.
  // Directly under the slots, not pinned to the card bottom with `mt-auto`: the grid
  // stretches this card to its row, and pinning left a hole between the slots and it.
  html += `<label class="mt-3 flex cursor-pointer items-center gap-3 border-t border-line-soft pt-3">
    <span class="min-w-0 flex-1">
      <span class="block text-xs text-fg">Auto-refill</span>
      <span class="block text-[11px] text-fg-muted">Switch to another spool of the same colour when one runs out</span>
    </span>
    <span class="${SWITCH_TRACK}"><input type="checkbox" class="auto-refill-toggle peer sr-only" ${canvas.auto_refill ? 'checked' : ''}><span class="${SWITCH_KNOB}"></span></span>
  </label>`;

  container.innerHTML = html;
  // Fresh markup comes back enabled; re-apply what the dashboard last knew.
  reapplyBusyGuard();

  // Bind delegated event listeners once on the container
  if (!canvasDelegationBound) {
    canvasDelegationBound = true;

    container.addEventListener('change', (e) => {
      const target = e.target as HTMLElement;
      if (!canvasClient) return;
      // Auto-refill toggle
      if (target.classList.contains('auto-refill-toggle')) {
        const on = (target as HTMLInputElement).checked;
        canvasClient.sendCommand(2004, { auto_refill: on });
      }
    });

    container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (!canvasClient) return;

      // Load button
      const loadBtn = target.closest('.spool-load-btn') as HTMLElement | null;
      if (loadBtn) {
        e.stopPropagation();
        const canvasId = parseInt(loadBtn.dataset.canvasId ?? '0');
        const trayId = parseInt(loadBtn.dataset.trayId ?? '0');
        canvasClient.sendCommand(2001, { canvas_id: canvasId, tray_id: trayId });
        setTimeout(() => canvasClient!.sendCommand(2005, {}), 1000);
        return;
      }

      // Unload button
      const unloadBtn = target.closest('.spool-unload-btn') as HTMLElement | null;
      if (unloadBtn) {
        e.stopPropagation();
        const canvasId = parseInt(unloadBtn.dataset.canvasId ?? '0');
        const trayId = parseInt(unloadBtn.dataset.trayId ?? '0');
        canvasClient.sendCommand(2002, { canvas_id: canvasId, tray_id: trayId });
        setTimeout(() => canvasClient!.sendCommand(2005, {}), 1000);
        return;
      }

      // Spool slot click for filament editing
      const slot = target.closest('.canvas-spool-slot') as HTMLElement | null;
      if (slot) {
        const canvasId = parseInt(slot.dataset.canvasId ?? '0');
        const trayId = parseInt(slot.dataset.trayId ?? '0');
        const isPrinting =
          (container.closest('#canvas-status') ?? container).getAttribute('data-printing') === '1';
        openFilamentEditor(
          canvasId,
          trayId,
          {
            type: slot.dataset.type || 'PLA',
            color: slot.dataset.color || '#ffffff',
            name: slot.dataset.name || '',
            brand: slot.dataset.brand || 'ELEGOO',
            minTemp: parseInt(slot.dataset.minTemp || '190'),
            maxTemp: parseInt(slot.dataset.maxTemp || '230'),
          },
          canvasClient,
          isPrinting,
        );
      }
    });
  }

  // Store printing state as data attr for delegation handler
  const isPrinting = state.status?.machine_status?.status === 2;
  container.setAttribute('data-printing', isPrinting ? '1' : '0');
}

/**
 * The no-Canvas case: a printer feeding one spool straight into the extruder.
 *
 * Built from the same tile as a Canvas slot so the card looks like one card in both
 * shapes, rather than the two unrelated layouts it used to carry.
 */
function renderMonoFilament(container: HTMLElement, info: Record<string, unknown>): void {
  const type = (info.filament_type ?? info.type ?? '') as string;
  const color = (info.filament_color ?? info.color ?? '') as string;
  const name = (info.filament_name ?? info.name ?? '') as string;
  const minTemp = (info.min_nozzle_temp ?? info.minTemp ?? 0) as number;
  const maxTemp = (info.max_nozzle_temp ?? info.maxTemp ?? 0) as number;
  const brand = (info.brand ?? '') as string;

  const colorHex = color ? `#${color.replace(/^#/, '')}` : '#666';
  const label = name || type || 'Unknown';
  const tempRange = minTemp && maxTemp ? `${minTemp}–${maxTemp}°C` : brand;

  container.innerHTML = `<div class="flex flex-col gap-2.5">
    <span class="text-[13px] font-semibold text-fg-soft">Direct drive</span>
    <div class="flex min-w-0 items-center gap-2.5 rounded-lg border border-line bg-surface p-2">
      <span class="grid h-9 w-9 shrink-0 place-items-center rounded-full border-[6px]" style="border-color:${escapeAttr(colorHex)}">
        <span class="h-2 w-2 rounded-full border border-line bg-card"></span>
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-xs font-medium text-fg">${escapeHtml(label)}</span>
        <span class="block truncate text-[11px] text-fg-muted">${escapeHtml(tempRange)}</span>
      </span>
    </div>
  </div>`;
}
