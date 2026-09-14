/**
 * The workshop tools' own state — prices, maintenance tasks, spools — and the one
 * automatic thing among them: taking a finished print off a spool.
 *
 * All of it is small and most of it is typed in by hand, so it lives in one file,
 * `workshop.json` under `DATA_DIR`, written atomically (`json-file.ts`). The print
 * record it reads from is the ledger's, not a copy.
 *
 * Writes are queued. Two requests arriving together would otherwise both write the same
 * temporary file and rename it over the real one, and whichever rename ran second would
 * decide what survived — not necessarily the later state.
 */

import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import {
  type CostBreakdown,
  type CostSettings,
  DEFAULT_COST_SETTINGS,
  costOf,
  electricityCost,
  hasAnyPrice,
  normaliseCostSettings,
} from '../workshop/cost-core.js';
import {
  type PendingUsage,
  type Spool,
  applyPrint,
  assignPending,
  normalisePending,
  normaliseSpool,
  normaliseSpools,
} from '../workshop/inventory-core.js';
import type { LedgerEntry } from '../workshop/ledger-core.js';
import {
  type MaintenanceTask,
  type TaskStatus,
  hoursSince,
  normaliseTasks,
  taskStatuses,
} from '../workshop/maintenance-core.js';
import type { FileEntry } from '../types.js';
import { getDataDir } from './data-paths.js';
import { readJson, writeJson } from './json-file.js';
import type { LedgerService } from './ledger.js';
import { getLogger } from './logger.js';

const log = getLogger('Workshop');

interface WorkshopState {
  cost: CostSettings;
  maintenance: MaintenanceTask[];
  spools: Spool[];
  pending: PendingUsage[];
  /** Ledger entry id → the spool it was taken off, so its cost can use that spool's price. */
  attributions: Record<string, string>;
}

export interface FileCost {
  filename: string;
  grams: number | null;
  seconds: number | null;
  materials: string[];
  filament: number | null;
  electricity: number | null;
}

export class WorkshopService extends EventEmitter {
  private state: WorkshopState = {
    cost: { ...DEFAULT_COST_SETTINGS },
    maintenance: normaliseTasks(undefined),
    spools: [],
    pending: [],
    attributions: {},
  };
  private readonly file: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(private ledger: LedgerService) {
    super();
    this.file = join(getDataDir(), 'workshop.json');
    ledger.on('added', (entry: LedgerEntry) => this.takeOffShelf(entry));
  }

  async start(): Promise<void> {
    const raw = (await readJson(this.file)) as Partial<Record<keyof WorkshopState, unknown>> | null;
    if (!raw) return; // first run: the defaults above
    const attributions: Record<string, string> = {};
    if (raw.attributions && typeof raw.attributions === 'object') {
      for (const [k, v] of Object.entries(raw.attributions))
        if (typeof v === 'string') attributions[k] = v;
    }
    this.state = {
      cost: normaliseCostSettings(raw.cost),
      maintenance: normaliseTasks(raw.maintenance),
      spools: normaliseSpools(raw.spools, Date.now()),
      pending: normalisePending(raw.pending),
      attributions,
    };
    log.info(
      `Loaded ${this.state.spools.length} spools, ${this.state.maintenance.length} maintenance tasks`,
    );
  }

