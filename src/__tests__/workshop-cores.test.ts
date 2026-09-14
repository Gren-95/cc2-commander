/**
 * Cost, maintenance and inventory — the three workshop tools' decisions.
 *
 * Weighted towards what would be wrong without looking wrong: a price that was never
 * set producing a number, a multi-material print priced as one material, a spool that
 * goes negative, and a deduction made by guessing which of two identical spools fed a
 * print.
 */

import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_COST_SETTINGS,
  costOf,
  electricityCost,
  filamentCost,
  hasAnyPrice,
  normaliseCostSettings,
  pricePerKgFor,
} from '../workshop/cost-core';
import {
  type PendingUsage,
  type Spool,
  applyPrint,
  assignPending,
  matchSpool,
  normaliseColor,
  normaliseSpool,
} from '../workshop/inventory-core';
import type { LedgerEntry } from '../workshop/ledger-core';
import {
  DEFAULT_TASKS,
  hoursSince,
  normaliseTasks,
  taskStatus,
  taskStatuses,
} from '../workshop/maintenance-core';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  const endedAt = over.endedAt ?? T0 + 10 * HOUR;
  const seconds = over.seconds ?? 3600;
  return {
    id: `e-${endedAt}`,
    filename: 'part.gcode',
    startedAt: endedAt - seconds * 1000,
    endedAt,
    seconds,
    outcome: 'completed',
    grams: 20,
    gramsEstimated: false,
    colours: [{ color: '#000000', material: 'PLA', tool: 1 }],
    ...over,
  };
}

/* ── cost ─────────────────────────────────────────────────────────────── */

describe('cost with nothing set', () => {
  const s = DEFAULT_COST_SETTINGS;

  it('prices nothing, rather than inventing a default', () => {
    expect(costOf({ grams: 20, seconds: 3600, materials: ['PLA'] }, s)).toEqual({
      filament: null,
      electricity: null,
    });
    expect(hasAnyPrice(s)).toBe(false);
  });
});

describe('filament cost', () => {
  const s = normaliseCostSettings({ filamentPerKg: 20, materialPerKg: { PETG: 30 } });

  it('is grams times the price per kilo', () => {
    expect(filamentCost(250, ['PLA'], s)).toBe(5);
  });

  it('uses a material’s own price when the print used only that material', () => {
    expect(filamentCost(1000, ['PETG'], s)).toBe(30);
  });

  it('matches the material regardless of case or spacing', () => {
    expect(pricePerKgFor([' petg '], s)).toBe(30);
  });

  it('falls back to the default for a mixed-material print, whose weight comes as one total', () => {
    expect(pricePerKgFor(['PETG', 'PLA'], s)).toBe(20);
  });

  it('is unknown when the weight is unknown', () => {
    expect(filamentCost(null, ['PLA'], s)).toBeNull();
  });
});

describe('electricity cost', () => {
  const s = normaliseCostSettings({ printerWatts: 150, electricityPerKwh: 0.2 });

  it('is hours times kilowatts times the price', () => {
    // 10 h × 0.15 kW × 0.20 = 0.30
    expect(electricityCost(10 * 3600, s)).toBe(0.3);
  });

  it('needs both the draw and the price', () => {
    expect(electricityCost(3600, normaliseCostSettings({ printerWatts: 150 }))).toBeNull();
    expect(electricityCost(3600, normaliseCostSettings({ electricityPerKwh: 0.2 }))).toBeNull();
  });
});

describe('cost settings arriving over HTTP', () => {
  it('rejects a price that is clearly a typo rather than storing it', () => {
    expect(normaliseCostSettings({ filamentPerKg: 2_000_000 }).filamentPerKg).toBeNull();
  });

  it('rejects negative and non-numeric values', () => {
    const s = normaliseCostSettings({ filamentPerKg: -5, printerWatts: 'lots' });
    expect(s.filamentPerKg).toBeNull();
    expect(s.printerWatts).toBeNull();
  });

  it('accepts a number typed into a form field as a string', () => {
    expect(normaliseCostSettings({ filamentPerKg: '19.5' }).filamentPerKg).toBe(19.5);
  });

  it('treats an empty field as unset, not as zero', () => {
    expect(normaliseCostSettings({ filamentPerKg: '' }).filamentPerKg).toBeNull();
  });

  it('keeps a currency short, so it cannot become a paragraph beside every amount', () => {
    expect(normaliseCostSettings({ currency: 'Estonian kroon' }).currency).toHaveLength(4);
  });
});

