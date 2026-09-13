/**
 * The file detail popover.
 *
 * Hover-only, and that is exactly why the row carries Print and Delete itself: this
 * surface does not exist on a touchscreen. What stays here is what only makes sense
 * with a pointer — a larger thumbnail, the slicer metadata, and Download, which needs a
 * filesystem to put the file on.
 *
 * Split out of `files.ts`. It does not import the renderer: `bindPopover` lends it each
 * render's state, sender and listing, the same way `file-thumbnails.ts` is lent them,
 * so nothing here can close an import loop back into the list.
 */

import { currentFileDir, currentFileSource } from './file-browsing';
import { cachedThumbnail, isFileCached } from './file-thumbnails';
import {
  THUMBNAIL_CLASS,
  applyDarkThumbnailCheck,
  escapeAttr,
  escapeHtml,
  formatBytes,
  formatTime,
} from './helpers';
import { icon } from './icons';
import type { PrinterState } from '../printer-state';
import type { FileEntry } from '../types';
import type { CommandSender } from '../ws-client';

let boundState: PrinterState | null = null;

/** Lend the popover this render's state, sender and listing. */
export function bindPopover(
  state: PrinterState,
  client: CommandSender,
  files: Map<string, FileEntry>,
): void {
  boundState = state;
  boundClient = client;
  fileMap = files;
}

/** The entry a row stands for, or undefined once the listing has moved on. */
export function popoverFile(filename: string): FileEntry | undefined {
  return fileMap.get(filename);
}

/** Is the pointer inside the popover? The mouseleave grace period asks this. */
export function popoverHovered(): boolean {
  return filePopover !== null && filePopover.matches(':hover');
}

// ── File detail popover on thumbnail hover ──────────────────────
let filePopover: HTMLElement | null = null;
let popoverTimeout: ReturnType<typeof setTimeout> | null = null;
let closePopoverTimeout: ReturnType<typeof setTimeout> | null = null;

/** How long a pointer must rest on a row before the popover opens. */
const OPEN_DELAY_MS = 300;
/**
 * Grace period before it closes. The pointer has to cross the gap between the row and
 * the popover, and closing the instant it leaves the row makes that crossing a race the
 * user loses.
 */
const CLOSE_DELAY_MS = 150;

/**
 * A pointer came to rest on a row.
 *
 * The open/close timers used to live in the list's hover delegation, which meant three
 * of this module's internals were being cleared and reassigned from outside it. The
 * list now says what happened; this decides what that means.
 */
export function schedulePopover(file: FileEntry, anchor: HTMLElement): void {
  if (closePopoverTimeout) {
    clearTimeout(closePopoverTimeout);
    closePopoverTimeout = null;
  }
  if (popoverTimeout) {
    clearTimeout(popoverTimeout);
    popoverTimeout = null;
  }
  // Already open: move it straight over, with no second delay. Waiting again would make
  // the popover lag a pointer sweeping down the list.
  if (filePopover) showFilePopover(file, anchor);
  else popoverTimeout = setTimeout(() => showFilePopover(file, anchor), OPEN_DELAY_MS);
}

/** The pointer left a row. Close unless it landed on the popover itself. */
export function schedulePopoverClose(): void {
  if (popoverTimeout) {
    clearTimeout(popoverTimeout);
    popoverTimeout = null;
  }
  closePopoverTimeout = setTimeout(() => {
    if (popoverHovered()) return;
    closeFilePopover();
  }, CLOSE_DELAY_MS);
}
/** Map filename → FileEntry for popover data lookup */
let fileMap = new Map<string, FileEntry>();
let boundClient: CommandSender | null = null;

/** Try to extract filament info from ECC2 slicer filename pattern */
function parseFilamentFromName(filename: string): { types: string[]; count: number } | null {
  // Pattern: ECC2_nozzle_name_FilamentType_layerHeight_time.gcode
  // May have multiple filament segments separated by +
  // Examples: "Elegoo PLA " or "Elegoo PLA + Elegoo PETG "
  const base = filename.replace(/\.gcode$/i, '');
  const parts = base.split('_');
  // Find filament-like segments (contain known type keywords)
  const typeKeywords = ['PLA', 'PETG', 'ABS', 'TPU', 'ASA', 'PA', 'PC', 'HIPS', 'PVA', 'Nylon'];
  const found: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (typeKeywords.some((kw) => trimmed.toUpperCase().includes(kw))) {
      // Split on + for multi-filament
      trimmed.split('+').forEach((seg) => {
        const s = seg.trim();
        if (s) found.push(s);
      });
    }
  }
  if (found.length === 0) return null;
  return { types: [...new Set(found)], count: found.length };
}

