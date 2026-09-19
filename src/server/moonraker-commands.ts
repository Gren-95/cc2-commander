/**
 * What a Moonraker client's print commands send to the printer.
 *
 * Three front doors take these commands: the `/moonraker/*` router on the main port
 * (`moonraker-compat.ts`), and the `:7125` server's REST routes and JSON-RPC methods
 * (`moonraker-server.ts`). Each used to carry its own copy, and the copies drifted: the
 * `/moonraker/*` one sent temperatures as `{ target: 'extruder', temperature }`, a shape
 * nothing else in the repo uses, where the dashboard and `:7125` send `{ extruder }`; it
 * also did not understand `SET_HEATER_TEMPERATURE`. Upstream had to fix `storage_media` in
 * every copy separately for the same reason. There is one copy now.
 */

import type { MqttBridge } from './mqtt-bridge.js';

/** The one thing these need from the bridge, so a test can hand in a recorder. */
export type CommandSender = Pick<MqttBridge, 'sendCommand'>;

const START_PRINT = 1020;
const PAUSE_PRINT = 1021;
const CANCEL_PRINT = 1022;
const RESUME_PRINT = 1023;
const HOME = 1026;
const SET_TEMPERATURE = 1028;

/**
 * Start `filename` from the printer's own storage. 'local', not 'udisk': the printer takes
 * 'udisk' with error_code 0 and does nothing (see mqtt-bridge.ts), and uploads through the
 * `:7125` server land on local storage anyway.
 */
export function startPrint(bridge: CommandSender, filename: string): void {
  bridge.sendCommand(START_PRINT, { filename, storage_media: 'local' });
}

export function pausePrint(bridge: CommandSender): void {
  bridge.sendCommand(PAUSE_PRINT, {});
}

export function resumePrint(bridge: CommandSender): void {
  bridge.sendCommand(RESUME_PRINT, {});
}

export function cancelPrint(bridge: CommandSender): void {
  bridge.sendCommand(CANCEL_PRINT, {});
}

/**
 * Moonraker's emergency stop, sent as a print cancel as it always has been. The printer does
 * have an emergency-stop method (1007, what the dashboard's own button sends); switching this
 * to it would change what a physical stop does from a Mainsail or Fluidd client, so it is
 * left as it was, deliberately and on its own.
 */
export function emergencyStop(bridge: CommandSender): void {
  bridge.sendCommand(CANCEL_PRINT, {});
}

/**
 * Run the handful of G-code commands the printer can be driven by; anything else is
 * accepted and ignored, as before. Returns the script as it was understood (trimmed and
 * upper-cased), for the caller to log or echo.
 */
export function runGcodeScript(bridge: CommandSender, raw: unknown): string {
  const script = (typeof raw === 'string' ? raw : '').trim().toUpperCase();
  const s = (re: RegExp) => script.match(re)?.[1];

  if (script === 'G28' || script.startsWith('G28 ')) {
    bridge.sendCommand(HOME, { axes: ['x', 'y', 'z'] });
  } else if (script.startsWith('M104 ')) {
    const temp = s(/S(\d+)/);
    if (temp) bridge.sendCommand(SET_TEMPERATURE, { extruder: Number.parseInt(temp, 10) });
  } else if (script.startsWith('M140 ')) {
    const temp = s(/S(\d+)/);
    if (temp) bridge.sendCommand(SET_TEMPERATURE, { heater_bed: Number.parseInt(temp, 10) });
  } else if (script === 'M112') {
    bridge.sendCommand(CANCEL_PRINT, {});
  } else if (script.startsWith('SET_HEATER_TEMPERATURE')) {
    const heater = s(/HEATER=(\S+)/)?.toLowerCase();
    const target = s(/TARGET=(\d+)/);
    if (heater && target !== undefined) {
      const temp = Number.parseInt(target, 10);
      bridge.sendCommand(
        SET_TEMPERATURE,
        heater === 'heater_bed' ? { heater_bed: temp } : { extruder: temp },
      );
    }
  } else if (script === 'TURN_OFF_HEATERS') {
    bridge.sendCommand(SET_TEMPERATURE, { extruder: 0 });
    bridge.sendCommand(SET_TEMPERATURE, { heater_bed: 0 });
  }
  return script;
}
