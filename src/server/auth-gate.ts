/**
 * Where authentication meets an HTTP request.
 *
 * `auth.ts` holds the decisions; this holds the plumbing — which paths are reachable
 * without credentials, how a request proves itself, and the three routes that mint and
 * destroy a session.
 *
 * ## The public set is deliberately tiny
 *
 * Only what a logged-out browser genuinely needs:
 *
 * - the login routes themselves, or there is no way in;
 * - `/api/auth/me`, so the SPA can ask "am I signed in?" and show a login form instead
 *   of fifteen cards of errors;
 * - `/api/health`, so a monitor or a deploy check still works — with the printer serial
 *   withheld until the caller is known, because that is an identifier for a specific
 *   machine and nothing about liveness needs it.
 *
 * Static assets are not listed because they never reach here: Bun answers them from the
 * route table built in `spa.ts`, before this code runs. That is intentional. The app
 * shell holds no secrets, and gating it would mean a login page that cannot load its own
 * stylesheet.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type AuthConfig,
  type AuthResult,
  LoginThrottle,
  SESSION_COOKIE,
  type SessionStore,
  clearedSessionCookie,
  isSecureRequest,
  readApiKey,
  readCookie,
  secretsMatch,
  sessionCookie,
  verifyPassword,
} from './auth.js';
import { getLogger } from './logger.js';

const log = getLogger('Auth');

/** Request bodies for login are tiny; anything larger is not a login. */
const MAX_LOGIN_BODY = 4096;

/** Paths that answer without credentials. Exact matches, not prefixes. */
const PUBLIC_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/health',
]);

/** Strip the query string; policy is decided on the path alone. */
export function pathOf(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

export function isPublicPath(url: string): boolean {
  return PUBLIC_PATHS.has(pathOf(url));
}

export class AuthGate {
  readonly throttle = new LoginThrottle();

  constructor(
    private readonly config: AuthConfig,
    private readonly sessions: SessionStore,
  ) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** The address used for throttling. `unknown` groups callers we cannot distinguish. */
  private addressOf(req: IncomingMessage): string {
    return req.socket?.remoteAddress || 'unknown';
  }

  private secure(req: IncomingMessage): boolean {
    return isSecureRequest(
      req.headers,
      Boolean((req.socket as { encrypted?: boolean })?.encrypted),
    );
  }

  /**
   * Who is calling.
   *
   * Session first, because it is the common case and costs a map lookup; the API key is
   * only compared when no valid session was presented, and always in constant time.
   *
   * Takes only the headers, so the :7125 server can ask about a WebSocket upgrade —
   * which never becomes a Node request — with the same code path the REST routes use.
   */
  authenticate(req: { headers: Record<string, string | string[] | undefined> }): AuthResult {
    if (!this.config.enabled) return { ok: true, via: 'disabled' };

    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (this.sessions.validate(token)) return { ok: true, via: 'session' };

    const key = readApiKey(req.headers);
    if (key) {
      if (this.config.apiKey && secretsMatch(key, this.config.apiKey)) {
        return { ok: true, via: 'apiKey' };
      }
      return { ok: false, reason: 'bad-key' };
    }

    return { ok: false, reason: token ? 'expired' : 'missing' };
  }

  /**
   * Gate a request. Returns true when the caller may proceed.
   *
   * On refusal it writes the response, so callers return immediately without touching
   * `res` again.
   */
  require(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.config.enabled) return true;
    if (isPublicPath(req.url || '')) return true;
    if (this.authenticate(req).ok) return true;

    res.writeHead(401, {
      'Content-Type': 'application/json',
      // Names the scheme a machine client should use. A browser is not offered Basic:
      // that would pop the browser's own credential dialog over the SPA's login form.
      'WWW-Authenticate': 'Bearer realm="cc2-commander"',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ error: 'Authentication required', code: 'AUTH_REQUIRED' }));
    return false;
  }

  /** Handle `/api/auth/*`. Returns true when the request was one of ours. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const path = pathOf(req.url || '');
    if (path === '/api/auth/me' && req.method === 'GET') {
      this.sendIdentity(req, res);
      return true;
    }
    if (path === '/api/auth/login' && req.method === 'POST') {
      this.handleLogin(req, res);
      return true;
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      this.handleLogout(req, res);
      return true;
    }
    return false;
  }

  private sendIdentity(req: IncomingMessage, res: ServerResponse): void {
    const result = this.authenticate(req);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        authRequired: this.config.enabled,
        authenticated: result.ok,
        via: result.ok ? result.via : null,
      }),
    );
  }

  private handleLogin(req: IncomingMessage, res: ServerResponse): void {
    if (!this.config.enabled) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication is not configured', code: 'AUTH_DISABLED' }));
      return;
    }

    const address = this.addressOf(req);
    if (!this.throttle.allows(address)) {
      const retryAfter = this.throttle.retryAfterSeconds(address);
      log.warn(`Login throttled for ${address} — ${retryAfter}s remaining`);
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
      });
      res.end(JSON.stringify({ error: 'Too many attempts', code: 'RATE_LIMITED', retryAfter }));
      return;
    }

    let body = '';
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (body.length + chunk.length > MAX_LOGIN_BODY) {
        tooLarge = true;
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      void (async () => {
        if (tooLarge) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request too large', code: 'VALIDATION_ERROR' }));
          return;
        }

        let password = '';
        try {
          const data = JSON.parse(body) as { password?: unknown };
          if (typeof data.password === 'string') password = data.password;
        } catch {
          // An unparseable body is a failed attempt like any other — it must still count
          // against the throttle, or malformed JSON becomes a free retry.
        }

        const ok =
          password.length > 0 && (await verifyPassword(password, this.config.passwordHash));
        if (!ok) {
          this.throttle.recordFailure(address);
          log.warn(`Failed login from ${address}`);
          // One message for every failure. A distinct "wrong password" vs "no password
          // supplied" tells an attacker which half they got right.
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid credentials', code: 'AUTH_INVALID' }));
          return;
        }

        this.throttle.recordSuccess(address);
        const session = this.sessions.create();
        log.info(`Login from ${address}`);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': sessionCookie(
            session.token,
            this.secure(req),
            Math.floor(this.config.absoluteTtlMs / 1000),
          ),
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ ok: true }));
      })();
    });
  }

  private handleLogout(req: IncomingMessage, res: ServerResponse): void {
    this.sessions.revoke(readCookie(req.headers.cookie, SESSION_COOKIE));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': clearedSessionCookie(this.secure(req)),
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ ok: true }));
  }

  /**
   * Whether a WebSocket upgrade may proceed.
   *
   * Cookie only, and that is not a limitation worth working around: the browser sends it
   * automatically on a same-origin upgrade, and the `WebSocket` constructor cannot set
   * headers, so a token would have to travel in the query string — where it lands in
   * access logs and `Referer`. A machine client that wants live state uses the API key
   * over HTTP, or Moonraker's socket on :7125.
   */
  allowsUpgrade(req: { headers: { cookie?: string } }): boolean {
    if (!this.config.enabled) return true;
    return this.sessions.validate(readCookie(req.headers.cookie, SESSION_COOKIE)) !== null;
  }
}
