/**
 * What a print costs: filament, and the electricity to run the machine.
 *
 * ## No default prices
 *
 * Every price starts empty. Electricity and filament prices vary several-fold between
 * one household and the next, and a made-up default would put a confident, wrong figure
 * into every total — which is worse than a blank that says "set your prices".
 *
 * ## Two figures, not one
 *
 * Filament and electricity are known for very different sets of prints. Run time is
 * recorded for every print, so electricity can be priced for all of them; a filament
 * weight only exists while the file is on the printer, so it is known for few. Summing
 * the two into one total would quietly mix prints priced in full with prints priced
 * for electricity alone. So they stay separate, each with its own count.
 *
 * Pure: settings in, money out.
 */

import type { LedgerOutcome } from './ledger-core';

export interface CostSettings {
  /** Shown before amounts. Free text, because a symbol is all it is. */
  currency: string;
  electricityPerKwh: number | null;
  /** Average draw while printing. A smart plug gives the real figure. */
  printerWatts: number | null;
  /** Used for any material without a price of its own. */
  filamentPerKg: number | null;
  /** Per-material prices, keyed by upper-case material name ("PLA", "PETG PRO"). */
  materialPerKg: Record<string, number>;
}

export const DEFAULT_COST_SETTINGS: CostSettings = {
  currency: '€',
  electricityPerKwh: null,
  printerWatts: null,
  filamentPerKg: null,
  materialPerKg: {},
};

/** Ceilings that reject a typo — a misplaced digit — rather than any real price. */
const MAX_PRICE = 10_000;
const MAX_WATTS = 5_000;

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

function bounded(v: unknown, max: number): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max ? n : null;
}

export function materialKey(name: string): string {
  return name.trim().toUpperCase();
}

/** Accept settings from disk or over HTTP, keeping only what is well-formed. */
export function normaliseCostSettings(raw: unknown): CostSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const currency =
    typeof r.currency === 'string' && r.currency.trim()
      ? r.currency.trim().slice(0, 4)
      : DEFAULT_COST_SETTINGS.currency;

  const materialPerKg: Record<string, number> = {};
  if (r.materialPerKg && typeof r.materialPerKg === 'object') {
    for (const [name, price] of Object.entries(r.materialPerKg as Record<string, unknown>)) {
      const key = materialKey(name).slice(0, 40);
      const p = bounded(price, MAX_PRICE);
      if (key && p !== null) materialPerKg[key] = p;
    }
  }

  return {
    currency,
    electricityPerKwh: bounded(r.electricityPerKwh, MAX_PRICE),
    printerWatts: bounded(r.printerWatts, MAX_WATTS),
    filamentPerKg: bounded(r.filamentPerKg, MAX_PRICE),
    materialPerKg,
  };
}

/**
 * The price that applies to a print's filament.
 *
 * A material's own price when every tool used that material; otherwise the default. A
 * multi-material print reports one combined weight, so there is no honest way to split
 * it between two prices.
 */
export function pricePerKgFor(materials: readonly string[], s: CostSettings): number | null {
  const distinct = [...new Set(materials.map(materialKey).filter(Boolean))];
  if (distinct.length === 1 && s.materialPerKg[distinct[0]] !== undefined) {
    return s.materialPerKg[distinct[0]];
  }
  return s.filamentPerKg;
}

export function filamentCost(
  grams: number | null,
  materials: readonly string[],
  s: CostSettings,
): number | null {
  const perKg = pricePerKgFor(materials, s);
  if (grams === null || perKg === null) return null;
  return money((grams / 1000) * perKg);
}

export function electricityCost(seconds: number, s: CostSettings): number | null {
  if (s.printerWatts === null || s.electricityPerKwh === null || seconds <= 0) return null;
  const kwh = (seconds / 3600) * (s.printerWatts / 1000);
  return money(kwh * s.electricityPerKwh);
}

export interface CostBreakdown {
  filament: number | null;
  electricity: number | null;
}

export function costOf(
  job: { grams: number | null; seconds: number; materials: readonly string[] },
  s: CostSettings,
): CostBreakdown {
  return {
    filament: filamentCost(job.grams, job.materials, s),
    electricity: electricityCost(job.seconds, s),
  };
}

/**
 * What one file on the printer would cost to print, before anyone prints it.
 *
 * Shared between `server/workshop.ts`, which computes it, and the Cost panel, which
 * draws it — a plain data shape belongs beside the maths that produces it, not inside
 * the server-only file that happens to call that maths first.
 */
export interface FileCost {
  filename: string;
  grams: number | null;
  seconds: number | null;
  materials: string[];
  filament: number | null;
  electricity: number | null;
}

/**
 * What one finished print actually cost.
 *
 * The ledger entry's own fields, plus the breakdown — same reasoning as `FileCost`
 * above: a plain data shape beside the maths, shared between `server/workshop.ts`
 * (`costedHistory`, which combines a `LedgerEntry` with `costOfEntry`'s result) and the
 * Cost panel's history table.
 */
export interface CostedPrint {
  id: string;
  filename: string;
  endedAt: number;
  grams: number | null;
  gramsEstimated: boolean;
  seconds: number;
  outcome: LedgerOutcome;
  filament: number | null;
  electricity: number | null;
}

/** Whether anything is priced yet — the cost panel prompts until it is. */
export function hasAnyPrice(s: CostSettings): boolean {
  return (
    s.filamentPerKg !== null ||
    Object.keys(s.materialPerKg).length > 0 ||
    (s.electricityPerKwh !== null && s.printerWatts !== null)
  );
}
