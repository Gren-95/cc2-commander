/**
 * Scheduled prints: start a chosen file at a chosen time, once, if the printer is free
 * to take it.
 *
 * ## Why "once", and why a skip rather than a retry
 *
 * A schedule that repeated the same file on its own is a machine that starts a job with
 * nobody watching the bed a second and third time; the first is already the part of this
 * feature worth being careful about. So a schedule fires at most once, and if the moment
 * arrives while the printer is busy, offline, or the file is gone, it is marked skipped
 * with why — never retried unattended, never silently dropped. `server/schedule.ts` owns
 * the clock, the MQTT command and the live file-list check this module cannot see; this
 * file is what stays true regardless of any of that: validation and "what is due now."
 */

export type ScheduleStatus = 'pending' | 'fired' | 'skipped' | 'cancelled';

export interface ScheduledPrint {
  id: string;
  /** Exactly what the printer's start-print command expects as `filename` — the full
   *  path, e.g. `benchy.gcode` or `misc/benchy.gcode`. */
  filename: string;
  /** The directory `filename` lives in, so the service can re-list it before firing
   *  rather than trust a listing that may be stale or scoped to a different folder. */
  dir: string;
  runAt: number;
  createdAt: number;
  status: ScheduleStatus;
  /** Why a `skipped` entry was skipped. `null` for anything else. */
  skipReason: string | null;
  /** When a `fired` entry actually started. `null` for anything else. */
  firedAt: number | null;
}

/** A generous ceiling, not a real limit anyone should reach — this is a to-do list of
 *  upcoming prints, not a queue meant to hold hundreds. */
export const MAX_SCHEDULES = 100;

/** More than a year out is almost certainly a typo (a year for a day), not intent — and
 *  a schedule that silently sits for that long is worse than one that failed to create. */
const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;

/** How long a `fired` or `skipped` entry stays in the list before `prune` drops it —
 *  enough to read what happened, not forever. */
export const HISTORY_MS = 7 * 24 * 60 * 60 * 1000;

function randomId(now: number): string {
  return `sched-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** What a POST body needs to become a new entry. `null` when it cannot. */
export function normaliseNewSchedule(
  raw: unknown,
  now: number,
): Pick<ScheduledPrint, 'filename' | 'dir' | 'runAt'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const filename = typeof r.filename === 'string' ? r.filename.trim().slice(0, 300) : '';
  const dir = typeof r.dir === 'string' ? r.dir.trim().slice(0, 300) : '';
  const runAt = Number(r.runAt);
  if (!filename || !Number.isFinite(runAt)) return null;
  if (runAt <= now || runAt - now > MAX_FUTURE_MS) return null;
  return { filename, dir, runAt };
}

/** Build a full entry from a validated `normaliseNewSchedule` result. */
export function createSchedule(
  input: Pick<ScheduledPrint, 'filename' | 'dir' | 'runAt'>,
  now: number,
): ScheduledPrint {
  return {
    id: randomId(now),
    ...input,
    createdAt: now,
    status: 'pending',
    skipReason: null,
    firedAt: null,
  };
}

const STATUSES: readonly ScheduleStatus[] = ['pending', 'fired', 'skipped', 'cancelled'];

/** Accept the list from disk, keeping only what is well-formed. */
export function normaliseStored(raw: unknown): ScheduledPrint[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ScheduledPrint[] = [];
  for (const item of raw.slice(0, MAX_SCHEDULES)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' && r.id ? r.id : null;
    const filename = typeof r.filename === 'string' ? r.filename : '';
    const runAt = Number(r.runAt);
    if (!id || seen.has(id) || !filename || !Number.isFinite(runAt)) continue;
    seen.add(id);
    const createdAt = Number(r.createdAt);
    const firedAt = Number(r.firedAt);
    out.push({
      id,
      filename,
      dir: typeof r.dir === 'string' ? r.dir : '',
      runAt,
      createdAt: Number.isFinite(createdAt) ? createdAt : runAt,
      status: STATUSES.includes(r.status as ScheduleStatus)
        ? (r.status as ScheduleStatus)
        : 'pending',
      skipReason: typeof r.skipReason === 'string' ? r.skipReason : null,
      firedAt: Number.isFinite(firedAt) && firedAt > 0 ? firedAt : null,
    });
  }
  return out;
}

/** Pending entries whose time has come. */
export function dueEntries(schedules: readonly ScheduledPrint[], now: number): ScheduledPrint[] {
  return schedules.filter((s) => s.status === 'pending' && s.runAt <= now);
}

/** Drops finished entries older than `HISTORY_MS`, so the list does not grow forever. */
export function pruneHistory(schedules: readonly ScheduledPrint[], now: number): ScheduledPrint[] {
  return schedules.filter(
    (s) => s.status === 'pending' || now - (s.firedAt ?? s.createdAt) < HISTORY_MS,
  );
}

/** Soonest first, so the list reads as a to-do list rather than a log. */
export function sortedSchedules(schedules: readonly ScheduledPrint[]): ScheduledPrint[] {
  return [...schedules].sort((a, b) => a.runAt - b.runAt);
}
