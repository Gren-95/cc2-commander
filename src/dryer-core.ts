/**
 * Filament dryer — the pure half.
 *
 * Drying is done on the printer's own heated bed with the lid closed: the bed is held
 * a little below the filament's glass transition for a few hours, which drives moisture
 * out without softening the coil. That makes this a feature that **heats a real
 * machine**, so the numbers and the guards below are the load-bearing part; the panel
 * that draws it is in `dryer-panel.ts`.
 *
 * Free of DOM and storage so the schedule maths and the clamps can be tested directly
 * (the vitest environment here is `node`).
 *
 * ## The two hazards this file exists to contain
 *
 * 1. **Too hot deforms the spool before it dries the filament.** Every temperature here
 *    sits under the material's glass transition, and `MAX_SAFE_C` is a hard ceiling on
 *    anything a user types. A plastic spool starts to sag around 55 °C, which is why
 *    materials above that carry `spoolWarning`.
 * 2. **The timer lives in a browser tab.** Nothing on the printer knows a drying session
 *    is running, so if the tab goes away the bed stays hot. The session is therefore
 *    persisted with an absolute `startedAt`, `hasExpired` can be answered by a tab that
 *    reopens hours later, and the panel shuts the heater off when it sees that.
 */

export interface DryingPreset {
  /** Stable id, stored in the session. */
  id: string;
  label: string;
  /** Bed temperature to hold, °C. */
  tempC: number;
  /** How long to hold it, minutes. */
  minutes: number;
  /** True when the temperature is high enough to soften a plastic spool. */
  spoolWarning?: boolean;
  note: string;
}

/**
 * A hard ceiling, applied to presets and to anything typed by hand.
 *
 * 80 °C is already above every preset here. The point is not to pick the best drying
 * temperature — it is that no combination of typing and rounding can ask the bed for
 * something that would melt a spool onto it.
 */
export const MAX_SAFE_C = 80;

/** Below this, nothing useful is being driven off; used to reject a pointless session. */
export const MIN_USEFUL_C = 35;

/** Longest session that can be started in one go. */
export const MAX_MINUTES = 24 * 60;

/**
 * Conservative bed temperatures and times.
 *
 * Each sits ~10–15 °C under the material's glass transition — hot enough to move water,
 * cool enough to leave the coil rigid. Times are for a spool that is damp rather than
 * soaked; a badly wet spool wants a second session rather than a hotter one.
 */
export const DRYING_PRESETS: DryingPreset[] = [
  {
    id: 'pla',
    label: 'PLA',
    tempC: 45,
    minutes: 240,
    note: 'Tg ≈ 60 °C. Keep it cool; PLA slumps easily.',
  },
  {
    id: 'pla-cf',
    label: 'PLA (wood / CF)',
    tempC: 45,
    minutes: 300,
    note: 'Filled PLA holds more water than plain.',
  },
  { id: 'petg', label: 'PETG', tempC: 65, minutes: 240, spoolWarning: true, note: 'Tg ≈ 80 °C.' },
  {
    id: 'tpu',
    label: 'TPU',
    tempC: 50,
    minutes: 300,
    note: 'Absorbs fast. Dry it before every long print.',
  },
  {
    id: 'abs',
    label: 'ABS / ASA',
    tempC: 70,
    minutes: 240,
    spoolWarning: true,
    note: 'Tg ≈ 105 °C.',
  },
  {
    id: 'pa',
    label: 'Nylon (PA)',
    tempC: 75,
    minutes: 480,
    spoolWarning: true,
    note: 'Very hygroscopic; 8 h is a minimum.',
  },
  {
    id: 'pc',
    label: 'Polycarbonate',
    tempC: 75,
    minutes: 360,
    spoolWarning: true,
    note: 'Tg ≈ 147 °C.',
  },
  {
    id: 'pva',
    label: 'PVA / BVOH',
    tempC: 45,
    minutes: 360,
    note: 'Water-soluble. Never leave it out of a dry box.',
  },
];

export function presetById(id: string): DryingPreset | undefined {
  return DRYING_PRESETS.find((p) => p.id === id);
}

/** A session in progress. Times are absolute so a reopened tab can resolve them. */
export interface DryerSession {
  presetId: string;
  /** The label at the time of starting, kept so a renamed preset still reads sensibly. */
  label: string;
  tempC: number;
  totalMinutes: number;
  /** Epoch ms. Absolute, not a duration, so a closed tab does not pause the clock. */
  startedAt: number;
  /** Minutes between rotation reminders; 0 disables them. */
  rotateEveryMin: number;
  /** How many rotation reminders the user has acknowledged. */
  rotationsDone: number;
}

