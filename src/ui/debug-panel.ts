/**
 * Debug Panel: live view of ALL printer state variables with change tracking.
 *
 * Features:
 * - Tree view of entire printer state (attributes, status, canvas, etc.)
 * - Highlights fields that changed in the last few seconds
 * - Change log: records every value change with timestamp + old/new value
 * - Auto-disable timeout for change logging (configurable, default 5 min)
 * - Export change log as JSON file
 * - Search/filter across all fields
 */

import { toggleState } from './state-classes';
import { icon, iconSolo, iconText } from './icons';
import { fetchTimeout } from './helpers';
import { PrinterState } from '../printer-state';
import { STATUS_NAMES, SUB_STATUS_NAMES, EXCEPTION_NAMES, SPEED_MODE_NAMES } from '../types';

// ---- Change log ----

interface ChangeEntry {
  timestamp: number;
  path: string;
  oldValue: unknown;
  newValue: unknown;
}

const MAX_CHANGE_LOG = 5000;
let changeLog: ChangeEntry[] = [];
let changeLoggingEnabled = false;
let changeLogTimer: ReturnType<typeof setTimeout> | null = null;
let changeLogTimeout = 5 * 60 * 1000; // 5 minutes default

// Track previous state snapshot for diff
let prevSnapshot: Record<string, unknown> = {};

// Track recent changes for highlight (path -> timestamp)
const recentChanges = new Map<string, number>();
const HIGHLIGHT_DURATION = 3000; // 3 seconds

// Watched paths: these are always logged even when global logging is off
const WATCHED_PATHS_KEY = 'debug-watched-paths';
const watchedPaths = new Set<string>(loadWatchedPaths());

function loadWatchedPaths(): string[] {
  try {
    const raw = localStorage.getItem(WATCHED_PATHS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore corrupt data */
  }
  return [];
}

function saveWatchedPaths(): void {
  localStorage.setItem(WATCHED_PATHS_KEY, JSON.stringify([...watchedPaths]));
}

let debugBound = false;
let currentFilter = '';
const collapsedPaths = new Set<string>();
let autoScrollLog = true;
let lastRenderedStateHash = '';
let lastRenderedLogCount = 0;

/** Flatten a nested object into dot-path keys */
function flattenObject(obj: unknown, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (obj === null || obj === undefined) {
    result[prefix || '(root)'] = obj;
    return result;
  }
  if (typeof obj !== 'object') {
    result[prefix || '(root)'] = obj;
    return result;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      result[prefix] = '[]';
    } else {
      for (let i = 0; i < obj.length; i++) {
        const sub = flattenObject(obj[i], `${prefix}[${i}]`);
        Object.assign(result, sub);
      }
    }
    return result;
  }
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const sub = flattenObject(rec[key], path);
    Object.assign(result, sub);
  }
  return result;
}

/** Get full state snapshot from PrinterState */
function getStateSnapshot(state: PrinterState): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  if (state.attributes) snap.attributes = state.attributes;
  if (state.status) snap.status = state.status;
  if (state.canvas) snap.canvas = state.canvas;
  if (state.monoFilament) snap.monoFilament = state.monoFilament;
  if (state.storageCapacity) snap.storageCapacity = state.storageCapacity;
  snap.zones = state.zones;
  // Scalars
  snap._thumbnail = state.thumbnail ? '(base64 PNG)' : null;
  snap._fileTotalLayers = state.fileTotalLayers;
  snap._fileFilamentUsed = state.fileFilamentUsed;
  snap._filesCount = state.files.length;
  snap._layerTimesCount = state.layerTimes.length;
  snap._filamentUsageCount = state.filamentUsage.length;
  snap._printHistoryTotal = state.printHistoryTotal;
  return snap;
}

