/**
 * Print statistics.
 *
 * Weighted towards the numbers that are easy to get quietly wrong: a finish rate that
 * counts outcomes nobody knows, filament totals that hide how little they cover, and a
 * month boundary drawn in the container's time zone instead of the viewer's.
 */

import { describe, expect, it } from 'bun:test';
import type { LedgerEntry, LedgerOutcome } from '../workshop/ledger-core';
import { computeStats, monthKey } from '../workshop/stats-core';

const HOUR = 3_600_000;
// 2026-09-14 12:00 UTC.
const NOW = Date.UTC(2026, 8, 14, 12);

let seq = 0;
function entry(over: Partial<LedgerEntry> & { outcome?: LedgerOutcome } = {}): LedgerEntry {
  seq++;
  const endedAt = over.endedAt ?? NOW - seq * HOUR;
  const seconds = over.seconds ?? 3600;
  return {
    id: `t${seq}`,
    filename: 'part.gcode',
    startedAt: endedAt - seconds * 1000,
    endedAt,
    seconds,
    outcome: 'completed',
    grams: 10,
    gramsEstimated: false,
    colours: [],
    ...over,
  };
}

describe('with nothing recorded', () => {
  const s = computeStats([], { now: NOW });

  it('has no finish rate rather than a rate of zero', () => {
    expect(s.finishRate).toBeNull();
  });

  it('has no cost rather than a cost of zero', () => {
    expect(s.filamentCost).toBeNull();
    expect(s.electricityCost).toBeNull();
  });

  it('still lays out twelve months, so the chart has a shape', () => {
    expect(s.months).toHaveLength(12);
    expect(s.months.at(-1)?.month).toBe('2026-09');
  });
});

describe('finish rate', () => {
  it('is completed over completed-plus-stopped', () => {
    const s = computeStats([entry(), entry(), entry(), entry({ outcome: 'stopped' })], {
      now: NOW,
    });
    expect(s.finishRate).toBe(0.75);
  });

  it('leaves unknown outcomes out of the denominator rather than counting them as failures', () => {
    const s = computeStats([entry(), entry({ outcome: 'unknown' })], { now: NOW });
    expect(s.finishRate).toBe(1);
    expect(s.unknown).toBe(1);
  });
});

describe('machine hours', () => {
  it('counts every outcome, because a stopped print still ran the machine', () => {
    const s = computeStats(
      [entry({ seconds: 3600 }), entry({ seconds: 1800, outcome: 'stopped' })],
      { now: NOW },
    );
    expect(s.hours).toBe(1.5);
  });
});

describe('filament', () => {
  it('sums only the weights that are known, and says how many that covers', () => {
    const s = computeStats([entry({ grams: 12 }), entry({ grams: null }), entry({ grams: 8 })], {
      now: NOW,
    });
    expect(s.grams).toBe(20);
    expect(s.gramsKnownFor).toBe(2);
    expect(s.prints).toBe(3);
  });
});

describe('the longest and average print', () => {
  it('only considers completed prints, not an abandoned one that ran a long time', () => {
    const s = computeStats(
      [
        entry({ filename: 'short.gcode', seconds: 600 }),
        entry({ filename: 'abandoned.gcode', seconds: 99_000, outcome: 'stopped' }),
        entry({ filename: 'long.gcode', seconds: 7200 }),
      ],
      { now: NOW },
    );
    expect(s.longest).toEqual({ filename: 'long.gcode', seconds: 7200 });
    expect(s.averageSeconds).toBe(3900);
  });
});

describe('months', () => {
  it('draws the month boundary in the viewer’s time zone, not the server’s', () => {
    // 22:30 UTC on 30 September is 01:30 on 1 October in UTC+3.
    const at = Date.UTC(2026, 8, 30, 22, 30);
    expect(monthKey(at, 0)).toBe('2026-09');
    expect(monthKey(at, -180)).toBe('2026-10');
  });

  it('files a print under its local month in the stats as well', () => {
    const oct1Local = Date.UTC(2026, 8, 30, 22, 30);
    const s = computeStats([entry({ endedAt: oct1Local })], {
      now: Date.UTC(2026, 9, 5),
      tzOffsetMinutes: -180,
    });
    expect(s.months.find((m) => m.month === '2026-10')?.prints).toBe(1);
    expect(s.months.find((m) => m.month === '2026-09')?.prints).toBe(0);
  });

  it('crosses a year boundary without losing a month', () => {
    const s = computeStats([], { now: Date.UTC(2027, 0, 15) });
    expect(s.months.map((m) => m.month).slice(-3)).toEqual(['2026-11', '2026-12', '2027-01']);
  });
});

describe('most printed files', () => {
  it('ranks by prints, then by how many of them finished', () => {
    const s = computeStats(
      [
        entry({ filename: 'a.gcode' }),
        entry({ filename: 'b.gcode' }),
        entry({ filename: 'b.gcode', outcome: 'stopped' }),
        entry({ filename: 'c.gcode' }),
        entry({ filename: 'c.gcode' }),
      ],
      { now: NOW },
    );
    expect(s.topFiles.map((f) => f.filename)).toEqual(['c.gcode', 'b.gcode', 'a.gcode']);
  });
});

describe('cost', () => {
  const costOf = (e: LedgerEntry) => ({
    filament: e.grams === null ? null : 0.25,
    electricity: 0.1,
  });

  it('prices electricity for every print, since every print has a run time', () => {
    const s = computeStats([entry({ grams: 10 }), entry({ grams: null })], { now: NOW, costOf });
    expect(s.electricityCost).toBe(0.2);
    expect(s.electricityCostKnownFor).toBe(2);
  });

  it('prices filament only where the weight is known, and says how many that is', () => {
    const s = computeStats([entry({ grams: 10 }), entry({ grams: null })], { now: NOW, costOf });
    expect(s.filamentCost).toBe(0.25);
    expect(s.filamentCostKnownFor).toBe(1);
  });
});
