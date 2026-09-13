/**
 * Print start confirmation dialog with filament-to-Canvas slot mapping.
 *
 * Flow:
 * 1. Request file detail (method 1046) to get color_map, thumbnail, metadata
 * 2. Auto-map gcode colors to Canvas trays (exact color match, then closest match)
 * 3. User can reassign mappings via dropdown
 * 4. On confirm: send method 1020 with slot_map
 */

import { toggleState } from './state-classes';
import { icon, iconSolo } from './icons';
import type { PrinterState } from '../printer-state';
import type { CommandSender } from '../ws-client';
import type { CanvasInfo, CanvasTray } from '../types';
import {
  escapeHtml,
  escapeAttr,
  formatTime,
  fetchTimeout,
  applyDarkThumbnailCheck,
  THUMBNAIL_CLASS,
} from './helpers';
import { toast } from './toast';
import { currentFileSource } from './files';

/** Format bytes to human-readable size */
function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Pending dialog state while waiting for 1046 response */
let pendingPrint: {
  filename: string;
  fullPath: string;
  client: CommandSender;
  state: PrinterState;
} | null = null;

/** Each color from the gcode mapped to a Canvas tray */
interface ColorMapping {
  /** Index in color_map (the 't' field) */
  t: number;
  /** Gcode filament color hex */
  gcodeColor: string;
  /** Gcode filament type name */
  gcodeType: string;
  /** Mapped Canvas unit & tray (-1 if unmapped) */
  canvasId: number;
  trayId: number;
  /** Mapped tray color */
  mappedColor: string;
  /** Mapped tray filament type */
  mappedType: string;
}

/** All available Canvas trays flattened */
interface FlatTray {
  canvasId: number;
  tray: CanvasTray;
}

/**
 * Called from files.ts when user clicks Print.
 * Requests file detail (1046) and waits for the response to show the dialog.
 */
export function requestPrintDialog(
  filename: string,
  fullPath: string,
  client: CommandSender,
  state: PrinterState,
): void {
  pendingPrint = { filename, fullPath, client, state };
  // Request file detail to get color_map + thumbnail + metadata
  client.sendCommand(1046, { storage_media: currentFileSource(), filename: fullPath });
  // Also request thumbnail separately (1046 may not include it)
  client.sendCommand(1045, { storage_media: currentFileSource(), file_name: fullPath });
}

/**
 * Called from main.ts when method 1046 response arrives.
 * If we have a pending print dialog, show it now.
 */
export function handleFileDetailForPrint(state: PrinterState): void {
  if (!pendingPrint) return;
  const { filename, fullPath, client } = pendingPrint;
  pendingPrint = null;
  showDialog(filename, fullPath, state, client);
}

/** Compute color distance (simple Euclidean in RGB space) */
function colorDistance(hex1: string, hex2: string): number {
  const parse = (h: string) => {
    const c = h.replace('#', '');
    return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
  };
  try {
    const [r1, g1, b1] = parse(hex1);
    const [r2, g2, b2] = parse(hex2);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  } catch {
    return Infinity;
  }
}

/** Contrast color for text on a given background */
function contrastColor(hex: string): string {
  try {
    const c = hex.replace('#', '');
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    // Relative luminance
    return r * 0.299 + g * 0.587 + b * 0.114 > 128 ? '#000' : '#fff';
  } catch {
    return '#fff';
  }
}

/** Get all available (non-empty) Canvas trays */
function getAvailableTrays(canvas: CanvasInfo | null): FlatTray[] {
  if (!canvas?.canvas_list?.length) return [];
  const trays: FlatTray[] = [];
  for (const unit of canvas.canvas_list) {
    if (!unit.connected) continue;
    for (const tray of unit.tray_list) {
      if (tray.status !== 0) {
        // not empty
        trays.push({ canvasId: unit.canvas_id, tray });
      }
    }
  }
  return trays;
}