/** Format value for display, adding human-readable labels where possible */
function formatValue(path: string, value: unknown): string {
  const s = JSON.stringify(value);
  // Add human-readable annotations
  if (path === 'status.machine_status.status' && typeof value === 'number') {
    const name = STATUS_NAMES[value];
    return name ? `${value} (${name})` : String(value);
  }
  if (path === 'status.machine_status.sub_status' && typeof value === 'number') {
    const name = SUB_STATUS_NAMES[value];
    return name ? `${value} (${name})` : String(value);
  }
  if (path === 'status.gcode_move.speed_mode' && typeof value === 'number') {
    const name = SPEED_MODE_NAMES[value];
    return name ? `${value} (${name})` : String(value);
  }
  if (path.match(/exception_status\[\d+\]/) && typeof value === 'number') {
    const name = EXCEPTION_NAMES[value];
    return name ? `${value} (${name})` : String(value);
  }
  if (s === undefined) return 'undefined';
  return s;
}

/** Detect changes between old and new flat snapshots, log them */
function detectChanges(oldFlat: Record<string, unknown>, newFlat: Record<string, unknown>): void {
  const now = Date.now();
  const allKeys = new Set([...Object.keys(oldFlat), ...Object.keys(newFlat)]);
  for (const key of allKeys) {
    const oldVal = oldFlat[key];
    const newVal = newFlat[key];
    const oldStr = JSON.stringify(oldVal);
    const newStr = JSON.stringify(newVal);
    if (oldStr !== newStr) {
      recentChanges.set(key, now);
      // Log if global logging is on, OR if this specific path is watched
      if (changeLoggingEnabled || isPathWatched(key)) {
        changeLog.push({ timestamp: now, path: key, oldValue: oldVal, newValue: newVal });
        if (changeLog.length > MAX_CHANGE_LOG) {
          changeLog = changeLog.slice(-MAX_CHANGE_LOG);
        }
      }
    }
  }
}

/** Check if a path or any of its ancestors is watched */
function isPathWatched(path: string): boolean {
  if (watchedPaths.has(path)) return true;
  // Check if any watched path is a prefix of this path
  for (const wp of watchedPaths) {
    if (path.startsWith(wp + '.') || path.startsWith(wp + '[')) return true;
  }
  return false;
}

