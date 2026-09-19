/**
 * The dashboard layout model.
 *
 * Pure by design — no DOM, no localStorage — so the decisions can be tested directly.
 * The cases that matter most are the MIGRATIONS: this model is on its third shape, and
 * every user upgrading has a layout saved in one of the first two. Getting that wrong
 * silently rearranges a dashboard someone has arranged to their liking, which is a
 * worse failure than a crash because nothing announces it.
 */

import { describe, expect, it } from 'bun:test';
import {
  ALL_CARD_IDS,
  CARD_ICONS,
  CARD_NAMES,
  type CardLayout,
  DEFAULT_ORDER,
  defaultCardLayout,
  defaultWidthFor,
  FOCUS_ALL,
  focusableCards,
  normaliseCardLayout,
  resolveFocus,
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
      v: 2,
      order: [...DEFAULT_ORDER],
      hidden: ['files-card'],
      collapsed: ['temps-card'],
      width: { 'gcode-preview-card': 'full' },
    });
    expect(layout.hidden).toEqual(['files-card']);
    expect(layout.collapsed).toEqual(['temps-card']);
    expect(layout.width['gcode-preview-card']).toBe('full');
  });

  it('drops the widths of a layout saved before they were uniform', () => {
    // Widths used to be assigned by card identity — the old sidebar six were quarters,
    // two log cards full width, the rest halves — which is why a fresh dashboard looked
    // arbitrary. A layout with no version has those dropped once so the uniform default
    // applies; everything a person actually chose is kept.
    const layout = normaliseCardLayout({
      order: [...DEFAULT_ORDER],
      hidden: ['files-card'],
      collapsed: ['temps-card'],
      width: { 'gcode-preview-card': 'full', 'log-card': 'full' },
    });
    expect(layout.width['gcode-preview-card']).toBe(defaultWidthFor('gcode-preview-card'));
    expect(layout.width['log-card']).toBe(defaultWidthFor('log-card'));
    expect(layout.hidden).toEqual(['files-card']);
    expect(layout.collapsed).toEqual(['temps-card']);
  });

  it('stamps the version, so the width reset happens exactly once', () => {
    const first = normaliseCardLayout({ width: { 'gcode-preview-card': 'full' } });
    expect(first.v).toBe(2);
    // Feeding the result back in is what a save-then-load does. A resize made after the
    // reset must survive it.
    const resized = { ...first, width: { ...first.width, 'gcode-preview-card': 'full' as const } };
    expect(normaliseCardLayout(resized).width['gcode-preview-card']).toBe('full');
  });

  it('drops an unrecognised width instead of rendering an unknown class', () => {
    const layout = normaliseCardLayout({ width: { 'gcode-preview-card': 'enormous' } });
    expect(layout.width['gcode-preview-card']).toBe(defaultWidthFor('gcode-preview-card'));
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
      main: ['gcode-preview-card', 'files-card'],
      hidden: ['log-card'],
      collapsed: ['fans-card'],
    });
    expect(layout.order.slice(0, 4)).toEqual([
      'temps-card',
      'fans-card',
      'gcode-preview-card',
      'files-card',
    ]);
    expect(layout.hidden).toEqual(['log-card']);
    expect(layout.collapsed).toEqual(['fans-card']);
  });

  it('gives every migrated card the same width, wherever it came from', () => {
    // The two-panel format never stored widths, and which panel a card sat in no longer
    // decides anything: position and width are independent, and the width is uniform.
    const layout = normaliseCardLayout({
      sidebar: ['temps-card', 'fans-card'],
      main: ['gcode-preview-card'],
    });
    const widths = new Set(layout.order.map((id) => layout.width[id]));
    expect([...widths]).toEqual([defaultWidthFor('temps-card')]);
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
    // One default for every card, rather than a table of exceptions by identity.
    expect(widthOf(layout, 'temps-card')).toBe('compact');
    expect(widthOf(layout, 'log-card')).toBe('compact');
    expect(widthOf(layout, 'gcode-preview-card')).toBe('compact');
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

/**
 * The mobile focus rail's decisions.
 *
 * Pure half only — the rail itself is DOM. What is worth pinning here is the stale-
 * choice handling: a focused card can be hidden in Settings or removed from the app
 * between sessions, and honouring a stale id would show an empty dashboard on a phone
 * with no obvious way out.
 */
describe('focus rail', () => {
  const layout = (over: Partial<CardLayout> = {}): CardLayout => ({
    ...defaultCardLayout(),
    ...over,
  });

  it('offers every card that is not hidden, in layout order', () => {
    const l = layout({ hidden: ['temps-card'] });
    expect(focusableCards(l)).toEqual(l.order.filter((id) => id !== 'temps-card'));
  });

  it('focuses the first visible card when nothing is saved', () => {
    const l = layout();
    expect(resolveFocus(l, null)).toBe(l.order[0]);
  });

  it('honours a saved card that is still visible', () => {
    expect(resolveFocus(layout(), 'gcode-preview-card')).toBe('gcode-preview-card');
  });

  it('falls back when the saved card has since been hidden', () => {
    const l = layout({ hidden: ['gcode-preview-card'] });
    expect(resolveFocus(l, 'gcode-preview-card')).toBe(l.order[0]);
  });

  it('falls back when the saved card no longer exists', () => {
    const l = layout();
    expect(resolveFocus(l, 'a-card-from-a-newer-build')).toBe(l.order[0]);
  });

  it('passes FOCUS_ALL through — it is the way back to the scrolling dashboard', () => {
    expect(resolveFocus(layout(), FOCUS_ALL)).toBe(FOCUS_ALL);
    // …even when every card is hidden, which would otherwise have nothing to fall to.
    expect(resolveFocus(layout({ hidden: [...ALL_CARD_IDS] }), FOCUS_ALL)).toBe(FOCUS_ALL);
  });

  it('reports FOCUS_ALL when every card is hidden and no choice was saved', () => {
    expect(resolveFocus(layout({ hidden: [...ALL_CARD_IDS] }), null)).toBe(FOCUS_ALL);
  });

  it('has a glyph for every card, or the rail renders a blank button', () => {
    for (const id of ALL_CARD_IDS) {
      expect(CARD_ICONS[id], `${id} has no rail icon`).toBeTruthy();
    }
  });
});

describe('the camera folded into the print card', () => {
  it('is no longer a card of its own', () => {
    expect(ALL_CARD_IDS).not.toContain('camera-card');
    expect(CARD_NAMES['camera-card']).toBeUndefined();
    expect(CARD_ICONS['camera-card']).toBeUndefined();
  });

  it('is still findable: the print card is named for what it now holds', () => {
    expect(CARD_NAMES['print-status-bar']).toContain('Camera');
  });

  it('is dropped from a layout saved while it was a card, keeping everything else in place', () => {
    const layout = normaliseCardLayout({
      order: ['temps-card', 'camera-card', 'files-card', 'print-status-bar'],
      collapsed: ['camera-card', 'fans-card'],
      width: { 'camera-card': 'full', 'temps-card': 'wide' },
      v: 2,
    });
    for (const list of [layout.order, layout.hidden, layout.collapsed]) {
      expect(list).not.toContain('camera-card');
    }
    expect(layout.width['camera-card']).toBeUndefined();
    // The neighbours keep their relative order and their own settings.
    expect(layout.order.slice(0, 3)).toEqual(['temps-card', 'files-card', 'print-status-bar']);
    expect(layout.collapsed).toEqual(['fans-card']);
    expect(layout.width['temps-card']).toBe('wide');
  });

  it('is dropped from the two-panel format too', () => {
    const layout = normaliseCardLayout({ sidebar: ['temps-card'], main: ['camera-card'] });
    expect(layout.order).not.toContain('camera-card');
  });

  it('does not carry a hidden camera over as a hidden print card', () => {
    // The camera is part of the print card now; someone who hid the old camera card has
    // not asked to hide the job's status.
    const layout = normaliseCardLayout({ hidden: ['camera-card'], v: 2 });
    expect(layout.hidden).toEqual([]);
    expect(focusableCards(layout)).toContain('print-status-bar');
  });

  it('leaves the rest of the tolerance for unknown cards alone', () => {
    // Only the named retirement is dropped; a card from a newer build is still kept.
    const layout = normaliseCardLayout({ order: ['ghost-card', 'camera-card'] });
    expect(layout.order).toContain('ghost-card');
  });
});

describe('a saved order that holds an id this build does not have', () => {
  // `normaliseCardLayout` keeps unknown ids (a layout from a newer build), so one can sit
  // in a saved order. It has no name, icon or element, and must never be focusable.
  const withGhost = () => normaliseCardLayout({ order: ['ghost-card', ...DEFAULT_ORDER], v: 2 });

  it('is not focusable', () => {
    expect(focusableCards(withGhost())).not.toContain('ghost-card');
  });

  it('is not honoured as a saved focus — that would be an empty screen on a phone', () => {
    const l = withGhost();
    expect(resolveFocus(l, 'ghost-card')).toBe(focusableCards(l)[0]);
  });

  it('covers a phone whose saved focus was the old camera card', () => {
    // The case that motivated this: focus saved on `camera-card`, layout from before.
    const l = normaliseCardLayout({ order: ['temps-card', 'camera-card'], v: 2 });
    expect(resolveFocus(l, 'camera-card')).toBe(focusableCards(l)[0]);
  });
});
