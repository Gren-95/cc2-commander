/**
 * What a schedule does at the moment it fires.
 *
 * `schedule.test.ts` covers the decisions in `schedule-core.ts`; this covers the service
 * that acts on them, because that is where an unattended job actually starts. Two things
 * matter most: a schedule starts the job with the settings it was given, and it does not
 * start it at all when a chosen spool is no longer what was chosen.
 *
 * No printer is involved. `MqttBridge` is a recorder that answers the file-list re-check,
 * and `StateStore` is a stub, so every `1020` below is an array entry.
 */

import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PrintOptions, ScheduledPrint } from '../../schedule-core.js';
import type { CanvasInfo } from '../../types.js';
import { initDataPaths } from '../data-paths.js';
import type { MqttBridge } from '../mqtt-bridge.js';
import { ScheduleService } from '../schedule.js';
import type { StateStore } from '../state-store.js';

const START_PRINT = 1020;
const SET_AUTO_REFILL = 2004;
const HOUR = 60 * 60 * 1000;

interface Sent {
  method: number;
  params: Record<string, unknown>;
}

class FakeStore extends EventEmitter {
  status: Record<string, unknown> = { machine_status: { status: 1, exception_status: [] } };
  canvas: CanvasInfo | null = null;
}

/** Records commands, and answers the file-list re-check with `files`. */
class FakeBridge extends EventEmitter {
  isConnected = true;
  sent: Sent[] = [];
  files = [{ filename: 'benchy.gcode' }];
  private nextId = 0;

  sendCommand(method: number, params: Record<string, unknown>): number {
    this.sent.push({ method, params });
    const id = ++this.nextId;
    if (method === 1044) {
      setTimeout(() => this.emit('response', 1044, { id, result: { file_list: this.files } }), 0);
    }
    return id;
  }
}

const tray = (tray_id: number, over: Record<string, unknown> = {}) => ({
  tray_id,
  brand: '',
  filament_type: 'PLA',
  filament_name: 'PLA',
  filament_color: '#FF0000',
  min_nozzle_temp: 190,
  max_nozzle_temp: 230,
  status: 1,
  ...over,
});

const canvasWith = (trays: unknown[], autoRefill = false): CanvasInfo =>
  ({
    active_canvas_id: 0,
    active_tray_id: 0,
    auto_refill: autoRefill,
    canvas_list: [{ canvas_id: 0, connected: 1, tray_list: trays }],
  }) as unknown as CanvasInfo;

const options = (over: Partial<PrintOptions> = {}): PrintOptions => ({
  bedType: 'B',
  timelapse: false,
  bedLeveling: true,
  autoRefill: true,
  spools: [{ t: 0, canvas_id: 0, tray_id: 1, filament_type: 'PLA', filament_color: 'FF0000' }],
  ...over,
});

let dir: string;
let store: FakeStore;
let bridge: FakeBridge;
let service: ScheduleService;

const make = () =>
  new ScheduleService(store as unknown as StateStore, bridge as unknown as MqttBridge);

/** Add a schedule and fire it now, as the tick would when its time came. */
async function addAndFire(opts: PrintOptions | null): Promise<ScheduledPrint> {
  const entry = await service.add({
    filename: 'benchy.gcode',
    dir: '',
    runAt: Date.now() + HOUR,
    options: opts,
  });
  if (!entry) throw new Error('the schedule was refused');
  bridge.sent = [];
  await (service as unknown as { fire: (e: ScheduledPrint) => Promise<void> }).fire(entry);
  return entry;
}

const starts = () => bridge.sent.filter((s) => s.method === START_PRINT);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc2-schedule-'));
  initDataPaths(dir);
  store = new FakeStore();
  bridge = new FakeBridge();
  service = make();
});

