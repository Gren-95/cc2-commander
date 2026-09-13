/**
 * The SPA fallback must never answer an asset request with the SPA document.
 *
 * The fallback exists for client-side routes, which have no file behind them. Pointed at
 * an asset it produces the worst kind of failure: `/assets/index-abc123.js` comes back as
 * HTML with a 200, the browser refuses to execute it as a module, no JavaScript runs at
 * all, and the page renders unstyled and never opens its WebSocket. It looks exactly like
 * the service has stopped responding, and nothing in the logs says otherwise.
 *
 * It is one ordinary step away, because the static route table is built once at startup:
 * rebuild the frontend without restarting the service, and every hashed filename the
 * running process advertises is gone from disk.
 */

import { describe, expect, it } from 'bun:test';
import { isNavigation, wantsDocument } from '../server/spa-paths.js';

describe('wantsDocument', () => {
  it('serves the document for client-side routes', () => {
    for (const path of ['/', '/settings', '/files', '/files/subdir', '/about/help']) {
      expect(wantsDocument(path), path).toBe(true);
    }
  });

  it('serves the document for an explicit .html path', () => {
    expect(wantsDocument('/index.html')).toBe(true);
  });

  it('refuses every fingerprinted asset', () => {
    for (const path of [
      '/assets/index-DnLgDHlC.js',
      '/assets/index-CF6NhTmr.css',
      '/assets/bootstrap-icons-abc.woff2',
    ]) {
      expect(wantsDocument(path), path).toBe(false);
    }
  });

  it('refuses anything else that names a file', () => {
    for (const path of ['/sw.js', '/manifest.webmanifest', '/favicon.ico', '/icon-192.png']) {
      expect(wantsDocument(path), path).toBe(false);
    }
  });

  it('ignores a query string or fragment', () => {
    // Callers pass the raw request URL. Without stripping these, `/page.html?v=1` reads
    // as extension ".html?v=1" and a cache-busted asset reads as a route.
    expect(wantsDocument('/assets/index-abc.js?v=2')).toBe(false);
    expect(wantsDocument('/index.html?v=2')).toBe(true);
    expect(wantsDocument('/settings#section')).toBe(true);
  });

  it('treats a dotfile as a file, not a route', () => {
    expect(wantsDocument('/.well-known/foo')).toBe(true);
    expect(wantsDocument('/.env')).toBe(false);
  });
});

describe('isNavigation', () => {
  it('treats GET and HEAD as navigations', () => {
    for (const m of ['GET', 'HEAD', 'get', 'head']) {
      expect(isNavigation(m), m).toBe(true);
    }
    // Node leaves `method` optional on a synthetic request; default to the safe case.
    expect(isNavigation(undefined)).toBe(true);
  });

  it('refuses every method a browser cannot navigate with', () => {
    // A POST to an unmatched path is an API call to something that does not exist.
    // Answering it with the app's HTML at 200 gives the caller a success it cannot
    // parse — found when an endpoint was removed and every POST to it started returning the
    // dashboard.
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(isNavigation(m), m).toBe(false);
    }
  });
});

describe('server prefixes are never client-side routes', () => {
  // Every one of these answered 200 with the dashboard's HTML. A caller sees `res.ok`,
  // then `res.json()` throws on the leading `<`, and nothing names the real problem.
  const apiPaths = [
    '/api/canvas',
    '/api/nonexistent',
    '/api/files/typo',
    '/octoprint/bogus',
    '/printer/objects/query',
    '/server/info',
    '/machine/update/status',
    '/access/login',
    '/metrics',
    '/ws',
  ];
  for (const path of apiPaths) {
    it(`404s rather than serving the app for ${path}`, () => {
      expect(wantsDocument(path)).toBe(false);
    });
  }

  it('still serves the app for real client-side routes', () => {
    for (const path of ['/', '/settings', '/files/some-model', '/about']) {
      expect(wantsDocument(path)).toBe(true);
    }
  });

  it('does not mistake a route that merely starts with the same letters', () => {
    // `/apiary` is not `/api/`. Prefix matching that ignored the slash would take it.
    expect(wantsDocument('/apiary')).toBe(true);
    expect(wantsDocument('/servers-of-the-world')).toBe(true);
    // `/metrics` and `/ws` are endpoints, so they match exactly and claim no tree.
    expect(wantsDocument('/metrics-dashboard')).toBe(true);
    expect(wantsDocument('/wsl-notes')).toBe(true);
  });
});
