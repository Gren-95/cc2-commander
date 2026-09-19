/**
 * Custom steppers, replacing the browser's own number spinner.
 *
 * The native control is two 8px arrows inside the field: unhittable on a touchscreen,
 * hover-only in Chrome, absent on iOS, and different in every browser. What replaces it
 * has to behave at least as well, and the parts worth pinning down are the ones a
 * hand-rolled stepper usually gets wrong: clamping, an empty field, decimal steps, and
 * telling the app the value moved.
 *
 * In a browser because the enhancement is DOM surgery: the input is MOVED into a wrapper
 * so the listeners already bound to it survive, and a MutationObserver re-enhances
 * anything re-rendered. jsdom would run it, but it would not catch the two things that
 * actually broke: double-wrapping, and a re-render silently dropping the buttons.
 */

import { type Page, expect, test } from '@playwright/test';

async function mount(page: Page, attrs: string): Promise<void> {
  await page.evaluate((a) => {
    document.body.innerHTML = `<div id="host"><input type="number" id="n" ${a}></div>`;
    (window as never as { T: { stepper: { initSteppers: (r?: ParentNode) => void } } })
      .T.stepper.initSteppers(document);
  }, attrs);
}

const value = (page: Page) => page.$eval('#n', (el) => (el as HTMLInputElement).value);
const press = (page: Page, which: 0 | 1) =>
  page.evaluate((i) => {
    const btn = document.querySelectorAll<HTMLButtonElement>('.stepper-btn')[i];
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }, which);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __ready: boolean }).__ready);
});

test.describe('the stepper', () => {
  test('wraps the field without replacing it, so listeners survive', async ({ page }) => {
    await mount(page, 'min="0" max="100" step="5" value="10"');
    expect(
      await page.evaluate(() => {
        const input = document.getElementById('n') as HTMLInputElement;
        let fired = 0;
        input.addEventListener('change', () => fired++);
        (document.querySelectorAll<HTMLButtonElement>('.stepper-btn')[1]).dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true }),
        );
        return { fired, sameNode: document.getElementById('n') === input };
      }),
    ).toEqual({ fired: 1, sameNode: true });
  });

  test('asks for the native spinner to be hidden, and drops the double frame', async ({
    page,
  }) => {
    // The classes, not the computed style: the harness serves no stylesheet, so nothing
    // Tailwind emits applies here and `appearance` would read `auto` however correct the
    // module is. That the rule reaches the page is checked on the real build instead:
    // measured `appearance: textfield` there.
    await mount(page, 'min="0" max="10" step="1" value="5"');
    const cls = await page.$eval('#n', (el) => [...el.classList]);
    expect(cls).toContain('[appearance:textfield]');
    expect(cls).toContain('[&::-webkit-inner-spin-button]:appearance-none');
    // The group carries the frame now; leaving it on the input draws two boxes.
    expect(cls).not.toContain('border');
    expect(cls).not.toContain('bg-input');
    expect(await page.$eval('.stepper', (el) => [...el.classList])).toContain('border');
  });

  test('clamps at both ends and disables the button that cannot act', async ({ page }) => {
    await mount(page, 'min="0" max="10" step="5" value="5"');
    await press(page, 1);
    expect(await value(page)).toBe('10');
    await press(page, 1); // already at max
    expect(await value(page)).toBe('10');
    expect(await page.$eval('.stepper-btn:last-of-type', (b) => (b as HTMLButtonElement).disabled)).toBe(true);

    await press(page, 0);
    await press(page, 0);
    expect(await value(page)).toBe('0');
    expect(await page.$eval('.stepper-btn', (b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  test('steps an empty field to its minimum, not to NaN or a surprising zero', async ({
    page,
  }) => {
    // The bed field starts blank. `'' + 5` is not 5, and `Number('')` is 0, which for a
    // field whose min is 40 would offer an illegal value the printer then rejects.
    await mount(page, 'min="40" max="120" step="5" value=""');
    await press(page, 1);
    expect(await value(page)).toBe('40');
  });

  test('keeps the decimals the step implies', async ({ page }) => {
    // 0.5-hour steps in the dryer. Floating point makes 4 + 0.5 + 0.5 print as
    // 5.000000000000001 if the result is not fixed to the step's precision.
    await mount(page, 'min="0.5" max="24" step="0.5" value="4"');
    await press(page, 1);
    await press(page, 1);
    expect(await value(page)).toBe('5.0');
  });

  test('re-enhances a field that was re-rendered, and never double-wraps', async ({
    page,
  }) => {
    // The spool calculator rebuilds its whole form on every keystroke, throwing the
    // wrapper away and putting a bare input back. This is why the module observes.
    await mount(page, 'min="0" max="10" step="1" value="1"');
    await page.evaluate(() => {
      const host = document.getElementById('host') as HTMLElement;
      host.innerHTML = '<input type="number" id="n" min="0" max="10" step="1" value="1">';
    });
    await page.waitForTimeout(150);
    expect(
      await page.evaluate(() => ({
        wrapped: !!document.getElementById('n')?.closest('.stepper'),
        groups: document.querySelectorAll('.stepper').length,
        buttons: document.querySelectorAll('.stepper-btn').length,
      })),
    ).toEqual({ wrapped: true, groups: 1, buttons: 2 });
  });
});
