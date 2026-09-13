/** Service status — compact header badge with click-to-expand dropdown + system info */

import { toggleState } from './state-classes';
import { ICONS, type IconName, icon } from './icons';
import { $, escapeHtml } from './helpers';
import { type AboutStatus, setAboutStatus } from './about';
import type { PrinterState } from '../printer-state';
import {
  type MqttPhase,
  type VersionStampish,
  UNKNOWN_VERSION_LABEL,
  buildVersionLabel,
  mqttBannerHeadline,
  mqttPhaseMessage,
} from '../types';

export interface ServiceStatus {
  uptime: number;
  mqtt: string;
  /**
   * The finer split of `mqtt`'s `broker_only` (ELEG-59). Optional because a browser can
   * outlive a server restart and still be holding a `service_status` from before this
   * shipped; `phaseOf()` falls back to the coarse field in that case.
   */
  mqttPhase?: MqttPhase;
  mqttRegisterAttempts: number;
  /**
   * The deploy stamp (ELEG-48). Optional for the same reason as `mqttPhase`: a browser
   * can be holding a `service_status` from before this shipped.
   */
  build?: VersionStampish | null;
  printerSn: string | null;
  printerIp: string;
  wsClients: number;
  telegram: string;
  camera: string;
}

interface ServiceCheck {
  label: string;
  state: string;
  okValues: string[];
}

/** What the MQTT row reads. `registering…` is now reserved for actually registering. */
const PHASE_LABELS: Record<MqttPhase, string> = {
  connected: 'connected',
  disconnected: 'disconnected',
  awaiting_sn: 'waiting for printer',
  registering: 'registering...',
  rejected: 'refused — too many clients',
};

/**
 * Prefer the server's phase; fall back to deriving one from the coarse `mqtt` field so a
 * browser holding a pre-ELEG-59 `service_status` still renders sensibly. The fallback
 * cannot tell `awaiting_sn` from `registering` — that is the whole point of the new
 * field — so it reports the vaguer of the two rather than guessing.
 */
function phaseOf(s: ServiceStatus): MqttPhase {
  if (s.mqttPhase) return s.mqttPhase;
  if (s.mqtt === 'connected') return 'connected';
  return s.mqtt === 'broker_only' ? 'registering' : 'disconnected';
}

let lastStatus: ServiceStatus | null = null;
let dropdownBound = false;

/**
 * The printer link, as reported by the WebSocket client rather than by the service's
 * `service_status` broadcast.
 *
 * It lives here because it is drawn here. The header used to carry a second pill for
 * it, which put two overlapping answers to "is anything connected?" side by side — and
 * on a phone that pill was one of the things pushed off-screen entirely. The two
 * sources still arrive independently, so the badge renders whichever it has.
 */
export type PrinterLink = 'connected' | 'connecting' | 'disconnected' | 'error';

const PRINTER_LINK: Record<PrinterLink, { icon: IconName; label: string; cls: string }> = {
  connected: { icon: 'printerOk', label: 'Printer connected', cls: 'svc-printer-connected' },
  connecting: { icon: 'pending', label: 'Connecting…', cls: 'svc-printer-connecting' },
  disconnected: { icon: 'printerOff', label: 'Disconnected', cls: 'svc-printer-disconnected' },
  error: { icon: 'printerOff', label: 'Connection error', cls: 'svc-printer-disconnected' },
};

const PRINTER_CLASSES = Object.values(PRINTER_LINK).map((v) => v.cls);

let printerLink: PrinterLink = 'connecting';

/** Called by the WebSocket client whenever the printer link changes. */
export function setPrinterLink(state: PrinterLink): void {
  printerLink = state;
  renderPrinterLink();
}

/**
 * Paint the printer half of the badge.
 *
 * Separate from `renderServiceStatus` on purpose: that function returns early until the
 * first `service_status` arrives, and the printer state is known before then — a badge
 * that stayed blank for the first few seconds is what this change was meant to remove.
 */
