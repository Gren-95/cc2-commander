import { describe, expect, it } from 'bun:test';
import { ensureShadable } from '../ui/color-shading';

/**
 * The gcode-preview library's tube shader is purely multiplicative
 * (`finalColor = uColor * (diff + ambient) * brightness`) so a black or near-black
 * filament rendered as a flat, shapeless silhouette: there is nothing for the light to
 * multiply. `ensureShadable` lifts the color's minimum brightness before it reaches the
 * renderer, so the shading actually shows.
 */
describe('ensureShadable', () => {
  it('lifts true black to a plainly visible mid grey, since there is no hue to preserve', () => {
    expect(ensureShadable('000000')).toBe('#666666');
  });

  it('lifts a dark hue while keeping its color, not flattening it to grey', () => {
    // Dark navy: only the blue channel is non-zero.
    const lifted = ensureShadable('00001a');
    expect(lifted).toMatch(/^#0000[0-9a-f]{2}$/);
    const blue = parseInt(lifted.slice(5, 7), 16);
    expect(blue).toBeGreaterThan(0x1a);
  });

  it('leaves an already-bright color untouched', () => {
    expect(ensureShadable('2196f3')).toBe('#2196f3');
  });

  it('leaves white untouched', () => {
    expect(ensureShadable('ffffff')).toBe('#ffffff');
  });

  it('accepts a leading #', () => {
    expect(ensureShadable('#000000')).toBe('#666666');
  });
});
