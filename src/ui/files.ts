import { toggleState } from './state-classes';
import { uploadFile } from './file-upload';
import { bindPopover, closeFilePopover } from './file-popover';
import {
  cachedThumbnail,
  fetchCachedStatus,
  bindThumbnails,
  fetchInlineThumbnails,
  isFileCached,
  resetThumbnailQueue,
} from './file-thumbnails';
import { currentFileDir, currentFileSource, setFileSource } from './file-browsing';
import { bindFileActions, ensureFileActions } from './file-actions';
import { reapplyBusyGuard } from './busy-guard';
import { positionSegmented } from './segmented';
import { EMPTY } from './design';
import { icon, iconSolo } from './icons';
import type { PrinterState } from '../printer-state';
import type { CommandSender } from '../ws-client';
import type { FileEntry } from '../types';
import {
  $,
  escapeHtml,
  formatBytes,
  escapeAttr,
  formatTime,
  THUMBNAIL_CLASS,
  THUMBNAIL_PLACEHOLDER_SRC,
} from './helpers';
import { type ListControls, createListControls } from './list-controls';

/** An icon-only action on a file row. Three of them have to fit beside a filename. */
const ROW_BTN = [
  'inline-flex items-center justify-center shrink-0 h-8 w-8 rounded-lg',
  'border border-line bg-card text-fg-soft cursor-pointer',
  'transition-colors hover:bg-hover hover:text-fg hover:border-fg-muted',
].join(' ');

/** The same, for the one that destroys something. */
const ROW_BTN_BAD = [
  'inline-flex items-center justify-center shrink-0 h-8 w-8 rounded-lg',
  'border border-line bg-card text-fg-muted cursor-pointer',
  'transition-colors hover:bg-bad hover:text-white hover:border-bad',
].join(' ');

let _lastState: PrinterState | null = null;
/** The sender for the whole card. Refreshed on every render. */
let _client: CommandSender | null = null;

function renderBreadcrumb(_client: CommandSender): string {
  if (currentFileDir() === '/') return '';
  const parts = currentFileDir().split('/').filter(Boolean);
  let html =
    '<div class="flex items-center [gap:2px] [padding:4px_0] [margin-bottom:6px] text-[12px] flex-wrap">';
  html += `<button class="file-nav-btn inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-fg cursor-pointer transition-colors hover:bg-hover hover:border-fg-muted disabled:opacity-50 disabled:cursor-not-allowed" data-dir="/">${icon('home')} Root</button>`;
  let path = '';
  for (let i = 0; i < parts.length; i++) {
    path += '/' + parts[i];
    const isLast = i === parts.length - 1;
    html += `<span class="text-fg-muted [margin:0_2px]">/</span>`;
    if (isLast) {
      html += `<span class="text-fg font-medium">${escapeHtml(parts[i])}</span>`;
    } else {
      html += `<button class="file-nav-btn inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-fg cursor-pointer transition-colors hover:bg-hover hover:border-fg-muted disabled:opacity-50 disabled:cursor-not-allowed" data-dir="${escapeAttr(path)}">${escapeHtml(parts[i])}</button>`;
    }
  }
  html += '</div>';
  return html;
}

function renderCapacityBar(state: PrinterState): string {
  const cap = state.storageCapacity;
  if (!cap || cap.total === 0) return '';
  const usedPct = Math.min(100, Math.round((cap.used / cap.total) * 100));
  // ONE background utility, chosen here. It used to be `bg-accent` plus a `capacity-warn`
  // / `capacity-high` class that appears at this call site and in no stylesheet — so a
  // disk at 95% drew the same accent blue as one at 10%, and had the classes existed,
  // two background utilities on one element have no defined winner anyway.
  const fill = usedPct > 90 ? 'bg-bad' : usedPct > 75 ? 'bg-warn' : 'bg-accent';
  return `<div class="mb-1.5 flex items-center gap-2">
    <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-input"><div class="h-full rounded-full ${fill} [transition:width_0.3s]" style="width:${usedPct}%"></div></div>
    <span class="shrink-0 text-[11px] text-fg-muted whitespace-nowrap">${formatBytes(cap.used)} / ${formatBytes(cap.total)}</span>
  </div>`;
}