/** Auto-map gcode colors to Canvas trays */
function autoMap(
  colorMap: Array<{ t: number; color: string; name: string }>,
  canvas: CanvasInfo | null,
): ColorMapping[] {
  const trays = getAvailableTrays(canvas);
  const usedTrays = new Set<string>(); // "canvasId:trayId"

  return colorMap.map((cm) => {
    const mapping: ColorMapping = {
      t: cm.t,
      gcodeColor: cm.color.startsWith('#') ? cm.color : `#${cm.color}`,
      gcodeType: cm.name || 'Unknown',
      canvasId: -1,
      trayId: -1,
      mappedColor: '',
      mappedType: '',
    };

    // Try exact color match first (case-insensitive), preferring same filament type
    let bestMatch: FlatTray | null = null;
    let bestDist = Infinity;

    for (const ft of trays) {
      const key = `${ft.canvasId}:${ft.tray.tray_id}`;
      if (usedTrays.has(key)) continue;

      const trayColor = ft.tray.filament_color.startsWith('#')
        ? ft.tray.filament_color
        : `#${ft.tray.filament_color}`;
      const dist = colorDistance(mapping.gcodeColor, trayColor);

      // Penalize type mismatch
      const typeMatch = ft.tray.filament_type.toUpperCase() === mapping.gcodeType.toUpperCase();
      const adjustedDist = typeMatch ? dist : dist + 100;

      if (adjustedDist < bestDist) {
        bestDist = adjustedDist;
        bestMatch = ft;
      }
    }

    if (bestMatch && bestDist < 200) {
      // threshold: allow reasonable matches
      const key = `${bestMatch.canvasId}:${bestMatch.tray.tray_id}`;
      usedTrays.add(key);
      mapping.canvasId = bestMatch.canvasId;
      mapping.trayId = bestMatch.tray.tray_id;
      mapping.mappedColor = bestMatch.tray.filament_color.startsWith('#')
        ? bestMatch.tray.filament_color
        : `#${bestMatch.tray.filament_color}`;
      mapping.mappedType = bestMatch.tray.filament_type;
    }

    return mapping;
  });
}

