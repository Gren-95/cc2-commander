/**
 * The MQTT phase as a human actually sees it (ELEG-59).
 *
 * The pure decisions (which phase, whether to warn) are tested in `types.test.ts`
 * under `bun test`. What is asserted here is the wiring: that the phase reaches the
 * badge and the banner, that the two previously-indistinguishable states now read
 * differently on the page, and that a browser holding a pre-ELEG-59 payload still
 * renders something sensible.
 *
 * This is the layer where the incident actually happened: the classifier could have been
 * perfect and it would still have cost a journal read if the page kept saying
 * `registering…`.
 */

import { type Page, expect, test } from '@playwright/test';

/** The ids `renderServiceStatus` looks up, and nothing more. */
const SHELL = `
  <div id="svc-header-wrap">
    <div id="svc-header-badge">
      <i class="bi" id="svc-printer-icon"></i>
      <span id="svc-printer-state"></span>
      <span id="svc-header-dots"></span>
      <span id="svc-header-count"></span>
    </div>
    <div id="svc-dropdown" class="hidden"><div id="service-status"></div></div>
  </div>`;

const BASE = {
  uptime: 120,
  mqtt: 'broker_only',
  mqttRegisterAttempts: 0,
  printerSn: null,
  printerIp: '192.0.2.10',
  wsClients: 1,
  telegram: 'disabled',
  ai: 'disabled',
  camera: 'available',
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __ready: boolean }).__ready);
  await page.evaluate(
    ({ shell, base }) => {
      const w = window as never as Record<string, unknown>;
      w.BASE = base;
      w.mount = () => {
        document.body.innerHTML = shell;
      };
      w.render = (over: Record<string, unknown>) =>
        (window as never as { T: any }).T.serviceStatus.updateServiceStatus({ ...base, ...over });
      w.link = (state: string) =>
        (window as never as { T: any }).T.serviceStatus.setPrinterLink(state);
    },
    { shell: SHELL, base: BASE },
  );
});

/** Mount, render one status, and read back what the panel says. */
async function panelAfter(page: Page, over: Record<string, unknown>) {
  return await page.evaluate((o) => {
    const w = window as never as any;
    w.mount();
    w.render(o);
    const panel = document.querySelector('#service-status') as HTMLElement;
    return {
      text: panel.textContent ?? '',
      hasWarning: panel.querySelector('.svc-firmware-warning') !== null,
    };
  }, over);
}

test.describe('the two broker_only states no longer look identical', () => {
  test('says the printer is not responding when no SN was ever discovered', async ({ page }) => {
    const { text } = await panelAfter(page, { mqttPhase: 'awaiting_sn', mqttRegisterAttempts: 0 });

    // The incident: registration was never even attempted, so attempts is 0.
    expect(text).toContain('waiting for printer');
    expect(text).toContain('Printer not responding');
    expect(text).toMatch(/power cycle/i);
    // And crucially it must NOT claim to be registering, which is what sent the
    // 2026-08-08 diagnosis at the service instead of at the printer.
    expect(text).not.toContain('registering...');
  });

  test('says the registration was refused, and why, when the printer said code 3', async ({ page }) => {
    const { text } = await panelAfter(page, { mqttPhase: 'rejected', mqttRegisterAttempts: 4 });
    expect(text).toContain('refused');
    expect(text).toContain('Registration refused');
    expect(text).toMatch(/two clients/i);
  });

  test('renders the two phases differently: the whole point of the change', async ({ page }) => {
    const { awaiting, rejected } = await page.evaluate(() => {
      const w = window as never as any;
      w.mount();
      const panel = document.querySelector('#service-status') as HTMLElement;
      w.render({ mqttPhase: 'awaiting_sn' });
      const awaiting = panel.textContent ?? '';
      w.render({ mqttPhase: 'rejected' });
      return { awaiting, rejected: panel.textContent ?? '' };
    });

    expect(awaiting).not.toBe(rejected);
  });
});

