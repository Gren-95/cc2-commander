/**
 * Single-user authentication.
 *
 * This service had none — see `.agents/security.md`, which is blunt about what that
 * meant: every REST route, the WebSocket, `/mcp`, and both compat layers answered any
 * request that reached the port, and the reachable surface includes `set_temperature`,
 * `move`, `start_print` and `emergency_stop`. The consequences are physical.
 *
 * ## Two credentials, because there are two kinds of client
 *
 * | | credential | who uses it |
 * | --- | --- | --- |
 * | browser | session cookie, from a password login | the dashboard |
 * | machine | API key in a header | `/mcp`, Moonraker, OctoPrint, slicers |
 *
 * A slicer cannot log in and hold a cookie, and a browser should not be made to carry a
 * long-lived bearer token in JavaScript. Each client gets the mechanism native to it.
 * The API key is deliberately a *separate* secret from the password: it is pasted into
 * config files across several machines, so it must be revocable without changing the
 * password, and it must never be derivable from it.
 *
 * ## Why it can be off
 *
 * Auth is enabled only when a password is configured. There is no safe way to default it
 * on: the service is already deployed, and a default-on with no configured password is
 * either a lockout or a service that refuses to start. Instead, an unconfigured service
 * logs a loud warning at startup naming the control surface it is leaving open.
 *
 * ## What this file does NOT do
 *
 * No user accounts, no roles, no registration, no password reset. One password, one API
 * key, both from the environment. "Single user" is the whole design, and every extra
 * concept here would be one more thing to get wrong on a service whose failure mode is a
 * hot nozzle.
 */

import { type ScryptOptions, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/** A minted session. The token is the credential; everything else is bookkeeping. */
export interface Session {
  token: string;
  /** Absolute creation time. A session is capped from here regardless of use. */
  createdAt: number;
  /** Last request that presented it, for the idle timeout. */
  lastSeenAt: number;
}

export interface AuthConfig {
  enabled: boolean;
  /** Argon2id hash of the password. Never the password itself. */
  passwordHash: string;
  /** Shared secret for machine clients. Empty disables key auth entirely. */
  apiKey: string;
  /** Hard cap on a session's life, however active it is. */
  absoluteTtlMs: number;
  /** How long a session survives without being presented. */
  idleTtlMs: number;
}

/** How the caller proved who they are, for logging and for the `/api/auth/me` reply. */
export type AuthResult =
  | { ok: true; via: 'disabled' | 'session' | 'apiKey' }
  | { ok: false; reason: 'missing' | 'expired' | 'bad-key' };

export const SESSION_COOKIE = 'elegoo_session';

/** 256 bits. The guideline floor is 128; there is no reason to be near it. */
const TOKEN_BYTES = 32;

/* ── Login throttling ────────────────────────────────────────────────── */

/** Attempts allowed per window, per client address. */
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

interface AttemptRecord {
  count: number;
  /** When the window opened. Attempts older than one window are forgotten wholesale. */
  windowStart: number;
}

/**
 * Password-guess throttling, per client address.
 *
 * In memory, which is the right scope: this is one process serving one user, and a
 * restart clearing the counters is not a meaningful bypass — an attacker cannot restart
 * the service. Keyed by address so one blocked client cannot lock the real user out from
 * somewhere else, which a single global counter would do.
 */
export class LoginThrottle {
  private readonly attempts = new Map<string, AttemptRecord>();

  /** Whether this address may try a password right now. */
  allows(address: string, now = Date.now()): boolean {
    const record = this.attempts.get(address);
    if (!record) return true;
    if (now - record.windowStart >= LOGIN_WINDOW_MS) return true;
    return record.count < LOGIN_MAX_ATTEMPTS;
  }

  /** Seconds until this address may try again; 0 when it already may. */
  retryAfterSeconds(address: string, now = Date.now()): number {
    const record = this.attempts.get(address);
    if (!record || this.allows(address, now)) return 0;
    return Math.max(1, Math.ceil((record.windowStart + LOGIN_WINDOW_MS - now) / 1000));
  }

  recordFailure(address: string, now = Date.now()): void {
    const record = this.attempts.get(address);
    if (!record || now - record.windowStart >= LOGIN_WINDOW_MS) {
      this.attempts.set(address, { count: 1, windowStart: now });
      return;
    }
    record.count += 1;
  }

  /** A correct password clears the record — the window is for guessing, not for use. */
  recordSuccess(address: string): void {
    this.attempts.delete(address);
  }

  /** Drop windows that have closed, so a scan of many addresses cannot grow this map. */
  prune(now = Date.now()): void {
    for (const [address, record] of this.attempts) {
      if (now - record.windowStart >= LOGIN_WINDOW_MS) this.attempts.delete(address);
    }
  }

  get size(): number {
    return this.attempts.size;
  }
}

/* ── Sessions ────────────────────────────────────────────────────────── */

/**
 * Live sessions, in memory only.
 *
 * Deliberately not persisted. A session token on disk is a credential at rest, in a
 * `DATA_DIR` that this same service serves reports and camera stills out of; the cost of
 * not persisting is that a restart asks for the password again, which for a service that
 * restarts on deploy is the correct trade.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly config: Pick<AuthConfig, 'absoluteTtlMs' | 'idleTtlMs'>) {}

  create(now = Date.now()): Session {
    const session: Session = {
      token: randomBytes(TOKEN_BYTES).toString('base64url'),
      createdAt: now,
      lastSeenAt: now,
    };
    this.sessions.set(session.token, session);
    return session;
  }

  /**
   * Look up a token and mark it used, or return null if it is unknown or expired.
   *
   * Both timeouts are checked here rather than on a sweep, so an expired session is
   * never honoured even if nothing has pruned it yet.
   */
  validate(token: string | undefined, now = Date.now()): Session | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (this.hasExpired(session, now)) {
      this.sessions.delete(token);
      return null;
    }
    session.lastSeenAt = now;
    return session;
  }

  private hasExpired(session: Session, now: number): boolean {
    return (
      now - session.createdAt >= this.config.absoluteTtlMs ||
      now - session.lastSeenAt >= this.config.idleTtlMs
    );
  }

  revoke(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  /** Log out everywhere. Used by the "sign out all devices" path. */
  revokeAll(): void {
    this.sessions.clear();
  }

  prune(now = Date.now()): void {
    for (const [token, session] of this.sessions) {
      if (this.hasExpired(session, now)) this.sessions.delete(token);
    }
  }

  get size(): number {
    return this.sessions.size;
  }
}

