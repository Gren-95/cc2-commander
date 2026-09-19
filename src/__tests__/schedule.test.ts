/**
 * Scheduled prints' decisions.
 *
 * This is the other feature in the repo that commands the printer on a timer rather
 * than a click, so the tests here are weighted the same way `dryer.test.ts`'s are:
 * toward the properties that would actually matter if they broke — a schedule that
 * outlives its own moment, one created in the past, and what "due right now" and
 * "worth keeping in the list" mean.
 */

import { describe, expect, it } from 'bun:test';
import {
  createSchedule,
  dueEntries,
  HISTORY_MS,
  normaliseNewSchedule,
  normaliseStored,
  pruneHistory,
  sortedSchedules,
  spoolMismatch,
  startConfig,
  UNCHOSEN,
  type ChosenSpool,
  type PrintOptions,
} from '../schedule-core';
import type { CanvasInfo } from '../types';

const HOUR = 60 * 60 * 1000;
const now = 1_700_000_000_000;

describe('normaliseNewSchedule', () => {
  it('accepts a filename and a future time', () => {
    const r = normaliseNewSchedule({ filename: 'benchy.gcode', dir: '', runAt: now + HOUR }, now);
    expect(r).toEqual({ filename: 'benchy.gcode', dir: '', runAt: now + HOUR, options: null });
  });

  it('refuses a time in the past', () => {
    expect(normaliseNewSchedule({ filename: 'a.gcode', dir: '', runAt: now - 1 }, now)).toBeNull();
  });

  it('refuses right now — the whole point of the feature is "later"', () => {
    expect(normaliseNewSchedule({ filename: 'a.gcode', dir: '', runAt: now }, now)).toBeNull();
  });

  it('refuses more than a year out, a likely typo rather than intent', () => {
    const wayOut = now + 400 * 24 * HOUR;
    expect(normaliseNewSchedule({ filename: 'a.gcode', dir: '', runAt: wayOut }, now)).toBeNull();
  });

  it('refuses an empty filename', () => {
    expect(normaliseNewSchedule({ filename: '  ', dir: '', runAt: now + HOUR }, now)).toBeNull();
  });

  it('refuses a non-finite runAt', () => {
    expect(
      normaliseNewSchedule({ filename: 'a.gcode', dir: '', runAt: 'tomorrow' }, now),
    ).toBeNull();
  });

  it('defaults dir to empty rather than failing when it is missing', () => {
    const r = normaliseNewSchedule({ filename: 'a.gcode', runAt: now + HOUR }, now);
    expect(r?.dir).toBe('');
  });
});

describe('createSchedule', () => {
  it('starts pending, with no skip reason and no fired time', () => {
    const s = createSchedule(
      { filename: 'a.gcode', dir: '', runAt: now + HOUR, options: null },
      now,
    );
    expect(s.status).toBe('pending');
    expect(s.skipReason).toBeNull();
    expect(s.firedAt).toBeNull();
    expect(s.createdAt).toBe(now);
  });

  it('gives two schedules created at the same instant different ids', () => {
    const a = createSchedule(
      { filename: 'a.gcode', dir: '', runAt: now + HOUR, options: null },
      now,
    );
    const b = createSchedule(
      { filename: 'b.gcode', dir: '', runAt: now + HOUR, options: null },
      now,
    );
    expect(a.id).not.toBe(b.id);
  });
});

describe('dueEntries', () => {
  it('is due exactly at runAt, not only strictly after it', () => {
    const s = createSchedule({ filename: 'a.gcode', dir: '', runAt: now, options: null }, now - 1);
    expect(dueEntries([s], now)).toEqual([s]);
  });

  it('leaves a future schedule alone', () => {
    const s = createSchedule(
      { filename: 'a.gcode', dir: '', runAt: now + HOUR, options: null },
      now,
    );
    expect(dueEntries([s], now)).toEqual([]);
  });

  it('never reconsiders anything already fired, skipped or cancelled — the whole', () => {
    // point of "fires at most once": being due again is not the same as firing again.
    const base = createSchedule(
      { filename: 'a.gcode', dir: '', runAt: now - 1, options: null },
      now - HOUR,
    );
    for (const status of ['fired', 'skipped', 'cancelled'] as const) {
      expect(dueEntries([{ ...base, status }], now)).toEqual([]);
    }
  });
});

describe('pruneHistory', () => {
  it('keeps a pending schedule no matter how old', () => {
    const s = createSchedule(
      { filename: 'a.gcode', dir: '', runAt: now, options: null },
      now - 365 * 24 * HOUR,
    );
    expect(pruneHistory([s], now)).toEqual([s]);
  });

  it('drops a fired schedule once past HISTORY_MS', () => {
    const s = {
      ...createSchedule(
        { filename: 'a.gcode', dir: '', runAt: now, options: null },
        now - HISTORY_MS - 1,
      ),
      status: 'fired' as const,
      firedAt: now - HISTORY_MS - 1,
    };
    expect(pruneHistory([s], now)).toEqual([]);
  });

  it('keeps a recently fired schedule', () => {
    const s = {
      ...createSchedule({ filename: 'a.gcode', dir: '', runAt: now, options: null }, now - HOUR),
      status: 'fired' as const,
      firedAt: now - HOUR,
    };
    expect(pruneHistory([s], now)).toEqual([s]);
  });
});

