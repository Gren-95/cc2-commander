/**
 * Ambient temperature and humidity, read from Home Assistant.
 *
 * The printer reports its own chamber, nozzle and bed. What it cannot tell you is the
 * humidity of the room the filament is sitting in — and that is the number that decides
 * whether PLA prints cleanly or strings, and whether a drying session was worth running.
 * Home Assistant usually already has a sensor for it.
 *
 * ## Read-only, and deliberately so
 *
 * This polls `GET /api/states/<entity>` and never writes. A long-lived access token in
 * Home Assistant carries the permissions of the user who made it, which for most people
 * is an administrator — so a bug here could otherwise unlock a door. Nothing in this
 * file issues anything but GET.
 *
 * ## Never breaks the dashboard
 *
 * Home Assistant is someone else's service on the same LAN: it reboots, it updates, its
 * token expires. Every failure degrades to `reachable: false` and a message, and the
 * rest of the dashboard carries on — a printer dashboard that goes dark because a
 * thermometer is unreachable would be a poor trade.
 */

import { EventEmitter } from 'events';
import { getLogger } from './logger.js';

const log = getLogger('HomeAssistant');

/**
 * How often the entities are re-read.
 *
 * Room temperature and humidity move over minutes, not seconds, and each poll is one
 * HTTP request per entity against a machine that is usually also running someone's
 * lights. 60s is frequent enough to watch a dryer pull moisture out of a room.
 */
const POLL_MS = 60_000;

/**
 * How many humidity samples to keep: twelve hours at one a minute.
 *
 * Long enough for any drying session — the panel caps a session at 12h — and small
 * enough that shipping the whole array to each client on every poll stays trivial
 * (720 points is about 18KB of JSON).
 */
const HISTORY_MAX = 720;

/** A request that hangs must not wedge the poll loop behind it. */
const TIMEOUT_MS = 5_000;

export interface HaReading {
  entityId: string;
  /** Friendly name from Home Assistant, falling back to the entity id. */
  name: string;
  value: number;
  unit: string;
  /** `temperature`, `humidity`, or whatever else the entity declares. */
  deviceClass: string;
  /** When Home Assistant last changed it, not when we read it. */
  changedAt: string;
}

/** One humidity sample: when it was taken, and what it read. */
export interface HaSample {
  t: number;
  v: number;
}

export interface HaState {
  configured: boolean;
  reachable: boolean;
  readings: HaReading[];
  lastError: string | null;
  lastPolledAt: number | null;
  /**
   * Recent humidity, oldest first.
   *
   * Kept here rather than in the browser because a drying session runs for hours and a
   * page reload would otherwise start the trace again from nothing — the same reason
   * the session itself is owned by the service. It is in memory only: a service restart
   * loses the curve but not the session, which is the right way round.
   */
  humidityHistory: HaSample[];
}

/** The half of an entity payload this cares about. */
interface HaEntityPayload {
  entity_id?: unknown;
  state?: unknown;
  last_changed?: unknown;
  attributes?: {
    friendly_name?: unknown;
    unit_of_measurement?: unknown;
    device_class?: unknown;
  };
}

/**
 * Turn one `/api/states/<entity>` body into a reading, or null if it is not one.
 *
 * Pure, and exported for that reason — this is where the shapes Home Assistant actually
 * returns get handled, and they are more varied than the docs suggest. `state` is always
 * a STRING, including for numbers; an entity that is unavailable reports the literal
 * `"unavailable"` or `"unknown"` rather than an error, and a sensor that has never
 * reported can carry `null`. All three must come back as "no reading" rather than as
 * `NaN` rendered on a dashboard.
 */
