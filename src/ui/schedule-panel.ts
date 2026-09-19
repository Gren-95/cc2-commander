/**
 * Tools → Schedule.
 *
 * A form to start a file at a chosen time, once, and a list of what is upcoming or has
 * already happened. `schedule-core.ts` and `server/schedule.ts` have the reasoning —
 * this file only draws it and saves what is typed.
 *
 * ## The filename is typed, not browsed
 *
 * A schedule can name any file on the printer, but this panel does not browse the
 * printer's folders to offer one — the Files card already does that, and duplicating
 * it here would drift. Absent beats wrong: the server re-checks the exact file is
 * still there, in the exact folder, the moment before it would fire (`schedule.ts`),
 * so a stale or mistyped name never silently starts the wrong thing — it skips, and
 * says why.
 *
 * The Start Print dialog is the other way in: its Later choice schedules through
 * `postSchedule`, the same request this form makes, so there is one place that decides
 * what a schedule request looks like. This form sends no options — a schedule made here
 * starts as it always has — while the dialog sends everything it collected.
 *
 * ## One static sibling, one freely-drawn list
 *
 * The add form is bound once and never rebuilt from fetched data, matching
 * `workshop-cost.ts`'s reasoning — nothing in it reflects server state, so a
 * `schedule_changed` refetch has nothing in it to clobber. The list carries no input
 * of its own (a Cancel button holds no typed state), so it redraws freely.
 */

import type { PrintOptions, ScheduledPrint, ScheduleStatus } from '../schedule-core';
import { BTN_ICON, BTN_PRIMARY, EMPTY, FIELD, LABEL } from './design';
import { escapeAttr, escapeHtml, fetchTimeout } from './helpers';
import { type IconName, icon, iconSolo } from './icons';
import { toast } from './toast';

const HOST_ID = 'schedule-content';

let loaded = false;
let mounted = false;
let schedules: ScheduledPrint[] = [];

const STATUS_LABEL: Record<ScheduleStatus, string> = {
  pending: 'Pending',
  fired: 'Started',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};
const STATUS_COLOR: Record<ScheduleStatus, string> = {
  pending: 'text-fg',
  fired: 'text-ok',
  skipped: 'text-bad',
  cancelled: 'text-fg-muted',
};
const STATUS_ICON: Record<ScheduleStatus, IconName> = {
  pending: 'clock',
  fired: 'ok',
  skipped: 'warning',
  cancelled: 'close',
};

/** `<input type="datetime-local">`'s own format, in local time, a minute from now — so
 *  the field's `min` refuses the past without refusing "right now". */
export function minLocalDateTime(): string {
  const d = new Date(Date.now() + 60_000);
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function addFormHtml(): string {
  return `
    <div class="flex flex-col gap-3 rounded-xl border border-line bg-card p-4 mb-5">
      <h3 class="text-xs font-semibold tracking-wide text-fg-muted">${icon('add')}Schedule a print</h3>
      <div class="flex flex-wrap items-end gap-2">
        <div class="flex flex-col gap-1 flex-1 min-w-40">
          <label class="${LABEL}" for="schedule-filename">File</label>
          <input type="text" id="schedule-filename" placeholder="benchy.gcode, or misc/benchy.gcode"
            class="${FIELD} w-full">
        </div>
        <div class="flex flex-col gap-1">
          <label class="${LABEL}" for="schedule-when">When</label>
          <input type="datetime-local" id="schedule-when" min="${minLocalDateTime()}" class="${FIELD}">
        </div>
        <button type="button" id="schedule-add" class="${BTN_PRIMARY}">${icon('add')}Schedule</button>
      </div>
      <p class="${LABEL}">
        The exact path Files shows for it — check there if you are not sure. The
        printer is re-checked for the file right before it fires; it is skipped, not
        guessed, if the file, or the printer, is not there.
      </p>
    </div>`;
}

/**
 * Ask the service to start `filename` once, at `runAt`.
 *
 * Says why on failure — a toast, from here, so every caller reads the same — and returns
 * whether the schedule was created. `filename` is the path 1020 wants (`benchy.gcode`,
 * `misc/benchy.gcode`); the folder is worked out from it so the service can re-list
 * exactly that folder before firing. `options` is what to start it with; `null` for none.
 */
export async function postSchedule(
  filename: string,
  runAt: number,
  options: PrintOptions | null = null,
): Promise<boolean> {
  const lastSlash = filename.lastIndexOf('/');
  const dir = lastSlash === -1 ? '' : filename.slice(0, lastSlash);
  try {
    const res = await fetchTimeout('/api/schedule/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, dir, runAt, options }),
    });
    const body = (await res.json()) as { error?: { message?: string } };
    if (!res.ok) {
      toast(body.error?.message ?? 'Could not schedule this print', 'error');
      return false;
    }
    toast('Scheduled', 'success');
    return true;
  } catch {
    toast('Not connected to the service', 'error');
    return false;
  }
}

