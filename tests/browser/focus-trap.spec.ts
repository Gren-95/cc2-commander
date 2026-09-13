/**
 * ELEG-41 — the camera overlay's focus trap, in a real browser.
 *
 * This suite used to run under `@vitest-environment jsdom` and carried a caveat:
 *
 * > jsdom does not implement inert's behaviour, so this asserts the attribute contract
 * > only; that a browser honours it is checked by hand.
 *
 * That caveat is gone. Chromium implements `inert`, so the test below presses a real Tab
 * key and asserts that focus genuinely cannot reach the button behind the overlay —
 * which is the property the trap exists for, and the one jsdom could never check.
 *
 * The safety case is not abstract: `danger-home` commands a physical machine, and it
 * sits behind an overlay the user cannot see past.
 */

import { expect, test } from '@playwright/test';

/**
 * The real shape: a dashboard containing buttons that command the machine, and a modal
 * that is a sibling deeper in the tree — not a direct child of body, which is why the
 * trap walks the whole ancestor chain.
 */
const LAYOUT = `
  <div id="app">
    <div id="dashboard">
      <button id="opener">Expand camera</button>
      <button id="danger-home">Home</button>
      <button id="danger-stop">Stop print</button>
    </div>
    <div id="camera-modal" tabindex="-1">
      <img id="camera-modal-img" alt="Camera">
      <button id="camera-modal-close">close</button>
      <button id="camera-modal-snapshot">snapshot</button>
    </div>
  </div>`;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __ready: boolean }).__ready);
  await page.evaluate((html) => {
    document.body.innerHTML = html;
  }, LAYOUT);
});

/** The id of whatever currently has focus — the assertion these tests are made of. */
const focused = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.activeElement?.id ?? null);

/** Open a trap on #camera-modal and keep its release function for later. */
async function trap(page: import('@playwright/test').Page, opts = {}): Promise<void> {
  await page.evaluate((o) => {
    const w = window as never as { T: any; __release?: () => void };
    w.__release = w.T.focusTrap.createFocusTrap(document.getElementById('camera-modal'), o);
  }, opts);
}

async function release(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as never as { __release?: () => void };
    w.__release?.();
    w.__release = undefined;
  });
}

test.describe('focusableWithin', () => {
  const ids = (page: import('@playwright/test').Page) =>
    page.evaluate(() => {
      const w = window as never as { T: any };
      return w.T.focusTrap
        .focusableWithin(document.getElementById('camera-modal'))
        .map((el: HTMLElement) => el.id);
    });

  test('finds the focusable children in order', async ({ page }) => {
    // The modal itself is tabindex="-1" and must NOT be listed: it is programmatically
    // focusable but not in the tab order, so wrapping to it would strand the user.
    expect(await ids(page)).toEqual(['camera-modal-close', 'camera-modal-snapshot']);
  });

  test('excludes disabled controls', async ({ page }) => {
    await page.evaluate(() => {
      (document.getElementById('camera-modal-snapshot') as HTMLButtonElement).disabled = true;
    });
    expect(await ids(page)).toEqual(['camera-modal-close']);
  });

  test('excludes anything marked inert or aria-hidden', async ({ page }) => {
    await page.evaluate(() =>
      document.getElementById('camera-modal-snapshot')?.setAttribute('inert', ''),
    );
    expect(await ids(page)).toEqual(['camera-modal-close']);

    await page.evaluate(() => {
      const s = document.getElementById('camera-modal-snapshot');
      s?.removeAttribute('inert');
      s?.setAttribute('aria-hidden', 'true');
    });
    expect(await ids(page)).toEqual(['camera-modal-close']);
  });
});

