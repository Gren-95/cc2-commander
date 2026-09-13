/**
 * Controls that need an idle printer.
 *
 * The printer has twelve states and only one is Idle. Before this, the jog pad and
 * every maintenance button stayed live through all of them — pressing Home mid-print
 * either did nothing or ruined the print, and the only feedback was a toast afterwards.
 *
 * These run in a browser because `disabled` and `title` are DOM behaviour, and because
 * the guard is driven entirely by an attribute in markup rather than a list in code.
 */

import { type Page, expect, test } from '@playwright/test';

type Guard = { applyBusyGuard: (s: number | undefined) => void; reapplyBusyGuard: () => void };

/**
 * `page.evaluate` ships the function body to the browser, so a helper defined out here
 * is not in scope in there. Every call reaches for `T` itself.
 */
declare global {
  interface Window {
    T: { busyGuard: Guard };
  }
}

async function mount(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.body.innerHTML = `
      <button id="jog" data-requires-idle title="Move X by 10mm">X+</button>
      <button id="level" data-requires-idle title="Run auto-level">Level</button>
      <button id="pause" title="Pause">Pause</button>`;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
  await mount(page);
});

const state = (page: Page, id: string) =>
  page.evaluate((i) => {
    const el = document.getElementById(i) as HTMLButtonElement;
    return { disabled: el.disabled, title: el.title };
  }, id);

test.describe('applyBusyGuard', () => {
  test('leaves everything enabled when the printer is idle', async ({ page }) => {
    await page.evaluate(() => window.T.busyGuard.applyBusyGuard(1));
    expect(await state(page, 'jog')).toEqual({ disabled: false, title: 'Move X by 10mm' });
  });

  test('disables marked controls while printing', async ({ page }) => {
    await page.evaluate(() => window.T.busyGuard.applyBusyGuard(2));
    const jog = await state(page, 'jog');
    expect(jog.disabled).toBe(true);
    expect(jog.title).toBe('Printing — wait until the printer is idle');
  });

  test('treats every non-idle state as busy, not only printing', async ({ page }) => {
    // Homing, levelling, a self-check and an update are as busy as a print. Guarding
    // on `status !== 2` would have left the jog pad live through all of them.
    for (const [status, name] of [
      [5, 'Auto Leveling'],
      [8, 'Self Checking'],
      [9, 'Updating'],
      [10, 'Homing'],
      [11, 'File Transferring'],
    ] as const) {
      await page.evaluate((s) => window.T.busyGuard.applyBusyGuard(s), status);
      const s = await state(page, 'level');
      expect(s.disabled, `status ${status}`).toBe(true);
      expect(s.title).toBe(`${name} — wait until the printer is idle`);
    }
  });

  test('never touches a control that is not marked', async ({ page }) => {
    // Pause, Resume, Stop and the emergency stop are what you reach for BECAUSE the
    // printer is busy. Disabling them would be exactly backwards.
    await page.evaluate(() => window.T.busyGuard.applyBusyGuard(2));
    expect(await state(page, 'pause')).toEqual({ disabled: false, title: 'Pause' });
  });

  test('restores the real title rather than leaving the explanation behind', async ({ page }) => {
    await page.evaluate(() => window.T.busyGuard.applyBusyGuard(2));
    await page.evaluate(() => window.T.busyGuard.applyBusyGuard(1));
    expect(await state(page, 'jog')).toEqual({ disabled: false, title: 'Move X by 10mm' });
  });

  test('re-applies to markup a card replaced after the fact', async ({ page }) => {
    // Cards render on their own schedule and hand back freshly ENABLED buttons.
    await page.evaluate(() => window.T.busyGuard.applyBusyGuard(2));
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<button id="fresh" data-requires-idle title="Print benchy.gcode">Print</button>',
      );
      window.T.busyGuard.reapplyBusyGuard();
    });
    const fresh = await state(page, 'fresh');
    expect(fresh.disabled).toBe(true);
    expect(fresh.title).toBe('Printing — wait until the printer is idle');
  });

  test('an unknown status is treated as busy rather than idle', async ({ page }) => {
    // Failing safe: a status this build has no name for is not evidence the printer is
    // free to home itself.
    await page.evaluate(() => window.T.busyGuard.applyBusyGuard(undefined));
    expect((await state(page, 'jog')).disabled).toBe(true);
  });
});
