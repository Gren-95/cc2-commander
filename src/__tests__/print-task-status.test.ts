/**
 * `task_status` from print history.
 *
 * The previous mapping had 1 and 2 swapped, so every successful print read as still
 * printing and every abandoned one as completed. Nothing tested it. These pin the
 * mapping to the evidence in `print-task-status.ts`, so a future "fix" that swaps them
 * back fails here instead of in the statistics.
 */

import { describe, expect, it } from 'bun:test';
import { mapTaskStatus } from '../print-task-status';

describe('task_status, as measured on a CC2', () => {
  it('reads 1 as completed: those prints ran their full slicer estimate', () => {
    expect(mapTaskStatus(1)).toBe('completed');
  });

  it('reads 2 as stopped: those prints ended a fraction of the way through', () => {
    expect(mapTaskStatus(2)).toBe('stopped');
  });

  it('is not the old, inverted mapping', () => {
    expect(mapTaskStatus(1)).not.toBe('printing');
    expect(mapTaskStatus(2)).not.toBe('completed');
  });
});

describe('codes never observed are not guessed at', () => {
  // A guessed `failed` would be counted as a failure; an honest `unknown` is not.
  for (const code of [0, 3, 4, 99, -1]) {
    it(`reads ${code} as unknown`, () => {
      expect(mapTaskStatus(code)).toBe('unknown');
    });
  }

  it('reads a missing status as unknown', () => {
    expect(mapTaskStatus(undefined)).toBe('unknown');
  });
});

describe('a status that is already a word', () => {
  it('passes it through unchanged', () => {
    expect(mapTaskStatus('failed')).toBe('failed');
  });
});
