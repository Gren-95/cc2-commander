/*
 * Service worker for the Elegoo Web dashboard.
 *
 * WHAT THE PREVIOUS ONE DID
 *
 * Nothing useful. `install` called `skipWaiting()` and cached not a single thing, so
 * the `fetch` handler's `caches.match()` fallback could only ever miss, and on a miss
 * it resolved `undefined`, which `respondWith(undefined)` turns into a TypeError rather
 * than a page. Measured: with the worker registered and controlling, a reload with the
 * network cut failed outright with ERR_FAILED. The app was installable and offline-dead.
 *
 * WHAT THIS ONE DOES
 *
 * The asset filenames are fingerprinted by vite and this file is a static asset that
 * cannot know them, so there is no precache manifest. Instead the shell is captured as
 * it is used: the first successful load populates the cache, and every load after that
 * survives the network going away.
 *
 * Strategy per request, and the reasoning matters more than the code:
 *
 *   live endpoints   NOT HANDLED AT ALL. /api, /ws, /mcp, /octoprint, /moonraker and
 *                    /webcam are a live printer. A stale temperature is worse than no
 *                    temperature, and a cached camera frame is a lie. These are not
 *                    passed to respondWith, so the browser handles them normally.
 *   /assets/*        Cache-first. Vite fingerprints these and the server sends
 *                    `immutable`, so a hit is always correct and never needs revalidating.
 *   navigations      Network-first, falling back to the cached shell, then to the
 *                    offline page below. Network-first because a deploy should be
 *                    picked up on the next load, not the one after.
 *   everything else  Stale-while-revalidate: manifest, icons. Served instantly, updated
 *                    in the background.
 */

/*
 * Bumping this name is how a stale cache is evicted: `activate` deletes every cache
 * whose name is not this one. The rename from `elegoo-web-v2` therefore does two jobs:
 * it finishes the project rename, and it purges the assets every existing client has
 * accumulated under `cacheFirst`, which never evicts an entry on its own.
 */
const CACHE = 'cc2-commander-v1';

/** Fetched by hand at install; everything else arrives as it is requested. */
const SEED = ['/manifest.json'];

/** Fingerprinted build output, as referenced from the shell and from its stylesheets. */
const ASSET_REF = /\/assets\/[A-Za-z0-9._-]+/g;

/** Prefixes that must never be served from a cache. See the header. */
const LIVE = ['/api/', '/ws', '/mcp', '/octoprint', '/moonraker', '/webcam'];

const OFFLINE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline: Elegoo Web</title>
<style>
  :root { color-scheme: dark light }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.5 system-ui,sans-serif; background:#0f1117; color:#e6e6e6 }
  .box { max-width:32rem; padding:2rem; text-align:center }
  h1 { font-size:1.25rem; margin:0 0 .5rem }
  p { margin:0 0 1.5rem; color:#9b9db0 }
  button { font:inherit; padding:.6rem 1.2rem; border:0; border-radius:8px;
           background:#2563eb; color:#fff; cursor:pointer }
</style></head>
<body><div class="box">
  <h1>Offline</h1>
  <p>This device cannot reach the Elegoo Web service. The printer is probably still
     printing: this dashboard just cannot see it from here.</p>
  <button onclick="location.reload()">Try again</button>
</div></body></html>`;

const offlineResponse = () =>
  new Response(OFFLINE_PAGE, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/**
 * Precache the shell and the assets it names.
 *
 * Without this the worker is only useful from the SECOND visit: a service worker does
 * not control the page that registers it, so the stylesheet and script requests of the
 * first load are never intercepted and never cached. Measured: after one visit the
 * cache held `/` and the manifest and nothing else, and the app appeared to work
 * offline purely because Chrome's own HTTP cache still had the immutable assets. That
 * is luck, not offline support.
 *
 * So the shell is read at install time and the `/assets/…` references are pulled out of
 * it. Stylesheets are read too, because the Bootstrap Icons woff2 is referenced from
 * the CSS and not from the HTML: miss it and a first-visit offline load renders every
 * control as a blank box.
 */
async function precacheShell(cache) {
  const shell = await fetch('/', { cache: 'reload' });
  if (!shell.ok) return;
  const html = await shell.clone().text();
  await cache.put('/', shell);

  const refs = new Set(html.match(ASSET_REF) ?? []);

  // One level of indirection is enough: HTML names the CSS, the CSS names the font.
  for (const ref of [...refs]) {
    if (!ref.endsWith('.css')) continue;
    try {
      const css = await fetch(ref);
      if (!css.ok) continue;
      for (const nested of (await css.text()).match(ASSET_REF) ?? []) refs.add(nested);
    } catch {
      // A stylesheet we cannot read just means fewer precached assets.
    }
  }

  // Individually, not `addAll`: that rejects the whole batch on one failure, which
  // would leave the worker uninstalled over a single missing file.
  await Promise.all([...refs].map((url) => cache.add(url).catch(() => {})));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await Promise.all(SEED.map((url) => cache.add(url).catch(() => {})));
      await precacheShell(cache).catch(() => {});
    }),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

/** Only ever cache a real, same-origin, complete response. */
function cacheable(response) {
  return response && response.status === 200 && response.type === 'basic';
}

async function cacheFirst(request) {
  /*
   * `ignoreSearch` matters here. Vite's CSS references the icon font as
   * `/assets/bootstrap-icons-<hash>.woff2?<another hash>`, while the precache stored it
   * under the bare path it found in the stylesheet text. Without this the two are
   * different cache keys, the lookup misses, and a first-visit-offline load renders
   * every icon as a blank box: the exact failure the precache exists to prevent.
   *
   * Safe because everything under /assets/ is content-hashed in the path itself, so the
   * query string cannot distinguish two different files.
   */
  const hit = await caches.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (cacheable(response)) {
    const copy = response.clone();
    caches.open(CACHE).then((c) => c.put(request, copy));
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (cacheable(response)) {
      const copy = response.clone();
      caches.open(CACHE).then((c) => c.put(request, copy));
    }
    return response;
  } catch {
    // The shell is keyed on '/', so a deep SPA link falls back to it rather than 404ing
    // into the offline page: the client router sorts the path out once it boots.
    return (await caches.match(request)) ?? (await caches.match('/')) ?? offlineResponse();
  }
}

async function staleWhileRevalidate(request) {
  const hit = await caches.match(request);
  const network = fetch(request)
    .then((response) => {
      if (cacheable(response)) {
        const copy = response.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return response;
    })
    .catch(() => null);
  return hit ?? (await network) ?? offlineResponse();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never interfere with a write, or with a cross-origin request.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (LIVE.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix))) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});