afterEach(() => {
  service.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('a schedule with saved settings', () => {
  it('starts the print with the plate, timelapse, leveling and spools that were chosen', async () => {
    store.canvas = canvasWith([tray(1)]);
    const entry = await addAndFire(options());

    expect(entry.status).toBe('fired');
    expect(starts()).toHaveLength(1);
    expect(starts()[0].params).toEqual({
      storage_media: 'local',
      filename: 'benchy.gcode',
      config: {
        delay_video: false,
        printer_check: true,
        print_layout: 'B',
        bedlevel_force: false,
        slot_map: [{ t: 0, canvas_id: 0, tray_id: 1 }],
      },
    });
  });

  it('sets auto-refill first, and only when it differs from the printer now', async () => {
    store.canvas = canvasWith([tray(1)], false);
    await addAndFire(options({ autoRefill: true }));
    expect(bridge.sent.map((s) => s.method).filter((m) => m !== 1044)).toEqual([
      SET_AUTO_REFILL,
      START_PRINT,
    ]);
    expect(bridge.sent.find((s) => s.method === SET_AUTO_REFILL)?.params).toEqual({
      auto_refill: true,
    });
  });

  it('leaves auto-refill alone when the printer already has what was chosen', async () => {
    store.canvas = canvasWith([tray(1)], true);
    await addAndFire(options({ autoRefill: true }));
    expect(bridge.sent.map((s) => s.method)).not.toContain(SET_AUTO_REFILL);
    expect(starts()).toHaveLength(1);
  });

  it('leaves auto-refill alone when the dialog offered no choice', async () => {
    store.canvas = canvasWith([tray(1)], false);
    await addAndFire(options({ autoRefill: null }));
    expect(bridge.sent.map((s) => s.method)).not.toContain(SET_AUTO_REFILL);
  });
});

describe('a schedule whose spools have changed', () => {
  it('is skipped, and says which spool and how, when the reel was swapped', async () => {
    store.canvas = canvasWith([tray(1, { filament_color: '#0000FF' })]);
    const entry = await addAndFire(options());

    expect(entry.status).toBe('skipped');
    expect(entry.skipReason).toContain('C1:T2');
    expect(entry.skipReason).toContain('now PLA #0000FF');
    // Nothing reaches the printer: no print, and no auto-refill change either.
    expect(starts()).toHaveLength(0);
    expect(bridge.sent.map((s) => s.method)).not.toContain(SET_AUTO_REFILL);
  });

  it('is skipped when the spool has run out', async () => {
    store.canvas = canvasWith([tray(1, { status: 0 })]);
    const entry = await addAndFire(options());
    expect(entry.status).toBe('skipped');
    expect(entry.skipReason).toBe('The spool in C1:T2 is empty');
    expect(starts()).toHaveLength(0);
  });

  it('is skipped rather than guessed at when the Canvas state is not known', async () => {
    store.canvas = null;
    const entry = await addAndFire(options());
    expect(entry.status).toBe('skipped');
    expect(entry.skipReason).toMatch(/not known/);
    expect(starts()).toHaveLength(0);
  });

  it('is never fired a second time after being skipped', async () => {
    store.canvas = canvasWith([tray(1, { status: 0 })]);
    const entry = await addAndFire(options());
    // Put the right spool back: the schedule is spent, not retried.
    store.canvas = canvasWith([tray(1)]);
    bridge.sent = [];
    await (service as unknown as { tick: () => Promise<void> }).tick();
    expect(entry.status).toBe('skipped');
    expect(starts()).toHaveLength(0);
  });
});

describe('a schedule with no settings', () => {
  it('starts exactly as schedules always have, whatever the Canvas looks like', async () => {
    store.canvas = null;
    const entry = await addAndFire(null);
    expect(entry.status).toBe('fired');
    expect(starts()[0].params).toEqual({
      storage_media: 'local',
      filename: 'benchy.gcode',
      config: {
        delay_video: true,
        printer_check: false,
        print_layout: 'A',
        bedlevel_force: false,
        slot_map: [],
      },
    });
    expect(bridge.sent.map((s) => s.method)).not.toContain(SET_AUTO_REFILL);
  });

  it('needs no spool check for a file that needs no mapping', async () => {
    store.canvas = null;
    const entry = await addAndFire(options({ spools: [], autoRefill: null }));
    expect(entry.status).toBe('fired');
  });
});

describe('the checks that come before the spools', () => {
  it('still skips a busy printer, without looking at the spools', async () => {
    store.status = { machine_status: { status: 2, exception_status: [] } };
    store.canvas = canvasWith([tray(1)]);
    const entry = await addAndFire(options());
    expect(entry.skipReason).toBe('The printer was busy');
    expect(starts()).toHaveLength(0);
  });

  it('still skips a file that is no longer on the printer', async () => {
    bridge.files = [];
    store.canvas = canvasWith([tray(1)]);
    const entry = await addAndFire(options());
    expect(entry.skipReason).toBe('The file is no longer on the printer');
    expect(starts()).toHaveLength(0);
  });
});

describe('persistence', () => {
  it('keeps a schedule’s settings across a restart', async () => {
    const entry = await service.add({
      filename: 'benchy.gcode',
      dir: '',
      runAt: Date.now() + HOUR,
      options: options(),
    });
    if (!entry) throw new Error('the schedule was refused');
    service.stop();

    service = make();
    await service.start();
    const [restored] = service.list();
    expect(restored.id).toBe(entry.id);
    expect(restored.options).toEqual(options());
  });

  it('refuses a request whose settings are malformed, rather than storing a guess', async () => {
    const entry = await service.add({
      filename: 'benchy.gcode',
      dir: '',
      runAt: Date.now() + HOUR,
      options: { ...options(), bedType: 'C' },
    });
    expect(entry).toBeNull();
    expect(service.list()).toHaveLength(0);
  });
});
