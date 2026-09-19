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
 * with why: never retried unattended, never silently dropped. `server/schedule.ts` owns
 * the clock, the MQTT command and the live file-list check this module cannot see; this
 * file is what stays true regardless of any of that: validation and "what is due now."
 *
 * ## The settings travel with the schedule
 *
 * A schedule made from the Start Print dialog keeps what that dialog collected (build
 * plate, timelapse, bed leveling, Canvas auto-refill and which spool prints which
 * colour) and starts the job with exactly those. The one thing that can go stale between
 * choosing and firing is the spools: someone changes a reel overnight and "tray 2, red
 * PLA" is now blue PETG. So each chosen spool is saved with what the tray held at the
 * time, and `spoolMismatch` is asked at the moment of firing; a schedule whose spools are
 * no longer what was chosen is skipped with the reason, never run in the wrong filament.
 */

import type { CanvasInfo } from './types';

export type ScheduleStatus = 'pending' | 'fired' | 'skipped' | 'cancelled';

/** One colour in the file, and the spool chosen to print it. */
export interface ChosenSpool {
  /** Index in the file's colour list: the `t` the start command wants. */
  t: number;
  canvas_id: number;
  tray_id: number;
  /** What that tray held when this was chosen. Compared again when the schedule fires. */
  filament_type: string;
  filament_color: string;
}

/** Everything the Start Print dialog collects, as the schedule keeps it. */
export interface PrintOptions {
  /** `A` textured, `B` smooth. */
  bedType: 'A' | 'B';
  timelapse: boolean;
  bedLeveling: boolean;
  /** Canvas auto-refill as chosen, or `null` when the dialog offered no such choice. */
  autoRefill: boolean | null;
  /** Empty for a file that needs no mapping. */
  spools: ChosenSpool[];
}

/**
 * What a schedule made with no options (typed into Tools → Schedule) has always
 * started with. Named rather than scattered, so "no options chosen" and the payload it
 * sends cannot drift apart.
 */
export const UNCHOSEN: PrintOptions = {
  bedType: 'A',
  timelapse: true,
  bedLeveling: false,
  autoRefill: null,
  spools: [],
};

export interface ScheduledPrint {
  id: string;
  /** Exactly what the printer's start-print command expects as `filename`, the full
   *  path, e.g. `benchy.gcode` or `misc/benchy.gcode`. */
  filename: string;
  /** The directory `filename` lives in, so the service can re-list it before firing
   *  rather than trust a listing that may be stale or scoped to a different folder. */
  dir: string;
  runAt: number;
  /** What to start it with, or `null` for a schedule made with none, see `UNCHOSEN`. */
  options: PrintOptions | null;
  createdAt: number;
  status: ScheduleStatus;
  /** Why a `skipped` entry was skipped. `null` for anything else. */
  skipReason: string | null;
  /** When a `fired` entry actually started. `null` for anything else. */
  firedAt: number | null;
}

/** A generous ceiling, not a real limit anyone should reach: this is a to-do list of
 *  upcoming prints, not a queue meant to hold hundreds. */
export const MAX_SCHEDULES = 100;

/** More than a year out is almost certainly a typo (a year for a day), not intent, and
 *  a schedule that silently sits for that long is worse than one that failed to create. */
const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;

/** How long a `fired` or `skipped` entry stays in the list before `prune` drops it:
 *  enough to read what happened, not forever. */
export const HISTORY_MS = 7 * 24 * 60 * 60 * 1000;

function randomId(now: number): string {
  return `sched-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** More spools than a Canvas has trays: a body past this is not a mapping. */
const MAX_SPOOLS = 16;

const isIndex = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255;
const isLabel = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 32;

/** `#ff0000`, `FF0000` and `#FF0000` are one colour. */
export function normaliseColor(color: string): string {
  return color.trim().replace(/^#/, '').toUpperCase();
}

/**
 * Validate a schedule's options. `undefined` for anything malformed: never a repaired
 * guess, because what this describes is what an unattended job will be started with.
 * `null` in, `null` out: no options chosen is a real answer, not an error.
 */
export function normaliseOptions(raw: unknown): PrintOptions | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.bedType !== 'A' && r.bedType !== 'B') return undefined;
  if (typeof r.timelapse !== 'boolean' || typeof r.bedLeveling !== 'boolean') return undefined;
  if (r.autoRefill !== null && typeof r.autoRefill !== 'boolean') return undefined;
  if (!Array.isArray(r.spools) || r.spools.length > MAX_SPOOLS) return undefined;

  const spools: ChosenSpool[] = [];
  const seen = new Set<number>();
  for (const item of r.spools) {
    if (!item || typeof item !== 'object') return undefined;
    const s = item as Record<string, unknown>;
    if (!isIndex(s.t) || !isIndex(s.canvas_id) || !isIndex(s.tray_id)) return undefined;
    if (!isLabel(s.filament_type) || !isLabel(s.filament_color)) return undefined;
    if (seen.has(s.t)) return undefined; // one spool per colour
    seen.add(s.t);
    spools.push({
      t: s.t,
      canvas_id: s.canvas_id,
      tray_id: s.tray_id,
      filament_type: s.filament_type.trim(),
      filament_color: normaliseColor(s.filament_color),
    });
  }
  return {
    bedType: r.bedType,
    timelapse: r.timelapse,
    bedLeveling: r.bedLeveling,
    autoRefill: r.autoRefill as boolean | null,
    spools,
  };
}

