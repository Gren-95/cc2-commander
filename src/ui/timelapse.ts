/** Timelapse viewer — list and play timelapse videos from print history.
 *
 * The CC2 stores timelapse data per print history entry:
 *   time_lapse_video_status: 0=NotCaptured, 1=NotExported, 2=Exported, 3=Failed
 *   time_lapse_video_url: filename/URL for the video
 *
 * Method 1051 (GetTimeLapseVideoList) is actually used to *export* a specific
 * timelapse video — it takes { url: filename } and triggers video generation.
 * The video list itself comes from print history (method 1036).
 */

import { icon, iconSolo, iconText } from './icons';
import type { CommandSender } from '../ws-client';
import type { PrinterState } from '../printer-state';
import { $, escapeHtml, escapeAttr, formatBytes } from './helpers';
import { type ListControls, createListControls } from './list-controls';
import { nonZero } from './list-sort';

let playerClient: CommandSender | null = null;

export function setTimelapseClient(client: CommandSender): void {
  playerClient = client;
}

/** The list is `Record<string, unknown>[]`, so each field is read through an accessor. */
type TimelapseEntry = Record<string, unknown>;

const entryName = (v: TimelapseEntry): string => String(v.filename || 'Unknown');
const entryStatus = (v: TimelapseEntry): number => (v.timelapse_status as number) ?? 0;
const entrySize = (v: TimelapseEntry): number | undefined =>
  nonZero(v.timelapse_size as number | undefined);
const entryDuration = (v: TimelapseEntry): number | undefined =>
  nonZero(v.timelapse_duration as number | undefined);
const entryBegin = (v: TimelapseEntry): number | undefined =>
  nonZero(v.begin_time as number | undefined);

/** Status codes, from the file header: 0=NotCaptured, 1=NotExported, 2=Exported, 3=Failed */
const STATUS_EXPORTED = 2;
const STATUS_FAILED = 3;

/** Kept outside the render function — see `list-controls.ts` on why that matters. */
let timelapseControls: ListControls<TimelapseEntry> | null = null;
let lastTimelapseState: PrinterState | null = null;

function ensureTimelapseControls(): ListControls<TimelapseEntry> {
  if (timelapseControls) return timelapseControls;
  timelapseControls = createListControls<TimelapseEntry>({
    id: 'timelapse',
    container: $('timelapse-controls'),
    noun: 'videos',
    filterPlaceholder: 'Filter timelapses…',
    filterText: entryName,
    columns: [
      { key: 'name', label: 'Name', value: entryName },
      { key: 'time', label: 'Recorded', value: entryBegin, initialDirection: 'desc' },
      { key: 'duration', label: 'Length', value: entryDuration, initialDirection: 'desc' },
      { key: 'size', label: 'Size', value: entrySize, initialDirection: 'desc' },
    ],
    defaultSort: { key: 'time', dir: 'desc' },
    selects: [
      {
        // The timelapse analogue of Print History's failures filter, which this issue
        // asked to fold in if it was cheap. It was — the helper already does dropdowns.
        id: 'state',
        label: 'State',
        options: [
          { value: 'ready', label: 'ready to play' },
          { value: 'pending', label: 'needs export' },
          { value: 'failed', label: 'generation failed' },
        ],
        match: (v, value) => {
          const status = entryStatus(v);
          if (value === 'ready') return status === STATUS_EXPORTED && !!v.timelapse_url;
          if (value === 'failed') return status === STATUS_FAILED;
          return status !== STATUS_EXPORTED && status !== STATUS_FAILED;
        },
      },
    ],
    onChange: () => {
      if (lastTimelapseState) renderTimelapse(lastTimelapseState);
    },
  });
  return timelapseControls;
}

