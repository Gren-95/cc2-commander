/**
 * Tools → Maintenance.
 *
 * An editable task list (label, interval in print hours) and a read-only status list
 * showing hours since each task was last done, computed server-side from the print
 * ledger. `workshop/maintenance-core.ts` has the maths; this file only draws it and
 * saves what is typed.
 *
 * ## Two static siblings, not one re-rendered panel
 *
 * The status list refetches on every `workshop_changed` frame: a finished print adds
 * hours to every task. If the editor were rebuilt along with it, a label half-typed
 * into a field would vanish out from under whoever was typing it, the same hazard
 * `workshop-cost.ts` avoids the same way. So the editor and the status list are two
 * separate elements; a refetch always redraws the status list, but only rebuilds the
 * editor when no field in it is focused.
 */

import type { MaintenanceTask, TaskState, TaskStatus } from '../workshop/maintenance-core';
import { BTN, BTN_ICON, BTN_PRIMARY, EMPTY, FIELD, LABEL } from './design';
import { escapeAttr, escapeHtml, fetchTimeout } from './helpers';
import { type IconName, icon, iconSolo } from './icons';
import { toast } from './toast';

const HOST_ID = 'workshop-maintenance-content';

interface MaintenanceData {
  tasks: TaskStatus[];
  totalHours: number;
}

let loaded = false;
let mounted = false;
let data: MaintenanceData | null = null;

function fmtHours(h: number): string {
  return h >= 100 ? String(Math.round(h)) : h.toFixed(1);
}

const STATE_LABEL: Record<TaskState, string> = { ok: 'OK', soon: 'Soon', due: 'Due' };
const STATE_COLOR: Record<TaskState, string> = {
  ok: 'text-ok',
  soon: 'text-warn',
  due: 'text-bad',
};
const STATE_ICON: Record<TaskState, IconName> = {
  ok: 'ok',
  soon: 'warning',
  due: 'warning',
};

function taskRowHtml(task: MaintenanceTask): string {
  return `
    <div class="flex items-center gap-2" data-task-row data-task-id="${escapeAttr(task.id)}">
      <input type="text" data-task-label value="${escapeAttr(task.label)}" aria-label="Task name"
        placeholder="Task, e.g. Clean the nozzle" class="${FIELD} flex-1 min-w-0">
      <div class="flex items-center gap-1.5 shrink-0">
        <input type="number" data-task-interval min="1" max="100000" step="1"
          value="${task.intervalHours}" aria-label="Interval in print hours" class="${FIELD} w-20">
        <span class="${LABEL}">h</span>
      </div>
      <button type="button" data-remove-task class="${BTN_ICON}"
        aria-label="Remove ${escapeAttr(task.label) || 'task'}">${iconSolo('trash')}</button>
    </div>`;
}

function editorHtml(tasks: readonly MaintenanceTask[]): string {
  return `
    <div class="flex flex-col gap-4 rounded-xl border border-line bg-card p-4 mb-5">
      <h3 class="text-xs font-semibold tracking-wide text-fg-muted">${icon('maintenance')}Tasks</h3>
      <div id="maintenance-tasks" class="flex flex-col gap-2">
        ${tasks.map(taskRowHtml).join('')}
      </div>
      <div class="flex items-center gap-3">
        <button type="button" id="maintenance-add-task" class="${BTN} self-start">${icon('add')}Add task</button>
        <button type="button" id="maintenance-save" class="${BTN_PRIMARY}">${icon('save')}Save changes</button>
      </div>
    </div>`;
}

function statusRowHtml(t: TaskStatus): string {
  const lastDone =
    t.lastDoneAt === null
      ? 'Never done: counting from the first recorded print'
      : `Last done ${new Date(t.lastDoneAt).toLocaleString()}`;
  return `<tr class="border-t border-line-soft" data-task-status-id="${escapeAttr(t.id)}">
      <td class="py-1.5 pr-4">
        <div class="font-medium text-fg">${escapeHtml(t.label)}</div>
        <div class="${LABEL}">${escapeHtml(lastDone)}</div>
      </td>
      <td class="py-1.5 pr-4 text-right tabular-nums whitespace-nowrap">${fmtHours(t.hoursSince)}h of ${t.intervalHours}h</td>
      <td class="py-1.5 pr-4">
        <span class="inline-flex items-center gap-1.5 font-medium ${STATE_COLOR[t.state]}">${icon(STATE_ICON[t.state])}${STATE_LABEL[t.state]}</span>
      </td>
      <td class="py-1.5 text-right">
        <button type="button" data-mark-done="${escapeAttr(t.id)}" class="${BTN}">${icon('done')}Mark done</button>
      </td>
    </tr>`;
}

