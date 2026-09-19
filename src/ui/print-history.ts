import { icon, iconSolo } from './icons';
import type { CommandSender } from '../ws-client';
import type { PrinterState } from '../printer-state';
import { $, $optional, escapeHtml, escapeAttr, formatTime } from './helpers';
import { toast } from './toast';
import { type ListControls, createListControls } from './list-controls';
import { nonZero, spanSeconds } from './list-sort';

let historyClient: CommandSender | null = null;

export function setHistoryClient(client: CommandSender): void {
  historyClient = client;
}

export function requestHistory(): void {
  if (!historyClient) return;
  // Method 1036 takes NO params per CC2 protocol, page/page_size not supported
  historyClient.sendCommand(1036, {});
}

type HistoryItem = PrinterState['printHistory'][number];

/** Kept outside the render function: see `list-controls.ts` on why that matters. */
let historyControls: ListControls<HistoryItem> | null = null;
let lastHistoryState: PrinterState | null = null;

function ensureHistoryControls(): ListControls<HistoryItem> {
  if (historyControls) return historyControls;
  historyControls = createListControls<HistoryItem>({
    id: 'print-history',
    container: $('print-history-controls'),
    noun: 'prints',
    filterPlaceholder: 'Filter by job name…',
    filterText: (item) => item.filename,
    columns: [
      { key: 'name', label: 'Name', value: (i) => i.filename },
      // nonZero/spanSeconds, not the raw fields: the printer sends 0 for a time it did
      // not record, and 0 sorts as 1970 (top of "newest first") rather than as absent.
      {
        key: 'started',
        label: 'Started',
        value: (i) => nonZero(i.begin_time),
        initialDirection: 'desc',
      },
      {
        key: 'duration',
        label: 'Duration',
        value: (i) => spanSeconds(i.begin_time, i.end_time),
        initialDirection: 'desc',
      },
      { key: 'status', label: 'Status', value: (i) => i.status },
    ],
    // Newest first: the last thing you printed is the thing you are asking about.
    defaultSort: { key: 'started', dir: 'desc' },
    selects: [
      {
        id: 'status',
        label: 'Status',
        options: [
          { value: 'completed', label: 'completed' },
          { value: 'failed', label: 'failed' },
          { value: 'stopped', label: 'stopped' },
        ],
        match: (item, value) => item.status === value,
      },
    ],
    onChange: () => {
      if (lastHistoryState) renderPrintHistory(lastHistoryState);
    },
  });
  return historyControls;
}

export function renderPrintHistory(state: PrinterState): void {
  const container = $optional('print-history-entries');
  if (!container) return;
  lastHistoryState = state;

  const controls = ensureHistoryControls();
  // Client-side over the whole set: 1036 takes no paging parameters, so there is no
  // server-side ordering to ask for even if there were enough entries to want one.
  const items = controls.apply(state.printHistory ?? []);

  if (items.length === 0) {
    // Two different facts: "narrow your filter" and "you have never printed".
    container.innerHTML = controls.emptyHtml('No print history');
    updateHistoryTotal(state);
    return;
  }

  const html = items
    .map((item) => {
      const statusClass =
        item.status === 'completed'
          ? 'success'
          : item.status === 'failed'
            ? 'danger'
            : item.status === 'stopped'
              ? 'warning'
              : '';
      const statusIcon =
        item.status === 'completed'
          ? icon('ok')
          : item.status === 'failed'
            ? icon('error')
            : item.status === 'stopped'
              ? icon('stop')
              : icon('unknown');

      const begin = item.begin_time ? new Date(item.begin_time * 1000).toLocaleString() : '--';
      const _end = item.end_time ? new Date(item.end_time * 1000).toLocaleString() : '--';
      const duration =
        item.begin_time && item.end_time ? formatTime(item.end_time - item.begin_time) : '--';

      // A record with no task_id cannot be addressed by 1038, so it gets no button
      // rather than one that silently does nothing.
      const deleteBtn = item.uuid
        ? `<button class="history-delete-btn inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-fg cursor-pointer transition-colors hover:bg-hover hover:border-fg-muted disabled:opacity-50 disabled:cursor-not-allowed" data-task-id="${escapeAttr(item.uuid)}" data-filename="${escapeAttr(item.filename)}" title="Delete this entry from the printer" aria-label="Delete this entry from the printer">${iconSolo('trash')}</button>`
        : '';

      return `<div class="[padding:6px_10px] rounded-[6px] bg-[var(--card-bg)] border border-line">
      <div class="flex items-center gap-2">
        <span class="text-[14px] ${statusClass}" title="${escapeHtml(item.status)}">${statusIcon}</span>
        <span class="font-medium overflow-hidden text-ellipsis whitespace-nowrap flex-1" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</span>
        ${deleteBtn}
      </div>
      <div class="flex gap-4 mt-1 [padding-left:26px] text-[0.82em] text-fg-muted">
        <span title="Start time">${icon('clock')} ${escapeHtml(begin)}</span>
        <span title="Duration">${icon('duration')} ${escapeHtml(duration)}</span>
      </div>
    </div>`;
    })
    .join('');

  container.innerHTML = html;
  updateHistoryTotal(state);
}

/** The printer's own total, which is not the same number as the filtered count. */
function updateHistoryTotal(state: PrinterState): void {
  const totalEl = $optional('print-history-total');
  if (totalEl) {
    totalEl.textContent = `${state.printHistoryTotal} prints`;
  }
}

export function bindHistoryControls(): void {
  $('btn-history-refresh').addEventListener('click', () => requestHistory());

  // Delegated, because the list is re-rendered on every 1036 response and per-row
  // listeners would be rebound each time.
  $('print-history-entries').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.history-delete-btn') as HTMLElement | null;
    if (!btn) return;
    const taskId = btn.dataset.taskId;
    if (!taskId || !historyClient) return;

    const name = btn.dataset.filename || 'this entry';
    // The record is destroyed on the printer, not hidden here: same shape as the file
    // delete in files.ts, and equally irreversible.
    if (
      !confirm(
        `Delete the history entry for ${name}?\n\nThis removes it from the printer and cannot be undone.`,
      )
    ) {
      return;
    }

    // Method 1038 (HistoryDelete) takes a list of task ids. NOT 1049: that is
    // UpdateToken, and sending it here would have written the printer's auth token
    // (ELEG-38).
    historyClient.sendCommand(1038, { list: [taskId] });
    toast('Deleting history entry…', 'info');
  });
}
