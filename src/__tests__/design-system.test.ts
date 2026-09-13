/**
 * The design system's one structural rule, enforced.
 *
 * Every bug in the Tailwind conversion was the same bug: two utilities setting one CSS
 * property on one element, where Tailwind guarantees no order between them. The Resume
 * button showed beside Pause (`hidden` vs `inline-flex`), the emergency stop came out
 * grey (`text-bad` vs `text-fg`), the selected jog step lost its fill (`bg-accent` vs
 * `bg-surface`), and the sort chips would have done the same (`bg-accent` vs `bg-input`).
 * Each rendered plausibly, so each survived review.
 *
 * A state delta is what makes this safe: `add` names what "selected" sets, `remove`
 * names the neutral it displaces. The two must line up — for every property `add`
 * touches, `remove` must clear the base's utility for that property, or the element ends
 * up wearing both.
 */

import { describe, expect, it } from 'bun:test';
import {
  BTN,
  BTN_ICON,
  BTN_ICON_DANGER,
  CHIP,
  SEGMENTED_BTN,
  EMPTY,
  FIELD,
  JOG,
  SWITCH_TRACK,
} from '../ui/design';
import { STATE_UTILITIES } from '../ui/state-classes';

/** Which CSS property a utility sets, for the ones that collide in practice. */
function property(utility: string): string | null {
  if (/^(bg-|has-\[:checked\]:bg-)/.test(utility)) return 'background';
  // `text-` is three properties in one prefix: colour, size, and alignment.
  if (/^text-(left|center|right|justify|start|end)$/.test(utility)) return 'text-align';
  if (/^text-(xs|sm|base|lg|xl|\d?xl|\[)/.test(utility)) return 'font-size';
  if (/^text-/.test(utility)) return 'color';
  if (/^border-(?!\d|$)/.test(utility) && !/^border-[trblxy]-/.test(utility)) return 'border-color';
  if (/^font-(bold|semibold|medium|normal|light)$/.test(utility)) return 'font-weight';
  if (/^(hidden|block|flex|inline-flex|grid|inline-block|inline)$/.test(utility)) return 'display';
  return null;
}

/** The properties a class list sets more than once. */
function collisions(classes: string): string[] {
  const seen = new Map<string, string[]>();
  for (const c of classes.split(/\s+/).filter(Boolean)) {
    // A variant is scoped to a state, so it never fights the unprefixed utility.
    if (c.includes(':')) continue;
    const p = property(c);
    if (!p) continue;
    seen.set(p, [...(seen.get(p) ?? []), c]);
  }
  return [...seen].filter(([, u]) => u.length > 1).map(([p, u]) => `${p}: ${u.join(' + ')}`);
}

describe('design tokens', () => {
  const TOKENS = { BTN, BTN_ICON, BTN_ICON_DANGER, CHIP, EMPTY, FIELD, JOG, SWITCH_TRACK };

  for (const [name, value] of Object.entries(TOKENS)) {
    it(`${name} sets each property once`, () => {
      expect(collisions(value)).toEqual([]);
    });
  }

  it('BTN_ICON_DANGER is spelled out rather than composed with BTN_ICON', () => {
    // Composing them would put `text-fg` and `text-bad` on the same element, and the
    // neutral one won: the emergency stop rendered the same grey as every other button.
    expect(collisions(`${BTN_ICON} ${BTN_ICON_DANGER}`).length).toBeGreaterThan(0);
    expect(collisions(BTN_ICON_DANGER)).toEqual([]);
  });
});

describe('state deltas', () => {
  /** The pickers built on SEGMENTED_BTN rather than CHIP. */
  const SEGMENTED_BASES = ['dist-btn', 'speed-btn', 'chart-time-btn', 'file-source-tab'];

  it('every chip picker shares one delta', () => {
    const deltas = new Set(
      Object.entries(STATE_UTILITIES.active)
        .filter(
          ([base]) => !['main-tab', 'subtab', 'progress-fill', ...SEGMENTED_BASES].includes(base),
        )
        .map(([, d]) => `${d.add}|${d.remove}`),
    );
    expect([...deltas]).toHaveLength(1);
  });

  it('every segmented picker shares one delta, and it is not the chip one', () => {
    // A second family, deliberately: a segmented button has no background of its own —
    // the sliding fill behind it supplies the colour — so "selected" is a text colour
    // and nothing else. Adding the chip's `bg-accent` here would paint a static pill on
    // top of the sliding one and hide the slide entirely.
    const deltas = new Set(
      SEGMENTED_BASES.map((base) => {
        const d = STATE_UTILITIES.active[base];
        return `${d.add}|${d.remove}`;
      }),
    );
    expect([...deltas]).toHaveLength(1);
    expect(STATE_UTILITIES.active['dist-btn'].add).not.toContain('bg-');
    expect(STATE_UTILITIES.active['dist-btn'].add).not.toContain('border-');
  });

  it('each picker delta clears every neutral it overrides on its own base', () => {
    // The delta has to be read against the base it is actually applied to. Checking the
    // segmented delta against CHIP would pass while leaving `bg-surface` and `text-white`
    // on the same element in the app.
    for (const [base, token] of [
      ['temp-preset-btn', CHIP],
      ['dist-btn', SEGMENTED_BTN],
    ] as const) {
      const delta = STATE_UTILITIES.active[base];
      const applied = token
        .split(' ')
        .filter((c) => !delta.remove.split(' ').includes(c))
        .concat(delta.add.split(' '))
        .join(' ');
      expect(collisions(applied), base).toEqual([]);
    }
  });

  for (const [state, bySelector] of Object.entries(STATE_UTILITIES)) {
    for (const [base, delta] of Object.entries(bySelector)) {
      it(`${state}/${base} does not contradict itself`, () => {
        expect(collisions(delta.add)).toEqual([]);
        // A class in both lists would be added and removed by the same call.
        const both = delta.add.split(' ').filter((c) => c && delta.remove.split(' ').includes(c));
        expect(both).toEqual([]);
      });
    }
  }

  it('no state table entry is unreachable', () => {
    // `capacity-fill` and `log-payload` outlived their elements; the table kept styling
    // that nothing could ever apply, which reads as wiring that already exists.
    const bases = new Set(Object.values(STATE_UTILITIES).flatMap((m) => Object.keys(m)));
    expect(bases.has('capacity-fill')).toBe(false);
    expect(bases.has('log-payload')).toBe(false);
  });

  it('CHIP carries the neutrals the delta removes', () => {
    for (const neutral of STATE_UTILITIES.active['dist-btn'].remove.split(' ')) {
      expect(CHIP.split(' ')).toContain(neutral);
    }
  });
});
