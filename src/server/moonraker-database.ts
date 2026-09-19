/**
 * The :7125 server's small file-backed key/value store (Moonraker's `server.database.*`,
 * which Mainsail and Fluidd keep their settings in). Moved out of moonraker-server.ts.
 */

import { readFile as fsRead, mkdir } from 'fs/promises';
import { writeJson } from './json-file.js';
import { join } from 'path';
import { existsSync } from 'fs';
import { getLogger } from './logger.js';

const log = getLogger('MoonrakerSrv');

// ── Simple file-backed key/value database ────────────────────────

export class MoonrakerDatabase {
  private namespaces = new Map<string, Record<string, unknown>>();
  private filePath: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'moonraker-db.json');
  }

  async load(): Promise<void> {
    try {
      if (existsSync(this.filePath)) {
        const raw = await fsRead(this.filePath, 'utf-8');
        const data = JSON.parse(raw) as Record<string, Record<string, unknown>>;
        for (const [ns, entries] of Object.entries(data)) {
          this.namespaces.set(ns, entries);
        }
        log.info(`Database loaded (${this.namespaces.size} namespaces)`);
      }
    } catch (e: unknown) {
      log.warn('Failed to load database:', (e as Error).message);
    }
    // Auto-save every 10s when dirty
    this.saveTimer = setInterval(() => {
      if (this.dirty) void this.save();
    }, 10_000);
  }

  async save(): Promise<void> {
    try {
      const obj: Record<string, Record<string, unknown>> = {};
      for (const [ns, entries] of this.namespaces) obj[ns] = entries;
      await mkdir(join(this.filePath, '..'), { recursive: true });
      // Whole or not at all: this is where Mainsail and Fluidd keep their settings, and a
      // crash half way through a plain write left a truncated file that loaded as empty.
      // A failed save leaves `dirty` set, so the next tick tries again.
      if (await writeJson(this.filePath, obj)) this.dirty = false;
    } catch (e: unknown) {
      log.warn('Failed to save database:', (e as Error).message);
    }
  }

  stop(): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    if (this.dirty) void this.save();
  }

  listNamespaces(): string[] {
    return Array.from(this.namespaces.keys());
  }

  getItem(namespace: string, key?: string): { namespace: string; key?: string; value: unknown } {
    const ns = this.namespaces.get(namespace);
    if (!ns) return { namespace, key, value: key ? undefined : {} };
    if (!key) return { namespace, value: ns };
    // Support dotted key paths (e.g. "uiSettings.general")
    const parts = key.split('.');
    let current: unknown = ns;
    for (const part of parts) {
      if (current == null || typeof current !== 'object')
        return { namespace, key, value: undefined };
      current = (current as Record<string, unknown>)[part];
    }
    return { namespace, key, value: current };
  }

  postItem(
    namespace: string,
    key: string,
    value: unknown,
  ): { namespace: string; key: string; value: unknown } {
    if (!this.namespaces.has(namespace)) this.namespaces.set(namespace, {});
    const ns = this.namespaces.get(namespace)!;
    // Support dotted key paths for nested writes
    const parts = key.split('.');
    if (parts.length === 1) {
      ns[key] = value;
    } else {
      let current: Record<string, unknown> = ns;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
          current[parts[i]] = {};
        }
        current = current[parts[i]] as Record<string, unknown>;
      }
      current[parts[parts.length - 1]] = value;
    }
    this.dirty = true;
    return { namespace, key, value };
  }

  deleteItem(namespace: string, key?: string): { namespace: string; key?: string; value: unknown } {
    if (!key) {
      const value = this.namespaces.get(namespace) ?? {};
      this.namespaces.delete(namespace);
      this.dirty = true;
      return { namespace, value };
    }
    const ns = this.namespaces.get(namespace);
    if (!ns) return { namespace, key, value: undefined };
    const value = ns[key];
    delete ns[key];
    this.dirty = true;
    return { namespace, key, value };
  }
}
