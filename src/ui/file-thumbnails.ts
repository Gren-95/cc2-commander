/**
 * Thumbnails and cache markers for the file list.
 *
 * A serialized queue, deliberately. `1045` is one request per file and the printer
 * answers them on the same MQTT connection everything else shares, so firing one per
 * visible row turns a directory listing into a burst the status stream has to queue
 * behind. One in flight at a time, next on completion.
 *
 * Split out of `files.ts` with the upload and the popover, which between them had it at
 * 781 lines doing four unrelated jobs. The list rendering asks this module two
 * questions (is this file cached, and do we have its thumbnail) through accessors,
 * rather than reaching into two Maps it does not own.
 */

import { currentFileDir, currentFileSource } from './file-browsing';
import { THUMBNAIL_CLASS, applyDarkThumbnailCheck } from './helpers';
import type { CommandSender } from '../ws-client';
import type { PrinterState } from '../printer-state';

/**
 * What the list renderer lends this module each render.
 *
 * The extracted code called `renderFiles(_lastState, client)` directly, which would put
 * an import back into `files.ts` and close exactly the cycle this split exists to
 * remove. So the renderer registers instead: the same inversion `theme.ts` uses to
 * avoid importing the gcode preview.
 */
let boundState: PrinterState | null = null;
let requestRerender: () => void = () => {};

export function bindThumbnails(state: PrinterState, onChanged: () => void): void {
  boundState = state;
  requestRerender = onChanged;
}

/** Set of full file paths that are cached on the server */
let cachedFiles = new Set<string>();
/** Map of full file path → base64 thumbnail */
const thumbnailCache = new Map<string, string>();
/** Queue of file paths waiting for thumbnail fetch */
let thumbnailQueue: string[] = [];
/** Currently fetching thumbnail for this file */
let thumbnailFetching: string | null = null;

/** Fetch which files are cached on the server and update markers */
let _fetchingCached = false;
export async function fetchCachedStatus(
  files: { filename: string; type?: string }[],
): Promise<void> {
  if (_fetchingCached) return;
  const gcodeFiles = files
    .filter((f) => f.type !== 'folder' && f.filename.toLowerCase().endsWith('.gcode'))
    .map((f) =>
      currentFileDir() === '/'
        ? f.filename
        : currentFileDir().replace(/^\//, '') + '/' + f.filename,
    );
  if (!gcodeFiles.length) {
    cachedFiles = new Set();
    return;
  }
  _fetchingCached = true;
  try {
    const params = gcodeFiles.map((f) => `file=${encodeURIComponent(f)}`).join('&');
    const resp = await fetch(`/api/files/cached?${params}`);
    if (resp.ok) {
      const data = (await resp.json()) as { cached: string[] };
      const newCached = new Set(data.cached);
      const changed =
        newCached.size !== cachedFiles.size || [...newCached].some((f) => !cachedFiles.has(f));
      cachedFiles = newCached;
      if (changed && cachedFiles.size > 0) {
        // Re-render so the cache markers appear.
        requestRerender();
      }
    }
  } catch {
    /* ignore */
  }
  _fetchingCached = false;
}

/** Fetch inline thumbnails for visible gcode files (serialized via queue) */
let _thumbClient: CommandSender | null = null;
export function fetchInlineThumbnails(
  files: { filename: string; type?: string }[],
  client: CommandSender,
): void {
  _thumbClient = client;
  for (const file of files) {
    if (file.type === 'folder') continue;
    if (!file.filename.toLowerCase().endsWith('.gcode')) continue;
    const fullPath =
      currentFileDir() === '/'
        ? file.filename
        : currentFileDir().replace(/^\//, '') + '/' + file.filename;
    if (
      thumbnailCache.has(fullPath) ||
      thumbnailQueue.includes(fullPath) ||
      thumbnailFetching === fullPath
    )
      continue;
    thumbnailQueue.push(fullPath);
  }
  fetchNextThumbnail();
}

function fetchNextThumbnail(): void {
  if (thumbnailFetching || !_thumbClient) return;
  const next = thumbnailQueue.shift();
  if (!next) return;
  thumbnailFetching = next;
  // Method 1045 uses file_name (with underscore!)
  boundState?.thumbnailRequestQueue.push('inline');
  _thumbClient.sendCommand(1045, { storage_media: currentFileSource(), file_name: next });
}

/** Called when a thumbnail response arrives: update inline preview if applicable */
export function handleInlineThumbnail(base64: string | null): void {
  const fullPath = thumbnailFetching;
  thumbnailFetching = null;
  if (fullPath && base64) {
    thumbnailCache.set(fullPath, base64);
    // Find the DOM element and insert thumbnail
    document.querySelectorAll('.file-item[data-type="file"]').forEach((el) => {
      const fn = (el as HTMLElement).dataset.filename;
      if (!fn) return;
      const fp = currentFileDir() === '/' ? fn : currentFileDir().replace(/^\//, '') + '/' + fn;
      if (fp !== fullPath) return;
      const iconEl = el.querySelector('.file-icon');
      // The guard skips a slot that already holds a *real* thumbnail. The placeholder
      // is not one, and must be replaced when the genuine preview arrives: treating it
      // as "already done" would leave every gcode file showing the placeholder forever
      // (ELEG-42).
      const existing = iconEl?.querySelector('img');
      if (iconEl && (!existing || existing.classList.contains('thumb-img-fallback'))) {
        const img = document.createElement('img');
        img.src = `data:image/png;base64,${base64}`;
        img.alt = 'Thumbnail';
        img.className = `file-inline-thumb ${THUMBNAIL_CLASS}`;
        applyDarkThumbnailCheck(img, iconEl as HTMLElement);
        iconEl.textContent = '';
        iconEl.appendChild(img);
      }
    });
  }
  // Fetch next in queue
  fetchNextThumbnail();
}

/** Has the server got this file cached? Drives the bolt marker on a row. */
export function isFileCached(fullPath: string): boolean {
  return cachedFiles.has(fullPath);
}

/** The thumbnail already fetched for this file, if there is one. */
export function cachedThumbnail(fullPath: string): string | undefined {
  return thumbnailCache.get(fullPath);
}

/** Dropped when the source or folder changes: the queued paths no longer exist. */
export function resetThumbnailQueue(): void {
  thumbnailQueue = [];
  thumbnailFetching = null;
}
