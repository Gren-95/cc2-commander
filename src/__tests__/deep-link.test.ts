/**
 * `?tab=` and `?subtab=` parsing.
 *
 * Pure, so it is tested without a browser. The cases that matter are the bad ones: a
 * link is the one input that arrives from outside the app — pasted, bookmarked, or left
 * over from an older build — so every field has to survive being wrong.
 */

import { describe, expect, it } from 'bun:test';
import { parseDeepLink } from '../ui/deep-link';

/** The panels this build has, as `main.ts` reads them from the DOM. */
const available = (group: string) =>
  ({ tools: ['dryer', 'spool'], help: ['about', 'help', 'debug'] })[group] ?? [];

describe('parseDeepLink', () => {
  it('opens a tab', () => {
    expect(parseDeepLink('?tab=tools', available)).toEqual({ tab: 'tools' });
  });

  it('opens a tab and its subtab, naming the group so the caller need not', () => {
    expect(parseDeepLink('?tab=tools&subtab=spool', available)).toEqual({
      tab: 'tools',
      group: 'tools',
      subtab: 'spool',
    });
  });

  it('maps debug onto the About page, where it actually lives', () => {
    // `debug` stopped being a tab and became a section of About. A link written before
    // that should still land somewhere sensible rather than nowhere.
    expect(parseDeepLink('?tab=debug&subtab=debug', available)).toEqual({
      tab: 'debug',
      group: 'help',
      subtab: 'debug',
    });
  });

  it('ignores a tab it does not have', () => {
    expect(parseDeepLink('?tab=banana', available)).toEqual({});
  });

  it('ignores a subtab this build does not have', () => {
    // A panel removed in a later version, linked from an old bookmark.
    expect(parseDeepLink('?tab=tools&subtab=retired', available)).toEqual({ tab: 'tools' });
  });

  it('ignores a subtab on a tab that has none', () => {
    expect(parseDeepLink('?tab=settings&subtab=spool', available)).toEqual({ tab: 'settings' });
  });

  it('ignores a bare subtab with no tab', () => {
    // The dashboard has no subtab group, so this asks for nothing coherent.
    expect(parseDeepLink('?subtab=spool', available)).toEqual({});
  });

  it('is empty for no query at all', () => {
    expect(parseDeepLink('', available)).toEqual({});
    expect(parseDeepLink('?', available)).toEqual({});
  });

  it('ignores unrelated parameters rather than choking on them', () => {
    // Analytics tags, a `?utm_source=`, anything a link picks up in transit.
    expect(parseDeepLink('?utm_source=x&tab=tools&ref=y', available)).toEqual({ tab: 'tools' });
  });

  it('takes the first value when a parameter is repeated', () => {
    expect(parseDeepLink('?tab=tools&tab=settings', available)).toEqual({ tab: 'tools' });
  });
});
