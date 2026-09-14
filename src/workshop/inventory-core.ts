/**
 * Filament inventory: what is on the shelf, and how much of each is left.
 *
 * ## Deducting a print, and when not to guess
 *
 * When a print lands in the ledger with a known weight, it comes off a spool — if the
 * spool can be named without guessing. The printer does not report which spool fed a
 * print: the slicer's colour map names each tool's colour and material, and a Canvas
 * slot is chosen at print time, not recorded after it. So a print is matched to a spool
 * only when exactly one spool on the shelf has that material and that colour, and the
 * print used exactly one colour.
 *
 * Everything else — two black PLA spools, a four-colour print whose weight comes as one
 * total, a colour nobody has entered — goes into a short queue for the person to assign
 * with a tap. A wrong deduction is silent and compounds; a queue asks once and is right.
 *
 * Pure: spools and a print in, spools and a decision out.
 */

import type { LedgerEntry, PrintColour } from './ledger-core';
import { materialKey } from './cost-core';

export interface Spool {
  id: string;
  /** Free text: "Elegoo PLA Black", "the blue one". */
  name: string;
  material: string;
  /** `#RRGGBB`, upper-case, so it compares with the slicer's colour map. */
  color: string;
  /** Filament when full, grams. Usually 1000. */
  netGrams: number;
  remainingGrams: number;
  /** Overrides the cost tool's material price for prints taken off this spool. */
  pricePerKg: number | null;
  createdAt: number;
}

/** A finished print whose filament has not been assigned to a spool yet. */
export interface PendingUsage {
  /** The ledger entry's id, so the same print is never queued twice. */
  id: string;
  filename: string;
  grams: number;
  estimated: boolean;
  endedAt: number;
  colours: PrintColour[];
}

const MAX_GRAMS = 100_000;
const MAX_SPOOLS = 200;
const MAX_PENDING = 100;
const HEX = /^#[0-9A-F]{6}$/;

export function normaliseColor(c: unknown): string | null {
  if (typeof c !== 'string') return null;
  const v = c.trim().toUpperCase();
  const full = /^#[0-9A-F]{3}$/.test(v) ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v;
  return HEX.test(full) ? full : null;
}

function grams(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= MAX_GRAMS ? Math.round(n * 10) / 10 : null;
}

/** Validate one spool. `null` when it cannot be made into one. */
export function normaliseSpool(raw: unknown, now: number, id?: string): Spool | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const material = typeof r.material === 'string' ? r.material.trim().slice(0, 40) : '';
  const color = normaliseColor(r.color);
  const net = grams(r.netGrams);
  if (!material || !color || net === null || net <= 0) return null;

  const remaining = grams(r.remainingGrams);
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 80) : material;
  const price = Number(r.pricePerKg);
  return {
    id: id ?? (typeof r.id === 'string' && r.id ? r.id.slice(0, 40) : `spool-${now}`),
    name,
    material,
    color,
    netGrams: net,
    // A new spool is full unless told otherwise; never more than full.
    remainingGrams: Math.min(net, remaining ?? net),
    pricePerKg:
      r.pricePerKg !== null && r.pricePerKg !== '' && Number.isFinite(price) && price >= 0
        ? price
        : null,
    createdAt:
      Number.isFinite(Number(r.createdAt)) && Number(r.createdAt) > 0 ? Number(r.createdAt) : now,
  };
}

export function normaliseSpools(raw: unknown, now: number): Spool[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Spool[] = [];
  for (const r of raw.slice(0, MAX_SPOOLS)) {
    const s = normaliseSpool(r, now);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

export function normalisePending(raw: unknown): PendingUsage[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingUsage[] = [];
  for (const item of raw.slice(-MAX_PENDING)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const g = grams(r.grams);
    if (typeof r.id !== 'string' || typeof r.filename !== 'string' || g === null) continue;
    out.push({
      id: r.id,
      filename: r.filename,
      grams: g,
      estimated: r.estimated === true,
      endedAt: Number(r.endedAt) || 0,
      colours: Array.isArray(r.colours) ? (r.colours as PrintColour[]) : [],
    });
  }
  return out;
}

/**
 * The one spool a print can be attributed to without guessing, or `null`.
 *
 * Only spools with filament left are candidates: an empty spool still on the list is a
 * record, not something a print could have come off.
 */
export function matchSpool(
  spools: readonly Spool[],
  colours: readonly PrintColour[],
): Spool | null {
  if (colours.length !== 1) return null;
  const want = colours[0];
  const color = normaliseColor(want.color);
  const material = materialKey(want.material);
  const hits = spools.filter(
    (s) => s.remainingGrams > 0 && s.color === color && materialKey(s.material) === material,
  );
  return hits.length === 1 ? hits[0] : null;
}

function deduct(spools: Spool[], id: string, g: number): Spool[] {
  return spools.map((s) =>
    s.id === id
      ? { ...s, remainingGrams: Math.max(0, Math.round((s.remainingGrams - g) * 10) / 10) }
      : s,
  );
}

/**
 * Take a finished print off the shelf.
 *
 * Returns the new spool list and what happened: deducted from a named spool, queued for
 * the person to assign, or nothing at all when the print's weight is unknown.
 */
export function applyPrint(
  spools: readonly Spool[],
  pending: readonly PendingUsage[],
  entry: LedgerEntry,
): { spools: Spool[]; pending: PendingUsage[]; deductedFrom: string | null } {
  const list = [...spools];
  const unchanged = { spools: list, pending: [...pending], deductedFrom: null };
  if (entry.grams === null || entry.grams <= 0 || pending.some((p) => p.id === entry.id)) {
    return unchanged;
  }
  // Only prints that ended once there was a shelf to take them off. Without this, the
  // ledger's first backfill — every print in the printer's history — would queue each
  // weighed one for assignment, for prints made before anyone entered a spool.
  if (!list.length || entry.endedAt < Math.min(...list.map((s) => s.createdAt))) {
    return unchanged;
  }
  const spool = matchSpool(list, entry.colours);
  if (spool) {
    return {
      spools: deduct(list, spool.id, entry.grams),
      pending: [...pending],
      deductedFrom: spool.id,
    };
  }
  const queued: PendingUsage = {
    id: entry.id,
    filename: entry.filename,
    grams: entry.grams,
    estimated: entry.gramsEstimated,
    endedAt: entry.endedAt,
    colours: entry.colours,
  };
  return { spools: list, pending: [...pending, queued].slice(-MAX_PENDING), deductedFrom: null };
}

/** The person has said which spool a queued print came off. */
export function assignPending(
  spools: readonly Spool[],
  pending: readonly PendingUsage[],
  usageId: string,
  spoolId: string,
): { spools: Spool[]; pending: PendingUsage[] } | null {
  const usage = pending.find((p) => p.id === usageId);
  if (!usage || !spools.some((s) => s.id === spoolId)) return null;
  return {
    spools: deduct([...spools], spoolId, usage.grams),
    pending: pending.filter((p) => p.id !== usageId),
  };
}
