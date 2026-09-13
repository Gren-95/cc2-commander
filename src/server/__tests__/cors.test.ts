/**
 * Cross-origin policy (ELEG-24).
 *
 * A CORS check that is wrong in the *permissive* direction looks completely fine from the
 * outside — the app works, nothing errors, and the hole is invisible until someone goes
 * looking. So these assert refusal at least as hard as they assert admission.
 *
 * What was there before: `Access-Control-Allow-Origin: *` on all five surfaces, with no
 * credential to withhold, in front of `set_temperature`, `move`, `start_print`,
 * `emergency_stop`, `/api/snapshot` and `/api/stream`.
 */

import { describe, it, expect } from 'bun:test';
import { allowOriginFor, corsHeaders, parseCorsPolicy } from '../cors.js';

describe('parseCorsPolicy', () => {
  it('defaults to same-origin when unset or empty', () => {
    expect(parseCorsPolicy(undefined)).toEqual({ kind: 'none' });
    expect(parseCorsPolicy('')).toEqual({ kind: 'none' });
    expect(parseCorsPolicy('   ')).toEqual({ kind: 'none' });
  });

  it('treats a bare * as the explicit opt-in', () => {
    expect(parseCorsPolicy('*')).toEqual({ kind: 'any' });
  });

  it('parses a list, trimming whitespace and trailing slashes', () => {
    expect(parseCorsPolicy(' https://a.test/ , https://b.test ')).toEqual({
      kind: 'list',
      origins: ['https://a.test', 'https://b.test'],
    });
  });

  it('deduplicates', () => {
    expect(parseCorsPolicy('https://a.test,https://a.test')).toEqual({
      kind: 'list',
      origins: ['https://a.test'],
    });
  });
});

describe('allowOriginFor', () => {
  const list = parseCorsPolicy('https://mainsail.test,https://fluidd.test');

  it('reflects a configured origin back', () => {
    expect(allowOriginFor(list, 'https://mainsail.test')).toBe('https://mainsail.test');
  });

  it('refuses an origin that is not configured', () => {
    expect(allowOriginFor(list, 'https://evil.example')).toBeNull();
  });

  it('does not admit a prefix or suffix near-miss', () => {
    // The bug this is here to prevent: substring or startsWith matching would hand
    // https://mainsail.test.evil.example the keys.
    expect(allowOriginFor(list, 'https://mainsail.test.evil.example')).toBeNull();
    expect(allowOriginFor(list, 'https://evil.example/https://mainsail.test')).toBeNull();
    expect(allowOriginFor(list, 'mainsail.test')).toBeNull();
  });

  it('sends nothing when the policy is same-origin, whatever the request claims', () => {
    const none = parseCorsPolicy(undefined);
    expect(allowOriginFor(none, 'https://mainsail.test')).toBeNull();
    expect(allowOriginFor(none, undefined)).toBeNull();
  });

  it('sends nothing for a request with no Origin under a list policy', () => {
    // Not a cross-origin request; it needs no header.
    expect(allowOriginFor(list, undefined)).toBeNull();
  });

  it('still allows everything under the explicit * opt-in', () => {
    const any = parseCorsPolicy('*');
    expect(allowOriginFor(any, 'https://evil.example')).toBe('*');
    expect(allowOriginFor(any, undefined)).toBe('*');
  });
});

describe('corsHeaders', () => {
  it('emits no headers at all under the default policy', () => {
    const h = corsHeaders(
      parseCorsPolicy(undefined),
      'https://evil.example',
      'GET',
      'Content-Type',
    );
    expect(h).toEqual({});
  });

  it('emits the full set for an allowed origin, and Vary: Origin with it', () => {
    const h = corsHeaders(
      parseCorsPolicy('https://mainsail.test'),
      'https://mainsail.test',
      'GET, POST',
      'Content-Type',
    );
    expect(h['Access-Control-Allow-Origin']).toBe('https://mainsail.test');
    expect(h['Access-Control-Allow-Methods']).toBe('GET, POST');
    // Without Vary, a shared cache could serve one origin's response to another.
    expect(h.Vary).toBe('Origin');
  });

  it('emits nothing for a disallowed origin even when a list is configured', () => {
    expect(
      corsHeaders(parseCorsPolicy('https://mainsail.test'), 'https://evil.example', 'GET', 'X'),
    ).toEqual({});
  });

  it('never sets expose-headers', () => {
    // Asserted rather than dropped: an expose-header is how a response field becomes
    // readable cross-origin, so adding one should be a deliberate act with a caller.
    // The only one this service ever set belonged to an endpoint that is gone.
    expect(
      corsHeaders(parseCorsPolicy('*'), undefined, 'GET', 'X')['Access-Control-Expose-Headers'],
    ).toBeUndefined();
  });
});
