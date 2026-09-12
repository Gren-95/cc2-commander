/**
 * WebSocket transport — serves browser clients.
 *
 * Protocol (JSON messages):
 *
 * Server → Client:
 *   { type: "init", sn, attributes, status, canvas, files, ... , serviceStatus }
 *   { type: "response", method, data }     // forwarded from printer api_response
 *   { type: "status", data }               // forwarded from printer api_status (delta)
 *   { type: "raw", direction, topic, data } // MQTT raw log entry
 *   { type: "connection", connected }       // printer connection state
 *   { type: "service_status", ... }         // periodic service health
 *
 * Client → Server:
 *   { type: "command", method, params }     // forwarded to printer api_request
 */

import type { ServerWebSocket, WebSocketHandler } from 'bun';
import type { StateStore, EventLogEntry } from './state-store.js';
import { getCameraHealth } from './rest-api.js';
import type { MqttBridge } from './mqtt-bridge.js';
import type { TelegramIntegration } from './telegram.js';
import type { AIMonitor } from './ai-monitor.js';
import { getLogger } from './logger.js';
import { getBuildInfo } from './build-info.js';

const log = getLogger('WS');

export interface ServiceStatusProvider {
  telegram: TelegramIntegration | null;
  aiMonitor: AIMonitor | null;
}

/** Per-connection state. Nothing to carry yet, but `upgrade()` requires the slot. */
export interface BrowserSocketData {
  readonly connectedAt: number;
}

export type BrowserSocket = ServerWebSocket<BrowserSocketData>;

const WS_OPEN = 1;

export class WebSocketTransport {
  private readonly clients = new Set<BrowserSocket>();
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private services: ServiceStatusProvider = { telegram: null, aiMonitor: null };
  private startTime = Date.now();

  constructor(
    private store: StateStore,
    private bridge: MqttBridge,
  ) {
    // Forward events from state store to all WS clients
    store.on('response', (method: number, data: Record<string, unknown>) => {
      this.broadcast({ type: 'response', method, data });
    });

    store.on('status', (data: Record<string, unknown>) => {
      this.broadcast({ type: 'status', data });
    });

    store.on('raw', (entry: { direction: string; topic: string; data: unknown; ts: number }) => {
      this.broadcast({ type: 'raw', ...entry });
    });

    store.on('chart_data', (point: { t: number; values: Record<string, number> }) => {
      this.broadcast({ type: 'chart_data', ...point });
    });

    store.on('event_log', (entry: EventLogEntry) => {
      this.broadcast({ type: 'event_log', ...entry });
    });

    store.on('layer_time', (entry: { layer: number; duration: number; timestamp: number }) => {
      this.broadcast({ type: 'layer_time', ...entry });
    });

    store.on('layer_clear', () => {
      this.broadcast({ type: 'layer_clear' });
    });

    store.on('filament_usage', (usage: unknown[]) => {
      this.broadcast({ type: 'filament_usage', usage });
    });

    store.on(
      'zone_change',
      (data: { from: string; to: string; x: number; y: number; timestamp: number }) => {
        this.broadcast({ type: 'zone_change', ...data });
      },
    );

    store.on(
      'ai_chart_data',
      (point: { t: number; motion: number; scores: Record<string, number> }) => {
        this.broadcast({ type: 'ai_chart_data', ...point });
      },
    );

    bridge.on('connected', () => {
      this.broadcast({ type: 'connection', connected: true, sn: bridge.serialNumber });
      // Re-send full init to all clients after reconnect
      for (const client of this.clients) {
        if (client.readyState === WS_OPEN) {
          this.sendInit(client);
        }
      }
    });

    bridge.on('disconnected', () => {
      this.broadcast({ type: 'connection', connected: false });
    });

    // Broadcast service status every 5 seconds
    this.statusInterval = setInterval(() => {
      this.broadcast({ type: 'service_status', ...this.getServiceStatus() });
    }, 5000);
  }

  /** Provide references to optional services for status reporting */
  setServices(services: ServiceStatusProvider): void {
    this.services = services;
  }

  /** The per-connection data `server.upgrade()` should attach. */
  upgradeData(): BrowserSocketData {
    return { connectedAt: Date.now() };
  }

