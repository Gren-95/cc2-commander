/**
 * ELEG-61/ELEG-22 — the list control bar's focus invariant, in a real browser.
 *
 * What is under test is the one invariant `list-controls.ts` is built around and that
 * ELEG-22 called out as most likely to be got wrong and least likely to be caught:
 *
 *   the control bar is mounted once into a STATIC container that is a sibling of the
 *   list, so re-rendering the list never rebuilds the filter input, and typing survives
 *   a WebSocket update landing mid-keystroke.
 *
 * These views assign `container.innerHTML` wholesale on every 1036 response. If the bar
 * were built inside that container, an input would be destroyed and recreated under
 * whoever was typing — losing focus, the caret and any selection.
 *
 * **NOTE ON THE FAILING DIRECTION.** A test that cannot go red is not coverage, so the
 * counterfactual is encoded permanently rather than demonstrated once by hand: the last
 * describe mounts the bar INSIDE the re-rendered container and asserts that focus IS
 * lost. If someone "simplifies" list-controls into the list container, the sibling tests
 * go red — and if someone weakens those assertions so they pass either way, the
 * counterfactual goes red instead, because it would be asserting a failure that no
 * longer happens.
 *
 * Moved from jsdom to Chromium, which matters more here than anywhere else in this
 * suite: focus, selection ranges and `document.activeElement` after a subtree is
 * replaced are exactly the behaviours a DOM emulator approximates. Now they are the
 * browser's own.
 *
 * Ids are unique per test because `ui-settings.ts` memoises the settings object in a
 * module-level `cached`, so a persisted sort from one test would otherwise leak into the
 * next — cheaper and less brittle than resetting modules.
 */

import { type Page, expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __ready: boolean }).__ready);
  await page.evaluate(() => {
    // Everything the suite needs, installed into the page once per test.
    const w = window as never as Record<string, unknown>;
    w.ROWS = [
      { name: 'benchy.gcode', size: 300, state: 'done' },
      { name: 'calibration-cube.gcode', size: 100, state: 'failed' },
      { name: 'vase.gcode', size: 200, state: 'done' },
    ];
    w.seq = 0;
    w.mountSiblingLayout = () => {
      document.body.innerHTML = '<div id="controls"></div><div id="list"></div>';
    };
    /** What every one of these views does on a WebSocket update. */
    w.renderList = (rows: { name: string }[]) => {
      (document.querySelector('#list') as HTMLElement).innerHTML = rows
        .map((r) => `<div class="row">${r.name}</div>`)
        .join('');
    };
    w.makeControls = (container: HTMLElement, onChange = () => {}) =>
      (window as never as { T: any }).T.listControls.createListControls({
        id: `test-list-${++(w.seq as number)}`,
        container,
        columns: [
          { key: 'name', label: 'Name', value: (r: any) => r.name },
          { key: 'size', label: 'Size', value: (r: any) => r.size },
        ],
        defaultSort: { key: 'name', dir: 'asc' },
        filterText: (r: any) => r.name,
        noun: 'files',
        onChange,
        selects: [
          {
            id: 'state',
            label: 'State',
            options: [
              { value: 'done', label: 'Done' },
              { value: 'failed', label: 'Failed' },
            ],
            match: (r: any, v: string) => r.state === v,
          },
        ],
      });
  });
});

/** The state that must survive: which element has focus, and the caret inside it. */
const focusState = (page: Page) =>
  page.evaluate(() => {
    const input = document.querySelector('.list-filter') as HTMLInputElement | null;
    return {
      focused: document.activeElement === input,
      value: input?.value ?? null,
      start: input?.selectionStart ?? null,
      end: input?.selectionEnd ?? null,
    };
  });

test.describe('the focus invariant', () => {
  test('keeps focus, caret and selection through a list re-render', async ({ page }) => {
    const result = await page.evaluate(() => {
      const w = window as never as any;
      w.mountSiblingLayout();
      const api = w.makeControls(document.querySelector('#controls'));
      w.renderList(api.apply(w.ROWS));

      const input = document.querySelector('.list-filter') as HTMLInputElement;
      input.focus();
      input.value = 'calibration';
      input.setSelectionRange(4, 9); // mid-word selection, the fragile case
      const focusedBefore = document.activeElement === input;

      // A 1036 response lands mid-keystroke.
      w.renderList(w.ROWS);

      return {
        focusedBefore,
        // Same node, not a rebuilt one that merely looks the same.
        sameNode: document.querySelector('.list-filter') === input,
      };
    });

    expect(result).toEqual({ focusedBefore: true, sameNode: true });
    expect(await focusState(page)).toEqual({
      focused: true,
      value: 'calibration',
      start: 4,
      end: 9,
    });
  });

  test('survives many re-renders, as a burst of updates would cause', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as never as any;
      w.mountSiblingLayout();
      w.makeControls(document.querySelector('#controls'));
      const input = document.querySelector('.list-filter') as HTMLInputElement;
      input.focus();
      input.value = 'vase';
      for (let i = 0; i < 25; i++) w.renderList(w.ROWS);
    });

    const state = await focusState(page);
    expect(state.focused).toBe(true);
    expect(state.value).toBe('vase');
  });

  test('repaints only the sort buttons when one is clicked, never the input', async ({ page }) => {
    const result = await page.evaluate(() => {
      const w = window as never as any;
      w.mountSiblingLayout();
      w.makeControls(document.querySelector('#controls'));

      const input = document.querySelector('.list-filter') as HTMLInputElement;
      const sortWrap = document.querySelector('.list-sort') as HTMLElement;
      input.focus();
      input.value = 'ben';
      input.setSelectionRange(3, 3);

      const sizeBtn = sortWrap.querySelector('[data-key="size"]') as HTMLButtonElement;
      sizeBtn.click();

      return {
        sameInput: document.querySelector('.list-filter') === input,
        // The buttons themselves DID repaint — otherwise this test would pass on a
        // control bar that simply never updates, which is not the invariant.
        buttonRepainted: sortWrap.querySelector('[data-key="size"]') !== sizeBtn,
        pressed: sortWrap.querySelector('[data-key="size"]')?.getAttribute('aria-pressed'),
      };
    });

    expect(result).toEqual({ sameInput: true, buttonRepainted: true, pressed: 'true' });
    const state = await focusState(page);
    expect(state).toEqual({ focused: true, value: 'ben', start: 3, end: 3 });
  });

  test('keeps focus when a dropdown filter changes', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as never as any;
      w.mountSiblingLayout();
      let api: any;
      api = w.makeControls(document.querySelector('#controls'), () => w.renderList(api.apply(w.ROWS)));

      const input = document.querySelector('.list-filter') as HTMLInputElement;
      const select = document.querySelector('.list-select') as HTMLSelectElement;
      input.focus();
      input.value = 'a';

      select.value = 'failed';
      select.dispatchEvent(new Event('change'));
    });

    const state = await focusState(page);
    expect(state.focused).toBe(true);
    expect(state.value).toBe('a');
  });
});

