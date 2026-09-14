/**
 * Read and write the small JSON files the workshop tools keep under `DATA_DIR`.
 *
 * Written atomically — to a temporary file, then renamed over the original — because
 * some of this is data a person typed in by hand, like a spool inventory. A crash or a
 * full disk halfway through a plain `writeFile` leaves a truncated file, and the next
 * start would read nothing and carry on with an empty inventory. A rename either happens
 * or it does not; the old file survives until the new one is complete.
 *
 * `state-persistence.ts` does the same thing for its own file; this is that pattern
 * made reusable rather than copied a third time.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
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

export async function writeJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await rename(tmp, path);
  } catch (err) {
    log.error(`Could not write ${path}: ${(err as Error).message}`);
  }
}
