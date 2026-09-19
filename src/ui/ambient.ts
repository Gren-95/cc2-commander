/**
 * Ambient readings from Home Assistant, in the Temperatures card.
 *
 * The printer measures its own chamber, nozzle and bed. It has nothing to say about the
 * humidity of the room the filament is sitting in, which is the number that decides
 * whether a spool prints cleanly, and the only way to know whether a drying session
 * achieved anything.
 *
 * The row renders only when Home Assistant is configured AND has given us something.
 * An unconfigured install should see no trace of it rather than an empty section
 * inviting a question, so "off" and "broken" are deliberately different states here:
 * nothing at all, versus a row that says it cannot reach the server.
 */

import { setDryerHumidity } from './dryer-panel';
import type { Sample } from './sparkline';
import { $, $optional, escapeHtml, fetchTimeout } from './helpers';
import { icon } from './icons';

interface Reading {
  entityId: string;
  name: string;
  value: number;
  unit: string;
  deviceClass: string;
  /** When Home Assistant last saw it change, not when we read it. */
  changedAt: string;
}

/** Humidity gets a water glyph, temperature a thermometer, anything else a plain dot. */
function glyphFor(deviceClass: string): string {
  if (deviceClass === 'humidity') return icon('humidity');
  if (deviceClass === 'temperature') return icon('temperature');
  return icon('info');
}

/**
 * How dry is dry enough?
 *
 * Filament manufacturers put the threshold for "store it below this" between 15% and
 * 20% RH; above about 60% most hygroscopic filaments pick up moisture fast enough to
 * matter within a day. These are advisory colours on someone else's sensor, not a
 * control input, so they are deliberately coarse, and the accent is not used, because
 * on this dashboard the accent means "this control is engaged".
 */
/** How long since Home Assistant saw this change, once that is worth saying. */
function readingAge(changedAt: string): string {
  if (!changedAt) return '';
  const ms = Date.now() - new Date(changedAt).getTime();
  if (!Number.isFinite(ms) || ms < 5 * 60_000) return '';
  const mins = Math.round(ms / 60_000);
  return mins < 90 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
}

/**
 * The sensor's name without its kind when the icon beside it already says so: Home
 * Assistant names entities "<device> <kind>", which read here as "Efe Temp Temperature".
 * Only a trailing word matching the device class is dropped, and never the whole name.
 */
export function shortSensorName(name: string, deviceClass: string): string {
  const trimmed = name.trim();
  if (!deviceClass) return trimmed;
  const kind = new RegExp(`\\s+${deviceClass.replace(/_/g, ' ')}$`, 'i');
  const short = trimmed.replace(kind, '').trim();
  return short || trimmed;
}

function humidityTone(value: number): string {
  if (value >= 60) return 'text-bad';
  if (value >= 40) return 'text-warn';
  return 'text-ok';
}

export function renderAmbient(state: Record<string, unknown>): void {
  const readings = Array.isArray(state.readings) ? (state.readings as Reading[]) : [];
  const reachable = state.reachable === true;

  // The dryer panel wants the humidity too, and this is the only place that knows the
  // payload's shape. Null when there is none, so the panel shows nothing rather than a
  // stale number from before Home Assistant went away.
  const humidity = readings.find((r) => r.deviceClass === 'humidity');
  setDryerHumidity(
    reachable && humidity ? humidity.value : null,
    humidity?.name ?? '',
    humidity?.changedAt ?? '',
    Array.isArray(state.humidityHistory) ? (state.humidityHistory as Sample[]) : [],
  );

  const row = document.getElementById('ambient-row');
  if (!row) return;

  const configured = state.configured === true;
  if (!configured) {
    row.classList.add('hidden');
    return;
  }
  row.classList.remove('hidden');

  if (!reachable || readings.length === 0) {
    const why =
      typeof state.lastError === 'string' && state.lastError ? state.lastError : 'No reading';
    // The message is server-generated (an HTTP status, or our own sentence) but it is
    // still interpolated into markup, so it is escaped like anything else.
    row.innerHTML = `<div class="flex items-center gap-2 text-[11px] text-fg-muted">
      ${icon('disconnected')}<span class="truncate" title="${escapeHtml(why)}">Home Assistant unreachable</span>
    </div>`;
    return;
  }

  row.innerHTML = readings
    .map((r) => {
      const tone = r.deviceClass === 'humidity' ? humidityTone(r.value) : 'text-fg';
      // A battery sensor goes quiet in two ways that look the same on a dashboard:
      // nothing changed, or nothing is being heard. Putting one inside a printer makes
      // the second much likelier: an enclosure is a metal box, and Zigbee and BLE both
      // struggle to get out of one. Without an age, a stale number reads as a fact.
      const stale = readingAge(r.changedAt);
      // `value` is a number from the service's own parse, and `unit`/`name` come from
      // Home Assistant: user-set strings, so both are escaped.
      return `<div class="flex min-w-0 items-center gap-1.5" title="${escapeHtml(r.name)}">
        <span class="text-fg-muted">${glyphFor(r.deviceClass)}</span>
        <span class="font-mono text-sm tabular-nums ${tone}">${r.value}</span>
        <span class="text-[11px] text-fg-muted">${escapeHtml(r.unit)}</span>
        <span class="min-w-0 truncate text-[11px] text-fg-muted">${escapeHtml(shortSensorName(r.name, r.deviceClass))}</span>
        ${stale ? `<span class="shrink-0 text-[11px] text-fg-muted">· ${stale}</span>` : ''}
      </div>`;
    })
    .join('');
}

/**
 * Read the current state once, then let WebSocket frames keep it current.
 *
 * Without this a page loading between two polls shows an empty row for up to a minute:
 * the service broadcasts only when it polls, and a client that was not connected at
 * that moment never hears about it. `ui/dryer-panel.ts` does the same for the same
 * reason.
 */
export async function initAmbient(): Promise<void> {
  $optional('ambient-row')?.classList.add('hidden');
  try {
    const res = await fetchTimeout('/api/home-assistant');
    if (!res.ok) return;
    const body = (await res.json()) as { data?: Record<string, unknown> };
    if (body.data) renderAmbient(body.data);
  } catch {
    // An unreachable own-service is already visible everywhere else on the page; there
    // is nothing useful this row can add to that.
  }
}
