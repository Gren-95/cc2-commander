/**
 * Filament drying, run by the service rather than by a browser tab.
 *
 * The timer used to live in `ui/dryer-panel.ts`: a `setInterval` in whichever tab had
 * the Tools page open. That tab owned a heater. Close it, navigate away, let a phone
 * sleep, and the bed stayed at temperature with nothing left running to turn it off —
 * the panel said so in small print, which is not a safety mechanism.
 *
 * Here the session is a file under `DATA_DIR` and the loop is the service's. A browser
 * starts and stops it and watches it; nothing depends on one being open.
 *
 * ## What makes this safe to own
 *
 * 1. **`startedAt` is absolute.** Expiry is answered by arithmetic against the clock, so
 *    a service restarted mid-session resumes it correctly and a service restarted *after*
 *    one should have ended turns the bed off at boot instead of resuming a finished job.
 *    Storing "minutes remaining" would make downtime pause the clock — and a bed that is
 *    still hot does not pause.
 * 2. **The target is re-asserted every 30s.** Anything that clears it — the dashboard's
 *    own Off button, the printer's screen, a Moonraker client, a firmware idle timeout —
 *    is undone, because a silent stop reads exactly like a session running normally.
 *    Observed before this existed: target 45 °C at 11:50, target 0 at 12:05, timer still
 *    counting down and eventually announcing dry filament.
 * 3. **Every exit turns the bed off.** Finished, stopped, refused, or resolved-expired
 *    all go through `finish`, which sends `heater_bed: 0` before clearing the session —
 *    and clears the session first so a keepalive cannot race in behind the off command.
 * 4. **Never during a print.** A drying session sets the bed to a fixed temperature for
 *    hours; doing that under a print ruins it. `start` refuses, and an active session
 *    stops itself if a print begins.
 * 5. **`MAX_SAFE_C` is a ceiling on everything**, including a value that arrives over
 *    HTTP. The clamp lives in `dryer-core.ts` and is shared with the browser so there is
 *    one answer rather than two that can drift.
 */

