/**
 * The overhead light's two switches.
 *
 * They are two views of one light, so what matters is that they never disagree: using
 * any one mirrors onto the others at once, the printer's own report redraws all of them,
 * and the command sender is handed every switch so all can be held while it is in flight
 * (otherwise a second could be flipped against the first before the printer answers).
 * Nothing here reaches a printer; the sender is a recorder.
 */

import { type Page, expect, test } from '@playwright/test';

type Harness = {
  lightSwitches: {
    showLight: (on: boolean) => void;
    bindLightSwitches: (send: (on: boolean, boxes: HTMLInputElement[]) => void) => void;
  };
};

const IDS = ['led-toggle-fans', 'led-toggle-camera'] as const;

/** The three switches, as index.html has them (minus the styling), bound to a recorder. */
async function mount(page: Page): Promise<void> {
  await page.evaluate((ids) => {
    document.body.innerHTML = ids.map((id) => `<label><input type="checkbox" id="${id}"></label>`).join('');
    (window as never as { calls: unknown[] }).calls = [];
    (window as never as { T: Harness }).T.lightSwitches.bindLightSwitches((on, boxes) =>
      (window as never as { calls: unknown[] }).calls.push({ on, held: boxes.map((b) => b.id) }),
    );
  }, IDS);
}

const state = (page: Page) =>
  page.evaluate((ids) => ids.map((id) => (document.getElementById(id) as HTMLInputElement).checked), IDS);
const calls = (page: Page) =>
  page.evaluate(() => (window as never as { calls: { on: boolean; held: string[] }[] }).calls);
const show = (page: Page, on: boolean) =>
  page.evaluate((v) => (window as never as { T: Harness }).T.lightSwitches.showLight(v), on);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
  await mount(page);
});

test('the printer reporting the light redraws every switch', async ({ page }) => {
  await show(page, true);
  expect(await state(page)).toEqual([true, true]);
  await show(page, false);
  expect(await state(page)).toEqual([false, false]);
});

for (const id of IDS) {
  test.describe(`using ${id}`, () => {
    test('turns the others on with it, at once', async ({ page }) => {
      await page.locator(`label:has(#${id})`).click();
      expect(await state(page)).toEqual([true, true]);
    });

    test('and off again', async ({ page }) => {
      await show(page, true);
      await page.locator(`label:has(#${id})`).click();
      expect(await state(page)).toEqual([false, false]);
    });

    test('sends the choice once, handing over every switch to be held', async ({ page }) => {
      await page.locator(`label:has(#${id})`).click();
      expect(await calls(page)).toEqual([{ on: true, held: [...IDS] }]);
    });
  });
}

test('sends nothing when nothing was used', async ({ page }) => {
  await show(page, true);
  await show(page, false);
  // The printer's own report is not a click: it must never be echoed back as a command.
  expect(await calls(page)).toEqual([]);
});

test('the printer’s report wins over a click that has not been confirmed', async ({ page }) => {
  await page.locator('label:has(#led-toggle-fans)').click();
  expect(await state(page)).toEqual([true, true]);
  // The printer says the light is off: say it was refused, or was already changed.
  await show(page, false);
  expect(await state(page)).toEqual([false, false]);
});
