import { icon, iconSolo } from './icons';
import { EMPTY, SWITCH_KNOB, SWITCH_TRACK } from './design';
import type { PrinterState } from '../printer-state';
import type { CommandSender } from '../ws-client';
import { $, escapeHtml, escapeAttr } from './helpers';
import { openFilamentEditor } from './filament-editor';

let canvasClient: CommandSender | null = null;
let canvasDelegationBound = false;

export function setCanvasClient(client: CommandSender): void {
  canvasClient = client;
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
    html += `<div class="flex flex-col [gap:10px] ${connected ? '' : 'opacity-[0.5]'}">`;
    html += `<div class="text-[13px] font-semibold text-fg-soft">Canvas ${unit.canvas_id + 1} ${connected ? `${icon('connected', 'canvas-state-ok')} Connected` : `${icon('disconnected', 'canvas-state-off')} Disconnected`}</div>`;

    // Physical layout: 2×2 grid of spools inside a "device" frame
    html += `<div class="flex items-center gap-3 bg-surface rounded-card p-4 relative">`;
    html += `<div class="flex flex-col items-center gap-1 min-w-12">`;
    html += `<div class="text-[9px] text-fg-muted uppercase tracking-[0.5px]">Canvas</div>`;
    html += `<div class="flex flex-col [gap:3px]">`;
    for (const tray of unit.tray_list) {
      const color = `#${(tray.filament_color || '434343').replace(/^#/, '')}`;
      const isEmpty = tray.status === 0;
      html += `<div class="w-8 h-1 rounded-[2px]" style="background: ${isEmpty ? '#434343' : escapeAttr(color)}"></div>`;
    }
    html += `</div></div>`;

    html += `<div class="grid grid-cols-[repeat(2,_1fr)] gap-3 flex-1 max-[800px]:[gap:10px]">`;
    // Physical layout is CCW from top-left: 0=TL, 1=BL, 2=BR, 3=TR
    // CSS grid fills row-major: pos0=TL, pos1=TR, pos2=BL, pos3=BR
    // Reorder: grid[0]=tray0, grid[1]=tray3, grid[2]=tray1, grid[3]=tray2
    const gridOrder = [0, 3, 1, 2];
    const orderedTrays = gridOrder
      .filter((i) => i < unit.tray_list.length)
      .map((i) => unit.tray_list[i]);
    for (const tray of orderedTrays) {
      const isActive =
        tray.status === 2 ||
        (unit.canvas_id === canvas.active_canvas_id && tray.tray_id === canvas.active_tray_id);
      const isEmpty = tray.status === 0;
      const color = `#${(tray.filament_color || '434343').replace(/^#/, '')}`;
      const statusClass = isActive ? 'spool-active' : isEmpty ? 'spool-empty' : 'spool-loaded';
      const typeLabel = tray.filament_type || (isEmpty ? '' : '?');
      const tempRange =
        !isEmpty && tray.min_nozzle_temp ? `${tray.min_nozzle_temp}–${tray.max_nozzle_temp}°C` : '';

      html += `<div class="canvas-spool-slot flex flex-col items-center gap-1 relative p-1 ${statusClass}" title="${escapeAttr(tray.filament_name || typeLabel)} — click to edit" data-canvas-id="${unit.canvas_id}" data-tray-id="${tray.tray_id}" data-type="${escapeAttr(tray.filament_type || '')}" data-color="${escapeAttr(tray.filament_color || '')}" data-brand="${escapeAttr(tray.brand || 'ELEGOO')}" data-name="${escapeAttr(tray.filament_name || '')}" data-min-temp="${tray.min_nozzle_temp || ''}" data-max-temp="${tray.max_nozzle_temp || ''}">`;
      html += `<div class="absolute top--1 left--1 w-5 h-5 rounded-full bg-fg-muted text-app text-[11px] font-bold flex items-center justify-center z-[1] [.spool-active_&]:bg-accent">${tray.tray_id + 1}</div>`;
      html += `<div class="w-16 h-16 rounded-full [border:4px_solid] relative flex items-center justify-center [transition:all_0.3s] [.spool-empty_&]:opacity-[0.3]" style="border-color: ${isEmpty ? '#434343' : escapeAttr(color)}">`;
      html += `<div class="w-full h-full rounded-full opacity-[0.3]" style="background: ${isEmpty ? 'transparent' : escapeAttr(color)}"></div>`;
      html += `<div class="absolute top-[50%] left-[50%] [transform:translate(-50%,_-50%)] w-[18px] h-[18px] rounded-full bg-card border-2 border-[rgba(255,_255,_255,_0.1)]"></div>`;
      if (isActive) {
        html += `<div class="absolute [inset:-6px] rounded-full border-2 border-accent [animation:pulse_1.5s_infinite]"></div>`;
      }
      html += `</div>`;
      html += `<div class="text-[11px] font-semibold text-fg text-center">${escapeHtml(typeLabel)}</div>`;
      if (tempRange) {
        html += `<div class="text-[9px] text-fg-muted">${tempRange}</div>`;
      }
      html += `<div class="spool-actions flex gap-1 justify-center [margin-top:2px]">`;
      if (isActive) {
        html += `<button class="spool-unload-btn inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-fg cursor-pointer transition-colors hover:bg-hover hover:border-fg-muted disabled:opacity-50 disabled:cursor-not-allowed" data-canvas-id="${unit.canvas_id}" data-tray-id="${tray.tray_id}">Unload</button>`;
      } else if (!isEmpty) {
        html += `<button class="spool-load-btn inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-fg cursor-pointer transition-colors hover:bg-hover hover:border-fg-muted disabled:opacity-50 disabled:cursor-not-allowed" data-canvas-id="${unit.canvas_id}" data-tray-id="${tray.tray_id}">Load</button>`;
      }
      html += `</div>`;
      html += `</div>`;
    }
    html += `</div>`; // canvas-spools

    // Extruder icon
    html += `<div class="flex items-center justify-center min-w-12" title="Extruder">`;
    html += `<div class="text-[32px] text-fg-muted opacity-[0.6]">${iconSolo('extruder')}</div>`;
    html += `</div>`;

    html += `</div>`; // canvas-device

    // Action bar
    html += `<div class="flex items-center gap-2">`;
    html += `<label class="text-[12px] text-fg-muted flex items-center gap-2 cursor-pointer">Auto-refill: `;
    html += `<label class="${SWITCH_TRACK}"><input type="checkbox" class="auto-refill-toggle peer sr-only" ${canvas.auto_refill ? 'checked' : ''}><span class="${SWITCH_KNOB}"></span></label>`;
    html += `</label>`;
    html += `</div>`;

    html += `</div>`; // canvas-unit
  }

  container.innerHTML = html;

  // Set cursor on spool slots (no event binding needed — delegation below)
  container.querySelectorAll('.canvas-spool-slot').forEach((slot) => {
    (slot as HTMLElement).style.cursor = 'pointer';
  });

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