test.describe('the banner threshold', () => {
  test('stays quiet during a normal young registration', async ({ page }) => {
    const { text, hasWarning } = await panelAfter(page, {
      mqttPhase: 'registering',
      mqttRegisterAttempts: 1,
    });
    expect(text).toContain('registering...');
    expect(hasWarning).toBe(false);
  });

  test('warns once registration has been retried enough to be a problem', async ({ page }) => {
    const { text, hasWarning } = await panelAfter(page, {
      mqttPhase: 'registering',
      mqttRegisterAttempts: 7,
    });
    expect(hasWarning).toBe(true);
    expect(text).toContain('7 registration attempts');
  });

  test('shows no banner at all when connected', async ({ page }) => {
    const { text, hasWarning } = await panelAfter(page, {
      mqtt: 'connected',
      mqttPhase: 'connected',
      printerSn: 'ABC123',
    });
    expect(hasWarning).toBe(false);
    expect(text).toContain('connected');
  });
});

test.describe('a browser holding a payload from before this shipped', () => {
  test('falls back to the coarse mqtt field rather than rendering undefined', async ({ page }) => {
    // No mqttPhase key at all: exactly what an old server sends.
    const { text } = await panelAfter(page, {
      mqttPhase: undefined,
      mqtt: 'broker_only',
      mqttRegisterAttempts: 0,
    });
    expect(text).toContain('registering...');
    expect(text).not.toContain('undefined');
  });

  test('still reports a plain disconnect', async ({ page }) => {
    const { text, hasWarning } = await panelAfter(page, {
      mqttPhase: undefined,
      mqtt: 'disconnected',
    });
    expect(text).toContain('disconnected');
    expect(hasWarning).toBe(false);
  });
});

test.describe('the running version in the panel (ELEG-48)', () => {
  /** The row for a named fact, and which status dot it carries. */
  const versionRow = (page: Page, over: Record<string, unknown>) =>
    page.evaluate((o) => {
      const w = window as never as any;
      w.mount();
      w.render(o);
      const panel = document.querySelector('#service-status') as HTMLElement;
      const row = [...panel.querySelectorAll('.svc-item')].find((r) =>
        r.textContent?.includes('Version'),
      );
      return {
        text: row?.textContent ?? '',
        ok: row?.querySelector('.status-dot-ok') !== null,
        err: row?.querySelector('.status-dot-err') !== null,
        panelText: panel.textContent ?? '',
      };
    }, over);

  test('renders x.y.z+aa from the deploy stamp', async ({ page }) => {
    const { panelText } = await versionRow(page, {
      mqtt: 'connected',
      mqttPhase: 'connected',
      build: { describe: 'v0.2.1-58-g5b00442', version: '0.2.1' },
    });
    expect(panelText).toContain('Version');
    expect(panelText).toContain('0.2.1+58');
  });

  test('says "unknown" on an unstamped build, and never renders null', async ({ page }) => {
    // Normal for a dev run, and for a deploy where the installer never re-ran. The issue
    // is explicit that this must not render `null+null`.
    const { panelText } = await versionRow(page, {
      mqtt: 'connected',
      mqttPhase: 'connected',
      build: null,
    });
    expect(panelText).toContain('unknown');
    expect(panelText).not.toContain('null');
  });

  test('marks an unstamped build as not-ok, because it is a real gap', async ({ page }) => {
    const row = await versionRow(page, { mqtt: 'connected', mqttPhase: 'connected', build: null });
    expect(row.err).toBe(true);
  });

  test('marks a stamped build ok', async ({ page }) => {
    const row = await versionRow(page, {
      mqtt: 'connected',
      mqttPhase: 'connected',
      build: { describe: 'v0.3.0' },
    });
    expect(row.ok).toBe(true);
    expect(row.text).toContain('0.3.0');
  });

  test('survives a browser holding a payload from before this shipped', async ({ page }) => {
    const { panelText } = await versionRow(page, {
      mqtt: 'connected',
      mqttPhase: 'connected',
      build: undefined,
    });
    expect(panelText).toContain('unknown');
  });
});