function renderPrinterLink(): void {
  const badge = document.getElementById('svc-header-badge');
  const iconEl = document.getElementById('svc-printer-icon');
  const stateEl = document.getElementById('svc-printer-state');
  if (!badge || !iconEl || !stateEl) return;

  const link = PRINTER_LINK[printerLink];
  // Only the glyph class changes: this element carries its own utilities now, and
  // assigning className outright would wipe them (size and state colour included).
  for (const c of [...iconEl.classList]) if (c.startsWith('bi-')) iconEl.classList.remove(c);
  iconEl.classList.add('bi', `bi-${ICONS[link.icon]}`);
  badge.classList.remove(...PRINTER_CLASSES);
  badge.classList.add(link.cls);

  /*
   * The word is shown only when something is wrong. Connected is the steady state and
   * needs no caption — and never relying on colour alone is what the glyph swap is
   * for: a filled printer when it is up, an unplugged lead when it is not.
   */
  stateEl.textContent = printerLink === 'connected' ? '' : link.label;
  badge.title = `${link.label} · click for service status`;
  badge.setAttribute('aria-label', badge.title);
}

export function updateServiceStatus(data: Record<string, unknown>): void {
  lastStatus = data as unknown as ServiceStatus;
  // The About panel reports the build, the printer and the service; this broadcast is
  // where all three come from.
  setAboutStatus(lastStatus as unknown as AboutStatus);
  renderServiceStatus();
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function isOk(state: string, okValues: string[]): boolean {
  return okValues.includes(state);
}

function dotHtml(ok: boolean): string {
  return `<span class="w-[7px] h-[7px] rounded-full shrink-0 ${ok ? 'status-dot-ok bg-ok' : 'status-dot-err bg-bad'}"></span>`;
}

export function renderServiceStatus(): void {
  const badge = $('svc-header-badge');
  const dotsEl = $('svc-header-dots');
  const countEl = $('svc-header-count');
  const dropdown = $('service-status');

  if (!badge || !dotsEl || !countEl) return;

  // Bind dropdown toggle once
  if (!dropdownBound) {
    dropdownBound = true;
    const wrap = $('svc-header-wrap');
    const dd = $('svc-dropdown');
    if (wrap && dd) {
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        dd.classList.toggle('hidden');
      });
      document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target as Node)) dd.classList.add('hidden');
      });
    }
  }

  renderPrinterLink();

  if (!lastStatus) {
    dotsEl.innerHTML = '';
    countEl.textContent = '--';
    if (dropdown)
      dropdown.innerHTML =
        '<div class="text-fg-muted text-[0.82rem] [padding:8px_10px]">Waiting for service...</div>';
    return;
  }

  const s = lastStatus;

  // Define all services for health check
  const checks: ServiceCheck[] = [
    { label: 'MQTT', state: s.mqtt, okValues: ['connected'] },
    { label: 'Telegram', state: s.telegram, okValues: ['running'] },
    { label: 'Camera', state: s.camera, okValues: ['available'] },
    { label: 'Printer', state: s.printerSn ? 'ok' : 'err', okValues: ['ok'] },
  ];

  const healthy = checks.filter((c) => isOk(c.state, c.okValues)).length;
  const total = checks.length;

  // Header badge: colored dots + count
  const allOk = healthy === total;
  dotsEl.innerHTML = checks.map((c) => dotHtml(isOk(c.state, c.okValues))).join('');
  countEl.textContent = `${healthy}/${total}`;
  toggleState(badge, 'svc-all-ok', allOk);
  toggleState(badge, 'svc-has-err', !allOk);

  // Dropdown detail
  if (!dropdown) return;

  const phase = phaseOf(s);
  const mqttLabel = PHASE_LABELS[phase];

  // `x.y.z+aa`, the way RCP renders it — see formatBuildVersion. The dot is grey on an
  // unstamped build rather than green, because "unknown" is a real gap: production runs
  // as a container, and an image built outside the publish workflow shows exactly this
  // (ELEG-48).
  const version = buildVersionLabel(s.build);

  // The banner used to fire on `broker_only && attempts >= 3`, which meant it could
  // never fire for the case that most needed it: when the printer never speaks, no SN is
  // learned, registration is never attempted and `mqttRegisterAttempts` stays 0 forever
  // (ELEG-59). The decision now lives in `mqttBannerHeadline`, where it is testable.
  const headline = mqttBannerHeadline(phase, s.mqttRegisterAttempts);
  const firmwareBanner = headline
    ? `<div class="svc-firmware-warning [padding:8px_10px] [margin-bottom:6px] rounded-chip bg-[rgba(255,_152,_0,_0.12)] border border-[rgba(255,_152,_0,_0.4)] text-[#ffb74d] text-[0.8rem] leading-[1.4] [&_strong]:text-[#ff9800]">
        ${icon('warning')} <strong>${escapeHtml(headline)}</strong> — ${escapeHtml(mqttPhaseMessage(phase))}
        ${phase === 'registering' ? `(${s.mqttRegisterAttempts} registration attempts)` : ''}
      </div>`
    : '';

  dropdown.innerHTML = `
    ${firmwareBanner}
    <div class="flex flex-col [gap:2px]">
      <div class="svc-item flex items-center [gap:6px] [padding:6px_10px] bg-input rounded-chip text-[0.82rem]">${dotHtml(isOk(s.mqtt, ['connected']))}<span class="text-fg-muted whitespace-nowrap">MQTT</span><span class="text-fg ml-auto font-medium">${mqttLabel}</span></div>
      <div class="svc-item flex items-center [gap:6px] [padding:6px_10px] bg-input rounded-chip text-[0.82rem]">${dotHtml(isOk(s.telegram, ['running']))}<span class="text-fg-muted whitespace-nowrap">Telegram</span><span class="text-fg ml-auto font-medium">${s.telegram}</span></div>
      <div class="svc-item flex items-center [gap:6px] [padding:6px_10px] bg-input rounded-chip text-[0.82rem]">${dotHtml(isOk(s.camera, ['available']))}<span class="text-fg-muted whitespace-nowrap">Camera</span><span class="text-fg ml-auto font-medium">${s.camera}</span></div>
      <div class="svc-item flex items-center [gap:6px] [padding:6px_10px] bg-input rounded-chip text-[0.82rem]">${dotHtml(!!s.printerSn)}<span class="text-fg-muted whitespace-nowrap">Printer</span><span class="text-fg ml-auto font-medium">${s.printerSn || 'unknown'}</span></div>
      <div class="svc-item flex items-center [gap:6px] [padding:6px_10px] bg-input rounded-chip text-[0.82rem]">${dotHtml(true)}<span class="text-fg-muted whitespace-nowrap">WS Clients</span><span class="text-fg ml-auto font-medium">${s.wsClients}</span></div>
      <div class="svc-item flex items-center [gap:6px] [padding:6px_10px] bg-input rounded-chip text-[0.82rem]">${dotHtml(true)}<span class="text-fg-muted whitespace-nowrap">Uptime</span><span class="text-fg ml-auto font-medium">${formatUptime(s.uptime)}</span></div>
      <div class="svc-item flex items-center [gap:6px] [padding:6px_10px] bg-input rounded-chip text-[0.82rem]">${dotHtml(version !== UNKNOWN_VERSION_LABEL)}<span class="text-fg-muted whitespace-nowrap">Version</span><span class="text-fg ml-auto font-medium">${escapeHtml(version)}</span></div>
    </div>
  `;
}

