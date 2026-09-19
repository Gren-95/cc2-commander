/**
 * Read and write the small JSON files the workshop tools keep under `DATA_DIR`.
 *
 * Written atomically (to a temporary file, then renamed over the original) because
 * some of this is data a person typed in by hand, like a spool inventory. A crash or a
 * full disk halfway through a plain `writeFile` leaves a truncated file, and the next
 * start would read nothing and carry on with an empty inventory. A rename either happens
 * or it does not; the old file survives until the new one is complete.
 *
 * `state-persistence.ts` does the same thing for its own file; this is that pattern
 * made reusable rather than copied a third time.
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { getLogger } from './logger.js';

const log = getLogger('JsonFile');

/** The parsed contents, or `null` if the file is absent or unreadable. */
export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch (err) {
    // Absent is the normal first-run case and says nothing. Present but unparseable is
    // worth a line in the log, because the caller is about to start from empty.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`Could not read ${path}: ${(err as Error).message}`);
    }
    return null;
  }
}

let tmpCounter = 0;

/**
 * Replace `path` with `data`, all or nothing. Returns whether it was written, so a caller
 * that tracks unsaved changes can keep them and try again rather than forget them.
 *
 * Each write gets its own temporary name: two overlapping writes to one file used to share
 * `<path>.tmp`, and the second could rename away the first's half-written file.
 */
export async function writeJson(path: string, data: unknown): Promise<boolean> {
  const tmp = `${path}.${process.pid}.${++tmpCounter}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await rename(tmp, path);
    return true;
  } catch (err) {
    log.error(`Could not write ${path}: ${(err as Error).message}`);
    await rm(tmp, { force: true }).catch(() => {});
    return false;
  }
}