import { EventEmitter } from 'events';
import { readFile, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import {
  type DryerSession,
  clampMinutes,
  clampTemp,
  hasExpired,
  normaliseSession,
  presetById,
  sessionFromPreset,
} from '../dryer-core.js';
import { getDataDir } from './data-paths.js';
import { getLogger } from './logger.js';
import type { MqttBridge } from './mqtt-bridge.js';
import type { StateStore } from './state-store.js';

const log = getLogger('Dryer');

/** `Set temperature`. `heater_bed: 0` turns it off. */
const SET_TEMPERATURE = 1028;

/**
 * How often the bed target is re-asserted.
 *
 * 30s is short enough that a cleared target costs half a minute of heat, and long enough
 * that a four-hour session is 480 publishes rather than one per second.
 */
const KEEPALIVE_MS = 30_000;

/** `machine_status.status` when the printer is running a job. */
const PRINTING = 2;

export type DryerStopReason = 'stopped' | 'done' | 'expired-while-down' | 'print-started';

export interface DryerState {
  session: DryerSession | null;
  /** What the printer last reported, so a client can show a correction without polling. */
  bedTarget: number | null;
  lastCorrectionAt: number | null;
}

export class DryerService extends EventEmitter {
  private session: DryerSession | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCorrectionAt: number | null = null;
  private readonly file: string;

  constructor(
    private store: StateStore,
    private bridge: MqttBridge,
  ) {
    super();
    this.file = join(getDataDir(), 'dryer.json');

    // A print starting is the one event that ends a session without anyone asking.
    store.on('print_event', (event: { type: string }) => {
      if (event.type === 'print_started' && this.session) {
        log.warn('Print started during a drying session — stopping it and cooling down');
        void this.finish('print-started');
      }
    });
  }

  /* ── Persistence ──────────────────────────────────────────────────── */

  private async load(): Promise<DryerSession | null> {
    try {
      return normaliseSession(JSON.parse(await readFile(this.file, 'utf-8')));
    } catch {
      // Absent is the normal case, and a malformed file is not worth crashing over: the
      // worst outcome of ignoring one is a session nobody can stop from the UI, which is
      // strictly better than a service that will not start.
      return null;
    }
  }

  private async persist(): Promise<void> {
    try {
      if (this.session) await writeFile(this.file, JSON.stringify(this.session), 'utf-8');
      else await rm(this.file, { force: true });
    } catch (err) {
      log.error(`Could not write ${this.file}: ${(err as Error).message}`);
    }
  }

  /* ── Commands ─────────────────────────────────────────────────────── */

  private setBed(tempC: number): void {
    this.bridge.sendCommand(SET_TEMPERATURE, { heater_bed: tempC });
  }

  private get printing(): boolean {
    return this.store.status?.machine_status?.status === PRINTING;
  }

  /* ── Lifecycle ────────────────────────────────────────────────────── */

  /**
   * Adopt whatever was left on disk.
   *
   * Called once at startup, before anything else can ask for state. The interesting
   * branch is the one nobody sees: a session that ran out while the service was down
   * gets the bed turned off *now*, rather than resumed or silently forgotten.
   */
  async start(): Promise<void> {
    const stored = await this.load();
    if (!stored) return;

    if (hasExpired(stored, Date.now())) {
      log.info(`Session for ${stored.label} expired while the service was down`);
      this.session = stored;
      await this.finish('expired-while-down');
      return;
    }

    this.session = stored;
    log.info(
      `Resuming drying: ${stored.label} at ${stored.tempC} °C, ` +
        `${Math.round((stored.startedAt + stored.totalMinutes * 60_000 - Date.now()) / 60_000)} min left`,
    );
    this.setBed(stored.tempC);
    this.startLoop();
    this.emitState();
  }

  /** Begin a session. Returns the reason it was refused, or null on success. */
  async begin(input: { presetId: string; tempC?: number; hours?: number }): Promise<string | null> {
    if (this.printing) return 'A print is running';
    const preset = presetById(input.presetId);
    if (!preset) return `Unknown preset: ${input.presetId}`;

    // `sessionFromPreset(preset, now, rotateEveryMin)` stamps the clock and the preset's
    // own figures; the overrides go on top, through the same clamps the panel uses.
    const session: DryerSession = {
      ...sessionFromPreset(preset, Date.now()),
      tempC: clampTemp(input.tempC ?? preset.tempC),
      totalMinutes: clampMinutes(
        input.hours === undefined ? preset.minutes : Math.round(input.hours * 60),
      ),
    };

    this.session = session;
    this.lastCorrectionAt = null;
    await this.persist();
    this.setBed(session.tempC);
    this.startLoop();
    log.info(`Drying ${session.label} at ${session.tempC} °C for ${session.totalMinutes} min`);
    this.emitState();
    return null;
  }

  /** End a session and always turn the bed off, whichever way it ended. */
  async finish(reason: DryerStopReason): Promise<void> {
    const ending = this.session;
    // Clear first. A keepalive that fired between the off command and the clear would
    // re-send the drying target and leave the bed hot with nothing running to stop it.
    this.session = null;
    this.stopLoop();
    this.lastCorrectionAt = null;
    await this.persist();
    this.setBed(0);

    if (ending) log.info(`Drying ended (${reason}) — bed off`);
    this.emit('finished', { session: ending, reason });
    this.emitState();
  }

  stop(): void {
    this.stopLoop();
  }

  /* ── The loop ─────────────────────────────────────────────────────── */

  private startLoop(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), KEEPALIVE_MS);
  }

  private stopLoop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const session = this.session;
    if (!session) {
      this.stopLoop();
      return;
    }

    if (hasExpired(session, Date.now())) {
      await this.finish('done');
      return;
    }

    if (this.printing) {
      log.warn('A print is running — stopping the drying session');
      await this.finish('print-started');
      return;
    }

    // Re-assert unconditionally rather than only on drift: a command the printer dropped
    // without ever reporting a target change would otherwise never be retried.
    const reported = this.store.status?.heater_bed?.target;
    if (reported !== undefined && Math.round(reported) !== session.tempC) {
      this.lastCorrectionAt = Date.now();
      log.warn(`Bed target had dropped to ${Math.round(reported)} °C — restoring ${session.tempC}`);
    }
    this.setBed(session.tempC);
    this.emitState();
  }

  /* ── State out ────────────────────────────────────────────────────── */

  getState(): DryerState {
    return {
      session: this.session,
      bedTarget: this.store.status?.heater_bed?.target ?? null,
      lastCorrectionAt: this.lastCorrectionAt,
    };
  }

  private emitState(): void {
    this.emit('state', this.getState());
  }
}