describe('sortedSchedules', () => {
  it('orders soonest first', () => {
    const late = createSchedule(
      { filename: 'late.gcode', dir: '', runAt: now + 2 * HOUR, options: null },
      now,
    );
    const soon = createSchedule(
      { filename: 'soon.gcode', dir: '', runAt: now + HOUR, options: null },
      now,
    );
    expect(sortedSchedules([late, soon]).map((s) => s.filename)).toEqual([
      'soon.gcode',
      'late.gcode',
    ]);
  });
});

describe('normaliseStored', () => {
  it('round-trips a well-formed list', () => {
    const s = createSchedule(
      { filename: 'a.gcode', dir: 'sub', runAt: now + HOUR, options: null },
      now,
    );
    expect(normaliseStored([s])).toEqual([s]);
  });

  it('is empty for anything that is not an array', () => {
    expect(normaliseStored(null)).toEqual([]);
    expect(normaliseStored({})).toEqual([]);
    expect(normaliseStored('nope')).toEqual([]);
  });

  it('drops an entry missing an id, a filename or a real runAt', () => {
    expect(
      normaliseStored([
        { filename: 'a.gcode', runAt: now },
        { id: 'x', runAt: now },
        { id: 'y', filename: 'b.gcode', runAt: 'never' },
      ]),
    ).toEqual([]);
  });

  it('drops a duplicate id rather than keeping two entries claiming the same schedule', () => {
    const out = normaliseStored([
      { id: 'x', filename: 'a.gcode', runAt: now },
      { id: 'x', filename: 'b.gcode', runAt: now },
    ]);
    expect(out.length).toBe(1);
    expect(out[0].filename).toBe('a.gcode');
  });

  it('falls back to pending for an unrecognised status, never inventing one of its own', () => {
    const out = normaliseStored([{ id: 'x', filename: 'a.gcode', runAt: now, status: 'exploded' }]);
    expect(out[0].status).toBe('pending');
  });
});

/* ── The settings a schedule carries ───────────────────────────────── */

const red: ChosenSpool = {
  t: 0,
  canvas_id: 0,
  tray_id: 1,
  filament_type: 'PLA',
  filament_color: 'FF0000',
};
const blue: ChosenSpool = {
  t: 1,
  canvas_id: 0,
  tray_id: 3,
  filament_type: 'PETG',
  filament_color: '1E40AF',
};

const options = (over: Record<string, unknown> = {}): PrintOptions =>
  ({
    bedType: 'B',
    timelapse: false,
    bedLeveling: true,
    autoRefill: true,
    spools: [red, blue],
    ...over,
  }) as PrintOptions;

const body = (o: unknown) => ({ filename: 'a.gcode', dir: '', runAt: now + HOUR, options: o });

describe('normaliseNewSchedule with options', () => {
  it('keeps what the dialog chose', () => {
    expect(normaliseNewSchedule(body(options()), now)?.options).toEqual(options());
  });

  it('treats no options as no options, not an error', () => {
    expect(normaliseNewSchedule(body(null), now)?.options).toBeNull();
    expect(normaliseNewSchedule(body(undefined), now)?.options).toBeNull();
  });

  it('normalises a colour to one spelling, so #ff0000 and FF0000 compare equal later', () => {
    const r = normaliseNewSchedule(
      body(options({ spools: [{ ...red, filament_color: '#ff0000' }] })),
      now,
    );
    expect(r?.options?.spools[0].filament_color).toBe('FF0000');
  });

  it('accepts a file that needs no mapping', () => {
    const r = normaliseNewSchedule(body(options({ spools: [], autoRefill: null })), now);
    expect(r?.options?.spools).toEqual([]);
  });

  // What an unattended job is started with is never repaired into a guess: anything
  // malformed refuses the whole request.
  it.each([
    ['an unknown plate', { bedType: 'C' }],
    ['a non-boolean timelapse', { timelapse: 'yes' }],
    ['a non-boolean bed leveling', { bedLeveling: 1 }],
    ['an auto-refill that is neither a boolean nor null', { autoRefill: 'on' }],
    ['spools that are not a list', { spools: 'all' }],
    ['a spool that is not an object', { spools: [7] }],
    ['a negative tray', { spools: [{ ...red, tray_id: -1 }] }],
    ['a fractional canvas', { spools: [{ ...red, canvas_id: 0.5 }] }],
    ['a spool with no filament type', { spools: [{ ...red, filament_type: '' }] }],
    ['two spools for one colour', { spools: [red, { ...blue, t: 0 }] }],
    [
      'more spools than any Canvas has trays',
      { spools: Array.from({ length: 17 }, (_, t) => ({ ...red, t })) },
    ],
  ])('refuses %s', (_label, over) => {
    expect(normaliseNewSchedule(body(options(over)), now)).toBeNull();
  });

  it('refuses options that are not an object', () => {
    expect(normaliseNewSchedule(body('A'), now)).toBeNull();
  });
});

