/**
 * Deleting a file.
 *
 * This is the only control on the dashboard that destroys something the printer cannot
 * give back, and the method it sends is one digit away from `1049 UpdateToken`, which
 * writes the printer's auth token — a mistake this repo has already nearly made once
 * (see the note on 1049 in `ui/log-methods.ts`). So the payload is asserted here rather
 * than confirmed by trying it: nothing in this file talks to a printer.
 *
 * `confirm` is stubbed in both directions. The cancel case is the one worth having —
 * a confirmation that fires the command anyway is worse than no confirmation, because
 * it teaches the user the dialog is load-bearing when it is not.
 */

import { type Page, expect, test } from '@playwright/test';

type Sent = { method: number; params: Record<string, unknown> };

/** A CommandSender that records instead of sending. */
async function runDelete(
  page: Page,
  opts: { accept: boolean; filename?: string; dir?: string; source?: string },
): Promise<{ result: boolean; sent: Sent[] }> {
  return page.evaluate(async (o) => {
    const sent: Sent[] = [];
    const client = {
      sendCommand: (method: number, params: Record<string, unknown>) =>
        sent.push({ method, params }),
    };
    const original = window.confirm;
    window.confirm = () => o.accept;
    const T = (globalThis as unknown as {
      T: { files: Record<string, Function>; fileBrowsing: Record<string, Function> };
    }).T;
    const filename = o.filename ?? 'benchy.gcode';
    const dir = o.dir ?? '/';
    const result = T.files.confirmDeleteFile(
      filename,
      T.fileBrowsing.filePathFor(filename, dir),
      o.source ?? 'local',
      dir,
      client,
    );
    window.confirm = original;
    // The listing refresh is on a 500ms timer, so wait past it before reporting.
    await new Promise((r) => setTimeout(r, 700));
    return { result, sent };
  }, opts);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
});

test.describe('confirmDeleteFile', () => {
  test('sends nothing at all when the confirmation is dismissed', async ({ page }) => {
    const { result, sent } = await runDelete(page, { accept: false });
    expect(result).toBe(false);
    expect(sent).toEqual([]);
  });

  test('deletes with 1047, never 1049', async ({ page }) => {
    const { result, sent } = await runDelete(page, { accept: true });
    expect(result).toBe(true);
    expect(sent[0].method).toBe(1047);
    // 1049 is UpdateToken. Sending a delete payload there writes the printer's auth
    // token; the label table called it "DeleteHistory" for most of this repo's life.
    expect(sent.map((c) => c.method)).not.toContain(1049);
  });

  test('names the file as a one-element array under file_path', async ({ page }) => {
    const { sent } = await runDelete(page, { accept: true, filename: 'benchy.gcode' });
    expect(sent[0].params).toEqual({ storage_media: 'local', file_path: ['benchy.gcode'] });
  });

  test('deletes from the folder being browsed, not from the root', async ({ page }) => {
    // The row only knows a bare filename; the path 1044 listed it under is what 1047
    // wants. Getting this wrong deletes nothing, or the wrong thing.
    const { sent } = await runDelete(page, {
      accept: true,
      filename: 'benchy.gcode',
      dir: '/models',
    });
    expect(sent[0].params.file_path).toEqual(['models/benchy.gcode']);
  });

  test('refreshes the listing and the disk figures afterwards', async ({ page }) => {
    const { sent } = await runDelete(page, { accept: true, dir: '/models', source: 'u-disk' });
    // 1047 answers but pushes no new listing, so without these the row stays on screen
    // and the capacity bar keeps counting the bytes back.
    expect(sent.map((c) => c.method)).toEqual([1047, 1044, 1048]);
    expect(sent[1].params).toMatchObject({ storage_media: 'u-disk', dir: '/models' });
    expect(sent[2].params).toEqual({ storage_media: 'u-disk' });
  });
});

test.describe('filePathFor', () => {
  test('leaves a root-level file alone and strips the leading slash elsewhere', async ({
    page,
  }) => {
    expect(
      await page.evaluate(() => {
        const T = (globalThis as unknown as {
      T: { files: Record<string, Function>; fileBrowsing: Record<string, Function> };
    }).T;
        return [
          T.fileBrowsing.filePathFor('a.gcode', '/'),
          T.fileBrowsing.filePathFor('a.gcode', '/models'),
          T.fileBrowsing.filePathFor('a.gcode', '/models/old'),
        ];
      }),
    ).toEqual(['a.gcode', 'models/a.gcode', 'models/old/a.gcode']);
  });
});
