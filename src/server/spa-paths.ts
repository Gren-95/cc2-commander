/**
 * Which request paths the SPA fallback may answer with index.html.
 *
 * Split out of `spa.ts` because it is pure string logic and needs to be testable, and
 * `spa.ts` is not importable from a test: the browser tsconfig excludes `src/server`,
 * but `exclude` only filters the initial file set — an import from a covered file pulls
 * the module in anyway, and then `Bun` and `node:fs` are undefined names. This file has
 * no imports at all, so it typechecks the same in either half.
 */

/**
 * Does this path want the SPA document, or a file that should have existed?
 *
 * The fallback exists for client-side routes — `/settings`, `/files/foo` — which have no
 * file behind them and must be answered with index.html. It must NOT answer a request
 * for an asset that way. When it does, a browser asking for `/assets/index-abc123.js`
 * gets HTML with a 200 and a `text/html` content type, refuses to execute it as a module,
 * and runs no JavaScript at all: the page renders unstyled and never opens its
 * WebSocket, so it looks like the service has stopped responding.
 *
 * That state is reachable in one ordinary step, because the route table is built once at
 * startup (see the note at the top of this file): rebuild the frontend without restarting
 * the service and every hashed filename the running process advertises is gone from disk.
 * A 404 makes that loud — a failed asset in the network tab — instead of a page that
 * loads and silently does nothing.
 */
/**
 * Methods a client-side route can arrive by.
 *
 * A browser navigates with GET (and HEAD for a preflight-ish probe). Nothing else is a
 * navigation, so a POST/PUT/DELETE to an unmatched path is an API call to something that
 * does not exist — and answering it with the app's HTML at 200 is the same silent
 * failure as serving HTML for a missing script: the caller gets a success it cannot use.
 *
 * Found when an endpoint was removed. Every POST to every unknown path answered 200 with
 * the dashboard, so a client calling the deleted endpoint saw success and a body it
 * could not parse, rather than a 404 naming the problem.
 */
const NAVIGATION_METHODS = new Set(['GET', 'HEAD']);

export function isNavigation(method: string | undefined): boolean {
  return NAVIGATION_METHODS.has((method ?? 'GET').toUpperCase());
}

/**
 * Prefixes that belong to a server, not to the app's router.
 *
 * A path under one of these is an API call to something that does not exist, and the
 * right answer is 404. Without this, `GET /api/canvas` — a typo for `/api/status` —
 * answered **200 with the dashboard's HTML**: `res.ok` is true, `res.json()` then throws
 * a parse error about an unexpected `<`, and the actual problem (no such route) appears
 * nowhere. Every unknown path under every compat layer did the same.
 *
 * This is the GET twin of the POST case the note above already describes. That one was
 * fixed by checking the method; a GET to a missing endpoint is just as much an API call,
 * and the method check cannot see it.
 */
const SERVER_PREFIXES = [
  '/api/',
  '/octoprint/', // OctoPrint compat
  '/printer/', // Moonraker compat, also mounted on the main port
  '/server/',
  '/machine/',
  '/access/',
];

/**
 * Endpoints, not trees — matched exactly.
 *
 * `startsWith('/metrics')` would also claim `/metrics-dashboard`, a perfectly good
 * client-side route. The auth gate's public-path list is exact for the same reason, and
 * that one is a security boundary.
 */
const SERVER_PATHS = new Set(['/metrics', '/ws']);

export function wantsDocument(rawPath: string): boolean {
  // Callers hand this the raw request URL, which may carry a query or a fragment.
  const urlPath = rawPath.split(/[?#]/)[0];
  if (urlPath.startsWith('/assets/')) return false;
  if (SERVER_PATHS.has(urlPath)) return false;
  if (SERVER_PREFIXES.some((prefix) => urlPath.startsWith(prefix))) return false;
  const lastSegment = urlPath.slice(urlPath.lastIndexOf('/') + 1);
  const dot = lastSegment.lastIndexOf('.');
  // No extension at all is a client-side route; `.html` is the document itself. A
  // leading dot (`/.env`) is a filename that is all extension, so it counts as a file.
  if (dot === -1) return true;
  return lastSegment.slice(dot).toLowerCase() === '.html';
}
