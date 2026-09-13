/** Gcode preview — 3D toolpath visualization using gcode-preview library */

import { toggleState } from './state-classes';
import { WebGLPreview } from 'gcode-preview';
import {
  ConeGeometry,
  MeshBasicMaterial,
  Mesh,
  EdgesGeometry,
  LineSegments,
  LineBasicMaterial,
  Group,
} from 'three';
import type { Object3D } from 'three';
import type { PrinterState } from '../printer-state';
import { $, fetchTimeout } from './helpers';
import { chartPalette } from './chart-palette';
import { positionSegmented } from './segmented';
import { onThemeChange } from './theme';

/** Internal fields of WebGLPreview we need to access to stop the animate loop */
interface WebGLPreviewInternals {
  animationFrameId?: number;
  animate: () => void;
}

let preview: WebGLPreview | null = null;
let loadedFile = '';
let loading = false;
let lastEndLayer = -1;
let followMode = localStorage.getItem('gcode-follow') !== 'false';
/*
 * Stacked unless explicitly asked otherwise.
 *
 * This read `!== 'false'`, so an absent key meant single-layer ON — the opposite of what
 * the card actually rendered, and the opposite of what anyone wants on first open: a
 * preview exists to show the model, and one slice of a benchy is not a benchy. Anyone
 * who turned it on has `'true'` stored and keeps it.
 */
let singleLayerMode = localStorage.getItem('gcode-single-layer') === 'true';
/** Track last known printer file so we auto-load when print starts */
let lastPrinterFile = '';

/** Nozzle indicator mesh */
let nozzleMesh: Object3D | null = null;
/** Last applied filament color to avoid redundant updates */
let lastFilamentColor = '';
/** Cached color map for re-init */
let cachedColorMap: Array<{ t: number; color: string }> = [];

// CC2 Centauri Carbon 2 build volume (mm)
/**
 * Tube shading, and why the numbers are small.
 *
 * The library's tube shader is:
 *
 *     finalColor = min(uColor * (diff + ambient) * brightness, 1.0)
 *
 * with `diff` the Lambert term scaled by `directional`. Its defaults — ambient 0.4,
 * directional 1.3, brightness 1.3 — put the lit side of a saturated blue at
 * 0.95 * 1.7 * 1.3 ≈ 2.1, which **clamps**. So does most of the mid-tone. Everything
 * above the clamp renders as the same pixel, which is precisely why a benchy came out as
 * a flat silhouette: the shading existed and was then thrown away by `min`.
 *
 * The instinct — turn the lights up — makes it worse, and measurably so: at ambient 0
 * with directional 4.0 the render is pixel-identical, because even more of the surface
 * clamps.
 *
 * So these are chosen to land the BRIGHTEST point just under 1.0 and let everything else
 * fall below it. For the blue channel at 0.95:
 *
 *     0.95 * (0.8 + 0.25) * 1.0 ≈ 1.0   lit side, just short of clamping
 *     0.95 * (0.0 + 0.25) * 1.0 ≈ 0.24  fully shaded side
 *
 * — a 4:1 range across the model instead of one flat value.
 */
const AMBIENT = 0.35;
const DIRECTIONAL = 1.0;
/**
 * A post-multiplier, so it trades highlight headroom for overall level.
 *
 * 1.1 puts the lit side of this blue near the top of the range while leaving the shaded
 * side around a quarter of it. The brightest facets clamp on the BLUE channel only —
 * red and green still vary there — so those read as a highlight rather than as the flat
 * plateau the library's 1.3 produced across the whole model.
 */
const BRIGHTNESS = 1.1;

const BUILD_VOLUME = { x: 256, y: 256, z: 256, smallGrid: false };

