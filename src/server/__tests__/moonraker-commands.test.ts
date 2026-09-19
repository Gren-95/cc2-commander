/**
 * What a Moonraker client's commands put on the wire.
 *
 * Three front doors take these (the `/moonraker/*` router and the `:7125` server's REST and
 * JSON-RPC), and each used to carry its own copy. The copies drifted: the `/moonraker/*`
 * one sent temperatures in a shape nothing else uses. These pin the one shared copy, and
 * drive the real `/moonraker/*` router to prove it goes through it. No printer is involved:
 * the bridge is a recorder, so every command below is an array entry.
 */

import { describe, expect, it } from 'bun:test';
import type { ServiceConfig } from '../config.js';
import { createMoonrakerRouter } from '../moonraker-compat.js';
import {
  cancelPrint,
  emergencyStop,
  pausePrint,
  resumePrint,
  runGcodeScript,
  startPrint,
} from '../moonraker-commands.js';
import type { MqttBridge } from '../mqtt-bridge.js';
import { runNodeHandler } from '../node-compat.js';
import type { StateStore } from '../state-store.js';

type Sent = { method: number; params: Record<string, unknown> };

function recorder() {
  const sent: Sent[] = [];
  return {
    sent,
    bridge: {
      sendCommand: (method: number, params: Record<string, unknown>) =>
        sent.push({ method, params }),
    },
  };
}

const gcode = (script: unknown) => {
  const r = recorder();
  runGcodeScript(r.bridge as never, script);
  return r.sent;
};

describe('print commands', () => {
  it('starts a file from the printer’s own storage, never "udisk"', () => {
    const r = recorder();
    startPrint(r.bridge as never, 'misc/benchy.gcode');
    expect(r.sent).toEqual([
      { method: 1020, params: { filename: 'misc/benchy.gcode', storage_media: 'local' } },
    ]);
  });

  it.each([
    ['pause', pausePrint, 1021],
    ['resume', resumePrint, 1023],
    ['cancel', cancelPrint, 1022],
  ] as const)('%s sends %s', (_name, fn, method) => {
    const r = recorder();
    fn(r.bridge as never);
    expect(r.sent).toEqual([{ method, params: {} }]);
  });

  it('keeps emergency stop as a cancel, as it has always been', () => {
    // Deliberately not 1007: changing what a physical stop does from a Mainsail client is
    // its own decision, not a side effect of a refactor.
    const r = recorder();
    emergencyStop(r.bridge as never);
    expect(r.sent).toEqual([{ method: 1022, params: {} }]);
  });
});

describe('G-code', () => {
  it('homes on G28, with or without axes', () => {
    expect(gcode('G28')).toEqual([{ method: 1026, params: { axes: ['x', 'y', 'z'] } }]);
    expect(gcode('g28 x')).toEqual([{ method: 1026, params: { axes: ['x', 'y', 'z'] } }]);
  });

  it('sets temperatures in the shape the dashboard uses', () => {
    expect(gcode('M104 S210')).toEqual([{ method: 1028, params: { extruder: 210 } }]);
    expect(gcode('M140 S60')).toEqual([{ method: 1028, params: { heater_bed: 60 } }]);
  });

  it('never sends the { target, temperature } shape the /moonraker/* copy used', () => {
    for (const script of [
      'M104 S210',
      'M140 S60',
      'TURN_OFF_HEATERS',
      'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=200',
    ]) {
      for (const c of gcode(script)) expect(c.params).not.toHaveProperty('target');
    }
  });

  it('understands SET_HEATER_TEMPERATURE for either heater', () => {
    expect(gcode('SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=55')).toEqual([
      { method: 1028, params: { heater_bed: 55 } },
    ]);
    expect(gcode('SET_HEATER_TEMPERATURE HEATER=extruder TARGET=200')).toEqual([
      { method: 1028, params: { extruder: 200 } },
    ]);
  });

  it('turns both heaters off', () => {
    expect(gcode('TURN_OFF_HEATERS')).toEqual([
      { method: 1028, params: { extruder: 0 } },
      { method: 1028, params: { heater_bed: 0 } },
    ]);
  });

  it('cancels on M112', () => {
    expect(gcode('M112')).toEqual([{ method: 1022, params: {} }]);
  });

  it('ignores what it does not understand, and a temperature with no value', () => {
    expect(gcode('G1 X10 Y10')).toEqual([]);
    expect(gcode('M104')).toEqual([]);
    expect(gcode(undefined)).toEqual([]);
    expect(gcode(42)).toEqual([]);
  });
});

describe('the /moonraker/* router goes through the shared commands', () => {
  const route = async (path: string, body?: unknown) => {
    const r = recorder();
    const router = createMoonrakerRouter(
      {} as StateStore,
      r.bridge as unknown as MqttBridge,
      {} as ServiceConfig,
    );
    const res = await runNodeHandler(
      (req, res) => {
        if (!router(req, res)) {
          res.writeHead(404);
          res.end();
        }
      },
      new Request(`http://localhost/moonraker${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    await res.text();
    return r.sent;
  };

  it('sends a G-code temperature in the dashboard’s shape', async () => {
    // The drift this refactor removes: this route used to send { target, temperature }.
    expect(await route('/printer/gcode/script', { script: 'M104 S205' })).toEqual([
      { method: 1028, params: { extruder: 205 } },
    ]);
  });

  it('starts a print from local storage', async () => {
    expect(await route('/printer/print/start?filename=a.gcode')).toEqual([
      { method: 1020, params: { filename: 'a.gcode', storage_media: 'local' } },
    ]);
  });

  it('sends emergency stop as a cancel', async () => {
    expect(await route('/printer/emergency_stop')).toEqual([{ method: 1022, params: {} }]);
  });
});