test.describe('createFocusTrap', () => {
  test('moves focus into the overlay when opened', async ({ page }) => {
    await page.focus('#opener');
    await trap(page);
    expect(await focused(page)).toBe('camera-modal-close');
  });

  test('wraps Tab from the last element back to the first', async ({ page }) => {
    await trap(page);
    await page.focus('#camera-modal-snapshot');
    await page.keyboard.press('Tab');
    expect(await focused(page)).toBe('camera-modal-close');
  });

  test('wraps Shift+Tab from the first element back to the last', async ({ page }) => {
    await trap(page);
    await page.focus('#camera-modal-close');
    await page.keyboard.press('Shift+Tab');
    expect(await focused(page)).toBe('camera-modal-snapshot');
  });

  test('a real Tab cannot reach the machine controls behind the overlay', async ({ page }) => {
    // The core safety property, and the one jsdom could not test: this presses the actual
    // key and lets Chromium decide where focus goes, rather than asserting that an
    // attribute was set and trusting the browser to honour it.
    await trap(page);
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      const id = await focused(page);
      expect(['camera-modal-close', 'camera-modal-snapshot', 'camera-modal']).toContain(id);
    }
  });

  test('refuses focus to the machine controls even when forced', async ({ page }) => {
    // The jsdom version of this test was called "pulls focus back if it has somehow
    // reached the page behind", and asserted that a Tab after `danger-home.focus()`
    // returned focus to the modal. In a real browser that premise cannot happen:
    // `.focus()` on an element inside an `inert` subtree is a no-op, so focus never
    // leaves the overlay in the first place. Measured — activeElement stays
    // `camera-modal-close` across the call.
    //
    // So the assertion is stronger here than it could be under jsdom, and the trap's
    // own keydown fallback is what covers the browsers that do not implement `inert`.
    await trap(page);
    await page.evaluate(() => (document.getElementById('danger-home') as HTMLElement).focus());
    expect(await focused(page)).toBe('camera-modal-close');

    await page.keyboard.press('Tab');
    expect(await focused(page)).not.toBe('danger-home');
  });

  test('marks the background inert and aria-hidden, and unmarks it on release', async ({ page }) => {
    await trap(page);
    expect(
      await page.evaluate(() => ({
        dashboardInert: document.getElementById('dashboard')?.hasAttribute('inert'),
        dashboardHidden: document.getElementById('dashboard')?.getAttribute('aria-hidden'),
        // The overlay's own subtree must never be marked.
        modalInert: document.getElementById('camera-modal')?.hasAttribute('inert'),
      })),
    ).toEqual({ dashboardInert: true, dashboardHidden: 'true', modalInert: false });

    await release(page);
    expect(
      await page.evaluate(() => ({
        inert: document.getElementById('dashboard')?.hasAttribute('inert'),
        hidden: document.getElementById('dashboard')?.hasAttribute('aria-hidden'),
      })),
    ).toEqual({ inert: false, hidden: false });
  });

  test('does not clobber an element that was already aria-hidden', async ({ page }) => {
    // Restoring such an element to "not hidden" on close would be a new bug.
    await page.evaluate(() =>
      document.getElementById('dashboard')?.setAttribute('aria-hidden', 'true'),
    );
    await trap(page);
    await release(page);
    expect(
      await page.evaluate(() => document.getElementById('dashboard')?.getAttribute('aria-hidden')),
    ).toBe('true');
  });

  test('calls onEscape and does not act on other keys', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as never as { T: any; __escapes: number; __release?: () => void };
      w.__escapes = 0;
      w.__release = w.T.focusTrap.createFocusTrap(document.getElementById('camera-modal'), {
        onEscape: () => {
          w.__escapes++;
        },
      });
    });

    await page.keyboard.press('a');
    expect(await page.evaluate(() => (window as never as { __escapes: number }).__escapes)).toBe(0);

    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (window as never as { __escapes: number }).__escapes)).toBe(1);
  });

  test('restores focus to the opener on release', async ({ page }) => {
    await page.focus('#opener');
    await trap(page);
    expect(await focused(page)).not.toBe('opener');

    await release(page);
    // Otherwise a keyboard user is dumped at the top of the document.
    expect(await focused(page)).toBe('opener');
  });

  test('stops trapping once released', async ({ page }) => {
    await trap(page);
    await release(page);

    await page.evaluate(() => (document.getElementById('danger-home') as HTMLElement).focus());
    await page.keyboard.press('Tab');
    // No longer pulled back — the trap must not outlive the overlay.
    expect(await focused(page)).not.toBe('camera-modal-close');
  });

  test('keeps focus on the container when the overlay has nothing focusable', async ({ page }) => {
    await page.evaluate(() => {
      document.body.innerHTML =
        '<div id="app"><div id="other">x</div><div id="m" tabindex="-1"></div></div>';
      const w = window as never as { T: any; __release?: () => void };
      w.__release = w.T.focusTrap.createFocusTrap(document.getElementById('m'));
    });
    await page.keyboard.press('Tab');
    expect(await focused(page)).toBe('m');
  });
});