/** Create the nozzle cone mesh with outline and add it to the scene */
function ensureNozzle(): void {
  if (nozzleMesh || !preview) return;
  const geo = new ConeGeometry(3, 8, 12);
  geo.rotateX(Math.PI);

  // Solid fill
  const mat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
  const cone = new Mesh(geo, mat);

  // Dark outline for contrast
  const edges = new EdgesGeometry(geo);
  const lineMat = new LineBasicMaterial({ color: 0x000000, linewidth: 2 });
  const outline = new LineSegments(edges, lineMat);

  const group = new Group();
  group.name = 'nozzle-indicator';
  group.add(cone);
  group.add(outline);

  nozzleMesh = group;
  preview.scene.add(nozzleMesh);
}

/** Update nozzle position from printer state */
function updateNozzle(state: PrinterState): void {
  if (!preview) return;
  const gm = state.status?.gcode_move;
  const isPrinting = state.status?.machine_status?.status === 2;
  if (!gm || !isPrinting) {
    if (nozzleMesh) nozzleMesh.visible = false;
    return;
  }

  if (!nozzleMesh) {
    ensureNozzle();
    if (!nozzleMesh) return;
  }

  nozzleMesh.visible = true;
  // Group applies -PI/2 X rotation: gcode (x,y,z) → scene (x, z, -y)
  nozzleMesh.position.set(gm.x, gm.z + 4, -gm.y);
}

/** Build extrusionColor from colorMap — array for multi-color */
function buildExtrusionColors(colorMap: Array<{ t: number; color: string }>): string | string[] {
  if (colorMap.length === 0) return chartPalette().gcodeExtrusion;
  if (colorMap.length === 1) return `#${colorMap[0].color.replace(/^#/, '')}`;
  // Multi-color: array indexed by tool number
  const maxTool = Math.max(...colorMap.map((c) => c.t));
  const colors: string[] = new Array(maxTool + 1).fill(chartPalette().gcodeUnknownTool);
  for (const entry of colorMap) {
    colors[entry.t] = `#${entry.color.replace(/^#/, '')}`;
  }
  return colors;
}

/** Re-init preview with updated colors if colorMap changed */
function updateFilamentColor(state: PrinterState): void {
  if (!preview || !loadedFile) return;
  const sig = state.colorMap.map((c) => `${c.t}:${c.color}`).join(',');
  if (sig === lastFilamentColor || sig === '') return;
  lastFilamentColor = sig;
  cachedColorMap = state.colorMap;
  // Colors can only be set at construction, so re-load
  loadGcode(loadedFile);
}

/** Throttle full gcode-preview renders (geometry rebuild) to max 2 FPS */
let lastRenderTime = 0;
const RENDER_INTERVAL = 500; // 2 FPS

function throttledRender(): void {
  const now = Date.now();
  if (now - lastRenderTime < RENDER_INTERVAL) return;
  lastRenderTime = now;
  preview?.render();
}

/** Lightweight WebGL-only redraw (no geometry rebuild) — for nozzle moves */
function lightRender(): void {
  const now = Date.now();
  if (now - lastRenderTime < RENDER_INTERVAL) return;
  lastRenderTime = now;
  if (!preview) return;
  preview.renderer.render(preview.scene, preview.camera);
}

/** Stop the library's internal 60fps rAF animate loop */
function stopAnimateLoop(p: WebGLPreview): void {
  // animationFrameId is private but accessible at runtime
  const internals = p as unknown as WebGLPreviewInternals;
  const id = internals.animationFrameId;
  if (id != null) cancelAnimationFrame(id);
  // Override animate() so it can't restart
  internals.animate = () => {};
}

/** Render on orbit control changes (user dragging the 3D view) — throttled */
function onOrbitChange(): void {
  if (!preview) return;
  preview.renderer.render(preview.scene, preview.camera);
}

/** Exported for main.ts to call on each render frame */
/**
 * Show or hide the "No G-code loaded" overlay.
 *
 * Called wherever `preview` is assigned, because that is the only thing that decides
 * whether the canvas has anything on it — a canvas with nothing drawn looks identical
 * to one that failed to load.
 */
