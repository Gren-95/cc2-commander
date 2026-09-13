/**
 * The dryer keepalive — the one thing in this repo that repeatedly commands a heater.
 *
 * Worth testing in a browser rather than reasoning about, because the behaviour is a
 * cadence over wall-clock time and the failure it exists to fix was invisible: the bed
 * target was sent once at start, something else cleared it, and the countdown carried
 * on to announce dry filament that had been cooling for hours. Observed on a real
 * session — target 45 °C at 11:50, target 0 at 12:05, timer still running.
 *
 * Nothing here touches a printer. `setDryerClient` takes any `CommandSender`, so the
 * commands are captured in an array and counted.
 *
 * `Date.now` is stubbed so a four-hour session and a 30-second interval can be walked
 * in milliseconds; the module's own 1s `setInterval` is left real, so each assertion
 * waits for a genuine tick rather than for a mocked one.
 */

import { type Page, expect, test } from '@playwright/test';

const SETTINGS_KEY = 'cc2-commander-ui-settings';
/** Must match KEEPALIVE_MS in dryer-panel.ts. */
const KEEPALIVE_MS = 30_000;

interface Sent {
  method: number;
  params: Record<string, unknown>;
}

/** Mount the panel with a captured client and a session already running. */
async function startSession(page: Page, tempC = 45): Promise<void> {
  await page.evaluate(
    ([key, temp]) => {
      const w = window as never as {
        T: { dryerPanel: Record<string, (...a: unknown[]) => unknown> };
        __sent: Sent[];
        __now: number;
      };
      document.body.innerHTML = '<div id="dryer-content"></div>';

      w.__sent = [];
      w.__now = 1_000_000_000_000;
      Date.now = () => w.__now;

      w.T.dryerPanel.setDryerClient({
        sendCommand: (method: number, params: Record<string, unknown>) => {
          w.__sent.push({ method, params });
        },
      });

      localStorage.setItem(
        key as string,
        JSON.stringify({
          dryer: {
            presetId: 'pla',
            label: 'PLA',
            tempC: temp as number,
            totalMinutes: 240,
            rotationMinutes: 0,
            rotationsDone: 0,
            startedAt: w.__now,
          },
        }),
      );
      w.T.dryerPanel.renderDryer();
    },
    [SETTINGS_KEY, tempC] as const,
  );
}

/** Move the fake clock forward, then wait for one real 1s tick to act on it. */
async function advance(page: Page, ms: number): Promise<void> {
  await page.evaluate((by) => {
    (window as never as { __now: number }).__now += by as number;
  }, ms);
  await page.waitForTimeout(1200);
}

/** Push a status frame in, the way `print-status.ts` does on every render. */
async function reportTemps(
  page: Page,
  t: { bed: number; bedTarget: number; chamber: number; nozzle: number },
): Promise<void> {
  await page.evaluate((next) => {
    (
      window as never as {
        T: { dryerPanel: { setDryerTemps: (n: unknown) => void } };
      }
    ).T.dryerPanel.setDryerTemps(next);
  }, t);
}

const sent = (page: Page) => page.evaluate(() => (window as never as { __sent: Sent[] }).__sent);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __ready: boolean }).__ready);
  await page.evaluate(() => localStorage.clear());
});