export function parseEntity(body: unknown): HaReading | null {
  if (!body || typeof body !== 'object') return null;
  const entity = body as HaEntityPayload;

  const entityId = typeof entity.entity_id === 'string' ? entity.entity_id : '';
  if (!entityId) return null;

  const raw = entity.state;
  if (typeof raw !== 'string' || raw === 'unavailable' || raw === 'unknown' || raw === '') {
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;

  const attributes = entity.attributes ?? {};
  return {
    entityId,
    name: typeof attributes.friendly_name === 'string' ? attributes.friendly_name : entityId,
    value,
    unit: typeof attributes.unit_of_measurement === 'string' ? attributes.unit_of_measurement : '',
    deviceClass: typeof attributes.device_class === 'string' ? attributes.device_class : '',
    changedAt: typeof entity.last_changed === 'string' ? entity.last_changed : '',
  };
}

/**
 * Split the configured entity list.
 *
 * Exported so the config can validate what it was given rather than discovering at the
 * first poll that someone wrote `sensor.a; sensor.b`.
 */
export function parseEntityList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export class HomeAssistantService extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: HaState;
  private humidityHistory: HaSample[] = [];

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly entities: string[],
  ) {
    super();
    this.state = {
      configured: this.enabled,
      reachable: false,
      readings: [],
      lastError: null,
      lastPolledAt: null,
      humidityHistory: [],
    };
  }

  private get enabled(): boolean {
    return Boolean(this.baseUrl && this.token && this.entities.length);
  }

  getState(): HaState {
    return this.state;
  }

  /** Begin polling. A no-op when it is not configured, so callers need no branch. */
  start(): void {
    if (!this.enabled || this.timer) return;
    log.info(
      `Polling ${this.entities.length} entit${this.entities.length === 1 ? 'y' : 'ies'} every ${POLL_MS / 1000}s`,
    );
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    // Not `unref`'d: this is a long-running service, and the loop is what keeps the
    // readings fresh for however long the dashboard is open.
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async fetchEntity(entityId: string): Promise<HaReading | null> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/api/states/${encodeURIComponent(entityId)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // 401 is the one worth naming: it means the token, not the entity, and it will
      // not fix itself on the next poll.
      throw new Error(
        res.status === 401
          ? 'Home Assistant rejected the token (401) — is HOMEASSISTANT_TOKEN still valid?'
          : `Home Assistant returned ${res.status} for ${entityId}`,
      );
    }
    return parseEntity(await res.json());
  }

  private async poll(): Promise<void> {
    if (!this.enabled) return;
    try {
      const settled = await Promise.all(
        this.entities.map(async (id) => {
          try {
            return await this.fetchEntity(id);
          } catch (err) {
            // One bad entity must not blank the others — a renamed sensor is the common
            // case, and the rest are still worth showing.
            log.warn(`${id}: ${(err as Error).message}`);
            return null;
          }
        }),
      );
      const readings = settled.filter((r): r is HaReading => r !== null);
      const wasReachable = this.state.reachable;

      // Record humidity against OUR clock, not Home Assistant's `last_changed`. A
      // sensor that has gone quiet keeps reporting the same `last_changed` forever, and
      // sampling on that would draw a flat line that looks like a stable reading rather
      // than an absent one. Timestamping the poll makes a dead sensor draw a flat line
      // that the staleness label explains.
      const humidity = readings.find((r) => r.deviceClass === 'humidity');
      if (humidity) {
        this.humidityHistory.push({ t: Date.now(), v: humidity.value });
        if (this.humidityHistory.length > HISTORY_MAX) {
          this.humidityHistory = this.humidityHistory.slice(-HISTORY_MAX);
        }
      }

      this.state = {
        configured: true,
        reachable: readings.length > 0,
        readings,
        lastError: readings.length > 0 ? null : 'No entity returned a usable value',
        lastPolledAt: Date.now(),
        humidityHistory: this.humidityHistory,
      };
      if (!wasReachable && this.state.reachable) {
        log.info(`Connected — ${readings.map((r) => `${r.name} ${r.value}${r.unit}`).join(', ')}`);
      }
      this.emit('readings', this.state);
    } catch (err) {
      const message = (err as Error).message;
      if (this.state.lastError !== message) log.warn(message);
      this.state = {
        ...this.state,
        reachable: false,
        lastError: message,
        lastPolledAt: Date.now(),
      };
      this.emit('readings', this.state);
    }
  }
}
