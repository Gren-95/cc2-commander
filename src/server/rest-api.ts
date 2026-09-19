/**
 * REST API and camera proxy.
 *
 * Endpoints:
 *   GET /api/status    (Current printer state as JSON
 *   GET /api/metrics) Structured metrics as JSON
 *   GET /api/metrics/prometheus (Metrics in Prometheus text exposition format
 *   GET /api/snapshot) Camera JPEG snapshot (proxied + cached)
 *   GET /api/stream    (MJPEG stream proxy (single upstream, fan-out to all clients)
 *   GET /api/stream/overlay) MJPEG stream with status text overlay
 *   GET /api/health: Service health check (incl. the deployed build stamp)
 *   GET /api/files/download (Proxy file download from printer
 *   POST /api/files/upload) Proxy file upload to printer (chunked PUT)
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { request as httpRequest } from 'http';
import { createHash } from 'crypto';
import { writeFile, readdir, readFile, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { join } from 'path';
import type { StateStore } from './state-store.js';
import type { ServiceConfig } from './config.js';
import type { DryerService } from './dryer.js';
import type { HomeAssistantService } from './home-assistant.js';
import type { PrintReportCollector } from './print-report-collector.js';
import type { MqttBridge } from './mqtt-bridge.js';
import { generateReportPDF } from './print-report-pdf.js';
import { getBuildInfo } from './build-info.js';
import { applyCors, corsHeaders } from './cors.js';
import { captureLogDir, gcodeCacheDir } from './data-paths.js';
import { getLogger } from './logger.js';
import { writeSpaFallback } from './spa.js';
import {
  STATUS_NAMES,
  SUB_STATUS_NAMES,
  SPEED_MODE_NAMES,
  EXCEPTION_NAMES,
  mqttPhaseMessage,
} from '../types.js';
import type { FanInfo } from '../types.js';
import {
  cacheGcodeBuffer,
  ensureCacheDir,
  getCachedTimelapse,
  handleFileDownload,
  precacheGcodeAsync,
  serveTimelapseLive,
} from './gcode-cache.js';
import { addOverlayClient, addStreamClient, getSnapshot, setOverlayStore } from './camera-proxy.js';

const log = getLogger('REST');
const debugLog = getLogger('Debug');

// Debug capture state
let activeCapture: { file: string } | null = null;

let _bridge: MqttBridge | null = null;

/* ── SPA fallback ────────────────────────────────────────────────
 *
 * dist/ is served by Bun's static route table (src/server/spa.ts), built once at
 * startup. What reaches this module is only the terminal case: a path that matched no
 * static file and no route above, which for a single-page app means "hand the browser
 * index.html and let the client router decide". */

