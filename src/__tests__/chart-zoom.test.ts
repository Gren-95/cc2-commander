/**
 * How a chart is zoomed, and what it says when it is.
 *
 * Both halves came from real complaints: the wheel used to be swallowed by every chart
 * (an ordinary page scroll zoomed the chart to 10× and stopped the page moving), and the
 * label shown while zoomed rendered its own markup as text across the top of the chart.
 */

import { describe, expect, it } from 'bun:test';
import { MAX_ZOOM, MIN_ZOOM, wheelZoom, zoomIndicator } from '../ui/chart-zoom';

const wheel = (deltaY: number, mods: { ctrlKey?: boolean; metaKey?: boolean } = {}) => ({
  deltaY,
  ctrlKey: false,
  metaKey: false,
  ...mods,
});

describe('wheelZoom', () => {
  it('leaves an ordinary wheel to the page, in either direction', () => {
    expect(wheelZoom(1, wheel(120))).toBeNull();
    expect(wheelZoom(1, wheel(-120))).toBeNull();
  });

  it('leaves a wheel alone even on a chart that is already zoomed', () => {
    expect(wheelZoom(6, wheel(-120))).toBeNull();
  });

  it('zooms in on Ctrl + wheel up, and out on Ctrl + wheel down', () => {
    expect(wheelZoom(1, wheel(-120, { ctrlKey: true }))).toBeCloseTo(1.25);
    expect(wheelZoom(1, wheel(120, { ctrlKey: true }))).toBeCloseTo(0.8);
  });

  it('treats ⌘ the same as Ctrl', () => {
    expect(wheelZoom(1, wheel(-120, { metaKey: true }))).toBeCloseTo(1.25);
  });

  it('is what a trackpad pinch arrives as: a wheel with ctrlKey set', () => {
    expect(wheelZoom(2, wheel(-4, { ctrlKey: true }))).toBeCloseTo(2.5);
  });

  it('never goes past the limits, however many notches', () => {
    let z = 1;
    for (let i = 0; i < 40; i++) z = wheelZoom(z, wheel(-120, { ctrlKey: true })) ?? z;
    expect(z).toBe(MAX_ZOOM);
    for (let i = 0; i < 80; i++) z = wheelZoom(z, wheel(120, { ctrlKey: true })) ?? z;
    expect(z).toBe(MIN_ZOOM);
  });

  it('does not treat sideways movement as "zoom in"', () => {
    // deltaY of 0 used to fall through to the zoom-in branch.
    expect(wheelZoom(1, wheel(0, { ctrlKey: true }))).toBeNull();
  });
});

describe('zoomIndicator', () => {
  it('says the zoom and how to get back', () => {
    expect(zoomIndicator(10, 0)).toBe('10.0x · double-click to reset');
  });

  it('says how far back a panned chart is looking', () => {
    expect(zoomIndicator(1, -30_000)).toBe('1.0x · 30s back · double-click to reset');
  });

  it('is plain text: it is drawn on a canvas, which paints markup literally', () => {
    for (const [zoom, pan] of [
      [10, 0],
      [0.1, 0],
      [3.5, -125_000],
      [1, -1000],
    ] as const) {
      const text = zoomIndicator(zoom, pan);
      expect(text, `zoom ${zoom}, pan ${pan}`).not.toMatch(/[<>&]/);
      expect(text).not.toContain('class=');
    }
  });
});
