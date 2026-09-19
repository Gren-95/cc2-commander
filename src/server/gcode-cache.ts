/**
 * The service's copies of printer files: gcode (so the preview and a download can be served
 * without asking the printer again) and timelapse video, under DATA_DIR. Moved out of
 * rest-api.ts, which the routes still use it from.
 */

import type { ServerResponse } from 'http';
import { request as httpRequest } from 'http';
import { createHash } from 'crypto';
import { writeFile, readdir, mkdir, stat, unlink, rename } from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { join } from 'path';
import { PassThrough } from 'stream';
import type { ServiceConfig } from './config.js';
import { gcodeCacheDir, timelapseCacheDir } from './data-paths.js';
import { getLogger } from './logger.js';

const log = getLogger('REST');

// ── Gcode file cache ────────────────────────────────────────────
// Path helpers live in data-paths.ts so DATA_DIR is honoured: this used to be
// join(process.cwd(), 'data', 'gcode-cache'), which ignored it (ELEG-70).
const GCODE_CACHE_MAX = 10; // keep at most N cached files

function gcodeCacheKey(fileName: string): string {
  return createHash('sha256').update(fileName).digest('hex').slice(0, 16) + '.gcode';
}

export async function ensureCacheDir(): Promise<void> {
  await mkdir(gcodeCacheDir(), { recursive: true });
}

/** Cache a gcode file from a Buffer (e.g. after upload) */
export async function cacheGcodeBuffer(fileName: string, data: Buffer): Promise<void> {
  try {
    await ensureCacheDir();
    const cachePath = join(gcodeCacheDir(), gcodeCacheKey(fileName));
    await writeFile(cachePath, data);
    await evictOldCache();
    log.info(`Cached uploaded gcode: ${fileName} (${data.length} bytes)`);
  } catch (err) {
    log.warn(`Failed to cache uploaded gcode ${fileName}: ${(err as Error).message}`);
  }
}

async function getCachedGcode(fileName: string): Promise<string | null> {
  try {
    const cached = join(gcodeCacheDir(), gcodeCacheKey(fileName));
    const s = await stat(cached);
    if (s.size > 0) return cached;
  } catch {
    /* not cached */
  }
  return null;
}

async function evictOldCache(): Promise<void> {
  try {
    const files = await readdir(gcodeCacheDir());
    if (files.length <= GCODE_CACHE_MAX) return;
    const entries = await Promise.all(
      files.map(async (f) => {
        const p = join(gcodeCacheDir(), f);
        const s = await stat(p).catch(() => null);
        return { path: p, mtime: s?.mtimeMs ?? 0 };
      }),
    );
    entries.sort((a, b) => a.mtime - b.mtime);
    const toRemove = entries.slice(0, entries.length - GCODE_CACHE_MAX);
    await Promise.all(toRemove.map((e) => unlink(e.path).catch(() => {})));
  } catch {
    /* ignore */
  }
}

// ── Timelapse cache ─────────────────────────────────────────────
// Unlike the gcode cache above, this one is deliberately not evicted. A gcode is a
// working cache for a print that is happening now; a timelapse is the whole reason this
// exists: the printer's own storage is small and timelapses are exactly the kind of
// file someone wants to keep after the print, and after the printer, are gone.

function timelapseCacheKey(fileName: string): string {
  return createHash('sha256').update(fileName).digest('hex').slice(0, 16) + '.mp4';
}

async function ensureTimelapseCacheDir(): Promise<void> {
  await mkdir(timelapseCacheDir(), { recursive: true });
}

export async function getCachedTimelapse(fileName: string): Promise<string | null> {
  try {
    const cached = join(timelapseCacheDir(), timelapseCacheKey(fileName));
    const s = await stat(cached);
    if (s.size > 0) return cached;
  } catch {
    /* not cached */
  }
  return null;
}

/**
 * Download a transcoded timelapse to server storage, fire-and-forget.
 *
 * Called from `index.ts` once `StateStore` sees a transcode finish: method 1051 (or
 * 1050) answering with `error_code: 0` and a `url`. Mirrors `precacheGcode` below, but
 * with no eviction and its own cache directory: see the comment above this section for
 * why the two caches behave differently.
 */
