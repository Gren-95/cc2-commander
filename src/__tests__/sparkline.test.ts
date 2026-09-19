/**
 * The humidity trace's geometry.
 *
 * Every failure here is silent: SVG renders a path containing `NaN` as nothing at all,
 * so the chart simply disappears and looks like missing data rather than a bug.
 */

import { describe, expect, it } from 'bun:test';
import { samplesSince, sparklineGeometry } from '../ui/sparkline';

const at = (mins: number, v: number) => ({ t: mins * 60_000, v });

describe('sparklineGeometry', () => {
  it('needs two points to draw a line', () => {
    expect(sparklineGeometry([], 100, 30)).toBeNull();
    expect(sparklineGeometry([at(0, 50)], 100, 30)).toBeNull();
  });

  it('spans the full width and inverts Y, so higher humidity sits higher', () => {
    const g = sparklineGeometry([at(0, 40), at(10, 60)], 100, 30, 0);
    expect(g).not.toBeNull();
    // First point at x=0 and the LOW value, so near the bottom (y = height).
    expect(g?.path.startsWith('M 0.0 30.0')).toBe(true);
    // Last at full width and the HIGH value, so at the top (y = 0).
    expect(g?.path.endsWith('L 100.0 0.0')).toBe(true);
  });

  it('draws a flat reading as a line rather than nothing', () => {
    // min === max would divide by zero; SVG renders a path with NaN as blank, which
    // reads as "no data" when the truth is "held steady for four hours".
    const g = sparklineGeometry([at(0, 51.4), at(60, 51.4), at(120, 51.4)], 100, 30);
    expect(g?.path).not.toContain('NaN');
    expect(g?.min).toBe(51.4);
    expect(g?.max).toBe(51.4);
  });

  it('survives every sample sharing a timestamp', () => {
    const g = sparklineGeometry([at(5, 40), at(5, 45)], 100, 30);
    expect(g?.path).not.toContain('NaN');
  });

  it('reports the range and the endpoints, which the panel labels', () => {
    const g = sparklineGeometry([at(0, 44), at(1, 58), at(2, 47)], 100, 30);
    expect(g?.min).toBe(44);
    expect(g?.max).toBe(58);
    expect(g?.first).toBe(44);
    expect(g?.last).toBe(47);
  });

  it('closes the area to the baseline so a fill has somewhere to go', () => {
    const g = sparklineGeometry([at(0, 40), at(1, 60)], 100, 30);
    expect(g?.area.endsWith('Z')).toBe(true);
    expect(g?.area.startsWith(g?.path ?? 'x')).toBe(true);
  });
});

describe('samplesSince', () => {
  it('keeps only what a session has seen, including the boundary', () => {
    const all = [at(0, 40), at(10, 45), at(20, 50)];
    expect(samplesSince(all, 10 * 60_000)).toEqual([at(10, 45), at(20, 50)]);
  });

  it('is empty when the session started after every sample', () => {
    expect(samplesSince([at(0, 40)], 99 * 60_000)).toEqual([]);
  });
});
