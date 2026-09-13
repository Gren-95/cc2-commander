/** Spool Calculator — visualizes remaining filament on a spool */

// Material densities in g/cm³
const MATERIALS: Record<string, number> = {
  PLA: 1.24,
  'PLA+': 1.24,
  PETG: 1.27,
  ABS: 1.04,
  ASA: 1.07,
  TPU: 1.21,
  PA: 1.14,
  PC: 1.2,
  HIPS: 1.04,
  PVA: 1.23,
};

// Deliberately NOT renamed with the project. This key is the only handle on a
// browser's saved state — theme, dashboard layout and card widths, list sorts,
// alert volume. Changing it does not migrate anything; it silently orphans all of
// it and the user sees a factory-fresh dashboard with no explanation. A cosmetic
// rename is not worth that.
const STORAGE_KEY = 'elegoo-web-spool-calc';

interface SpoolParams {
  hubDiameter: number; // mm — inner diameter (the core around which filament is wound)
  flangeDiameter: number; // mm — outer diameter of the spool flanges
  spoolWidth: number; // mm — width/depth of the spool
  emptyWeight: number; // g — weight of the empty spool (no filament)
  currentWeight: number; // g — current total weight (spool + remaining filament)
  filamentDiameter: number; // mm — 1.75 or 2.85
  material: string; // key into MATERIALS
  fullWeight: number; // g — full spool weight (spool + full filament, e.g. empty + 1000)
  currentOuterDiameter: number; // mm — measured outer diameter of remaining filament on spool
}

const DEFAULTS: SpoolParams = {
  hubDiameter: 55,
  flangeDiameter: 200,
  spoolWidth: 63,
  emptyWeight: 250,
  currentWeight: 1250,
  filamentDiameter: 1.75,
  material: 'PLA',
  fullWeight: 1250,
  currentOuterDiameter: 0,
};

