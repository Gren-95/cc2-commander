/**
 * Parsing what Home Assistant actually returns.
 *
 * `state` is a STRING for every entity, including numeric ones, and an entity that is
 * offline reports the literal `"unavailable"` rather than failing the request. Both are
 * ordinary, and both must come back as "no reading" instead of `NaN` on a dashboard.
 */

import { describe, expect, it } from 'bun:test';
import { parseEntity, parseEntityList } from '../home-assistant.js';

const entity = (over: Record<string, unknown> = {}) => ({
  entity_id: 'sensor.room_humidity',
  state: '43.2',
  last_changed: '2026-09-13T18:00:00.000000+00:00',
  attributes: {
    friendly_name: 'Room humidity',
    unit_of_measurement: '%',
    device_class: 'humidity',
  },
  ...over,
});

describe('parseEntity', () => {
  it('reads a numeric sensor', () => {
    expect(parseEntity(entity())).toEqual({
      entityId: 'sensor.room_humidity',
      name: 'Room humidity',
      value: 43.2,
      unit: '%',
      deviceClass: 'humidity',
      changedAt: '2026-09-13T18:00:00.000000+00:00',
    });
  });

  it('returns nothing for the states an offline sensor reports', () => {
    // These are values, not errors — the request succeeds and carries them.
    for (const state of ['unavailable', 'unknown', '']) {
      expect(parseEntity(entity({ state }))).toBeNull();
    }
  });

  it('returns nothing for a non-numeric state rather than NaN', () => {
    // `binary_sensor` and friends report 'on'/'off'. Number('on') is NaN, and NaN
    // rendered into a dashboard reads as a broken sensor rather than a wrong entity.
    expect(parseEntity(entity({ state: 'on' }))).toBeNull();
    expect(parseEntity(entity({ state: null }))).toBeNull();
  });

  it('falls back to the entity id when there is no friendly name', () => {
    const r = parseEntity(entity({ attributes: {} }));
    expect(r?.name).toBe('sensor.room_humidity');
    expect(r?.unit).toBe('');
    expect(r?.deviceClass).toBe('');
  });

  it('survives a body that is not an entity at all', () => {
    for (const body of [null, undefined, 'nope', 42, {}, { entity_id: '' }]) {
      expect(parseEntity(body)).toBeNull();
    }
  });

  it('keeps a negative reading, which an outdoor sensor will have', () => {
    expect(parseEntity(entity({ state: '-7.5' }))?.value).toBe(-7.5);
  });
});

describe('parseEntityList', () => {
  it('splits on commas and whitespace, and drops the gaps', () => {
    expect(parseEntityList('sensor.a, sensor.b\nsensor.c')).toEqual([
      'sensor.a',
      'sensor.b',
      'sensor.c',
    ]);
    expect(parseEntityList('  sensor.a ,, ')).toEqual(['sensor.a']);
  });

  it('is empty for an unset variable, which is what makes the integration optional', () => {
    expect(parseEntityList('')).toEqual([]);
  });
});
