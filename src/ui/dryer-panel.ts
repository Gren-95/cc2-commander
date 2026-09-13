/**
 * Filament dryer — the panel, and the only place that drives the heater.
 *
 * The maths, the presets and the safety clamps are in `dryer.ts`; this file is the DOM,
 * the timer tick and the two commands (heat on, heat off). Read that file first — the
 * reasoning about why this is riskier than the rest of the UI lives there.
 *
 * ## The three rules this panel enforces
 *
 * 1. **Never while printing.** A drying session sets the bed to a fixed temperature for
 *    hours. Doing that under a running print ruins the print, so starting is refused
 *    outright rather than warned about.
 * 2. **Confirm before heating.** Every other control in this app acts on something the
 *    user is already looking at. This one walks away and leaves a heater on, so it asks.
 * 3. **Always able to stop.** The session is persisted with an absolute start time, so a
 *    tab reopened hours later resolves it, turns the bed off if it has finished, and
 *    says so. Closing the tab mid-session is the one case nothing can cover — the panel
 *    says that in as many words rather than pretending otherwise.
 */

import type { CommandSender } from '../ws-client';
import { playAlert } from './alert-sound';
import {
  DRYING_PRESETS,
  type DryerSession,
  finishesAt,
  formatDuration,
  MAX_SAFE_C,
  MIN_USEFUL_C,
  normaliseSession,
  presetById,
  progressOf,
  sessionFromPreset,
} from '../dryer-core';
import { escapeHtml, fetchTimeout } from './helpers';
import { icon } from './icons';
import { toast } from './toast';

let client: CommandSender | null = null;
let printing = false;
let ticker: ReturnType<typeof setInterval> | null = null;
/**
 * What the printer last reported, or nulls before the first status arrives.
 *
 * The panel used to show only a countdown, which said nothing about whether the bed was
 * actually hot — the one fact that decides whether the filament is drying at all. The
 * keepalive needs `bedTarget` anyway to tell a correction from a no-op, so the rest
 * comes along at no cost and is worth showing.
 */
export interface DryerTemps {
  bed: number | null;
  bedTarget: number | null;
  chamber: number | null;
  nozzle: number | null;
}

let temps: DryerTemps = { bed: null, bedTarget: null, chamber: null, nozzle: null };
/** Set when a keepalive found the target had been cleared, for the running view. */
let lastCorrectionAt: number | null = null;

/** Fed from `print-status.ts` on every status render, like `setDryerPrinting`. */
export function setDryerTemps(next: DryerTemps): void {
  temps = next;
}

export function setDryerClient(c: CommandSender): void {
  client = c;
  // Called on every connect, so this also re-syncs after a dropped WebSocket: the
  // service may have started, finished or corrected a session while this page was away.
  void refreshFromService();
}

/** Told by the dashboard render so the panel can refuse to start mid-print. */
export function setDryerPrinting(value: boolean): void {
  printing = value;
  const btn = document.getElementById('dryer-start') as HTMLButtonElement | null;
  if (btn) btn.disabled = printing;
  const warn = document.getElementById('dryer-printing-warning');
  if (warn) warn.classList.toggle('hidden', !printing);
}

/**
 * The session the SERVICE is running, mirrored here.
 *
 * It used to live in this tab's localStorage with a `setInterval` beside it, which meant
 * a heater owned by whichever page happened to be open. `server/dryer.ts` owns it now;
 * this is a cache of what the last `/api/dryer` or `dryer_state` frame said, so the
 * panel can render without asking again on every tick.
 */
let session: DryerSession | null = null;

/** Take a state frame from the service — a WS broadcast, or a REST reply. */
export function applyDryerState(state: {
  session?: unknown;
  bedTarget?: number | null;
  lastCorrectionAt?: number | null;
}): void {
  session = normaliseSession(state.session);
  if (state.lastCorrectionAt !== undefined) lastCorrectionAt = state.lastCorrectionAt;
  if (state.bedTarget !== undefined) temps = { ...temps, bedTarget: state.bedTarget ?? null };
  renderDryer();
}

