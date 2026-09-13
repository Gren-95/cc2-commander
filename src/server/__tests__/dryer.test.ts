/**
 * The drying service — the one thing in this repo that holds a heater on by itself.
 *
 * The timer used to live in a browser tab, which meant closing the tab left the bed at
 * temperature with nothing running to turn it off. Moving it into the service fixes
 * that and takes on the obligation that comes with it: this process is now the only
 * thing that will ever send the off command, so the paths that send it are the paths
 * worth testing.
 *
 * No printer is involved. `MqttBridge` is a recorder and `StateStore` is a stub, so
 * every `1028` below is an array entry.
 */

import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { initDataPaths, resetDataPathsForTest } from '../data-paths.js';
import { DryerService } from '../dryer.js';
import type { MqttBridge } from '../mqtt-bridge.js';
import type { StateStore } from '../state-store.js';

const SET_TEMPERATURE = 1028;

interface Sent {
  method: number;
  params: Record<string, unknown>;
}

class FakeStore extends EventEmitter {
  status: Record<string, unknown> = {};
}

function makeBridge(sent: Sent[]): MqttBridge {
  return {
    sendCommand: (method: number, params: Record<string, unknown>) => {
      sent.push({ method, params });
    },
  } as unknown as MqttBridge;
}

let dir: string;
let sent: Sent[];
let store: FakeStore;
let dryer: DryerService;

const sessionFile = () => join(dir, 'dryer.json');
const beds = () => sent.filter((s) => s.method === SET_TEMPERATURE).map((s) => s.params.heater_bed);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc2-dryer-'));
  initDataPaths(dir);
  sent = [];
  store = new FakeStore();
  dryer = new DryerService(store as unknown as StateStore, makeBridge(sent));
});

afterEach(() => {
  dryer.stop();
  resetDataPathsForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('starting a session', () => {
  it('heats the bed and writes the session to disk', async () => {
    expect(await dryer.begin({ presetId: 'pla' })).toBeNull();
    expect(beds()).toEqual([45]);
    expect(existsSync(sessionFile())).toBe(true);
    expect(dryer.getState().session?.label).toBe('PLA');
  });

  it('refuses while a print is running, and sends nothing', async () => {
    // A drying session pins the bed for hours. Doing that under a print ruins the print,
    // and the refusal has to happen before any command goes out.
    store.status = { machine_status: { status: 2 } };
    expect(await dryer.begin({ presetId: 'pla' })).toBe('A print is running');
    expect(sent).toHaveLength(0);
    expect(existsSync(sessionFile())).toBe(false);
  });

  it('refuses an unknown preset rather than inventing a temperature', async () => {
    expect(await dryer.begin({ presetId: 'nonsense' })).toContain('Unknown preset');
    expect(sent).toHaveLength(0);
  });

  it('clamps a temperature arriving over HTTP to the safe ceiling', async () => {
    // The clamp is shared with the browser rather than reimplemented, so a request that
    // skips the UI entirely gets the same ceiling as one typed into the panel.
    await dryer.begin({ presetId: 'pla', tempC: 900 });
    expect(beds()).toEqual([80]);
  });
});

describe('ending a session', () => {
  it('turns the bed off and clears the file', async () => {
    await dryer.begin({ presetId: 'pla' });
    sent.length = 0;
    await dryer.finish('stopped');
    expect(beds()).toEqual([0]);
    expect(existsSync(sessionFile())).toBe(false);
    expect(dryer.getState().session).toBeNull();
  });

  it('clears the session before sending the off command', async () => {
    // The race this guards: a keepalive firing between the off command and the clear
    // would re-send the drying target and leave the bed hot with nothing running to
    // stop it. Asserted by watching what the session looks like as the command goes out.
    await dryer.begin({ presetId: 'pla' });
    let sessionAtOffTime: unknown = 'not observed';
    const bridge = makeBridge(sent);
    (
      bridge as unknown as { sendCommand: (m: number, p: Record<string, unknown>) => void }
    ).sendCommand = (method, params) => {
      sent.push({ method, params });
      if (params.heater_bed === 0) sessionAtOffTime = dryer.getState().session;
    };
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the instance is the point
    (dryer as any).bridge = bridge;

    await dryer.finish('stopped');
    expect(sessionAtOffTime).toBeNull();
  });

  it('stops itself when a print starts', async () => {
    await dryer.begin({ presetId: 'pla' });
    sent.length = 0;
    store.status = { machine_status: { status: 2 } };
    store.emit('print_event', { type: 'print_started' });
    await Bun.sleep(20);
    expect(beds()).toEqual([0]);
    expect(dryer.getState().session).toBeNull();
  });
});

describe('adopting what was left on disk', () => {
  it('resumes a session that is still running', async () => {
    writeFileSync(
      sessionFile(),
      JSON.stringify({
        presetId: 'pla',
        label: 'PLA',
        tempC: 45,
        totalMinutes: 240,
        rotateEveryMin: 60,
        rotationsDone: 0,
        startedAt: Date.now() - 60_000,
      }),
    );
    await dryer.start();
    expect(beds()).toEqual([45]);
    expect(dryer.getState().session?.label).toBe('PLA');
  });

  it('turns the bed off for a session that ran out while the service was down', async () => {
    // The branch nobody sees, and the reason `startedAt` is absolute. Storing minutes
    // remaining would make downtime pause the clock — and a hot bed does not pause.
    writeFileSync(
      sessionFile(),
      JSON.stringify({
        presetId: 'pla',
        label: 'PLA',
        tempC: 45,
        totalMinutes: 10,
        rotateEveryMin: 0,
        rotationsDone: 0,
        startedAt: Date.now() - 60 * 60_000,
      }),
    );
    await dryer.start();
    expect(beds()).toEqual([0]);
    expect(dryer.getState().session).toBeNull();
    expect(existsSync(sessionFile())).toBe(false);
  });

  it('ignores a malformed file rather than refusing to start', async () => {
    writeFileSync(sessionFile(), '{ this is not json');
    await dryer.start();
    expect(sent).toHaveLength(0);
    expect(dryer.getState().session).toBeNull();
  });

  it('does nothing at all when there is no file', async () => {
    await dryer.start();
    expect(sent).toHaveLength(0);
  });
});

describe('what is persisted', () => {
  it('stores an absolute start time, not a remaining duration', async () => {
    const before = Date.now();
    await dryer.begin({ presetId: 'pla' });
    const stored = JSON.parse(readFileSync(sessionFile(), 'utf-8')) as { startedAt: number };
    expect(stored.startedAt).toBeGreaterThanOrEqual(before);
    expect(stored.startedAt).toBeLessThanOrEqual(Date.now());
  });
});