async function addSchedule(): Promise<void> {
  const filenameEl = document.getElementById('schedule-filename') as HTMLInputElement | null;
  const whenEl = document.getElementById('schedule-when') as HTMLInputElement | null;
  const filename = filenameEl?.value.trim() ?? '';
  const when = whenEl?.value ?? '';
  const runAt = when ? new Date(when).getTime() : NaN;
  if (!filename || !Number.isFinite(runAt)) {
    toast('A schedule needs a file and a time', 'error');
    return;
  }
  if (runAt <= Date.now()) {
    toast('Pick a time in the future', 'error');
    return;
  }

  const btn = document.getElementById('schedule-add') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    if (!(await postSchedule(filename, runAt))) return;
    if (filenameEl) filenameEl.value = '';
    if (whenEl) whenEl.value = '';
    await fetchAndRender();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function cancelSchedule(id: string): Promise<void> {
  try {
    const res = await fetchTimeout(`/api/schedule/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const body = (await res.json()) as { error?: { message?: string } };
    if (!res.ok) {
      toast(body.error?.message ?? 'Could not cancel this schedule', 'error');
      return;
    }
    await fetchAndRender();
  } catch {
    toast('Not connected to the service', 'error');
  }
}

/** What a pending job will start with — the point of keeping the settings is that you can
 *  see them before nobody is there to. Empty for a schedule made with none. */
function optionsSummary(o: PrintOptions | null): string {
  if (!o) return '';
  const parts = [
    o.bedType === 'A' ? 'Textured plate' : 'Smooth plate',
    `timelapse ${o.timelapse ? 'on' : 'off'}`,
    `bed leveling ${o.bedLeveling ? 'on' : 'off'}`,
  ];
  if (o.spools.length) {
    parts.push(`spools ${o.spools.map((x) => `C${x.canvas_id + 1}:T${x.tray_id + 1}`).join(', ')}`);
  }
  return parts.join(' · ');
}

function scheduleRowHtml(s: ScheduledPrint): string {
  const when = new Date(s.runAt).toLocaleString();
  const sub =
    s.status === 'skipped' && s.skipReason
      ? s.skipReason
      : s.status === 'fired' && s.firedAt
        ? `Started ${new Date(s.firedAt).toLocaleString()}`
        : when;
  const cancel =
    s.status === 'pending'
      ? `<button type="button" data-cancel="${escapeAttr(s.id)}" class="${BTN_ICON}" aria-label="Cancel">${iconSolo('close')}</button>`
      : '';
  return `
    <div class="flex items-center gap-3 rounded-xl border border-line bg-card p-3">
      <div class="flex-1 min-w-0">
        <div class="font-medium text-fg truncate">${escapeHtml(s.filename)}</div>
        <div class="${LABEL}">${s.status === 'pending' ? `Runs ${when}` : escapeHtml(sub)}</div>
        ${s.status === 'pending' && s.options ? `<div class="${LABEL}">${escapeHtml(optionsSummary(s.options))}</div>` : ''}
      </div>
      <span class="inline-flex items-center gap-1.5 text-[13px] font-medium ${STATUS_COLOR[s.status]}">${icon(STATUS_ICON[s.status])}${STATUS_LABEL[s.status]}</span>
      ${cancel}
    </div>`;
}

function listHtml(): string {
  if (!schedules.length) {
    return `<div class="${EMPTY}">${iconSolo('schedule')}<p>No scheduled prints.</p>
      <p>Add one above and it will start on its own at the time you pick.</p></div>`;
  }
  return `<div class="flex flex-col gap-2">${schedules.map(scheduleRowHtml).join('')}</div>`;
}

function renderList(): void {
  const host = document.getElementById('schedule-list');
  if (host) host.innerHTML = listHtml();
}

function bindPanel(host: HTMLElement): void {
  document.getElementById('schedule-add')?.addEventListener('click', () => void addSchedule());
  host.addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-cancel]')?.dataset.cancel;
    if (id) void cancelSchedule(id);
  });
}

async function fetchAndRender(): Promise<void> {
  const host = document.getElementById(HOST_ID);
  if (!host) return;
  if (!mounted) {
    host.innerHTML = `${addFormHtml()}<div id="schedule-list"></div>`;
    mounted = true;
    bindPanel(host);
  }
  if (!loaded) {
    const listHost = document.getElementById('schedule-list');
    if (listHost) listHost.innerHTML = `<p class="${LABEL}">Loading schedule…</p>`;
  }

  try {
    const res = await fetchTimeout('/api/schedule/');
    const body = (await res.json()) as { data?: { schedules?: ScheduledPrint[] } };
    if (!res.ok || !body.data) throw new Error(String(res.status));
    schedules = body.data.schedules ?? [];
    renderList();
    loaded = true;
  } catch {
    if (loaded) return; // keep the list already on screen
    const listHost = document.getElementById('schedule-list');
    if (listHost) {
      listHost.innerHTML = `<div class="${EMPTY}">${iconSolo('warning')}<p>Could not load the schedule: the service did not answer.</p>
        <button type="button" id="schedule-retry" class="text-accent underline">${icon('refresh')}Try again</button></div>`;
      listHost
        .querySelector('#schedule-retry')
        ?.addEventListener('click', () => void fetchAndRender());
    }
  }
}

export async function renderSchedulePanel(): Promise<void> {
  await fetchAndRender();
}