function loadParams(): SpoolParams {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

function saveParams(p: SpoolParams): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

/** Convert outer diameter (mm) to filament mass (grams) using spool geometry */
function outerDiameterToMass(
  outerDiameter: number,
  hubDiameter: number,
  spoolWidth: number,
  material: string,
): number {
  const density = MATERIALS[material] ?? 1.24;
  const outerR = outerDiameter / 2 / 10; // cm
  const hubR = hubDiameter / 2 / 10; // cm
  const width = spoolWidth / 10; // cm
  const volume = Math.PI * (outerR * outerR - hubR * hubR) * width; // cm³
  return Math.max(0, volume * density); // grams
}

/** Calculate filament remaining stats */
function calculate(p: SpoolParams) {
  const density = MATERIALS[p.material] ?? 1.24;
  const filamentMass = Math.max(0, p.currentWeight - p.emptyWeight); // grams
  const fullFilamentMass = Math.max(0, p.fullWeight - p.emptyWeight);
  const filamentRadius = p.filamentDiameter / 2 / 10; // cm
  const crossSection = Math.PI * filamentRadius * filamentRadius; // cm²

  // Volume of remaining filament in cm³
  const volume = filamentMass / density;
  const fullVolume = fullFilamentMass / density;

  // Length in cm, convert to meters
  const lengthCm = volume / crossSection;
  const lengthM = lengthCm / 100;

  const fullLengthCm = fullVolume / crossSection;
  const fullLengthM = fullLengthCm / 100;

  // Current outer radius of wound filament
  const hubRadius = p.hubDiameter / 2; // mm
  const spoolWidthCm = p.spoolWidth / 10; // cm
  const hubRadiusCm = hubRadius / 10; // cm

  // V = π × (R² - r²) × W → R = sqrt(V / (π × W) + r²)
  const currentOuterRadiusCm = Math.sqrt(
    volume / (Math.PI * spoolWidthCm) + hubRadiusCm * hubRadiusCm,
  );
  const currentOuterRadius = currentOuterRadiusCm * 10; // back to mm

  const fullOuterRadiusCm = Math.sqrt(
    fullVolume / (Math.PI * spoolWidthCm) + hubRadiusCm * hubRadiusCm,
  );
  const fullOuterRadius = fullOuterRadiusCm * 10; // mm

  const percentRemaining = fullFilamentMass > 0 ? (filamentMass / fullFilamentMass) * 100 : 0;

  return {
    filamentMass,
    fullFilamentMass,
    lengthM,
    fullLengthM,
    currentOuterRadius: Math.min(currentOuterRadius, p.flangeDiameter / 2),
    fullOuterRadius: Math.min(fullOuterRadius, p.flangeDiameter / 2),
    percentRemaining,
    density,
  };
}

/** Draw spool side-view SVG */
function renderSVG(p: SpoolParams, calc: ReturnType<typeof calculate>): string {
  const W = 360;
  const H = 280;
  const cx = W / 2;
  const cy = H / 2;

  // Scale factor: map flange diameter to fit in the SVG
  const flangeRadius = p.flangeDiameter / 2;
  const maxVisualRadius = 120; // px
  const scale = maxVisualRadius / flangeRadius;

  const hubR = (p.hubDiameter / 2) * scale;
  const flangeR = flangeRadius * scale;
  const filamentR = calc.currentOuterRadius * scale;
  const fullFilamentR = calc.fullOuterRadius * scale;
  const spoolW = Math.min(p.spoolWidth * scale * 0.6, 80); // visual width capped
  const flangeThick = 3;

  // Side view: spool is a rectangle, hub is inner rect, filament fills between
  const left = cx - spoolW / 2;
  const right = cx + spoolW / 2;

  // Build SVG
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="w-full max-w-105 h-auto" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<defs>
    <linearGradient id="filament-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--accent-light)" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.7"/>
    </linearGradient>
    <linearGradient id="ghost-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--text-muted)" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="var(--text-muted)" stop-opacity="0.08"/>
    </linearGradient>
  </defs>`;

  // --- Flange outline (outer frame) ---
  svg += `<rect x="${left - flangeThick}" y="${cy - flangeR}" width="${spoolW + flangeThick * 2}" height="${flangeR * 2}" 
    rx="2" fill="none" stroke="var(--text-muted)" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.4"/>`;

  // --- Left flange wall ---
  svg += `<rect x="${left - flangeThick}" y="${cy - flangeR}" width="${flangeThick}" height="${flangeR * 2}" 
    rx="1" fill="var(--border)" opacity="0.8"/>`;

  // --- Right flange wall ---
  svg += `<rect x="${right}" y="${cy - flangeR}" width="${flangeThick}" height="${flangeR * 2}" 
    rx="1" fill="var(--border)" opacity="0.8"/>`;

  // --- Ghost outline: full spool capacity ---
  if (fullFilamentR > hubR + 1) {
    svg += `<rect x="${left}" y="${cy - fullFilamentR}" width="${spoolW}" height="${fullFilamentR * 2}" 
      rx="2" fill="url(#ghost-grad)" stroke="var(--text-muted)" stroke-width="0.5" stroke-dasharray="3,3"/>`;
  }

  // --- Filament (current fill) ---
  if (filamentR > hubR + 0.5) {
    svg += `<rect x="${left}" y="${cy - filamentR}" width="${spoolW}" height="${filamentR * 2}" 
      rx="2" fill="url(#filament-grad)"/>`;
  }

  // --- Hub (center core) ---
  svg += `<rect x="${left}" y="${cy - hubR}" width="${spoolW}" height="${hubR * 2}" 
    rx="2" fill="var(--bg-secondary)" stroke="var(--border)" stroke-width="1.5"/>`;

  // --- Hub hole (center) ---
  const holeR = hubR * 0.5;
  svg += `<rect x="${left + 2}" y="${cy - holeR}" width="${spoolW - 4}" height="${holeR * 2}" 
    rx="2" fill="var(--bg-primary)" opacity="0.6"/>`;

  // --- Dimension labels ---
  const dimX = right + flangeThick + 14;

  // Flange diameter
  svg += `<line x1="${dimX - 6}" y1="${cy - flangeR}" x2="${dimX - 6}" y2="${cy + flangeR}" 
    stroke="var(--text-muted)" stroke-width="0.8" marker-start="url(#arr)" marker-end="url(#arr)"/>`;
  svg += `<text x="${dimX}" y="${cy + 4}" fill="var(--text-muted)" font-size="10" font-family="monospace">${p.flangeDiameter}mm</text>`;

  // Hub diameter
  const hubDimX = left - flangeThick - 14;
  svg += `<line x1="${hubDimX + 6}" y1="${cy - hubR}" x2="${hubDimX + 6}" y2="${cy + hubR}" 
    stroke="var(--text-muted)" stroke-width="0.8"/>`;
  svg += `<text x="${hubDimX - 2}" y="${cy + 4}" fill="var(--text-muted)" font-size="10" font-family="monospace" text-anchor="end">${p.hubDiameter}mm</text>`;

  // Spool width (bottom)
  const widthY = cy + flangeR + 16;
  svg += `<line x1="${left}" y1="${widthY}" x2="${right}" y2="${widthY}" 
    stroke="var(--text-muted)" stroke-width="0.8"/>`;
  svg += `<text x="${cx}" y="${widthY + 14}" fill="var(--text-muted)" font-size="10" font-family="monospace" text-anchor="middle">${p.spoolWidth}mm</text>`;

  // Filament outer radius indicator
  if (filamentR > hubR + 2) {
    svg += `<line x1="${cx}" y1="${cy - filamentR}" x2="${cx}" y2="${cy - filamentR - 8}" 
      stroke="var(--accent-light)" stroke-width="0.8"/>`;
    svg += `<text x="${cx}" y="${cy - filamentR - 12}" fill="var(--accent-light)" font-size="9" font-family="monospace" text-anchor="middle">⌀${Math.round(calc.currentOuterRadius * 2)}mm</text>`;
  }

  svg += '</svg>';
  return svg;
}

/** Render the full spool calculator page */
export function renderSpoolCalc(): void {
  const container = document.getElementById('tools-content');
  if (!container) return;

  const p = loadParams();
  const calc = calculate(p);

  container.innerHTML = `
    <div class="mt-2">
      <div class="grid grid-cols-[1fr_320px] gap-6 items-start max-[700px]:grid-cols-[1fr]">
        <div class="flex flex-col items-center gap-4 bg-surface rounded-card p-5 border border-line">
          <div id="spool-svg-container">${renderSVG(p, calc)}</div>
          <div class="grid grid-cols-[repeat(4,_1fr)] gap-3 w-full max-[700px]:grid-cols-[repeat(2,_1fr)]">
            <div class="text-center bg-card rounded-chip [padding:10px_6px] border border-line">
              <span class="block text-[22px] font-bold text-accent-light [font-variant-numeric:tabular-nums]" id="sc-meters">${calc.lengthM.toFixed(1)}</span>
              <span class="block text-[11px] text-fg-muted [margin-top:2px] uppercase tracking-[0.3px]">meters left</span>
            </div>
            <div class="text-center bg-card rounded-chip [padding:10px_6px] border border-line">
              <span class="block text-[22px] font-bold text-accent-light [font-variant-numeric:tabular-nums]" id="sc-full-meters">${calc.fullLengthM.toFixed(1)}</span>
              <span class="block text-[11px] text-fg-muted [margin-top:2px] uppercase tracking-[0.3px]">meters full</span>
            </div>
            <div class="text-center bg-card rounded-chip [padding:10px_6px] border border-line">
              <span class="block text-[22px] font-bold text-accent-light [font-variant-numeric:tabular-nums]" id="sc-grams">${calc.filamentMass.toFixed(0)}</span>
              <span class="block text-[11px] text-fg-muted [margin-top:2px] uppercase tracking-[0.3px]">grams filament</span>
            </div>
            <div class="text-center bg-card rounded-chip [padding:10px_6px] border border-line">
              <span class="block text-[22px] font-bold text-accent-light [font-variant-numeric:tabular-nums]" id="sc-percent">${calc.percentRemaining.toFixed(0)}%</span>
              <span class="block text-[11px] text-fg-muted [margin-top:2px] uppercase tracking-[0.3px]">remaining</span>
            </div>
          </div>
        </div>
        <div class="spool-calc-inputs bg-card rounded-card p-4 border border-line [&_h4]:text-[12px] [&_h4]:font-semibold [&_h4]:text-fg-soft [&_h4]:uppercase [&_h4]:tracking-[0.4px] [&_h4]:[margin:14px_0_8px] [&_h4:first-child]:mt-0 [&_.form-group_label]:text-[12px] [&_.form-group_label]:text-fg-soft [&_.form-group_label]:[margin-bottom:3px] [&_.form-group_label]:block">
          <h4>Spool Dimensions</h4>
          <div class="form-group mb-4 [&_label]:block [&_label]:text-[12px] [&_label]:text-fg-soft [&_label]:mb-1 [&_input]:w-full [&_input]:[padding:8px_12px] [&_input]:bg-input [&_input]:border [&_input]:border-line [&_input]:rounded-chip [&_input]:text-fg [&_input]:text-[14px] [&_input]:[outline:none] [.modal-body_&]:mb-3 [.spool-calc-inputs_&]:[margin-bottom:10px] [&_input:focus]:border-accent last:[.modal-body_&]:mb-0">
            <label for="sc-hub-dia">Hub Diameter (inner)</label>
            <div class="flex items-center [gap:6px] [&_input]:flex-1 [&_input]:[padding:6px_10px] [&_input]:bg-input [&_input]:border [&_input]:border-line [&_input]:rounded-chip [&_input]:text-fg [&_input]:text-[14px] [&_input]:[outline:none] [&_input]:[font-variant-numeric:tabular-nums] [&_input:focus]:border-accent">
              <input type="number" id="sc-hub-dia" value="${p.hubDiameter}" min="10" max="120" step="1">
              <span class="text-[12px] text-fg-muted min-w-7">mm</span>
            </div>
          </div>
          <div class="form-group mb-4 [&_label]:block [&_label]:text-[12px] [&_label]:text-fg-soft [&_label]:mb-1 [&_input]:w-full [&_input]:[padding:8px_12px] [&_input]:bg-input [&_input]:border [&_input]:border-line [&_input]:rounded-chip [&_input]:text-fg [&_input]:text-[14px] [&_input]:[outline:none] [.modal-body_&]:mb-3 [.spool-calc-inputs_&]:[margin-bottom:10px] [&_input:focus]:border-accent last:[.modal-body_&]:mb-0">
            <label for="sc-flange-dia">Flange Diameter (outer)</label>
            <div class="flex items-center [gap:6px] [&_input]:flex-1 [&_input]:[padding:6px_10px] [&_input]:bg-input [&_input]:border [&_input]:border-line [&_input]:rounded-chip [&_input]:text-fg [&_input]:text-[14px] [&_input]:[outline:none] [&_input]:[font-variant-numeric:tabular-nums] [&_input:focus]:border-accent">
              <input type="number" id="sc-flange-dia" value="${p.flangeDiameter}" min="50" max="400" step="1">
              <span class="text-[12px] text-fg-muted min-w-7">mm</span>
            </div>
          </div>
          <div class="form-group mb-4 [&_label]:block [&_label]:text-[12px] [&_label]:text-fg-soft [&_label]:mb-1 [&_input]:w-full [&_input]:[padding:8px_12px] [&_input]:bg-input [&_input]:border [&_input]:border-line [&_input]:rounded-chip [&_input]:text-fg [&_input]:text-[14px] [&_input]:[outline:none] [.modal-body_&]:mb-3 [.spool-calc-inputs_&]:[margin-bottom:10px] [&_input:focus]:border-accent last:[.modal-body_&]:mb-0">
            <label for="sc-width">Spool Width</label>
            <div class="flex items-center [gap:6px] [&_input]:flex-1 [&_input]:[padding:6px_10px] [&_input]:bg-input [&_input]:border [&_input]:border-line [&_input]:rounded-chip [&_input]:text-fg [&_input]:text-[14px] [&_input]:[outline:none] [&_input]:[font-variant-numeric:tabular-nums] [&_input:focus]:border-accent">
              <input type="number" id="sc-width" value="${p.spoolWidth}" min="10" max="150" step="1">
              <span class="text-[12px] text-fg-muted min-w-7">mm</span>
            </div>
          </div>

          <h4>Weight</h4>
          <div class="form-group mb-4 [&_label]:block [&_label]:text-[12px] [&_label]:text-fg-soft [&_label]:mb-1 [&_input]:w-full [&_input]:[padding:8px_12px] [&_input]:bg-input [&_input]:border [&_input]:border-line [&_input]:rounded-chip [&_input]:text-fg [&_input]:text-[14px] [&_input]:[outline:none] [.modal-body_&]:mb-3 [.spool-calc-inputs_&]:[margin-bottom:10px] [&_input:focus]:border-accent last:[.modal-body_&]:mb-0">
            <label for="sc-empty-weight">Empty Spool Weight</label>
            <div class="flex items-center [gap:6px] [&_input]:flex-1 [&_input]:[padding:6px_10px] [&_input]:bg-input [&_input]:border [&_input]:border-line [&_input]:rounded-chip [&_input]:text-fg [&_input]:text-[14px] [&_input]:[outline:none] [&_input]:[font-variant-numeric:tabular-nums] [&_input:focus]:border-accent">
              <input type="number" id="sc-empty-weight" value="${p.emptyWeight}" min="0" max="2000" step="1">
              <span class="text-[12px] text-fg-muted min-w-7">g</span>
            </div>
          </div>
          <div class="form-group mb-4 [&_label]:block [&_label]:text-[12px] [&_label]:text-fg-soft [&_label]:mb-1 [&_input]:w-full [&_input]:[padding:8px_12px] [&_input]:bg-input [&_input]:border [&_input]:border-line [&_input]:rounded-chip [&_input]:text-fg [&_input]:text-[14px] [&_input]:[outline:none] [.modal-body_&]:mb-3 [.spool-calc-inputs_&]:[margin-bottom:10px] [&_input:focus]:border-accent last:[.modal-body_&]:mb-0">
            <label for="sc-full-weight">Full Spool Weight (spool + filament)</label>
            <div class="flex items-center [gap:6px] [&_input]:flex-1 [&_input]:[padding:6px_10px] [&_input]:bg-input [&_input]:border [&_input]:border-line [&_input]:rounded-chip [&_input]:text-fg [&_input]:text-[14px] [&_input]:[outline:none] [&_input]:[font-variant-numeric:tabular-nums] [&_input:focus]:border-accent">
              <input type="number" id="sc-full-weight" value="${p.fullWeight}" min="0" max="10000" step="1">
              <span class="text-[12px] text-fg-muted min-w-7">g</span>
            </div>
          </div>
          <div class="form-group mb-4 [&_label]:block [&_label]:text-[12px] [&_label]:text-fg-soft [&_label]:mb-1 [&_input]:w-full [&_input]:[padding:8px_12px] [&_input]:bg-input [&_input]:border [&_input]:border-line [&_input]:rounded-chip [&_input]:text-fg [&_input]:text-[14px] [&_input]:[outline:none] [.modal-body_&]:mb-3 [.spool-calc-inputs_&]:[margin-bottom:10px] [&_input:focus]:border-accent last:[.modal-body_&]:mb-0">
            <label for="sc-current-weight">Current Weight</label>
            <div class="flex items-center [gap:6px] [&_input]:flex-1 [&_input]:[padding:6px_10px] [&_input]:bg-input [&_input]:border [&_input]:border-line [&_input]:rounded-chip [&_input]:text-fg [&_input]:text-[14px] [&_input]:[outline:none] [&_input]:[font-variant-numeric:tabular-nums] [&_input:focus]:border-accent">
              <input type="number" id="sc-current-weight" value="${p.currentWeight}" min="0" max="10000" step="1">
              <span class="text-[12px] text-fg-muted min-w-7">g</span>
            </div>
          </div>

          <h4>Measure by Diameter</h4>
          <div class="form-group mb-4 [&_label]:block [&_label]:text-[12px] [&_label]:text-fg-soft [&_label]:mb-1 [&_input]:w-full [&_input]:[padding:8px_12px] [&_input]:bg-input [&_input]:border [&_input]:border-line [&_input]:rounded-chip [&_input]:text-fg [&_input]:text-[14px] [&_input]:[outline:none] [.modal-body_&]:mb-3 [.spool-calc-inputs_&]:[margin-bottom:10px] [&_input:focus]:border-accent last:[.modal-body_&]:mb-0">
            <label for="sc-outer-dia">Current Outer Diameter</label>
            <div class="flex items-center [gap:6px] [&_input]:flex-1 [&_input]:[padding:6px_10px] [&_input]:bg-input [&_input]:border [&_input]:border-line [&_input]:rounded-chip [&_input]:text-fg [&_input]:text-[14px] [&_input]:[outline:none] [&_input]:[font-variant-numeric:tabular-nums] [&_input:focus]:border-accent">
              <input type="number" id="sc-outer-dia" value="${p.currentOuterDiameter || ''}" min="0" max="400" step="1" placeholder="e.g. 180">
              <span class="text-[12px] text-fg-muted min-w-7">mm</span>
            </div>
            <span class="text-[0.8rem] text-fg-muted [margin:0_0_8px] [&_code]:bg-input [&_code]:[padding:1px_4px] [&_code]:rounded-[3px] [&_code]:text-[0.75rem]">Measure the filament wound on the spool with a ruler — updates weight automatically</span>
          </div>

          <h4>Filament</h4>
          <div class="form-group mb-4 [&_label]:block [&_label]:text-[12px] [&_label]:text-fg-soft [&_label]:mb-1 [&_input]:w-full [&_input]:[padding:8px_12px] [&_input]:bg-input [&_input]:border [&_input]:border-line [&_input]:rounded-chip [&_input]:text-fg [&_input]:text-[14px] [&_input]:[outline:none] [.modal-body_&]:mb-3 [.spool-calc-inputs_&]:[margin-bottom:10px] [&_input:focus]:border-accent last:[.modal-body_&]:mb-0">
            <label for="sc-material">Material</label>
            <select id="sc-material" class="bg-input border border-line rounded-[4px] text-fg [padding:4px_8px] text-[0.8rem] [.spool-calc-inputs_&]:w-full [.spool-calc-inputs_&]:[padding:6px_10px] [.spool-calc-inputs_&]:text-[14px]">
              ${Object.keys(MATERIALS)
                .map(
                  (m) =>
                    `<option value="${m}"${m === p.material ? ' selected' : ''}>${m} (${MATERIALS[m]} g/cm³)</option>`,
                )
                .join('')}
            </select>
          </div>
          <div class="form-group mb-4 [&_label]:block [&_label]:text-[12px] [&_label]:text-fg-soft [&_label]:mb-1 [&_input]:w-full [&_input]:[padding:8px_12px] [&_input]:bg-input [&_input]:border [&_input]:border-line [&_input]:rounded-chip [&_input]:text-fg [&_input]:text-[14px] [&_input]:[outline:none] [.modal-body_&]:mb-3 [.spool-calc-inputs_&]:[margin-bottom:10px] [&_input:focus]:border-accent last:[.modal-body_&]:mb-0">
            <label for="sc-filament-dia">Filament Diameter</label>
            <select id="sc-filament-dia" class="bg-input border border-line rounded-[4px] text-fg [padding:4px_8px] text-[0.8rem] [.spool-calc-inputs_&]:w-full [.spool-calc-inputs_&]:[padding:6px_10px] [.spool-calc-inputs_&]:text-[14px]">
              <option value="1.75"${p.filamentDiameter === 1.75 ? ' selected' : ''}>1.75 mm</option>
              <option value="2.85"${p.filamentDiameter === 2.85 ? ' selected' : ''}>2.85 mm</option>
            </select>
          </div>

          <div class="spool-calc-density mt-3 text-[11px] text-fg-muted font-mono">
            Density: ${calc.density} g/cm³ · Cross-section: ${(Math.PI * (p.filamentDiameter / 2) ** 2).toFixed(4)} mm²
          </div>
        </div>
      </div>
    </div>
  `;

  // Bind input listeners for live update
  const ids: [string, keyof SpoolParams][] = [
    ['sc-hub-dia', 'hubDiameter'],
    ['sc-flange-dia', 'flangeDiameter'],
    ['sc-width', 'spoolWidth'],
    ['sc-empty-weight', 'emptyWeight'],
    ['sc-full-weight', 'fullWeight'],
    ['sc-current-weight', 'currentWeight'],
  ];

  for (const [elemId, key] of ids) {
    const el = document.getElementById(elemId) as HTMLInputElement | null;
    if (el) {
      el.addEventListener('input', () => {
        const val = parseFloat(el.value);
        if (!isNaN(val) && val >= 0) {
          (p as unknown as Record<string, number>)[key] = val;
          updateCalc(p);
        }
      });
    }
  }

  const matEl = document.getElementById('sc-material') as HTMLSelectElement | null;
  if (matEl) {
    matEl.addEventListener('change', () => {
      p.material = matEl.value;
      updateCalc(p);
    });
  }

  const diaEl = document.getElementById('sc-filament-dia') as HTMLSelectElement | null;
  if (diaEl) {
    diaEl.addEventListener('change', () => {
      p.filamentDiameter = parseFloat(diaEl.value);
      updateCalc(p);
    });
  }

  // Diameter → Weight sync: changing outer diameter auto-calculates currentWeight
  const outerDiaEl = document.getElementById('sc-outer-dia') as HTMLInputElement | null;
  if (outerDiaEl) {
    outerDiaEl.addEventListener('input', () => {
      const val = parseFloat(outerDiaEl.value);
      if (!isNaN(val) && val > 0 && val >= p.hubDiameter) {
        p.currentOuterDiameter = val;
        const mass = outerDiameterToMass(val, p.hubDiameter, p.spoolWidth, p.material);
        p.currentWeight = Math.round(mass + p.emptyWeight);
        const weightEl = document.getElementById('sc-current-weight') as HTMLInputElement | null;
        if (weightEl) weightEl.value = String(p.currentWeight);
        updateCalc(p);
      }
    });
  }
}

function updateCalc(p: SpoolParams): void {
  saveParams(p);
  const calc = calculate(p);

  const svgContainer = document.getElementById('spool-svg-container');
  if (svgContainer) svgContainer.innerHTML = renderSVG(p, calc);

  const metersEl = document.getElementById('sc-meters');
  if (metersEl) metersEl.textContent = calc.lengthM.toFixed(1);

  const fullMetersEl = document.getElementById('sc-full-meters');
  if (fullMetersEl) fullMetersEl.textContent = calc.fullLengthM.toFixed(1);

  const gramsEl = document.getElementById('sc-grams');
  if (gramsEl) gramsEl.textContent = calc.filamentMass.toFixed(0);

  const percentEl = document.getElementById('sc-percent');
  if (percentEl) percentEl.textContent = `${calc.percentRemaining.toFixed(0)}%`;

  // Update density line
  const densityEl = document.querySelector('.spool-calc-density');
  if (densityEl) {
    densityEl.textContent = `Density: ${calc.density} g/cm³ · Cross-section: ${(Math.PI * (p.filamentDiameter / 2) ** 2).toFixed(4)} mm²`;
  }

  // Sync outer diameter display from calculated value (when weight is edited manually)
  const outerDiaEl = document.getElementById('sc-outer-dia') as HTMLInputElement | null;
  if (outerDiaEl && document.activeElement !== outerDiaEl) {
    outerDiaEl.value =
      calc.currentOuterRadius > p.hubDiameter / 2
        ? Math.round(calc.currentOuterRadius * 2).toString()
        : '';
  }
}
