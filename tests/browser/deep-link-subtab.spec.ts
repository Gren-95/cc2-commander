/**
 * Writing a subtab into the address bar.
 *
 * The URL was written only when a MAIN tab changed, so clicking between subtabs left it
 * showing whichever panel happened to be remembered when the tab opened — you could be
 * looking at the Spool Calculator while the address bar said `subtab=dryer`, and copying
 * that link sent someone to the wrong panel.
 *
 * In a browser because the whole function is `history.replaceState` plus a DOM read of
 * which tab is active.
 */

import { type Page, expect, test } from '@playwright/test';

type DeepLink = { updateDeepLinkSubtab: (group: string, subtab: string) => void };
const deepLink = `(globalThis).T.deepLink`;

/** A tab strip with one tab marked active, as `toggleState` leaves it. */
async function mount(page: Page, activeTab: string): Promise<void> {
  await page.evaluate((tab) => {
    document.body.innerHTML = ['dashboard', 'tools', 'help', 'settings']
      .map((t) => `<button class="main-tab${t === tab ? ' active' : ''}" data-tab="${t}"></button>`)
      .join('');
    history.replaceState(null, '', '/');
  }, activeTab);
}

const search = (page: Page) => page.evaluate(() => location.search);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
});

test.describe('updateDeepLinkSubtab', () => {
  test('writes the subtab of the tab you are looking at', async ({ page }) => {
    await mount(page, 'tools');
    await page.evaluate(`${deepLink}.updateDeepLinkSubtab('tools', 'spool')`);
    expect(await search(page)).toBe('?tab=tools&subtab=spool');
  });

  test('replaces rather than pushes, so Back still leaves the app', async ({ page }) => {
    await mount(page, 'tools');
    const before = await page.evaluate(() => history.length);
    await page.evaluate(
      `${deepLink}.updateDeepLinkSubtab('tools', 'spool');` +
        `${deepLink}.updateDeepLinkSubtab('tools', 'dryer');` +
        `${deepLink}.updateDeepLinkSubtab('tools', 'spool');`,
    );
    expect(await page.evaluate(() => history.length)).toBe(before);
  });

  test('ignores a group whose tab is not on screen', async ({ page }) => {
    // `switchSubtab` runs for a group whenever its parent tab is opened, including to
    // restore a remembered panel — so the About page must not rewrite the URL while
    // Tools is what you are looking at.
    await mount(page, 'tools');
    await page.evaluate(`${deepLink}.updateDeepLinkSubtab('help', 'debug')`);
    expect(await search(page)).toBe('');
  });

  test('ignores a group on a tab that has no subtabs', async ({ page }) => {
    await mount(page, 'dashboard');
    await page.evaluate(`${deepLink}.updateDeepLinkSubtab('tools', 'spool')`);
    expect(await search(page)).toBe('');
  });

  test('maps the About page onto its group', async ({ page }) => {
    await mount(page, 'help');
    await page.evaluate(`${deepLink}.updateDeepLinkSubtab('help', 'debug')`);
    expect(await search(page)).toBe('?tab=help&subtab=debug');
  });
});