export function createRestRouter(
  store: StateStore,
  config: ServiceConfig,
  dryer?: DryerService | null,
  reportCollector?: PrintReportCollector | null,
  bridge?: MqttBridge | null,
  homeAssistant?: HomeAssistantService | null,
  /**
   * Whether this caller is known. Only `/api/health` asks, because it is the one route
   * that answers without credentials: a predicate rather than the gate itself so this
   * file keeps knowing nothing about sessions or keys.
   */
  isAuthenticated: (req: IncomingMessage) => boolean = () => true,
) {
  setOverlayStore(store);
  if (bridge) _bridge = bridge;
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '';

    // CORS headers for API routes: same-origin unless CORS_ALLOWED_ORIGINS says
    // otherwise (ELEG-24). This is the surface that serves /api/snapshot, /api/stream
    // and the control routes, so the wildcard mattered most here.
    if (url.startsWith('/api/')) {
      applyCors(
        res,
        corsHeaders(config.corsPolicy, req.headers.origin, 'GET, POST, OPTIONS', 'Content-Type'),
      );
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (url === '/api/health') {
      const known = isAuthenticated(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          mqtt: _bridge?.isConnected
            ? 'connected'
            : _bridge?.brokerConnected
              ? 'broker_only'
              : 'disconnected',
          // `mqtt` above stays as it was for existing consumers. These three are what
          // make a `broker_only` diagnosable without a journal read (ELEG-59):
          // `mqttPhase` separates "printer never spoke" from "registration refused",
          // `mqttRegisterAttempts` separates 0 (never started) from 12 (trying and
          // failing), and `mqttMessage` is the sentence to show a human.
          mqttPhase: _bridge?.phase ?? 'disconnected',
          mqttRegisterAttempts: _bridge?.registerAttempts ?? 0,
          mqttMessage: mqttPhaseMessage(_bridge?.phase ?? 'disconnected'),
          // Liveness is public; identity is not. The serial names one specific machine
          // and the build names the commit running: neither is needed to answer "is it
          // up?", which is all an unauthenticated caller is asking.
          printerSn: known ? _bridge?.serialNumber || null : null,
          clients: 0, // filled in by ws-transport if needed
          // Which commit is serving this. All-null on an unstamped deploy or a dev
          // run; cached, because this endpoint is polled.
          build: known ? getBuildInfo() : null,
        }),
      );
      return;
    }

    if (url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          attributes: store.attributes,
          status: store.status,
          canvas: store.canvas,
          files: store.files,
        }),
      );
      return;
    }

    // /webcam/?action=stream|snapshot (mjpegstreamer-compatible)
    if (url.startsWith('/webcam/') || url === '/webcam') {
      const qIdx = url.indexOf('?');
      const qs = qIdx >= 0 ? url.slice(qIdx + 1) : '';
      const action = new URLSearchParams(qs).get('action');
      if (action === 'stream') {
        if (!config.cameraEnabled) {
          res.writeHead(503);
          res.end('Camera disabled');
          return;
        }
        addStreamClient(res, config);
        return;
      }
      // Default to snapshot
      getSnapshot(config)
        .then((jpeg) => {
          if (jpeg) {
            res.writeHead(200, {
              'Content-Type': 'image/jpeg',
              'Cache-Control': 'no-cache',
              'Content-Length': jpeg.length,
            });
            res.end(jpeg);
          } else {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Camera unavailable');
          }
        })
        .catch(() => {
          res.writeHead(500);
          res.end('Internal error');
        });
      return;
    }

    if (url === '/api/snapshot') {
      getSnapshot(config)
        .then((jpeg) => {
          if (jpeg) {
            res.writeHead(200, {
              'Content-Type': 'image/jpeg',
              'Cache-Control': 'no-cache',
              'Content-Length': jpeg.length,
            });
            res.end(jpeg);
          } else {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Camera unavailable');
          }
        })
        .catch(() => {
          res.writeHead(500);
          res.end('Internal error');
        });
      return;
    }

    if (url === '/api/stream') {
      if (!config.cameraEnabled) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Camera disabled');
        return;
      }
      addStreamClient(res, config);
      return;
    }

    if (url === '/api/stream/overlay') {
      if (!config.cameraEnabled) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Camera disabled');
        return;
      }
      addOverlayClient(res, config);
      return;
    }

    // Telegram config: GET (read) and POST (update progress interval)
    if (url === '/api/config/telegram') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            enabled: config.telegramEnabled,
            chatId: config.telegramChatId ? config.telegramChatId.slice(0, 4) + '...' : '',
            progressInterval: config.progressInterval,
          }),
        );
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body) as { progressInterval?: number };
            if (
              typeof data.progressInterval === 'number' &&
              data.progressInterval >= 5 &&
              data.progressInterval <= 50
            ) {
              (config as { progressInterval: number }).progressInterval = data.progressInterval;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, progressInterval: config.progressInterval }));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid progressInterval (5-50)' }));
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }
    }

    /*
     * Filament drying. The session lives in the service, not in a tab: see
     * `server/dryer.ts` for why something that heats a bed cannot be owned by a page
     * that a phone can put to sleep.
     */
    /**
     * Ambient temperature and humidity from Home Assistant.
     *
     * Read once on page load, then kept current by `home_assistant` WebSocket frames:
     * the same shape as `/api/dryer`, and for the same reason: a client that connects
     * between two polls would otherwise show nothing until the next one, which is up to
     * a minute of a blank row.
     *
     * The token is NOT in this payload and must never be. It is a Home Assistant
     * long-lived token, which usually carries administrator rights.
     */
    if (url === '/api/home-assistant') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          data: homeAssistant?.getState() ?? {
            configured: false,
            reachable: false,
            readings: [],
            lastError: null,
            lastPolledAt: null,
          },
        }),
      );
      return;
    }

    if (url === '/api/dryer') {
      if (!dryer) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Dryer not running' } }));
        return;
      }

      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: dryer.getState() }));
        return;
      }

      if (req.method === 'DELETE') {
        void dryer.finish('stopped').then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: dryer.getState() }));
        });
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          let parsed: { presetId?: string; tempC?: number; hours?: number };
          try {
            parsed = JSON.parse(body);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ error: { code: 'INVALID_FORMAT', message: 'Body is not JSON' } }),
            );
            return;
          }
          if (!parsed.presetId) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ error: { code: 'MISSING_FIELD', message: 'presetId is required' } }),
            );
            return;
          }
          // `begin` clamps the temperature and the duration itself; a value arriving over
          // HTTP gets the same ceiling as one typed into the panel, because the clamp is
          // shared rather than reimplemented on each side.
          void dryer
            .begin({ presetId: parsed.presetId, tempC: parsed.tempC, hours: parsed.hours })
            .then((refusal) => {
              if (refusal) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { code: 'CONFLICT', message: refusal } }));
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, data: dryer.getState() }));
            });
        });
        return;
      }

      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: req.method } }));
      return;
    }

    // Debug capture: start a timed raw MQTT capture
    if (url === '/api/debug/capture' && req.method === 'POST') {
      if (activeCapture) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Capture already in progress', file: activeCapture.file }));
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        let duration = 10;
        try {
          const parsed = JSON.parse(body) as { duration?: number };
          if (parsed.duration && parsed.duration > 0 && parsed.duration <= 60) {
            duration = parsed.duration;
          }
        } catch {
          /* use default */
        }
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `mqtt-capture-${ts}.json`;
        const messages: Array<{ direction: string; topic: string; data: unknown; ts: number }> = [];
        const listener = (entry: {
          direction: string;
          topic: string;
          data: unknown;
          ts: number;
        }) => {
          messages.push(entry);
        };
        store.on('raw', listener);
        activeCapture = { file: filename };
        setTimeout(async () => {
          store.off('raw', listener);
          activeCapture = null;
          const filePath = join(captureLogDir(), filename);
          await writeFile(filePath, JSON.stringify(messages, null, 2));
          debugLog.info(`Capture saved: ${filename} (${messages.length} messages, ${duration}s)`);
        }, duration * 1000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            file: filename,
            duration,
            message: `Capturing for ${duration}s`,
          }),
        );
      });
      return;
    }

    // List available captures
    if (url === '/api/debug/captures' && req.method === 'GET') {
      readdir(captureLogDir())
        .then((files) => {
          const captures = files
            .filter((f) => f.startsWith('mqtt-capture-'))
            .sort()
            .reverse();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ captures, active: activeCapture?.file ?? null }));
        })
        .catch(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ captures: [], active: null }));
        });
      return;
    }

    // Download a specific capture file
    if (url.startsWith('/api/debug/captures/') && req.method === 'GET') {
      const filename = decodeURIComponent(url.slice('/api/debug/captures/'.length));
      // Prevent path traversal
      if (
        filename.includes('..') ||
        filename.includes('/') ||
        !filename.startsWith('mqtt-capture-')
      ) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid filename' }));
        return;
      }
      readFile(join(captureLogDir(), filename), 'utf-8')
        .then((content) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(content);
        })
        .catch(() => {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'File not found' }));
        });
      return;
    }

    // Enable video stream via SDCP WebSocket (port 3030): what the official app does
    if (url === '/api/debug/videostream/sdcp' && req.method === 'POST') {
      if (!bridge) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bridge not available' }));
        return;
      }
      bridge
        .enableVideoStreamSDCP()
        .then((result) => {
          res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        });
      return;
    }

    // Enable video stream via MQTT method 1054 (CTRL_LIVE_STREAM)
    if (url === '/api/debug/videostream/mqtt' && req.method === 'POST') {
      if (!bridge) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bridge not available' }));
        return;
      }
      bridge.enableVideoStreamMQTT();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          note: 'Sent method 1054 Enable=1. Check the MQTT log for the response.',
        }),
      );
      return;
    }

    // Reset layer duration data
    if (url === '/api/layer-data' && req.method === 'DELETE') {
      store.clearLayerData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── File download proxy ─────────────────────────────────────────
    // GET /api/files/download?file=<path>&source=local|u-disk|sd-card
    // Gcode files are cached on disk so they can be served even when the printer is busy
    if (url.startsWith('/api/files/download') && req.method === 'GET') {
      const params = new URL(url, 'http://localhost').searchParams;
      const fileName = params.get('file');
      const source = params.get('source') || 'local';
      if (!fileName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing file parameter' }));
        return;
      }

      const isGcode = fileName.toLowerCase().endsWith('.gcode');
      const baseName = fileName.split('/').pop() || 'file';

      // Try cache first, then fall through to printer proxy
      void handleFileDownload(res, fileName, baseName, source, isGcode, config);
      return;
    }

    /**
     * Stream a timelapse video: from server storage if it has already been archived
     * there, otherwise live from the printer.
     *
     * The play button used to point a `<video>` at the bare path the printer reports
     * (`video/<name>.mp4`) which has no host, so the browser resolved it against the
     * dashboard, got this service's 404, and reported
     * `MEDIA_ERR_SRC_NOT_SUPPORTED: Format error`: a 404 body is not a video, and the
     * element blames the format rather than the address.
     *
     * The file is real and reachable; it comes down the same `/download` endpoint as a
     * gcode, with the same token. What it does NOT come with is a content type, so this
     * supplies one, without it the proxy would fail exactly as the 404 did.
     */
    if (url.startsWith('/api/timelapse/video') && req.method === 'GET') {
      const fileName = new URL(url, 'http://localhost').searchParams.get('file');
      if (!fileName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing file parameter' }));
        return;
      }
      const baseName = fileName.split('/').pop() || 'timelapse.mp4';

      void (async () => {
        const cached = await getCachedTimelapse(fileName);
        if (cached) {
          log.info(`Timelapse: serving ${fileName} from server storage`);
          const s = await stat(cached);
          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Disposition': `inline; filename="${baseName}"`,
            'Content-Length': String(s.size),
          });
          createReadStream(cached).pipe(res);
          return;
        }
        // Not archived yet, proxy live, and tee the response into the cache so this
        // play also becomes the download `precacheTimelapse` failed to make (an export
        // from before this cache existed, or a precache that errored).
        serveTimelapseLive(res, fileName, baseName, config);
      })();
      return;
    }

    // ── List cached gcode files ─────────────────────────────────────
    // GET /api/files/cached: returns array of filenames that have cached gcode
    if (url.startsWith('/api/files/cached') && req.method === 'GET') {
      void (async () => {
        try {
          await ensureCacheDir();
          const cacheFiles = await readdir(gcodeCacheDir());
          const cacheHashes = new Set(cacheFiles.map((f) => f.replace(/\.gcode$/, '')));
          const params = new URL(req.url || '', 'http://localhost').searchParams;
          const checkFiles = params.getAll('file');
          const cached: string[] = [];
          for (const f of checkFiles) {
            const hash = createHash('sha256').update(f).digest('hex').slice(0, 16);
            if (cacheHashes.has(hash)) cached.push(f);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ cached }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ cached: [], error: (err as Error).message }));
        }
      })();
      return;
    }

    // ── Gcode precache endpoint ──────────────────────────────────────
    // POST /api/files/precache  { file: string, source?: string }
    // Downloads gcode from printer to service cache before print start
    if (url === '/api/files/precache' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          const { file, source } = JSON.parse(body) as { file: string; source?: string };
          if (!file) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing file parameter' }));
            return;
          }
          const result = await precacheGcodeAsync(file, config, source || 'local');
          res.writeHead(result.ok ? 200 : 502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        }
      });
      return;
    }

    // ── File upload proxy ───────────────────────────────────────────
    // POST /api/files/upload  (multipart/form-data with 'file' field)
    // Query: ?source=local|u-disk|sd-card
    if (url.startsWith('/api/files/upload') && req.method === 'POST') {
      const params = new URL(url, 'http://localhost').searchParams;
      const source = params.get('source') || 'local';
      const pathMap: Record<string, string> = {
        local: '/upload',
        'u-disk': '/upload/udisk',
        'sd-card': '/upload/sdcard',
      };
      const uploadPath = pathMap[source] ?? '/upload';

      // Parse multipart boundary from Content-Type
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
      if (!boundaryMatch) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing multipart boundary' }));
        return;
      }

      // Collect full body (gcode files are typically < 100MB)
      const chunks: Buffer[] = [];
      let totalSize = 0;
      const MAX_UPLOAD = 500 * 1024 * 1024; // 500MB limit
      req.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_UPLOAD) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'File too large (max 500MB)' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', async () => {
        try {
          const body = Buffer.concat(chunks);

          // Extract the file from multipart data
          const boundary = boundaryMatch[1];
          const { fileName, fileData } = parseMultipart(body, boundary);
          if (!fileName || !fileData) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No file found in upload' }));
            return;
          }

          // Compute MD5 of entire file
          const md5 = createHash('md5').update(fileData).digest('hex');

          // Upload in 1MB chunks via PUT
          const CHUNK_SIZE = 1024 * 1024;
          const totalBytes = fileData.length;
          let offset = 0;

          while (offset < totalBytes) {
            const end = Math.min(offset + CHUNK_SIZE, totalBytes);
            const chunkData = fileData.subarray(offset, end);

            const chunkResult = await uploadChunk(
              config.printerIp,
              uploadPath,
              config.printerPassword,
              fileName,
              md5,
              chunkData,
              offset,
              end - 1,
              totalBytes,
            );

            if (chunkResult.error_code !== 0) {
              // Retry once on offset mismatch
              if (chunkResult.error_code === 9000) {
                const retry = await uploadChunk(
                  config.printerIp,
                  uploadPath,
                  config.printerPassword,
                  fileName,
                  md5,
                  chunkData,
                  offset,
                  end - 1,
                  totalBytes,
                );
                if (retry.error_code !== 0) {
                  res.writeHead(502, { 'Content-Type': 'application/json' });
                  res.end(
                    JSON.stringify({
                      error: `Upload failed at offset ${offset}`,
                      error_code: retry.error_code,
                    }),
                  );
                  return;
                }
              } else {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: `Upload failed at offset ${offset}`,
                    error_code: chunkResult.error_code,
                  }),
                );
                return;
              }
            }

            offset = end;
          }

          log.info(`Upload complete: ${fileName} (${formatUploadSize(totalBytes)}, MD5: ${md5})`);

          // Cache the uploaded gcode on the service for preview
          if (fileName.toLowerCase().endsWith('.gcode')) {
            void cacheGcodeBuffer(fileName, fileData);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, fileName, size: totalBytes, md5 }));
        } catch (err) {
          log.error(`Upload error: ${(err as Error).message}`);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Upload failed' }));
          }
        }
      });
      return;
    }

    // JSON metrics endpoint
    if (url === '/api/metrics' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildMetrics(store)));
      return;
    }

    // Prometheus metrics endpoint
    if (url === '/api/metrics/prometheus' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(buildPrometheusMetrics(store));
      return;
    }

    // ── Print Reports ───────────────────────────────────────────────
    if (url === '/api/reports' && req.method === 'GET') {
      if (!reportCollector) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reports: [] }));
        return;
      }
      reportCollector
        .listReports()
        .then((reports) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ reports, active: reportCollector.isActive() }));
        })
        .catch(() => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to list reports' }));
        });
      return;
    }

    if (url.startsWith('/api/reports/') && req.method === 'GET') {
      if (!reportCollector) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const parts = url.slice('/api/reports/'.length).split('/');
      const reportId = decodeURIComponent(parts[0]);
      const action = parts[1];

      // Validate report ID
      if (!reportId || reportId.includes('..')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid report ID' }));
        return;
      }

      // GET /api/reports/:id/pdf: Download PDF
      if (action === 'pdf') {
        Promise.all([reportCollector.getReport(reportId), reportCollector.getChartData(reportId)])
          .then(async ([report, chartData]) => {
            if (!report) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Report not found' }));
              return;
            }
            const pdf = await generateReportPDF(
              report,
              chartData ?? [],
              join(config.dataDir, 'reports'),
            );
            const safeName = report.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
            res.writeHead(200, {
              'Content-Type': 'application/pdf',
              'Content-Disposition': `attachment; filename="report-${safeName}.pdf"`,
              'Content-Length': pdf.length,
            });
            res.end(pdf);
          })
          .catch((err) => {
            log.error(`PDF generation failed: ${err}`);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'PDF generation failed' }));
            }
          });
        return;
      }

      // GET /api/reports/:id/snapshot/:filename: Download snapshot JPEG
      if (action === 'snapshot' && parts[2]) {
        const snapName = decodeURIComponent(parts[2]);
        if (snapName.includes('..') || !snapName.endsWith('.jpg')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid snapshot filename' }));
          return;
        }
        reportCollector
          .getSnapshot(reportId, snapName)
          .then((jpeg) => {
            if (jpeg) {
              res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length });
              res.end(jpeg);
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Snapshot not found' }));
            }
          })
          .catch(() => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to read snapshot' }));
          });
        return;
      }

      // GET /api/reports/:id: Report JSON
      reportCollector
        .getReport(reportId)
        .then((report) => {
          if (report) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(report));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Report not found' }));
          }
        })
        .catch(() => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to read report' }));
        });
      return;
    }

    if (url.startsWith('/api/reports/') && req.method === 'DELETE') {
      if (!reportCollector) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const reportId = decodeURIComponent(url.slice('/api/reports/'.length));
      if (!reportId || reportId.includes('..')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid report ID' }));
        return;
      }
      reportCollector
        .deleteReport(reportId)
        .then((ok) => {
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok }));
        })
        .catch(() => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to delete report' }));
        });
      return;
    }

    // ── Client error reporting ───────────────────────────────────────
    if (url === '/api/client-error' && req.method === 'POST') {
      handleClientError(req, res);
      return;
    }

    // Not an API route: hand the browser the SPA entry document, unless it asked for a
    // file, in which case a missing file must read as missing.
    writeSpaFallback(res, url, req.method);

    function handleClientError(req: IncomingMessage, res: ServerResponse): void {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        if (body.length > 8192) return; // cap at 8KB
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const data = JSON.parse(body) as {
            message?: string;
            stack?: string;
            url?: string;
            line?: number;
            col?: number;
          };
          const msg = typeof data.message === 'string' ? data.message.slice(0, 500) : 'unknown';
          const stack = typeof data.stack === 'string' ? data.stack.slice(0, 2000) : '';
          const url = typeof data.url === 'string' ? data.url.slice(0, 200) : '';
          const line = typeof data.line === 'number' ? data.line : 0;
          const col = typeof data.col === 'number' ? data.col : 0;
          log.warn(`[ClientError] ${msg} at ${url}:${line}:${col}${stack ? '\\n' + stack : ''}`);
          res.writeHead(204);
          res.end();
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
    }
  };
}

