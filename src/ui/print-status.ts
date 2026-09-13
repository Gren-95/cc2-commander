import { setDryerPrinting, setDryerTemps } from './dryer-panel';
import { positionSegmented } from './segmented';
import { toggleState } from './state-classes';
import { icon, iconOnly, iconSolo, iconText } from './icons';
import type { PrinterState } from '../printer-state';
import type { CommandSender } from '../ws-client';
import {
  STATUS_NAMES,
  SUB_STATUS_NAMES,
  EXCEPTION_NAMES,
  CRITICAL_EXCEPTIONS,
  powerLossState,
} from '../types';
import { maybeShowPowerLossDialog } from './power-loss-dialog';
import { $, formatTime, formatClock, fanPct, escapeHtml, applyDarkThumbnailCheck } from './helpers';
import { loadUISettings, saveUISettings } from './ui-settings';

let lastThumbnailFile = '';

// Filament densities (g/cm³) for length calculation
const FILAMENT_DENSITY: Record<string, number> = {
  PLA: 1.24,
  ABS: 1.04,
  ASA: 1.07,
  PETG: 1.27,
  TPU: 1.21,
  PA: 1.14,
  PC: 1.2,
  PVA: 1.23,
  HIPS: 1.04,
};
const FILAMENT_DIAMETER_CM = 0.175; // 1.75mm
const CROSS_SECTION_CM2 = Math.PI * (FILAMENT_DIAMETER_CM / 2) ** 2;

// Extrusion tracking for live flow rate
const FILAMENT_RADIUS_MM = 1.75 / 2;
const CROSS_SECTION_MM2 = Math.PI * FILAMENT_RADIUS_MM * FILAMENT_RADIUS_MM;
let _prevE = 0;
let _prevETime = 0;
let _lastExtRate = 0;
let _lastFlowRate = 0;
let _lastMassFlow = 0;
let _lastPulseTime = 0;

function gramsToMeters(grams: number, filamentType: string): number {
  const density = FILAMENT_DENSITY[filamentType.toUpperCase()] ?? FILAMENT_DENSITY.PLA;
  const volumeCm3 = grams / density;
  return volumeCm3 / CROSS_SECTION_CM2 / 100;
}

function getActiveFilamentType(state: PrinterState): string {
  // Try active Canvas tray
  const canvas = state.canvas;
  if (canvas?.canvas_list?.length) {
    for (const unit of canvas.canvas_list) {
      if (unit.canvas_id !== canvas.active_canvas_id) continue;
      for (const tray of unit.tray_list) {
        if (tray.tray_id === canvas.active_tray_id && tray.filament_type) {
          return tray.filament_type;
        }
      }
    }
  }
  // Try mono filament
  const mono = state.monoFilament as Record<string, unknown> | null;
  if (mono?.filament_type) return mono.filament_type as string;
  return 'PLA';
}

/** Get active filament type + color for display */
function getActiveFilamentInfo(state: PrinterState): { type: string; color: string } | null {
  const canvas = state.canvas;
  if (canvas?.canvas_list?.length) {
    for (const unit of canvas.canvas_list) {
      if (unit.canvas_id !== canvas.active_canvas_id) continue;
      for (const tray of unit.tray_list) {
        if (tray.tray_id === canvas.active_tray_id && tray.filament_type) {
          const color = `#${(tray.filament_color || '434343').replace(/^#/, '')}`;
          return { type: tray.filament_type, color };
        }
      }
    }
  }
  const mono = state.monoFilament as Record<string, unknown> | null;
  if (mono?.filament_type) {
    const color = `#${((mono.filament_color as string) || '434343').replace(/^#/, '')}`;
    return { type: mono.filament_type as string, color };
  }
  return null;
}

