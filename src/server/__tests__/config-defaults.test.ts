import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { loadConfig } from '../config.js';

/**
 * Defaults, which are the part of `config.ts` a user actually meets (ELEG-72).
 *
 * `docs/testing.md` names this module as a high-value target with no coverage. The
 * reason it earned a test now: two of its defaults were wrong in a way that only showed
 * up once the Docker image went public, because the production `.env` sets every AI key
 * explicitly and so the defaults were never exercised on the one install anyone looks at.
 *
 * `loadConfig()` reads `process.env` directly, so these tests swap it out wholesale
 * rather than mutating keys — a stray value inherited from the developer's shell would
 * otherwise make them pass or fail for reasons unrelated to the code.
 */

const ORIGINAL = process.env;

beforeEach(() => {
  // A minimal environment: only what loadConfig() refuses to start without.
  process.env = { PRINTER_IP: '192.0.2.10' } as NodeJS.ProcessEnv;
});

afterEach(() => {
  process.env = ORIGINAL;
});

describe('AI monitoring, which no longer exists', () => {
  it('exposes no AI configuration at all', () => {
    // The whole subsystem is gone — local classification, the VLM backend, motion
    // detection, the card and the alerts. What is asserted here is the *surface*: a
    // stale AI_ENABLED or AI_VLM_* in an existing .env must be inert.
    //
    // This block used to hold four regression tests, and they are the reason it is
    // still here rather than deleted. The VLM default once pointed at a hardcoded
    // private address on the maintainer's own LAN and shipped that way in a public
    // image, so every user who turned AI on sent pictures of their printer to whatever
    // held that IP on THEIR network (ELEG-72); AI_ENABLED=true also silently switched
    // the VLM on. Both are impossible now because nothing reads the keys — but if AI
    // ever comes back, it must come back deliberately, and this test is what fails
    // first to say so.
    process.env.AI_ENABLED = 'true';
    process.env.AI_VLM_ENABLED = 'true';
    process.env.AI_VLM_BASE_URL = 'http://192.168.1.100:11434';

    const config = loadConfig() as unknown as Record<string, unknown>;
    for (const key of Object.keys(config)) {
      expect(key.startsWith('ai')).toBe(false);
    }
  });
});

describe('PRINTER_IP validation', () => {
  it('refuses a malformed address rather than starting and failing later', () => {
    process.env.PRINTER_IP = 'not-an-ip';
    expect(() => loadConfig()).toThrow(/PRINTER_IP/);
  });

  it('is required, with no fallback address (ELEG-73)', () => {
    // It used to default to a real printer on the maintainer's LAN, which shipped in a
    // public image: a user who forgot to set it got a service that started cleanly and
    // dialled a machine they had never heard of, then sat in `awaiting_sn` for ever.
    process.env.PRINTER_IP = undefined as unknown as string;
    delete process.env.PRINTER_IP;
    expect(() => loadConfig()).toThrow(/PRINTER_IP is not set/);
  });

  it('says what to do, not just what is wrong', () => {
    // The whole point of failing at startup is that the message replaces a silent hang.
    delete process.env.PRINTER_IP;
    expect(() => loadConfig()).toThrow(/192\.168\.1\.150|\.env\.example/);
  });

  it('never falls back to a private address belonging to anyone else', () => {
    delete process.env.PRINTER_IP;
    let message = '';
    try {
      loadConfig();
    } catch (err) {
      message = (err as Error).message;
    }
    // The example in the message is documentation; what must not exist is a silent
    // default. Assert the throw happened rather than a config coming back.
    expect(message).toContain('PRINTER_IP');
  });
});
