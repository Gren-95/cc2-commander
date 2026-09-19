// No dotenv: Bun loads `.env` (and `.env.local`, `.env.<NODE_ENV>`) before any user code
// runs, so the import was a no-op that still pulled a package. This service has required
// Bun as its runtime since the Node/pnpm/tsx removal, so there is no path where the
// variables would go unloaded.
import { parseAllowedChatIds } from './allowlist.js';
import { type CorsPolicy, parseCorsPolicy } from './cors.js';
import { parseEntityList } from './home-assistant.js';

export interface ServiceConfig {
  // Printer
  printerIp: string;
  printerPassword: string;
  /**
   * Optional serial-number override. Normally discovered and then cached, but a
   * printer that is silent at startup can never be discovered — so this lets a first
   * start register immediately (ELEG-60). Empty means "discover it".
   */
  printerSn: string;

  // Authentication (single user; see src/server/auth.ts)
  auth: {
    enabled: boolean;
    passwordHash: string;
    /** `AUTH_PASSWORD`, hashed by `initAuth()` at startup and never stored. */
    plainPassword: string;
    /**
     * `AUTH_SECRET`. Signs session tokens so they survive a restart; empty keeps
     * sessions memory-only, which is what they were.
     */
    sessionSecret: string;
    apiKey: string;
    absoluteTtlMs: number;
    idleTtlMs: number;
  };

  // Service
  servicePort: number;
  /**
   * The interface both HTTP servers (the main service and the separate Moonraker `:7125`
   * one) bind to. Defaults to `0.0.0.0`, which is what they always did: who *should* be
   * able to reach a service that drives a physical machine is the operator's decision,
   * not this default's. Also reported back to Moonraker clients in `server.config`,
   * since that is what real Moonraker does.
   */
  bindAddress: string;

  // Camera
  cameraEnabled: boolean;
  cameraUrl: string;

  /** Cross-origin policy for every HTTP surface; defaults to same-origin (ELEG-24) */
  corsPolicy: CorsPolicy;

  // Telegram (optional)
  telegramEnabled: boolean;
  telegramToken: string;
  telegramChatId: string;
  /** Numeric sender ids permitted to issue bot commands; empty denies everyone (ELEG-3) */
  telegramAllowedChatIds: string[];
  progressInterval: number;

  // Data persistence
  dataDir: string;

  // Moonraker compat server (optional)
  moonrakerPort: number;

  /**
   * Home Assistant (optional): ambient temperature and humidity the printer cannot
   * measure itself, and optionally an entity to ring on a critical error or a failed
   * print. Reading is unconditionally on once configured; ringing is the one write this
   * service makes to Home Assistant — see the note in `home-assistant.ts` about what a
   * long-lived token can do, and why that stays as narrow as one entity.
   */
  homeAssistant: {
    enabled: boolean;
    url: string;
    /** Long-lived access token. A SECRET: never logged, never sent to the browser. */
    token: string;
    entities: string[];
    /** Empty when not configured — ringing the buzzer is then a no-op, not an error. */
    buzzerEntity: string;
  };

  // AI monitoring (optional)
}

