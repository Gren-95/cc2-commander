/**
 * Uploading a gcode to the printer.
 *
 * Split out of `files.ts`, which had grown to 781 lines carrying four unrelated jobs.
 * This one talks to `POST /api/files/upload` over XHR — not `fetch` — for the single
 * reason that XHR reports upload progress and `fetch` still cannot, and a 500MB file
 * over a printer's wifi needs a progress bar.
 *
 * Validation is repeated here rather than trusted from the `accept` attribute: an
 * `<input accept>` is a file-picker filter, not a check, and a drag-and-drop or a
 * changed attribute walks straight past it. The server validates too; this exists so a
 * rejection is instant and legible instead of a failed request.
 */

import { currentFileDir, currentFileSource } from './file-browsing';
import { formatBytes } from './helpers';
import { iconText } from './icons';
import { toggleState } from './state-classes';
import type { CommandSender } from '../ws-client';

const ALLOWED_EXTENSIONS = ['.gcode', '.3mf'];
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500 MB

export async function uploadFile(file: File, client: CommandSender): Promise<void> {
  const progressEl = document.getElementById('upload-progress');
  const fillEl = document.getElementById('upload-progress-fill');
  const textEl = document.getElementById('upload-progress-text');
  const labelEl = document.getElementById('file-upload-label');
  if (!progressEl || !fillEl || !textEl) return;

  // Client-side validation
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    progressEl.classList.remove('hidden');
    progressEl.classList.add('upload-error');
    fillEl.style.width = '0%';
    iconText(textEl, 'cross', `Invalid file type "${ext}" — only .gcode and .3mf allowed`);
    return;
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    progressEl.classList.remove('hidden');
    progressEl.classList.add('upload-error');
    fillEl.style.width = '0%';
    iconText(
      textEl,
      'cross',
      `File too large (${(file.size / 1024 / 1024).toFixed(0)} MB) — max 500 MB`,
    );
    return;
  }

  progressEl.classList.remove('hidden');
  fillEl.style.width = '0%';
  textEl.textContent = `Uploading ${file.name}...`;
  if (labelEl) toggleState(labelEl, 'disabled', true);

  const formData = new FormData();
  formData.append('file', file);

  const source = currentFileSource() === 'u-disk' ? 'u-disk' : 'local';

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/files/upload?source=${encodeURIComponent(source)}`);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        fillEl.style.width = pct + '%';
        textEl.textContent = `Uploading ${file.name}... ${pct}% (${formatBytes(e.loaded)} / ${formatBytes(e.total)})`;
      }
    });

    await new Promise<void>((resolve, reject) => {
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          let msg = `Upload failed (HTTP ${xhr.status})`;
          try {
            msg = JSON.parse(xhr.responseText).error || msg;
          } catch {
            /* ignore */
          }
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(formData);
    });

    fillEl.style.width = '100%';
    iconText(textEl, 'check', `${file.name} uploaded`);
    // Refresh file list
    client.sendCommand(1044, {
      storage_media: currentFileSource(),
      dir: currentFileDir(),
      offset: 0,
      limit: 200,
    });
    client.sendCommand(1048, { storage_media: currentFileSource() });
  } catch (err) {
    iconText(textEl, 'cross', (err as Error).message);
    fillEl.style.width = '0%';
    progressEl.classList.add('upload-error');
  } finally {
    if (labelEl) toggleState(labelEl, 'disabled', false);
    // Auto-hide progress after 4 seconds on success
    setTimeout(() => {
      if (!progressEl.classList.contains('upload-error')) {
        progressEl.classList.add('hidden');
      }
    }, 4000);
  }
}
