/**
 * Deploy-stamp reader (ELEG-10).
 *
 * The point of the stamp is to answer "is this change live?" from `/api/health`, so the
 * reader must never be the thing that breaks that endpoint. These cases are the three
 * the issue names (present, absent, malformed) plus the two shapes a hand-edited or
 * half-written stamp actually takes: valid JSON that is not an object, and an object
 * with fields missing or blank.
 *
 * Lives under `src/server/` for the same reason as the other server tests: `tsconfig.json`
 * excludes this directory, so importing server code from `src/__tests__/` would drag
 * Node-only modules into the browser typecheck. Here it is covered by
 * `pnpm service:check`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * The reader's only observable output besides the BuildInfo is a warning, and that
 * warning is the entire difference between "malformed" and "absent": both return the
 * same all-null value. Stubbing the logger is what makes the shape checks in
 * `readBuildInfo` assertable rather than merely present.
 */
const warn = mock();
mock.module('../logger.js', () => ({ getLogger: () => ({ warn }) }));

// Imported dynamically, and that is load-bearing: a static `import` is hoisted above
// `mock.module`, so the real logger would already be bound by the time the stub was
// registered. Vitest hid this with `vi.hoisted`; bun:test is explicit about it instead.
const { BUILD_INFO_PATH, UNKNOWN_BUILD_INFO, readBuildInfo } = await import('../build-info.js');

let dir: string;

/** Write a stamp file and return its path. */
function stamp(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents, 'utf8');
  return path;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'elegoo-build-info-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  warn.mockClear();
});

describe('readBuildInfo', () => {
  it('reads every field from a well-formed stamp', () => {
    const path = stamp(
      'good.json',
      JSON.stringify({
        commit: 'a8157a9f0e1b2c3d4e5f60718293a4b5c6d7e8f9',
        shortCommit: 'a8157a9',
        describe: 'v1.4.0-3-ga8157a9',
        version: '1.4.0',
        installedAt: '2026-08-07T12:00:00Z',
      }),
    );

    expect(readBuildInfo(path)).toEqual({
      commit: 'a8157a9f0e1b2c3d4e5f60718293a4b5c6d7e8f9',
      shortCommit: 'a8157a9',
      describe: 'v1.4.0-3-ga8157a9',
      version: '1.4.0',
      installedAt: '2026-08-07T12:00:00Z',
    });
  });

  it('returns the explicit unknown quietly when the file is absent', () => {
    // The normal case for `pnpm dev` and for any deploy predating the stamp, so it must
    // not warn: an unstamped dev run is not a fault.
    expect(readBuildInfo(join(dir, 'does-not-exist.json'))).toEqual(UNKNOWN_BUILD_INFO);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the explicit unknown and warns when the file is malformed', () => {
    expect(readBuildInfo(stamp('truncated.json', '{"commit": "a8157a9"'))).toEqual(
      UNKNOWN_BUILD_INFO,
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns the explicit unknown and warns for valid JSON that is not an object', () => {
    // `JSON.parse` accepts all three. Without the shape check two of them would read as
    // an all-null stamp *silently*: indistinguishable from a dev run, which is exactly
    // the confusion the stamp exists to remove. The warning is the load-bearing part
    // here, not the return value.
    for (const [name, contents] of [
      ['array.json', '["a8157a9"]'],
      ['null.json', 'null'],
      ['string.json', '"a8157a9"'],
    ]) {
      warn.mockClear();
      expect(readBuildInfo(stamp(name, contents))).toEqual(UNKNOWN_BUILD_INFO);
      // The loop body names the case, since bun:test's expect takes no message.
      expect(warn.mock.calls.length).toBe(1);
    }
  });

  it('nulls fields that are missing, blank, or the wrong type', () => {
    // A partial stamp is what an installer running outside a checkout writes.
    const path = stamp(
      'partial.json',
      JSON.stringify({ commit: 'a8157a9', shortCommit: '', version: 42 }),
    );

    expect(readBuildInfo(path)).toEqual({
      ...UNKNOWN_BUILD_INFO,
      commit: 'a8157a9',
    });
  });

  it('never throws, whatever it is handed', () => {
    for (const contents of ['', 'not json at all', '{{{', '\0']) {
      expect(() => readBuildInfo(stamp('junk.json', contents))).not.toThrow();
    }
  });

  it('resolves the default path to the install root, not the cwd', () => {
    // The service reads this from the app root's `build-info.json`, outside src/ so
    // nothing that replaces src/ alone can reach it (ELEG-11). Anchoring on the module
    // location rather than process.cwd() is the load-bearing part.
    const root = join(import.meta.dirname, '..', '..', '..');
    expect(BUILD_INFO_PATH).toBe(join(root, 'build-info.json'));
  });
});
