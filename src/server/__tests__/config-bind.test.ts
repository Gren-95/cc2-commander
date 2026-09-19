import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { loadConfig } from '../config.js';

/**
 * `BIND_ADDRESS` — the interface both HTTP servers listen on. Pinned the same way
 * `PRINTER_IP` is in `config-defaults.test.ts`: a minimal environment swapped in
 * wholesale, so a value inherited from the developer's shell cannot pass or fail these
 * for the wrong reason.
 */

const ORIGINAL = process.env;

beforeEach(() => {
  process.env = { PRINTER_IP: '192.0.2.10' } as NodeJS.ProcessEnv;
});

afterEach(() => {
  process.env = ORIGINAL;
});

describe('BIND_ADDRESS', () => {
  it('defaults to 0.0.0.0, so an existing deployment behaves as before', () => {
    expect(loadConfig().bindAddress).toBe('0.0.0.0');
  });

  it('accepts loopback', () => {
    process.env.BIND_ADDRESS = '127.0.0.1';
    expect(loadConfig().bindAddress).toBe('127.0.0.1');
  });

  it('accepts an arbitrary valid IPv4 address', () => {
    process.env.BIND_ADDRESS = '192.0.2.50';
    expect(loadConfig().bindAddress).toBe('192.0.2.50');
  });

  it('refuses a malformed value rather than passing it to listen() unchecked', () => {
    process.env.BIND_ADDRESS = 'not-an-address';
    expect(() => loadConfig()).toThrow(/BIND_ADDRESS/);
  });

  it('refuses an out-of-range octet', () => {
    process.env.BIND_ADDRESS = '999.0.0.1';
    expect(() => loadConfig()).toThrow(/BIND_ADDRESS.*octet/);
  });

  it('refuses IPv6 and says so, rather than silently mis-binding', () => {
    process.env.BIND_ADDRESS = '::';
    expect(() => loadConfig()).toThrow(/IPv6/);
  });

  it('treats an empty value as unset', () => {
    // env() counts an empty string as unset — easy to assume the opposite, and it is what
    // a `BIND_ADDRESS=` line left in a .env produces.
    process.env.BIND_ADDRESS = '';
    expect(loadConfig().bindAddress).toBe('0.0.0.0');
  });
});

describe('PRINTER_IP shares the validator', () => {
  it('still refuses an out-of-range octet by name', () => {
    process.env.PRINTER_IP = '192.0.2.300';
    expect(() => loadConfig()).toThrow(/PRINTER_IP.*octet/);
  });
});