function renderMonoFilament(container: HTMLElement, info: Record<string, unknown>): void {
  const type = (info.filament_type ?? info.type ?? '') as string;
  const color = (info.filament_color ?? info.color ?? '') as string;
  const name = (info.filament_name ?? info.name ?? '') as string;
  const minTemp = (info.min_nozzle_temp ?? info.minTemp ?? 0) as number;
  const maxTemp = (info.max_nozzle_temp ?? info.maxTemp ?? 0) as number;
  const brand = (info.brand ?? '') as string;

  const colorHex = color ? `#${color.replace(/^#/, '')}` : '#666';
  const label = name || type || 'Unknown';
  const tempRange = minTemp && maxTemp ? `${minTemp}–${maxTemp}°C` : '';
  const brandLabel = brand ? escapeHtml(brand) + ' ' : '';

  let html = '<div class="p-3">';
  html += '<div class="text-[13px] font-semibold text-fg-soft mb-3">Direct Drive Filament</div>';
  html += '<div class="flex items-center gap-4">';
  html += `<div class="w-13 h-13 rounded-full [border:4px_solid] relative flex items-center justify-center [transition:all_0.3s] shrink-0 [.spool-empty_&]:opacity-[0.3]" style="border-color: ${escapeAttr(colorHex)}">`;
  html += `<div class="w-full h-full rounded-full opacity-[0.3]" style="background: ${escapeAttr(colorHex)}"></div>`;
  html += `<div class="absolute top-[50%] left-[50%] [transform:translate(-50%,_-50%)] w-[18px] h-[18px] rounded-full bg-card border-2 border-[rgba(255,_255,_255,_0.1)]"></div>`;
  html += '</div>';
  html += `<div class="flex flex-col [gap:2px]">`;
  html += `<div class="text-[14px] font-medium">${brandLabel}${escapeHtml(label)}</div>`;
  if (tempRange) html += `<div class="text-[12px] text-fg-muted">${tempRange}</div>`;
  html += `</div>`;
  html += '</div>';

  // Show raw fields if we got unexpected structure (helps debug)
  const knownKeys = new Set([
    'filament_type',
    'type',
    'filament_color',
    'color',
    'filament_name',
    'name',
    'min_nozzle_temp',
    'minTemp',
    'max_nozzle_temp',
    'maxTemp',
    'brand',
    'error_code',
  ]);
  const extra = Object.entries(info).filter(([k]) => !knownKeys.has(k));
  if (extra.length > 0 && !type && !name) {
    html += '<div class="mt-2 text-[11px] text-fg-muted">';
    for (const [k, v] of extra) {
      html += `<div class="[&_span]:text-fg-soft [&_span]:font-medium"><span>${escapeHtml(k)}:</span> ${escapeHtml(String(v))}</div>`;
    }
    html += '</div>';
  }

  html += '</div>';
  container.innerHTML = html;
}
