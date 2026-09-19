/**
 * Scheduled prints, run by the service so a schedule fires whether or not a browser is
 * open — same reasoning as `dryer.ts`, and the same class of feature: this is the one
 * other place in the app that commands the printer on a timer rather than on a click.
 *
 * ## What makes this safe to own
 *
 * 1. **It only ever fires once.** A schedule is `pending` until its moment, then becomes
 *    `fired` or `skipped` and never fires again — see `schedule-core.ts` for why a retry
 *    loop is the wrong shape for a feature that starts unattended jobs.
 * 2. **Skip, never guess.** Firing checks its facts fresh, at the moment they matter,
 *    not whatever was true when the schedule was created: the MQTT connection, whether
 *    the printer is actually idle, whether the file is still there (via a live re-list of
 *    its directory, never the ambient `StateStore.files` cache another browser's folder
 *    click could have overwritten) and, when the schedule carries a filament mapping, whether each chosen spool still holds what was chosen (a reel
 *    swapped overnight must skip the print, not run it in the wrong filament). Any of them
 *    failing skips with a reason instead of sending `1020` on a guess.
 * 3. **A tick that outlives any browser.** `setInterval` here, not a tab's timer, so a
 *    schedule fires whether or not anyone is looking — the same fix the dryer needed.
 */

import { EventEmitter } from 'events';
import { join } from 'path';
import {
  type ScheduledPrint,
  createSchedule,
  dueEntries,
  normaliseNewSchedule,
  normaliseStored,
  pruneHistory,
  sortedSchedules,
  spoolMismatch,
  startConfig,
} from '../schedule-core.js';
import type { FileEntry } from '../types.js';
import { getDataDir } from './data-paths.js';
import { readJson, writeJson } from './json-file.js';
import { getLogger } from './logger.js';
import type { MqttBridge } from './mqtt-bridge.js';
import type { StateStore } from './state-store.js';

const log = getLogger('Schedule');

/** `Start print`. */
const START_PRINT = 1020;
/** `Set auto refill`, the same command the print dialog sends. */
const SET_AUTO_REFILL = 2004;
/** `Get file list`. */
const GET_FILE_LIST = 1044;
/** `machine_status.status` when the printer is doing nothing. */
const IDLE = 1;

/** How often due schedules are checked. Fine enough that "2:00 PM" fires within half a
 *  minute of 2:00 PM, coarse enough that it is not worth its own justification. */
const TICK_MS = 15_000;

/** How long to wait for the printer to answer a file-list re-check before giving up and
 *  skipping — an unanswered request is exactly the kind of uncertainty this feature
 *  refuses to guess through. */
const FILE_CHECK_TIMEOUT_MS = 8_000;

/** The last path segment — what a `1044` listing's own `filename` field holds, as
 *  opposed to the full `dir/filename` this service stores. */