function setPreviewEmpty(empty: boolean): void {
  $('gcode-preview-empty')?.classList.toggle('hidden', !empty);
  // The canvas reserves 350px — the tallest single element on the dashboard — and with
  // nothing loaded that is 350px of nothing behind a one-line message. Collapsing it
  // rather than overlaying the message is most of the difference between the card
  // looking "empty" and looking "broken".
  $('gcode-preview-canvas')?.classList.toggle('hidden', empty);
  $('gcode-layer-slider')?.parentElement?.classList.toggle('hidden', empty);
}

export function renderGcodePreview(state: PrinterState): void {
  const s = state.status;
  const ps = s?.print_status;
  const isPrinting = s?.machine_status?.status === 2;
  const filename = ps?.filename || '';

  // Auto-load when a new print starts (delay 3s to let printer settle)
  if (isPrinting && filename && filename !== lastPrinterFile) {
    lastPrinterFile = filename;
    cachedColorMap = state.colorMap;
    lastFilamentColor = state.colorMap.map((c) => `${c.t}:${c.color}`).join(',');
    if (filename !== loadedFile) {
      setTimeout(() => loadGcode(filename), 3000);
    }
  }

  // When print stops, keep the preview but reset tracking
  if (!isPrinting && lastPrinterFile) {
    lastPrinterFile = '';
  }

  updateInfo(state);
  updateNozzle(state);
  updateFilamentColor(state);

  // Follow mode: update visible layers to match print progress
  if (!preview || !followMode) return;
  const currentLayer = ps?.current_layer ?? 0;
  if (isPrinting && currentLayer > 0 && currentLayer !== lastEndLayer) {
    lastEndLayer = currentLayer;
    preview.singleLayerMode = singleLayerMode;
    // gcode-preview counts preamble as layer 0, so printer layer N = preview layer N+1
    preview.endLayer = currentLayer + 1;
    throttledRender();

    // Sync slider
    const slider = $('gcode-layer-slider') as HTMLInputElement | null;
    if (slider) {
      slider.value = String(currentLayer);
      updateLayerReadout();
    }
  } else if (isPrinting && nozzleMesh?.visible) {
    // Re-render to show updated nozzle position (lightweight, no geometry rebuild)
    lightRender();
  }
}

/** Initialize the 3D preview on the canvas */
function initPreview(colorMap?: Array<{ t: number; color: string }>): WebGLPreview | null {
  const pal = chartPalette();
  const canvas = $('gcode-preview-canvas') as HTMLCanvasElement | null;
  if (!canvas) return null;

  // Dispose previous instance
  if (preview) {
    try {
      preview.dispose();
    } catch {
      /* ignore */
    }
    preview = null;
    setPreviewEmpty(true);
    nozzleMesh = null;
  }

  const extrusionColor =
    colorMap && colorMap.length > 0 ? buildExtrusionColors(colorMap) : pal.gcodeExtrusion;

  const p = new WebGLPreview({
    canvas,
    backgroundColor: pal.gcodeBg,
    extrusionColor,
    topLayerColor: pal.gcodeTopLayer,
    lastSegmentColor: pal.gcodeLastSegment,
    travelColor: pal.gcodeTravel,
    buildVolume: BUILD_VOLUME,
    /*
     * Tubes, not lines. `renderTubes: false` drew every extrusion as a flat 2px line in
     * one colour, so a model came out as a silhouette — a benchy was a blue blob you
     * could not read as a boat, because nothing in the image varied with the surface
     * angle. Tubes are real geometry, and the library lights them, so the shape reads.
     */
    renderTubes: true,
    // The nozzle and layer height this printer actually uses, so a tube is the size of
    // the bead it represents rather than a guess.
    extrusionWidth: 0.42,
    lineHeight: 0.2,
    lineWidth: 2,
    renderExtrusion: true,
    renderTravel: false,
    // Front-right and above, matching the webcam's view, but much closer than the old
    // [200,350,200]: that framed the whole 256mm plate, leaving a 60mm benchy as a
    // thumbnail in the middle of an empty grid. Orbit still reaches the far corners.
    initialCameraPosition: [95, 120, 95],
  });

  /*
   * Contrast comes from the ratio between these two, not from either alone.
   *
   * The library's defaults light tubes almost flatly. Pulling ambient down and the
   * directional up is what makes a curve read as a curve: the lit side separates from
   * the shaded side instead of both landing on the same blue.
   */
  // Deliberately NOT set here — see `applyShading`.

  lastEndLayer = -1;
  return p;
}

