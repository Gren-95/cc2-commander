/**
 * Keeps the print ledger (`workshop/ledger-core.ts`) current and on disk.
 *
 * Three moments matter:
 *
 * 1. **Connect.** Ask the printer for its history and fold in anything new. This is the
 *    backfill, and it is also how a print that finished while the service was down gets
 *    recorded — late, but with the printer's own timestamps, so nothing is lost but the
 *    filament weight, if the file has gone since.
 * 2. **A print starts.** Read its file's weight and colours *now*, while the file is
 *    certainly on the printer, and hold them until the print ends. Waiting until the
 *    end would usually work, but a file deleted mid-print — or a list that has moved to
 *    the USB stick in the meantime — would lose the one number this exists to keep.
 * 3. **A print ends.** Ask for history again: that is where the finished row appears,
 *    with the printer's own start, end and outcome.
 *
 * Emits `added` with each new row, which is what the inventory deducts from.
 */

import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import {
  type FileFacts,
  type HistoryTask,
  type LedgerEntry,
  basename,
  factsFromFile,
  mergeHistory,
  normaliseLedger,
} from '../workshop/ledger-core.js';
import { getDataDir } from './data-paths.js';
import { readJson, writeJson } from './json-file.js';
import { getLogger } from './logger.js';
import type { MqttBridge } from './mqtt-bridge.js';
import type { StateStore } from './state-store.js';

const log = getLogger('Ledger');

/** Print task list. Takes no parameters on the CC2. */
const GET_HISTORY = 1036;

/**
 * How long after a print ends to ask for history.
 *
 * Asked immediately, the printer can answer before it has written the finished task,
 * and the row would not appear until the next connect.
 */
const HISTORY_AFTER_END_MS = 5_000;

/** After connecting, wait for the file list (`1044`) to land so the backfill can use it. */
const HISTORY_AFTER_CONNECT_MS = 3_000;

export class LedgerService extends EventEmitter {
  private entries: LedgerEntry[] = [];
  /** Facts captured at print start, by basename, until that print is in the ledger. */
  private pending = new Map<string, FileFacts>();
  private readonly file: string;

  constructor(
    private store: StateStore,
    private bridge: MqttBridge,
  ) {
    super();
    this.file = join(getDataDir(), 'ledger.json');

    store.on('history', (tasks: unknown[]) => void this.merge(tasks as HistoryTask[]));

    store.on('print_event', (event: { type: string; filename?: string }) => {
      if (event.type === 'connected') this.askForHistory(HISTORY_AFTER_CONNECT_MS);
      if (event.type === 'print_started' && event.filename) this.capture(event.filename);
      if (event.type === 'print_completed' || event.type === 'print_failed') {
        this.askForHistory(HISTORY_AFTER_END_MS);
      }
    });
  }

  async start(): Promise<void> {
    this.entries = normaliseLedger(await readJson(this.file));
    log.info(`Loaded ${this.entries.length} ledger entries`);
  }

  getEntries(): readonly LedgerEntry[] {
    return this.entries;
  }

  private askForHistory(delayMs: number): void {
    setTimeout(() => this.bridge.sendCommand(GET_HISTORY, {}), delayMs).unref();
  }

  private fileFacts(name: string): FileFacts | null {
    const wanted = basename(name);
    return factsFromFile(this.store.files.find((f) => basename(f.filename) === wanted));
  }

  private capture(filename: string): void {
    const facts = this.fileFacts(filename);
    if (facts) this.pending.set(basename(filename), facts);
  }

  private async merge(tasks: HistoryTask[]): Promise<void> {
    const { entries, added } = mergeHistory(
      this.entries,
      tasks,
      // What was captured at print start is the better source: the file may have gone.
      (name) => this.pending.get(name) ?? this.fileFacts(name),
    );
    if (!added.length) return;

    this.entries = entries;
    for (const e of added) this.pending.delete(basename(e.filename));
    await writeJson(this.file, { version: 1, entries: this.entries });

    const weighed = added.filter((e) => e.grams !== null).length;
    log.info(`Recorded ${added.length} print(s), ${weighed} with a filament weight`);
    for (const e of added) this.emit('added', e);
    this.emit('changed');
  }
}