/* ── File upload helpers ──────────────────────────────────────────── */

function parseMultipart(
  body: Buffer,
  boundary: string,
): { fileName: string | null; fileData: Buffer | null } {
  const sep = Buffer.from(`--${boundary}`);
  let start = body.indexOf(sep);
  if (start === -1) return { fileName: null, fileData: null };

  // Find the part with Content-Disposition containing filename
  while (start !== -1) {
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), start);
    if (headerEnd === -1) break;

    const headers = body.subarray(start, headerEnd).toString('utf-8');
    const nameMatch = headers.match(/filename="([^"]+)"/);

    if (nameMatch) {
      const dataStart = headerEnd + 4;
      const nextBoundary = body.indexOf(sep, dataStart);
      const dataEnd = nextBoundary !== -1 ? nextBoundary - 2 : body.length; // -2 for \r\n before boundary
      return { fileName: nameMatch[1], fileData: body.subarray(dataStart, dataEnd) };
    }

    start = body.indexOf(sep, start + sep.length);
  }
  return { fileName: null, fileData: null };
}

function uploadChunk(
  printerIp: string,
  uploadPath: string,
  password: string,
  fileName: string,
  md5: string,
  chunk: Buffer,
  rangeStart: number,
  rangeEnd: number,
  totalSize: number,
): Promise<{ error_code: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: printerIp,
        port: 80,
        path: uploadPath,
        method: 'PUT',
        timeout: 30_000,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': chunk.length,
          'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${totalSize}`,
          'X-Token': password,
          'X-File-Name': encodeURIComponent(fileName),
          'X-File-MD5': md5,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (d: Buffer) => {
          body += d.toString();
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as { error_code: number });
          } catch {
            resolve({ error_code: -1 });
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Upload chunk timeout'));
    });
    req.write(chunk);
    req.end();
  });
}

function formatUploadSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ── Metrics helpers ─────────────────────────────────────────────── */

function fanPct(speed: number): number {
  return Math.round((speed / 255) * 100);
}

function buildMetrics(store: StateStore) {
  const s = store.status;
  const a = store.attributes;
  const ms = s?.machine_status;
  const ps = s?.print_status;
  const ext = s?.extruder;
  const bed = s?.heater_bed;
  const ch = s?.ztemperature_sensor;
  const fans = s?.fans;
  const gm = s?.gcode_move;
  const layers = store.layerTimes;

  const avgLayerDur =
    layers.length > 0 ? layers.reduce((sum, l) => sum + l.duration, 0) / layers.length : null;
  const lastLayerDur = layers.length > 0 ? layers[layers.length - 1].duration : null;

  return {
    printer: a
      ? {
          model: a.machine_model,
          sn: a.sn,
          ip: a.ip,
          firmware: a.software_version?.ota_version ?? null,
        }
      : null,
    connected: !!_bridge?.isConnected,
    state: {
      status: ms?.status ?? null,
      status_name: STATUS_NAMES[ms?.status ?? -1] ?? 'Unknown',
      sub_status: ms?.sub_status ?? null,
      sub_status_name: SUB_STATUS_NAMES[ms?.sub_status ?? 0] || null,
      progress: ms?.progress ?? null,
      exceptions: (ms?.exception_status ?? []).map((c) => ({
        code: c,
        name: EXCEPTION_NAMES[c] ?? `Unknown (${c})`,
      })),
    },
    temperature: {
      nozzle: ext?.temperature ?? null,
      nozzle_target: ext?.target ?? null,
      bed: bed?.temperature ?? null,
      bed_target: bed?.target ?? null,
      chamber: ch?.temperature ?? null,
    },
    fans: fans
      ? {
          part_fan: fanPct(fans.fan?.speed ?? 0),
          aux_fan: fanPct(fans.aux_fan?.speed ?? 0),
          box_fan: fanPct(fans.box_fan?.speed ?? 0),
          heater_fan: fanPct(fans.heater_fan?.speed ?? 0),
          controller_fan: fanPct(fans.controller_fan?.speed ?? 0),
        }
      : null,
    position: gm
      ? {
          x: gm.x,
          y: gm.y,
          z: gm.z,
          speed: gm.speed,
          speed_mode: gm.speed_mode,
          speed_mode_name: SPEED_MODE_NAMES[gm.speed_mode] ?? 'Unknown',
        }
      : null,
    print: ps
      ? {
          filename: ps.filename || null,
          current_layer: ps.current_layer,
          total_layer: ps.total_layer ?? store.fileTotalLayers ?? null,
          print_duration: ps.print_duration,
          remaining_time_sec: ps.remaining_time_sec,
        }
      : null,
    filament_detected: ext?.filament_detected ?? null,
    filament_usage: store.getFilamentUsageArray(),
    layers: {
      count: layers.length,
      avg_duration_sec: avgLayerDur != null ? Math.round(avgLayerDur * 10) / 10 : null,
      last_duration_sec: lastLayerDur ?? null,
    },
  };
}

