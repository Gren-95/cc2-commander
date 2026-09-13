/**
 * Single-user auth.
 *
 * These are the properties that decide whether the feature is worth anything, so they
 * are asserted rather than assumed:
 *
 * - a wrong password is refused, and guessing is throttled;
 * - a session expires on both clocks, idle and absolute;
 * - the cookie cannot be read by script and is not sent cross-site;
 * - the public path list is exact, because a prefix match on `/api/auth` would have
 *   opened every route beginning with those characters.
 *
 * The pure halves live in `src/server/auth.ts`, which imports nothing from Node's http
 * layer, so all of this runs without a server.
 */

import { describe, expect, it } from 'bun:test';
import {
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS,
  LoginThrottle,
  SESSION_COOKIE,
  SessionStore,
  clearedSessionCookie,
  hashPassword,
  isSecureRequest,
  readApiKey,
  readCookie,
  secretsMatch,
  sessionCookie,
  verifyPassword,
} from '../server/auth.js';
import { isPublicPath, pathOf } from '../server/auth-gate.js';

const HOUR = 60 * 60 * 1000;
const ttls = { absoluteTtlMs: 720 * HOUR, idleTtlMs: 168 * HOUR };

describe('passwords', () => {
  it('accepts the right one and refuses the rest', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(await verifyPassword('correct-horse-battery', hash)).toBe(true);
    expect(await verifyPassword('Correct-horse-battery', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('stores a hash, never the password', async () => {
    const hash = await hashPassword('hunter2-hunter2');
    expect(hash).not.toContain('hunter2');
    // Self-describing, so the cost parameters can be raised later without stranding
    // a hash generated today: scrypt$N$r$p$salt$key.
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash.split('$')).toHaveLength(6);
  });

  it('fails closed on a malformed hash', async () => {
    // A typo in AUTH_PASSWORD_HASH must mean nobody logs in, not everybody.
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', 'scrypt$bad$8$1$$')).toBe(false);
    expect(await verifyPassword('anything', '$argon2id$v=19$m=1$abc$def')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });
});

describe('secretsMatch', () => {
  it('compares exactly', () => {
    expect(secretsMatch('abc123', 'abc123')).toBe(true);
    expect(secretsMatch('abc123', 'abc124')).toBe(false);
    expect(secretsMatch('abc', 'abc123')).toBe(false);
    expect(secretsMatch('abc123', 'abc')).toBe(false);
  });

  it('refuses when no key is configured', () => {
    // Otherwise an unset AUTH_API_KEY would be satisfied by sending an empty key.
    expect(secretsMatch('', '')).toBe(false);
    expect(secretsMatch('anything', '')).toBe(false);
  });
});

describe('LoginThrottle', () => {
  it(`allows ${LOGIN_MAX_ATTEMPTS} attempts, then blocks`, () => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
      expect(throttle.allows('10.0.0.1')).toBe(true);
      throttle.recordFailure('10.0.0.1');
    }
    expect(throttle.allows('10.0.0.1')).toBe(false);
    expect(throttle.retryAfterSeconds('10.0.0.1')).toBeGreaterThan(0);
  });

  it('blocks one address without blocking another', () => {
    // A single global counter would let anyone lock the real user out from anywhere.
    const throttle = new LoginThrottle();
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) throttle.recordFailure('10.0.0.1');
    expect(throttle.allows('10.0.0.1')).toBe(false);
    expect(throttle.allows('10.0.0.2')).toBe(true);
  });

  it('reopens after the window', () => {
    const throttle = new LoginThrottle();
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) throttle.recordFailure('10.0.0.1', t0);
    expect(throttle.allows('10.0.0.1', t0 + LOGIN_WINDOW_MS - 1)).toBe(false);
    expect(throttle.allows('10.0.0.1', t0 + LOGIN_WINDOW_MS)).toBe(true);
  });

  it('clears the count on success', () => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS - 1; i++) throttle.recordFailure('10.0.0.1');
    throttle.recordSuccess('10.0.0.1');
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS - 1; i++) {
      expect(throttle.allows('10.0.0.1')).toBe(true);
      throttle.recordFailure('10.0.0.1');
    }
  });

  it('does not grow without bound', () => {
    const throttle = new LoginThrottle();
    const t0 = 1_000_000;
    for (let i = 0; i < 50; i++) throttle.recordFailure(`10.0.0.${i}`, t0);
    expect(throttle.size).toBe(50);
    throttle.prune(t0 + LOGIN_WINDOW_MS);
    expect(throttle.size).toBe(0);
  });
});