async function refreshFromService(): Promise<void> {
  try {
    const res = await fetchTimeout('/api/dryer');
    if (!res.ok) return;
    const body = (await res.json()) as { data?: { session?: unknown } };
    if (body.data) applyDryerState(body.data);
  } catch {
    // Offline. The panel keeps showing the last frame it had, which is the honest
    // answer — the service is still running the session either way.
  }
}

/* ── Rendering ──────────────────────────────────────────────────────── */

function presetOptions(selected: string): string {
  return DRYING_PRESETS.map(
    (p) =>
      `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${escapeHtml(
        `${p.label} — ${p.tempC}°C for ${formatDuration(p.minutes)}`,
      )}</option>`,
  ).join('');
}

function idleView(): string {
  const first = DRYING_PRESETS[0];
  return `
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-1">
        <label for="dryer-preset" class="text-[11px] uppercase tracking-[0.5px] text-fg-muted">Filament</label>
        <select id="dryer-preset" class="bg-input border border-line rounded-chip text-fg [padding:8px_10px] text-[13px]">
          ${presetOptions(first.id)}
        </select>
        <p id="dryer-note" class="text-[12px] text-fg-muted"></p>
      </div>

      <div class="flex flex-wrap gap-4">
        <div class="flex flex-col gap-1">
          <label for="dryer-temp" class="text-[11px] uppercase tracking-[0.5px] text-fg-muted">Bed temperature</label>
          <div class="flex items-center gap-2">
            <input id="dryer-temp" type="number" min="${MIN_USEFUL_C}" max="${MAX_SAFE_C}" step="1"
              class="w-24 bg-input border border-line rounded-chip text-fg [padding:8px_10px] text-[13px]">
            <span class="text-fg-muted text-[13px]">°C</span>
          </div>
        </div>
        <div class="flex flex-col gap-1">
          <label for="dryer-hours" class="text-[11px] uppercase tracking-[0.5px] text-fg-muted">Duration</label>
          <div class="flex items-center gap-2">
            <input id="dryer-hours" type="number" min="0.5" max="24" step="0.5"
              class="w-24 bg-input border border-line rounded-chip text-fg [padding:8px_10px] text-[13px]">
            <span class="text-fg-muted text-[13px]">hours</span>
          </div>
        </div>
        <div class="flex flex-col gap-1">
          <label for="dryer-rotate" class="text-[11px] uppercase tracking-[0.5px] text-fg-muted">Rotate reminder</label>
          <select id="dryer-rotate" class="bg-input border border-line rounded-chip text-fg [padding:8px_10px] text-[13px]">
            <option value="30">Every 30 min</option>
            <option value="60" selected>Every hour</option>
            <option value="120">Every 2 hours</option>
            <option value="0">Off</option>
          </select>
        </div>
      </div>

      <p id="dryer-spool-warning" class="hidden text-[12px] text-warn">
        ${icon('warning')} Above 55 °C a plastic spool can soften. Use a cardboard or
        polycarbonate spool, and do not stack anything on it.
      </p>

      <p id="dryer-printing-warning" class="hidden text-[12px] text-bad">
        ${icon('warning')} A print is running. Drying holds the bed at a fixed
        temperature for hours and would ruin it.
      </p>

      <div class="flex items-center gap-3">
        <button id="dryer-start" class="[padding:8px_16px] rounded-chip bg-accent text-white font-semibold cursor-pointer border border-accent">
          ${icon('heat')} Start drying
        </button>
        <span class="text-[12px] text-fg-muted">Heats the printer's bed — the lid should be closed.</span>
      </div>
    </div>`;
}

/**
 * The live temperatures, with the plate first and stated against its target.
 *
 * "3h 37m left" is not evidence that anything is drying — the bed can be cold, off, or
 * still climbing, and the countdown reads identically in all three cases. The plate row
 * therefore carries a *state* rather than only a number, and the one state worth
 * shouting about is a target of 0 while a session runs: that is the failure the
 * keepalive exists to undo, visible in the ~30s before it does.
 */
