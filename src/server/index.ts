/**
 * Elegoo CC2 Service — single MQTT connection shared by all consumers.
 *
 * Architecture:
 *   Printer MQTT ←→ MqttBridge (singleton) ←→ StateStore
 *                                               ↓
 *                            ┌──────────────────┼──────────────────┐
 *                            WebSocket        REST/Camera      Telegram
 *                           (browsers)        (snapshots)       (bot)
 *
 * The front door is `Bun.serve`. Three things reach the socket by three different
 * paths, fastest first:
 *
 *   dist/**   Bun's static route table, built once at startup (spa.ts). Served
 *             without entering JavaScript — this is the SPA's whole asset burst.
 *   /ws       Bun's native WebSocket server (ws-transport.ts). No `ws` package.
 *   the rest  the existing Node-style routers, through the adapter in node-compat.ts.
 */

import { runNodeHandler, type NodeHandler } from './node-compat.js';
import { buildStaticRoutes } from './spa.js';
import { loadConfig } from './config.js';
import { MqttBridge } from './mqtt-bridge.js';
import { StateStore } from './state-store.js';
import { WebSocketTransport } from './ws-transport.js';
import { createRestRouter, precacheGcode } from './rest-api.js';
import { SessionStore, hashPassword } from './auth.js';
import { AuthGate } from './auth-gate.js';
import { createOctoPrintRouter } from './octoprint-compat.js';
import { createMoonrakerRouter } from './moonraker-compat.js';
import { MoonrakerServer } from './moonraker-server.js';
import { TelegramIntegration } from './telegram.js';
import { StatePersistence } from './state-persistence.js';
import { AIMonitor, type AIAlert } from './ai-monitor.js';
import { PrintReportCollector } from './print-report-collector.js';
import { getBuildInfo } from './build-info.js';
import { applyCors, corsHeaders } from './cors.js';
import { initLogger, getLogger } from './logger.js';
import { initDataPaths } from './data-paths.js';
import { readCachedSn, writeCachedSn } from './sn-cache.js';

const config = loadConfig();
initLogger(config.dataDir);
// Beside initLogger on purpose: both exist so DATA_DIR is honoured from one place, and
// keeping them adjacent is what stops the next path from drifting back to cwd (ELEG-70).
initDataPaths(config.dataDir);
const log = getLogger('Service');

// Read the deploy stamp here so it is in the startup banner and in the process cache
// before the first /api/health request arrives.
const build = getBuildInfo();

// --- MQTT Bridge (singleton connection to printer) ---
// A remembered SN turns "wait for the printer to say something" into "register now".
// Without it a restart can hang in broker_only indefinitely (ELEG-60).
const knownSn = config.printerSn || readCachedSn(config.dataDir);
const bridge = new MqttBridge(config.printerIp, config.printerPassword, knownSn, (sn) =>
  writeCachedSn(config.dataDir, sn),
);

log.info('🖨  Elegoo CC2 Service');
log.info(
  `Build:   ${build.describe ?? build.shortCommit ?? 'unstamped (not an installed deploy?)'}`,
);
log.info(
  `Printer: ${config.printerIp}${knownSn ? ` (SN ${knownSn}${config.printerSn ? ', from PRINTER_SN' : ', cached'})` : ' (SN not yet known)'}`,
);
log.info(`Service: http://0.0.0.0:${config.servicePort}`);
log.info(`Camera:  ${config.cameraEnabled ? config.cameraUrl : 'disabled'}`);
log.info(`Data:    ${config.dataDir}`);
if (config.telegramEnabled) {
  log.info(`Telegram: enabled (progress every ${config.progressInterval}%)`);
}
if (config.aiEnabled) {
  log.info(
    `AI:       enabled (VLM: ${config.aiVlmEnabled ? config.aiVlmModel : 'off'}, Local: ${config.aiLocalEnabled ? 'on' : 'off'})`,
  );
}
log.info(`Moonraker: http://0.0.0.0:${config.moonrakerPort}`);
if (config.auth.enabled) {
  log.info(`Auth:    enabled (API key ${config.auth.apiKey ? 'set' : 'NOT set'})`);
} else {
  // Loud, and specific about what is reachable. A quiet "auth: off" is how a service
  // ends up on the public internet with `emergency_stop` open to anyone who finds it.
  log.warn(
    'Auth:    DISABLED — every endpoint answers without credentials, including ' +
      'printer control (set_temperature, move, start_print, emergency_stop) and the ' +
      'camera. Set AUTH_PASSWORD or AUTH_PASSWORD_HASH in .env to require a login.',
  );
}

// --- State Store (shared state for all consumers) ---
const store = new StateStore(bridge, config.progressInterval);

// Pre-download gcode to cache when a print starts so the preview
// can be served from cache instead of hitting the busy printer
store.on('print_event', (event: { type: string; filename?: string }) => {
  if (event.type === 'print_started' && event.filename) {
    precacheGcode(event.filename, config);
  }
});

// --- State Persistence ---
const persistence = new StatePersistence(store, config.dataDir);

// --- Telegram Bot (optional) ---
let telegram: TelegramIntegration | null = null;
if (config.telegramEnabled) {
  telegram = new TelegramIntegration(store, bridge, config);
}

// --- AI Monitor (optional, created early so REST API can reference it) ---
let aiMonitor: AIMonitor | null = null;
if (config.aiEnabled) {
  aiMonitor = new AIMonitor(store, config);
}

// --- Print Report Collector ---
const reportCollector = new PrintReportCollector(store, config);

// --- HTTP Server ---
const restHandler = createRestRouter(
  store,
  config,
  aiMonitor,
  reportCollector,
  bridge,
  (req) => authGate.authenticate(req).ok,
);
const octoPrintHandler = createOctoPrintRouter(store, bridge, config);
const moonrakerHandler = createMoonrakerRouter(store, bridge, config);