function updateFan(prefix: string, speed: number, toggleId: string, rpm?: number): void {
  const pct = fanPct(speed);
  const range = document.getElementById(`${prefix}-range`) as HTMLInputElement | null;
  // Never while it has focus. A status frame lands every second, and writing the
  // reported speed back mid-drag snaps the thumb out from under the pointer — the fan
  // has not spun up yet, so the value being written is the OLD one.
  if (range && document.activeElement !== range) range.value = String(pct);
  $(`${prefix}-value`).textContent = `${pct}%`;
  ($(toggleId) as HTMLInputElement).checked = speed > 0;
  const rpmEl = $(`${prefix}-rpm`);
  if (rpmEl) {
    rpmEl.textContent = rpm != null && rpm > 0 ? `${rpm} RPM` : '';
  }
}

let overlayEnabled = loadUISettings().cameraOverlay;

function getCameraStreamUrl(): string {
  return overlayEnabled ? '/api/stream/overlay' : '/api/stream';
}

export function toggleCameraOverlay(): void {
  overlayEnabled = !overlayEnabled;
  saveUISettings({ cameraOverlay: overlayEnabled });
  const img = $('camera-feed') as HTMLImageElement;
  const btn = $('camera-overlay-btn');
  if (img && !img.classList.contains('hidden')) {
    img.src = getCameraStreamUrl();
  }
  // Also update modal img if visible
  const modalImg = $('camera-modal-img') as HTMLImageElement;
  if (modalImg && modalImg.src) {
    modalImg.src = getCameraStreamUrl();
  }
  if (btn) {
    toggleState(btn, 'active', overlayEnabled);
    // Two glyphs when active (chart + tick), so `iconText` is not enough — but the
    // label is a literal, so innerHTML is safe here.
    btn.innerHTML = overlayEnabled
      ? `${icon('overlay')} Overlay ${iconSolo('check')}`
      : `${icon('overlay')} Overlay`;
  }
}

function updateCamera(hasCamera: boolean, _printerIp: string): void {
  const img = $('camera-feed') as HTMLImageElement;
  const overlay = $('camera-overlay');

  if (hasCamera) {
    const src = getCameraStreamUrl();
    if (!img.src.endsWith(new URL(src, location.href).pathname)) {
      img.src = src;
    }
    overlay.classList.add('hidden');
    img.classList.remove('hidden');
    $('camera-wrap')?.classList.remove('camera-off');
  } else {
    img.classList.add('hidden');
    overlay.classList.remove('hidden');
    // Drops the 200px min-height so the card is the size of its message, not of the
    // video it is not showing.
    $('camera-wrap')?.classList.add('camera-off');
    // Only the text node — `overlay.textContent = …` would take the icon with it.
    $('camera-overlay-text').textContent = 'Camera not connected';
  }
}