/** Build tree HTML for nested state */
function buildTreeHtml(obj: unknown, path: string, filter: string, depth = 0): string {
  const now = Date.now();
  if (obj === null || obj === undefined) {
    const changed = recentChanges.has(path) && now - recentChanges.get(path)! < HIGHLIGHT_DURATION;
    const watched = isPathWatched(path);
    const cls = changed ? ' debug-changed' : '';
    // Apply filter to null/undefined leaves too
    if (
      filter &&
      !path.toLowerCase().includes(filter) &&
      !String(obj).toLowerCase().includes(filter)
    ) {
      return '';
    }
    return `<div class="debug-leaf whitespace-nowrap [padding:1px_0] rounded-[3px] [transition:background_0.3s_ease] ${cls}" style="padding-left:${depth * 16}px">
      ${watched ? `<span class="text-[10px] [margin-right:2px]" title="Watched">${iconSolo('watching')}</span>` : ''}
      <span class="text-[#79c0ff] mr-1 after:content-[':'] after:text-fg-soft after:mr-1 after:[.debug-node>&]:content-['']">${escapeKey(path)}</span>
      <span class="text-[#8b949e] [font-style:italic]">${String(obj)}</span>
      <span class="debug-watch cursor-pointer text-[10px] opacity-[0.3] ml-1 select-none [transition:opacity_0.15s] [.debug-leaf:hover_&]:opacity-[1] [.debug-node:hover>&]:opacity-[1]" data-path="${escapeHtmlStr(path)}" title="Toggle watch">${watched ? iconSolo('watching') : iconSolo('unwatched')}</span>
    </div>`;
  }
  if (typeof obj !== 'object') {
    const display = formatValue(path, obj);
    const changed = recentChanges.has(path) && now - recentChanges.get(path)! < HIGHLIGHT_DURATION;
    const watched = isPathWatched(path);
    const cls = changed ? ' debug-changed' : '';
    if (
      filter &&
      !path.toLowerCase().includes(filter) &&
      !String(obj).toLowerCase().includes(filter) &&
      !display.toLowerCase().includes(filter)
    ) {
      return '';
    }
    return `<div class="debug-leaf whitespace-nowrap [padding:1px_0] rounded-[3px] [transition:background_0.3s_ease] ${cls}" style="padding-left:${depth * 16}px">
      ${watched ? `<span class="text-[10px] [margin-right:2px]" title="Watched">${iconSolo('watching')}</span>` : ''}
      <span class="text-[#79c0ff] mr-1 after:content-[':'] after:text-fg-soft after:mr-1 after:[.debug-node>&]:content-['']">${escapeKey(lastSegment(path))}</span>
      <span class="${typeClass(obj)}">${escapeHtmlStr(display)}</span>
      <span class="debug-watch cursor-pointer text-[10px] opacity-[0.3] ml-1 select-none [transition:opacity_0.15s] [.debug-leaf:hover_&]:opacity-[1] [.debug-node:hover>&]:opacity-[1]" data-path="${escapeHtmlStr(path)}" title="Toggle watch">${watched ? iconSolo('watching') : iconSolo('unwatched')}</span>
    </div>`;
  }
  if (Array.isArray(obj)) {
    const collapsed = collapsedPaths.has(path);
    const childrenHtml = collapsed
      ? ''
      : obj.map((item, i) => buildTreeHtml(item, `${path}[${i}]`, filter, depth + 1)).join('');
    // If filtering and no children matched and the path doesn't match, hide
    const hasVisibleChildren = childrenHtml.replace(/\s/g, '').length > 0;
    if (filter && !hasVisibleChildren && !collapsed && !path.toLowerCase().includes(filter))
      return '';
    const watched = watchedPaths.has(path);
    const arrow = collapsed ? icon('collapsed') : icon('expanded');
    return `<div class="debug-node cursor-default whitespace-nowrap" style="padding-left:${depth * 16}px">
      <span class="debug-toggle cursor-pointer inline-block w-[14px] text-center text-fg-soft select-none text-[10px] hover:text-accent" data-path="${escapeHtmlStr(path)}">${arrow}</span>
      <span class="text-[#79c0ff] mr-1 after:content-[':'] after:text-fg-soft after:mr-1 after:[.debug-node>&]:content-['']">${escapeKey(lastSegment(path))}</span>
      <span class="text-fg-soft text-[11px]">[${obj.length}]</span>
      <span class="debug-watch cursor-pointer text-[10px] opacity-[0.3] ml-1 select-none [transition:opacity_0.15s] [.debug-leaf:hover_&]:opacity-[1] [.debug-node:hover>&]:opacity-[1]" data-path="${escapeHtmlStr(path)}" title="Watch all children">${watched ? iconSolo('watching') : iconSolo('unwatched')}</span>
    </div>${childrenHtml}`;
  }
  const rec = obj as Record<string, unknown>;
  const keys = Object.keys(rec);
  const collapsed = collapsedPaths.has(path);
  const childrenHtml = collapsed
    ? ''
    : keys.map((k) => buildTreeHtml(rec[k], path ? `${path}.${k}` : k, filter, depth + 1)).join('');
  const hasVisibleChildren = childrenHtml.replace(/\s/g, '').length > 0;
  if (filter && !hasVisibleChildren && !collapsed && !path.toLowerCase().includes(filter))
    return '';
  const watched = watchedPaths.has(path);
  const arrow = collapsed ? icon('collapsed') : icon('expanded');
  const label = path ? lastSegment(path) : '{root}';
  return `<div class="debug-node cursor-default whitespace-nowrap" style="padding-left:${depth * 16}px">
    <span class="debug-toggle cursor-pointer inline-block w-[14px] text-center text-fg-soft select-none text-[10px] hover:text-accent" data-path="${escapeHtmlStr(path)}">${arrow}</span>
    <span class="text-[#79c0ff] mr-1 after:content-[':'] after:text-fg-soft after:mr-1 after:[.debug-node>&]:content-['']">${escapeKey(label)}</span>
    <span class="text-fg-soft text-[11px]">{${keys.length}}</span>
    ${path ? `<span class="debug-watch cursor-pointer text-[10px] opacity-[0.3] ml-1 select-none [transition:opacity_0.15s] [.debug-leaf:hover_&]:opacity-[1] [.debug-node:hover>&]:opacity-[1]" data-path="${escapeHtmlStr(path)}" title="Watch all children">${watched ? iconSolo('watching') : iconSolo('unwatched')}</span>` : ''}
  </div>${childrenHtml}`;
}

