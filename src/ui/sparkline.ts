/**
 * The humidity trace on the dryer panel.
 *
 * Pure geometry, in its own module, because it is the one part of the panel with maths
 * worth asserting — and because the panel re-renders by `innerHTML` every second, so
 * the chart has to be a string rather than a canvas that a re-render would destroy.
 * `ui/charts.ts` is canvas-based and registered by element id; that suits a chart that
 * lives in a stable container, which this does not.
 *
 * ## What the curve is for
 *
 * Moisture leaving filament has to go somewhere, and in a closed chamber it goes into
 * the air. So a session that is working shows humidity RISING for the first stretch and
 * then falling back as it vents — and a flat line from the start means either the
 * filament was already dry or nothing is reaching the sensor. That is the whole reason
 * to draw it: the number alone cannot tell those apart, and the shape can.
 */

export interface Sample {
  t: number;
  v: number;
}

export interface SparklineGeometry {
  /** `M x y L x y …` for the trace, or '' when there is nothing to draw. */
  path: string;
  /** The same points closed to the baseline, for a soft fill under the line. */
  area: string;
  min: number;
  max: number;
  first: number;
  last: number;
}

/**
 * Project samples into an SVG viewBox of `width` × `height`.
 *
 * The Y range is padded and never zero-height: a session where humidity holds at 51%
 * for four hours would otherwise divide by zero and put the line at NaN, which SVG
 * renders as nothing at all — a blank chart that looks like missing data rather than a
 * flat reading.
 */
export function sparklineGeometry(
  samples: Sample[],
  width: number,
  height: number,
  pad = 2,
): SparklineGeometry | null {
  if (samples.length < 2) return null;

  const values = samples.map((s) => s.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const first = values[0];
  const last = values[values.length - 1];

  // A flat trace gets an artificial ±1% window so it draws as a line through the middle.
  const lo = min === max ? min - 1 : min;
  const hi = min === max ? max + 1 : max;

  const t0 = samples[0].t;
  const span = samples[samples.length - 1].t - t0;
  const usableW = width - pad * 2;
  const usableH = height - pad * 2;

  const x = (t: number) => pad + (span === 0 ? usableW : ((t - t0) / span) * usableW);
  const y = (v: number) => pad + usableH - ((v - lo) / (hi - lo)) * usableH;

  const points = samples.map((s) => `${x(s.t).toFixed(1)} ${y(s.v).toFixed(1)}`);
  const path = `M ${points.join(' L ')}`;
  const area = `${path} L ${x(samples[samples.length - 1].t).toFixed(1)} ${height} L ${x(t0).toFixed(1)} ${height} Z`;

  return { path, area, min, max, first, last };
}

/** Samples taken at or after `since`, which is how the trace is scoped to a session. */
export function samplesSince(samples: Sample[], since: number): Sample[] {
  return samples.filter((s) => s.t >= since);
}