/**
 * Push the shading values into the materials, after the geometry exists.
 *
 * Setting them on the instance before rendering does nothing, which cost an hour to
 * pin down. The library builds each tube material through a factory that is **cached by
 * colour at module scope**:
 *
 *     function makeMaterial(color, ambient, directional, brightness) {
 *       if (cache[color]) return cache[color];   // <- the arguments are ignored
 *       ...
 *     }
 *
 * so whichever instance first renders a given colour fixes that colour's uniforms for
 * the lifetime of the page, and every later instance silently inherits them. Measured:
 * the instance reported ambient 0.25 while all 58 of its materials held the library's
 * 0.4.
 *
 * The instance setters, however, write straight into `materials[].uniforms`. So the
 * values have to be applied *after* the geometry is built rather than before — which is
 * this function, called at every point that finishes rendering.
 */
function applyShading(p: WebGLPreview): void {
  p.ambientLight = AMBIENT;
  p.directionalLight = DIRECTIONAL;
  p.brightness = BRIGHTNESS;
}

/** Load gcode file from the server download proxy */
export async function loadGcode(filename: string, source = 'local'): Promise<void> {
  if (loading) return;

  const statusEl = $('gcode-preview-status');
  const loadBtn = $('btn-load-gcode') as HTMLButtonElement | null;

  try {
    loading = true;
    if (loadBtn) loadBtn.disabled = true;
    if (statusEl) statusEl.textContent = 'Downloading gcode…';

    const url = `/api/files/download?file=${encodeURIComponent(filename)}&source=${encodeURIComponent(source)}`;
    let resp: Response | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        resp = await fetchTimeout(url, undefined, 120_000);
        if (resp.ok) break;
        resp = null;
      } catch (e) {
        if (attempt < 3) {
          if (statusEl) statusEl.textContent = `Retry ${attempt}/2 — download failed`;
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          throw e;
        }
      }
    }
    if (!resp || !resp.ok) throw new Error(`Download failed: ${resp?.status ?? 'no response'}`);

    if (statusEl) statusEl.textContent = 'Parsing gcode…';

    const gcode = await resp.text();

    // Initialize clean preview with filament colors
    preview = initPreview(cachedColorMap);
    setPreviewEmpty(false);
    if (!preview) {
      if (statusEl) statusEl.textContent = 'Canvas not found';
      return;
    }

    // Process gcode (v3 is async)
    await preview.processGCode(gcode);
    applyShading(preview);

    // Stop the library's built-in 60fps animate loop — it calls WebGL render()
    // every frame, leaking ~23 MB/s. We render on-demand instead.
    stopAnimateLoop(preview);
    // Re-render once after stopping the loop (processGCode's last frame may be lost)
    preview.renderer.render(preview.scene, preview.camera);
    // Render on orbit control interaction (user dragging)
    preview.controls.addEventListener('change', onOrbitChange);

    loadedFile = filename;

    // Set layer slider range
    const totalLayers = preview.countLayers;
    const slider = $('gcode-layer-slider') as HTMLInputElement | null;
    if (slider) {
      slider.max = String(totalLayers);
      slider.value = String(totalLayers);
      updateLayerReadout();
    }

    // Show total layers
    if (statusEl) statusEl.textContent = `${totalLayers} layers · ${shortName(filename)}`;
  } catch (err) {
    console.error('Gcode preview load error:', err);
    if (statusEl) statusEl.textContent = `Error: ${(err as Error).message}`;
  } finally {
    loading = false;
    if (loadBtn) loadBtn.disabled = false;
  }
}

