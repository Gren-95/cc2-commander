/**
 * The camera proxy: one upstream MJPEG connection to the printer, fanned out to every
 * viewer, a cached still for snapshots, and the stream with the print status burned in.
 * Moved out of rest-api.ts, whose routes serve it.
 */

import type { ServerResponse } from 'http';
import { request as httpRequest } from 'http';
import sharp from 'sharp';
import type { StateStore } from './state-store.js';
import type { ServiceConfig } from './config.js';
import { getLogger } from './logger.js';
import { STATUS_NAMES } from '../types.js';

const log = getLogger('REST');

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);
const CACHE_TTL_MS = 5_000;

let cachedSnapshot: Buffer | null = null;
let cacheTime = 0;
let fetchInFlight: Promise<Buffer | null> | null = null;

async function fetchCameraFrame(cameraUrl: string): Promise<Buffer | null> {
  // Return cached snapshot if fresh
  if (cachedSnapshot && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedSnapshot;
  }

  // Serialize concurrent requests
  if (fetchInFlight) return fetchInFlight;

  fetchInFlight = doFetch(cameraUrl);
  try {
    const result = await fetchInFlight;
    if (result) {
      cachedSnapshot = result;
      cacheTime = Date.now();
    }
    return result;
  } finally {
    fetchInFlight = null;
  }
}

async function doFetch(cameraUrl: string): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(cameraUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) {
      return Buffer.from(await res.arrayBuffer());
    }

    // MJPEG stream: extract first frame
    if (!res.body) return null;
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let totalLen = 0;

    try {
      while (totalLen < 5 * 1024 * 1024) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        chunks.push(buf);
        totalLen += buf.length;

        const combined = Buffer.concat(chunks);
        const startIdx = combined.indexOf(JPEG_START);
        if (startIdx === -1) continue;
        const endIdx = combined.indexOf(JPEG_END, startIdx + 2);
        if (endIdx === -1) continue;

        reader.cancel();
        return combined.subarray(startIdx, endIdx + 2);
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    return null;
  } catch (err) {
    log.warn(`Snapshot failed: ${(err as Error).message}`);
    return null;
  }
}

/** Shared snapshot fetcher: used by both REST API, Telegram, and AI monitor.
 *  Prefers the cached frame from the active MJPEG fan-out stream (zero-cost).
 *  Only falls back to a dedicated HTTP fetch if no recent frame is available. */
/** Check actual camera stream health (fresh cached frame or active upstream). */
export function getCameraHealth(): 'available' | 'unavailable' {
  if (cachedSnapshot && Date.now() - cacheTime < CACHE_TTL_MS) return 'available';
  if (upstreamActive) return 'available';
  return 'unavailable';
}

export async function getSnapshot(config: ServiceConfig): Promise<Buffer | null> {
  if (!config.cameraEnabled) return null;
  // Use cached frame from MJPEG stream if fresh (within TTL)
  if (cachedSnapshot && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedSnapshot;
  }
  return fetchCameraFrame(config.cameraUrl);
}

// ---- MJPEG fan-out proxy ----
// Single upstream connection to the camera, re-streamed to all connected clients.
const MJPEG_BOUNDARY = '--mjpegboundary';
const streamClients = new Set<ServerResponse>();
const overlayClients = new Set<ServerResponse>();
let upstreamActive = false;
let overlayStore: StateStore | null = null;

/** The state the overlay draws from. The router hands it over when it is built. */
export function setOverlayStore(store: StateStore): void {
  overlayStore = store;
}
let overlayProcessing = false;
const OVERLAY_MIN_INTERVAL_MS = 200; // max ~5 FPS for overlay
let lastOverlayTime = 0;

function startMjpegUpstream(cameraUrl: string): void {
  if (upstreamActive) return;
  upstreamActive = true;

  const url = new URL(cameraUrl);
  const reqOpts = {
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname + (url.search || ''),
    method: 'GET',
    timeout: 10_000,
  };

  log.info(`Opening upstream MJPEG stream to ${cameraUrl}`);

  const req = httpRequest(reqOpts, (upstream) => {
    let buf = Buffer.alloc(0);

    upstream.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      // Extract complete JPEG frames and broadcast
      while (true) {
        const startIdx = buf.indexOf(JPEG_START);
        if (startIdx === -1) {
          buf = Buffer.alloc(0);
          break;
        }
        const endIdx = buf.indexOf(JPEG_END, startIdx + 2);
        if (endIdx === -1) break; // Wait for more data

        const frame = buf.subarray(startIdx, endIdx + 2);
        buf = buf.subarray(endIdx + 2);

        // Update snapshot cache too
        cachedSnapshot = frame;
        cacheTime = Date.now();

        // Broadcast to all connected clients
        for (const client of streamClients) {
          try {
            client.write(`${MJPEG_BOUNDARY}\r\n`);
            client.write('Content-Type: image/jpeg\r\n');
            client.write(`Content-Length: ${frame.length}\r\n\r\n`);
            client.write(frame);
          } catch {
            streamClients.delete(client);
          }
        }

        // Broadcast overlay frames (throttled)
        if (overlayClients.size > 0 && !overlayProcessing) {
          const now = Date.now();
          if (now - lastOverlayTime >= OVERLAY_MIN_INTERVAL_MS) {
            lastOverlayTime = now;
            overlayProcessing = true;
            processOverlayFrame(frame)
              .then((overlayFrame) => {
                if (!overlayFrame) return;
                for (const client of overlayClients) {
                  try {
                    client.write(`${MJPEG_BOUNDARY}\r\n`);
                    client.write('Content-Type: image/jpeg\r\n');
                    client.write(`Content-Length: ${overlayFrame.length}\r\n\r\n`);
                    client.write(overlayFrame);
                  } catch {
                    overlayClients.delete(client);
                  }
                }
              })
              .catch(() => {})
              .finally(() => {
                overlayProcessing = false;
              });
          }
        }
      }
    });

    upstream.on('end', () => {
      log.info('Upstream stream ended');
      upstreamActive = false;
      if (streamClients.size > 0 || overlayClients.size > 0) {
        setTimeout(() => startMjpegUpstream(cameraUrl), 2000);
      }
    });

    upstream.on('error', (err) => {
      log.warn(`Upstream error: ${err.message}`);
      upstreamActive = false;
      if (streamClients.size > 0 || overlayClients.size > 0) {
        setTimeout(() => startMjpegUpstream(cameraUrl), 5000);
      }
    });
  });

  req.on('error', (err) => {
    log.warn(`Upstream connection failed: ${err.message}`);
    upstreamActive = false;
    if (streamClients.size > 0 || overlayClients.size > 0) {
      setTimeout(() => startMjpegUpstream(cameraUrl), 5000);
    }
  });

  req.on('timeout', () => {
    log.warn('Upstream connection timed out');
    req.destroy();
    upstreamActive = false;
    if (streamClients.size > 0 || overlayClients.size > 0) {
      setTimeout(() => startMjpegUpstream(cameraUrl), 2000);
    }
  });

  req.end();
}