  private save(): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify({ version: 1, ...this.state }));
    this.writing = this.writing.then(() => writeJson(this.file, snapshot));
    this.emit('changed');
    return this.writing;
  }

  /* ── Cost ─────────────────────────────────────────────────────────── */

  getCostSettings(): CostSettings {
    return this.state.cost;
  }

  async setCostSettings(raw: unknown): Promise<CostSettings> {
    this.state.cost = normaliseCostSettings(raw);
    await this.save();
    return this.state.cost;
  }

  /** What a print already made cost — using the spool's own price if it is known. */
  costOfEntry = (entry: LedgerEntry): CostBreakdown => {
    const spool = this.state.spools.find((s) => s.id === this.state.attributions[entry.id]);
    if (spool?.pricePerKg != null && entry.grams !== null) {
      return {
        filament: Math.round((entry.grams / 1000) * spool.pricePerKg * 100) / 100,
        electricity: electricityCost(entry.seconds, this.state.cost),
      };
    }
    return costOf(
      {
        grams: entry.grams,
        seconds: entry.seconds,
        materials: entry.colours.map((c) => c.material),
      },
      this.state.cost,
    );
  };

  /** What each file on the printer would cost to print, before anyone prints it. */
  costFiles(files: readonly FileEntry[]): FileCost[] {
    return files
      .filter((f) => f.type !== 'folder')
      .map((f) => {
        const grams =
          typeof f.total_filament_used === 'number' && f.total_filament_used > 0
            ? f.total_filament_used
            : null;
        const seconds = typeof f.print_time === 'number' && f.print_time > 0 ? f.print_time : null;
        const materials = (f.color_map ?? []).map((c) => String(c.name ?? ''));
        const c = costOf({ grams, seconds: seconds ?? 0, materials }, this.state.cost);
        return { filename: f.filename, grams, seconds, materials, ...c };
      });
  }

  hasAnyPrice(): boolean {
    return hasAnyPrice(this.state.cost);
  }

  /* ── Maintenance ──────────────────────────────────────────────────── */

  getMaintenance(): { tasks: TaskStatus[]; totalHours: number } {
    const entries = this.ledger.getEntries();
    return {
      tasks: taskStatuses(this.state.maintenance, entries),
      totalHours: hoursSince(entries, null),
    };
  }

  async setTasks(raw: unknown): Promise<void> {
    // Keep each surviving task's history: the edit form sends labels and intervals, and
    // renaming a task should not quietly reset when it was last done.
    const previous = new Map(this.state.maintenance.map((t) => [t.id, t.lastDoneAt]));
    this.state.maintenance = normaliseTasks(raw).map((t) => ({
      ...t,
      lastDoneAt: t.lastDoneAt ?? previous.get(t.id) ?? null,
    }));
    await this.save();
  }

  async markDone(id: string): Promise<boolean> {
    const task = this.state.maintenance.find((t) => t.id === id);
    if (!task) return false;
    task.lastDoneAt = Date.now();
    await this.save();
    return true;
  }

  /* ── Inventory ────────────────────────────────────────────────────── */

  getInventory(): { spools: Spool[]; pending: PendingUsage[] } {
    return { spools: this.state.spools, pending: this.state.pending };
  }

  private takeOffShelf(entry: LedgerEntry): void {
    const r = applyPrint(this.state.spools, this.state.pending, entry);
    if (r.deductedFrom) {
      this.state.attributions[entry.id] = r.deductedFrom;
      log.info(`${entry.grams} g of ${entry.filename} taken off ${r.deductedFrom}`);
    }
    const changed = r.deductedFrom !== null || r.pending.length !== this.state.pending.length;
    this.state.spools = r.spools;
    this.state.pending = r.pending;
    if (changed) void this.save();
  }

  async addSpool(raw: unknown): Promise<Spool | null> {
    const now = Date.now();
    const spool = normaliseSpool(raw, now, `spool-${now.toString(36)}`);
    if (!spool) return null;
    this.state.spools.push(spool);
    await this.save();
    return spool;
  }

  async updateSpool(id: string, raw: unknown): Promise<Spool | null> {
    const i = this.state.spools.findIndex((s) => s.id === id);
    if (i < 0) return null;
    const current = this.state.spools[i];
    // A partial update: anything the request leaves out keeps its value.
    const merged = normaliseSpool({ ...current, ...(raw as object) }, current.createdAt, id);
    if (!merged) return null;
    this.state.spools[i] = { ...merged, createdAt: current.createdAt };
    await this.save();
    return this.state.spools[i];
  }

  async deleteSpool(id: string): Promise<boolean> {
    const before = this.state.spools.length;
    this.state.spools = this.state.spools.filter((s) => s.id !== id);
    if (this.state.spools.length === before) return false;
    await this.save();
    return true;
  }

  async assign(usageId: string, spoolId: string): Promise<boolean> {
    const r = assignPending(this.state.spools, this.state.pending, usageId, spoolId);
    if (!r) return false;
    this.state.spools = r.spools;
    this.state.pending = r.pending;
    this.state.attributions[usageId] = spoolId;
    await this.save();
    return true;
  }

  async dismiss(usageId: string): Promise<boolean> {
    const before = this.state.pending.length;
    this.state.pending = this.state.pending.filter((p) => p.id !== usageId);
    if (this.state.pending.length === before) return false;
    await this.save();
    return true;
  }
}
