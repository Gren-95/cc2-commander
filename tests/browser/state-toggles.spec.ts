/**
 * `toggleState` finds its base class, or does nothing at all.
 *
 * The lookup is `el.classList.contains(base)` — **classes only, never the id**. So a
 * state-table key that names an element's id matches nothing, the delta is never
 * applied, and the call is a silent no-op: no error, no warning, no visual change. That
 * is what the upload button did, and `camera-overlay-btn`, and the Canvas connection
 * dot, each found by noticing a control that never changed rather than by anything
 * failing.
 *
 * These assert the two that were fixed, in a browser because `classList` semantics are
 * the thing under test.
 */

import { expect, test } from '@playwright/test';

type Toggle = (el: Element, state: string, on: boolean) => void;

async function applyState(
  page: import('@playwright/test').Page,
  className: string,
  state: string,
): Promise<{ before: string[]; after: string[] }> {
  return page.evaluate(
    ([cls, st]) => {
      const el = document.createElement('button');
      el.className = cls;
      document.body.appendChild(el);
      const before = [...el.classList];
      (
        globalThis as unknown as { T: { stateClasses: { toggleState: Toggle } } }
      ).T.stateClasses.toggleState(el, st, true);
      const after = [...el.classList];
      el.remove();
      return { before, after };
    },
    [className, state] as const,
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
});

test.describe('toggleState applies a delta, not just the state class', () => {
  test('the upload button actually disables', async ({ page }) => {
    // It carried `file-upload-label` as an id only, so the table key never matched and
    // the button stayed live through an upload — a second file could be started on top
    // of the one in flight.
    const { after } = await applyState(page, 'file-upload-label', 'disabled');
    expect(after).toContain('disabled');
    expect(after).toContain('pointer-events-none');
  });

  test('the debug log toggle shows that it is running', async ({ page }) => {
    const { after } = await applyState(page, 'debug-log-toggle', 'active');
    expect(after).toContain('border-accent');
    // The delta must also clear the neutral it displaces, or two utilities fight for
    // one property and Tailwind's emit order picks the winner.
    expect(after).not.toContain('border-line');
  });

  test('an element with no matching base is left alone but for the state class', async ({
    page,
  }) => {
    const { before, after } = await applyState(page, 'not-a-registered-base', 'active');
    expect(after).toEqual([...before, 'active']);
  });
});
