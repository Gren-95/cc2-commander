/**
 * ELEG-64: UI settings really do survive a reload.
 *
 * These exist to prove persistence is REAL, and are written so they cannot pass if it is
 * not. The hazard: `ui-settings.ts` wraps every storage access in try/catch and falls
 * back to defaults, so a broken environment produces no error, just defaults, silently.
 *
 * Two rules for anything added here, both carried over from the jsdom version:
 *
 *  1. **Never assert a value equal to the module's default.** `theme` defaults to
 *     'auto', so these use 'dark'; `listSort` defaults to `{}`, so these use a populated
 *     object. An assertion that matches the default cannot tell working storage from
 *     absent storage.
 *  2. **Reload rather than calling load twice.** `ui-settings.ts` memoises in a
 *     module-level `cached`, so a second `loadUISettings()` returns the cache without
 *     touching storage: testing the variable, not the persistence.
 *
 * Rule 2 is where this port is stronger than what it replaces. The jsdom version
 * simulated a reload with `vi.resetModules()`: a test-runner API that drops a module
 * cache. Here `page.reload()` is an actual browser reload: new realm, new module
 * instances, storage re-read from disk. The thing under test is the thing being done.
 *
 * The original also asserted the document origin was not opaque, because jsdom's default
 * `about:blank` refuses localStorage outright. A real browser served over http has no
 * such failure mode, but the probe is kept, if storage is ever unavailable, every
 * assertion below would pass for the wrong reason, so it must fail loudly first.
 */

import { type Page, expect, test } from '@playwright/test';

const STORAGE_KEY = 'cc2-commander-ui-settings';

/** A genuine reload, then wait for the harness bundle to re-expose the modules. */
async function reload(page: Page): Promise<void> {
  await page.reload();
  await page.waitForFunction(() => (window as never as { __ready: boolean }).__ready);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __ready: boolean }).__ready);
  await page.evaluate(() => localStorage.clear());
});

const settings = (page: Page) =>
  page.evaluate(() => (window as never as { T: any }).T.uiSettings);

test.describe('the environment itself', () => {
  test('provides a real, working localStorage', async ({ page }) => {
    // The guard the whole file rests on. If this fails, every persistence assertion
    // below is meaningless, so it must fail loudly rather than be inferred.
    expect(
      await page.evaluate(() => {
        localStorage.setItem('eleg-64-probe', 'stored');
        return localStorage.getItem('eleg-64-probe');
      }),
    ).toBe('stored');
  });

  test('is served from a non-opaque origin, which is what makes that true', async ({ page }) => {
    expect(await page.evaluate(() => window.location.origin)).toBe('http://127.0.0.1:5199');
  });
});

test.describe('ui-settings persistence', () => {
  test('writes saved settings through to the storage key', async ({ page }) => {
    const raw = await page.evaluate((key) => {
      (window as never as { T: any }).T.uiSettings.saveUISettings({ theme: 'dark' });
      // Asserting on the raw storage entry, not on a getter, this is what proves the
      // value left the module and reached storage.
      return localStorage.getItem(key);
    }, STORAGE_KEY);

    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).theme).toBe('dark');
  });

  test('restores a saved value across a real page reload', async ({ page }) => {
    await page.evaluate(() =>
      (window as never as { T: any }).T.uiSettings.saveUISettings({ theme: 'dark' }),
    );
    await reload(page);
    // 'dark' is deliberately not the default ('auto'), so absent storage fails here.
    expect(
      await page.evaluate(() => (window as never as { T: any }).T.uiSettings.loadUISettings().theme),
    ).toBe('dark');
  });

  test('restores a per-list sort choice across a reload', async ({ page }) => {
    await page.evaluate(() =>
      (window as never as { T: any }).T.uiSettings.saveListSort('files-list', {
        key: 'size',
        dir: 'desc',
      }),
    );
    await reload(page);
    // listSort defaults to {}, so getListSort would return undefined without storage.
    expect(
      await page.evaluate(() =>
        (window as never as { T: any }).T.uiSettings.getListSort('files-list'),
      ),
    ).toEqual({ key: 'size', dir: 'desc' });
  });

  test('restores a dropdown selection across a reload', async ({ page }) => {
    await page.evaluate(() =>
      (window as never as { T: any }).T.uiSettings.saveListSelect('files-list.status', 'failed'),
    );
    await reload(page);
    // The documented default for an absent selection is 'all'; 'failed' is not it.
    expect(
      await page.evaluate(() =>
        (window as never as { T: any }).T.uiSettings.getListSelect('files-list.status'),
      ),
    ).toBe('failed');
  });

  test('falls back to defaults when nothing is stored, without throwing', async ({ page }) => {
    expect((await settings(page)) !== null).toBe(true);
    expect(
      await page.evaluate(() => (window as never as { T: any }).T.uiSettings.loadUISettings().theme),
    ).toBe('auto');
  });
});

