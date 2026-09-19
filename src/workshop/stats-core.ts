/**
 * Print statistics, from the ledger.
 *
 * Pure, and deliberately modest about what it knows. Two figures in particular are
 * easy to overstate:
 *
 * - **Finish rate, not success rate.** `stopped` covers every print that did not run to
 *   the end, and most of those on a real machine are a first layer somebody cancelled
 *   and restarted. That is not a failure of the print: calling the ratio "success"
 *   would read a cautious operator as an unreliable printer.
 * - **Filament is a partial sum.** A weight can only be recorded while its file is still
 *   on the printer, so history from before the ledger existed mostly has none. Every
 *   total carries how many prints it actually covers.
 */

import type { CostBreakdown } from './cost-core';
import type { LedgerEntry } from './ledger-core';

export interface MonthStats {
  /** `YYYY-MM`, in the viewer's local time. */
  month: string;
  prints: number;
  completed: number;
  hours: number;
  grams: number;
}

export interface FileStats {
  filename: string;
  prints: number;
  completed: number;
}

export interface Stats {
  prints: number;
  completed: number;
  stopped: number;
  unknown: number;
  /** completed / (completed + stopped). `null` until there is something to divide. */
  finishRate: number | null;
  /** Machine hours across every outcome: a stopped print still ran the machine. */
  hours: number;
  /** Sum of the weights that are known. */
  grams: number;
  /** How many prints `grams` covers, the denominator nobody should have to guess. */
  gramsKnownFor: number;
  /**
   * Money spent, as two figures with their own counts, see `cost-core.ts` for why they
   * are not added together. `null` when no print could be priced.
   */
  filamentCost: number | null;
  filamentCostKnownFor: number;
  electricityCost: number | null;
  electricityCostKnownFor: number;
  averageSeconds: number | null;
  longest: { filename: string; seconds: number } | null;
  months: MonthStats[];
  topFiles: FileStats[];
  /** When the earliest recorded print started, epoch ms. */
  since: number | null;
}

const MONTHS_SHOWN = 12;
const TOP_FILES = 5;

/**
 * A timestamp's month in the viewer's time zone.
 *
 * `tzOffsetMinutes` is what `Date.prototype.getTimezoneOffset` returns in the browser:
 * positive west of UTC, so UTC+3 is -180. Without it the container's clock, which is
 * UTC, would put a print that ended at 01:00 local on the 1st into the previous month.
 */
export function monthKey(epochMs: number, tzOffsetMinutes: number): string {
  const d = new Date(epochMs - tzOffsetMinutes * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The last `count` months ending with the current one, oldest first. */
function recentMonths(now: number, tzOffsetMinutes: number, count: number): string[] {
  const d = new Date(now - tzOffsetMinutes * 60_000);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function computeStats(
  entries: readonly LedgerEntry[],
  options: {
    now: number;
    tzOffsetMinutes?: number;
    /** Cost of one print. Supplied by the cost tool, which owns the prices. */
    costOf?: (entry: LedgerEntry) => CostBreakdown;
  },
): Stats {
  const tz = options.tzOffsetMinutes ?? 0;
  let completed = 0;
  let stopped = 0;
  let unknown = 0;
  let seconds = 0;
  let grams = 0;
  let gramsKnownFor = 0;
  let filamentCost = 0;
  let filamentCostKnownFor = 0;
  let electricityCost = 0;
  let electricityCostKnownFor = 0;
  let completedSeconds = 0;
  let longest: Stats['longest'] = null;
  let since: number | null = null;

  const months = new Map<string, MonthStats>(
    recentMonths(options.now, tz, MONTHS_SHOWN).map((m) => [
      m,
      { month: m, prints: 0, completed: 0, hours: 0, grams: 0 },
    ]),
  );
  const files = new Map<string, FileStats>();

  for (const e of entries) {
    if (e.outcome === 'completed') completed++;
    else if (e.outcome === 'stopped') stopped++;
    else unknown++;

    seconds += e.seconds;
    if (e.grams !== null) {
      grams += e.grams;
      gramsKnownFor++;
    }
    const c = options.costOf?.(e);
    if (c?.filament != null) {
      filamentCost += c.filament;
      filamentCostKnownFor++;
    }
    if (c?.electricity != null) {
      electricityCost += c.electricity;
      electricityCostKnownFor++;
    }

    if (e.outcome === 'completed') {
      completedSeconds += e.seconds;
      if (!longest || e.seconds > longest.seconds) {
        longest = { filename: e.filename, seconds: e.seconds };
      }
    }
    if (since === null || e.startedAt < since) since = e.startedAt;

    const m = months.get(monthKey(e.endedAt, tz));
    if (m) {
      m.prints++;
      if (e.outcome === 'completed') m.completed++;
      m.hours += e.seconds / 3600;
      if (e.grams !== null) m.grams += e.grams;
    }

    const f = files.get(e.filename) ?? { filename: e.filename, prints: 0, completed: 0 };
    f.prints++;
    if (e.outcome === 'completed') f.completed++;
    files.set(e.filename, f);
  }

  const decided = completed + stopped;
  return {
    prints: entries.length,
    completed,
    stopped,
    unknown,
    finishRate: decided > 0 ? completed / decided : null,
    hours: round1(seconds / 3600),
    grams: Math.round(grams),
    gramsKnownFor,
    filamentCost: filamentCostKnownFor > 0 ? Math.round(filamentCost * 100) / 100 : null,
    filamentCostKnownFor,
    electricityCost: electricityCostKnownFor > 0 ? Math.round(electricityCost * 100) / 100 : null,
    electricityCostKnownFor,
    averageSeconds: completed > 0 ? Math.round(completedSeconds / completed) : null,
    longest,
    months: [...months.values()].map((m) => ({
      ...m,
      hours: round1(m.hours),
      grams: Math.round(m.grams),
    })),
    topFiles: [...files.values()]
      .sort((a, b) => b.prints - a.prints || b.completed - a.completed)
      .slice(0, TOP_FILES),
    since,
  };
}