/**
 * Clamp anything a user can type into the range the bed may be asked for.
 *
 * A non-finite input falls to the FLOOR, not the ceiling: it means the caller has lost
 * track of what it is asking for, and the safe answer to that on a heater is the
 * coldest useful setting.
 */
export function clampTemp(c: number): number {
  if (!Number.isFinite(c)) return MIN_USEFUL_C;
  return Math.min(MAX_SAFE_C, Math.max(MIN_USEFUL_C, Math.round(c)));
}

export function clampMinutes(m: number): number {
  if (!Number.isFinite(m)) return 60;
  return Math.min(MAX_MINUTES, Math.max(1, Math.round(m)));
}

/** Build a session from a preset, with both values clamped on the way in. */
export function sessionFromPreset(
  preset: DryingPreset,
  now: number,
  rotateEveryMin = 60,
): DryerSession {
  return {
    presetId: preset.id,
    label: preset.label,
    tempC: clampTemp(preset.tempC),
    totalMinutes: clampMinutes(preset.minutes),
    startedAt: now,
    rotateEveryMin: Math.max(0, Math.round(rotateEveryMin)),
    rotationsDone: 0,
  };
}

export interface DryerProgress {
  elapsedMin: number;
  remainingMin: number;
  /** 0..1, clamped — a session that overran still reports 1 rather than >1. */
  fraction: number;
  done: boolean;
  /** Minutes until the next rotation reminder, or null when rotation is off/finished. */
  nextRotationInMin: number | null;
  /** How many reminders are owed but not yet acknowledged. */
  rotationsDue: number;
}

/**
 * Where a session has got to.
 *
 * `now` is passed in rather than read from the clock so the caller — and the tests —
 * decide what time it is.
 */
export function progressOf(session: DryerSession, now: number): DryerProgress {
  const elapsedMin = Math.max(0, (now - session.startedAt) / 60_000);
  const remainingMin = Math.max(0, session.totalMinutes - elapsedMin);
  const done = remainingMin <= 0;
  const fraction = session.totalMinutes > 0 ? Math.min(1, elapsedMin / session.totalMinutes) : 1;

  let nextRotationInMin: number | null = null;
  let rotationsDue = 0;
  if (session.rotateEveryMin > 0) {
    // How many reminders the elapsed time has earned, capped at the session length so a
    // finished session does not keep asking for rotations.
    const earned = Math.floor(Math.min(elapsedMin, session.totalMinutes) / session.rotateEveryMin);
    rotationsDue = Math.max(0, earned - session.rotationsDone);
    if (!done) {
      const nextAt = (session.rotationsDone + rotationsDue + 1) * session.rotateEveryMin;
      // Only offer a next rotation if it lands before the session ends.
      nextRotationInMin = nextAt < session.totalMinutes ? Math.max(0, nextAt - elapsedMin) : null;
    }
  }

  return { elapsedMin, remainingMin, fraction, done, nextRotationInMin, rotationsDue };
}

/** True when a stored session's end time has already passed — the reopened-tab case. */
export function hasExpired(session: DryerSession, now: number): boolean {
  return progressOf(session, now).done;
}

/** `4h 05m`, or `45m` under an hour. For a countdown, so it never shows seconds. */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.ceil(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** When a session will finish, as a local clock time. */
export function finishesAt(session: DryerSession): Date {
  return new Date(session.startedAt + session.totalMinutes * 60_000);
}

/** Shapes a stored value into a session, or null if it is not one. */
export function normaliseSession(value: unknown): DryerSession | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const startedAt = typeof v.startedAt === 'number' ? v.startedAt : NaN;
  const tempC = typeof v.tempC === 'number' ? v.tempC : NaN;
  const totalMinutes = typeof v.totalMinutes === 'number' ? v.totalMinutes : NaN;
  if (!Number.isFinite(startedAt) || !Number.isFinite(tempC) || !Number.isFinite(totalMinutes)) {
    return null;
  }
  return {
    presetId: typeof v.presetId === 'string' ? v.presetId : 'custom',
    label: typeof v.label === 'string' ? v.label : 'Filament',
    // Re-clamped on the way out: a hand-edited localStorage entry must not be able to
    // ask the bed for 300 °C when the page resumes it.
    tempC: clampTemp(tempC),
    totalMinutes: clampMinutes(totalMinutes),
    startedAt,
    rotateEveryMin:
      typeof v.rotateEveryMin === 'number' && Number.isFinite(v.rotateEveryMin)
        ? Math.max(0, Math.round(v.rotateEveryMin))
        : 60,
    rotationsDone:
      typeof v.rotationsDone === 'number' && Number.isFinite(v.rotationsDone)
        ? Math.max(0, Math.round(v.rotationsDone))
        : 0,
  };
}