describe('SessionStore', () => {
  it('mints unguessable tokens', () => {
    const store = new SessionStore(ttls);
    const tokens = new Set(Array.from({ length: 200 }, () => store.create().token));
    expect(tokens.size).toBe(200);
    // 32 bytes of base64url. The guideline floor is 128 bits; this is 256.
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it('validates a live session and refuses an unknown one', () => {
    const store = new SessionStore(ttls);
    const session = store.create();
    expect(store.validate(session.token)).not.toBeNull();
    expect(store.validate('not-a-token')).toBeNull();
    expect(store.validate(undefined)).toBeNull();
  });

  it('expires on the absolute clock however active the session is', () => {
    const store = new SessionStore({ absoluteTtlMs: 10 * HOUR, idleTtlMs: 10 * HOUR });
    const t0 = 1_000_000;
    const session = store.create(t0);
    // Used constantly, so the idle clock never fires — the absolute cap still must.
    for (let t = t0; t < t0 + 10 * HOUR; t += HOUR) {
      expect(store.validate(session.token, t)).not.toBeNull();
    }
    expect(store.validate(session.token, t0 + 10 * HOUR)).toBeNull();
  });

  it('expires on the idle clock', () => {
    const store = new SessionStore({ absoluteTtlMs: 720 * HOUR, idleTtlMs: 2 * HOUR });
    const t0 = 1_000_000;
    const session = store.create(t0);
    expect(store.validate(session.token, t0 + HOUR)).not.toBeNull();
    // That use moved lastSeenAt, so the idle window restarts from there.
    expect(store.validate(session.token, t0 + 2 * HOUR)).not.toBeNull();
    expect(store.validate(session.token, t0 + 4 * HOUR + 1)).toBeNull();
  });

  it('forgets a revoked session immediately', () => {
    const store = new SessionStore(ttls);
    const session = store.create();
    store.revoke(session.token);
    expect(store.validate(session.token)).toBeNull();
  });

  it('revokeAll signs out every device', () => {
    const store = new SessionStore(ttls);
    const a = store.create();
    const b = store.create();
    store.revokeAll();
    expect(store.validate(a.token)).toBeNull();
    expect(store.validate(b.token)).toBeNull();
  });

  it('drops expired sessions rather than holding them forever', () => {
    const store = new SessionStore({ absoluteTtlMs: HOUR, idleTtlMs: HOUR });
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) store.create(t0);
    expect(store.size).toBe(20);
    store.prune(t0 + 2 * HOUR);
    expect(store.size).toBe(0);
  });
});

describe('cookies', () => {
  it('reads one cookie out of a crowd', () => {
    const header = `theme=dark; ${SESSION_COOKIE}=abc123; other=x`;
    expect(readCookie(header, SESSION_COOKIE)).toBe('abc123');
    expect(readCookie(header, 'theme')).toBe('dark');
    expect(readCookie(header, 'absent')).toBeUndefined();
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
  });

  it('is HttpOnly and SameSite=Strict', () => {
    // HttpOnly: script cannot read it, so an XSS bug is not also a stolen session.
    // SameSite=Strict: a cross-site request carries no cookie, which is the CSRF
    // defence for the whole control surface.
    const cookie = sessionCookie('tok', false, 3600);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=3600');
  });

  it('only sets Secure over TLS', () => {
    // A Secure cookie on a plain-HTTP LAN is silently dropped, which presents as
    // "login does nothing" — the least debuggable failure available.
    expect(sessionCookie('tok', true, 60)).toContain('; Secure');
    expect(sessionCookie('tok', false, 60)).not.toContain('; Secure');
  });

  it('logout expires the cookie', () => {
    expect(clearedSessionCookie(false)).toContain('Max-Age=0');
  });
});

describe('isSecureRequest', () => {
  it('trusts a terminating proxy', () => {
    expect(isSecureRequest({ 'x-forwarded-proto': 'https' }, false)).toBe(true);
    expect(isSecureRequest({ 'x-forwarded-proto': 'http' }, false)).toBe(false);
    // A proxy chain sends a list; the client's own protocol is the first entry.
    expect(isSecureRequest({ 'x-forwarded-proto': 'https, http' }, false)).toBe(true);
  });

  it('falls back to the socket', () => {
    expect(isSecureRequest({}, true)).toBe(true);
    expect(isSecureRequest({}, false)).toBe(false);
  });
});

describe('readApiKey', () => {
  it('accepts both header styles', () => {
    // X-Api-Key is what OctoPrint and Moonraker clients send; Bearer is what a generic
    // HTTP client sends. Supporting one would mean a client needing a custom build.
    expect(readApiKey({ 'x-api-key': 'k1' })).toBe('k1');
    expect(readApiKey({ authorization: 'Bearer k2' })).toBe('k2');
    expect(readApiKey({ authorization: 'bearer k3' })).toBe('k3');
  });

  it('ignores other schemes and empty values', () => {
    expect(readApiKey({ authorization: 'Basic abc' })).toBeUndefined();
    expect(readApiKey({})).toBeUndefined();
    expect(readApiKey({ 'x-api-key': '' })).toBeUndefined();
  });
});

describe('public paths', () => {
  it('opens exactly the four that must be open', () => {
    expect(isPublicPath('/api/auth/login')).toBe(true);
    expect(isPublicPath('/api/auth/logout')).toBe(true);
    expect(isPublicPath('/api/auth/me')).toBe(true);
    expect(isPublicPath('/api/health')).toBe(true);
  });

  it('does not open the control surface', () => {
    for (const path of [
      '/api/status',
      '/api/command',
      '/api/snapshot',
      '/api/stream',
      '/api/files',
      '/moonraker/printer/info',
      '/octoprint/api/job',
    ]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });

  it('matches exactly, never by prefix', () => {
    // A prefix match on '/api/health' would have opened '/api/health-secrets', and one
    // on '/api/auth' would have opened anything an attacker could name under it.
    expect(isPublicPath('/api/healthcheck')).toBe(false);
    expect(isPublicPath('/api/health/../status')).toBe(false);
    expect(isPublicPath('/api/auth/login/../../status')).toBe(false);
  });

  it('decides on the path, ignoring the query', () => {
    expect(isPublicPath('/api/health?verbose=1')).toBe(true);
    expect(isPublicPath('/api/status?x=/api/health')).toBe(false);
    expect(pathOf('/api/health?a=b#c')).toBe('/api/health');
  });
});