/**
 * Write the layer readout from the slider.
 *
 * `updateInfo` only runs when a printer status frame arrives, so with no printer — a
 * file opened by hand, or the service offline — the Layer row sat blank however far you
 * scrubbed. The slider knows both numbers on its own; nothing about them needs the
 * machine.
 */
function updateLayerReadout(): void {
  const infoEl = document.getElementById('gcode-preview-info');
  const slider = document.getElementById('gcode-layer-slider') as HTMLInputElement | null;
  if (!infoEl || !slider || !preview) return;
  infoEl.textContent = `${slider.value}/${slider.max}`;
}

/** Reflect `followMode` in the switch without firing its change handler. */
function setFollowChecked(on: boolean): void {
  const box = document.getElementById('btn-gcode-follow') as HTMLInputElement | null;
  if (box) box.checked = on;
}

/** Move the segmented fill to whichever view is selected. */
function syncViewButtons(): void {
  for (const btn of document.querySelectorAll<HTMLElement>('[data-single]')) {
    toggleState(btn, 'active', (btn.dataset.single === '1') === singleLayerMode);
  }
  const track = document
    .querySelector<HTMLElement>('[data-single]')
    ?.closest<HTMLElement>('.segmented');
  if (track) positionSegmented(track);
}

/** Update the info bar below the 3D view */
function updateInfo(state: PrinterState): void {
  const infoEl = $('gcode-preview-info');
  if (!infoEl) return;

  const s = state.status;
  const ps = s?.print_status;
  const isPrinting = s?.machine_status?.status === 2;

  if (!preview || !loadedFile) {
    infoEl.textContent = '';
    return;
  }

  const currentLayer = ps?.current_layer ?? 0;
  const totalLayer = ps?.total_layer ?? state.fileTotalLayers ?? preview.countLayers;
  const zPos = s?.gcode_move?.z ?? 0;
  const progress = s?.machine_status?.progress ?? 0;
  const displayedLayer = preview.endLayer ?? preview.countLayers;

  /*
   * The numbers only. The row is labelled "Layer" now, so repeating the word here both
   * duplicated it and overflowed a 64px cell — the text rendered underneath the slider
   * and read as missing. Z and progress moved to the status line below, which has the
   * width for them and is where the file name already lives.
   */
  const shown = isPrinting && !singleLayerMode ? currentLayer : displayedLayer;
  infoEl.textContent = `${shown}/${totalLayer || preview.countLayers}`;

  const statusEl = document.getElementById('gcode-preview-status');
  if (statusEl && loadedFile) {
    const detail = isPrinting ? ` · Z ${zPos.toFixed(1)}mm · ${progress}%` : '';
    statusEl.textContent = `${preview.countLayers} layers · ${loadedFile}${detail}`;
  }
}