test.describe('the dryer keepalive', () => {
  test('re-sends the bed target once per interval, not once per tick', async ({ page }) => {
    await startSession(page);
    // The start command itself is not sent here — the session is seeded directly — so
    // everything captured below is keepalive.
    expect(await sent(page)).toHaveLength(0);

    await advance(page, KEEPALIVE_MS + 1000);
    const first = await sent(page);
    expect(first).toHaveLength(1);
    expect(first[0]).toEqual({ method: 1028, params: { heater_bed: 45 } });

    // Several ticks inside one interval must not each send. This is the assertion that
    // would fail if the keepalive were moved into `tick` without its own clock.
    await page.waitForTimeout(2500);
    expect(await sent(page)).toHaveLength(1);

    await advance(page, KEEPALIVE_MS + 1000);
    expect(await sent(page)).toHaveLength(2);
  });

  test('stops dead once the session ends, and does not re-heat after the off command', async ({
    page,
  }) => {
    await startSession(page);
    await advance(page, KEEPALIVE_MS + 1000);
    expect(await sent(page)).toHaveLength(1);

    await page.click('#dryer-stop');
    const afterStop = await sent(page);
    expect(afterStop[afterStop.length - 1]).toEqual({
      method: 1028,
      params: { heater_bed: 0 },
    });

    // The race this guards: `finish` clears the stored session before sending the off
    // command, so a keepalive cannot fire between the two and leave the bed hot with
    // nothing running to turn it off again.
    const count = afterStop.length;
    await advance(page, KEEPALIVE_MS * 3);
    expect(await sent(page)).toHaveLength(count);
  });

  test('says so in the running view, because it will override a manual Off', async ({
    page,
  }) => {
    await startSession(page);
    const text = await page.textContent('#dryer-content');
    expect(text).toContain('re-sent every 30 seconds');
    expect(text).toMatch(/will\s+not\s+stop drying/i);
    expect(text).toContain('Stop and cool down');
  });

  test('reports a correction when something else had cleared the target', async ({
    page,
  }) => {
    await startSession(page);
    // The printer reports a target of 0 — something turned the bed off.
    await reportTemps(page, { bed: 44, bedTarget: 0, chamber: 24, nozzle: 27 });
    await advance(page, KEEPALIVE_MS + 1000);

    expect((await sent(page))[0]).toEqual({ method: 1028, params: { heater_bed: 45 } });
    expect(await page.textContent('#dryer-content')).toContain('Last correction');
  });

  test('shows the plate against its target, plus chamber and nozzle', async ({ page }) => {
    await startSession(page);
    await reportTemps(page, { bed: 44.6, bedTarget: 45, chamber: 24.2, nozzle: 27.4 });
    await page.evaluate(() => {
      (window as never as { T: { dryerPanel: { renderDryer: () => void } } })
        .T.dryerPanel.renderDryer();
    });

    const text = (await page.textContent('#dryer-content')) ?? '';
    expect(text).toContain('44.6 °C');
    expect(text).toContain('of 45 °C');
    expect(text).toContain('24.2 °C');
    expect(text).toContain('27.4 °C');
    // Within 2° counts as arrived, which is what the bar on the dashboard uses.
    expect(text).toContain('at temperature');
  });

  test('calls out a cleared heater in the readout, not only in a toast', async ({
    page,
  }) => {
    // The ~30 seconds between something turning the bed off and the keepalive undoing
    // it. A countdown alone reads identically whether the bed is hot or stone cold, so
    // this is the state worth saying out loud.
    await startSession(page);
    await reportTemps(page, { bed: 41, bedTarget: 0, chamber: 24, nozzle: 27 });
    await page.evaluate(() => {
      (window as never as { T: { dryerPanel: { renderDryer: () => void } } })
        .T.dryerPanel.renderDryer();
    });
    expect(await page.textContent('#dryer-content')).toContain('heater off');
  });

  test('renders dashes rather than zeroes before the first status arrives', async ({
    page,
  }) => {
    // A cold-looking 0.0 °C on a bed that is actually at 45 is worse than saying nothing.
    await startSession(page);
    expect(await page.textContent('#dryer-content')).toContain('––');
  });

  test('sends nothing at all when no session is running', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as never as {
        T: { dryerPanel: Record<string, (...a: unknown[]) => unknown> };
        __sent: Sent[];
      };
      document.body.innerHTML = '<div id="dryer-content"></div>';
      w.__sent = [];
      w.T.dryerPanel.setDryerClient({
        sendCommand: (method: number, params: Record<string, unknown>) => {
          w.__sent.push({ method, params });
        },
      });
      w.T.dryerPanel.renderDryer();
    });
    await page.waitForTimeout(2000);
    expect(await sent(page)).toHaveLength(0);
  });
});
