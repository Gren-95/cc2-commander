/**
 * A small static isometric cube for the Control card — a 3D representation of the
 * machine's axes, drawn once beside the X/Y/Z coordinate readouts in index.html.
 *
 * Deliberately not live: an earlier version tracked the toolhead's actual position with
 * a moving dot inside the box, which was more than this card needs — the numbers next
 * to the cube already say where the toolhead is, live, and a dot chasing them added
 * motion to track without adding anything the numbers didn't. What stayed is the part
 * that actually answers "the numbers are 3D how" — the wireframe box and its axis
 * labels, giving the flat X/Y/Z figures a visual home.
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
 * isoY the box produces.
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
  // Solid, not dashed, and fg-muted rather than the card-border line color: a dashed
  // border-colored line reads as decoration you're not meant to look at closely — which
  // is right for a card outline, wrong for the one thing this SVG exists to draw.
  return `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" class="stroke-fg-muted" stroke-width="1.5" stroke-linecap="round" />`;
}

function label(p: Point, text: string): string {
  return `<text x="${p[0].toFixed(1)}" y="${p[1].toFixed(1)}" class="fill-fg-muted font-mono text-[9px]" text-anchor="middle">${text}</text>`;
}

let built = false;

/** Draw the wireframe cube once. Safe to call more than once; purely decorative. */
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

  svg.innerHTML = `${bed}${wireframe}${labels}`;
}
