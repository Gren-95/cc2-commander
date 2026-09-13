/**
 * The two pure decisions behind dashboard edit mode.
 *
 * Both are the kind of arithmetic that produces a bug indistinguishable from a flaky
 * drag: a card that lands one slot off, or a resize that snaps to the wrong bucket. In
 * a browser you would blame the pointer; here it either holds or it does not.
 */

import { describe, expect, it } from 'bun:test';
import { reorder, widthForColumns } from '../ui/dashboard-edit';

const ORDER = ['a', 'b', 'c', 'd', 'e'];

describe('reorder', () => {
  it('moves a later card up, landing before the target', () => {
    expect(reorder(ORDER, 'd', 'b')).toEqual(['a', 'd', 'b', 'c', 'e']);
  });

  it('moves an earlier card down', () => {
    // The off-by-one direction: removing 'b' first shifts 'd' down one, so a naive
    // indexOf-before-removal would insert one slot too far right.
    expect(reorder(ORDER, 'b', 'd')).toEqual(['a', 'c', 'b', 'd', 'e']);
  });

  it('moves to the very front', () => {
    expect(reorder(ORDER, 'e', 'a')).toEqual(['e', 'a', 'b', 'c', 'd']);
  });

  it('is a no-op when dropped on itself', () => {
    expect(reorder(ORDER, 'c', 'c')).toEqual(ORDER);
  });

  it('never drops or duplicates a card', () => {
    // The property that matters more than any single arrangement: a layout that loses
    // an id hides a card with no way to get it back from the tray.
    for (const moved of ORDER) {
      for (const target of ORDER) {
        const out = reorder(ORDER, moved, target);
        expect(out.length).toBe(ORDER.length);
        expect([...out].sort()).toEqual([...ORDER].sort());
      }
    }
  });

  it('leaves the order alone when the target is unknown', () => {
    expect(reorder(ORDER, 'a', 'missing')).toEqual(ORDER);
  });

  it('returns a copy, never the input array', () => {
    // `updateCardLayout` assigns the result over `layout.order`; returning the same
    // array would make a mutation look like a no-op to anything comparing references.
    const out = reorder(ORDER, 'a', 'a');
    expect(out).not.toBe(ORDER);
  });
});

describe('widthForColumns', () => {
  it('snaps to the nearest of the three buckets', () => {
    expect(widthForColumns(3)).toBe('compact'); // exact
    expect(widthForColumns(6)).toBe('wide');
    expect(widthForColumns(12)).toBe('full');
  });

  it('rounds a dragged width to whichever bucket is closest', () => {
    expect(widthForColumns(1)).toBe('compact');
    expect(widthForColumns(4)).toBe('compact'); // 1 from 3, 2 from 6
    expect(widthForColumns(5)).toBe('wide'); // 2 from 3, 1 from 6
    expect(widthForColumns(8)).toBe('wide'); // 2 from 6, 4 from 12
    expect(widthForColumns(10)).toBe('full'); // 4 from 6, 2 from 12
  });

  it('never returns something outside the three named widths', () => {
    // A stored width the rest of the app does not know would render as no width class
    // at all — a card 1/12 of a screen wide, which is how the print-status card used
    // to render before it was managed here.
    for (let c = -4; c <= 24; c++) {
      expect(['compact', 'wide', 'full']).toContain(widthForColumns(c));
    }
  });
});
