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
} from './dryer';
import { escapeHtml } from './helpers';
import { icon } from './icons';
import { toast } from './toast';
import { loadUISettings, saveUISettings } from './ui-settings';

/** Bed heater. 1028 is `Set temperature`; `heater_bed: 0` turns it off. */
const SET_TEMPERATURE = 1028;

let client: CommandSender | null = null;
let printing = false;
let ticker: ReturnType<typeof setInterval> | null = null;

export function setDryerClient(c: CommandSender): void {
  client = c;
}

/** Told by the dashboard render so the panel can refuse to start mid-print. */
export function setDryerPrinting(value: boolean): void {
  printing = value;
  const btn = document.getElementById('dryer-start') as HTMLButtonElement | null;
  if (btn) btn.disabled = printing;
  const warn = document.getElementById('dryer-printing-warning');
  if (warn) warn.classList.toggle('hidden', !printing);
}

function loadSession(): DryerSession | null {
  return normaliseSession(loadUISettings().dryer);
}

function storeSession(session: DryerSession | null): void {
  saveUISettings({ dryer: session });
}

function setBed(tempC: number): void {
  if (!client) {
    toast('Not connected to the printer', 'error');
    return;
  }
  client.sendCommand(SET_TEMPERATURE, { heater_bed: tempC });
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
        <span class="text-[12px] text-fg-muted">
          The timer runs in this tab. Closing it leaves the bed hot — stop the session
          instead, or turn the bed off from the dashboard.
        </span>
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
          'The printer will hold this temperature until the timer ends or you stop it. ' +
          'Close the lid, and do not leave anything on the bed.',
      )
    ) {
      return;
    }

    storeSession(session);
    setBed(session.tempC);
    toast(`Drying ${session.label} at ${session.tempC} °C`, 'success');
    renderDryer();
  });
}

function bindRunning(session: DryerSession): void {
  document.getElementById('dryer-rotated')?.addEventListener('click', () => {
    const p = progressOf(session, Date.now());
    storeSession({ ...session, rotationsDone: session.rotationsDone + p.rotationsDue });
    renderDryer();
  });

  document.getElementById('dryer-stop')?.addEventListener('click', () => {
    finish(session, 'stopped');
  });
}

/** End a session and always turn the bed off, whichever way it ended. */
function finish(session: DryerSession, why: 'stopped' | 'done' | 'resumed-expired'): void {
  storeSession(null);
  setBed(0);
  if (why === 'done') {
    toast(`${session.label} is dry — bed turned off`, 'success');
    void playAlert('success');
  } else if (why === 'resumed-expired') {
    toast(`Drying finished while you were away — bed turned off`, 'info');
  } else {
    toast('Drying stopped — bed turned off', 'info');
  }
  renderDryer();
}

let lastRotationsAnnounced = -1;

/** One tick: redraw the countdown, fire reminders, finish when the time is up. */
function tick(): void {
  const host = document.getElementById('dryer-content');
  if (!host) return;
  const session = loadSession();
  if (!session) return;

  const p = progressOf(session, Date.now());
  if (p.done) {
    finish(session, 'done');
    return;
  }

  // Announce a rotation once per newly-earned reminder, not once per second.
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

  const session = loadSession();

  if (session && progressOf(session, Date.now()).done) {
    // The tab was closed when the timer ran out. Shut the bed off now.
    finish(session, 'resumed-expired');
    return;
  }

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