function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export class ScheduleService extends EventEmitter {
  private schedules: ScheduledPrint[] = [];
  private readonly file: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private writing: Promise<void> = Promise.resolve();
  /**
   * ids currently inside `fire()`. The file-list re-check can take up to
   * `FILE_CHECK_TIMEOUT_MS`, and with several schedules due in the same window that adds
   * up to longer than `TICK_MS` — so a second `tick()` can start while the first is still
   * awaiting the first entry's check. Without this, `dueEntries()` would find that same
   * entry still `pending` and fire it a second time, concurrently.
   */
  private firing = new Set<string>();

  constructor(
    private store: StateStore,
    private bridge: MqttBridge,
  ) {
    super();
    this.file = join(getDataDir(), 'schedule.json');
  }

  /* ── Lifecycle ────────────────────────────────────────────────────── */

  async start(): Promise<void> {
    this.schedules = normaliseStored(await readJson(this.file));
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /* ── Reads ────────────────────────────────────────────────────────── */

  list(): ScheduledPrint[] {
    return sortedSchedules(this.schedules);
  }

  /* ── Commands ─────────────────────────────────────────────────────── */

  /** Add a schedule. `null` when the input is invalid or the list is already full. */
  async add(raw: unknown): Promise<ScheduledPrint | null> {
    const now = Date.now();
    const input = normaliseNewSchedule(raw, now);
    if (!input) return null;
    if (this.schedules.filter((s) => s.status === 'pending').length >= 100) return null;

    const entry = createSchedule(input, now);
    this.schedules.push(entry);
    log.info(`Scheduled ${entry.filename} for ${new Date(entry.runAt).toISOString()}`);
    await this.save();
    return entry;
  }

  /** Cancel a still-pending schedule. `false` if there is none by that id. */
  async cancel(id: string): Promise<boolean> {
    const entry = this.schedules.find((s) => s.id === id && s.status === 'pending');
    if (!entry) return false;
    entry.status = 'cancelled';
    log.info(`Cancelled scheduled print: ${entry.filename}`);
    await this.save();
    return true;
  }

  /* ── The loop ─────────────────────────────────────────────────────── */

  private async tick(): Promise<void> {
    for (const entry of dueEntries(this.schedules, Date.now())) {
      if (this.firing.has(entry.id)) continue;
      this.firing.add(entry.id);
      try {
        await this.fire(entry);
      } finally {
        this.firing.delete(entry.id);
      }
    }
  }

  private get idle(): boolean {
    const ms = this.store.status?.machine_status;
    return ms?.status === IDLE && (ms.exception_status?.length ?? 0) === 0;
  }

  private async skip(entry: ScheduledPrint, reason: string): Promise<void> {
    entry.status = 'skipped';
    entry.skipReason = reason;
    log.warn(`Scheduled print skipped (${entry.filename}): ${reason}`);
    await this.save();
    this.emit('skipped', entry);
  }

  private async fire(entry: ScheduledPrint): Promise<void> {
    if (!this.bridge.isConnected) {
      await this.skip(entry, 'The printer was not connected');
      return;
    }
    if (!this.idle) {
      await this.skip(entry, 'The printer was busy');
      return;
    }

    const files = await this.requestFileList(entry.dir);
    if (files === null) {
      await this.skip(entry, 'Could not confirm the file was still there');
      return;
    }
    if (!files.some((f) => f.filename === basename(entry.filename))) {
      await this.skip(entry, 'The file is no longer on the printer');
      return;
    }

    // The Canvas is read now, not when the schedule was made: this is the check that
    // stops a reel swapped overnight from being printed in.
    const mismatch = spoolMismatch(entry.options?.spools ?? [], this.store.canvas);
    if (mismatch) {
      await this.skip(entry, mismatch);
      return;
    }

    entry.status = 'fired';
    entry.firedAt = Date.now();
    log.info(`Starting scheduled print: ${entry.filename}`);
    // Auto-refill first, as the dialog does, and only when it differs from what the
    // printer has now — it is a printer setting, and this is what the user chose.
    const autoRefill = entry.options?.autoRefill ?? null;
    if (autoRefill !== null && autoRefill !== (this.store.canvas?.auto_refill ?? false)) {
      this.bridge.sendCommand(SET_AUTO_REFILL, { auto_refill: autoRefill });
    }
    this.bridge.sendCommand(START_PRINT, {
      storage_media: 'local',
      filename: entry.filename,
      config: startConfig(entry.options),
    });
    await this.save();
    this.emit('fired', entry);
  }

  /**
   * A fresh `1044` for `dir`, resolved with its file list or `null` on no answer within
   * `FILE_CHECK_TIMEOUT_MS`. Deliberately not `StateStore.files` — see the module comment
   * on why that cache cannot be trusted for this.
   *
   * Matched on the response's own `id` when the printer sends one back, not just its
   * `method` — the `response` event is shared by every consumer of the one MQTT
   * connection, so a browser browsing a folder at the same moment sends its own `1044`
   * too, and matching by method alone would sometimes resolve this with THAT folder's
   * listing instead of `dir`'s. Falls back to matching by method alone when a response
   * carries no `id` at all, rather than trust an unverified assumption about the
   * protocol into never matching anything — see `data/CC2_PROTOCOL_REFERENCE.md` (not in
   * this checkout) and CLAUDE.md on citing it. Absent that file, this degrades to the
   * less precise but still-functional check instead of silently never firing.
   */
  private requestFileList(dir: string): Promise<FileEntry[] | null> {
    return new Promise((resolve) => {
      const requestId = this.bridge.sendCommand(GET_FILE_LIST, {
        storage_media: 'local',
        dir,
        offset: 0,
        limit: 200,
      });
      if (requestId === null) {
        resolve(null);
        return;
      }

      let done = false;
      const finish = (result: FileEntry[] | null) => {
        if (done) return;
        done = true;
        this.bridge.off('response', onResponse);
        clearTimeout(timer);
        resolve(result);
      };
      const onResponse = (method: number, data: Record<string, unknown>) => {
        if (method !== GET_FILE_LIST) return;
        if (data.id !== undefined && data.id !== requestId) return;
        const result = data.result as Record<string, unknown> | undefined;
        const list = result?.file_list as FileEntry[] | undefined;
        finish(Array.isArray(list) ? list : null);
      };
      const timer = setTimeout(() => finish(null), FILE_CHECK_TIMEOUT_MS);
      this.bridge.on('response', onResponse);
    });
  }

  /* ── Persistence ──────────────────────────────────────────────────── */

  private save(): Promise<void> {
    this.schedules = pruneHistory(this.schedules, Date.now());
    const snapshot = [...this.schedules];
    this.writing = this.writing.then(() => writeJson(this.file, snapshot));
    this.emit('changed');
    return this.writing;
  }
}
