/**
 * The dryer panel, now that it is only a view.
 *
 * The keepalive, the expiry check and the off command moved into `server/dryer.ts` — a
 * heater cannot be owned by a page that a phone can put to sleep. What is left here is
 * rendering, and the rendering still carries the two things that matter to someone
 * standing at the printer: whether the bed is actually at temperature, and that stopping
 * it anywhere else will not stop the session.
 *
 * The service is not involved: `applyDryerState` is the seam it pushes through, so these
 * drive it directly. No command can reach a printer from this file.
 */

import { type Page, expect, test } from '@playwright/test';

type Panel = {
  applyDryerState: (s: Record<string, unknown>) => void;
  setDryerTemps: (t: Record<string, unknown>) => void;
  handleDryerFinished: (reason: string, label: string) => void;
  renderDryer: () => void;
};

const panel = (page: Page) =>
  page.evaluate(() => (window as never as { T: { dryerPanel: Panel } }).T.dryerPanel);

/** Push a state frame in, the way a `dryer_state` broadcast does. */
async function running(page: Page, over: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate((extra) => {
    const p = (window as never as { T: { dryerPanel: Panel } }).T.dryerPanel;
    document.body.innerHTML = '<div id="dryer-content"></div>';
    p.applyDryerState({
      session: {
        presetId: 'pla',
        label: 'PLA',
        tempC: 45,
        totalMinutes: 240,
        rotateEveryMin: 60,
        rotationsDone: 1,
        startedAt: Date.now() - 23 * 60_000,
      },
      bedTarget: 45,
      lastCorrectionAt: null,
      ...(extra as Record<string, unknown>),
    });
  }, over);
}

const text = (page: Page) => page.textContent('#dryer-content');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __ready: boolean }).__ready);
  await page.evaluate(() => localStorage.clear());
});

test.describe('the dryer panel', () => {
  test('renders a session it was told about, without having one of its own', async ({
    page,
  }) => {
    await running(page);
    const t = (await text(page)) ?? '';
    expect(t).toContain('PLA');
    expect(t).toContain('45 °C');
    // 240 minutes total, 23 elapsed
    expect(t).toMatch(/3h\s*37m/);
  });

  test('says the service owns the session, not the page', async ({ page }) => {
    // The old copy said "the timer runs in this tab", which was true and was the bug.
    await running(page);
    const t = (await text(page)) ?? '';
    expect(t).toMatch(/will\s+not\s+stop drying/i);
    expect(t).toContain('Stop and cool down');
    expect(t).not.toContain('this tab is open');
  });

  test('shows the plate against its target, plus chamber and nozzle', async ({ page }) => {
    await running(page);
    await page.evaluate(() => {
      const p = (window as never as { T: { dryerPanel: Panel } }).T.dryerPanel;
      p.setDryerTemps({ bed: 44.6, bedTarget: 45, chamber: 24.2, nozzle: 27.4 });
      p.renderDryer();
    });
    const t = (await text(page)) ?? '';
    expect(t).toContain('44.6 °C');
    expect(t).toContain('of 45 °C');
    expect(t).toContain('24.2 °C');
    expect(t).toContain('27.4 °C');
    expect(t).toContain('at temperature');
  });

  test('calls out a cleared heater, which is what a silent stop looks like', async ({
    page,
  }) => {
    await running(page);
    await page.evaluate(() => {
      const p = (window as never as { T: { dryerPanel: Panel } }).T.dryerPanel;
      p.setDryerTemps({ bed: 41, bedTarget: 0, chamber: 24, nozzle: 27 });
      p.renderDryer();
    });
    expect(await text(page)).toContain('heater off');
  });

  test('renders dashes rather than zeroes before any status has arrived', async ({
    page,
  }) => {
    // A bed actually at 45 reading as a cold 0.0 is worse than saying nothing.
    await running(page);
    expect(await text(page)).toContain('––');
  });

  test('goes back to the form when the service says the session ended', async ({ page }) => {
    await running(page);
    expect(await text(page)).toContain('Stop and cool down');
    await page.evaluate(() => {
      (window as never as { T: { dryerPanel: Panel } }).T.dryerPanel.handleDryerFinished(
        'done',
        'PLA',
      );
    });
    const t = (await text(page)) ?? '';
    expect(t).not.toContain('Stop and cool down');
    expect(t).toContain('Start drying');
  });
});
