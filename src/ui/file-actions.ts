/**
 * What a click on the file list means.
 *
 * Split out of `files.ts` with the popover, the thumbnails and the upload, which between
 * them had it at 781 lines doing five jobs. This is the fifth: one delegated listener
 * per container, because `#file-list` is replaced wholesale on every render and a
 * listener bound to a row would die with it.
 *
 * It does not import the renderer. `bindFileActions` is handed each render's state and
 * sender, the same inversion `file-thumbnails.ts` and `file-popover.ts` use, so nothing
 * here can close a loop back into the list.
 */

import { currentFileDir, currentFileSource, filePathFor, setFileDir } from './file-browsing';
import {
  closeFilePopover,
  popoverFile,
  schedulePopover,
  schedulePopoverClose,
} from './file-popover';
import { resetThumbnailQueue } from './file-thumbnails';
import { EMPTY } from './design';
import { requestPrintDialog } from './print-dialog';
import type { PrinterState } from '../printer-state';
import type { CommandSender } from '../ws-client';

/**
 * Delete a file from the printer, behind a confirmation.
 *
 * **Native `confirm`, deliberately.** A filename comes off the printer's own filesystem
 * and is shown back here; a native dialog renders plain text, so a name crafted to look
 * like markup is inert in it by construction. It is also what the emergency stop already
 * uses, for the same reason. The trade is that it cannot be styled, and a destructive,
 * irreversible action is the place to accept that.
 *
 * Returns whether the delete was actually sent, so a caller can leave its own UI alone
 * when the user backs out.
 */
export function confirmDeleteFile(
  filename: string,
  fullPath: string,
  source: string,
  dir: string,
  client: CommandSender | null,
): boolean {
  if (!confirm(`Delete ${filename}?\n\nThis permanently removes it from the printer.`)) {
    return false;
  }
  client?.sendCommand(1047, { storage_media: source, file_path: [fullPath] });
  // 1047 answers, but pushes no new listing, so ask for one, and for the disk figures
  // the capacity bar reads, or the row stays on screen and the bar stays wrong.
  setTimeout(() => {
    client?.sendCommand(1044, { storage_media: source, dir, offset: 0, limit: 200 });
    client?.sendCommand(1048, { storage_media: source });
  }, 500);
  return true;
}

let boundState: PrinterState | null = null;
let boundClient: CommandSender | null = null;

/** Lend this render's state and sender to the handlers. */
export function bindFileActions(state: PrinterState, client: CommandSender): void {
  boundState = state;
  boundClient = client;
}

let fileDelegationBound = false;

/** Bind delegated event listeners on the file list container (once) */
export function ensureFileActions(container: HTMLElement): void {
  if (fileDelegationBound) return;
  fileDelegationBound = true;

  // Delegated mouseenter/mouseleave for file popovers (use capture for mouseenter)
  container.addEventListener(
    'mouseenter',
    (e) => {
      const target = e.target as HTMLElement;
      const item = target.closest('.file-item[data-type="file"]') as HTMLElement | null;
      if (!item) return;
      if (target.closest('.file-actions')) return;
      const fn = item.dataset.filename;
      if (!fn) return;
      const file = popoverFile(fn);
      if (!file) return;
      schedulePopover(file, item);
    },
    true,
  );

  container.addEventListener(
    'mouseleave',
    (e) => {
      const target = e.target as HTMLElement;
      const item = target.closest('.file-item[data-type="file"]') as HTMLElement | null;
      if (!item) return;
      schedulePopoverClose();
    },
    true,
  );

  // Delegated click for folders, breadcrumbs, and print buttons
  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Print button
    const printBtn = target.closest('.file-print-btn') as HTMLElement | null;
    if (printBtn) {
      e.stopPropagation();
      const item = printBtn.closest('.file-item') as HTMLElement;
      const filename = item?.dataset.filename;
      if (filename && boundState && boundClient) {
        const fullPath =
          currentFileDir() === '/'
            ? filename
            : currentFileDir().replace(/^\//, '') + '/' + filename;
        requestPrintDialog(filename, fullPath, boundClient, boundState);
      }
      return;
    }

    // Delete button. The popover had the only delete, and the popover opens on hover,
    // so on a touchscreen there was no way to reach it at all.
    const deleteBtn = target.closest('.file-delete-btn') as HTMLElement | null;
    if (deleteBtn) {
      e.stopPropagation();
      const filename = (deleteBtn.closest('.file-item') as HTMLElement)?.dataset.filename;
      if (!filename) return;
      closeFilePopover();
      confirmDeleteFile(
        filename,
        filePathFor(filename, currentFileDir()),
        currentFileSource(),
        currentFileDir(),
        boundClient,
      );
      return;
    }

    // Folder click
    const folder = target.closest('.file-item-folder') as HTMLElement | null;
    if (folder) {
      const dirname = folder.dataset.filename;
      if (!dirname || !boundClient) return;
      setFileDir(currentFileDir() === '/' ? `/${dirname}` : `${currentFileDir()}/${dirname}`);
      resetThumbnailQueue();
      container.innerHTML = `<div class="${EMPTY}"><i class="bi bi-arrow-repeat" aria-hidden="true"></i>Loading…</div>`;
      boundClient.sendCommand(1044, {
        storage_media: currentFileSource(),
        dir: currentFileDir(),
        offset: 0,
        limit: 200,
      });
      return;
    }

    // Breadcrumb nav
    const navBtn = target.closest('.file-nav-btn') as HTMLElement | null;
    if (navBtn) {
      const dir = navBtn.dataset.dir;
      if (dir == null || !boundClient) return;
      setFileDir(dir);
      resetThumbnailQueue();
      container.innerHTML = `<div class="${EMPTY}"><i class="bi bi-arrow-repeat" aria-hidden="true"></i>Loading…</div>`;
      boundClient.sendCommand(1044, {
        storage_media: currentFileSource(),
        dir: currentFileDir(),
        offset: 0,
        limit: 200,
      });
    }
  });
}
