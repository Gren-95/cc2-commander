/**
 * Maintenance reminders, counted in print hours.
 *
 * Hours rather than days because wear follows use: a printer idle for a month has not
 * worn its rails, and one that ran around the clock for a week has. The hours come from
 * the print ledger — every print, whatever its outcome, since a stopped print still ran
 * the machine.
 *
 * ## The intervals are starting points, not specifications
 *
 * The defaults below are round numbers for a typical enclosed FDM printer, chosen here —
 * not figures from Elegoo, which publishes none this code has been able to check. They
 * are meant to be edited: abrasive filament wears a nozzle in a fraction of the time
 * PLA does, and a printer in a dusty room wants its fans cleaned sooner. The panel says
 * so beside them.
 *
 * ## "Never done" counts from the first recorded print
 *
 * A task with no `lastDoneAt` counts every hour in the ledger, which for a printer whose
 * history starts when it was new is exactly the hours since new. Marking it done starts
 * the count again.
 */

import type { LedgerEntry } from './ledger-core';

export interface MaintenanceTask {
  id: string;
  label: string;
  intervalHours: number;
  /** Epoch ms, or `null` for "not done since the first recorded print". */
  lastDoneAt: number | null;
}

export type TaskState = 'ok' | 'soon' | 'due';

export interface TaskStatus extends MaintenanceTask {
  hoursSince: number;
  /** hoursSince / intervalHours: 1 is due. */
  fraction: number;
  state: TaskState;
}

/** From here to the interval, a task reads "soon" rather than "ok". */
export const SOON_FRACTION = 0.8;

const MAX_INTERVAL_HOURS = 100_000;
const MAX_TASKS = 50;

export const DEFAULT_TASKS: MaintenanceTask[] = [
  { id: 'clean-plate', label: 'Clean the build plate', intervalHours: 25, lastDoneAt: null },
  { id: 'lube-rails', label: 'Lubricate the rails and rods', intervalHours: 200, lastDoneAt: null },
  { id: 'belts', label: 'Check belt tension', intervalHours: 200, lastDoneAt: null },
  { id: 'extruder', label: 'Clean the extruder gears', intervalHours: 250, lastDoneAt: null },
  { id: 'fans', label: 'Clean the fans and filters', intervalHours: 300, lastDoneAt: null },
  { id: 'nozzle', label: 'Inspect or replace the nozzle', intervalHours: 500, lastDoneAt: null },
];

/** Print hours in the ledger that ended after `since`; all of them when `since` is null. */
export function hoursSince(entries: readonly LedgerEntry[], since: number | null): number {
  let seconds = 0;
  for (const e of entries) {
    if (since === null || e.endedAt > since) seconds += e.seconds;
  }
  return Math.round((seconds / 3600) * 10) / 10;
}

export function taskStatus(task: MaintenanceTask, entries: readonly LedgerEntry[]): TaskStatus {
  const hours = hoursSince(entries, task.lastDoneAt);
  const fraction = task.intervalHours > 0 ? hours / task.intervalHours : 0;
  const state: TaskState = fraction >= 1 ? 'due' : fraction >= SOON_FRACTION ? 'soon' : 'ok';
  return { ...task, hoursSince: hours, fraction, state };
}

/** Most overdue first, so the thing that needs doing is at the top. */
export function taskStatuses(
  tasks: readonly MaintenanceTask[],
  entries: readonly LedgerEntry[],
): TaskStatus[] {
  return tasks.map((t) => taskStatus(t, entries)).sort((a, b) => b.fraction - a.fraction);
}

function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'task'
  );
}

/**
 * Accept a task list from disk or over HTTP.
 *
 * Drops anything malformed, clamps intervals to a sane range, and makes ids unique —
 * a duplicate id would make "mark done" ambiguous about which task it meant.
 */
export function normaliseTasks(raw: unknown): MaintenanceTask[] {
  if (!Array.isArray(raw)) return DEFAULT_TASKS.map((t) => ({ ...t }));
  const seen = new Set<string>();
  const out: MaintenanceTask[] = [];
  for (const item of raw.slice(0, MAX_TASKS)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const label = typeof r.label === 'string' ? r.label.trim().slice(0, 80) : '';
    const interval = Number(r.intervalHours);
    if (!label || !Number.isFinite(interval) || interval <= 0) continue;

    let id = typeof r.id === 'string' && r.id.trim() ? r.id.trim().slice(0, 40) : slug(label);
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);

    const done = Number(r.lastDoneAt);
    out.push({
      id,
      label,
      intervalHours: Math.min(MAX_INTERVAL_HOURS, Math.round(interval)),
      lastDoneAt: r.lastDoneAt !== null && Number.isFinite(done) && done > 0 ? done : null,
    });
  }
  return out;
}