/** What a POST body needs to become a new entry. `null` when it cannot. */
export function normaliseNewSchedule(
  raw: unknown,
  now: number,
): Pick<ScheduledPrint, 'filename' | 'dir' | 'runAt' | 'options'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const filename = typeof r.filename === 'string' ? r.filename.trim().slice(0, 300) : '';
  const dir = typeof r.dir === 'string' ? r.dir.trim().slice(0, 300) : '';
  const runAt = Number(r.runAt);
  if (!filename || !Number.isFinite(runAt)) return null;
  if (runAt <= now || runAt - now > MAX_FUTURE_MS) return null;
  const options = normaliseOptions(r.options);
  if (options === undefined) return null;
  return { filename, dir, runAt, options };
}

/** Build a full entry from a validated `normaliseNewSchedule` result. */
export function createSchedule(
  input: Pick<ScheduledPrint, 'filename' | 'dir' | 'runAt' | 'options'>,
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
    let status = STATUSES.includes(r.status as ScheduleStatus)
      ? (r.status as ScheduleStatus)
      : 'pending';
    let skipReason = typeof r.skipReason === 'string' ? r.skipReason : null;
    // A schedule saved before options existed has none, that is `null`, and it starts as
    // it always did. One whose options are present but unreadable is not the same thing:
    // starting it with the defaults would be guessing at what the user chose, so it is
    // skipped, and says why.
    let options = normaliseOptions(r.options);
    if (options === undefined) {
      options = null;
      if (status === 'pending') {
        status = 'skipped';
        skipReason = 'Its saved print settings could not be read';
      }
    }
    out.push({
      id,
      filename,
      dir: typeof r.dir === 'string' ? r.dir : '',
      runAt,
      options,
      createdAt: Number.isFinite(createdAt) ? createdAt : runAt,
      status,
      skipReason,
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

/** `C1:T2`, the way the print dialog labels a tray. */
const trayLabel = (canvasId: number, trayId: number) => `C${canvasId + 1}:T${trayId + 1}`;

/**
 * Why the chosen spools cannot be trusted right now, or `null` when every one is still
 * what was chosen. Called by the service at the moment a schedule fires, against the live
 * Canvas state: an unknown state is a reason too, because "could not check" is not "fine".
 */
export function spoolMismatch(
  spools: readonly ChosenSpool[],
  canvas: CanvasInfo | null,
): string | null {
  if (!spools.length) return null;
  if (!canvas?.canvas_list?.length) {
    return 'The Canvas state is not known, so the chosen spools could not be confirmed';
  }
  for (const want of spools) {
    const label = trayLabel(want.canvas_id, want.tray_id);
    const unit = canvas.canvas_list.find((u) => u.canvas_id === want.canvas_id);
    if (!unit?.connected) return `Canvas ${want.canvas_id + 1} is not connected`;
    const tray = unit.tray_list?.find((t) => t.tray_id === want.tray_id);
    if (!tray || tray.status === 0) return `The spool in ${label} is empty`;
    const heldType = tray.filament_type ?? '';
    const heldColor = normaliseColor(tray.filament_color ?? '');
    if (heldType !== want.filament_type || heldColor !== want.filament_color) {
      return `The spool in ${label} is no longer the one chosen (was ${want.filament_type} #${want.filament_color}, now ${heldType} #${heldColor})`;
    }
  }
  return null;
}

/** The `config` half of a `1020`, from a schedule's options. */
export function startConfig(options: PrintOptions | null) {
  const o = options ?? UNCHOSEN;
  return {
    delay_video: o.timelapse,
    printer_check: o.bedLeveling,
    print_layout: o.bedType,
    bedlevel_force: false,
    // Only where each colour goes. What the tray held is for the check, not the printer.
    slot_map: o.spools.map(({ t, canvas_id, tray_id }) => ({ t, canvas_id, tray_id })),
  };
}
