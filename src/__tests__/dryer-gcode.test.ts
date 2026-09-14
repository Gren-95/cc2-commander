/**
 * The gcode a drying cycle is expressed as.
 *
 * This file is generated and then handed to a printer to execute unattended for hours,
 * so the tests are weighted towards the things that would be dangerous or silently
 * wrong rather than towards formatting: heat that outlives the cycle, a nozzle that is
 * not explicitly cold, motion that could drive the head into a loaded spool, and a hold
 * that is shorter than the one asked for.
 */

import { describe, expect, it } from 'bun:test';
import { MAX_SAFE_C, MIN_USEFUL_C } from '../dryer-core';
import {
  DRYING_FILE_PREFIX,
  DWELL_SECONDS,
  buildDryingGcode,
  dryingFileName,
  isDryingFile,
} from '../dryer-gcode';

const dwellsIn = (g: string) => g.split('\n').filter((l) => l.startsWith('G4 P')).length;

describe('the cycle always ends cold', () => {
  it('turns the bed off at the end, after the last dwell', () => {
    const lines = buildDryingGcode({ tempC: 60, minutes: 60 }).split('\n');
    // Not `findLastIndex`: the browser tsconfig's lib predates it.
    let lastDwell = -1;
    lines.forEach((l, i) => {
      if (l.startsWith('G4 P')) lastDwell = i;
    });
    const bedOff = lines.findIndex((l) => l.startsWith('M140 S0'));
    expect(lastDwell).toBeGreaterThan(0);
    expect(bedOff).toBeGreaterThan(lastDwell);
  });

  it('never leaves a bed target as the final instruction', () => {
    const lines = buildDryingGcode({ tempC: 70, minutes: 30 })
      .split('\n')
      .filter((l) => l.startsWith('M140'))
      // Strip the trailing comment: what matters is the command, not how it reads.
      .map((l) => l.split(';')[0].trim());
    expect(lines.at(-1)).toBe('M140 S0');
  });
});

describe('the nozzle is never asked for heat', () => {
  it('sets the nozzle to zero and to nothing else', () => {
    const g = buildDryingGcode({ tempC: 60, minutes: 120 });
    const nozzle = g.split('\n').filter((l) => /^M10[49]/.test(l));
    expect(nozzle.length).toBeGreaterThan(0);
    for (const line of nozzle) expect(line).toMatch(/^M10[49] S0\b/);
  });

  it('has no M109, which would block waiting for a hotend that never heats', () => {
    expect(buildDryingGcode({ tempC: 60, minutes: 60 })).not.toContain('M109');
  });
});

describe('nothing moves, so a loaded spool cannot be hit', () => {
  it('emits no homing or motion commands', () => {
    const g = buildDryingGcode({ tempC: 60, minutes: 240 });
    const motion = g
      .split('\n')
      .filter((l) => !l.startsWith(';'))
      .filter((l) => /^(G28|G[01]\s|G2\s|G3\s|M84|FORCE_MOVE|SET_KINEMATIC_POSITION)/.test(l));
    expect(motion).toEqual([]);
  });
});

describe('the hold is at least as long as asked for', () => {
  it('covers the requested minutes exactly when they divide evenly', () => {
    expect(dwellsIn(buildDryingGcode({ tempC: 60, minutes: 240 }))).toBe(
      (240 * 60) / DWELL_SECONDS,
    );
  });

  it('rounds up rather than down, so a cycle is never short', () => {
    // 90 seconds of hold cannot be expressed in whole minutes; take the extra half.
    const g = buildDryingGcode({ tempC: 60, minutes: 2 });
    expect(dwellsIn(g) * DWELL_SECONDS).toBeGreaterThanOrEqual(2 * 60);
  });

  it('scales with the request', () => {
    const four = dwellsIn(buildDryingGcode({ tempC: 60, minutes: 240 }));
    const eight = dwellsIn(buildDryingGcode({ tempC: 60, minutes: 480 }));
    expect(eight).toBe(four * 2);
  });
});

describe('the clamps are not bypassed by going through gcode', () => {
  it('refuses a temperature above the ceiling', () => {
    const g = buildDryingGcode({ tempC: 250, minutes: 60 });
    expect(g).toContain(`M140 S${MAX_SAFE_C}`);
    expect(g).not.toContain('M140 S250');
  });

  it('lifts a uselessly low temperature to the floor', () => {
    expect(buildDryingGcode({ tempC: 5, minutes: 60 })).toContain(`M140 S${MIN_USEFUL_C}`);
  });

  it('survives values that are not numbers at all', () => {
    const g = buildDryingGcode({ tempC: Number.NaN, minutes: Number.NaN });
    expect(g).toContain('M140 S');
    expect(dwellsIn(g)).toBeGreaterThan(0);
  });
});

describe('drying files are recognisable as ours', () => {
  it('names a file by its actual temperature and duration', () => {
    expect(dryingFileName(60, 240)).toBe(`${DRYING_FILE_PREFIX}60c-240m.gcode`);
  });

  it('names by clamped values, so the name cannot promise what the file does not do', () => {
    expect(dryingFileName(250, 60)).toBe(`${DRYING_FILE_PREFIX}${MAX_SAFE_C}c-60m.gcode`);
  });

  it('recognises its own names', () => {
    expect(isDryingFile(dryingFileName(60, 240))).toBe(true);
  });

  it('recognises them under a directory, where a bare prefix test would fail', () => {
    expect(isDryingFile(`/some/dir/${dryingFileName(60, 240)}`)).toBe(true);
  });

  it('does not claim a real print', () => {
    expect(isDryingFile('benchy.gcode')).toBe(false);
    expect(isDryingFile('/local/ECC2_0.4_3dbenchy.gcode')).toBe(false);
  });
});