export function precacheTimelapse(fileName: string, config: ServiceConfig): void {
  void precacheTimelapseAsync(fileName, config);
}

async function precacheTimelapseAsync(fileName: string, config: ServiceConfig): Promise<void> {
  const cachePath = join(timelapseCacheDir(), timelapseCacheKey(fileName));
  const tmpPath = `${cachePath}.part`;
  try {
    await ensureTimelapseCacheDir();
    if (await getCachedTimelapse(fileName)) {
      log.info(`Timelapse precache: ${fileName} already cached`);
      return;
    }
    log.info(`Timelapse precache: downloading ${fileName}`);
    await downloadToFile(fileName, config, tmpPath);
    await rename(tmpPath, cachePath);
    log.info(`Timelapse precache: cached ${fileName}`);
  } catch (err) {
    // Logged, not thrown: a transcode the service failed to archive should not take the
    // MQTT event loop down with it. Nothing marks this as cached, so the next export or
    // the next attempt to play it will simply try the download again.
    log.warn(`Timelapse precache failed for ${fileName}: ${(err as Error).message}`);
    await unlink(tmpPath).catch(() => {});
  }
}

/** Stream a printer file straight to `destPath`. Shared by the two timelapse paths below. */
function downloadToFile(fileName: string, config: ServiceConfig, destPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proxyReq = httpRequest(
      {
        hostname: config.printerIp,
        port: 80,
        path: `/download?X-Token=${encodeURIComponent(config.printerPassword)}&file_name=${encodeURIComponent(fileName)}`,
        method: 'GET',
        timeout: 120_000,
        // See handleFileDownload below, the printer's libhv sends both Content-Length
        // and Transfer-Encoding: chunked, which Node's strict parser rejects.
        insecureHTTPParser: true,
      },
      (proxyRes) => {
        if (proxyRes.statusCode !== 200) {
          proxyRes.resume();
          reject(new Error(`Printer returned ${proxyRes.statusCode}`));
          return;
        }
        const fileStream = createWriteStream(destPath);
        proxyRes.pipe(fileStream);
        fileStream.on('finish', () => resolve());
        fileStream.on('error', reject);
        proxyRes.on('error', reject);
      },
    );
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      reject(new Error('Download timed out'));
    });
    proxyReq.end();
  });
}

/**
 * Proxy a timelapse live from the printer, teeing the response into the cache as it
 * streams so this play also archives it. Written to a `.part` path and renamed only on
 * a clean finish, so a play that is interrupted midway does not leave a truncated file
 * behind that a later request would serve as if it were complete.
 */
export function serveTimelapseLive(
  res: ServerResponse,
  fileName: string,
  baseName: string,
  config: ServiceConfig,
): void {
  const cachePath = join(timelapseCacheDir(), timelapseCacheKey(fileName));
  const tmpPath = `${cachePath}.part`;
  log.info(`Timelapse: proxying ${fileName} live (not yet in server storage)`);

  const proxyReq = httpRequest(
    {
      hostname: config.printerIp,
      port: 80,
      path: `/download?X-Token=${encodeURIComponent(config.printerPassword)}&file_name=${encodeURIComponent(fileName)}`,
      method: 'GET',
      timeout: 120_000,
      insecureHTTPParser: true,
    },
    (proxyRes) => {
      if (proxyRes.statusCode !== 200) {
        res.writeHead(proxyRes.statusCode ?? 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Printer returned ${proxyRes.statusCode}` }));
        proxyRes.resume();
        return;
      }
      proxyRes.socket?.setTimeout(120_000);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `inline; filename="${baseName}"`,
        ...(proxyRes.headers['content-length']
          ? { 'Content-Length': proxyRes.headers['content-length'] }
          : {}),
      });

      const cacheStream = createWriteStream(tmpPath);
      const tee = new PassThrough();
      tee.pipe(res);
      tee.pipe(cacheStream);
      proxyRes.pipe(tee);
      cacheStream.on('finish', () => {
        rename(tmpPath, cachePath)
          .then(() => log.info(`Timelapse: archived ${fileName} to server storage`))
          .catch(() => {});
      });
      cacheStream.on('error', () => {
        unlink(tmpPath).catch(() => {});
      });
    },
  );
  proxyReq.on('error', (err) => {
    log.error(`Timelapse proxy error: ${(err as NodeJS.ErrnoException).code} ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to connect to printer' }));
    }
  });
  proxyReq.on('timeout', () => {
    log.error('Timelapse proxy timeout');
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Download timed out' }));
    }
  });
  proxyReq.end();
}