/**
 * Sort and filter controls (ELEG-49). Created lazily on the first render because the
 * card may be hidden at startup, and once only — the bar lives in `#file-list-controls`,
 * a static sibling of `#file-list`, so nothing here is touched when the list repaints.
 */
let fileControls: ListControls<FileEntry> | null = null;

function ensureFileControls(): ListControls<FileEntry> {
  if (fileControls) return fileControls;
  fileControls = createListControls<FileEntry>({
    id: 'files',
    container: $('file-list-controls'),
    noun: 'files',
    filterPlaceholder: 'Filter files…',
    filterText: (file) => file.filename,
    // Folders first is a *grouping*, not a sort key: it holds whichever column is
    // active and in both directions, which is why it is not just another comparator.
    group: (file) => (file.type === 'folder' ? 0 : 1),
    columns: [
      // You find a file by what it is called, how big it is, or how recent it is.
      // "Print time" and "Layers" were two more chips above a list of two files; both
      // figures are on every row to read, and neither is how anyone looks for a model.
      { key: 'name', label: 'Name', value: (f) => f.filename },
      { key: 'size', label: 'Size', value: (f) => f.size, initialDirection: 'desc' },
      { key: 'created', label: 'Added', value: (f) => f.create_time, initialDirection: 'desc' },
    ],
    defaultSort: { key: 'name', dir: 'asc' },
    onChange: () => {
      if (_lastState && _client) renderFiles(_lastState, _client);
    },
  });
  return fileControls;
}