function lastSegment(path: string): string {
  const dot = path.lastIndexOf('.');
  const bracket = path.lastIndexOf('[');
  const idx = Math.max(dot, bracket);
  return idx >= 0 ? path.slice(idx + (path[idx] === '.' ? 1 : 0)) : path;
}

function escapeKey(s: string): string {
  return escapeHtmlStr(s);
}

function escapeHtmlStr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function typeClass(val: unknown): string {
  if (typeof val === 'number') return 'debug-number';
  if (typeof val === 'boolean') return 'debug-boolean';
  if (typeof val === 'string') return 'debug-string';
  return '';
}

// ---- Change detection (runs on EVERY state change, regardless of tab visibility) ----

/** Track state changes: must be called on every state update to avoid missing intermediate values */
export function trackStateChanges(state: PrinterState): void {
  const snapshot = getStateSnapshot(state);
  const flatNew = flattenObject(snapshot);

  // Only detect after we have a baseline
  if (Object.keys(prevSnapshot).length > 0) {
    detectChanges(prevSnapshot, flatNew);
  }
  prevSnapshot = flatNew;
}

// ---- Render (only when debug tab is visible) ----

/** Render the debug state tree (called on every state change) */
export function renderDebugPanel(state: PrinterState): void {
  const container = document.getElementById('debug-state-tree');
  if (!container) return;
  // Only render if debug tab is visible
  const tabContent = document.getElementById('debug-tab-content');
  if (!tabContent || tabContent.classList.contains('hidden')) return;

  // Clean old highlights
  const now = Date.now();
  for (const [key, ts] of recentChanges) {
    if (now - ts > HIGHLIGHT_DURATION) recentChanges.delete(key);
  }

  // Simple hash to skip identical renders
  const hash = JSON.stringify(prevSnapshot);
  if (hash === lastRenderedStateHash && recentChanges.size === 0) return;
  lastRenderedStateHash = hash;

  // Build tree from current snapshot
  const snapshot = getStateSnapshot(state);
  const filter = currentFilter.toLowerCase();
  const treeHtml = buildTreeHtml(snapshot, '', filter);
  container.innerHTML =
    treeHtml ||
    '<div class="text-fg-soft [font-style:italic] p-4 text-center">No matching fields</div>';

  // Render change log
  renderChangeLog();
}

function renderChangeLog(): void {
  const container = document.getElementById('debug-change-log');
  if (!container) return;
  if (changeLog.length === lastRenderedLogCount) return;
  lastRenderedLogCount = changeLog.length;

  const count = document.getElementById('debug-log-count');
  if (count) count.textContent = `${changeLog.length} changes`;

  // Show last 200 entries (most recent at bottom)
  const visible = changeLog.slice(-200);
  let html = '';
  for (const entry of visible) {
    const time = new Date(entry.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    } as Intl.DateTimeFormatOptions);
    const oldStr = formatValue(entry.path, entry.oldValue);
    const newStr = formatValue(entry.path, entry.newValue);
    const watched = isPathWatched(entry.path);
    html += `<div class="flex [gap:6px] [padding:2px_4px] border-b border-line items-baseline flex-wrap hover:bg-input ${watched ? 'bg-[rgba(88,_166,_255,_0.05)]' : ''}">
      <span class="text-fg-soft shrink-0 text-[10px]">${time}</span>
      ${watched ? `<span class="text-[10px] shrink-0">${iconSolo('watching')}</span>` : ''}
      <span class="text-[#79c0ff] shrink-0 max-w-[250px] overflow-hidden text-ellipsis">${escapeHtmlStr(entry.path)}</span>
      <span class="text-[#f85149] [text-decoration:line-through] max-w-[150px] overflow-hidden text-ellipsis">${escapeHtmlStr(oldStr)}</span>
      <span class="text-fg-soft shrink-0">${iconSolo('changeTo')}</span>
      <span class="text-[#3fb950] max-w-50 overflow-hidden text-ellipsis">${escapeHtmlStr(newStr)}</span>
    </div>`;
  }
  container.innerHTML =
    html ||
    '<div class="text-fg-soft [font-style:italic] p-4 text-center">No changes logged yet. Enable logging or watch specific values to start recording.</div>';

  if (autoScrollLog) {
    container.scrollTop = container.scrollHeight;
  }
}