function tempsView(session: DryerSession): string {
  const cell = (label: string, value: string, extra = '') =>
    `<div class="flex flex-col gap-0.5">
       <span class="text-[11px] text-fg-muted">${label}</span>
       <span class="font-mono text-[15px] text-fg">${value}</span>
       ${extra}
     </div>`;

  const deg = (v: number | null) => (v === null ? '––' : `${v.toFixed(1)} °C`);

  let plateState = '';
  if (temps.bed !== null && temps.bedTarget !== null) {
    if (Math.round(temps.bedTarget) === 0) {
      plateState = `<span class="text-[11px] font-semibold text-bad">heater off — restoring</span>`;
    } else if (Math.abs(temps.bed - temps.bedTarget) <= 2) {
      plateState = `<span class="text-[11px] font-semibold text-ok">at temperature</span>`;
    } else if (temps.bed < temps.bedTarget) {
      plateState = `<span class="text-[11px] text-warn">heating</span>`;
    } else {
      plateState = `<span class="text-[11px] text-fg-muted">cooling</span>`;
    }
  }

  const plateValue =
    temps.bedTarget === null
      ? deg(temps.bed)
      : `${deg(temps.bed)} <span class="text-[12px] text-fg-muted">of ${Math.round(
          temps.bedTarget,
        )} °C</span>`;

  return `
      <div class="flex flex-wrap gap-6 [padding:10px_12px] rounded-chip bg-input">
        ${cell(`Plate — drying at ${session.tempC} °C`, plateValue, plateState)}
        ${cell('Chamber', deg(temps.chamber))}
        ${cell('Nozzle', deg(temps.nozzle))}
      </div>`;
}