/* ─── System Info (rendered into dropdown) ─── */

let lastSysKey = '';

export function renderSystemInfo(state: PrinterState): void {
  const container = $('system-info');
  if (!container) return;

  const attrs = state.attributes;
  if (!attrs) return;

  const key = JSON.stringify([attrs.sn, attrs.software_version?.ota_version]);
  if (key === lastSysKey) return;
  lastSysKey = key;

  // Everything here comes from 1001 (GET_ATTRIBUTES). There used to be a second loop
  // over `state.systemInfo`, filled from method 1062 — it never produced a single row,
  // because 1062 answers `{"error_code": 1100}` on this firmware and the handler only
  // stored a result on `error_code === 0` (ELEG-55).
  const rows: [string, string][] = [];

  rows.push(['Hostname', attrs.hostname]);
  rows.push(['Model', attrs.machine_model]);
  rows.push(['Serial', attrs.sn]);
  rows.push(['IP', attrs.ip]);
  if (attrs.software_version) {
    rows.push(['OTA Version', attrs.software_version.ota_version]);
    rows.push(['MCU Version', attrs.software_version.mcu_version]);
    rows.push(['SoC Version', attrs.software_version.soc_version]);
  }
  if (attrs.hardware_version) {
    rows.push(['Hardware', attrs.hardware_version]);
  }
  if (attrs.protocol_version) {
    rows.push(['Protocol', attrs.protocol_version]);
  }

  let html = '<div class="flex flex-col [gap:2px]">';
  for (const [label, value] of rows) {
    html += `<div class="svc-item flex items-center [gap:6px] [padding:6px_10px] bg-input rounded-chip text-[0.82rem]"><span class="text-fg-muted whitespace-nowrap">${escapeHtml(label)}</span><span class="text-fg ml-auto font-medium">${escapeHtml(value)}</span></div>`;
  }
  html += '</div>';

  container.innerHTML = html;
}