export function addStreamClient(res: ServerResponse, config: ServiceConfig): void {
  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
    'Cache-Control': 'no-cache, no-store',
    Connection: 'close',
  });

  streamClients.add(res);
  log.info(`Stream client connected (total: ${streamClients.size})`);

  res.on('close', () => {
    streamClients.delete(res);
    log.info(`Stream client disconnected (total: ${streamClients.size})`);
  });

  // Start upstream if not already running
  startMjpegUpstream(config.cameraUrl);
}

// ---- MJPEG overlay processing ----

function formatOverlayTime(sec: number | undefined): string {
  if (sec == null || sec <= 0) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildOverlaySvg(width: number, height: number): string {
  const store = overlayStore;
  if (!store?.status) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`;
  }

  const s = store.status;
  const ps = s.print_status;
  const ms = s.machine_status;
  const isPrinting = ms?.status === 2;
  const statusName = STATUS_NAMES[ms?.status] ?? 'Unknown';

  const lines: string[] = [];

  const fontSize = Math.max(14, Math.round(height / 30));
  const charWidth = fontSize * 0.6; // monospace approximate
  const padding = 8;
  const maxChars = Math.max(10, Math.floor((width - padding * 2 - 8) / charWidth));

  if (isPrinting && ps?.filename) {
    const name =
      ps.filename.length > maxChars ? ps.filename.slice(0, maxChars - 3) + '...' : ps.filename;
    lines.push(escapeXml(name));
    lines.push(
      `Progress: ${ms?.progress ?? 0}%  Layer: ${ps.current_layer ?? '--'}/${ps.total_layer ?? store.fileTotalLayers ?? '??'}`,
    );
    lines.push(
      `Remaining: ${formatOverlayTime(ps.remaining_time_sec)}  Elapsed: ${formatOverlayTime(ps.print_duration)}`,
    );
  } else {
    lines.push(`Status: ${statusName}`);
  }

  // Temperatures
  const nozzle = s.extruder?.temperature?.toFixed(1) ?? '--';
  const nozzleTgt = s.extruder?.target ? `/${Math.round(s.extruder.target)}` : '';
  const bed = s.heater_bed?.temperature?.toFixed(1) ?? '--';
  const bedTgt = s.heater_bed?.target ? `/${Math.round(s.heater_bed.target)}` : '';
  lines.push(`Nozzle: ${nozzle}${nozzleTgt}°C  Bed: ${bed}${bedTgt}°C`);

  const lineHeight = fontSize * 1.3;
  const boxHeight = lines.length * lineHeight + padding * 2;
  const boxY = height - boxHeight - 4;

  let svgText = '';
  lines.forEach((line, i) => {
    const y = boxY + padding + (i + 1) * lineHeight - 2;
    svgText +=
      `<text x="${padding + 4}" y="${y}" fill="white" font-family="monospace" font-size="${fontSize}" font-weight="bold">` +
      `<tspan stroke="black" stroke-width="3" paint-order="stroke">${line}</tspan></text>`;
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect x="2" y="${boxY}" width="${width - 4}" height="${boxHeight}" rx="4" fill="rgba(0,0,0,0.55)"/>` +
    svgText +
    `</svg>`
  );
}

async function processOverlayFrame(frame: Buffer): Promise<Buffer | null> {
  try {
    const meta = await sharp(frame).metadata();
    const w = meta.width || 640;
    const h = meta.height || 480;

    const svg = buildOverlaySvg(w, h);
    const svgBuf = Buffer.from(svg);

    return await sharp(frame)
      .composite([{ input: svgBuf, top: 0, left: 0 }])
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch (err) {
    log.warn(`Overlay processing failed: ${(err as Error).message}`);
    return null;
  }
}

export function addOverlayClient(res: ServerResponse, config: ServiceConfig): void {
  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
    'Cache-Control': 'no-cache, no-store',
    Connection: 'close',
  });

  overlayClients.add(res);
  log.info(`Overlay client connected (total: ${overlayClients.size})`);

  res.on('close', () => {
    overlayClients.delete(res);
    log.info(`Overlay client disconnected (total: ${overlayClients.size})`);
  });

  startMjpegUpstream(config.cameraUrl);
}