function runningView(session: DryerSession, now: number): string {
  const p = progressOf(session, now);
  const pct = Math.round(p.fraction * 100);
  const finish = finishesAt(session);
  return `
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-baseline gap-3">
        <span class="text-[22px] font-bold font-mono text-fg">${formatDuration(p.remainingMin)}</span>
        <span class="text-[13px] text-fg-muted">left of ${escapeHtml(session.label)} at ${session.tempC} °C</span>
      </div>

      <div class="h-2 w-full bg-input rounded-[3px] overflow-hidden">
        <div class="h-full bg-accent rounded-[3px] [transition:width_1s_linear]" style="width:${pct}%"></div>
      </div>

      <div class="flex flex-wrap gap-6 text-[13px]">
        <div><span class="text-fg-muted">Finishes</span> <span class="font-mono">${escapeHtml(
          finish.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        )}</span></div>
        <div><span class="text-fg-muted">Elapsed</span> <span class="font-mono">${formatDuration(p.elapsedMin)}</span></div>
        <div><span class="text-fg-muted">Rotations</span> <span class="font-mono">${session.rotationsDone}</span></div>
        ${
          p.nextRotationInMin !== null
            ? `<div><span class="text-fg-muted">Next rotation</span> <span class="font-mono">${formatDuration(
                p.nextRotationInMin,
              )}</span></div>`
            : ''
        }
      </div>

      ${tempsView(session)}

      ${
        p.rotationsDue > 0
          ? `<div id="dryer-rotate-due" class="flex items-center gap-3 [padding:10px_12px] rounded-chip bg-warn-dim border border-warn">
               <span class="text-[13px] text-warn font-semibold">${icon('refresh')} Rotate the spool a half turn</span>
               <button id="dryer-rotated" class="[padding:6px_12px] rounded-chip bg-warn text-white text-[12px] font-semibold cursor-pointer border-0">Done</button>
             </div>`
          : ''
      }

      <div class="flex items-center gap-3">
        <button id="dryer-stop" class="[padding:8px_16px] rounded-chip bg-bad text-white font-semibold cursor-pointer border border-bad">
          ${icon('stop')} Stop and cool down
        </button>
      </div>

      <div class="[padding:10px_12px] rounded-chip bg-warn-dim border border-warn flex flex-col gap-1.5 text-[12px] text-warn">
        <span class="font-semibold">${icon('warning')} The service re-sends the bed target every 30 seconds</span>
        <span class="text-fg-soft">
          Turning the bed off from the dashboard, the printer screen or another app will
          not stop drying — it comes back on within 30 seconds. Use
          <strong>Stop and cool down</strong> above.
        </span>
        <span class="text-fg-soft">
          The service is running this, not this page. It keeps going with the browser
          closed, resumes after a restart, and turns the bed off when the timer ends.
        </span>
        ${
          client === null
            ? '<span class="text-bad font-semibold">This page is not connected to the service — the countdown above may be stale. The session itself is unaffected.</span>'
            : ''
        }
        ${
          lastCorrectionAt !== null
            ? `<span class="text-fg-soft">Last correction ${escapeHtml(
                new Date(lastCorrectionAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              )} — something had cleared the target and it was put back.</span>`
            : ''
        }
      </div>
    </div>`;
}

/* ── Wiring ─────────────────────────────────────────────────────────── */

function syncPresetFields(): void {
  const sel = document.getElementById('dryer-preset') as HTMLSelectElement | null;
  const temp = document.getElementById('dryer-temp') as HTMLInputElement | null;
  const hours = document.getElementById('dryer-hours') as HTMLInputElement | null;
  const note = document.getElementById('dryer-note');
  const warn = document.getElementById('dryer-spool-warning');
  if (!sel || !temp || !hours) return;
  const preset = presetById(sel.value) ?? DRYING_PRESETS[0];
  temp.value = String(preset.tempC);
  hours.value = String(preset.minutes / 60);
  if (note) note.textContent = preset.note;
  warn?.classList.toggle('hidden', !preset.spoolWarning);
}

function bindIdle(): void {
  const sel = document.getElementById('dryer-preset') as HTMLSelectElement | null;
  sel?.addEventListener('change', syncPresetFields);
  syncPresetFields();
  setDryerPrinting(printing);

  // Typing a temperature above the guidance re-raises the spool warning, since the
  // preset's own flag no longer describes what is about to happen.
  const temp = document.getElementById('dryer-temp') as HTMLInputElement | null;
  temp?.addEventListener('input', () => {
    const warn = document.getElementById('dryer-spool-warning');
    warn?.classList.toggle('hidden', Number(temp.value) < 55);
  });

  document.getElementById('dryer-start')?.addEventListener('click', () => {
    if (printing) {
      toast('Cannot dry while a print is running', 'error');
      return;
    }
    const preset = presetById(sel?.value ?? '') ?? DRYING_PRESETS[0];
    const tempInput = document.getElementById('dryer-temp') as HTMLInputElement | null;
    const hoursInput = document.getElementById('dryer-hours') as HTMLInputElement | null;
    const rotateInput = document.getElementById('dryer-rotate') as HTMLSelectElement | null;

    // Built through `sessionFromPreset` so the clamps apply to typed values too.
    const session = sessionFromPreset(
      {
        ...preset,
        tempC: Number(tempInput?.value ?? preset.tempC),
        minutes: Math.round(Number(hoursInput?.value ?? preset.minutes / 60) * 60),
      },
      Date.now(),
      Number(rotateInput?.value ?? 60),
    );

    // This walks away and leaves a heater on. Ask.
    if (
      !confirm(
        `Heat the bed to ${session.tempC} °C for ${formatDuration(session.totalMinutes)}?\n\n` +
          'The SERVICE runs this, not this page — it keeps going with the browser closed ' +
          'and resumes after a restart, and it turns the bed off when the timer ends.\n\n' +
          'It re-sends the target every 30 seconds, so turning the bed off from the ' +
          'dashboard, the printer screen or another app will NOT stop drying. Use ' +
          '"Stop and cool down".\n\n' +
          'Close the lid, and do not leave anything on the bed.',
      )
    ) {
      return;
    }

    void startOnService(session);
  });
}

/** Ask the service to begin. It owns the clamping, the timer and the heater. */
async function startOnService(draft: DryerSession): Promise<void> {
  try {
    const res = await fetchTimeout('/api/dryer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        presetId: draft.presetId,
        tempC: draft.tempC,
        hours: draft.totalMinutes / 60,
      }),
    });
    const body = (await res.json()) as { data?: unknown; error?: { message?: string } };
    if (!res.ok) {
      toast(body.error?.message ?? 'Could not start drying', 'error');
      return;
    }
    applyDryerState((body.data ?? {}) as Record<string, unknown>);
    toast(`Drying ${draft.label} at ${draft.tempC} °C`, 'success');
  } catch {
    toast('Not connected to the service', 'error');
  }
}

