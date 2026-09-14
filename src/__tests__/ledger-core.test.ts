/**
 * The print ledger's merge.
 *
 * The fixtures are the real shapes a CC2 (firmware 02.01.00.00) sends — a `1036` task and
 * a `1044` file entry — so a test that passes here is one about the printer, not about a
 * shape somebody imagined.
 */

import { describe, expect, it } from 'bun:test';
import { dryingFileName } from '../dryer-gcode';
import type { FileEntry } from '../types';
import {
  type FileFacts,
  type HistoryTask,
  type LedgerEntry,
  basename,
  factsFromFile,
  gramsFor,
  mergeHistory,
  normaliseLedger,
} from '../workshop/ledger-core';

/** A real `1044` entry, verbatim. 11.71 is grams: a Benchy weighs about 12 g. */
const BENCHY: FileEntry = {
  filename: 'ECC2_0.4_3dbenchy_Elegoo PLA _0.2_37m53s.gcode',
  type: 'file',
  size: 3200116,
  create_time: 1789216213,
  print_time: 2273,
  layer: 240,
  total_filament_used: 11.71,
  color_map: [{ color: '#000000', name: 'PLA', t: 1 }],
};

/** A real `1036` task: that Benchy, finished. */
const task = (over: Partial<HistoryTask> = {}): HistoryTask => ({
  task_id: 'aad55a12-7efc-454c-880f-70dd96ca2dae',
  task_name: BENCHY.filename,
  task_status: 1,
  begin_time: 1787125615,
  end_time: 1787128070,
  ...over,
});

const noFacts = () => null;
const benchyFacts = (name: string) => (name === BENCHY.filename ? factsFromFile(BENCHY) : null);

describe('what a file tells the ledger', () => {
  it('reads grams, the estimate and the colours from a real entry', () => {
    expect(factsFromFile(BENCHY)).toEqual({
      grams: 11.71,
      printSeconds: 2273,
      colours: [{ color: '#000000', material: 'PLA', tool: 1 }],
    });
  });

  it('normalises colour case, so #abcdef and #ABCDEF are one spool', () => {
    const facts = factsFromFile({
      ...BENCHY,
      color_map: [{ color: '#abcdef', name: 'PLA', t: 1 }],
    });
    expect(facts?.colours[0].color).toBe('#ABCDEF');
  });

  it('treats a missing or zero weight as unknown, not as zero grams', () => {
    expect(factsFromFile({ ...BENCHY, total_filament_used: 0 })?.grams).toBeNull();
    expect(factsFromFile({ ...BENCHY, total_filament_used: undefined })?.grams).toBeNull();
  });

  it('has nothing to say about a file that is not there', () => {
    expect(factsFromFile(undefined)).toBeNull();
  });
});

describe('how much filament a print used', () => {
  const facts: FileFacts = { grams: 100, printSeconds: 3600, colours: [] };

  it('a completed print used the whole file', () => {
    expect(gramsFor(facts, 'completed', 3600)).toEqual({ grams: 100, estimated: false });
  });

  it('a completed print that ran long still used the whole file, not more', () => {
    // Running 35% over the estimate is slow travel, not extra plastic.
    expect(gramsFor(facts, 'completed', 4860)).toEqual({ grams: 100, estimated: false });
  });

  it('a stopped print used the part it got through, and says it is an estimate', () => {
    expect(gramsFor(facts, 'stopped', 900)).toEqual({ grams: 25, estimated: true });
  });

  it('never estimates more than the whole file for a stopped print', () => {
    expect(gramsFor(facts, 'stopped', 99_999).grams).toBe(100);
  });

  it('cannot scale a stopped print without the estimate to scale against', () => {
    expect(gramsFor({ ...facts, printSeconds: null }, 'stopped', 900).grams).toBeNull();
  });

  it('claims nothing for an outcome it does not know', () => {
    expect(gramsFor(facts, 'unknown', 3600).grams).toBeNull();
  });
});

