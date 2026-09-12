/** Event Log panel — shows important printer events (start, error, milestones, layer changes) */

import { icon } from './icons';
import { EMPTY } from './design';
import { $, escapeHtml } from './helpers';
import { timestampSpan } from './relative-time';

interface EventLogEntry {
  ts: number;
  event: Record<string, unknown>;
}

const MAX_ENTRIES = 100;
const entries: EventLogEntry[] = [];

/** Format timestamp as HH:MM:SS */
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/** Format duration in seconds as human-readable */
function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

/** Get icon and CSS class for event type */
function eventMeta(type: string): { icon: string; cls: string } {
  switch (type) {
    case 'connected':
      return { icon: icon('link'), cls: 'event-success' };
    case 'disconnected':
      return { icon: icon('unplug'), cls: 'event-warning' };
    case 'print_started':
      return { icon: icon('play'), cls: 'event-info' };
    case 'print_completed':
      return { icon: icon('ok'), cls: 'event-success' };
    case 'print_failed':
      return { icon: icon('error'), cls: 'event-error' };
    case 'print_progress':
      return { icon: icon('reports'), cls: 'event-muted' };
    case 'error':
      return { icon: icon('critical'), cls: 'event-error' };
    case 'filament_runout':
      return { icon: icon('filament'), cls: 'event-error' };
    case 'layer_change':
      return { icon: icon('ruler'), cls: 'event-muted' };
    case 'first_layer_complete':
      return { icon: icon('firstLayer'), cls: 'event-success' };
    case 'status_change':
      return { icon: icon('refresh'), cls: 'event-info' };
    case 'sub_status_change':
      return { icon: icon('zone'), cls: 'event-muted' };
    default:
      return { icon: icon('mqttLog'), cls: 'event-muted' };
  }
}

/** Build human-readable description for an event */
function eventDescription(e: Record<string, unknown>): string {
  const type = e.type as string;
  switch (type) {
    case 'connected':
      return `Connected to printer ${escapeHtml(String(e.sn || ''))}`;
    case 'disconnected':
      return 'Printer disconnected';
    case 'print_started': {
      const fn = escapeHtml(String(e.filename || 'unknown'));
      return e.resumed ? `Resumed print: ${fn}` : `Print started: ${fn}`;
    }
    case 'print_completed': {
      const fn = escapeHtml(String(e.filename || 'unknown'));
      const dur = typeof e.duration === 'number' ? ` (${fmtDuration(e.duration)})` : '';
      return `Print completed: ${fn}${dur}`;
    }
    case 'print_failed': {
      const fn = escapeHtml(String(e.filename || 'unknown'));
      const reason = escapeHtml(String(e.reason || 'unknown'));
      return `Print failed: ${fn} — ${reason}`;
    }
    case 'print_progress': {
      const pct = e.progress as number;
      const layer = e.layer as number;
      const total = e.totalLayers as number;
      const rem =
        typeof e.remaining === 'number' ? ` (${fmtDuration(e.remaining as number)} remaining)` : '';
      return `Progress: ${pct}% — Layer ${layer}/${total}${rem}`;
    }
    case 'error': {
      const names = (e.names as string[]) || [];
      return `Error: ${names.map((n) => escapeHtml(n)).join(', ') || 'Unknown'}`;
    }
    case 'filament_runout':
      return 'Filament runout detected';
    case 'layer_change': {
      const layer = e.layer as number;
      const total = e.totalLayers as number;
      const dur =
        typeof e.durationSec === 'number'
          ? ` (layer took ${fmtDuration(e.durationSec as number)})`
          : '';
      return `Layer ${layer}${total ? '/' + total : ''}${dur}`;
    }
    case 'first_layer_complete': {
      const fn = escapeHtml(String(e.filename || 'unknown'));
      const dur =
        typeof e.durationSec === 'number' ? ` (${fmtDuration(e.durationSec as number)})` : '';
      return `First layer complete: ${fn}${dur}`;
    }
    case 'status_change':
      return `Status: ${escapeHtml(String(e.from))} ${icon('changeTo')} ${escapeHtml(String(e.to))}`;
    case 'sub_status_change':
      return `Sub-status: ${escapeHtml(String(e.from || 'Default'))} ${icon('changeTo')} ${escapeHtml(String(e.to || 'Default'))}`;
    default:
      return `Event: ${escapeHtml(type)}`;
  }
}

/** Add a single event log entry */
export function handleEventLog(data: { ts: number; event: Record<string, unknown> }): void {
  entries.push(data);
  if (entries.length > MAX_ENTRIES) entries.shift();
  renderEventLog();
}

/** Load event log history from init snapshot */
export function loadEventLogHistory(
  history: Array<{ ts: number; event: Record<string, unknown> }>,
): void {
  entries.length = 0;
  for (const e of history) {
    entries.push(e);
  }
  // Trim to max
  while (entries.length > MAX_ENTRIES) entries.shift();
  renderEventLog();
}

/** Render the event log panel */
export function renderEventLog(): void {
  const container = $('event-log-entries');
  if (!container) return;

  if (entries.length === 0) {
    container.innerHTML = `<div class="${EMPTY}"><i class="bi bi-list-ul" aria-hidden="true"></i>No events yet</div>`;
    return;
  }

  // Most recent first
  const html = entries
    .slice()
    .reverse()
    .map((entry) => {
      const type = (entry.event.type as string) || 'unknown';
      const meta = eventMeta(type);
      const desc = eventDescription(entry.event);
      return `<div class="flex items-center gap-2 [padding:4px_8px] text-[0.8rem] rounded-chip bg-input hover:bg-[var(--bg-hover,_rgba(255,_255,_255,_0.06))] ${meta.cls}">
      <span class="shrink-0 text-[0.9rem]">${meta.icon}</span>
      ${timestampSpan('event-log-time', entry.ts, fmtTime(entry.ts))}
      <span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [.event-success_&]:text-[#4caf50] [.event-warning_&]:text-[#ff9800] [.event-error_&]:text-[#f44336] [.event-info_&]:text-[#58a6ff] [.event-muted_&]:text-fg-muted" title="${desc}">${desc}</span>
    </div>`;
    })
    .join('');

  container.innerHTML = html;
}