/** Ask the service to stop. It sends the off command; this page only asks. */
async function stopOnService(): Promise<void> {
  try {
    const res = await fetchTimeout('/api/dryer', { method: 'DELETE' });
    const body = (await res.json()) as { data?: unknown };
    applyDryerState((body.data ?? {}) as Record<string, unknown>);
    toast('Drying stopped — bed turned off', 'info');
  } catch {
    toast('Not connected to the service', 'error');
  }
}

function bindRunning(current: DryerSession): void {
  document.getElementById('dryer-rotated')?.addEventListener('click', () => {
    // Acknowledged locally. The rotation count is a note to the person in the room, not
    // something the heater depends on, so it does not need a round trip to the service.
    const p = progressOf(current, Date.now());
    session = { ...current, rotationsDone: current.rotationsDone + p.rotationsDue };
    lastRotationsAnnounced = -1;
    renderDryer();
  });

  document.getElementById('dryer-stop')?.addEventListener('click', () => {
    void stopOnService();
  });
}

/**
 * The service says a session ended.
 *
 * Announcing only — the bed was turned off by `server/dryer.ts` before this frame was
 * sent. A page that also sent an off command here would be a second writer to a heater,
 * which is the arrangement this whole change exists to remove.
 */
export function handleDryerFinished(reason: string, label: string): void {
  session = null;
  lastCorrectionAt = null;
  if (reason === 'done') {
    toast(`${label} is dry — bed turned off`, 'success');
    void playAlert('success');
  } else if (reason === 'expired-while-down') {
    toast('Drying finished while the service was down — bed turned off', 'info');
  } else if (reason === 'print-started') {
    toast('A print started — drying stopped and the bed is cooling', 'warning');
  }
  renderDryer();
}

let lastRotationsAnnounced = -1;

/**
 * One tick: redraw the countdown and fire rotation reminders.
 *
 * It no longer decides anything. Expiry, the keepalive and the off command all belong to
 * the service; if this page is closed they still happen. What is left is the second hand
 * on a clock someone else is keeping.
 */
function tick(): void {
  const host = document.getElementById('dryer-content');
  if (!host || !session) return;

  const p = progressOf(session, Date.now());

  // Announce a rotation once per newly-earned reminder, not once per second. This one
  // stays client-side on purpose: it is a nudge to the person in the room, and a service
  // that has no idea whether anyone is there should not be the thing deciding to nag.
  if (p.rotationsDue > 0 && p.rotationsDue !== lastRotationsAnnounced) {
    lastRotationsAnnounced = p.rotationsDue;
    toast('Rotate the spool a half turn', 'warning');
    void playAlert('success');
  }
  if (p.rotationsDue === 0) lastRotationsAnnounced = -1;

  renderDryer();
}

/**
 * Draw the panel.
 *
 * Called on tab open and once a second while a session runs. Cheap: one innerHTML of a
 * form or a countdown.
 */
export function renderDryer(): void {
  const host = document.getElementById('dryer-content');
  if (!host) return;

  // No expiry check here any more. A session that has run out is the service's problem,
  // and it has already turned the bed off by the time this page hears about it — the
  // page used to do that itself, which only worked if someone had it open.

  /*
   * A dot on the Tools sub-tab while a session runs, so the timer is visible from the
   * spool calculator — the whole point of sub-tabs is that only one is on screen, and a
   * running heater should not be the thing you have to remember to go and check.
   */
  document.getElementById('dryer-running-dot')?.classList.toggle('hidden', !session);

  host.innerHTML = session ? runningView(session, Date.now()) : idleView();
  if (session) bindRunning(session);
  else bindIdle();

  // Tick only while something is running.
  if (session && !ticker) ticker = setInterval(tick, 1000);
  if (!session && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}
