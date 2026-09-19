/**
 * ELEG-45: relative timestamps in the log, in a real browser.
 *
 * The claim under test is the one the issue warns about: a relative timestamp written
 * once and never updated is worse than a clock. These assert the *refresh* path, and
 * that it works **without a re-render**, which is what keeps the log's auto-scroll,
 * pause button and expanded rows intact. `renderLog` short-circuits when nothing
 * changed, so a re-render-based approach would silently do nothing at all.
 *
 * The jsdom version called `vi.resetModules()` in `beforeEach` to clear `ui-settings`'
 * module-level cache and fake a page reload. That is not needed here: every `page.goto`
 * is a genuinely fresh JS realm, so the module cache is new by construction rather than
 * by a test-runner API. It is the one place this port got simpler instead of longer.
 */

import { type Page, expect, test } from '@playwright/test';

const NOW = 1_700_000_000_000;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __ready: boolean }).__ready);
  await page.evaluate(() => localStorage.clear());
});

/** Mount one timestamp span of the shape the three render sites emit. */
async function mountSpan(page: Page, ts: number, abs: string): Promise<void> {
  await page.evaluate(
    ({ ts, abs }) => {
      document.body.innerHTML = `<span class="log-time" data-ts="${ts}" data-abs="${abs}" title="${abs}">${abs}</span>`;
    },
    { ts, abs },
  );
}

const refresh = (page: Page, at: number) =>
  page.evaluate((t) => (window as never as { T: any }).T.relativeTime.refreshTimestamps(t), at);

const enableRelative = (page: Page, on: boolean) =>
  page.evaluate(
    (v) => (window as never as { T: any }).T.uiSettings.saveUISettings({ relativeTimestamps: v }),
    on,
  );

const spanText = (page: Page) =>
  page.evaluate(() => document.querySelector('.log-time')?.textContent);
const spanTitle = (page: Page) =>
  page.evaluate(() => (document.querySelector('.log-time') as HTMLElement)?.title);

test.describe('refreshTimestamps', () => {
  test('leaves the absolute text alone while the setting is off', async ({ page }) => {
    await mountSpan(page, NOW - 120_000, '12:34:56.000');
    await refresh(page, NOW);
    // Off by default, so this must not have become "2m ago".
    expect(await spanText(page)).toBe('12:34:56.000');
  });

  test('rewrites the text to a relative age once the setting is on', async ({ page }) => {
    await enableRelative(page, true);
    await mountSpan(page, NOW - 120_000, '12:34:56.000');
    await refresh(page, NOW);
    expect(await spanText(page)).toBe('2m ago');
  });

  test('advances the age on a later refresh: the whole point of the ticker', async ({ page }) => {
    await enableRelative(page, true);
    await mountSpan(page, NOW, 'irrelevant');

    await refresh(page, NOW + 60_000);
    expect(await spanText(page)).toBe('1m ago');

    // A stale "1m ago" is exactly the defect the issue describes, so assert it moves.
    await refresh(page, NOW + 300_000);
    expect(await spanText(page)).toBe('5m ago');
  });

  test('keeps the absolute value in the title in BOTH modes', async ({ page }) => {
    await mountSpan(page, NOW - 120_000, '12:34:56.000');
    await refresh(page, NOW);
    expect(await spanTitle(page)).toBe('12:34:56.000');

    await enableRelative(page, true);
    await refresh(page, NOW);
    expect(await spanText(page)).toBe('2m ago');
    // Hovering must still give the precise value: this is a toggle, not a replacement.
    expect(await spanTitle(page)).toBe('12:34:56.000');
  });

  test('can switch back to absolute without a re-render', async ({ page }) => {
    await enableRelative(page, true);
    await mountSpan(page, NOW - 120_000, '12:34:56.000');
    await refresh(page, NOW);
    expect(await spanText(page)).toBe('2m ago');

    await enableRelative(page, false);
    await refresh(page, NOW);
    // Restored from data-abs, so the render sites never have to be involved.
    expect(await spanText(page)).toBe('12:34:56.000');
  });

  test('does not replace the element, so listeners and scroll state survive', async ({ page }) => {
    await enableRelative(page, true);
    await mountSpan(page, NOW - 120_000, '12:34:56.000');

    const survived = await page.evaluate((now) => {
      const el = document.querySelector('.log-time') as HTMLElement;
      let clicks = 0;
      el.addEventListener('click', () => {
        clicks++;
      });

      (window as never as { T: any }).T.relativeTime.refreshTimestamps(now);

      // Identity, not just equality: an innerHTML rebuild would give a different node
      // and silently drop the listener. This is what protects the auto-scroll.
      const sameNode = document.querySelector('.log-time') === el;
      el.click();
      return { sameNode, clicks };
    }, NOW);

    expect(survived).toEqual({ sameNode: true, clicks: 1 });
  });

  test('ignores elements without the timestamp attributes', async ({ page }) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<span class="log-time">untouched</span>';
    });
    await refresh(page, NOW);
    expect(await spanText(page)).toBe('untouched');
  });
});
