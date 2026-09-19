/**
 * The About panel, which build is running, and what it is talking to.
 *
 * Worth testing rather than eyeballing because the interesting case is the one that is
 * invisible in development: an UNSTAMPED deploy. Production runs as a container,
 * which is not a git checkout, so this panel is the only answer to "which commit is
 * this?", and the failure mode to avoid is it confidently showing something wrong.
 * ELEG-48: a version you cannot trust is worse than none.
 *
 * `diagnosticsText` gets the same attention: it is what a bug report will be pasted
 * from, so it has to stay readable when every field is missing.
 */

import { type Page, expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __ready: boolean }).__ready);
  await page.evaluate(() => {
    document.body.innerHTML = '';
  });
});

/**
 * Mount the panel host, render a status into it, and read the label/value pairs back.
 *
 * One round trip rather than three, because each `page.evaluate` is an IPC hop and the
 * panel's render is synchronous anyway.
 */
async function renderFacts(page: Page, status: unknown): Promise<Record<string, string>> {
  return await page.evaluate((s) => {
    document.body.innerHTML = '<div id="about-card"></div>';
    (window as never as { T: any }).T.about.setAboutStatus(s);
    const host = document.getElementById('about-card') as HTMLElement;
    return Object.fromEntries(
      [...host.querySelectorAll('.font-mono')].map((el) => [
        el.previousElementSibling?.textContent?.trim() ?? '',
        el.textContent?.trim() ?? '',
      ]),
    );
  }, status);
}

const diagnostics = (page: Page, status: unknown, ua: string) =>
  page.evaluate(
    ({ s, ua }) => (window as never as { T: any }).T.about.diagnosticsText(s, ua),
    { s: status, ua },
  );

test.describe('the running build', () => {
  test('shows the formatted version, the short commit and the install time', async ({ page }) => {
    const facts = await renderFacts(page, {
      build: {
        describe: 'v0.2.1-97-gd867b1b',
        version: '0.2.1',
        commit: 'd867b1bc7dbcbc4582a6549d4f74348468664f63',
        shortCommit: 'd867b1b',
        installedAt: '2026-09-12T17:45:48.951Z',
      },
    });

    expect(facts.Version).toBe('0.2.1+97');
    expect(facts.Commit).toBe('d867b1b');
    expect(facts.Installed).toBeTruthy();
  });

  test('keeps the full sha and the raw describe reachable without showing them', async ({ page }) => {
    // The short forms are what a human reads; the long forms are what they paste.
    const titles = await page.evaluate(() => {
      document.body.innerHTML = '<div id="about-card"></div>';
      (window as never as { T: any }).T.about.setAboutStatus({
        build: {
          describe: 'v0.2.1-97-gd867b1b-dirty',
          version: '0.2.1',
          commit: 'd867b1bc7dbcbc4582a6549d4f74348468664f63',
          shortCommit: 'd867b1b',
        },
      });
      return [...document.querySelectorAll('#about-card .font-mono')].map((el) =>
        el.getAttribute('title'),
      );
    });

    expect(titles).toContain('d867b1bc7dbcbc4582a6549d4f74348468664f63');
    expect(titles).toContain('v0.2.1-97-gd867b1b-dirty');
  });

  test('says so plainly when the deploy is unstamped, rather than inventing a version', async ({ page }) => {
    const facts = await renderFacts(page, { build: { describe: null, version: null } });
    expect(facts.Version).toBe('unstamped');
    // No commit row at all, an empty one would imply the field exists and is blank.
    expect(facts.Commit).toBeUndefined();
  });

  test('handles no status at all, which is the state before the first broadcast', async ({ page }) => {
    expect((await renderFacts(page, null)).Version).toBe('unstamped');
  });

  test('ignores an unparseable installedAt instead of rendering "Invalid Date"', async ({ page }) => {
    const facts = await renderFacts(page, {
      build: { version: '0.2.1', installedAt: 'not-a-date' },
    });
    expect(facts.Installed).toBeUndefined();
  });

  test('does nothing when the host element is absent', async ({ page }) => {
    // The panel only exists on the About sub-tab; the broadcast fires regardless.
    const threw = await page.evaluate(() => {
      document.body.innerHTML = '';
      try {
        (window as never as { T: any }).T.about.setAboutStatus({ build: { version: '0.2.1' } });
        return false;
      } catch {
        return true;
      }
    });
    expect(threw).toBe(false);
  });
});

test.describe('printer and service facts', () => {
  test('reports what the service says it is connected to', async ({ page }) => {
    const facts = await renderFacts(page, {
      printerSn: 'CC2-123',
      printerIp: '192.0.2.10',
      mqtt: 'connected',
      uptime: 3723,
      wsClients: 2,
      camera: 'available',
    });

    expect(facts.Serial).toBe('CC2-123');
    expect(facts.Address).toBe('192.0.2.10');
    expect(facts.MQTT).toBe('connected');
    expect(facts.Uptime).toBe('1h 2m');
    expect(facts.Browsers).toBe('2');
  });

  test('says "not registered" rather than blank when the printer has not spoken', async ({ page }) => {
    // `printerSn` is null until the printer identifies itself: a real state, and a
    // blank value would read as a bug in the panel rather than a fact about the setup.
    const facts = await renderFacts(page, { printerSn: null, printerIp: '192.0.2.10' });
    expect(facts.Serial).toBe('not registered');
  });
});

test.describe('diagnosticsText', () => {
  const status = {
    build: {
      version: '0.2.1',
      describe: 'v0.2.1-97-gd867b1b',
      commit: 'd867b1bc',
      installedAt: '2026-09-12T17:45:48.951Z',
    },
    printerSn: 'CC2-123',
    printerIp: '192.0.2.10',
    mqtt: 'connected',
    uptime: 3723,
    wsClients: 2,
    camera: 'available',
  };

  test('carries the full commit, not the short one: it is going into an issue', async ({ page }) => {
    const text = await diagnostics(page, status, 'TestBrowser/1.0');
    expect(text).toContain('d867b1bc');
    expect(text).toContain('0.2.1+97');
    expect(text).toContain('CC2-123');
    expect(text).toContain('TestBrowser/1.0');
  });

  test('stays readable when everything is missing', async ({ page }) => {
    const text = await diagnostics(page, null, 'TestBrowser/1.0');
    expect(text).toContain('unknown');
    expect(text.split('\n').length).toBeGreaterThan(5);
    // No stray "undefined" or "null" for a reader to puzzle over.
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });
});
