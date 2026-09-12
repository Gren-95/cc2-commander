/**
 * The dashboard layout model.
 *
 * Pure by design — no DOM, no localStorage — so the decisions can be tested directly.
 * The cases that matter most are the MIGRATIONS: this model is on its third shape, and
 * every user upgrading has a layout saved in one of the first two. Getting that wrong
 * silently rearranges a dashboard someone has arranged to their liking, which is a
 * worse failure than a crash because nothing announces it.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_CARD_IDS,
  CARD_NAMES,
  type CardLayout,
  DEFAULT_ORDER,
  defaultCardLayout,
  defaultWidthFor,
  normaliseCardLayout,
  widthOf,
} from '../ui/card-layout';

describe('defaultCardLayout', () => {
  it('places every known card and hides none', () => {
    const layout = defaultCardLayout();
    expect([...layout.order].sort()).toEqual([...ALL_CARD_IDS].sort());
    expect(layout.hidden).toEqual([]);
    expect(layout.collapsed).toEqual([]);
  });

  it('gives every card a width', () => {
    const layout = defaultCardLayout();
    for (const id of layout.order) expect(layout.width[id]).toBeTruthy();
  });

  it('hands out a fresh copy each time, since callers mutate it', () => {
    const a = defaultCardLayout();
    a.order.push('injected');
    a.width['temps-card'] = 'full';
    const b = defaultCardLayout();
    expect(b.order).not.toContain('injected');
    expect(b.width['temps-card']).toBe('compact');
  });
});

describe('normaliseCardLayout', () => {
  it('falls back to defaults for anything that is not an object', () => {
    for (const junk of [null, undefined, 42, 'nope', []]) {
      expect(normaliseCardLayout(junk).order).toEqual(DEFAULT_ORDER);
    }
  });

  it('keeps a saved order rather than reimposing the default one', () => {
    const order = [...DEFAULT_ORDER].reverse();
    expect(normaliseCardLayout({ order }).order).toEqual(order);
  });

  it('preserves hidden, collapsed and per-card widths', () => {
    const layout = normaliseCardLayout({
      order: [...DEFAULT_ORDER],
      hidden: ['files-card'],
      collapsed: ['temps-card'],
      width: { 'camera-card': 'full' },
    });
    expect(layout.hidden).toEqual(['files-card']);
    expect(layout.collapsed).toEqual(['temps-card']);
    expect(layout.width['camera-card']).toBe('full');
  });

  it('drops an unrecognised width instead of rendering an unknown class', () => {
    const layout = normaliseCardLayout({ width: { 'camera-card': 'enormous' } });
    expect(layout.width['camera-card']).toBe(defaultWidthFor('camera-card'));
  });

  it('backfills a card added after the layout was saved (ELEG-44)', () => {
    const short = DEFAULT_ORDER.slice(0, 3);
    const layout = normaliseCardLayout({ order: short });
    expect([...layout.order].sort()).toEqual([...ALL_CARD_IDS].sort());
    // …and it keeps what was saved at the front rather than reshuffling.
    expect(layout.order.slice(0, 3)).toEqual(short);
  });

  it('gives a backfilled card a width, so it cannot render unstyled', () => {
    const layout = normaliseCardLayout({ order: ['temps-card'] });
    for (const id of layout.order) expect(layout.width[id]).toBeTruthy();
  });

  it('never lists a card twice, whatever storage claimed', () => {
    const layout = normaliseCardLayout({ order: ['temps-card', 'temps-card', 'files-card'] });
    expect(layout.order.filter((id) => id === 'temps-card')).toHaveLength(1);
  });

  it('drops non-string entries instead of passing them to the DOM pass', () => {
    const layout = normaliseCardLayout({ order: ['temps-card', 42, null, 'files-card'] });
    expect(layout.order).not.toContain(42);
    expect(layout.order).not.toContain(null);
  });

  it('keeps an unknown card rather than silently discarding it', () => {
    // A card removed from the app, or a layout from a newer build. Dropping it would
    // lose the user's arrangement of everything after it on the next save.
    const layout = normaliseCardLayout({ order: ['ghost-card', ...DEFAULT_ORDER] });
    expect(layout.order).toContain('ghost-card');
  });
});

describe('migrating older saved layouts', () => {
  it('migrates the pre-panel { order, hidden } format', () => {
    const layout = normaliseCardLayout({
      order: ['files-card', 'temps-card'],
      hidden: ['log-card'],
    });
    expect(layout.order.slice(0, 2)).toEqual(['files-card', 'temps-card']);
    expect(layout.hidden).toEqual(['log-card']);
  });

  it('flattens the two-panel { sidebar, main } format, sidebar first', () => {
    // Reading order is what the user actually arranged, so it has to survive.
    const layout = normaliseCardLayout({
      sidebar: ['temps-card', 'fans-card'],
      main: ['camera-card', 'files-card'],
      hidden: ['log-card'],
      collapsed: ['fans-card'],
    });
    expect(layout.order.slice(0, 4)).toEqual([
      'temps-card',
      'fans-card',
      'camera-card',
      'files-card',
    ]);
    expect(layout.hidden).toEqual(['log-card']);
    expect(layout.collapsed).toEqual(['fans-card']);
  });

  it('gives migrated sidebar cards the narrow width they used to have', () => {
    // The two-panel format never stored widths. Defaulting everything to `wide` would
    // double the width of five cards on first load after the upgrade.
    const layout = normaliseCardLayout({
      sidebar: ['temps-card', 'fans-card'],
      main: ['camera-card'],
    });
    expect(layout.width['temps-card']).toBe('compact');
    expect(layout.width['fans-card']).toBe('compact');
    expect(layout.width['camera-card']).not.toBe('compact');
  });

  it('handles a two-panel layout that only ever had one panel', () => {
    const layout = normaliseCardLayout({ sidebar: ['temps-card'] });
    expect(layout.order[0]).toBe('temps-card');
    expect([...layout.order].sort()).toEqual([...ALL_CARD_IDS].sort());
  });
});

describe('widthOf', () => {
  it('falls back to the card default when the layout does not say', () => {
    const layout: CardLayout = { order: [], hidden: [], collapsed: [], width: {} };
    expect(widthOf(layout, 'temps-card')).toBe('compact');
    expect(widthOf(layout, 'log-card')).toBe('full');
  });

  it('prefers what the layout says', () => {
    const layout: CardLayout = {
      order: [],
      hidden: [],
      collapsed: [],
      width: { 'temps-card': 'full' },
    };
    expect(widthOf(layout, 'temps-card')).toBe('full');
  });
});

describe('CARD_NAMES', () => {
  it('names every card that can appear in the settings list', () => {
    for (const id of ALL_CARD_IDS) {
      expect(CARD_NAMES[id], `${id} has no display name`).toBeTruthy();
    }
  });
});
