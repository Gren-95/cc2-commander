/**
 * The sliding fill behind a segmented picker.
 *
 * A segmented control is one track with N positions, and the fill is a single element
 * that moves to whichever is selected. Everything about how it looks is in `design.ts`
 * (`SEGMENTED`, `SEGMENTED_BTN`, `SEGMENTED_FILL`); this file only answers *where*.
 *
 * ## Why measure instead of using equal columns
 *
 * `grid-cols-4` plus a fill of `width: 25%` is simpler and wrong here: "0.1mm" and
 * "Ludicrous" are not the same width, and forcing them to be either pads the short
 * labels into a very wide control or truncates the long ones. Measuring the selected
 * button lets each label take the room it needs.
 *
 * ## Why a ResizeObserver rather than a resize listener
 *
 * The card these live in is resizable (dashboard edit mode) and its width now changes
 * with a container query rather than the viewport, so `window.resize` misses the case
 * that matters: the *card* got narrower, the labels rewrapped, and the fill is now
 * sitting under the wrong one. The observer watches the track itself, which covers the
 * viewport changing, the card being resized, and the font loading late.
 */

/** Put the fill under the selected button, or hide it when there is no selection. */
export function positionSegmented(track: HTMLElement): void {
  const fill = track.querySelector<HTMLElement>('.segmented-fill');
  if (!fill) return;

  const selected = track.querySelector<HTMLElement>('.segmented-btn.active');
  if (!selected) {
    // No selection is a real state: the speed picker has none until the printer says
    // which mode it is in. A fill parked at position 0 would be a confident lie.
    fill.style.opacity = '0';
    return;
  }

  fill.style.opacity = '1';
  fill.style.width = `${selected.offsetWidth}px`;
  fill.style.transform = `translateX(${selected.offsetLeft}px)`;
}

/** Every segmented picker on the page, repositioned. */
export function positionAllSegmented(): void {
  for (const track of document.querySelectorAll<HTMLElement>('.segmented')) {
    positionSegmented(track);
  }
}

/**
 * Start watching every segmented picker.
 *
 * The first paint is deliberately deferred by one frame: at `DOMContentLoaded` the icon
 * webfont has usually not swapped in, so a label measured now is a few pixels narrower
 * than the one on screen a moment later, and the fill ends up short. The observer fires
 * again when that swap reflows the track, so this is belt and braces rather than the
 * only correction, but it stops the first render being visibly wrong.
 */
export function initSegmented(): void {
  const tracks = [...document.querySelectorAll<HTMLElement>('.segmented')];
  if (!tracks.length) return;

  const observer = new ResizeObserver(() => {
    for (const track of tracks) positionSegmented(track);
  });
  for (const track of tracks) observer.observe(track);

  requestAnimationFrame(() => {
    for (const track of tracks) positionSegmented(track);
  });
}