/* ── Credential checks ───────────────────────────────────────────────── */

/**
 * Constant-time secret comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the length, so
 * the lengths are compared first and both branches still do the full comparison against
 * a same-length buffer.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Compare b with itself so the work done does not depend on the input length.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * scrypt parameters. `N` dominates both cost and memory: 2^16 with r=8 needs ~64 MiB per
 * hash, which is the point — it is what makes a stolen hash expensive to attack on a GPU.
 *
 * Node's default `maxmem` is 32 MiB and would reject this, so it is raised explicitly.
 * The values are stored in the hash string rather than assumed, so raising them later
 * does not invalidate an existing `AUTH_PASSWORD_HASH`.
 */
const SCRYPT = { N: 1 << 16, r: 8, p: 1, keylen: 32, maxmem: 192 * 1024 * 1024 } as const;

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Hash a password for storage in `AUTH_PASSWORD_HASH`.
 *
 * scrypt from `node:crypto` rather than `Bun.password`'s argon2id, for one reason that
 * turned out to matter: the `Bun` global does not exist under the test runner, so the
 * argon2 version could not be tested at all — and an untested password check is the last
 * thing to want. scrypt is on the approved list, needs no dependency, and runs in both.
 *
 * The format is self-describing — `scrypt$N$r$p$salt$key`, all base64url — so the
 * parameters can be raised later without stranding hashes generated today.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT);
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/**
 * Check a password against the configured hash.
 *
 * Returns false rather than throwing on a malformed hash: a typo in `AUTH_PASSWORD_HASH`
 * must fail closed (nobody logs in) rather than open.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  try {
    const [scheme, n, r, p, saltB64, keyB64] = hash.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(keyB64, 'base64url');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await scryptAsync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ── Request-shaped helpers ──────────────────────────────────────────── */

/** Read one cookie out of a `Cookie` header. */
export function readCookie(
  header: string | string[] | undefined,
  name: string,
): string | undefined {
  // Node types a repeated header as an array. `Cookie` is not repeatable in practice,
  // but a caller passing IncomingHttpHeaders straight through must still typecheck.
  if (Array.isArray(header)) header = header[0];
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * The API key a machine client presented, from either header it might use.
 *
 * `X-Api-Key` is what OctoPrint clients and Moonraker clients send; `Authorization:
 * Bearer` is what MCP clients and anything generic sends. Both are accepted so no client
 * needs a special build.
 */
export function readApiKey(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const single = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;
  const direct = single(headers['x-api-key'])?.trim();
  if (direct) return direct;
  const auth = single(headers.authorization)?.trim();
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return undefined;
}

/**
 * Build the `Set-Cookie` value for a session.
 *
 * `Secure` is conditional because the service is routinely reached over plain HTTP on a
 * LAN, and a `Secure` cookie is silently dropped there — which presents as "login does
 * nothing", the least debuggable failure available. Behind a TLS-terminating proxy the
 * request arrives as HTTP with `X-Forwarded-Proto: https`, so that is honoured too.
 *
 * `SameSite=Strict` is the CSRF defence: a cross-site request carries no cookie at all,
 * so the control surface cannot be driven by a page the user happens to visit — the
 * exact attack `.agents/security.md` describes as surviving a LAN-only deployment.
 */
export function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** The same cookie, expired, for logout. */
export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie('', secure, 0);
}

/** Whether this request arrived over TLS, directly or through a terminating proxy. */
export function isSecureRequest(
  headers: Record<string, string | string[] | undefined>,
  encrypted: boolean,
): boolean {
  const proto = headers['x-forwarded-proto'];
  const first = Array.isArray(proto) ? proto[0] : proto;
  if (first) return first.split(',')[0].trim().toLowerCase() === 'https';
  return encrypted;
}