describe('folding history into the ledger', () => {
  it('records a finished print with the printer’s own timing', () => {
    const { entries } = mergeHistory([], [task()], benchyFacts);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.outcome).toBe('completed');
    expect(e.seconds).toBe(1787128070 - 1787125615);
    expect(e.startedAt).toBe(1787125615 * 1000); // stored in ms
    expect(e.grams).toBe(11.71);
  });

  it('uses the corrected status mapping: 2 is stopped', () => {
    const { entries } = mergeHistory([], [task({ task_status: 2 })], noFacts);
    expect(entries[0].outcome).toBe('stopped');
  });

  it('is idempotent: the same history twice adds nothing the second time', () => {
    const first = mergeHistory([], [task()], benchyFacts);
    const second = mergeHistory(first.entries, [task()], benchyFacts);
    expect(second.entries).toHaveLength(1);
    expect(second.added).toEqual([]);
  });

  it('reports only the rows it added, which is what a spool is deducted from', () => {
    const first = mergeHistory([], [task({ task_id: 'a' })], noFacts);
    const second = mergeHistory(
      first.entries,
      [task({ task_id: 'a' }), task({ task_id: 'b' })],
      noFacts,
    );
    expect(second.added.map((e) => e.id)).toEqual(['b']);
  });

  it('leaves a print still running for the next merge', () => {
    expect(mergeHistory([], [task({ end_time: 0 })], noFacts).entries).toEqual([]);
  });

  it('skips a task with no start, which leaves no duration to count', () => {
    expect(mergeHistory([], [task({ begin_time: 0 })], noFacts).entries).toEqual([]);
  });

  it('keeps drying cycles out of the ledger', () => {
    const dry = task({ task_name: dryingFileName(45, 240) });
    expect(mergeHistory([], [dry], noFacts).entries).toEqual([]);
  });

  it('records a print whose file has gone, with an honest null weight', () => {
    const { entries } = mergeHistory([], [task()], noFacts);
    expect(entries[0].grams).toBeNull();
  });

  it('keeps rows sorted by when they ended', () => {
    const late = task({ task_id: 'late', begin_time: 2000, end_time: 3000 });
    const early = task({ task_id: 'early', begin_time: 1000, end_time: 1500 });
    expect(mergeHistory([], [late, early], noFacts).entries.map((e) => e.id)).toEqual([
      'early',
      'late',
    ]);
  });

  it('falls back to name@start when the printer omits a task id', () => {
    const { entries } = mergeHistory([], [task({ task_id: undefined })], noFacts);
    expect(entries[0].id).toBe(`${BENCHY.filename}@1787125615`);
  });

  it('ignores garbage the printer might send instead of throwing', () => {
    const junk = [{}, { task_name: 42 }, { task_name: 'x', begin_time: 'soon' }] as HistoryTask[];
    expect(mergeHistory([], junk, noFacts).entries).toEqual([]);
  });
});

describe('matching a file across the places it is named', () => {
  it('strips a directory, so /local/foo.gcode finds foo.gcode', () => {
    expect(basename('/local/foo.gcode')).toBe('foo.gcode');
    expect(basename('foo.gcode')).toBe('foo.gcode');
  });
});

describe('a stored ledger that has been damaged', () => {
  const good: LedgerEntry = {
    id: 'a',
    filename: 'x.gcode',
    startedAt: 1,
    endedAt: 2,
    seconds: 1,
    outcome: 'completed',
    grams: 5,
    gramsEstimated: false,
    colours: [],
  };

  it('keeps what it can and drops what it cannot read', () => {
    const out = normaliseLedger({ entries: [good, { id: 7 }, null, 'nope'] });
    expect(out).toEqual([good]);
  });

  it('starts empty rather than failing when the file is not a ledger at all', () => {
    expect(normaliseLedger(null)).toEqual([]);
    expect(normaliseLedger({ entries: 'x' })).toEqual([]);
  });

  it('reads an unrecognised outcome as unknown rather than trusting it', () => {
    expect(normaliseLedger({ entries: [{ ...good, outcome: 'exploded' }] })[0].outcome).toBe(
      'unknown',
    );
  });
});
