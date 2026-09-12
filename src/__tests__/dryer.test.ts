/**
 * The filament dryer's decisions.
 *
 * This is the one feature in the repo that asks the printer to HEAT on a timer, so the
 * tests here are weighted towards the two things that would actually cause damage: a
 * temperature the spool cannot survive, and a session whose clock is wrong because the
 * tab was closed for part of it.
 */

import { describe, expect, it } from 'vitest';
import {
  clampMinutes,
  clampTemp,
  DRYING_PRESETS,
  type DryerSession,
  finishesAt,
  formatDuration,
  hasExpired,
  MAX_MINUTES,
  MAX_SAFE_C,
  MIN_USEFUL_C,
  normaliseSession,
  presetById,
  progressOf,
  sessionFromPreset,
} from '../ui/dryer';

const MIN = 60_000;
const session = (over: Partial<DryerSession> = {}): DryerSession => ({
  presetId: 'pla',
  label: 'PLA',
  tempC: 45,
  totalMinutes: 240,
  startedAt: 0,
  rotateEveryMin: 60,
  rotationsDone: 0,
  ...over,
});

describe('presets', () => {
  it('never exceeds the hard ceiling', () => {
    for (const p of DRYING_PRESETS) {
      expect(p.tempC, `${p.label} is above MAX_SAFE_C`).toBeLessThanOrEqual(MAX_SAFE_C);
    }
  });

  it('flags every preset hot enough to soften a plastic spool', () => {
    // 55 °C is roughly where a PLA spool starts to sag. Anything at or above it has to
    // say so, because the damage is to the spool rather than the filament.
    for (const p of DRYING_PRESETS) {
      if (p.tempC >= 55) expect(p.spoolWarning, `${p.label} needs spoolWarning`).toBe(true);
    }
  });

  it('has unique ids, since the session stores one', () => {
    const ids = DRYING_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('looks a preset up by id', () => {
    expect(presetById('petg')?.label).toBe('PETG');
    expect(presetById('nope')).toBeUndefined();
  });
});

describe('clamping', () => {
  it('refuses a temperature above the ceiling', () => {
    expect(clampTemp(250)).toBe(MAX_SAFE_C);
  });

  it('refuses a pointless one below the floor', () => {
    expect(clampTemp(5)).toBe(MIN_USEFUL_C);
  });

  it('fails COLD on nonsense, rather than passing NaN to a heater', () => {
    // Both of these fall to the floor, not the ceiling. A non-finite input means the
    // caller has lost track of what it is asking for, and the safe response to that is
    // the coldest useful setting — never the hottest.
    expect(clampTemp(Number.NaN)).toBe(MIN_USEFUL_C);
    expect(clampTemp(Number.POSITIVE_INFINITY)).toBe(MIN_USEFUL_C);
    expect(clampMinutes(Number.NaN)).toBe(60);
  });

  it('caps the session length', () => {
    expect(clampMinutes(99999)).toBe(MAX_MINUTES);
    expect(clampMinutes(0)).toBe(1);
  });
});

describe('sessionFromPreset', () => {
  it('clamps on the way in, so a bad preset cannot start a bad session', () => {
    const s = sessionFromPreset({ id: 'x', label: 'X', tempC: 999, minutes: 999999, note: '' }, 0);
    expect(s.tempC).toBe(MAX_SAFE_C);
    expect(s.totalMinutes).toBe(MAX_MINUTES);
  });
});

describe('progressOf', () => {
  it('reports elapsed, remaining and fraction', () => {
    const p = progressOf(session(), 60 * MIN);
    expect(p.elapsedMin).toBe(60);
    expect(p.remainingMin).toBe(180);
    expect(p.fraction).toBeCloseTo(0.25);
    expect(p.done).toBe(false);
  });

  it('does not report a fraction above 1 when a session overran', () => {
    // The tab was closed for a day; the clock kept running.
    const p = progressOf(session(), 48 * 60 * MIN);
    expect(p.fraction).toBe(1);
    expect(p.remainingMin).toBe(0);
    expect(p.done).toBe(true);
  });

  it('counts rotations that are owed', () => {
    // Two hours in, on an hourly reminder, with none acknowledged.
    expect(progressOf(session(), 120 * MIN).rotationsDue).toBe(2);
  });

  it('stops owing rotations once they are acknowledged', () => {
    expect(progressOf(session({ rotationsDone: 2 }), 120 * MIN).rotationsDue).toBe(0);
  });

  it('counts down to the next rotation', () => {
    expect(progressOf(session(), 90 * MIN).nextRotationInMin).toBeCloseTo(30);
  });

  it('stops asking for rotations after the session ends', () => {
    // Four hours of drying at hourly reminders earns three, not four: there is no point
    // turning the spool at the moment the heat goes off.
    const p = progressOf(session(), 10 * 60 * MIN);
    expect(p.rotationsDue).toBe(4);
    expect(p.nextRotationInMin).toBeNull();
  });

  it('handles rotation reminders being switched off', () => {
    const p = progressOf(session({ rotateEveryMin: 0 }), 120 * MIN);
    expect(p.rotationsDue).toBe(0);
    expect(p.nextRotationInMin).toBeNull();
  });
});

describe('hasExpired', () => {
  it('is how a tab reopened hours later knows to shut the bed off', () => {
    const s = session();
    expect(hasExpired(s, 60 * MIN)).toBe(false);
    expect(hasExpired(s, 241 * MIN)).toBe(true);
  });
});

describe('normaliseSession', () => {
  it('rejects anything that is not a session', () => {
    for (const junk of [null, undefined, 42, 'no', [], {}]) {
      expect(normaliseSession(junk)).toBeNull();
    }
  });

  it('re-clamps a hand-edited temperature', () => {
    // localStorage is user-writable. A session restored from it must not be able to ask
    // the bed for 300 °C.
    const s = normaliseSession({ ...session(), tempC: 300 });
    expect(s?.tempC).toBe(MAX_SAFE_C);
  });

  it('keeps the absolute start time, so a closed tab does not pause the clock', () => {
    const s = normaliseSession({ ...session(), startedAt: 1234 });
    expect(s?.startedAt).toBe(1234);
  });

  it('fills in sensible defaults for missing optional fields', () => {
    const s = normaliseSession({ tempC: 45, totalMinutes: 60, startedAt: 0 });
    expect(s?.rotateEveryMin).toBe(60);
    expect(s?.rotationsDone).toBe(0);
  });
});

describe('formatting', () => {
  it('reads as hours and minutes', () => {
    expect(formatDuration(245)).toBe('4h 05m');
    expect(formatDuration(45)).toBe('45m');
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(-5)).toBe('0m');
  });

  it('rounds up, so a countdown never shows 0m while time remains', () => {
    expect(formatDuration(0.2)).toBe('1m');
  });

  it('computes the finish time from the absolute start', () => {
    expect(finishesAt(session({ startedAt: 0, totalMinutes: 90 })).getTime()).toBe(90 * MIN);
  });
});
