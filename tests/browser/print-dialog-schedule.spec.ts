/**
 * Scheduling from the Start Print dialog.
 *
 * "Later" hands the file to the service's scheduler instead of sending `1020` from the
 * page. What is worth pinning is what it carries and what it does *not* do: it sends the
 * plate, timelapse, leveling, auto-refill and the spool chosen for each colour, it never
 * sends `1020`, it is not reachable for a USB file (the service can only fire against the
 * printer's own storage), and choosing it must not change what "Now" sends. Nothing in
 * this file talks to a printer or to the real scheduler: the sender is a recorder and the
 * two HTTP endpoints the dialog uses are stubbed.
 *
 * Visibility is asserted by the `hidden` class, not by `toBeVisible`: this page has no
 * stylesheet, so `hidden` hides nothing here and a visibility check would pass whether or
 * not anything changed.
 */

import { type Page, expect, test } from '@playwright/test';

type Sent = { method: number; params: Record<string, unknown> };

type Harness = {
  fileBrowsing: { setFileSource: (s: string) => void };
  printDialog: {
    requestPrintDialog: (f: string, p: string, c: unknown, s: unknown) => void;
    handleFileDetailForPrint: (s: unknown) => void;
  };
};

const HIDDEN = /\bhidden\b/;
const LATER = '.print-when-btn[data-when="later"]';
const NOW = '.print-when-btn[data-when="now"]';

/** A Canvas with one loaded red PLA tray: enough for a file to need a mapping. */
const CANVAS = {
  canvas_list: [
    {
      canvas_id: 0,
      connected: 1,
      tray_list: [
        {
          tray_id: 0,
          brand: '',
          filament_type: 'PLA',
          filament_name: 'PLA',
          filament_color: '#FF0000',
          min_nozzle_temp: 190,
          max_nozzle_temp: 230,
          status: 1,
        },
      ],
    },
  ],
  auto_refill: false,
};

type ScheduleCall = {
  filename: string;
  dir: string;
  runAt: number;
  options: {
    bedType: string;
    timelapse: boolean;
    bedLeveling: boolean;
    autoRefill: boolean | null;
    spools: Record<string, unknown>[];
  };
};

/** Stub the scheduler; record what it is asked, and answer with `status`. */
async function stubScheduler(
  page: Page,
  status = 201,
  message?: string,
): Promise<ScheduleCall[]> {
  const calls: ScheduleCall[] = [];
  await page.route('**/api/schedule/', async (route) => {
    calls.push(route.request().postDataJSON() as ScheduleCall);
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(status < 300 ? { data: {} } : { error: { message } }),
    });
  });
  return calls;
}

async function openDialog(
  page: Page,
  opts: { source?: 'local' | 'u-disk'; path?: string; needsMapping?: boolean } = {},
): Promise<void> {
  await page.route('**/api/files/precache', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, cached: true, size: 0 }),
    }),
  );
  await page.evaluate(
    (o) => {
      const T = (window as never as { T: Harness }).T;
      document.body.innerHTML = '';
      (window as never as { sent: Sent[] }).sent = [];
      const client = {
        printerIp: '192.0.2.99',
        sendCommand: (method: number, params: Record<string, unknown>) =>
          (window as never as { sent: Sent[] }).sent.push({ method, params }),
      };
      T.fileBrowsing.setFileSource(o.source);
      const state = {
        canvas: o.needsMapping ? o.canvas : null,
        colorMap: o.needsMapping ? [{ t: 0, color: '#ff0000', name: 'PLA' }] : [],
        lastFileDetail: { print_time: 3600, layer: 120 },
        thumbnail: null,
        fileFilamentUsed: 12.5,
      };
      const path = o.path;
      T.printDialog.requestPrintDialog(path.split('/').pop() as string, path, client, state);
      T.printDialog.handleFileDetailForPrint(state);
      // Opening the dialog asks for detail and a thumbnail; those are not what is under test.
      (window as never as { sent: Sent[] }).sent = [];
    },
    {
      source: opts.source ?? 'local',
      path: opts.path ?? 'benchy.gcode',
      needsMapping: opts.needsMapping ?? false,
      canvas: CANVAS,
    },
  );
}

