/**
 * The print ledger — one row per finished print, kept by the service.
 *
 * Statistics, costs, maintenance hours and filament deductions all need the same thing:
 * a record of each print with how long it ran and how much filament it used. The
 * printer's own history (`1036`) has the first half and not the second. Its entries
 * carry a filename, an outcome and two timestamps, and no weight at all.
 *
 * The weight lives on the *file* (`total_filament_used` in `1044`), and files do not
 * outlive their prints for long: of 49 history entries on the machine this was written
 * against, 2 still had their file on the printer. So a weight has to be captured while
 * the file is still there — at the moment a print starts or ends — or it is gone.
 *
 * Hence a ledger rather than a view over history:
 *
 *   - **Timing comes from `1036`**, which is the printer's own record: exact start and
 *     end, and an outcome. Its `task_id` makes merging idempotent, so asking twice, or a
 *     browser asking too, cannot duplicate a row.
 *   - **Weight comes from the file**, looked up while it exists.
 *   - **Rows are never dropped**, so if the printer trims its history the ledger does
 *     not follow it.
 *
 * Pure: no clock, no disk, no network. Everything it needs is passed in.
 */

import { isDryingFile } from '../dryer-gcode';
import { mapTaskStatus } from '../print-task-status';
import type { FileEntry } from '../types';

export type LedgerOutcome = 'completed' | 'stopped' | 'unknown';

/** One colour a print used, as the slicer recorded it. Used to match it to a spool. */
export interface PrintColour {
  color: string;
  material: string;
  tool: number;
}

export interface LedgerEntry {
  /** The printer's `task_id`. Stable, which is what makes a merge idempotent. */
  id: string;
  filename: string;
  /** Epoch milliseconds. */
  startedAt: number;
  endedAt: number;
  /** How long it actually ran — machine time, whatever the outcome. */
  seconds: number;
  outcome: LedgerOutcome;
  /** Filament used, in grams. `null` when the file had gone before it could be read. */
  grams: number | null;
  /**
   * True when `grams` is scaled from a print that stopped partway. A print that ran a
   * third of its estimate is assumed to have used a third of its filament; that is a
   * fair guess, but a guess, and the UI says so.
   */
  gramsEstimated: boolean;
  colours: PrintColour[];
}

/** What a file says about itself, captured while it is still on the printer. */
export interface FileFacts {
  grams: number | null;
  /** The slicer's estimate, seconds. Needed to scale a stopped print's filament. */
  printSeconds: number | null;
  colours: PrintColour[];
}

/** A raw `1036` entry. Every field optional: this is what the printer sends, unvalidated. */
export interface HistoryTask {
  task_id?: unknown;
  task_name?: unknown;
  task_status?: unknown;
  begin_time?: unknown;
  end_time?: unknown;
}

/**
 * The last path segment.
 *
 * The same file is named `foo.gcode` in history, `foo.gcode` in the file list, and
 * sometimes `/local/foo.gcode` in print status. Matching on the basename is what lets
 * one find the other.
 */
export function basename(filename: string): string {
  return filename.split('/').pop() ?? filename;
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toOutcome(status: unknown): LedgerOutcome {
  const word = mapTaskStatus(
    typeof status === 'number' || typeof status === 'string' ? status : undefined,
  );
  return word === 'completed' || word === 'stopped' ? word : 'unknown';
}

/** What a file-list entry tells the ledger. `null` for a missing file. */
export function factsFromFile(file: FileEntry | undefined): FileFacts | null {
  if (!file) return null;
  const grams =
    typeof file.total_filament_used === 'number' && file.total_filament_used > 0
      ? file.total_filament_used
      : null;
  const printSeconds =
    typeof file.print_time === 'number' && file.print_time > 0 ? file.print_time : null;
  const colours = (file.color_map ?? [])
    .filter((c) => c && typeof c.color === 'string')
    .map((c) => ({ color: c.color.toUpperCase(), material: String(c.name ?? ''), tool: c.t }));
  return { grams, printSeconds, colours };
}

/**
 * How much filament a print used.
 *
 * A completed print used what the file says — even one that ran long. Running 35% past
 * the estimate is slow travel, not extra plastic. A stopped print used the fraction of
 * it that it got through, estimated from time. An unknown outcome claims nothing.
 */
export function gramsFor(
  facts: FileFacts | null,
  outcome: LedgerOutcome,
  seconds: number,
): { grams: number | null; estimated: boolean } {
  if (!facts || facts.grams === null || facts.grams <= 0) return { grams: null, estimated: false };
  if (outcome === 'completed') return { grams: round2(facts.grams), estimated: false };
  if (outcome === 'stopped' && facts.printSeconds && facts.printSeconds > 0) {
    const fraction = Math.min(1, Math.max(0, seconds / facts.printSeconds));
    return { grams: round2(facts.grams * fraction), estimated: true };
  }
  return { grams: null, estimated: false };
}

/**
 * Fold printer history into the ledger.
 *
 * Returns the whole ledger and, separately, only the rows this call added — those are
 * what a caller acts on (a new print to deduct from a spool), whereas the rest were
 * already accounted for.
 */
export function mergeHistory(
  entries: readonly LedgerEntry[],
  tasks: readonly HistoryTask[],
  factsFor: (basename: string) => FileFacts | null,
): { entries: LedgerEntry[]; added: LedgerEntry[] } {
  const known = new Set(entries.map((e) => e.id));
  const added: LedgerEntry[] = [];

  for (const task of tasks) {
    const name = typeof task.task_name === 'string' ? task.task_name : '';
    const begin = asNumber(task.begin_time);
    const end = asNumber(task.end_time);
    // No end time is a print still running, and no start time leaves no duration to
    // count. Either way there is nothing yet to record; the next merge will have it.
    if (!name || begin <= 0 || end <= 0 || end < begin) continue;
    // A drying cycle runs as a print, but it is not one anybody wants in their stats.
    if (isDryingFile(name)) continue;

    const id = typeof task.task_id === 'string' && task.task_id ? task.task_id : `${name}@${begin}`;
    if (known.has(id)) continue;
    known.add(id);

    const outcome = toOutcome(task.task_status);
    const seconds = end - begin;
    const facts = factsFor(basename(name));
    const { grams, estimated } = gramsFor(facts, outcome, seconds);

    added.push({
      id,
      filename: name,
      startedAt: begin * 1000,
      endedAt: end * 1000,
      seconds,
      outcome,
      grams,
      gramsEstimated: estimated,
      colours: facts?.colours ?? [],
    });
  }

  const merged = [...entries, ...added].sort((a, b) => a.endedAt - b.endedAt);
  return { entries: merged, added };
}

/** Accept a stored ledger, dropping anything malformed rather than failing to start. */
export function normaliseLedger(raw: unknown): LedgerEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(list)) return [];
  const out: LedgerEntry[] = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.filename !== 'string') continue;
    const outcome = r.outcome === 'completed' || r.outcome === 'stopped' ? r.outcome : 'unknown';
    out.push({
      id: r.id,
      filename: r.filename,
      startedAt: asNumber(r.startedAt),
      endedAt: asNumber(r.endedAt),
      seconds: asNumber(r.seconds),
      outcome,
      grams: typeof r.grams === 'number' && Number.isFinite(r.grams) ? r.grams : null,
      gramsEstimated: r.gramsEstimated === true,
      colours: Array.isArray(r.colours) ? (r.colours as PrintColour[]) : [],
    });
  }
  return out.sort((a, b) => a.endedAt - b.endedAt);
}