export function showFilePopover(file: FileEntry, anchor: HTMLElement): void {
  closeFilePopover();
  const fullPath =
    currentFileDir() === '/'
      ? file.filename
      : currentFileDir().replace(/^\//, '') + '/' + file.filename;
  const thumb = cachedThumbnail(fullPath);
  const isCached = isFileCached(fullPath);
  const filamentInfo = parseFilamentFromName(file.filename);

  const el = document.createElement('div');
  el.className = 'file-popover';

  let html = '<div class="flex flex-col [gap:10px]">';
  if (thumb) {
    html += `<img class="file-popover-thumb w-full max-h-45 object-contain rounded-chip bg-surface ${THUMBNAIL_CLASS}" src="data:image/png;base64,${thumb}" alt="Preview">`;
  }
  html += '<div class="">';
  html += `<div class="text-[13px] font-semibold text-fg break-all leading-[1.3]">${escapeHtml(file.filename)}</div>`;
  html +=
    '<table class="w-full text-[12px] [border-collapse:collapse] [&_td]:[padding:2px_0] [&_td:first-child]:text-fg-muted [&_td:first-child]:pr-3 [&_td:first-child]:whitespace-nowrap [&_td:last-child]:text-fg">';
  html += `<tr><td>Size</td><td>${formatBytes(file.size)}</td></tr>`;
  if (file.print_time)
    html += `<tr><td>Print time</td><td>${formatTime(file.print_time)}</td></tr>`;
  if (file.layer) html += `<tr><td>Layers</td><td>${file.layer}</td></tr>`;
  if (file.total_filament_used)
    html += `<tr><td>Filament</td><td>${file.total_filament_used.toFixed(1)}g</td></tr>`;
  if (filamentInfo) {
    html += `<tr><td>Material</td><td>${escapeHtml(filamentInfo.types.join(', '))}`;
    if (filamentInfo.count > 1) html += ` (${filamentInfo.count} filaments)`;
    html += `</td></tr>`;
  }
  // Show color map info if available from last file detail matching this file
  if (boundState?.lastFileDetail?.filename === fullPath && boundState.colorMap.length > 0) {
    const cm = boundState.colorMap;
    const swatches = cm
      .map((c) => {
        const hex = c.color.startsWith('#') ? c.color : `#${c.color}`;
        return `<span class="inline-block w-3 h-3 rounded-[3px] border border-[rgba(255,_255,_255,_0.2)] align-[middle] [margin-right:2px]" style="background:${escapeAttr(hex)}" title="${escapeAttr(c.name)}"></span>`;
      })
      .join(' ');
    html += `<tr><td>Filaments</td><td>${swatches} (${cm.length})</td></tr>`;
  }
  if (file.create_time) {
    const d = new Date(file.create_time * 1000);
    html += `<tr><td>Created</td><td>${d.toLocaleDateString()} ${d.toLocaleTimeString()}</td></tr>`;
  }
  if (isCached) html += `<tr><td>Cache</td><td>${icon('cached')} Cached on server</td></tr>`;
  html += '</table>';

  // One action, and it is the one the row does not carry. Delete and Print live on the
  // row; "Preview" opened a larger thumbnail popup from a popover that is already
  // showing the thumbnail — a second floating layer over the first, for the same image.
  html += '<div class="file-popover-actions flex [margin-top:6px] pt-2 border-t border-line">';
  html += `<button class="file-popover-download inline-flex w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-fg cursor-pointer transition-colors hover:bg-hover hover:border-fg-muted" title="Download">${icon('download')} Download</button>`;
  html += '</div>';

  html += '</div></div>';
  el.innerHTML = html;

  document.body.appendChild(el);

  // Bind popover action buttons
  const source = currentFileSource() === 'u-disk' ? 'u-disk' : 'local';
  el.querySelector('.file-popover-download')?.addEventListener('click', () => {
    closeFilePopover();
    const a = document.createElement('a');
    a.href = `/api/files/download?file=${encodeURIComponent(fullPath)}&source=${encodeURIComponent(source)}`;
    a.download = file.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  // Position relative to anchor
  const rect = anchor.getBoundingClientRect();
  const popW = 320;
  const popH = el.offsetHeight || 200;
  let left = rect.right + 8;
  let top = rect.top;
  // Keep within viewport
  if (left + popW > window.innerWidth) left = rect.left - popW - 8;
  if (top + popH > window.innerHeight) top = Math.max(8, window.innerHeight - popH - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  // Apply dark thumbnail check if we have an image
  const img = el.querySelector('.file-popover-thumb') as HTMLImageElement | null;
  if (img) applyDarkThumbnailCheck(img, el);

  filePopover = el;

  // Close when mouse leaves the popover (with delay for moving back)
  el.addEventListener('mouseleave', () => {
    closePopoverTimeout = setTimeout(() => closeFilePopover(), 150);
  });
  el.addEventListener('mouseenter', () => {
    if (closePopoverTimeout) {
      clearTimeout(closePopoverTimeout);
      closePopoverTimeout = null;
    }
  });
}

export function closeFilePopover(): void {
  if (popoverTimeout) {
    clearTimeout(popoverTimeout);
    popoverTimeout = null;
  }
  if (filePopover) {
    filePopover.remove();
    filePopover = null;
  }
}