function env(key: string, fallback = ''): string {
  return process.env[key] || fallback;
}

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function validatePort(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid ${name}: ${value} (must be 1-65535)`);
  }
}

/**
 * Validates a dotted-quad IPv4 address, for `PRINTER_IP` and `BIND_ADDRESS`. Throws an
 * actionable message at startup rather than letting a bad value reach `listen()`, where a
 * malformed address surfaces as an opaque `EADDRNOTAVAIL`.
 *
 * IPv6 (`::`, `::1`) is deliberately refused rather than half-supported: every example
 * and fixture here is IPv4, and `0.0.0.0` / `127.0.0.1` already cover the binds anyone
 * has asked for.
 */
function validateIPv4(value: string, name: string): void {
  if (!IP_RE.test(value)) {
    throw new Error(
      `Invalid ${name}: "${value}" (must be a valid IPv4 address; IPv6 is not supported)`,
    );
  }
  if (value.split('.').some((octet) => Number(octet) > 255)) {
    throw new Error(`Invalid ${name}: "${value}" (octet out of range)`);
  }
}

const HOURS = 60 * 60 * 1000;

/**
 * Single-user auth settings.
 *
 * Enabled only when a password is configured, and there is no way around that: the
 * service is already deployed, so defaulting it on with nothing to check against is
 * either a lockout or a refusal to start. `index.ts` logs a warning naming the open
 * control surface when this comes back disabled.
 *
 * `AUTH_PASSWORD_HASH` is the supported form. `AUTH_PASSWORD` exists because asking
 * someone to run a hashing command before they can turn on a login is how a security
 * feature ends up switched off — it is hashed at startup and never stored, but it is a
 * plaintext credential in a file, so it warns and points at the generator.
 */
function loadAuthConfig(): ServiceConfig['auth'] {
  const hash = env('AUTH_PASSWORD_HASH', '').trim();
  const plain = env('AUTH_PASSWORD', '').trim();
  const explicitlyOff = env('AUTH_ENABLED', '').trim().toLowerCase() === 'false';

  const absoluteHours = parseInt(env('AUTH_SESSION_HOURS', '720'), 10) || 720;
  const idleHours = parseInt(env('AUTH_IDLE_HOURS', '168'), 10) || 168;

  return {
    // `passwordHash` is filled in by `initAuth()` when only AUTH_PASSWORD was given —
    // hashing is async and config loading is not. That function has to be CALLED; when
    // it was only described in this comment, a plaintext password enabled auth with an
    // empty hash and locked the owner out silently.
    enabled: !explicitlyOff && Boolean(hash || plain),
    passwordHash: hash,
    plainPassword: plain,
    sessionSecret: env('AUTH_SECRET', '').trim(),
    apiKey: env('AUTH_API_KEY', '').trim(),
    absoluteTtlMs: absoluteHours * HOURS,
    // An idle timeout longer than the absolute cap is a typo, not a policy; the cap wins
    // either way, so clamping here keeps the two from disagreeing in the logs.
    idleTtlMs: Math.min(idleHours, absoluteHours) * HOURS,
  };
}

export function loadConfig(): ServiceConfig {
  // No default. It used to fall back to a real address on the maintainer's own LAN,
  // which shipped in a public image (ELEG-73) — so a user who forgot to set this got a
  // service that started cleanly and then dialled a machine they had never heard of.
  //
  // Required rather than a placeholder: without a printer the service cannot do anything
  // useful, and failing at startup with a clear message beats sitting in `awaiting_sn`
  // (ELEG-59) looking like it is still trying.
  const printerIp = env('PRINTER_IP');

  if (!printerIp) {
    throw new Error(
      "PRINTER_IP is not set. Set it to your printer's IPv4 address, e.g. " +
        'PRINTER_IP=192.168.1.150 (see .env.example).',
    );
  }
  validateIPv4(printerIp, 'PRINTER_IP');

  const servicePort = parseInt(env('SERVICE_PORT', '8088'), 10);
  validatePort(servicePort, 'SERVICE_PORT');

  const bindAddress = env('BIND_ADDRESS', '0.0.0.0');
  validateIPv4(bindAddress, 'BIND_ADDRESS');

  const moonrakerPort = parseInt(env('MOONRAKER_PORT', '7125'), 10);
  validatePort(moonrakerPort, 'MOONRAKER_PORT');

  const telegramToken = env('TELEGRAM_BOT_TOKEN');
  const telegramChatId = env('TELEGRAM_CHAT_ID');
  if (telegramChatId && !/^-?\d+$/.test(telegramChatId)) {
    throw new Error(`Invalid TELEGRAM_CHAT_ID: "${telegramChatId}" (must be a numeric string)`);
  }
  // Who may *send* commands. Defaults to TELEGRAM_CHAT_ID, so an existing deployment
  // gains the gate without a new setting (ELEG-3).
  const telegramAllowedChatIds = parseAllowedChatIds(
    env('TELEGRAM_ALLOWED_CHAT_IDS'),
    telegramChatId,
  );
  if (env('TELEGRAM_ALLOWED_CHAT_IDS') && telegramAllowedChatIds.length === 0) {
    throw new Error(
      'TELEGRAM_ALLOWED_CHAT_IDS is set but contains no valid numeric id — refusing to start ' +
        'rather than fall back to a bot that answers everyone',
    );
  }

  // ── Home Assistant (optional) ──────────────────────────────────────────────
  //
  // All three are required together: a URL with no token cannot authenticate, and a
  // token with no entities has nothing to read. Any one alone is a half-finished
  // configuration, so it is treated as "off" rather than started and left failing.
  const haUrl = env('HOMEASSISTANT_URL').trim().replace(/\/+$/, '');
  const haToken = env('HOMEASSISTANT_TOKEN').trim();
  const haEntities = parseEntityList(env('HOMEASSISTANT_ENTITIES'));
  // Independent of the three above: a buzzer needs no sensors to read, and the sensor
  // poll needs no buzzer, so neither is required for the other to work.
  const haBuzzerEntity = env('HOMEASSISTANT_BUZZER_ENTITY').trim();
  if (haUrl && !/^https?:\/\//.test(haUrl)) {
    throw new Error(`Invalid HOMEASSISTANT_URL: "${haUrl}" (must start with http:// or https://)`);
  }
  // `sensor.living_room_humidity` — domain, dot, object id. A bare name is the usual
  // mistake and produces a 404 per poll that reads like the server is down.
  const entityRe = /^[a-z_]+\.[a-z0-9_]+$/;
  const badEntity = haEntities.find((e) => !entityRe.test(e));
  if (badEntity) {
    throw new Error(
      `Invalid HOMEASSISTANT_ENTITIES entry: "${badEntity}" (expected e.g. sensor.room_humidity)`,
    );
  }
  if (haBuzzerEntity && !entityRe.test(haBuzzerEntity)) {
    throw new Error(
      `Invalid HOMEASSISTANT_BUZZER_ENTITY: "${haBuzzerEntity}" (expected e.g. switch.printer_buzzer)`,
    );
  }

  return {
    auth: loadAuthConfig(),
    printerIp,
    printerPassword: env('PRINTER_PASSWORD', '123456'),
    printerSn: env('PRINTER_SN', '').trim(),
    servicePort,
    bindAddress,
    cameraEnabled: env('CAMERA_ENABLED') !== 'false',
    cameraUrl: env('CAMERA_URL') || `http://${printerIp}:8080`,
    corsPolicy: parseCorsPolicy(env('CORS_ALLOWED_ORIGINS')),
    telegramEnabled: !!(telegramToken && telegramChatId),
    telegramToken,
    telegramChatId,
    telegramAllowedChatIds,
    progressInterval: parseInt(env('PROGRESS_INTERVAL', '25'), 10) || 25,
    dataDir: env('DATA_DIR') || './data',
    moonrakerPort,
    homeAssistant: {
      enabled: !!(haUrl && haToken && haEntities.length),
      url: haUrl,
      token: haToken,
      entities: haEntities,
      buzzerEntity: haUrl && haToken ? haBuzzerEntity : '',
    },
  };
}
