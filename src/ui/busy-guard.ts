/**
 * Disabling the controls a busy printer cannot take.
 *
 * The printer has twelve states and only one of them is Idle. Homing, levelling, a PID
 * run, a resonance test, a self-check, a firmware update and a file transfer are all as
 * busy as printing — and until now the jog pad and every maintenance button stayed live
 * through all of them. Pressing one either did nothing, or did something that ruined
 * whatever was in progress; the only feedback was a toast after the fact, and only
 * because ELEG-40 added one.
 *
 * ## Declarative, so the list cannot drift
 *
 * A control that needs an idle machine says so in the markup with `data-requires-idle`,
 * and this disables every one of them together. The alternative — a list of ids in here
 * — is a second place to remember, and the first thing anyone adding a button forgets.
 *
 * ## What is deliberately NOT marked
 *
 * Pause, Resume, Stop and the emergency stop are the controls you reach for *because*
 * the printer is busy; disabling them would be exactly backwards. Temperature, fan,
 * speed and the light are all valid mid-print — tuning a print while it runs is normal.
 * Only motion, maintenance and starting a print need the machine to be doing nothing.
 */

import { STATUS_NAMES } from '../types';

/** The one state in which a printer will accept motion and maintenance. */
const IDLE = 1;

export function isPrinterIdle(status: number | undefined): boolean {
  return status === IDLE;
}

/**
 * The last status the dashboard saw.
 *
 * Cards render on their own schedule — a file listing arrives from `1044`, the Canvas
 * from `2005` — and each replaces its markup wholesale, handing back freshly ENABLED
 * buttons after the guard has already run. Rather than have every renderer thread the
 * status through, they call `reapplyBusyGuard()` and this remembers it.
 */
let lastStatus: number | undefined;

/** Re-apply the last known state, after markup has been replaced. */
export function reapplyBusyGuard(): void {
  applyBusyGuard(lastStatus);
}

/**
 * Apply the current state to every `[data-requires-idle]` control.
 *
 * The title says which state is blocking rather than a generic "printer busy": "Auto
 * Leveling — wait until the printer is idle" tells you how long to expect to wait, and
 * that nothing is wrong.
 */
export function applyBusyGuard(status: number | undefined): void {
  lastStatus = status;
  const idle = isPrinterIdle(status);
  const label = STATUS_NAMES[status ?? -1] ?? 'Busy';

  for (const el of document.querySelectorAll<HTMLElement>('[data-requires-idle]')) {
    const control = el as HTMLButtonElement;
    // Remember the real title once, so restoring it does not hand back the explanation.
    if (control.dataset.idleTitle === undefined) {
      control.dataset.idleTitle = control.title ?? '';
    }
    control.disabled = !idle;
    control.title = idle ? control.dataset.idleTitle : `${label} — wait until the printer is idle`;
    // A disabled button is not focusable and announces itself, so `aria-disabled` would
    // be redundant. What is not automatic is the reason, which the title carries.
  }
}
