/**
 * The spool tile on the Canvas card.
 *
 * `spoolTile` is a pure string function, but every assertion worth making about it is
 * about escaping — and `escapeHtml` escapes by setting `textContent` on a real element
 * and reading `innerHTML` back. There is no DOM in `bun test`, so this belongs here.
 *
 * What it guards: a tray reports a filament NAME and a TYPE straight from the printer,
 * and both are interpolated into a `title` attribute and into the tile body. A spool
 * named by whoever loaded it is the one string on this card a person chooses, so it is
 * the one that has to survive a quote.
 *
 * The harness serves no stylesheet, so these assert classes and text — never computed
 * styles, which would all be zero here.
 */

import { expect, test } from '@playwright/test';

type Tray = Record<string, unknown>;

const tray = (o: Tray): Tray => ({
  brand: '',
  filament_code: '',
  filament_color: '',
  filament_name: '',
  filament_type: '',
  max_nozzle_temp: 0,
  min_nozzle_temp: 0,
  status: 0,
  tray_id: 0,
  ...o,
});

async function render(page: import('@playwright/test').Page, t: Tray, active = false) {
  return page.evaluate(
    ([t, active]) => {
      document.body.innerHTML = (
        globalThis as unknown as {
          T: { canvas: { spoolTile: (u: number, t: unknown, a: boolean) => string } };
        }
      ).T.canvas.spoolTile(0, t, active as boolean);
      const root = document.body.firstElementChild as HTMLElement;
      return {
        html: root.outerHTML,
        stateClass: root.className,
        title: root.querySelector('.canvas-spool-slot')?.getAttribute('title') ?? '',
        text: (root.textContent ?? '').replace(/\s+/g, ' ').trim(),
        load: root.querySelectorAll('.spool-load-btn').length,
        unload: root.querySelectorAll('.spool-unload-btn').length,
        buttons: root.querySelectorAll('button').length,
        nestedButtons: root.querySelectorAll('button button').length,
      };
    },
    [t, active] as const,
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
});

test.describe('spoolTile', () => {
  test('an empty slot says so, and offers no load button', async ({ page }) => {
    const r = await render(page, tray({ tray_id: 1, status: 0 }));
    expect(r.stateClass).toContain('spool-empty');
    expect(r.text).toContain('Empty');
    // "Tap to set" is the only thing telling a user the ring is clickable at all — an
    // empty Canvas is otherwise four anonymous circles.
    expect(r.text).toContain('Tap to set');
    expect(r.load).toBe(0);
    expect(r.unload).toBe(0);
  });

  test('a loaded slot shows its type and temperature range, and offers Load', async ({ page }) => {
    const r = await render(
      page,
      tray({
        tray_id: 0,
        status: 1,
        filament_type: 'PLA',
        filament_color: 'ff6b35',
        min_nozzle_temp: 190,
        max_nozzle_temp: 230,
      }),
    );
    expect(r.stateClass).toContain('spool-loaded');
    expect(r.text).toContain('PLA');
    expect(r.text).toContain('190–230°C');
    expect(r.load).toBe(1);
    expect(r.unload).toBe(0);
  });

  test('the active slot offers Unload instead, and takes the accent', async ({ page }) => {
    const r = await render(page, tray({ tray_id: 2, status: 2, filament_type: 'PETG' }), true);
    expect(r.stateClass).toContain('spool-active');
    // The accent means "engaged" and nothing else, so it is the active tile that carries it.
    expect(r.html).toContain('spool-active');
    expect(r.unload).toBe(1);
    expect(r.load).toBe(0);
  });

  test('the two controls are siblings, never nested', async ({ page }) => {
    // A button inside a button is invalid HTML and the inner one swallows clicks meant
    // for the outer. The auto-refill row on this card shipped the <label> version of
    // exactly this mistake.
    const r = await render(page, tray({ tray_id: 0, status: 1, filament_type: 'PLA' }));
    expect(r.buttons).toBe(2);
    expect(r.nestedButtons).toBe(0);
  });

  test('a filament name containing a quote cannot break out of the title attribute', async ({
    page,
  }) => {
    const r = await render(
      page,
      tray({
        tray_id: 0,
        status: 1,
        filament_type: 'PLA',
        filament_name: '" onmouseover="alert(1)',
      }),
    );
    // The whole name must survive INSIDE the attribute — if the quote escaped, the
    // parser would end `title` early and `onmouseover` would become a real handler.
    expect(r.title).toBe('" onmouseover="alert(1) — click to edit');
    expect(r.html).not.toContain('onmouseover="alert');
  });

  test('a filament type containing markup renders as text', async ({ page }) => {
    const r = await render(
      page,
      tray({ tray_id: 0, status: 1, filament_type: '<img src=x onerror=alert(1)>' }),
    );
    expect(r.html).not.toContain('<img');
    expect(r.text).toContain('<img src=x onerror=alert(1)>');
  });
});