export function renderDashboard(state: PrinterState, client: CommandSender): void {
  const s = state.status;
  if (!s) return;

  const machineStatus = s.machine_status;
  const ps = s.print_status;
  const isPrinting = machineStatus?.status === 2;
  // The dryer refuses to start mid-print: it would hold the bed at a fixed temperature
  // for hours. This is the one place that already knows, so it is the one that tells.
  setDryerPrinting(isPrinting);
  const isPaused = machineStatus?.sub_status === 2502 || machineStatus?.sub_status === 2505;
  const statusName = STATUS_NAMES[machineStatus?.status] ?? 'Unknown';
  const subStatusName = SUB_STATUS_NAMES[machineStatus?.sub_status] ?? '';
  const powerLoss = powerLossState(machineStatus?.status, machineStatus?.sub_status);

  // A half-finished print is waiting on a human, and this is the thing they have open.
  maybeShowPowerLossDialog(powerLoss, ps?.filename, client);

  // Thumbnail — request once per file, don't retry on failure
  if (ps?.filename && ps.filename !== lastThumbnailFile) {
    lastThumbnailFile = ps.filename;
    state.thumbnail = null;
    state.thumbnailFailed = false;
    state.fileFilamentUsed = null;
    state.thumbnailRequestQueue.push('print');
    client.sendCommand(1045, { storage_media: 'local', file_name: ps.filename });
    client.sendCommand(1046, { storage_media: 'local', filename: ps.filename });
  }

  // Show thumbnail
  const thumbImg = $('print-thumbnail') as HTMLImageElement;
  const thumbPlaceholder = $('print-thumbnail-placeholder');
  if (state.thumbnail) {
    thumbImg.src = `data:image/png;base64,${state.thumbnail}`;
    thumbImg.classList.remove('hidden');
    thumbPlaceholder.classList.add('hidden');
    applyDarkThumbnailCheck(thumbImg, $('print-thumbnail-wrap'));
  } else {
    thumbImg.classList.add('hidden');
    thumbPlaceholder.classList.remove('hidden');
    if (state.thumbnailFailed) thumbPlaceholder.textContent = 'No preview';
    else iconOnly(thumbPlaceholder, 'print', 'No thumbnail yet');
    $('print-thumbnail-wrap').classList.remove('thumbnail-dark');
  }

  // Print filename
  if (ps?.filename) {
    $('print-filename').textContent = ps.filename;
    $('print-filename').title = ps.filename;
  } else {
    // The badge underneath already carries the status and its sub-status. Repeating it
    // here rendered "Idle" twice, one line above the other.
    $('print-filename').textContent = 'No active print';
    $('print-filename').removeAttribute('title');
  }

  // Status badge — always show both status and sub-status
  const badge = $('print-status-badge');
  const subLabel = subStatusName ? ` · ${subStatusName}` : '';
  if (isPrinting && !isPaused) {
    iconText(badge, 'printing', `Printing${subLabel}`);
    badge.className =
      'print-status-badge badge-printing inline-block [padding:3px_12px] rounded-[10px] text-[13px] font-semibold [margin:4px_0] tracking-[0.02em] bg-[rgba(33,_150,_243,_0.2)] text-accent';
  } else if (isPaused) {
    iconText(badge, 'pause', `Paused${subLabel}`);
    badge.className =
      'print-status-badge badge-paused inline-block [padding:3px_12px] rounded-[10px] text-[13px] font-semibold [margin:4px_0] tracking-[0.02em] bg-[rgba(255,_167,_38,_0.2)] text-warn';
  } else if (machineStatus?.status === 5) {
    iconText(badge, 'layer', `${statusName}${subLabel}`);
    badge.className =
      'print-status-badge badge-busy inline-block [padding:3px_12px] rounded-[10px] text-[13px] font-semibold [margin:4px_0] tracking-[0.02em] bg-[rgba(156,_39,_176,_0.2)] text-[#ce93d8]';
  } else if (
    machineStatus?.status === 3 ||
    machineStatus?.status === 4 ||
    machineStatus?.status === 13
  ) {
    iconText(badge, 'refresh', `${statusName}${subLabel}`);
    badge.className =
      'print-status-badge badge-busy inline-block [padding:3px_12px] rounded-[10px] text-[13px] font-semibold [margin:4px_0] tracking-[0.02em] bg-[rgba(156,_39,_176,_0.2)] text-[#ce93d8]';
  } else if (
    machineStatus?.status === 6 ||
    machineStatus?.status === 7 ||
    machineStatus?.status === 8
  ) {
    iconText(badge, 'settings', `${statusName}${subLabel}`);
    badge.className =
      'print-status-badge badge-busy inline-block [padding:3px_12px] rounded-[10px] text-[13px] font-semibold [margin:4px_0] tracking-[0.02em] bg-[rgba(156,_39,_176,_0.2)] text-[#ce93d8]';
  } else if (machineStatus?.status === 14) {
    iconText(badge, 'estop', statusName);
    badge.className = 'print-status-badge badge-error';
  } else if (powerLoss !== 'none') {
    // Status 15 used to fall through to the `else` below and render as `badge-idle` —
    // the printer sitting on a half-finished job awaiting a decision, styled as though
    // it had nothing to do (ELEG-29).
    iconText(
      badge,
      'powerLoss',
      powerLoss === 'awaiting_decision'
        ? 'Power loss — resume or cancel'
        : `${statusName}${subLabel}`,
    );
    badge.className =
      powerLoss === 'awaiting_decision'
        ? 'print-status-badge badge-error inline-block [padding:3px_12px] rounded-[10px] text-[13px] font-semibold [margin:4px_0] tracking-[0.02em] bg-[rgba(239,_83,_80,_0.2)] text-bad'
        : 'print-status-badge badge-busy inline-block [padding:3px_12px] rounded-[10px] text-[13px] font-semibold [margin:4px_0] tracking-[0.02em] bg-[rgba(156,_39,_176,_0.2)] text-[#ce93d8]';
  } else {
    badge.textContent = statusName + subLabel;
    badge.className =
      'print-status-badge badge-idle inline-block [padding:3px_12px] rounded-[10px] text-[13px] font-semibold [margin:4px_0] tracking-[0.02em] bg-[rgba(160,_160,_184,_0.15)] text-fg-soft';
  }

  // Progress — compute from durations in delta updates (available every second)
  // machine_status.progress only arrives from full 1002 responses (every ~5s)
  let progress = machineStatus?.progress ?? 0;
  if ((isPrinting || isPaused) && ps?.print_duration != null && ps?.remaining_time_sec != null) {
    const total = ps.print_duration + ps.remaining_time_sec;
    if (total > 0) {
      progress = Math.min(99, Math.round((ps.print_duration / total) * 100));
    }
  }
  const progressText = $('print-progress-text');
  progressText.textContent = isPrinting || isPaused ? `${progress}%` : '--%';
  const progressBar = $('print-progress-bar') as HTMLElement;
  progressBar.style.width = `${progress}%`;
  toggleState(progressBar, 'active', isPrinting && !isPaused);
  // Pulse progress text every ~2s while printing to show data is live
  const pulseNow = Date.now();
  if ((isPrinting || isPaused) && pulseNow - _lastPulseTime >= 2000) {
    _lastPulseTime = pulseNow;
    toggleState(progressText, 'pulse', false);
    void progressText.offsetWidth;
    toggleState(progressText, 'pulse', true);
  } else if (!isPrinting && !isPaused) {
    toggleState(progressText, 'pulse', false);
  }

  // Window title — show status and progress
  if (isPrinting || isPaused) {
    const pctStr = `${progress}%`;
    const stateStr = isPaused ? 'Paused' : 'Printing';
    const sub = subStatusName ? ` · ${subStatusName}` : '';
    document.title = `${pctStr} ${stateStr}${sub} — CC2 Commander`;
  } else if (machineStatus?.status === 1) {
    document.title = 'Idle — CC2 Commander';
  } else {
    const sub = subStatusName ? ` · ${subStatusName}` : '';
    document.title = `${statusName}${sub} — CC2 Commander`;
  }

  // Layer info — use fileTotalLayers from method 1046 or fallback to print_status
  const totalLayer = ps?.total_layer ?? state.fileTotalLayers ?? '??';
  const currentLayer = ps?.current_layer ?? '--';
  // The label lives in the markup now, so this writes the value alone.
  $('print-layer').textContent = `${currentLayer} of ${totalLayer}`;

  // Filament usage from method 1046
  const filamentUsed = state.fileFilamentUsed;
  if (filamentUsed != null && (isPrinting || isPaused)) {
    const lengthM = gramsToMeters(filamentUsed, getActiveFilamentType(state));
    iconText(
      $('print-filament'),
      'filament',
      `${filamentUsed.toFixed(1)}g (${lengthM.toFixed(1)}m)`,
    );
  } else {
    $('print-filament').textContent = '--';
  }

  // Active filament display
  const activeFilamentEl = $('print-active-filament');
  const colorChangesEl = $('print-color-changes');
  if (isPrinting || isPaused) {
    const activeInfo = getActiveFilamentInfo(state);
    if (activeInfo) {
      activeFilamentEl.innerHTML = `<span class="inline-block w-3 h-3 rounded-[3px] border border-[rgba(255,_255,_255,_0.2)] align-[middle] [margin-right:2px]" style="background:${escapeHtml(activeInfo.color)}"></span> ${escapeHtml(activeInfo.type)}`;
    } else {
      iconText(activeFilamentEl, 'filament', getActiveFilamentType(state));
    }
    // Color changes from color_map
    const colorMap = state.colorMap;
    if (colorMap.length > 1) {
      iconText(colorChangesEl, 'refresh', `${colorMap.length} filaments`);
    } else {
      colorChangesEl.textContent = '';
    }
  } else {
    activeFilamentEl.textContent = '--';
    colorChangesEl.textContent = '';
  }

  // Remaining time
  const remaining = formatTime(ps?.remaining_time_sec);
  $('print-remaining').textContent =
    (isPrinting || isPaused) && remaining !== '--' ? remaining : '--';

  // Elapsed time
  const printDur = ps?.print_duration;
  if (printDur != null && (isPrinting || isPaused)) {
    $('print-elapsed').textContent = formatTime(printDur);
  } else {
    $('print-elapsed').textContent = '--';
  }

  // Start time and ETA (calculated from elapsed / remaining)
  if ((isPrinting || isPaused) && printDur != null) {
    const startedAt = new Date(Date.now() - printDur * 1000);
    $('print-started').textContent = formatClock(startedAt);
  } else {
    $('print-started').textContent = '--';
  }
  if ((isPrinting || isPaused) && ps?.remaining_time_sec != null && ps.remaining_time_sec > 0) {
    const eta = new Date(Date.now() + ps.remaining_time_sec * 1000);
    $('print-eta').textContent = formatClock(eta);
  } else {
    $('print-eta').textContent = '--';
  }

  // The print-only blocks. Everything in them reads "--" without a print, and there are
  // nine such fields — so an idle printer's most prominent card was a grid of dashes
  // with `0 of ??` set in the largest type on it. It gets one honest line instead.
  const running = isPrinting || isPaused;
  $('print-progress-block').classList.toggle('hidden', !running);
  $('print-detail-grid').classList.toggle('hidden', !running);
  $('print-idle-note').classList.toggle('hidden', running);

  // Print action buttons
  $('btn-pause').classList.toggle('hidden', !isPrinting || isPaused);
  $('btn-resume').classList.toggle('hidden', !isPaused);
  $('btn-stop').classList.toggle('hidden', !isPrinting && !isPaused);

  // Temperatures (show 2 decimal places like Elegoo app)
  const ext = s.extruder;
  if (ext) {
    $('temp-nozzle').textContent = ext.temperature.toFixed(2);
    $('temp-nozzle-target').textContent = Math.round(ext.target).toString();
    const nozzlePct = ext.target > 0 ? Math.min(100, (ext.temperature / ext.target) * 100) : 0;
    ($('temp-nozzle-bar') as HTMLElement).style.width = `${nozzlePct}%`;
    const nozzleBar = $('temp-nozzle-bar') as HTMLElement;
    toggleState(nozzleBar, 'heating', ext.temperature < ext.target - 2 && ext.target > 0);
    toggleState(
      nozzleBar,
      'at-target',
      Math.abs(ext.temperature - ext.target) <= 2 && ext.target > 0,
    );
  }

  const bed = s.heater_bed;
  if (bed) {
    $('temp-bed').textContent = bed.temperature.toFixed(2);
    $('temp-bed-target').textContent = Math.round(bed.target).toString();
    const bedPct = bed.target > 0 ? Math.min(100, (bed.temperature / bed.target) * 100) : 0;
    ($('temp-bed-bar') as HTMLElement).style.width = `${bedPct}%`;
    const bedBar = $('temp-bed-bar') as HTMLElement;
    toggleState(bedBar, 'heating', bed.temperature < bed.target - 2 && bed.target > 0);
    toggleState(bedBar, 'at-target', Math.abs(bed.temperature - bed.target) <= 2 && bed.target > 0);
  }

  // One call, after all three are read, so the dryer panel never renders a mix of this
  // status and the last one. Its keepalive compares `bedTarget` against the session to
  // tell a correction from a no-op, and the running view shows the rest.
  setDryerTemps({
    bed: bed?.temperature ?? null,
    bedTarget: bed?.target ?? null,
    chamber: s.ztemperature_sensor?.temperature ?? null,
    nozzle: ext?.temperature ?? null,
  });

  const chamber = s.ztemperature_sensor;
  if (chamber) {
    $('temp-chamber').textContent = chamber.temperature.toFixed(2);
    const minT = chamber.measured_min_temperature;
    const maxT = chamber.measured_max_temperature;
    const rangeEl = $('temp-chamber-range');
    if (minT != null && maxT != null && (minT > 0 || maxT > 0)) {
      // Literal numbers only, so innerHTML is safe — and two arrows in one string
      // is past what iconText() can express.
      rangeEl.innerHTML = `(${icon('down')}${minT.toFixed(0)} ${icon('up')}${maxT.toFixed(0)})`;
    } else {
      rangeEl.textContent = '';
    }
  }

  // Position
  const pos = s.gcode_move;
  if (pos) {
    $('pos-x').textContent = pos.x?.toFixed(1) ?? '--';
    $('pos-y').textContent = pos.y?.toFixed(1) ?? '--';
    $('pos-z').textContent = pos.z?.toFixed(1) ?? '--';
  }

  // Homing status
  const homed = s.tool_head?.homed_axes ?? '';
  for (const a of ['x', 'y', 'z'] as const) {
    const dot = $(`home-${a}`);
    const isHomed = homed.includes(a);
    toggleState(dot, 'homed', isHomed);
    dot.title = isHomed ? `${a.toUpperCase()} homed` : `${a.toUpperCase()} not homed`;
  }

  // Live speed & flow. The unit is markup beside the value, not part of it —
  // see the readout/unit split in `ui/design.ts`.
  $('live-speed').textContent = pos?.speed ? String(Math.round(pos.speed)) : '--';
  const currentE = pos?.extruder ?? pos?.e ?? 0;
  const now = Date.now();
  // Only recompute rates when we get a NEW extruder position (not every render)
  if (currentE !== _prevE && _prevETime > 0) {
    const dt = (now - _prevETime) / 1000;
    if (dt > 0 && currentE > _prevE) {
      _lastExtRate = (currentE - _prevE) / dt;
      _lastFlowRate = _lastExtRate * CROSS_SECTION_MM2;
      const activeType = getActiveFilamentType(state);
      const density = FILAMENT_DENSITY[activeType.toUpperCase()] ?? FILAMENT_DENSITY.PLA;
      _lastMassFlow = (_lastExtRate / 10) * CROSS_SECTION_CM2 * density * 1000; // mg/s
    }
    _prevE = currentE;
    _prevETime = now;
  } else if (_prevETime === 0 && currentE > 0) {
    // First sample — just record baseline
    _prevE = currentE;
    _prevETime = now;
  }
  $('live-extrusion').textContent = _lastExtRate > 0 ? _lastExtRate.toFixed(1) : '--';
  $('live-flow').textContent = _lastFlowRate > 0 ? _lastFlowRate.toFixed(1) : '--';
  $('live-mass-flow').textContent = _lastMassFlow > 0 ? _lastMassFlow.toFixed(1) : '--';

  // Per-spool filament usage
  renderFilamentUsage(state);

  // Fans — use Elegoo naming (Model/Assistance/Case)
  const fans = s.fans;
  if (fans) {
    updateFan('fan-model', fans.fan?.speed ?? 0, 'fan-model-toggle', fans.fan?.rpm);
    updateFan('fan-aux', fans.aux_fan?.speed ?? 0, 'fan-aux-toggle', fans.aux_fan?.rpm);
    updateFan('fan-case', fans.box_fan?.speed ?? 0, 'fan-case-toggle', fans.box_fan?.rpm);
  }

  // Speed mode buttons — status reports 0/1/2/3, buttons use command values 50/100/130/160
  const speedModeMap: Record<number, number> = { 0: 50, 1: 100, 2: 130, 3: 160 };
  const speedMode = speedModeMap[pos?.speed_mode ?? 1] ?? 100;
  document.querySelectorAll('.speed-btn').forEach((btn) => {
    const mode = parseInt((btn as HTMLElement).dataset.mode ?? '100');
    toggleState(btn, 'active', mode === speedMode);
  });
  // The selection here comes from the printer, not from a click, so the fill has to be
  // told to follow it — the speed picker moves on its own when the machine changes mode.
  const speedTrack = document.querySelector('.speed-btn')?.closest<HTMLElement>('.segmented');
  if (speedTrack) positionSegmented(speedTrack);

  // LED toggle
  const ledOn = s.led?.status === 1;
  ($('led-toggle') as HTMLInputElement).checked = ledOn;

  // Camera
  updateCamera(s.external_device?.camera ?? false, client.printerIp);

  // Exception banner
  renderExceptions(machineStatus?.exception_status ?? []);
}