test.describe('audible alert settings (ELEG-46)', () => {
  test('is OFF by default', async ({ page }) => {
    // An explicit requirement of ELEG-46, and the one most likely to be broken by a
    // careless edit to the defaults object: a dashboard that starts making noise on
    // first load is the failure this asserts against.
    expect(
      await page.evaluate(() => {
        const s = (window as never as { T: any }).T.uiSettings.loadUISettings();
        return { sound: s.alertSound, volume: s.alertVolume };
      }),
    ).toEqual({ sound: false, volume: 0.5 });
  });

  test('persists the toggle and volume across a reload', async ({ page }) => {
    await page.evaluate(() =>
      (window as never as { T: any }).T.uiSettings.saveUISettings({
        alertSound: true,
        alertVolume: 0.2,
      }),
    );
    await reload(page);
    // Both differ from the defaults, so absent storage fails this rather than passing.
    expect(
      await page.evaluate(() => {
        const s = (window as never as { T: any }).T.uiSettings.loadUISettings();
        return { sound: s.alertSound, volume: s.alertVolume };
      }),
    ).toEqual({ sound: true, volume: 0.2 });
  });
});

/**
 * The rename from `elegoo-web-*` to `cc2-commander-*`.
 *
 * localStorage has no rename: writing a new key leaves the old value stranded and every
 * module falls back to defaults, so a person who had arranged their dashboard opens a
 * factory-fresh one with nothing to explain where it went. These assert the data
 * actually moves, which is the only reason the migration exists.
 */
test.describe('the storage-key rename carries data across', () => {
  const LEGACY = 'elegoo-web-ui-settings';

  test('adopts a value written under the old key', async ({ page }) => {
    await page.evaluate((legacy) => {
      localStorage.clear();
      // What a browser that last ran the old build would be holding.
      localStorage.setItem(legacy, JSON.stringify({ theme: 'dark', alertVolume: 0.2 }));
    }, LEGACY);
    await reload(page);

    const settings = await page.evaluate(() => {
      const s = (window as never as { T: any }).T.uiSettings.loadUISettings();
      return { theme: s.theme, volume: s.alertVolume };
    });
    // 'dark' and 0.2 are both non-default, so defaults cannot fake this passing.
    expect(settings).toEqual({ theme: 'dark', volume: 0.2 });
  });

  test('removes the old key once adopted, so a later rename cannot resurrect it', async ({ page }) => {
    const keys = await page.evaluate(
      ({ legacy, current }) => {
        localStorage.clear();
        localStorage.setItem(legacy, JSON.stringify({ theme: 'dark' }));
        (window as never as { T: any }).T.storageMigration.readMigrated(current, legacy);
        return { legacy: localStorage.getItem(legacy), current: localStorage.getItem(current) };
      },
      { legacy: LEGACY, current: STORAGE_KEY },
    );
    expect(keys.legacy).toBeNull();
    expect(JSON.parse(keys.current as string).theme).toBe('dark');
  });

  test('prefers the new key when both exist', async ({ page }) => {
    // A browser that ran the new build, then briefly an old one. The newer value wins.
    const theme = await page.evaluate(
      ({ legacy, current }) => {
        localStorage.clear();
        localStorage.setItem(legacy, JSON.stringify({ theme: 'light' }));
        localStorage.setItem(current, JSON.stringify({ theme: 'dark' }));
        const raw = (window as never as { T: any }).T.storageMigration.readMigrated(current, legacy);
        return JSON.parse(raw).theme;
      },
      { legacy: LEGACY, current: STORAGE_KEY },
    );
    expect(theme).toBe('dark');
  });
});