/** Show the print confirmation dialog */
function showDialog(
  filename: string,
  fullPath: string,
  state: PrinterState,
  client: CommandSender,
): void {
  // Remove any existing dialog
  document.getElementById('print-dialog-overlay')?.remove();

  const canvas = state.canvas;
  const hasCanvas = !!canvas?.canvas_list?.length;
  const colorMap = state.colorMap;
  const isMultiColor = hasCanvas && colorMap.length > 0;
  const detail = state.lastFileDetail;
  const trays = getAvailableTrays(canvas);

  // Auto-map colors to Canvas trays
  const mappings = isMultiColor ? autoMap(colorMap, canvas) : [];
  const autoRefill = canvas?.auto_refill ?? false;

  // Build dialog HTML
  const overlay = document.createElement('div');
  overlay.id = 'print-dialog-overlay';
  overlay.className =
    'print-dialog-overlay fixed inset-0 bg-[rgba(0,_0,_0,_0.7)] flex items-center justify-center z-[10000] p-5';

  const timeStr = detail?.print_time ? formatTime(detail.print_time) : '';
  const layerStr = detail?.layer ? `${detail.layer} layers` : '';
  const filamentStr = state.fileFilamentUsed ? `${state.fileFilamentUsed.toFixed(1)}g` : '';
  const metaParts = [timeStr, layerStr, filamentStr].filter(Boolean);

  let mappingHtml = '';
  if (isMultiColor) {
    mappingHtml = `
      <div class="[margin-bottom:14px]">
        <div class="text-[11px] uppercase tracking-[0.3px] text-fg-muted mb-2 font-semibold">Filament Mapping</div>
        <div class="flex flex-col [gap:6px]" id="print-dialog-mappings">
          ${renderMappings(mappings, trays)}
        </div>
      </div>`;
  }

  overlay.innerHTML = `
    <div class="bg-card border border-line rounded-[8px] w-full max-w-110 max-h-[90vh] flex flex-col [box-shadow:0_8px_32px_rgba(0,_0,_0,_0.5)]">
      <div class="flex justify-between items-center [padding:12px_16px] border-b border-line font-semibold text-[14px] text-fg">
        <span>Start Print</span>
        <button class="bg-transparent border-0 text-fg-soft text-[20px] cursor-pointer [padding:0_4px] leading-[1] hover:text-fg" id="print-dialog-cancel-x">&times;</button>
      </div>
      <div class="p-4 overflow-y-auto flex-1">
        <div class="flex gap-3 mb-4">
          <div class="w-24 h-24 shrink-0 rounded-[6px] overflow-hidden bg-surface flex items-center justify-center [&_img]:w-full [&_img]:h-full [&_img]:object-cover" id="print-dialog-thumb">
            ${
              detail?.thumbnail || state.thumbnail
                ? `<img src="data:image/png;base64,${detail?.thumbnail || state.thumbnail}" alt="Preview" id="print-dialog-thumb-img" class="${THUMBNAIL_CLASS}">`
                : '<div class="text-fg-muted text-[11px] text-center">No preview</div>'
            }
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-semibold text-[13px] text-fg [word-break:break-word] [margin-bottom:6px]">${escapeHtml(filename)}</div>
            ${metaParts.length ? `<div class="text-fg-soft text-[12px] [&_span_+_span::before]:content-['_·_']">${metaParts.map((p) => `<span>${escapeHtml(p)}</span>`).join(' · ')}</div>` : ''}
          </div>
        </div>
        ${mappingHtml}
        <div class="[margin-bottom:14px]">
          <div class="text-[11px] uppercase tracking-[0.3px] text-fg-muted mb-2 font-semibold">Print Settings</div>
          <div class="flex flex-col [gap:10px]">
            <div class="[&_label:first-child]:text-[12px] [&_label:first-child]:text-fg-soft [&_label:first-child]:[margin-bottom:6px] [&_label:first-child]:block">
              <label>Build Plate</label>
              <div class="flex gap-0 rounded-[6px] overflow-hidden border border-line">
                <button type="button" class="print-bed-btn active flex-1 [padding:8px_12px] border-0 bg-accent text-white text-[12px] font-semibold cursor-pointer [transition:background_0.15s,_color_0.15s] hover:bg-hover hover:text-fg [&:not(:last-child)]:border-r [&:not(:last-child)]:border-line" data-bed="A">Textured (A)</button>
                <button type="button" class="print-bed-btn flex-1 [padding:8px_12px] border-0 bg-surface text-fg-soft text-[12px] font-semibold cursor-pointer [transition:background_0.15s,_color_0.15s] hover:bg-hover hover:text-fg [&:not(:last-child)]:border-r [&:not(:last-child)]:border-line" data-bed="B">Smooth (B)</button>
              </div>
            </div>
            <div class="flex gap-3 flex-wrap">
              <label class="flex items-center gap-2 cursor-pointer text-[12px] text-fg select-none [&_input[type="checkbox"]]:appearance-none [&_input[type="checkbox"]]:[-webkit-appearance:none] [&_input[type="checkbox"]]:w-[18px] [&_input[type="checkbox"]]:h-[18px] [&_input[type="checkbox"]]:border-2 [&_input[type="checkbox"]]:border-line [&_input[type="checkbox"]]:rounded-[4px] [&_input[type="checkbox"]]:bg-surface [&_input[type="checkbox"]]:cursor-pointer [&_input[type="checkbox"]]:relative [&_input[type="checkbox"]]:shrink-0 [&_input[type="checkbox"]]:[transition:background_0.15s,_border-color_0.15s] [&_input[type="checkbox"]:checked]:bg-accent [&_input[type="checkbox"]:checked]:border-accent [&_input[type="checkbox"]:hover]:border-accent [&_input[type="checkbox"]:checked::after]:content-[''] [&_input[type="checkbox"]:checked::after]:absolute [&_input[type="checkbox"]:checked::after]:left-1 [&_input[type="checkbox"]:checked::after]:top-[1px] [&_input[type="checkbox"]:checked::after]:w-[6px] [&_input[type="checkbox"]:checked::after]:h-[10px] [&_input[type="checkbox"]:checked::after]:[border:solid_#fff] [&_input[type="checkbox"]:checked::after]:[border-width:0_2px_2px_0] [&_input[type="checkbox"]:checked::after]:[transform:rotate(45deg)]"><input type="checkbox" id="print-opt-timelapse" checked><span>Timelapse</span></label>
              <label class="flex items-center gap-2 cursor-pointer text-[12px] text-fg select-none [&_input[type="checkbox"]]:appearance-none [&_input[type="checkbox"]]:[-webkit-appearance:none] [&_input[type="checkbox"]]:w-[18px] [&_input[type="checkbox"]]:h-[18px] [&_input[type="checkbox"]]:border-2 [&_input[type="checkbox"]]:border-line [&_input[type="checkbox"]]:rounded-[4px] [&_input[type="checkbox"]]:bg-surface [&_input[type="checkbox"]]:cursor-pointer [&_input[type="checkbox"]]:relative [&_input[type="checkbox"]]:shrink-0 [&_input[type="checkbox"]]:[transition:background_0.15s,_border-color_0.15s] [&_input[type="checkbox"]:checked]:bg-accent [&_input[type="checkbox"]:checked]:border-accent [&_input[type="checkbox"]:hover]:border-accent [&_input[type="checkbox"]:checked::after]:content-[''] [&_input[type="checkbox"]:checked::after]:absolute [&_input[type="checkbox"]:checked::after]:left-1 [&_input[type="checkbox"]:checked::after]:top-[1px] [&_input[type="checkbox"]:checked::after]:w-[6px] [&_input[type="checkbox"]:checked::after]:h-[10px] [&_input[type="checkbox"]:checked::after]:[border:solid_#fff] [&_input[type="checkbox"]:checked::after]:[border-width:0_2px_2px_0] [&_input[type="checkbox"]:checked::after]:[transform:rotate(45deg)]"><input type="checkbox" id="print-opt-leveling"><span>Bed Leveling</span></label>
              ${isMultiColor ? `<label class="flex items-center gap-2 cursor-pointer text-[12px] text-fg select-none [&_input[type="checkbox"]]:appearance-none [&_input[type="checkbox"]]:[-webkit-appearance:none] [&_input[type="checkbox"]]:w-[18px] [&_input[type="checkbox"]]:h-[18px] [&_input[type="checkbox"]]:border-2 [&_input[type="checkbox"]]:border-line [&_input[type="checkbox"]]:rounded-[4px] [&_input[type="checkbox"]]:bg-surface [&_input[type="checkbox"]]:cursor-pointer [&_input[type="checkbox"]]:relative [&_input[type="checkbox"]]:shrink-0 [&_input[type="checkbox"]]:[transition:background_0.15s,_border-color_0.15s] [&_input[type="checkbox"]:checked]:bg-accent [&_input[type="checkbox"]:checked]:border-accent [&_input[type="checkbox"]:hover]:border-accent [&_input[type="checkbox"]:checked::after]:content-[''] [&_input[type="checkbox"]:checked::after]:absolute [&_input[type="checkbox"]:checked::after]:left-1 [&_input[type="checkbox"]:checked::after]:top-[1px] [&_input[type="checkbox"]:checked::after]:w-[6px] [&_input[type="checkbox"]:checked::after]:h-[10px] [&_input[type="checkbox"]:checked::after]:[border:solid_#fff] [&_input[type="checkbox"]:checked::after]:[border-width:0_2px_2px_0] [&_input[type="checkbox"]:checked::after]:[transform:rotate(45deg)]"><input type="checkbox" id="print-opt-auto-refill" ${autoRefill ? 'checked' : ''}><span>Auto Refill</span></label>` : ''}
            </div>
          </div>
        </div>
      </div>
      <div class="print-dialog-footer flex justify-end gap-2 [padding:12px_16px] border-t border-line">
        <button class="inline-flex items-center justify-center [padding:8px_16px] border border-line rounded-chip text-[13px] font-medium cursor-pointer [transition:all_0.15s] text-fg-soft bg-transparent max-[800px]:[padding:8px_16px] pointer-coarse:min-h-11 hover:[filter:brightness(1.15)] active:[transform:scale(0.97)] [.spool-actions_&]:text-[9px] [.spool-actions_&]:[padding:2px_8px] [.spool-actions_&]:rounded-[10px] [.file-popover-actions_&]:text-[12px] [.file-popover-actions_&]:[padding:4px_10px] max-[800px]:[.file-actions_&]:min-h-9 max-[800px]:[.file-actions_&]:min-w-9 max-[800px]:[.file-actions_&]:[padding:6px_8px] [.settings-card-move_&]:[padding:1px_6px] [.settings-card-move_&]:text-[10px] [.settings-card-move_&]:leading-[1] [.ai-label-config-delete_&]:text-bad [.ai-label-config-delete_&]:[padding:4px_8px] [.ai-label-config-delete_&]:text-[14px] [.ai-label-config-delete_&]:leading-[1] hover:[.ai-label-config-delete_&]:bg-[rgba(239,_83,_80,_0.15)]" id="print-dialog-cancel">Cancel</button>
        <button class="inline-flex items-center justify-center [padding:8px_16px] border-0 rounded-chip text-[13px] font-medium cursor-pointer [transition:all_0.15s] text-white bg-accent max-[800px]:[padding:8px_16px] pointer-coarse:min-h-11 hover:[filter:brightness(1.15)] active:[transform:scale(0.97)] [.spool-actions_&]:text-[9px] [.spool-actions_&]:[padding:2px_8px] [.spool-actions_&]:rounded-[10px] [.file-popover-actions_&]:text-[12px] [.file-popover-actions_&]:[padding:4px_10px] max-[800px]:[.file-actions_&]:min-h-9 max-[800px]:[.file-actions_&]:min-w-9 max-[800px]:[.file-actions_&]:[padding:6px_8px] [.settings-card-move_&]:[padding:1px_6px] [.settings-card-move_&]:text-[10px] [.settings-card-move_&]:leading-[1] [.ai-label-config-delete_&]:text-bad [.ai-label-config-delete_&]:[padding:4px_8px] [.ai-label-config-delete_&]:text-[14px] [.ai-label-config-delete_&]:leading-[1] [.print-dialog-footer_&]:min-w-25 hover:[.ai-label-config-delete_&]:bg-[rgba(239,_83,_80,_0.15)]" id="print-dialog-confirm">${icon('play')} Print</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Apply dark thumbnail check
  const thumbImg = document.getElementById('print-dialog-thumb-img') as HTMLImageElement | null;
  const thumbContainer = document.getElementById('print-dialog-thumb') as HTMLElement | null;
  if (thumbImg && thumbContainer) {
    applyDarkThumbnailCheck(thumbImg, thumbContainer);
  }

  // Bind mapping dropdowns
  if (isMultiColor) {
    bindMappingDropdowns(mappings, trays);
  }

  // Bind bed plate toggle buttons
  overlay.querySelectorAll('.print-bed-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.print-bed-btn').forEach((b) => toggleState(b, 'active', false));
      toggleState(btn, 'active', true);
    });
  });

  // Close handlers
  const close = () => overlay.remove();
  document.getElementById('print-dialog-cancel')!.addEventListener('click', close);
  document.getElementById('print-dialog-cancel-x')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  // Confirm handler
  document.getElementById('print-dialog-confirm')!.addEventListener('click', async () => {
    // Check all colors are mapped if multi-color
    if (isMultiColor) {
      const unmapped = mappings.filter((m) => m.trayId === -1);
      if (unmapped.length > 0) {
        toast(`${unmapped.length} color(s) not mapped to Canvas trays`, 'error');
        return;
      }
    }

    const bedType =
      (overlay.querySelector('.print-bed-btn.active') as HTMLElement)?.dataset.bed || 'A';
    const leveling = (document.getElementById('print-opt-leveling') as HTMLInputElement).checked;
    const timelapse = (document.getElementById('print-opt-timelapse') as HTMLInputElement).checked;

    const slotMap = isMultiColor
      ? mappings.map((m) => ({ t: m.t, canvas_id: m.canvasId, tray_id: m.trayId }))
      : [];

    const confirmBtn = document.getElementById('print-dialog-confirm') as HTMLButtonElement;
    const cancelBtn = document.getElementById('print-dialog-cancel') as HTMLButtonElement;
    const cancelXBtn = document.getElementById('print-dialog-cancel-x') as HTMLButtonElement;
    const footerEl = overlay.querySelector('.print-dialog-footer') as HTMLElement;

    // Show precache progress
    if (fullPath.toLowerCase().endsWith('.gcode')) {
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      cancelXBtn.disabled = true;

      // Insert progress bar before footer
      const progressEl = document.createElement('div');
      progressEl.className = 'print-dialog-precache [padding:8px_16px_4px]';
      progressEl.innerHTML = `
        <div class="h-1 bg-input rounded-[2px] overflow-hidden mb-1">
          <div class="print-dialog-precache-fill h-full bg-accent rounded-[2px] [transition:width_0.3s_ease]"></div>
        </div>
        <div class="print-dialog-precache-text text-[11px] text-fg-soft">Caching gcode for preview…</div>
      `;
      footerEl.before(progressEl);

      const fillEl = progressEl.querySelector('.print-dialog-precache-fill') as HTMLElement;
      const textEl = progressEl.querySelector('.print-dialog-precache-text') as HTMLElement;

      // Animate indeterminate progress
      fillEl.style.width = '30%';

      try {
        const resp = await fetchTimeout(
          '/api/files/precache',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: fullPath, source: currentFileSource() }),
          },
          120_000,
        );

        const result = (await resp.json()) as {
          ok: boolean;
          cached: boolean;
          size: number;
          error?: string;
        };
        fillEl.style.width = '100%';

        if (result.ok) {
          textEl.textContent = result.cached
            ? 'Already cached'
            : `Cached (${formatSize(result.size)})`;
        } else {
          // Precache failed — warn but still allow printing
          textEl.textContent = `Cache failed: ${result.error ?? 'unknown'} — printing anyway`;
          textEl.style.color = 'var(--warning)';
        }
      } catch {
        // Network error — warn but still allow printing
        fillEl.style.width = '100%';
        fillEl.style.background = 'var(--warning)';
        textEl.textContent = 'Cache unavailable — printing anyway';
        textEl.style.color = 'var(--warning)';
      }

      // Brief pause so user sees the result
      await new Promise((r) => setTimeout(r, 400));
      progressEl.remove();
    }

    // Update auto refill setting if changed
    if (isMultiColor) {
      const autoRefillEl = document.getElementById(
        'print-opt-auto-refill',
      ) as HTMLInputElement | null;
      if (autoRefillEl && autoRefillEl.checked !== (canvas?.auto_refill ?? false)) {
        client.sendCommand(2004, { auto_refill: autoRefillEl.checked });
      }
    }

    client.sendCommand(1020, {
      storage_media: currentFileSource(),
      filename: fullPath,
      config: {
        delay_video: timelapse,
        printer_check: leveling,
        print_layout: bedType,
        bedlevel_force: false,
        slot_map: slotMap,
      },
    });

    close();
    toast(`Starting print: ${filename}`, 'success');
  });
}

/** Render the filament mapping as gcode color chips + graphical 2×2 spool grids */
function renderMappings(mappings: ColorMapping[], trays: FlatTray[]): string {
  // Group trays by canvas unit
  const canvasUnits = new Map<number, FlatTray[]>();
  for (const ft of trays) {
    const list = canvasUnits.get(ft.canvasId) || [];
    list.push(ft);
    canvasUnits.set(ft.canvasId, list);
  }

  return mappings
    .map((m, idx) => {
      const gcColor = m.gcodeColor;
      const gcContrast = contrastColor(gcColor);

      // Render a 2×2 spool grid for each canvas unit
      // Physical layout CCW from top-left: tray 0=TL, 1=BL, 2=BR, 3=TR
      // CSS grid row-major: pos0=TL, pos1=TR, pos2=BL, pos3=BR
      const gridOrder = [0, 3, 1, 2]; // maps grid position → tray index

      let gridsHtml = '';
      for (const [canvasId, unitTrays] of canvasUnits) {
        const spoolsHtml = gridOrder
          .map((trayIdx) => {
            const ft = unitTrays.find((t) => t.tray.tray_id === trayIdx);
            if (!ft)
              return '<div class="print-spool print-spool-empty w-11 h-11 rounded-[6px] cursor-default flex flex-col items-center justify-center border-2 border-transparent [transition:border-color_0.15s,_transform_0.15s] relative overflow-hidden opacity-[0.3] hover:[&:not(.print-spool-empty)]:[transform:scale(1.1)] hover:[&:not(.print-spool-empty)]:border-fg-soft"></div>';

            const color = ft.tray.filament_color.startsWith('#')
              ? ft.tray.filament_color
              : `#${ft.tray.filament_color}`;
            const isEmpty = ft.tray.status === 0;
            const isSelected = ft.canvasId === m.canvasId && ft.tray.tray_id === m.trayId;
            const spoolColor = isEmpty ? '#44403c' : color;
            const typeLabel = isEmpty ? '/' : ft.tray.filament_type;
            const trayNum = ft.tray.tray_id + 1;
            const labelContrast = contrastColor(spoolColor);

            return `<div class="print-spool w-11 h-11 rounded-[6px] cursor-pointer flex flex-col items-center justify-center border-2 border-transparent [transition:border-color_0.15s,_transform_0.15s] relative overflow-hidden hover:[&:not(.print-spool-empty)]:[transform:scale(1.1)] hover:[&:not(.print-spool-empty)]:border-fg-soft ${isEmpty ? 'print-spool-empty cursor-default opacity-[0.3]' : ''} ${isSelected ? 'border-accent [box-shadow:0_0_8px_var(--accent)] [transform:scale(1.05)]' : ''}"
          data-idx="${idx}" data-canvas="${ft.canvasId}" data-tray="${ft.tray.tray_id}"
          style="--spool-color: ${escapeAttr(spoolColor)}"
          title="${escapeAttr(typeLabel)} (C${canvasId + 1}:T${trayNum})">
          <div class="absolute inset-0 rounded-[4px] bg-[var(--spool-color,_#44403c)] [.print-spool-empty_&]:bg-[#44403c]"></div>
          <div class="relative z-[1] text-[13px] [font-weight:800] leading-[1] [text-shadow:0_0_4px_rgba(0,_0,_0,_0.6)]" style="color:${labelContrast}">${trayNum}</div>
          <div class="relative z-[1] text-[8px] font-bold leading-[1] [text-shadow:0_0_3px_rgba(0,_0,_0,_0.6)] uppercase tracking-[0.3px]" style="color:${labelContrast}">${escapeHtml(typeLabel)}</div>
        </div>`;
          })
          .join('');

        gridsHtml += `<div class="grid grid-cols-[1fr_1fr] [grid-template-rows:1fr_1fr] gap-1 shrink-0" data-canvas="${canvasId}">${spoolsHtml}</div>`;
      }

      return `
      <div class="flex items-center gap-2" data-idx="${idx}">
        <div class="w-20 [padding:4px_8px] rounded-[4px] text-[11px] font-semibold text-center shrink-0" style="background:${escapeAttr(gcColor)};color:${gcContrast}">
          ${escapeHtml(m.gcodeType)}
        </div>
        <div class="text-fg-muted text-[14px] shrink-0">${iconSolo('changeTo')}</div>
        <div class="flex gap-2 flex-1">
          ${gridsHtml}
        </div>
      </div>`;
    })
    .join('');
}