/**
 * The printer link, which used to be a separate "Disconnected" pill in the header.
 *
 * Folding it into this badge is only an improvement if the collapsed badge actually
 * answers the question the pill answered, so that is what is asserted here, including
 * the case the pill handled badly: the link is known before the first `service_status`
 * broadcast arrives, and the badge has to show it rather than sit blank.
 */
test.describe('printer link on the collapsed badge', () => {
  const badgeState = (page: Page) =>
    page.evaluate(() => {
      const badge = document.querySelector('#svc-header-badge') as HTMLElement;
      return {
        classes: [...badge.classList].filter((c) => c.startsWith('svc-printer-')),
        caption: (document.querySelector('#svc-printer-state') as HTMLElement).textContent,
        ariaLabel: badge.getAttribute('aria-label') ?? '',
        icon: (document.querySelector('#svc-printer-icon') as HTMLElement).className,
      };
    });

  test('shows the link before any service_status has arrived', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as never as any;
      w.mount();
      w.link('disconnected');
    });
    const state = await badgeState(page);
    expect(state.classes).toContain('svc-printer-disconnected');
    expect(state.caption).toBe('Disconnected');
  });

  test('drops the caption when connected, because steady state needs none', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as never as any;
      w.mount();
      w.link('connected');
    });
    const state = await badgeState(page);
    expect(state.classes).toContain('svc-printer-connected');
    expect(state.caption).toBe('');
    // …but the state is still available to a screen reader and on hover.
    expect(state.ariaLabel).toContain('Printer connected');
  });

  test('changes the glyph as well as the colour', async ({ page }) => {
    // Colour alone would be invisible to a colour-blind reader and on a mono display.
    const { connected, disconnected } = await page.evaluate(() => {
      const w = window as never as any;
      w.mount();
      const icon = () => (document.querySelector('#svc-printer-icon') as HTMLElement).className;
      w.link('connected');
      const connected = icon();
      w.link('disconnected');
      return { connected, disconnected: icon() };
    });

    expect(connected).not.toBe(disconnected);
    expect(connected).toContain('bi-printer-fill');
    expect(disconnected).toContain('bi-plug');
  });

  test('holds exactly one printer state class at a time', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as never as any;
      w.mount();
      w.link('connecting');
      w.link('connected');
    });
    expect((await badgeState(page)).classes).toEqual(['svc-printer-connected']);
  });

  test('keeps the link when a service_status render follows', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as never as any;
      w.mount();
      w.link('disconnected');
      w.render({ mqtt: 'connected', printerSn: 'CC2-123' });
    });
    const state = await badgeState(page);
    expect(state.classes).toContain('svc-printer-disconnected');
    expect(state.caption).toBe('Disconnected');
  });
});

test.describe('the header count', () => {
  /** Mount, render one status, and read back the badge. */
  const badgeAfter = (page: Page, over: Record<string, unknown>) =>
    page.evaluate((o) => {
      const w = window as never as any;
      w.mount();
      w.render(o);
      const badge = document.getElementById('svc-header-badge') as HTMLElement;
      return {
        count: document.getElementById('svc-header-count')?.textContent ?? '',
        dots: document.getElementById('svc-header-dots')?.children.length ?? 0,
        title: badge.title,
      };
    }, over);

  const healthy = { mqtt: 'connected', printerSn: 'TESTSN000000001', camera: 'available' };

  test('does not count an integration nobody switched on as a fault', async ({ page }) => {
    // Telegram not configured is how every install without a bot looks. It used to read
    // as a permanent red "3/4".
    const b = await badgeAfter(page, { ...healthy, telegram: 'disabled' });
    expect(b.count).toBe('3/3');
    expect(b.dots).toBe(3);
    expect(b.title).toBe('All 3 services OK. Click for details');
  });

  test('counts it once it is switched on', async ({ page }) => {
    expect((await badgeAfter(page, { ...healthy, telegram: 'running' })).count).toBe('4/4');
  });

  test('names what is wrong, when something is', async ({ page }) => {
    const b = await badgeAfter(page, { ...healthy, telegram: 'stopped', camera: 'unavailable' });
    expect(b.count).toBe('2/4');
    expect(b.title).toBe('2 of 4 services OK. Not OK: Telegram, Camera');
  });
});
