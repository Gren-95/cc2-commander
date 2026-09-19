/**
 * The built SPA, served by Bun's static route table.
 *
 * `dist/` is immutable for the lifetime of a process — the container bakes it into the
 * image, and a deploy replaces the container rather than editing files underneath a
 * running one — so the whole tree is walked once at startup and turned
 * into `Bun.serve({ routes })` entries. Bun answers those from its own route table
 * without entering JavaScript at all, which is the point of the exercise: the request
 * burst a browser makes when it opens the dashboard never reaches our code.
 *
 * This replaces the hand-rolled `serveStatic()` that used to live in rest-api.ts —
 * an `existsSync` + `createReadStream` per request, with its own MIME table.
 *
 * The consequence of building the table once is that a rebuild is not picked up by a
 * running process. That is already how production works; in development `vite` serves
 * the frontend and this table is empty.
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import { getLogger } from './logger.js';
import { isNavigation, wantsDocument } from './spa-paths.js';

const log = getLogger('SPA');

const DIST_DIR = resolve(import.meta.dirname, '..', '..', 'dist');

/**
 * Vite fingerprints everything under assets/, so those may be cached forever. Anything
 * else — index.html above all — must be revalidated or a deploy is invisible.
 */
function cacheControlFor(urlPath: string): string {
  return urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
}

/**
 * Content type, from Bun rather than from a hand-kept table.
 *
 * The `serveStatic()` this replaced carried its own MIME map, which is how a table like
 * that always ends: it listed `.woff2` but not the `.wasm` a future dependency might
 * ship, and every new asset type is a silent `application/octet-stream`. Bun's own
 * inference was checked against everything vite emits here — html, css, js, svg, ico,
 * png, webmanifest, woff, woff2, map, wasm — and is right on all of them.
 */
function contentTypeFor(filePath: string): string {
  return Bun.file(filePath).type || 'application/octet-stream';
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

/** index.html, read once. Held in memory because it answers every SPA navigation. */
let indexHtml: Uint8Array | null = null;

const INDEX_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-cache',
} as const;

/**
 * Every file in dist/ as a `Bun.serve` route, keyed by URL path.
 *
 * Returns an empty table when there is no build — `bun run dev` runs the service
 * without ever calling `vite build`, and that has to keep working.
 */
export function buildStaticRoutes(): Record<string, Response> {
  const routes: Record<string, Response> = {};
  if (!existsSync(DIST_DIR)) {
    log.warn(`No dist/ at ${DIST_DIR}: frontend not served (run \`bun run build\`)`);
    return routes;
  }

  for (const filePath of walk(DIST_DIR)) {
    const urlPath = '/' + relative(DIST_DIR, filePath).split(sep).join('/');
    const headers = {
      'Content-Type': contentTypeFor(filePath),
      'Cache-Control': cacheControlFor(urlPath),
    };
    routes[urlPath] = new Response(Bun.file(filePath), { headers });
  }

  const index = join(DIST_DIR, 'index.html');
  if (existsSync(index)) {
    indexHtml = readFileSync(index);
    // "/" is not a file path, so it needs its own entry; "/index.html" already has one.
    routes['/'] = new Response(indexHtml, { headers: INDEX_HEADERS });
  }

  log.info(`Serving ${Object.keys(routes).length} static routes from ${DIST_DIR}`);
  return routes;
}

/**
 * Say so, once, when a fingerprinted asset is missing.
 *
 * The only way to reach this is a dist/ that has changed under a running process, and
 * the symptom at the browser — a page that loads and does nothing — gives no hint of the
 * cause. One line in the journal is the difference between a restart and an afternoon.
 * Rate-limited because a stale index.html asks for every asset it references.
 */
let staleAssetWarnedAt = 0;
function warnStaleAsset(urlPath: string): void {
  if (!urlPath.startsWith('/assets/')) return;
  const now = Date.now();
  if (now - staleAssetWarnedAt < 60_000) return;
  staleAssetWarnedAt = now;
  log.warn(
    `404 for ${urlPath}: the route table was built at startup and dist/ has changed since. ` +
      'Restart the service to pick up the new build.',
  );
}

/**
 * The same fallback for callers still holding a Node `ServerResponse` — rest-api.ts's
 * terminal "not an API route" branch, which behaves exactly as it did before.
 */
export function writeSpaFallback(res: ServerResponse, urlPath: string, method?: string): void {
  if (!indexHtml || !wantsDocument(urlPath) || !isNavigation(method)) {
    warnStaleAsset(urlPath);
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, INDEX_HEADERS);
  res.end(indexHtml);
}