export function renderFiles(state: PrinterState, client: CommandSender): void {
  _lastState = state;
  _client = client;
  const container = $('file-list');
  const files = state.files;
  const controls = ensureFileControls();

  let html = renderCapacityBar(state);

  // Show USB not-connected warning
  if (currentFileSource() === 'u-disk' && !state.status?.external_device?.u_disk) {
    html += `<div class="${EMPTY}"><i class="bi bi-usb-drive" aria-hidden="true"></i>No USB drive detected</div>`;
  }

  html += renderBreadcrumb(client);

  // Sorted client-side over the whole listing: 1044 returns the directory in one
  // response and offers no ordering, so there is no server-side sort to ask for.
  const sorted = controls.apply(files);

  if (!sorted.length) {
    html += controls.emptyHtml(
      `No files ${currentFileDir() === '/' ? '' : 'in this folder '}on ${currentFileSource() === 'u-disk' ? 'USB drive' : 'printer'}`,
    );
    container.innerHTML = html;
    bindFileActions(state, client);
    ensureFileActions(container);
    return;
  }

  for (const file of sorted) {
    const isFolder = file.type === 'folder';
    const sizeMB = isFolder ? '' : (file.size / (1024 * 1024)).toFixed(1);
    const timeInfo = file.print_time ? formatTime(file.print_time) : '';
    const layerInfo = file.layer ? `${file.layer} layers` : '';
    const filamentInfo = file.total_filament_used
      ? `${file.total_filament_used.toFixed(1)}g filament`
      : '';
    const meta = isFolder
      ? 'Folder'
      : [sizeMB + ' MB', timeInfo, layerInfo, filamentInfo].filter(Boolean).join(' · ');

    const fullPath =
      currentFileDir() === '/'
        ? file.filename
        : currentFileDir().replace(/^\//, '') + '/' + file.filename;
    const isCached = isFileCached(fullPath);
    const cachedThumb = cachedThumbnail(fullPath);
    const cacheMarker = isCached
      ? ` <span class="[margin-left:6px] text-[11px] shrink-0 opacity-[0.8]" title="Cached on server">${iconSolo('cached')}</span>`
      : '';

    let iconHtml: string;
    if (isFolder) {
      iconHtml = icon('folder');
    } else if (cachedThumb) {
      iconHtml = `<img src="data:image/png;base64,${cachedThumb}" alt="Thumb" class="w-10 h-10 object-cover rounded-chip ${THUMBNAIL_CLASS}">`;
    } else if (file.filename.toLowerCase().endsWith('.gcode')) {
      // A gcode file whose thumbnail is queued, absent or unusable. Same placeholder
      // the error handler swaps in, so "no thumbnail" and "bad thumbnail" look alike
      // and deliberate rather than one being a mismatched emoji in a grid of previews
      // (ELEG-42). Replaced in place by handleInlineThumbnail when one arrives.
      iconHtml = `<img src="${THUMBNAIL_PLACEHOLDER_SRC}" alt="No preview" class="thumb-img-fallback w-10 h-10 object-contain rounded-chip opacity-[0.55] [padding:2px]">`;
    } else {
      iconHtml = icon('file');
    }

    // One block, not two stacked rows. The name used to sit on its own line above a
    // second row holding the thumbnail, so a file was visually separated from its own
    // preview and every row was twice as tall as it needed to be.
    // Two verbs, not three. Download went on the row a commit ago because the popover
    // that held it opens on hover and is therefore unreachable on a touchscreen — but
    // downloading a gcode off the printer only means anything on a machine with a mouse
    // and a filesystem to put it on, which is exactly the machine that can hover. Print
    // and Delete are the two that a phone needs, so they are the two the row carries.
    const actions = isFolder
      ? ''
      : `<button data-requires-idle class="file-print-btn ${ROW_BTN}" title="Print ${escapeAttr(file.filename)}" aria-label="Print ${escapeAttr(file.filename)}">${iconSolo('play')}</button>
         <button class="file-delete-btn ${ROW_BTN_BAD}" title="Delete ${escapeAttr(file.filename)}" aria-label="Delete ${escapeAttr(file.filename)}">${iconSolo('trash')}</button>`;

    html += `
      <div class="file-item flex items-center gap-2.5 p-2 rounded-chip bg-surface transition-colors hover:bg-hover min-w-0 ${isFolder ? 'file-item-folder cursor-pointer' : ''}" data-filename="${escapeAttr(file.filename)}" data-type="${isFolder ? 'folder' : 'file'}">
        <div class="file-icon flex h-10 w-10 shrink-0 items-center justify-center text-[20px]">${iconHtml}</div>
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center">
            <span class="truncate text-[13px] font-medium" title="${escapeAttr(file.filename)}">${escapeHtml(file.filename)}</span>${cacheMarker}
          </div>
          <div class="truncate text-[11px] text-fg-muted">${meta}</div>
        </div>
        <div class="file-actions flex shrink-0 items-center gap-1">${actions}</div>
      </div>`;
  }

  container.innerHTML = html;
  bindFileActions(state, client);
  ensureFileActions(container);
  // Fresh markup comes back enabled; re-apply what the dashboard last knew.
  reapplyBusyGuard();

  // Lend the popover this render's state, sender and listing.
  bindPopover(
    state,
    new Map(sorted.filter((f) => f.type !== 'folder').map((f) => [f.filename, f])),
  );

  // Close any stale popover from previous render
  closeFilePopover();

  // Lend the thumbnail module this render's state and a way to ask for another one.
  bindThumbnails(state, () => renderFiles(state, client));
  // Fetch cached status and inline thumbnails asynchronously
  void fetchCachedStatus(sorted);
  fetchInlineThumbnails(sorted, client);
}

let fileControlsBound = false;

export function bindFileControls(client: CommandSender): void {
  if (fileControlsBound) return;
  fileControlsBound = true;

  document.querySelectorAll('.file-source-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const source = (tab as HTMLElement).dataset.source as 'local' | 'u-disk';
      setFileSource(source);
      resetThumbnailQueue();
      document.querySelectorAll('.file-source-tab').forEach((t) => toggleState(t, 'active', false));
      toggleState(tab, 'active', true);
      // The fill does not follow a class change on its own — it is positioned from the
      // selected button's offsetLeft/offsetWidth, so every picker moves it by hand.
      const track = tab.closest('.segmented') as HTMLElement | null;
      if (track) positionSegmented(track);
      $('file-list').innerHTML =
        `<div class="${EMPTY}"><i class="bi bi-arrow-repeat" aria-hidden="true"></i>Loading…</div>`;
      client.sendCommand(1044, { storage_media: source, dir: '/', offset: 0, limit: 200 });
      client.sendCommand(1048, { storage_media: source });
    });
  });

  // Upload handler
  const uploadInput = document.getElementById('file-upload-input') as HTMLInputElement | null;
  if (uploadInput) {
    uploadInput.addEventListener('change', () => {
      const file = uploadInput.files?.[0];
      if (!file) return;
      uploadInput.value = ''; // reset so same file can be re-selected
      uploadFile(file, client);
    });
  }
}
