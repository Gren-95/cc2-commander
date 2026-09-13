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
    // parse — found when /mcp was removed and every POST to it started returning the
    // dashboard.
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(isNavigation(m), m).toBe(false);
    }
  });
});