export function renderHeader(state: PrinterState): void {
  const attrs = state.attributes;
  if (attrs) {
    $('printer-name').textContent =
      `${attrs.hostname} (${attrs.machine_model}) — FW ${attrs.software_version?.ota_version}`;
  }
}

let lastExceptionKey = '';

function renderExceptions(codes: number[]): void {
  const banner = $('exception-banner');
  if (!codes.length) {
    banner.classList.add('hidden');
    banner.innerHTML = '';
    lastExceptionKey = '';
    return;
  }

  const key = codes.join(',');
  if (key === lastExceptionKey) return;
  lastExceptionKey = key;

  const items = codes.map((code) => {
    const name = EXCEPTION_NAMES[code] ?? `Unknown Error (${code})`;
    const isCritical = CRITICAL_EXCEPTIONS.has(code);
    const cls = isCritical ? 'exception-item critical' : 'exception-item warning';
    const severityIcon = isCritical ? icon('critical') : icon('warning');
    return `<div class="${cls}">${severityIcon} <strong>${escapeHtml(String(code))}</strong> — ${escapeHtml(name)}</div>`;
  });

  banner.innerHTML = items.join('');
  banner.classList.remove('hidden');
}

/** Render per-spool filament usage summary */
function renderFilamentUsage(state: PrinterState): void {
  const container = document.getElementById('filament-usage-display');
  if (!container) return;
  const usage = state.filamentUsage;
  if (!usage || usage.length === 0) {
    container.innerHTML = '';
    return;
  }
  const totalGrams = usage.reduce((sum, u) => sum + u.grams, 0);
  const totalMeters = usage.reduce((sum, u) => sum + u.meters, 0);
  let html =
    '<div class="text-[11px] text-fg-muted uppercase tracking-[0.5px] [margin-bottom:6px]">Filament Used</div>';
  for (const u of usage) {
    const label = u.trayKey === 'mono' ? u.filamentType : `${u.filamentType}`;
    html += `<div class="flex items-center gap-2 [padding:2px_0] text-[13px] font-mono">
      <span class="w-[10px] h-[10px] rounded-[2px] shrink-0" style="background:${escapeHtml(u.color)}"></span>
      <span class="flex-1 text-fg-soft">${escapeHtml(label)}</span>
      <span class="min-w-15 text-right text-fg">${u.meters.toFixed(3)} m</span>
      <span class="min-w-15 text-right text-fg">${u.grams.toFixed(3)} g</span>
    </div>`;
  }
  if (usage.length > 1) {
    html += `<div class="flex items-center gap-2 [padding:2px_0] text-[13px] font-mono border-t border-line mt-1 pt-1 font-semibold">
      <span class="w-[10px] h-[10px] rounded-[2px] shrink-0"></span>
      <span class="flex-1 text-fg-soft">Total</span>
      <span class="min-w-15 text-right text-fg">${totalMeters.toFixed(3)} m</span>
      <span class="min-w-15 text-right text-fg">${totalGrams.toFixed(3)} g</span>
    </div>`;
  }
  container.innerHTML = html;
}
