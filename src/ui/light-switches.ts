/**
 * The overhead light has two switches, on the Fans & light card, and on the camera (you
 * want the light on when you are looking at the print). There used to be a third in the
 * Control card; one light in three places was one too many.
 *
 * They are two views of one light, so they must never disagree. That is why this lives
 * in one place: whichever is used mirrors its choice onto the others at once, and the
 * printer's own report of the light redraws all three (`showLight`). Nothing else keeps
 * a copy of the state.
 */

import { $ } from './helpers';

export const LIGHT_SWITCH_IDS = ['led-toggle-fans', 'led-toggle-camera'] as const;

const switches = (): HTMLInputElement[] => LIGHT_SWITCH_IDS.map((id) => $(id) as HTMLInputElement);

/** Draw the light as on or off on every switch. */
export function showLight(on: boolean): void {
  for (const box of switches()) box.checked = on;
}

/**
 * Call `send` when any switch is used, after mirroring its choice onto the rest.
 *
 * `send` is handed every switch, so the caller can hold them all while the command is in
 * flight: otherwise a second switch could be flipped against the first before the printer
 * has answered.
 */
export function bindLightSwitches(send: (on: boolean, boxes: HTMLInputElement[]) => void): void {
  const boxes = switches();
  for (const box of boxes) {
    box.addEventListener('change', () => {
      showLight(box.checked);
      send(box.checked, boxes);
    });
  }
}
