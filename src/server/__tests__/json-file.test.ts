/**
 * Writing the service's JSON files whole or not at all.
 *
 * `dryer.json` tells a restarted service the bed is being held hot, and `moonraker-db.json`
 * holds Mainsail's and Fluidd's settings. Both used to be written in place, so a crash half
 * way through left a truncated file that read back as "nothing": no session to turn off, or
 * no settings. These pin the replacement: a failed write keeps the old file and says so, no
 * temporary file is left behind, and saves that overlap cannot leave a broken file.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { writeJson } from '../json-file.js';
import { MoonrakerDatabase } from '../moonraker-database.js';

let dir: string;
const file = () => join(dir, 'data.json');
const leftovers = () => readdirSync(dir).filter((n) => n.endsWith('.tmp'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc2-json-'));
});
afterEach(() => {
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

describe('writeJson', () => {
  it('writes the file, says so, and leaves nothing behind', async () => {
    expect(await writeJson(file(), { a: 1 })).toBe(true);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ a: 1 });
    expect(leftovers()).toEqual([]);
  });

  it('keeps the old file whole when a write fails, and reports the failure', async () => {
    writeFileSync(file(), JSON.stringify({ kept: true }));
    chmodSync(dir, 0o555); // nothing can be created in here now
    expect(await writeJson(file(), { replaced: true })).toBe(false);
    chmodSync(dir, 0o755);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ kept: true });
    expect(leftovers()).toEqual([]);
  });

  it('leaves a whole file when writes overlap, never a mix of two', async () => {
    const big = (n: number) => ({ n, rows: Array.from({ length: 5000 }, (_, i) => ({ i, n })) });
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => writeJson(file(), big(n))));
    expect(results.every(Boolean)).toBe(true);
    const back = JSON.parse(readFileSync(file(), 'utf8'));
    expect([1, 2, 3, 4, 5]).toContain(back.n);
    expect(back.rows.every((r: { n: number }) => r.n === back.n)).toBe(true);
    expect(leftovers()).toEqual([]);
  });
});

describe('the Moonraker settings store', () => {
  it('keeps unsaved settings after a failed save, and saves them on the next try', async () => {
    const db = new MoonrakerDatabase(dir);
    await db.load();
    db.postItem('mainsail', 'theme', 'dark');
    chmodSync(dir, 0o555);
    await db.save();
    chmodSync(dir, 0o755);
    expect(existsSync(join(dir, 'moonraker-db.json'))).toBe(false);
    // Still marked unsaved: the periodic save only retries while this is set.
    expect((db as unknown as { dirty: boolean }).dirty).toBe(true);

    await db.save(); // what the 10-second tick does while there is something unsaved
    db.stop();
    const back = JSON.parse(readFileSync(join(dir, 'moonraker-db.json'), 'utf8'));
    expect(back.mainsail.theme).toBe('dark');
  });

  it('stop() resolves only once outstanding settings are on disk', async () => {
    // Shutdown awaits this before the process exits. It used to start the save and return,
    // and the exit a moment later cut it off: every restart lost the last changes.
    const db = new MoonrakerDatabase(dir);
    await db.load();
    db.postItem('fluidd', 'layout', 'compact');
    await db.stop();
    const back = JSON.parse(readFileSync(join(dir, 'moonraker-db.json'), 'utf8'));
    expect(back.fluidd.layout).toBe('compact');
  });
});
