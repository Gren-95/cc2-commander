/**
 * The dashboard's cards, as `index.html` actually has them.
 *
 * `card-layout.ts` says which cards exist; `index.html` is what draws them, and nothing
 * else ties the two together. A card in one and not the other renders as a blank rail
 * button or a phantom entry in the settings list — and merging the camera into the print
 * card is exactly the kind of change that leaves one of them behind. Read as text: this
 * runner has no DOM, and ids and their order are all that is being asked.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_CARD_IDS } from '../ui/card-layout';

const html = readFileSync(join(import.meta.dir, '../../index.html'), 'utf8');

const idAt = (id: string) => html.indexOf(`id="${id}"`);
const count = (id: string) => html.split(`id="${id}"`).length - 1;

describe('every card the layout knows', () => {
  it.each(ALL_CARD_IDS)('%s is in the markup, once', (id) => {
    expect(count(id), `${id} should appear as an element id exactly once`).toBe(1);
  });

  it('has no element for a card that was folded away', () => {
    expect(count('camera-card')).toBe(0);
  });
});

describe('the camera, inside the print card', () => {
  // Each of these is looked up by id by the camera code, so all must exist, once, and
  // inside the card that is now their home.
  const CAMERA_PARTS = [
    'camera-wrap',
    'camera-feed',
    'camera-overlay',
    'camera-overlay-text',
    'camera-overlay-btn',
    'camera-snapshot-btn',
    'camera-expand-btn',
  ];

  // The print card runs from its own opening tag to the next card's. Its `class` sits in
  // the same tag as its `id`, so the search starts after that tag closes.
  const start = idAt('print-status-bar');
  const nextCard = html.indexOf('class="card @container', html.indexOf('>', start));

  it('finds the print card, and a card after it', () => {
    expect(start).toBeGreaterThan(0);
    expect(nextCard).toBeGreaterThan(start);
  });

  it.each(CAMERA_PARTS)('%s is inside it, once', (id) => {
    expect(count(id), `${id} should appear exactly once`).toBe(1);
    expect(idAt(id)).toBeGreaterThan(start);
    expect(idAt(id)).toBeLessThan(nextCard);
  });

  it('keeps the print controls in the same card', () => {
    for (const id of ['btn-pause', 'btn-resume', 'btn-stop', 'btn-estop', 'print-progress-bar']) {
      expect(idAt(id)).toBeGreaterThan(start);
      expect(idAt(id)).toBeLessThan(nextCard);
    }
  });
});