/** Bind click events on spool grid items */
function bindMappingDropdowns(mappings: ColorMapping[], trays: FlatTray[]): void {
  const container = document.getElementById('print-dialog-mappings');
  if (!container) return;

  container.addEventListener('click', (e) => {
    const spool = (e.target as HTMLElement).closest('.print-spool[data-idx]') as HTMLElement | null;
    if (!spool || spool.classList.contains('print-spool-empty')) return;

    const idx = parseInt(spool.dataset.idx ?? '-1');
    const canvasId = parseInt(spool.dataset.canvas ?? '-1');
    const trayId = parseInt(spool.dataset.tray ?? '-1');
    if (idx < 0 || idx >= mappings.length) return;

    const ft = trays.find((t) => t.canvasId === canvasId && t.tray.tray_id === trayId);
    if (!ft) return;

    // Toggle: clicking already-selected spool deselects it
    if (mappings[idx].canvasId === canvasId && mappings[idx].trayId === trayId) {
      mappings[idx].canvasId = -1;
      mappings[idx].trayId = -1;
      mappings[idx].mappedColor = '';
      mappings[idx].mappedType = '';
    } else {
      mappings[idx].canvasId = canvasId;
      mappings[idx].trayId = trayId;
      mappings[idx].mappedColor = ft.tray.filament_color.startsWith('#')
        ? ft.tray.filament_color
        : `#${ft.tray.filament_color}`;
      mappings[idx].mappedType = ft.tray.filament_type;
    }

    // Re-render all mappings to update selection state
    container.innerHTML = renderMappings(mappings, trays);
  });
}