/**
 * The non-static, non-WebSocket half of the service, unchanged from when this was an
 * `http.createServer` callback — one `res` threaded through the whole chain, so the
 * CORS headers each branch applies still survive a fall-through to the next router.
 */
/**
 * Single-user auth. Built before the router because every branch below consults it.
 *
 * `AUTH_PASSWORD` is hashed here rather than in `loadConfig` because hashing is async
 * and config loading is not — argon2 is deliberately slow, which is the point of it.
 */
const sessions = new SessionStore(config.auth);
if (config.auth.enabled && !config.auth.passwordHash) {
  config.auth.passwordHash = await hashPassword(process.env.AUTH_PASSWORD ?? '');
}
const authGate = new AuthGate(config.auth, sessions);

// Expired entries are only dropped when something touches them, so nothing reclaims the
// memory of a session or a throttled address that is never seen again.
setInterval(
  () => {
    sessions.prune();
    authGate.throttle.prune();
  },
  60 * 60 * 1000,
).unref();

const moonrakerServer = new MoonrakerServer(store, bridge, config, authGate);

const nodeRouter: NodeHandler = (req, res) => {
  const url = req.url || '';

  // Auth first, for every surface at once. Putting it here rather than in each of
  // /octoprint, /moonraker and rest-api is the whole point: `.agents/security.md`
  // records that the CORS fix had to be applied five times and the :7125 server was
  // nearly missed. A new endpoint is protected by existing, not by remembering.
  if (authGate.handle(req, res)) return;
  if (!authGate.require(req, res)) return;

  // OctoPrint compatibility API
  if (url === '/octoprint' || url.startsWith('/octoprint/') || url.startsWith('/octoprint?')) {
    applyCors(
      res,
      corsHeaders(
        config.corsPolicy,
        req.headers.origin,
        'GET, POST, OPTIONS',
        'Content-Type, X-Api-Key, Authorization',
      ),
    );
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (octoPrintHandler(req, res)) return;
  }

  // Moonraker compatibility API
  if (url === '/moonraker' || url.startsWith('/moonraker/') || url.startsWith('/moonraker?')) {
    applyCors(
      res,
      corsHeaders(
        config.corsPolicy,
        req.headers.origin,
        'GET, POST, DELETE, OPTIONS',
        'Content-Type, Authorization',
      ),
    );
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (moonrakerHandler(req, res)) return;
  }

  restHandler(req, res);
};

// --- WebSocket Transport (for browser clients) ---
const wsTransport = new WebSocketTransport(store, bridge);

// Provide service references for status panel
wsTransport.setServices({ telegram, aiMonitor });

// Forward AI events to WS clients
if (aiMonitor) {
  aiMonitor.on('analysis', (analysis: Record<string, unknown>) => {
    wsTransport.broadcast({ type: 'ai_analysis', ...analysis });
  });

  aiMonitor.on('alert', (alert: AIAlert) => {
    wsTransport.broadcast({ type: 'ai_alert', ...alert });
    // Also send to Telegram
    if (telegram) {
      telegram.sendAIAlert(alert);
    }
  });

  aiMonitor.on(
    'ai_chart_data',
    (data: { t: number; motion: number; scores: Record<string, number> }) => {
      store.pushAIChartData(data);
    },
  );
}

let server: ReturnType<typeof Bun.serve> | null = null;

// --- Startup ---
async function start(): Promise<void> {
  // Restore persisted state before connecting
  await persistence.load();
  persistence.start();

  // Initialize report collector
  await reportCollector.init();

  // Start MQTT connection
  bridge.connect();

  // Start HTTP + WebSocket server. Bun.serve binds as soon as it is constructed, so
  // it is created here rather than at module scope — nothing is answered until the
  // persisted state is back and the report collector is initialised.
  server = Bun.serve({
    port: config.servicePort,
    hostname: '0.0.0.0',

    // dist/**, answered from Bun's route table without running any of our code.
    routes: buildStaticRoutes(),

    // The camera endpoints hold a response open for as long as the client watches,
    // and 255s is the ceiling Bun allows. The MJPEG stream writes a frame every few
    // hundred milliseconds, so this only bites when the upstream camera itself stalls.
    idleTimeout: 255,

    fetch(request, self) {
      const { pathname } = new URL(request.url);

      if (pathname === '/ws') {
        // The upgrade carries the session cookie like any same-origin request. Refusing
        // here rather than after the handshake means an unauthenticated client never
        // reaches the command frames at all.
        if (
          !authGate.allowsUpgrade({
            headers: { cookie: request.headers.get('cookie') ?? undefined },
          })
        ) {
          return new Response('Authentication required', { status: 401 });
        }
        if (self.upgrade(request, { data: wsTransport.upgradeData() })) return undefined;
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }

      return runNodeHandler(nodeRouter, request, self.requestIP(request)?.address);
    },

    websocket: wsTransport.handlers,

    error(err) {
      log.error('Unhandled request error:', err);
      return new Response('Internal server error', { status: 500 });
    },
  });

  log.info(`Listening on :${server.port}`);

  // Start dedicated Moonraker compat server
  moonrakerServer.start();

  // Start Telegram bot if configured
  if (telegram) {
    await telegram.start();
  }

  // Start AI monitor if configured
  if (aiMonitor) {
    await aiMonitor.start();
  }
}

// Graceful shutdown
function shutdown(): void {
  log.info('Shutting down...');
  aiMonitor?.stop();
  persistence.stop();
  moonrakerServer.stop();
  wsTransport.close();
  telegram?.stop();
  bridge.disconnect();
  server?.stop(true);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