test.describe('the failure mode the sibling layout prevents', () => {
  test('loses focus and the caret when the bar is inside the re-rendered container', async ({ page }) => {
    // Deliberately WRONG: the control bar is mounted inside the container the render
    // pass overwrites. This asserts the bug is real, which is what makes the tests above
    // meaningful — if this ever passes, `renderList` has stopped destroying its children
    // and the sibling requirement no longer has teeth.
    const result = await page.evaluate(() => {
      const w = window as never as any;
      document.body.innerHTML = '<div id="list"></div>';
      const list = document.querySelector('#list') as HTMLElement;

      const bar = document.createElement('div');
      list.appendChild(bar); // <- the mistake
      w.makeControls(bar);

      const input = bar.querySelector('.list-filter') as HTMLInputElement;
      input.focus();
      input.value = 'calibration';
      input.setSelectionRange(4, 9);
      const focusedBefore = document.activeElement === input;

      w.renderList(w.ROWS);

      return {
        focusedBefore,
        stillFocused: document.activeElement === input,
        stillInDocument: document.body.contains(input),
        filterFound: list.querySelector('.list-filter') !== null,
      };
    });

    expect(result).toEqual({
      focusedBefore: true,
      stillFocused: false,
      stillInDocument: false,
      filterFound: false,
    });
  });
});

test.describe('the count readout', () => {
  test('reads "n files" unfiltered and "n of m files" when narrowing', async ({ page }) => {
    expect(
      await page.evaluate(() => {
        const w = window as never as any;
        w.mountSiblingLayout();
        const api = w.makeControls(document.querySelector('#controls'));
        const count = document.querySelector('.list-count') as HTMLElement;
        const input = document.querySelector('.list-filter') as HTMLInputElement;
        const read = () => count.textContent;

        api.apply(w.ROWS);
        const unfiltered = read();

        input.value = 'gcode';
        input.dispatchEvent(new Event('input'));
        api.apply(w.ROWS);
        const allMatch = read();

        input.value = 'vase';
        input.dispatchEvent(new Event('input'));
        api.apply(w.ROWS);
        return { unfiltered, allMatch, narrowed: read() };
      }),
    ).toEqual({ unfiltered: '3 files', allMatch: '3 of 3 files', narrowed: '1 of 3 files' });
  });

  test('says nothing at all when there is no data', async ({ page }) => {
    expect(
      await page.evaluate(() => {
        const w = window as never as any;
        w.mountSiblingLayout();
        w.makeControls(document.querySelector('#controls')).apply([]);
        return (document.querySelector('.list-count') as HTMLElement).textContent;
      }),
    ).toBe('');
  });
});

test.describe('the two empty states', () => {
  test('distinguishes "no data" from "filtered to nothing"', async ({ page }) => {
    const result = await page.evaluate(() => {
      const w = window as never as any;
      w.mountSiblingLayout();
      const api = w.makeControls(document.querySelector('#controls'));
      const before = {
        filtering: api.isFiltering(),
        html: api.emptyHtml('No files on the printer.'),
      };

      const input = document.querySelector('.list-filter') as HTMLInputElement;
      input.value = 'zzzz';
      input.dispatchEvent(new Event('input'));

      return {
        before,
        after: { filtering: api.isFiltering(), html: api.emptyHtml('No files on the printer.') },
      };
    });

    expect(result.before.filtering).toBe(false);
    expect(result.before.html).toContain('No files on the printer.');

    expect(result.after.filtering).toBe(true);
    expect(result.after.html).toContain('Nothing matches your filter');
    // The caller's message must NOT leak into the filtered state — they are different
    // facts and that is the whole point of having two.
    expect(result.after.html).not.toContain('No files on the printer.');
  });
});