function statusListHtml(d: MaintenanceData): string {
  if (!d.tasks.length) {
    return `<div class="${EMPTY}">${iconSolo('maintenance')}<p>No maintenance tasks yet.</p>
      <p>Add one above to start tracking it by print hours.</p></div>`;
  }
  const rows = d.tasks.map(statusRowHtml).join('');
  return `
    <div class="overflow-x-auto">
      <table class="w-full text-xs">
        <thead class="text-fg-muted"><tr>
          <th class="py-1.5 pr-4 text-left font-medium">Task</th>
          <th class="py-1.5 pr-4 text-right font-medium">Hours</th>
          <th class="py-1.5 pr-4 text-left font-medium">Status</th>
          <th class="py-1.5 text-right font-medium"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/** Read the task rows currently in the DOM, skipping any left with no name. */
function tasksFromForm(): Array<{ id?: string; label: string; intervalHours: number }> {
  const tasks: Array<{ id?: string; label: string; intervalHours: number }> = [];
  for (const row of document.querySelectorAll<HTMLElement>('#maintenance-tasks [data-task-row]')) {
    const label = row.querySelector<HTMLInputElement>('[data-task-label]')?.value.trim() ?? '';
    const interval = Number(
      row.querySelector<HTMLInputElement>('[data-task-interval]')?.value ?? '',
    );
    if (!label || !Number.isFinite(interval) || interval <= 0) continue;
    const id = row.dataset.taskId;
    tasks.push(id ? { id, label, intervalHours: interval } : { label, intervalHours: interval });
  }
  return tasks;
}

async function saveTasks(): Promise<void> {
  const btn = document.getElementById('maintenance-save') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    const res = await fetchTimeout('/api/workshop/maintenance/tasks', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tasksFromForm()),
    });
    const body = (await res.json()) as { data?: MaintenanceData; error?: { message?: string } };
    if (!res.ok) {
      toast(body.error?.message ?? 'Could not save tasks', 'error');
      return;
    }
    toast('Tasks saved', 'success');
    data = body.data ?? data;
    renderEditor();
    renderStatusList();
  } catch {
    toast('Not connected to the service', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function markDone(id: string): Promise<void> {
  try {
    const res = await fetchTimeout(
      `/api/workshop/maintenance/tasks/${encodeURIComponent(id)}/done`,
      {
        method: 'POST',
      },
    );
    const body = (await res.json()) as { data?: MaintenanceData; error?: { message?: string } };
    if (!res.ok) {
      toast(body.error?.message ?? 'Could not mark the task done', 'error');
      return;
    }
    toast('Marked done', 'success');
    data = body.data ?? data;
    renderEditor();
    renderStatusList();
  } catch {
    toast('Not connected to the service', 'error');
  }
}

function bindEditor(): void {
  document.getElementById('maintenance-save')?.addEventListener('click', () => void saveTasks());

  document.getElementById('maintenance-add-task')?.addEventListener('click', () => {
    const container = document.getElementById('maintenance-tasks');
    if (!container) return;
    container.insertAdjacentHTML(
      'beforeend',
      taskRowHtml({ id: '', label: '', intervalHours: 100, lastDoneAt: null }),
    );
    const rows = container.querySelectorAll<HTMLInputElement>('[data-task-label]');
    rows[rows.length - 1]?.focus();
  });

  document.getElementById('maintenance-tasks')?.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('[data-remove-task]')) return;
    (e.target as HTMLElement).closest('[data-task-row]')?.remove();
  });
}

function renderEditor(): void {
  if (!data) return;
  const host = document.getElementById('maintenance-editor');
  if (!host) return;
  // Never redraw under someone's fingers, see the module comment.
  if (host.contains(document.activeElement) && document.activeElement !== document.body) return;
  host.innerHTML = editorHtml(data.tasks);
  bindEditor();
}

function renderStatusList(): void {
  if (!data) return;
  const host = document.getElementById('maintenance-status-list');
  if (host) host.innerHTML = statusListHtml(data);
}

async function fetchAndRender(): Promise<void> {
  const host = document.getElementById(HOST_ID);
  if (!host) return;
  if (!mounted) {
    host.innerHTML = `
      <div id="maintenance-editor"></div>
      <div id="maintenance-status-list"></div>`;
    mounted = true;
    host.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-mark-done]')?.dataset
        .markDone;
      if (id) void markDone(id);
    });
  }
  if (!loaded) {
    const statusHost = document.getElementById('maintenance-status-list');
    if (statusHost) statusHost.innerHTML = `<p class="${LABEL}">Loading maintenance tasks…</p>`;
  }

  try {
    const res = await fetchTimeout('/api/workshop/maintenance');
    const body = (await res.json()) as { data?: MaintenanceData };
    if (!res.ok || !body.data) throw new Error(String(res.status));
    data = body.data;
    renderEditor();
    renderStatusList();
    loaded = true;
  } catch {
    if (loaded) return; // keep the figures already on screen
    const statusHost = document.getElementById('maintenance-status-list');
    if (statusHost) {
      statusHost.innerHTML = `<div class="${EMPTY}">${iconSolo('warning')}<p>Could not load maintenance tasks: the service did not answer.</p>
        <button type="button" id="maintenance-retry" class="text-accent underline">${icon('refresh')}Try again</button></div>`;
      statusHost
        .querySelector('#maintenance-retry')
        ?.addEventListener('click', () => void fetchAndRender());
    }
  }
}

export async function renderWorkshopMaintenance(): Promise<void> {
  await fetchAndRender();
}
