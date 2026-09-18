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
} from '../schedule-core';

const HOUR = 60 * 60 * 1000;
const now = 1_700_000_000_000;

describe('normaliseNewSchedule', () => {
  it('accepts a filename and a future time', () => {
    const r = normaliseNewSchedule({ filename: 'benchy.gcode', dir: '', runAt: now + HOUR }, now);
    expect(r).toEqual({ filename: 'benchy.gcode', dir: '', runAt: now + HOUR });
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
    const s = createSchedule({ filename: 'a.gcode', dir: '', runAt: now + HOUR }, now);
    expect(s.status).toBe('pending');
    expect(s.skipReason).toBeNull();
    expect(s.firedAt).toBeNull();
    expect(s.createdAt).toBe(now);
  });

  it('gives two schedules created at the same instant different ids', () => {
    const a = createSchedule({ filename: 'a.gcode', dir: '', runAt: now + HOUR }, now);
    const b = createSchedule({ filename: 'b.gcode', dir: '', runAt: now + HOUR }, now);
    expect(a.id).not.toBe(b.id);
  });
});

describe('dueEntries', () => {
  it('is due exactly at runAt, not only strictly after it', () => {
    const s = createSchedule({ filename: 'a.gcode', dir: '', runAt: now }, now - 1);
    expect(dueEntries([s], now)).toEqual([s]);
  });

  it('leaves a future schedule alone', () => {
    const s = createSchedule({ filename: 'a.gcode', dir: '', runAt: now + HOUR }, now);
    expect(dueEntries([s], now)).toEqual([]);
  });

  it('never reconsiders anything already fired, skipped or cancelled — the whole', () => {
    // point of "fires at most once": being due again is not the same as firing again.
    const base = createSchedule({ filename: 'a.gcode', dir: '', runAt: now - 1 }, now - HOUR);
    for (const status of ['fired', 'skipped', 'cancelled'] as const) {
      expect(dueEntries([{ ...base, status }], now)).toEqual([]);
    }
  });
});

describe('pruneHistory', () => {
  it('keeps a pending schedule no matter how old', () => {
    const s = createSchedule({ filename: 'a.gcode', dir: '', runAt: now }, now - 365 * 24 * HOUR);
    expect(pruneHistory([s], now)).toEqual([s]);
  });

  it('drops a fired schedule once past HISTORY_MS', () => {
    const s = {
      ...createSchedule({ filename: 'a.gcode', dir: '', runAt: now }, now - HISTORY_MS - 1),
      status: 'fired' as const,
      firedAt: now - HISTORY_MS - 1,
    };
    expect(pruneHistory([s], now)).toEqual([]);
  });

  it('keeps a recently fired schedule', () => {
    const s = {
      ...createSchedule({ filename: 'a.gcode', dir: '', runAt: now }, now - HOUR),
      status: 'fired' as const,
      firedAt: now - HOUR,
    };
    expect(pruneHistory([s], now)).toEqual([s]);
  });
});

describe('sortedSchedules', () => {
  it('orders soonest first', () => {
    const late = createSchedule({ filename: 'late.gcode', dir: '', runAt: now + 2 * HOUR }, now);
    const soon = createSchedule({ filename: 'soon.gcode', dir: '', runAt: now + HOUR }, now);
    expect(sortedSchedules([late, soon]).map((s) => s.filename)).toEqual([
      'soon.gcode',
      'late.gcode',
    ]);
  });
});

describe('normaliseStored', () => {
  it('round-trips a well-formed list', () => {
    const s = createSchedule({ filename: 'a.gcode', dir: 'sub', runAt: now + HOUR }, now);
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