export function renderTimelapse(state: PrinterState): void {
  const container = $('timelapse-list');
  if (!container) return;
  lastTimelapseState = state;

  const controls = ensureTimelapseControls();
  const videos = controls.apply(state.timelapseList ?? []);

  if (!videos.length) {
    // "No timelapses at all" and "none match your filter" are different facts.
    container.innerHTML = controls.emptyHtml(
      'No timelapse videos found. Click Refresh to load print history.',
    );
    return;
  }

  let html = '';
  for (const video of videos) {
    const name = entryName(video);
    const status = entryStatus(video);
    const videoUrl = (video.timelapse_url as string) || '';
    const time = entryBegin(video) ? new Date(entryBegin(video)! * 1000).toLocaleString() : '';
    const videoDuration = entryDuration(video);
    const durStr = videoDuration ? `${videoDuration}s` : '';
    const size = entrySize(video);
    const sizeStr = size ? formatBytes(size) : '';
    const meta = [time, durStr, sizeStr].filter(Boolean).join(' · ');

    // Status 2 = already exported (has URL), status 1 = captured but needs export
    const isExported = status === STATUS_EXPORTED && videoUrl;
    const actionBtn = isExported
      ? `<button class="timelapse-play-btn inline-flex items-center justify-center [padding:4px_10px] border-0 rounded-chip text-[11px] font-medium cursor-pointer [transition:all_0.15s] text-white bg-accent max-[800px]:[padding:6px_12px] max-[800px]:text-[13px] pointer-coarse:min-h-11 hover:[filter:brightness(1.15)] active:[transform:scale(0.97)] [.spool-actions_&]:text-[9px] [.spool-actions_&]:[padding:2px_8px] [.spool-actions_&]:rounded-[10px] [.file-popover-actions_&]:text-[12px] [.file-popover-actions_&]:[padding:4px_10px] max-[800px]:[.file-actions_&]:min-h-9 max-[800px]:[.file-actions_&]:min-w-9 max-[800px]:[.file-actions_&]:[padding:6px_8px] [.settings-card-move_&]:[padding:1px_6px] [.settings-card-move_&]:text-[10px] [.settings-card-move_&]:leading-[1] [.ai-label-config-delete_&]:text-bad [.ai-label-config-delete_&]:[padding:4px_8px] [.ai-label-config-delete_&]:text-[14px] [.ai-label-config-delete_&]:leading-[1] [.print-dialog-footer_&]:min-w-25 hover:[.ai-label-config-delete_&]:bg-[rgba(239,_83,_80,_0.15)]" data-url="${escapeAttr(videoUrl)}">${icon('play')} Play</button>`
      : `<button class="timelapse-export-btn inline-flex items-center justify-center [padding:4px_10px] border border-line rounded-chip text-[11px] font-medium cursor-pointer [transition:all_0.15s] text-fg-soft bg-transparent max-[800px]:[padding:6px_12px] max-[800px]:text-[13px] pointer-coarse:min-h-11 hover:[filter:brightness(1.15)] active:[transform:scale(0.97)] [.spool-actions_&]:text-[9px] [.spool-actions_&]:[padding:2px_8px] [.spool-actions_&]:rounded-[10px] [.file-popover-actions_&]:text-[12px] [.file-popover-actions_&]:[padding:4px_10px] max-[800px]:[.file-actions_&]:min-h-9 max-[800px]:[.file-actions_&]:min-w-9 max-[800px]:[.file-actions_&]:[padding:6px_8px] [.settings-card-move_&]:[padding:1px_6px] [.settings-card-move_&]:text-[10px] [.settings-card-move_&]:leading-[1] [.ai-label-config-delete_&]:text-bad [.ai-label-config-delete_&]:[padding:4px_8px] [.ai-label-config-delete_&]:text-[14px] [.ai-label-config-delete_&]:leading-[1] hover:[.ai-label-config-delete_&]:bg-[rgba(239,_83,_80,_0.15)]" data-url="${escapeAttr(videoUrl || name)}">${icon('exportFile')} Export</button>`;

    html += `
      <div class="file-item flex flex-col gap-1 p-2 bg-surface rounded-chip [transition:background_0.15s] max-[800px]:[padding:10px] max-[800px]:[gap:10px] hover:bg-hover [&[data-type="file"]]:cursor-default" data-filename="${escapeAttr(name)}">
        <div class="file-icon text-[20px] w-10 h-10 flex items-center justify-center shrink-0">${iconSolo('timelapse')}</div>
        <div class="flex-1 min-w-0">
          <div class="text-[13px] font-medium overflow-hidden text-ellipsis whitespace-nowrap min-w-0" title="${escapeAttr(name)}">${escapeHtml(name)}</div>
          <div class="text-[11px] text-fg-muted">${meta}${isExported ? ` · ${icon('ok')} Ready` : ` · ${icon('pending')} Needs export`}</div>
        </div>
        ${actionBtn}
      </div>`;
  }

  container.innerHTML = html;

  // Bind play buttons (for already-exported videos)
  container.querySelectorAll('.timelapse-play-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const url = (e.currentTarget as HTMLElement).dataset.url;
      if (url) showTimelapsePlayer(url);
    });
  });

  // Bind export buttons (triggers method 1051 to generate the video)
  container.querySelectorAll('.timelapse-export-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const url = (e.currentTarget as HTMLElement).dataset.url;
      if (url && playerClient) {
        playerClient.sendCommand(1051, { url });
        (e.currentTarget as HTMLButtonElement).disabled = true;
        iconText(e.currentTarget as HTMLButtonElement, 'pending', 'Exporting…');
      }
    });
  });
}

function _formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

export function showTimelapsePlayer(url: string): void {
  const player = $('timelapse-player') as HTMLVideoElement;
  const container = $('timelapse-player-wrap');
  if (!player || !container) return;

  player.src = url;
  container.classList.remove('hidden');
  player.play().catch(() => {});
}

/** Fetch print history which populates timelapse list */
export function requestTimelapseList(): void {
  if (playerClient) {
    // Request print history — timelapse entries are extracted from history
    playerClient.sendCommand(1036, { page: 1, page_size: 100 });
  }
}