/**
 * How a proxied file should be presented to the browser.
 *
 * A timelapse needs `video/mp4` and `inline` or a `<video>` element will not play it;
 * everything else is a download. **The printer sends no `Content-Type` at all** (the
 * header comes back `null`) so whatever this proxy does not set, nothing does, and the
 * browser is left guessing. That is the whole reason a timelapse failed with
 * `MEDIA_ERR_SRC_NOT_SUPPORTED` and the word "Format" in it.
 */
interface DownloadPresentation {
  contentType: string;
  inline: boolean;
}

export async function handleFileDownload(
  res: ServerResponse,
  fileName: string,
  baseName: string,
  source: string,
  isGcode: boolean,
  config: ServiceConfig,
  presentation: DownloadPresentation = { contentType: 'application/octet-stream', inline: false },
): Promise<void> {
  // Try serving from cache first (gcode files only)
  if (isGcode) {
    try {
      await ensureCacheDir();
      const cached = await getCachedGcode(fileName);
      if (cached) {
        log.info(`Download proxy: serving ${fileName} from cache`);
        const s = await stat(cached);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${baseName}"`,
          'Content-Length': String(s.size),
        });
        createReadStream(cached).pipe(res);
        return;
      }
    } catch {
      /* cache miss, fall through to printer */
    }
  }

  const pathMap: Record<string, string> = {
    local: '/download',
    'u-disk': '/download/udisk',
    'sd-card': '/download/sdcard',
  };
  const dlPath = pathMap[source] ?? '/download';
  log.info(`Download proxy: ${fileName} from ${dlPath}`);

  const proxyReq = httpRequest(
    {
      hostname: config.printerIp,
      port: 80,
      path: `${dlPath}?X-Token=${encodeURIComponent(config.printerPassword)}&file_name=${encodeURIComponent(fileName)}`,
      method: 'GET',
      timeout: 120_000,
      // Printer's libhv sends both Content-Length and Transfer-Encoding: chunked,
      // which is invalid HTTP. Node's strict parser rejects this.
      insecureHTTPParser: true,
    },
    (proxyRes) => {
      if (proxyRes.statusCode !== 200) {
        res.writeHead(proxyRes.statusCode ?? 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Printer returned ${proxyRes.statusCode}` }));
        proxyRes.resume();
        return;
      }
      // Keep the socket alive during slow transfers
      proxyRes.socket?.setTimeout(120_000);
      res.writeHead(200, {
        'Content-Type': presentation.contentType,
        'Content-Disposition': presentation.inline
          ? `inline; filename="${baseName}"`
          : `attachment; filename="${baseName}"`,
        // Forwarded, and it arrives, but it does NOT reach the browser, which sees
        // `transfer-encoding: chunked` and no length. Established while chasing it:
        // the printer does send `content-length: 7924491` (alongside a contradictory
        // `transfer-encoding: chunked`, which is why this proxy needs
        // `insecureHTTPParser`); `res.getHeader('content-length')` reads it back
        // correctly after this `writeHead`; and Bun preserves a declared length on a
        // streamed `Response` in isolation. So it is lost between the compat layer and
        // the wire, and the cause is not yet known.
        //
        // The cost is small and bounded: a `<video>` plays fine without it but cannot
        // seek until the file has buffered. Not worth buffering 8MB in memory per
        // request to fix, which is the only remedy that does not need the cause.
        ...(proxyRes.headers['content-length']
          ? { 'Content-Length': proxyRes.headers['content-length'] }
          : {}),
      });

      // For gcode files, tee the stream to a cache file
      if (isGcode) {
        const cachePath = join(gcodeCacheDir(), gcodeCacheKey(fileName));
        const cacheStream = createWriteStream(cachePath);
        const tee = new PassThrough();
        tee.pipe(res);
        tee.pipe(cacheStream);
        proxyRes.pipe(tee);
        cacheStream.on('finish', () => {
          evictOldCache().catch(() => {});
          log.info(`Cached gcode: ${fileName}`);
        });
        cacheStream.on('error', () => {
          unlink(cachePath).catch(() => {});
        });
      } else {
        proxyRes.pipe(res);
      }
    },
  );
  proxyReq.on('error', (err) => {
    log.error(`Download proxy error: ${(err as NodeJS.ErrnoException).code} ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to connect to printer' }));
    }
  });
  proxyReq.on('timeout', () => {
    log.error('Download proxy timeout');
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Download timed out' }));
    }
  });
  proxyReq.end();
}