function buildPrometheusMetrics(store: StateStore): string {
  const lines: string[] = [];
  const s = store.status;
  const a = store.attributes;
  const ms = s?.machine_status;
  const ps = s?.print_status;
  const ext = s?.extruder;
  const bed = s?.heater_bed;
  const ch = s?.ztemperature_sensor;
  const fans = s?.fans;
  const gm = s?.gcode_move;
  const layers = store.layerTimes;

  const labels = a ? `model="${a.machine_model}",sn="${a.sn}"` : '';

  function g(name: string, help: string, value: number | null | undefined, extra = '') {
    if (value == null) return;
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    const lab = [labels, extra].filter(Boolean).join(',');
    lines.push(`${name}{${lab}} ${value}`);
  }

  // Connection
  g(
    'elegoo_connected',
    'Printer MQTT connection state (1=connected, 0=disconnected)',
    _bridge?.isConnected ? 1 : 0,
  );

  // Machine state
  g('elegoo_machine_status', 'Machine status code', ms?.status);
  g('elegoo_machine_sub_status', 'Machine sub-status code', ms?.sub_status);
  g('elegoo_print_progress', 'Print progress percentage (0-100)', ms?.progress);

  // Temperatures
  g('elegoo_nozzle_temperature_celsius', 'Nozzle temperature', ext?.temperature);
  g('elegoo_nozzle_target_celsius', 'Nozzle target temperature', ext?.target);
  g('elegoo_bed_temperature_celsius', 'Bed temperature', bed?.temperature);
  g('elegoo_bed_target_celsius', 'Bed target temperature', bed?.target);
  g('elegoo_chamber_temperature_celsius', 'Chamber temperature', ch?.temperature);

  // Fans (as percentage 0-100)
  if (fans) {
    const fanEntries: [string, FanInfo | undefined][] = [
      ['part', fans.fan],
      ['aux', fans.aux_fan],
      ['box', fans.box_fan],
      ['heater', fans.heater_fan],
      ['controller', fans.controller_fan],
    ];
    lines.push('# HELP elegoo_fan_speed_percent Fan speed percentage');
    lines.push('# TYPE elegoo_fan_speed_percent gauge');
    for (const [name, fi] of fanEntries) {
      if (fi == null) continue;
      const lab = [labels, `fan="${name}"`].filter(Boolean).join(',');
      lines.push(`elegoo_fan_speed_percent{${lab}} ${fanPct(fi.speed)}`);
    }
  }

  // Position
  if (gm) {
    g('elegoo_position_x_mm', 'Toolhead X position', gm.x);
    g('elegoo_position_y_mm', 'Toolhead Y position', gm.y);
    g('elegoo_position_z_mm', 'Toolhead Z position', gm.z);
    g('elegoo_speed_mm_per_min', 'Toolhead speed', gm.speed);
    g('elegoo_speed_mode', 'Speed mode (0=Silent,1=Balanced,2=Sport,3=Ludicrous)', gm.speed_mode);
  }

  // Print info
  if (ps) {
    g('elegoo_print_current_layer', 'Current print layer', ps.current_layer);
    g(
      'elegoo_print_total_layers',
      'Total print layers',
      ps.total_layer ?? store.fileTotalLayers ?? undefined,
    );
    g('elegoo_print_duration_seconds', 'Elapsed print time in seconds', ps.print_duration);
    g(
      'elegoo_print_remaining_seconds',
      'Estimated remaining time in seconds',
      ps.remaining_time_sec,
    );
  }

  // Filament detected
  g('elegoo_filament_detected', 'Filament detected (1=yes, 0=no)', ext?.filament_detected);

  // Filament usage per spool
  const usage = store.getFilamentUsageArray();
  if (usage.length > 0) {
    lines.push('# HELP elegoo_filament_used_grams Filament used in grams');
    lines.push('# TYPE elegoo_filament_used_grams gauge');
    for (const u of usage) {
      const lab = [labels, `tray="${u.trayKey}",type="${u.filamentType}"`]
        .filter(Boolean)
        .join(',');
      lines.push(`elegoo_filament_used_grams{${lab}} ${Math.round(u.grams * 100) / 100}`);
    }
    lines.push('# HELP elegoo_filament_used_meters Filament used in meters');
    lines.push('# TYPE elegoo_filament_used_meters gauge');
    for (const u of usage) {
      const lab = [labels, `tray="${u.trayKey}",type="${u.filamentType}"`]
        .filter(Boolean)
        .join(',');
      lines.push(`elegoo_filament_used_meters{${lab}} ${Math.round(u.meters * 1000) / 1000}`);
    }
  }

  // Layer stats
  if (layers.length > 0) {
    g('elegoo_layer_count', 'Number of recorded layer times', layers.length);
    const avgDur = layers.reduce((sum, l) => sum + l.duration, 0) / layers.length;
    g('elegoo_layer_avg_duration_seconds', 'Average layer duration', Math.round(avgDur * 10) / 10);
    g(
      'elegoo_layer_last_duration_seconds',
      'Last layer duration',
      layers[layers.length - 1].duration,
    );
  }

  // Exceptions
  const exceptions = ms?.exception_status ?? [];
  if (exceptions.length > 0) {
    lines.push('# HELP elegoo_exception Active exception (1=active)');
    lines.push('# TYPE elegoo_exception gauge');
    for (const code of exceptions) {
      const name = EXCEPTION_NAMES[code] ?? `unknown_${code}`;
      const lab = [labels, `code="${code}",name="${name}"`].filter(Boolean).join(',');
      lines.push(`elegoo_exception{${lab}} 1`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