/* ── maintenance ──────────────────────────────────────────────────────── */

describe('maintenance hours', () => {
  const ledger = [
    entry({ endedAt: T0 + 1 * HOUR, seconds: 7200 }),
    entry({ endedAt: T0 + 5 * HOUR, seconds: 3600, outcome: 'stopped' }),
  ];

  it('counts every print when a task has never been done', () => {
    expect(hoursSince(ledger, null)).toBe(3);
  });

  it('counts only prints since it was last done', () => {
    expect(hoursSince(ledger, T0 + 2 * HOUR)).toBe(1);
  });

  it('counts a stopped print, which still ran the machine', () => {
    expect(hoursSince([entry({ outcome: 'stopped', seconds: 3600 })], null)).toBe(1);
  });
});

describe('maintenance state', () => {
  const task = { id: 't', label: 'Lube', intervalHours: 10, lastDoneAt: null };
  const hours = (h: number) => [entry({ seconds: h * 3600 })];

  it('is ok well within the interval', () => {
    expect(taskStatus(task, hours(5)).state).toBe('ok');
  });

  it('is soon from 80% of the interval', () => {
    expect(taskStatus(task, hours(8)).state).toBe('soon');
  });

  it('is due at the interval and past it', () => {
    expect(taskStatus(task, hours(10)).state).toBe('due');
    expect(taskStatus(task, hours(25)).state).toBe('due');
  });

  it('lists the most overdue first', () => {
    const tasks = [
      { ...task, id: 'short', intervalHours: 5 },
      { ...task, id: 'long', intervalHours: 100 },
    ];
    expect(taskStatuses(tasks, hours(4)).map((t) => t.id)).toEqual(['short', 'long']);
  });
});

describe('maintenance tasks arriving over HTTP', () => {
  it('starts from the defaults when there is nothing stored', () => {
    expect(normaliseTasks(undefined)).toEqual(DEFAULT_TASKS);
  });

  it('does not hand out the default objects themselves, which a caller could mutate', () => {
    expect(normaliseTasks(undefined)[0]).not.toBe(DEFAULT_TASKS[0]);
  });

  it('drops a task with no label or a non-positive interval', () => {
    expect(
      normaliseTasks([
        { label: '', intervalHours: 10 },
        { label: 'x', intervalHours: 0 },
      ]),
    ).toEqual([]);
  });

  it('makes ids unique, so "mark done" cannot mean two tasks', () => {
    const out = normaliseTasks([
      { id: 'a', label: 'One', intervalHours: 10 },
      { id: 'a', label: 'Two', intervalHours: 10 },
    ]);
    expect(new Set(out.map((t) => t.id)).size).toBe(2);
  });

  it('keeps an empty list empty rather than restoring the defaults', () => {
    // Someone who deleted every task meant it.
    expect(normaliseTasks([])).toEqual([]);
  });
});

/* ── inventory ────────────────────────────────────────────────────────── */

function spool(over: Partial<Spool> = {}): Spool {
  return {
    id: 'black',
    name: 'Black PLA',
    material: 'PLA',
    color: '#000000',
    netGrams: 1000,
    remainingGrams: 1000,
    pricePerKg: null,
    createdAt: T0,
    ...over,
  };
}

describe('spool input', () => {
  it('accepts short hex colours and normalises them to the slicer’s form', () => {
    expect(normaliseColor('#abc')).toBe('#AABBCC');
    expect(normaliseColor('#1100ff')).toBe('#1100FF');
  });

  it('refuses a spool with no material, no colour or no weight', () => {
    expect(normaliseSpool({ color: '#000000', netGrams: 1000 }, T0)).toBeNull();
    expect(normaliseSpool({ material: 'PLA', netGrams: 1000 }, T0)).toBeNull();
    expect(normaliseSpool({ material: 'PLA', color: '#000000', netGrams: 0 }, T0)).toBeNull();
  });

  it('treats a new spool as full, and never as more than full', () => {
    expect(
      normaliseSpool({ material: 'PLA', color: '#000', netGrams: 1000 }, T0)?.remainingGrams,
    ).toBe(1000);
    expect(
      normaliseSpool({ material: 'PLA', color: '#000', netGrams: 1000, remainingGrams: 5000 }, T0)
        ?.remainingGrams,
    ).toBe(1000);
  });
});