/**
 * Pre-download a gcode file to cache in the background.
 * Called on print start so the preview can be served from cache
 * instead of hitting the printer while it's busy printing.
 */
export function precacheGcode(fileName: string, config: ServiceConfig, source = 'local'): void {
  // Fire and forget, errors are logged but don't affect the caller
  void precacheGcodeAsync(fileName, config, source);
}

/**
 * Pre-download a gcode file to cache. Returns a promise that resolves
 * with { ok, cached, size } when done.
 */
export async function precacheGcodeAsync(
  fileName: string,
  config: ServiceConfig,
  source = 'local',
): Promise<{ ok: boolean; cached: boolean; size: number; error?: string }> {
  try {
    await ensureCacheDir();
    const existing = await getCachedGcode(fileName);
    if (existing) {
      const s = await stat(existing);
      log.info(`Precache: ${fileName} already cached (${s.size} bytes)`);
      return { ok: true, cached: true, size: s.size };
    }

    const pathMap: Record<string, string> = {
      local: '/download',
      'u-disk': '/download/udisk',
      'sd-card': '/download/sdcard',
    };
    const dlPath = pathMap[source] ?? '/download';
    log.info(`Precache: downloading ${fileName} from ${dlPath}`);

    const cachePath = join(gcodeCacheDir(), gcodeCacheKey(fileName));

    const size = await new Promise<number>((resolve, reject) => {
      const proxyReq = httpRequest(
        {
          hostname: config.printerIp,
          port: 80,
          path: `${dlPath}?X-Token=${encodeURIComponent(config.printerPassword)}&file_name=${encodeURIComponent(fileName)}`,
          method: 'GET',
          timeout: 120_000,
          insecureHTTPParser: true,
        },
        (proxyRes) => {
          if (proxyRes.statusCode !== 200) {
            proxyRes.resume();
            reject(new Error(`Printer returned ${proxyRes.statusCode}`));
            return;
          }
          proxyRes.socket?.setTimeout(120_000);
          const cacheStream = createWriteStream(cachePath);
          let bytes = 0;
          proxyRes.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
          });
          proxyRes.pipe(cacheStream);
          cacheStream.on('finish', () => {
            evictOldCache().catch(() => {});
            log.info(`Precache: cached ${fileName} (${bytes} bytes)`);
            resolve(bytes);
          });
          cacheStream.on('error', (err) => {
            unlink(cachePath).catch(() => {});
            reject(err);
          });
        },
      );
      proxyReq.on('error', reject);
      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        reject(new Error('Precache download timed out'));
      });
      proxyReq.end();
    });

    return { ok: true, cached: false, size };
  } catch (err) {
    const msg = (err as Error).message;
    log.warn(`Precache failed for ${fileName}: ${msg}`);
    return { ok: false, cached: false, size: 0, error: msg };
  }
}