/** Extract short filename from full path */
function shortName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** Bind control event handlers — call once at startup */
export function bindGcodePreviewControls(): void {
  onThemeChange(refreshGcodePreviewTheme);

  // `preview` starts null without ever being ASSIGNED null, so none of the call sites
  // below fire on a fresh load and the card opened showing an empty 350px canvas with
  // the placeholder stacked under it — taller than before the placeholder existed.
  setPreviewEmpty(true);

  // The controls start from the stored modes rather than from whatever the markup
  // happens to mark active — they disagreed before, and nothing reconciled them.
  syncViewButtons();
  setFollowChecked(followMode);

  // Layer slider
  const slider = $('gcode-layer-slider') as HTMLInputElement | null;
  if (slider) {
    slider.addEventListener('input', () => {
      if (!preview) return;
      followMode = false;
      localStorage.setItem('gcode-follow', 'false');
      const val = parseInt(slider.value, 10);
      preview.endLayer = val;
      lastEndLayer = val;
      preview.render();
      updateLayerReadout();

      setFollowChecked(false);

      if (preview) {
        preview.singleLayerMode = singleLayerMode;
        preview.render();
      }
    });
  }

  /*
   * View: stacked or single, as a segmented picker.
   *
   * It was one button that flipped a boolean and called `toggleState(btn, 'active', …)`.
   * That adds a bare `.active` class, and with the stylesheet gone nothing maps it to a
   * utility — measured, the computed style was identical on and off, so the control gave
   * no clue which mode you were in. Two named positions say it without needing a state
   * to be styled at all.
   */
  for (const btn of document.querySelectorAll<HTMLElement>('[data-single]')) {
    btn.addEventListener('click', () => {
      singleLayerMode = btn.dataset.single === '1';
      localStorage.setItem('gcode-single-layer', String(singleLayerMode));
      syncViewButtons();
      if (preview) {
        preview.singleLayerMode = singleLayerMode;
        preview.render();
      }
    });
  }

  // Follow, as a switch. Same reasoning: a checkbox shows its own state.
  const followBox = $('btn-gcode-follow') as HTMLInputElement | null;
  if (followBox) {
    followBox.addEventListener('change', () => {
      followMode = followBox.checked;
      localStorage.setItem('gcode-follow', String(followMode));
      // Reset so the render loop picks up the current print layer.
      if (followMode) lastEndLayer = -1;
    });
  }

  // Load button
  const loadBtn = $('btn-load-gcode');
  if (loadBtn) {
    loadBtn.addEventListener('click', () => {
      const input = $('gcode-file-input') as HTMLInputElement | null;
      if (input) input.click();
    });
  }

  // Hidden file input for manual drag/load
  const fileInput = $('gcode-file-input') as HTMLInputElement | null;
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const gcode = reader.result as string;
        preview = initPreview(cachedColorMap);
        setPreviewEmpty(false);
        if (!preview) return;
        await preview.processGCode(gcode);
        applyShading(preview);
        loadedFile = file.name;
        const slider = $('gcode-layer-slider') as HTMLInputElement | null;
        if (slider) {
          slider.max = String(preview.countLayers);
          slider.value = String(preview.countLayers);
          updateLayerReadout();
        }
        const statusEl = $('gcode-preview-status');
        if (statusEl) statusEl.textContent = `${preview.countLayers} layers · ${file.name}`;
      };
      reader.readAsText(file);
      fileInput.value = '';
    });
  }

  // Handle canvas resize
  const canvas = $('gcode-preview-canvas') as HTMLCanvasElement | null;
  if (canvas) {
    const ro = new ResizeObserver(() => {
      if (preview) preview.resize();
    });
    ro.observe(canvas);
  }
}

/** Dispose the preview (if navigating away, cleanup) */
/**
 * Re-colour a live preview after a theme change.
 *
 * The four colours are read from the chart palette once, at construction, and baked into
 * WebGL state — so flipping the theme used to leave the model sitting on the old
 * background until the page reloaded. `ui/theme.ts` calls this for the same reason it
 * calls `invalidateChartPalette`: a canvas cannot re-read a stylesheet by itself.
 *
 * Colours only. Rebuilding the preview would mean re-parsing the whole file, which for
 * the 3.2 MB benchy this was tested against is several seconds of nothing.
 */
export function refreshGcodePreviewTheme(): void {
  if (!preview) return;
  const pal = chartPalette();
  preview.backgroundColor = pal.gcodeBg;
  preview.travelColor = pal.gcodeTravel;
  preview.topLayerColor = pal.gcodeTopLayer;
  if (!Array.isArray(preview.extrusionColor)) preview.extrusionColor = pal.gcodeExtrusion;
  preview.render();
}

export function disposeGcodePreview(): void {
  if (preview) {
    try {
      preview.dispose();
    } catch {
      /* ignore */
    }
    preview = null;
    setPreviewEmpty(true);
    nozzleMesh = null;
  }
  loadedFile = '';
  lastEndLayer = -1;
}