/** Render the watched paths list */
function renderWatchedPaths(): void {
  const container = document.getElementById('debug-watched-list');
  if (!container) return;
  if (watchedPaths.size === 0) {
    container.innerHTML = `<span class="text-fg-soft text-[11px] [font-style:italic]">Click ${icon('unwatched')} on any value to watch it</span>`;
    return;
  }
  let html = '';
  for (const path of watchedPaths) {
    html += `<span class="debug-watched-tag inline-flex items-center gap-1 [padding:2px_8px] bg-[rgba(88,_166,_255,_0.15)] border border-[rgba(88,_166,_255,_0.3)] rounded-[12px] text-[11px] font-mono text-[#79c0ff] cursor-pointer [transition:background_0.15s] hover:bg-[rgba(248,_81,_73,_0.2)] hover:border-[rgba(248,_81,_73,_0.4)] hover:text-[#f85149]" data-path="${escapeHtmlStr(path)}">${escapeHtmlStr(path)} ${icon('close')}</span>`;
  }
  container.innerHTML = html;
}

/** Start change logging with auto-disable timeout */
function startLogging(): void {
  changeLoggingEnabled = true;
  if (changeLogTimer) clearTimeout(changeLogTimer);
  changeLogTimer = setTimeout(() => {
    changeLoggingEnabled = false;
    updateLoggingUI();
  }, changeLogTimeout);
  updateLoggingUI();
}

function stopLogging(): void {
  changeLoggingEnabled = false;
  if (changeLogTimer) {
    clearTimeout(changeLogTimer);
    changeLogTimer = null;
  }
  updateLoggingUI();
}

function updateLoggingUI(): void {
  const btn = document.getElementById('debug-log-toggle') as HTMLButtonElement | null;
  if (btn) {
    if (changeLoggingEnabled) iconText(btn, 'stop', 'Stop Logging');
    else iconText(btn, 'play', 'Start Logging');
    toggleState(btn, 'active', changeLoggingEnabled);
  }
  const badge = document.getElementById('debug-logging-badge');
  if (badge) {
    badge.classList.toggle('hidden', !changeLoggingEnabled);
    if (changeLoggingEnabled) {
      const mins = Math.round(changeLogTimeout / 60000);
      badge.textContent = `LOGGING (auto-stop in ${mins}m)`;
    }
  }
}