describe('normaliseStored with options', () => {
  const stored = (over: Record<string, unknown>) => [
    { id: 's1', filename: 'a.gcode', dir: '', runAt: now + HOUR, status: 'pending', ...over },
  ];

  it('reads a schedule saved before options existed as one with none, still pending', () => {
    const [s] = normaliseStored(stored({}));
    expect(s.options).toBeNull();
    expect(s.status).toBe('pending');
  });

  it('keeps saved options', () => {
    expect(normaliseStored(stored({ options: options() }))[0].options).toEqual(options());
  });

  it('skips, and says why, a pending schedule whose saved options cannot be read', () => {
    // Starting it with the defaults would be guessing at what the user chose.
    const [s] = normaliseStored(stored({ options: { bedType: 'C' } }));
    expect(s.status).toBe('skipped');
    expect(s.skipReason).toBe('Its saved print settings could not be read');
  });

  it('leaves an already finished schedule with unreadable options as it was', () => {
    const [s] = normaliseStored(stored({ status: 'fired', options: { bedType: 'C' } }));
    expect(s.status).toBe('fired');
  });
});

describe('startConfig', () => {
  it('starts a schedule with no options exactly as schedules always have', () => {
    // Pinned: this is what every schedule typed into Tools -> Schedule sends.
    expect(startConfig(null)).toEqual({
      delay_video: true,
      printer_check: false,
      print_layout: 'A',
      bedlevel_force: false,
      slot_map: [],
    });
    expect(startConfig(UNCHOSEN)).toEqual(startConfig(null));
  });

  it('sends the plate, timelapse and leveling that were chosen', () => {
    const c = startConfig(options());
    expect(c.print_layout).toBe('B');
    expect(c.delay_video).toBe(false);
    expect(c.printer_check).toBe(true);
  });

  it('sends where each colour goes, and nothing about what the tray held', () => {
    expect(startConfig(options()).slot_map).toEqual([
      { t: 0, canvas_id: 0, tray_id: 1 },
      { t: 1, canvas_id: 0, tray_id: 3 },
    ]);
  });
});

describe('spoolMismatch', () => {
  const tray = (tray_id: number, over: Record<string, unknown> = {}) => ({
    tray_id,
    brand: '',
    filament_type: 'PLA',
    filament_name: 'PLA',
    filament_color: '#FF0000',
    min_nozzle_temp: 190,
    max_nozzle_temp: 230,
    status: 1,
    ...over,
  });
  const canvas = (trays: unknown[], connected = 1): CanvasInfo =>
    ({
      active_canvas_id: 0,
      active_tray_id: 0,
      auto_refill: false,
      canvas_list: [{ canvas_id: 0, connected, tray_list: trays }],
    }) as unknown as CanvasInfo;

  const matching = canvas([tray(1), tray(3, { filament_type: 'PETG', filament_color: '#1E40AF' })]);

  it('has nothing to check for a schedule with no mapping — even with no Canvas at all', () => {
    expect(spoolMismatch([], null)).toBeNull();
  });

  it('passes when every chosen spool still holds what was chosen', () => {
    expect(spoolMismatch([red, blue], matching)).toBeNull();
  });

  it('compares colours as colours, not as spellings', () => {
    expect(spoolMismatch([red], canvas([tray(1, { filament_color: 'ff0000' })]))).toBeNull();
  });

  it('refuses to guess when the Canvas state is not known', () => {
    expect(spoolMismatch([red], null)).toMatch(/not known/);
    expect(spoolMismatch([red], { canvas_list: [] } as unknown as CanvasInfo)).toMatch(/not known/);
  });

  it('names a Canvas that is not connected', () => {
    expect(spoolMismatch([red], canvas([tray(1)], 0))).toBe('Canvas 1 is not connected');
  });

  it('names a spool that has run out', () => {
    expect(spoolMismatch([red], canvas([tray(1, { status: 0 })]))).toBe(
      'The spool in C1:T2 is empty',
    );
  });

  it('names a tray that is not there at all', () => {
    expect(spoolMismatch([red], canvas([tray(0)]))).toBe('The spool in C1:T2 is empty');
  });

  it('catches a spool swapped for another colour, and says what changed', () => {
    const why = spoolMismatch([red], canvas([tray(1, { filament_color: '#0000FF' })]));
    expect(why).toContain('C1:T2');
    expect(why).toContain('was PLA #FF0000, now PLA #0000FF');
  });

  it('catches the same colour in a different filament', () => {
    expect(spoolMismatch([red], canvas([tray(1, { filament_type: 'PETG' })]))).toContain(
      'now PETG',
    );
  });

  it('fails if any one of several spools is wrong', () => {
    const swapped = canvas([tray(1), tray(3, { filament_type: 'PLA', filament_color: '#1E40AF' })]);
    expect(spoolMismatch([red, blue], swapped)).toContain('C1:T4');
  });
});