  /**
   * The `websocket` handler table for `Bun.serve`.
   *
   * Bun owns the socket itself — no `ws` package, no Node stream per connection, and
   * the upgrade is decided in `fetch()` rather than by a second `upgrade` listener
   * bolted onto an http.Server.
   */
  readonly handlers: WebSocketHandler<BrowserSocketData> = {
    open: (ws) => {
      this.clients.add(ws);
      log.info(`Client connected (total: ${this.clients.size})`);
      this.sendInit(ws);
    },
    message: (ws, message) => {
      this.handleClientMessage(ws, typeof message === 'string' ? message : message.toString());
    },
    close: (ws) => {
      this.clients.delete(ws);
      log.info(`Client disconnected (total: ${this.clients.size})`);
    },
  };

  /** Live browser connections, for /api/health and the status broadcast. */
  get clientCount(): number {
    return this.clients.size;
  }

  private getServiceStatus(): Record<string, unknown> {
    // Detailed MQTT state: 'connected' | 'broker_only' | 'disconnected'
    let mqttState = 'disconnected';
    if (this.bridge.isConnected) {
      mqttState = 'connected';
    } else if (this.bridge.brokerConnected) {
      mqttState = 'broker_only';
    }

    return {
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      // Which build is serving this (ELEG-48). Already on /api/health, but nothing in
      // the browser fetches that, and the UI is where "which build am I looking at?"
      // actually gets asked. Cached per process, so this costs nothing per broadcast.
      build: getBuildInfo(),
      mqtt: mqttState,
      // The coarse `mqtt` above is kept as-is for any existing consumer; `mqttPhase`
      // splits its `broker_only` into awaiting_sn / registering / rejected, which is the
      // distinction a human actually needs (ELEG-59).
      mqttPhase: this.bridge.phase,
      mqttRegisterAttempts: this.bridge.registerAttempts,
      printerSn: this.bridge.serialNumber || null,
      printerIp: this.bridge.ip,
      wsClients: this.clients.size,
      telegram: this.services.telegram
        ? this.services.telegram.isRunning
          ? 'running'
          : 'stopped'
        : 'disabled',
      ai: this.services.aiMonitor
        ? this.services.aiMonitor.monitoring
          ? 'monitoring'
          : this.services.aiMonitor.isRunning
            ? 'idle'
            : 'stopped'
        : 'disabled',
      aiConfig: this.services.aiMonitor?.getConfigSummary() ?? null,
      camera: getCameraHealth(),
    };
  }

  private sendInit(ws: BrowserSocket): void {
    const msg = {
      type: 'init',
      connected: this.bridge.isConnected,
      sn: this.bridge.serialNumber,
      printerIp: this.bridge.ip,
      attributes: this.store.attributes,
      status: this.store.status,
      canvas: this.store.canvas,
      files: this.store.files,
      thumbnail: this.store.thumbnail,
      thumbnailFailed: this.store.thumbnailFailed,
      fileTotalLayers: this.store.fileTotalLayers,
      timelapseList: this.store.timelapseList,
      videoUrl: this.store.videoUrl,
      zones: this.store.zones,
      layerTimes: this.store.layerTimes,
      filamentUsage: this.store.getFilamentUsageArray(),
      chartHistory: this.store.getChartHistory(),
      aiChartHistory: this.store.getAIChartHistory(),
      eventLog: this.store.getEventLog(),
      serviceStatus: this.getServiceStatus(),
    };
    ws.send(JSON.stringify(msg));
  }

  private handleClientMessage(_ws: BrowserSocket, raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'command') {
      const method = msg.method as number;
      const params = (msg.params as Record<string, unknown>) ?? {};
      if (typeof method === 'number') {
        this.bridge.sendCommand(method, params);
      }
    }
  }

  /** Max queued bytes before dropping messages for a slow client */
  private static readonly MAX_BUFFERED = 1024 * 1024; // 1 MB

  /**
   * Deliberately NOT `server.publish()`, which would serialise once and let uWebSockets
   * fan out. Publish has no per-client hook, and the slow-client drop below is load
   * bearing: this service pushes a status frame every 5s plus every MQTT delta, and a
   * browser on a stalled link would otherwise grow an unbounded send queue.
   */
  broadcast(data: unknown): void {
    const json = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState !== WS_OPEN) continue;
      const buffered = client.getBufferedAmount();
      if (buffered > WebSocketTransport.MAX_BUFFERED) {
        log.warn(`Dropping message for slow client (buffered: ${buffered})`);
        continue;
      }
      client.send(json);
    }
  }

  close(): void {
    if (this.statusInterval) clearInterval(this.statusInterval);
    for (const client of this.clients) client.close(1001, 'Server shutting down');
    this.clients.clear();
  }
}
