/**
 * The sliding fill behind a segmented picker.
 *
 * Every failure here is silent: the fill sits under the wrong label, or off the end of
 * the track, and nothing throws. It is also pure layout (`offsetLeft` and `offsetWidth`
 * against real, laid-out, differently-sized labels) so there is nothing to assert
 * without a browser. jsdom reports 0 for both and would pass whatever was written.
 *
 * The track is built here rather than taken from `index.html` so the widths are known:
 * three labels of deliberately different lengths, which is the case equal-width columns
 * would get wrong and measuring gets right.
 */

import { type Page, expect, test } from '@playwright/test';

const TRACK = 'segmented';
const FILL = 'segmented-fill';
const BTN = 'segmented-btn';

/**
 * The layout the tokens in `design.ts` supply, restated as plain CSS.
 *
 * The harness serves the modules against a blank document with no stylesheet, so the
 * Tailwind classes carry no geometry there and every measurement would be zero. Stating
 * the handful of properties the maths depends on (the track establishing a containing
 * block, the fill being absolute, the labels having width) keeps this a test of
 * `positionSegmented` rather than of Tailwind's output. If the tokens ever stop
 * supplying one of these, the app breaks and this spec does not; that is what the
 * in-browser alignment check on the real page is for.
 */
const LAYOUT = `
  .segmented { position: relative; display: inline-flex; align-items: center;
               padding: 2px; font: 11px system-ui, sans-serif; }
  .segmented-fill { position: absolute; top: 2px; bottom: 2px; left: 0; }
  .segmented-btn { display: inline-flex; padding: 4px 12px; border: 0;
                   background: transparent; font: inherit; white-space: nowrap; }
`;

async function mount(page: Page, selected: number | null): Promise<void> {
  await page.evaluate(
    ([track, fill, btn, sel, css]) => {
      const labels = ['0.1mm', 'Balanced', 'Ludicrous'];
      document.body.innerHTML = `<style>${css}</style><div class="${track}" id="t">
        <div class="${fill}"></div>
        ${labels
          .map(
            (l, i) =>
              `<button class="${btn}${i === sel ? ' active' : ''}" data-i="${i}">${l}</button>`,
          )
          .join('')}
      </div>`;
      (
        window as never as { T: { segmented: { positionSegmented: (e: HTMLElement) => void } } }
      ).T.segmented.positionSegmented(document.getElementById('t') as HTMLElement);
    },
    [TRACK, FILL, BTN, selected, LAYOUT] as const,
  );
}

/** Where the fill sits, and whether it covers exactly the selected label. */
const geometry = (page: Page) =>
  page.evaluate(() => {
    const t = document.getElementById('t') as HTMLElement;
    const fill = t.querySelector('.segmented-fill') as HTMLElement;
    const active = t.querySelector('.segmented-btn.active') as HTMLElement | null;
    const fr = fill.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    const ar = active?.getBoundingClientRect() ?? null;
    return {
      opacity: getComputedStyle(fill).opacity,
      coversSelected: ar ? Math.abs(fr.left - ar.left) <= 1 && Math.abs(fr.width - ar.width) <= 1 : null,
      insideTrack: fr.left >= tr.left - 1 && fr.right <= tr.right + 1,
      fillWidth: Math.round(fr.width),
      selectedWidth: ar ? Math.round(ar.width) : null,
    };
  });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __ready: boolean }).__ready);
});

test.describe('the segmented fill', () => {
  test('covers the selected label exactly, whichever it is', async ({ page }) => {
    for (const i of [0, 1, 2]) {
      await mount(page, i);
      const g = await geometry(page);
      expect(g.coversSelected, `position ${i}`).toBe(true);
      expect(g.insideTrack, `position ${i}`).toBe(true);
    }
  });

  test('takes each label its own width, not an equal share', async ({ page }) => {
    // The reason this measures rather than using `grid-cols-3` and a 33% fill: "0.1mm"
    // and "Ludicrous" are not the same size, and forcing them to be pads the short ones
    // or truncates the long ones.
    await mount(page, 0);
    const short = (await geometry(page)).fillWidth;
    await mount(page, 2);
    const long = (await geometry(page)).fillWidth;
    expect(long).toBeGreaterThan(short);
  });

  test('hides itself when nothing is selected', async ({ page }) => {
    // Real state: the speed picker has no selection until the printer reports a mode.
    // A fill parked at position 0 would be a confident lie about the machine.
    await mount(page, null);
    expect((await geometry(page)).opacity).toBe('0');
  });

  test('re-measures when the track gets narrower', async ({ page }) => {
    await mount(page, 2);
    const before = await geometry(page);
    expect(before.coversSelected).toBe(true);

    // A narrower card rewraps the labels. `initSegmented`'s ResizeObserver is what
    // catches this in the app; here the same call is made directly, since the assertion
    // is that the maths re-derives rather than that the observer fires.
    await page.evaluate(() => {
      const t = document.getElementById('t') as HTMLElement;
      t.style.maxWidth = '140px';
      t.style.flexWrap = 'wrap';
      (
        window as never as { T: { segmented: { positionSegmented: (e: HTMLElement) => void } } }
      ).T.segmented.positionSegmented(t);
    });
    const after = await geometry(page);
    expect(after.coversSelected).toBe(true);
    expect(after.insideTrack).toBe(true);
  });
});
