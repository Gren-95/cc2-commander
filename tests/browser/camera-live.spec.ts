/**
 * The camera's live-view switch.
 *
 * One setting, two controls — a pill on the camera and a row on the fans card — and what
 * matters is that they agree, that "off" really closes the stream, and that the choice
 * outlives a reload. Nothing here reaches a camera: the stream is only ever a URL on an
 * `<img>`, and these tests read that attribute.
 *
 * Visibility is asserted by the `hidden` class, not by `toBeVisible`: this page has no
 * stylesheet, so `hidden` hides nothing here.
 */

import { type Page, expect, test } from '@playwright/test';

type Harness = {
  printStatus: {
    updateCamera: (hasCamera: boolean) => void;
    setCameraLive: (on: boolean) => void;
    setCameraOverlay: (on: boolean) => void;
    initCameraLiveControls: () => void;
  };
};

const HIDDEN = /\bhidden\b/;
const PILL = '#camera-live-btn';
const ROW = '#camera-live-toggle';

/** The camera's parts, and the two controls, as index.html has them (minus the styling). */
const SHELL = `
  <div id="camera-wrap" class="camera-off"><img id="camera-feed" class="hidden" alt="">
    <div id="camera-overlay"><span id="camera-overlay-text"></span></div></div>
  <label title=""><input type="checkbox" id="camera-live-btn"></label>
  <input type="checkbox" id="camera-overlay-btn">
  <button id="camera-snapshot-btn"></button><button id="camera-expand-btn"></button>
  <label title=""><input type="checkbox" id="camera-live-toggle"></label>`;

async function mount(page: Page, hasCamera: boolean): Promise<void> {
  await page.evaluate(
    ([shell, has]) => {
      document.body.innerHTML = shell as string;
      const T = (window as never as { T: Harness }).T;
      T.printStatus.initCameraLiveControls();
      T.printStatus.updateCamera(has as boolean);
    },
    [SHELL, hasCamera] as const,
  );
}

const feed = (page: Page) => page.locator('#camera-feed');
const stored = (page: Page) =>
  page.evaluate(() => {
    const raw = localStorage.getItem('cc2-commander-ui-settings');
    return raw ? JSON.parse(raw).cameraLive : undefined;
  });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
});

test.describe('with a camera', () => {
  test('is on by default: the stream is requested and both switches say so', async ({ page }) => {
    await mount(page, true);
    await expect(feed(page)).not.toHaveClass(HIDDEN);
    await expect(feed(page)).toHaveAttribute('src', '/api/stream');
    await expect(page.locator(PILL)).toBeChecked();
    await expect(page.locator(ROW)).toBeChecked();
    await expect(page.locator('#camera-snapshot-btn')).toBeEnabled();
  });

  test('switching it off closes the stream, not just hides it', async ({ page }) => {
    await mount(page, true);
    await page.evaluate(() => (window as never as { T: Harness }).T.printStatus.setCameraLive(false));

    await expect(feed(page)).toHaveClass(HIDDEN);
    // A hidden <img> with a src keeps its connection open. No attribute, no stream.
    expect(await feed(page).getAttribute('src')).toBeNull();
    await expect(page.locator('#camera-overlay-text')).toHaveText('Camera off');
    await expect(page.locator('#camera-snapshot-btn')).toBeDisabled();
    await expect(page.locator('#camera-expand-btn')).toBeDisabled();
  });

  test('both switches follow the one setting', async ({ page }) => {
    await mount(page, true);
    await page.evaluate(() => (window as never as { T: Harness }).T.printStatus.setCameraLive(false));
    await expect(page.locator(PILL)).not.toBeChecked();
    await expect(page.locator(ROW)).not.toBeChecked();
    await page.evaluate(() => (window as never as { T: Harness }).T.printStatus.setCameraLive(true));
    await expect(page.locator(PILL)).toBeChecked();
    await expect(page.locator(ROW)).toBeChecked();
    await expect(feed(page)).toHaveAttribute('src', '/api/stream');
  });

  test('comes back on the annotated stream when the overlay is on', async ({ page }) => {
    await mount(page, true);
    await page.evaluate(() => {
      const p = (window as never as { T: Harness }).T.printStatus;
      p.setCameraOverlay(true);
      p.setCameraLive(false);
      p.setCameraLive(true);
    });
    await expect(feed(page)).toHaveAttribute('src', '/api/stream/overlay');
  });

  test('is remembered across a reload, and a reload does not turn it back on', async ({ page }) => {
    await mount(page, true);
    await page.evaluate(() => (window as never as { T: Harness }).T.printStatus.setCameraLive(false));
    expect(await stored(page)).toBe(false);

    await page.reload();
    await page.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
    await mount(page, true);
    await expect(feed(page)).toHaveClass(HIDDEN);
    expect(await feed(page).getAttribute('src')).toBeNull();
    await expect(page.locator(PILL)).not.toBeChecked();
    await expect(page.locator(ROW)).not.toBeChecked();
  });
});

test.describe('without a camera', () => {
  test('says it is not connected, and the switches cannot be used', async ({ page }) => {
    await mount(page, false);
    await expect(page.locator('#camera-overlay-text')).toHaveText('Camera not connected');
    await expect(page.locator(PILL)).toBeDisabled();
    await expect(page.locator(ROW)).toBeDisabled();
    await expect(page.locator(ROW).locator('xpath=..')).toHaveAttribute('title', 'No camera detected');
  });

  test('keeps what was chosen, so a camera appearing later obeys it', async ({ page }) => {
    await mount(page, false);
    await page.evaluate(() => (window as never as { T: Harness }).T.printStatus.setCameraLive(false));
    await page.evaluate(() => (window as never as { T: Harness }).T.printStatus.updateCamera(true));
    // A camera is there now, and the choice was off: no stream.
    expect(await feed(page).getAttribute('src')).toBeNull();
    await expect(page.locator('#camera-overlay-text')).toHaveText('Camera off');
    await expect(page.locator(PILL)).toBeEnabled();
  });

  test('a camera that goes away closes the stream it had open', async ({ page }) => {
    await mount(page, true);
    await expect(feed(page)).toHaveAttribute('src', '/api/stream');
    await page.evaluate(() => (window as never as { T: Harness }).T.printStatus.updateCamera(false));
    expect(await feed(page).getAttribute('src')).toBeNull();
  });
});
