/**
 * A small isometric position indicator for the Control card.
 *
 * Three flat numbers said "the toolhead is somewhere" without ever showing where — in
 * the one card on this dashboard that represents a genuine 3D machine. This draws the
 * build volume as a wireframe box and marks the toolhead's actual X/Y/Z inside it. A
 * dashed line drops the dot straight to its footprint on the bed, the way an
 * engineering drawing carries a point's height, so Z reads as clearly as X and Y do.
 *
 * Plain SVG and a hand-rolled isometric projection, not the WebGL preview: this card is
 * not the place to pay for a second GPU context and an orbit-controlled camera just to
 * place one dot. The cube's 8 corners and the dot are projected with the exact same
 * function, so nothing can render the dot outside the box it is supposed to sit in.
 */

import { $ } from './helpers';

/** Same volume the gcode preview builds its scene against (src/ui/gcode-preview.ts). */
const BUILD = { x: 256, y: 256, z: 256 };

const COS30 = Math.cos(Math.PI / 6);
const SIN30 = Math.sin(Math.PI / 6);
/*
 * Chosen so every corner of the cube, PLUS the axis labels a little beyond it, lands
 * inside the "0 0 150 130" viewBox (index.html) with room to spare. The far corner —
 * max X and max Y at Z=0 — is the one that actually decides this: it is the largest
 * isoY the box produces, and it clipped past the bottom of an earlier, taller viewBox
 * before these numbers were picked.
 */
const SCALE_XY = 40;
const SCALE_Z = 44;
const ORIGIN_X = 75;
const ORIGIN_Y = 78;

type Point = [number, number];

/** Project a machine-space coordinate to the SVG's 2D isometric plane. */
function project(x: number, y: number, z: number): Point {
  const nx = x / BUILD.x;
  const ny = y / BUILD.y;
  const nz = z / BUILD.z;
  const isoX = (nx - ny) * COS30 * SCALE_XY;
  const isoY = (nx + ny) * SIN30 * SCALE_XY - nz * SCALE_Z;
  return [ORIGIN_X + isoX, ORIGIN_Y + isoY];
}

function pt([x, y]: Point): string {
  return `${x.toFixed(1)},${y.toFixed(1)}`;
}

function edge(a: Point, b: Point): string {
  return `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" class="stroke-line" stroke-width="1" stroke-dasharray="2.5 2.5" />`;
}

function label(p: Point, text: string): string {
  return `<text x="${p[0].toFixed(1)}" y="${p[1].toFixed(1)}" class="fill-fg-muted font-mono text-[9px]" text-anchor="middle">${text}</text>`;
}

let built = false;

/** Build the static wireframe once. Safe to call more than once. */
export function initPosition3D(): void {
  if (built) return;
  const svg = $('position-3d') as unknown as SVGSVGElement | null;
  if (!svg) return;
  built = true;

  const b000 = project(0, 0, 0);
  const b100 = project(BUILD.x, 0, 0);
  const b010 = project(0, BUILD.y, 0);
  const b110 = project(BUILD.x, BUILD.y, 0);
  const t000 = project(0, 0, BUILD.z);
  const t100 = project(BUILD.x, 0, BUILD.z);
  const t010 = project(0, BUILD.y, BUILD.z);
  const t110 = project(BUILD.x, BUILD.y, BUILD.z);

  const bed = `<polygon points="${[b000, b100, b110, b010].map(pt).join(' ')}" class="fill-bed/10 stroke-bed" stroke-width="1.25" />`;

  const wireframe = [
    edge(b000, t000),
    edge(b100, t100),
    edge(b010, t010),
    edge(b110, t110),
    edge(t000, t100),
    edge(t100, t110),
    edge(t110, t010),
    edge(t010, t000),
  ].join('');

  const labels = [
    label(project(BUILD.x + 36, 0, 0), 'X'),
    label(project(0, BUILD.y + 36, 0), 'Y'),
    label(project(0, 0, BUILD.z + 22), 'Z'),
  ].join('');

  // The origin corner (b000), not raw SVG (0,0) — otherwise the dot sits off in the
  // corner of the viewBox until the first real position arrives, rather than at a
  // point that is actually inside the box it is drawn in.
  const [ox, oy] = b000.map((n) => n.toFixed(1));

  svg.innerHTML = `
    ${bed}
    ${wireframe}
    ${labels}
    <line id="position-3d-drop" class="stroke-nozzle" stroke-width="1.25" stroke-dasharray="2 2" x1="${ox}" y1="${oy}" x2="${ox}" y2="${oy}" />
    <circle id="position-3d-shadow" class="fill-none stroke-nozzle" stroke-width="1.25" r="3" cx="${ox}" cy="${oy}" />
    <circle id="position-3d-dot" class="fill-nozzle" r="4" cx="${ox}" cy="${oy}" />
  `;
}

/**
 * Move the toolhead marker. Coordinates are clamped into the build volume for display —
 * a value that has not homed yet can be well outside it, and drawing the dot flying off
 * the wireframe would read as a bug rather than as "not homed" (the home dots already
 * say that).
 */
export function updatePosition3D(
  x: number | undefined,
  y: number | undefined,
  z: number | undefined,
): void {
  if (!built) return;
  const cx = Math.min(Math.max(x ?? 0, 0), BUILD.x);
  const cy = Math.min(Math.max(y ?? 0, 0), BUILD.y);
  const cz = Math.min(Math.max(z ?? 0, 0), BUILD.z);

  const [dx, dy] = project(cx, cy, cz);
  const [fx, fy] = project(cx, cy, 0);

  const dot = document.getElementById('position-3d-dot');
  const shadow = document.getElementById('position-3d-shadow');
  const drop = document.getElementById('position-3d-drop');
  dot?.setAttribute('cx', dx.toFixed(1));
  dot?.setAttribute('cy', dy.toFixed(1));
  shadow?.setAttribute('cx', fx.toFixed(1));
  shadow?.setAttribute('cy', fy.toFixed(1));
  if (drop) {
    drop.setAttribute('x1', dx.toFixed(1));
    drop.setAttribute('y1', dy.toFixed(1));
    drop.setAttribute('x2', fx.toFixed(1));
    drop.setAttribute('y2', fy.toFixed(1));
  }
}