describe('matching a print to a spool', () => {
  const colours = [{ color: '#000000', material: 'PLA', tool: 1 }];

  it('finds the one spool with that material and colour', () => {
    expect(matchSpool([spool()], colours)?.id).toBe('black');
  });

  it('refuses to choose between two identical spools', () => {
    expect(matchSpool([spool({ id: 'a' }), spool({ id: 'b' })], colours)).toBeNull();
  });

  it('ignores an empty spool, which nothing can have come off', () => {
    expect(
      matchSpool([spool({ id: 'empty', remainingGrams: 0 }), spool({ id: 'full' })], colours)?.id,
    ).toBe('full');
  });

  it('refuses a multi-colour print, whose weight is one total for every tool', () => {
    expect(
      matchSpool([spool()], [...colours, { color: '#FFFFFF', material: 'PLA', tool: 2 }]),
    ).toBeNull();
  });

  it('does not match the same colour in a different material', () => {
    expect(matchSpool([spool({ material: 'PETG' })], colours)).toBeNull();
  });
});

describe('taking a print off the shelf', () => {
  it('deducts a matched print from its spool', () => {
    const { spools, deductedFrom } = applyPrint([spool()], [], entry({ grams: 20 }));
    expect(deductedFrom).toBe('black');
    expect(spools[0].remainingGrams).toBe(980);
  });

  it('never takes a spool below zero', () => {
    const { spools } = applyPrint([spool({ remainingGrams: 5 })], [], entry({ grams: 20 }));
    expect(spools[0].remainingGrams).toBe(0);
  });

  it('queues a print it cannot attribute, rather than guessing', () => {
    const { pending, deductedFrom } = applyPrint(
      [spool({ id: 'a' }), spool({ id: 'b' })],
      [],
      entry({ id: 'job' }),
    );
    expect(deductedFrom).toBeNull();
    expect(pending.map((p) => p.id)).toEqual(['job']);
  });

  it('does nothing with a print whose weight is unknown', () => {
    const r = applyPrint([spool()], [], entry({ grams: null }));
    expect(r.pending).toEqual([]);
    expect(r.spools[0].remainingGrams).toBe(1000);
  });

  it('ignores prints made before there was any spool to take them from', () => {
    // The ledger's first backfill is the whole of the printer's history.
    const old = entry({ endedAt: T0 - HOUR });
    const r = applyPrint([spool({ createdAt: T0 })], [], old);
    expect(r.pending).toEqual([]);
    expect(r.spools[0].remainingGrams).toBe(1000);
  });

  it('with no spools at all, queues nothing', () => {
    expect(applyPrint([], [], entry()).pending).toEqual([]);
  });

  it('never queues the same print twice', () => {
    const e = entry({ id: 'job' });
    const two = [spool({ id: 'a' }), spool({ id: 'b' })];
    const first = applyPrint(two, [], e);
    expect(applyPrint(two, first.pending, e).pending).toHaveLength(1);
  });
});

describe('assigning a queued print', () => {
  const queued: PendingUsage = {
    id: 'job',
    filename: 'part.gcode',
    grams: 30,
    estimated: false,
    endedAt: T0,
    colours: [],
  };

  it('deducts it from the chosen spool and clears it from the queue', () => {
    const r = assignPending([spool()], [queued], 'job', 'black');
    expect(r?.spools[0].remainingGrams).toBe(970);
    expect(r?.pending).toEqual([]);
  });

  it('refuses a spool or a print that does not exist', () => {
    expect(assignPending([spool()], [queued], 'job', 'nope')).toBeNull();
    expect(assignPending([spool()], [queued], 'nope', 'black')).toBeNull();
  });
});
