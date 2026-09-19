/**
 * The mouse wheel over a chart.
 *
 * Two things went wrong together. Every chart swallowed the wheel, so scrolling the page
 * with the pointer over one zoomed it instead — up to 10×, or down to 0.1× — and stopped
 * the page moving. And the label shown while zoomed painted its own markup as text. Both are
 * read here from what the page really does: whether the browser was allowed to scroll, and
 * what text the chart actually paints onto its canvas.
 */

import { type Page, expect, test } from '@playwright/test';

type Harness = {
  charts: {
    registerChart: (c: Record<string, unknown>) => void;
    initCharts: (s: unknown) => void;
  };
  chartStore: {
    ChartStore: new () => {
      defineSeries: (k: string, l: string, c: string) => void;
      pushPoint: (t: number, v: Record<string, number>) => void;
    };
  };
};

/** A chart with a few minutes of data, and every string it paints recorded. */
async function mount(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.body.innerHTML =
      '<canvas id="chart-temps" style="display:block;width:420px;height:180px"></canvas>';
    const w = window as never as { T: Harness; drawn: string[] };
    w.drawn = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text: string, ...rest: number[]) {
      w.drawn.push(String(text));
      return original.call(this, text, ...(rest as [number, number]));
    };
    const store = new w.T.chartStore.ChartStore();
    store.defineSeries('nozzle', 'Nozzle', '#ef5350');
    const now = Date.now();
    for (let i = 60; i >= 0; i--) store.pushPoint(now - i * 5000, { nozzle: 200 + Math.sin(i / 6) * 8 });
    w.T.charts.registerChart({ canvasId: 'chart-temps', seriesKeys: ['nozzle'], yMin: 0, yMax: 300, unit: '°' });
    w.T.charts.initCharts(store);
  });
}

/** Send a wheel event to the chart; report whether the page was allowed to scroll. */
const wheel = (page: Page, init: Record<string, unknown>) =>
  page.evaluate((i) => {
    const canvas = document.getElementById('chart-temps')!;
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...i });
    canvas.dispatchEvent(event);
    return { pageMayScroll: !event.defaultPrevented };
  }, init);

const drawnSince = async (page: Page, mark: number) =>
  page.evaluate((m) => (window as never as { drawn: string[] }).drawn.slice(m), mark);
const mark = (page: Page) => page.evaluate(() => (window as never as { drawn: string[] }).drawn.length);
const settle = (page: Page) => page.waitForTimeout(350); // the chart repaints on a 100ms timer

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
  await mount(page);
  await settle(page);
});

test.describe('an ordinary wheel', () => {
  test('is left to the page: down, and up', async ({ page }) => {
    expect((await wheel(page, { deltaY: 120 })).pageMayScroll).toBe(true);
    expect((await wheel(page, { deltaY: -120 })).pageMayScroll).toBe(true);
  });

  test('never zooms the chart, however much is scrolled', async ({ page }) => {
    for (let i = 0; i < 20; i++) await wheel(page, { deltaY: -120 });
    const m = await mark(page);
    await settle(page);
    const text = (await drawnSince(page, m)).join(' | ');
    expect(text).not.toContain('double-click to reset');
    expect(text).not.toMatch(/\d\.\dx/);
  });
});

test.describe('Ctrl + wheel, and ⌘ + wheel', () => {
  test('is taken by the chart, so it does not scroll the page as well', async ({ page }) => {
    expect((await wheel(page, { deltaY: -120, ctrlKey: true })).pageMayScroll).toBe(false);
    expect((await wheel(page, { deltaY: -120, metaKey: true })).pageMayScroll).toBe(false);
  });

  test('zooms, and says so in plain text — never in markup', async ({ page }) => {
    for (let i = 0; i < 3; i++) await wheel(page, { deltaY: -120, ctrlKey: true });
    const m = await mark(page);
    await settle(page);
    const drawn = await drawnSince(page, m);
    const indicator = drawn.find((t) => t.includes('double-click to reset'));
    expect(indicator, `nothing said the chart was zoomed; it painted: ${drawn.join(' | ')}`).toBeTruthy();
    expect(indicator).toContain('2.0x'); // 1.25 ** 3
    // The regression: markup painted onto the canvas as if it were text.
    for (const text of drawn) expect(text, `painted markup: ${text}`).not.toMatch(/[<>]|class=/);
  });

  test('zooms out on the way down, and stops at the limits', async ({ page }) => {
    for (let i = 0; i < 60; i++) await wheel(page, { deltaY: 120, ctrlKey: true });
    const m = await mark(page);
    await settle(page);
    expect((await drawnSince(page, m)).join(' | ')).toContain('0.1x');
  });

  test('double-click puts it back', async ({ page }) => {
    for (let i = 0; i < 4; i++) await wheel(page, { deltaY: -120, ctrlKey: true });
    await page.evaluate(() => document.getElementById('chart-temps')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    const m = await mark(page);
    await settle(page);
    expect((await drawnSince(page, m)).join(' | ')).not.toContain('double-click to reset');
  });
});