/** Export change log as JSON file */
function exportChangeLog(): void {
  if (changeLog.length === 0) return;
  const data = changeLog.map((e) => ({
    time: new Date(e.timestamp).toISOString(),
    path: e.path,
    old: e.oldValue,
    new: e.newValue,
  }));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `debug-changes-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Export full current state as JSON file */
function exportState(): void {
  const stateStr = JSON.stringify(prevSnapshot, null, 2);
  const blob = new Blob([stateStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `debug-state-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Bind debug panel controls (idempotent) */
export function bindDebugPanel(): void {
  if (debugBound) return;
  debugBound = true;

  // Toggle tree nodes + watch toggle (delegated)
  const tree = document.getElementById('debug-state-tree');
  if (tree) {
    tree.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // Collapse/expand toggle
      const toggle = target.closest('.debug-toggle') as HTMLElement | null;
      if (toggle) {
        const path = toggle.dataset.path ?? '';
        if (collapsedPaths.has(path)) {
          collapsedPaths.delete(path);
        } else {
          collapsedPaths.add(path);
        }
        lastRenderedStateHash = '';
        return;
      }

      // Watch toggle
      const watch = target.closest('.debug-watch') as HTMLElement | null;
      if (watch) {
        const path = watch.dataset.path ?? '';
        if (!path) return;
        if (watchedPaths.has(path)) {
          watchedPaths.delete(path);
        } else {
          watchedPaths.add(path);
        }
        saveWatchedPaths();
        lastRenderedStateHash = ''; // force re-render
        renderWatchedPaths();
        return;
      }
    });
  }

  // Watched list: click to remove
  const watchedList = document.getElementById('debug-watched-list');
  if (watchedList) {
    watchedList.addEventListener('click', (e) => {
      const tag = (e.target as HTMLElement).closest('.debug-watched-tag') as HTMLElement | null;
      if (!tag) return;
      const path = tag.dataset.path ?? '';
      watchedPaths.delete(path);
      saveWatchedPaths();
      lastRenderedStateHash = '';
      renderWatchedPaths();
    });
  }

  // Filter input
  const filterInput = document.getElementById('debug-filter') as HTMLInputElement | null;
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      currentFilter = filterInput.value;
      lastRenderedStateHash = ''; // force re-render
    });
  }

  // Logging toggle
  const logToggle = document.getElementById('debug-log-toggle');
  if (logToggle) {
    logToggle.addEventListener('click', () => {
      if (changeLoggingEnabled) stopLogging();
      else startLogging();
    });
  }

  // Timeout select
  const timeoutSelect = document.getElementById('debug-log-timeout') as HTMLSelectElement | null;
  if (timeoutSelect) {
    timeoutSelect.addEventListener('change', () => {
      changeLogTimeout = parseInt(timeoutSelect.value, 10) * 60 * 1000;
      // If currently logging, restart the timer
      if (changeLoggingEnabled) startLogging();
    });
  }

  // Export buttons
  const exportLogBtn = document.getElementById('debug-export-log');
  if (exportLogBtn) {
    exportLogBtn.addEventListener('click', exportChangeLog);
  }

  const exportStateBtn = document.getElementById('debug-export-state');
  if (exportStateBtn) {
    exportStateBtn.addEventListener('click', exportState);
  }

  // Clear log
  const clearBtn = document.getElementById('debug-clear-log');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      changeLog = [];
      lastRenderedLogCount = 0;
      renderChangeLog();
    });
  }

  // Auto-scroll toggle
  const scrollToggle = document.getElementById('debug-log-autoscroll') as HTMLInputElement | null;
  if (scrollToggle) {
    scrollToggle.addEventListener('change', () => {
      autoScrollLog = scrollToggle.checked;
    });
  }

  updateLoggingUI();
  renderWatchedPaths();

  // Video stream debug buttons
  const resultSpan = document.getElementById('debug-videostream-result');
  const sdcpBtn = document.getElementById('debug-videostream-sdcp') as HTMLButtonElement | null;
  if (sdcpBtn) {
    sdcpBtn.addEventListener('click', async () => {
      sdcpBtn.disabled = true;
      if (resultSpan) resultSpan.textContent = 'SDCP: connecting...';
      try {
        const resp = await fetchTimeout('/api/debug/videostream/sdcp', { method: 'POST' }, 15_000);
        const data = await resp.json();
        if (resultSpan)
          data.success
            ? iconText(
                resultSpan,
                'check',
                `SDCP: ${data.videoUrl ? `VideoUrl: ${data.videoUrl}` : 'OK'}`,
              )
            : iconText(resultSpan, 'cross', `SDCP: ${data.error || 'Failed'}`);
      } catch (err: unknown) {
        if (resultSpan)
          iconText(
            resultSpan,
            'cross',
            `SDCP: ${err instanceof Error ? err.message : String(err)}`,
          );
      } finally {
        sdcpBtn.disabled = false;
      }
    });
  }

  const mqttBtn = document.getElementById('debug-videostream-mqtt') as HTMLButtonElement | null;
  if (mqttBtn) {
    mqttBtn.addEventListener('click', async () => {
      mqttBtn.disabled = true;
      if (resultSpan) resultSpan.textContent = 'MQTT: sending...';
      try {
        const resp = await fetchTimeout('/api/debug/videostream/mqtt', { method: 'POST' }, 15_000);
        const data = await resp.json();
        if (resultSpan)
          data.success
            ? iconText(resultSpan, 'check', 'MQTT 1054 sent. Check the log for the response.')
            : iconText(resultSpan, 'cross', `MQTT 1054: ${data.error || 'Failed'}`);
      } catch (err: unknown) {
        if (resultSpan)
          iconText(
            resultSpan,
            'cross',
            `MQTT 1054: ${err instanceof Error ? err.message : String(err)}`,
          );
      } finally {
        mqttBtn.disabled = false;
      }
    });
  }
}