const sent = (page: Page) => page.evaluate(() => (window as never as { sent: Sent[] }).sent);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
});

test.describe('the Start choice', () => {
  test('opens on Now, with the mapping and settings in view', async ({ page }) => {
    await openDialog(page, { needsMapping: true });
    await expect(page.locator('#print-dialog-mappings')).toHaveCount(1);
    await expect(page.locator('#print-when-later')).toHaveClass(HIDDEN);
    await expect(page.locator('#print-dialog-title')).toHaveText('Start Print');
    await expect(page.locator('#print-dialog-confirm')).toContainText('Print');
  });

  test('Later swaps in the time field, and keeps the mapping and settings in view', async ({
    page,
  }) => {
    await openDialog(page, { needsMapping: true });
    await page.locator(LATER).click();
    await expect(page.locator('#print-when-later')).not.toHaveClass(HIDDEN);
    await expect(page.locator('#print-dialog-title')).toHaveText('Schedule Print');
    await expect(page.locator('#print-dialog-confirm')).toContainText('Schedule');
    await expect(page.locator('#print-when')).toBeFocused();
    // A schedule keeps these, so they are not hidden or removed.
    await expect(page.locator('#print-dialog-mappings')).toHaveCount(1);
    await expect(page.locator('.print-bed-btn')).toHaveCount(2);
    await expect(page.locator('#print-opt-timelapse')).toHaveCount(1);
    await expect(page.locator('#print-opt-leveling')).toHaveCount(1);
  });

  test('going between Now and Later loses none of what was chosen', async ({ page }) => {
    await openDialog(page);
    await page.locator('.print-bed-btn[data-bed="B"]').click();
    await page.locator('#print-opt-timelapse').uncheck();
    await page.locator(LATER).click();
    await page.locator(NOW).click();
    await expect(page.locator('#print-dialog-title')).toHaveText('Start Print');
    await expect(page.locator('#print-dialog-confirm')).not.toContainText('Schedule');
    await expect(page.locator('#print-when-later')).toHaveClass(HIDDEN);
    await expect(page.locator('.print-bed-btn[data-bed="B"]')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#print-opt-timelapse')).not.toBeChecked();
  });

  test('tells a file that needs a mapping that its spools are checked again', async ({ page }) => {
    await openDialog(page, { needsMapping: true });
    await page.locator(LATER).click();
    await expect(page.locator('#print-when-later')).toContainText('spools you chose are checked again');
    await expect(page.locator('#print-when-later')).toContainText('skipped');
  });

  test('says nothing about spools for a file that needs no mapping', async ({ page }) => {
    await openDialog(page);
    await page.locator(LATER).click();
    await expect(page.locator('#print-when-later')).not.toContainText('spools');
  });
});

test.describe('the dialog layout', () => {
  // Sizes are measured in the real app, not here: this page has no stylesheet. These pin
  // what the compact layout must not have lost on the way.
  test('shows the file details with one separator between each, not two', async ({ page }) => {
    await openDialog(page);
    const dialog = page.locator('#print-dialog-overlay');
    await expect(dialog).toContainText('1h00m · 120 layers · 12.5g');
    await expect(dialog).not.toContainText('· ·');
  });

  test('lists each colour’s four slots in order, keeping an empty slot in place', async ({
    page,
  }) => {
    await openDialog(page, { needsMapping: true });
    const titles = await page
      .locator('#print-dialog-mappings [data-idx="0"] .print-spool')
      .evaluateAll((els) => els.map((e) => e.getAttribute('title')));
    expect(titles).toEqual(['PLA (C1:T1)', 'Empty (C1:T2)', 'Empty (C1:T3)', 'Empty (C1:T4)']);
  });

  test('an empty slot cannot be chosen', async ({ page }) => {
    const calls = await stubScheduler(page);
    await openDialog(page, { needsMapping: true });
    await page.locator('.print-spool-empty').first().click();
    await page.locator(LATER).click();
    await page.locator('#print-when').fill('2099-01-01T08:30');
    await page.locator('#print-dialog-confirm').click();
    await expect(page.locator('#print-dialog-overlay')).toHaveCount(0);
    // Still the one loaded spool: clicking a placeholder neither deselected it nor took it.
    expect(calls[0].options.spools).toHaveLength(1);
    expect(calls[0].options.spools[0].tray_id).toBe(0);
  });
});

test.describe('the USB drive', () => {
  test('Later is disabled, and says why', async ({ page }) => {
    await openDialog(page, { source: 'u-disk' });
    await expect(page.locator(LATER)).toBeDisabled();
    await expect(page.locator(LATER)).toHaveAttribute('title', /not on the USB drive/);
  });

  test('stays on Now even if a click gets through the disabled button', async ({ page }) => {
    await openDialog(page, { source: 'u-disk' });
    await page.evaluate((sel) => {
      document.querySelector(sel)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, LATER);
    await expect(page.locator('#print-when-later')).toHaveClass(HIDDEN);
    await expect(page.locator('#print-dialog-title')).toHaveText('Start Print');
  });
});

test.describe('confirming Later', () => {
  test('asks the scheduler for the file, its folder and the time — and sends no 1020', async ({
    page,
  }) => {
    const calls = await stubScheduler(page);
    await openDialog(page, { path: 'models/benchy.gcode' });
    await page.locator(LATER).click();
    await page.locator('#print-when').fill('2099-01-01T08:30');
    await page.locator('#print-dialog-confirm').click();

    await expect(page.locator('#print-dialog-overlay')).toHaveCount(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].filename).toBe('models/benchy.gcode');
    expect(calls[0].dir).toBe('models');
    expect(calls[0].runAt).toBe(
      await page.evaluate(() => new Date('2099-01-01T08:30').getTime()),
    );
    // Nothing was changed in the dialog, so these are its own defaults, and there is no
    // mapping to send for a file that needs none.
    expect(calls[0].options).toEqual({
      bedType: 'A',
      timelapse: true,
      bedLeveling: false,
      autoRefill: null,
      spools: [],
    });
    // Absence needs a wait: the Now path sends 1020 only after a 400ms pause following the
    // precache, so checking straight away would pass even if Later fell through into it.
    await page.waitForTimeout(900);
    expect((await sent(page)).map((c) => c.method)).not.toContain(1020);
  });

  test('a file at the root has no folder', async ({ page }) => {
    const calls = await stubScheduler(page);
    await openDialog(page, { path: 'benchy.gcode' });
    await page.locator(LATER).click();
    await page.locator('#print-when').fill('2099-01-01T08:30');
    await page.locator('#print-dialog-confirm').click();
    await expect(page.locator('#print-dialog-overlay')).toHaveCount(0);
    expect(calls[0].dir).toBe('');
  });

  test('sends the plate, timelapse and bed leveling that were chosen', async ({ page }) => {
    const calls = await stubScheduler(page);
    await openDialog(page);
    await page.locator('.print-bed-btn[data-bed="B"]').click();
    await page.locator('#print-opt-timelapse').uncheck();
    await page.locator('#print-opt-leveling').check();
    await page.locator(LATER).click();
    await page.locator('#print-when').fill('2099-01-01T08:30');
    await page.locator('#print-dialog-confirm').click();
    await expect(page.locator('#print-dialog-overlay')).toHaveCount(0);
    expect(calls[0].options).toMatchObject({ bedType: 'B', timelapse: false, bedLeveling: true });
  });

  test('sends the spool chosen for each colour, with what the tray holds now', async ({ page }) => {
    const calls = await stubScheduler(page);
    await openDialog(page, { needsMapping: true });
    await page.locator(LATER).click();
    await page.locator('#print-when').fill('2099-01-01T08:30');
    await page.locator('#print-dialog-confirm').click();
    await expect(page.locator('#print-dialog-overlay')).toHaveCount(0);
    // The single red colour was auto-mapped to the single red tray; what that tray holds
    // goes too, so the service can tell if it has changed by the time it fires.
    expect(calls[0].options.spools).toEqual([
      { t: 0, canvas_id: 0, tray_id: 0, filament_type: 'PLA', filament_color: '#FF0000' },
    ]);
    expect(calls[0].options.autoRefill).toBe(false);
  });

  test('sends the auto-refill choice for a file that needs a mapping', async ({ page }) => {
    const calls = await stubScheduler(page);
    await openDialog(page, { needsMapping: true });
    await page.locator('#print-opt-auto-refill').check();
    await page.locator(LATER).click();
    await page.locator('#print-when').fill('2099-01-01T08:30');
    await page.locator('#print-dialog-confirm').click();
    await expect(page.locator('#print-dialog-overlay')).toHaveCount(0);
    expect(calls[0].options.autoRefill).toBe(true);
  });

  test('refuses to schedule while a colour has no spool, as Print does', async ({ page }) => {
    const calls = await stubScheduler(page);
    await openDialog(page, { needsMapping: true });
    // Clicking the selected spool deselects it.
    await page.locator('.print-spool[data-idx="0"][data-tray="0"]').click();
    await page.locator(LATER).click();
    await page.locator('#print-when').fill('2099-01-01T08:30');
    await page.locator('#print-dialog-confirm').click();
    await expect(page.locator('#toast-container')).toContainText('not mapped to Canvas trays');
    await expect(page.locator('#print-dialog-overlay')).toHaveCount(1);
    expect(calls).toHaveLength(0);
  });

  test('refuses a missing time, and keeps the dialog open', async ({ page }) => {
    const calls = await stubScheduler(page);
    await openDialog(page);
    await page.locator(LATER).click();
    await page.locator('#print-dialog-confirm').click();
    await expect(page.locator('#toast-container')).toContainText('Pick a time in the future');
    await expect(page.locator('#print-dialog-overlay')).toHaveCount(1);
    expect(calls).toHaveLength(0);
  });

  test('refuses a time in the past', async ({ page }) => {
    const calls = await stubScheduler(page);
    await openDialog(page);
    await page.locator(LATER).click();
    // The field's `min` is advisory; nothing stops a typed or pasted past date.
    await page.locator('#print-when').fill('2000-01-01T08:30');
    await page.locator('#print-dialog-confirm').click();
    await expect(page.locator('#toast-container')).toContainText('Pick a time in the future');
    expect(calls).toHaveLength(0);
  });

  test('keeps the dialog open and says why when the service refuses', async ({ page }) => {
    await stubScheduler(page, 409, 'That file is already scheduled');
    await openDialog(page);
    await page.locator(LATER).click();
    await page.locator('#print-when').fill('2099-01-01T08:30');
    await page.locator('#print-dialog-confirm').click();
    await expect(page.locator('#toast-container')).toContainText('That file is already scheduled');
    await expect(page.locator('#print-dialog-overlay')).toHaveCount(1);
    // Free to try again, not stuck disabled.
    await expect(page.locator('#print-dialog-confirm')).toBeEnabled();
  });
});

test.describe('confirming Now, which this change must not have touched', () => {
  test('still starts the print with 1020 and its settings, and schedules nothing', async ({
    page,
  }) => {
    const calls = await stubScheduler(page);
    await openDialog(page, { path: 'models/benchy.gcode' });
    await page.locator('#print-dialog-confirm').click();

    // The confirm handler pauses briefly after precaching, so wait for the command.
    await expect.poll(async () => (await sent(page)).length, { timeout: 5000 }).toBeGreaterThan(0);
    const commands = await sent(page);
    expect(commands.map((c) => c.method)).toEqual([1020]);
    expect(commands[0].params).toEqual({
      storage_media: 'local',
      filename: 'models/benchy.gcode',
      config: {
        delay_video: true,
        printer_check: false,
        print_layout: 'A',
        bedlevel_force: false,
        slot_map: [],
      },
    });
    expect(calls).toHaveLength(0);
  });

  test('going Later and back to Now still prints, and does not schedule', async ({ page }) => {
    const calls = await stubScheduler(page);
    await openDialog(page);
    await page.locator(LATER).click();
    await page.locator('#print-when').fill('2099-01-01T08:30');
    await page.locator(NOW).click();
    await page.locator('#print-dialog-confirm').click();
    await expect.poll(async () => (await sent(page)).length, { timeout: 5000 }).toBeGreaterThan(0);
    expect((await sent(page)).map((c) => c.method)).toEqual([1020]);
    expect(calls).toHaveLength(0);
  });
});
