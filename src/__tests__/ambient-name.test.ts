/**
 * Home Assistant names an entity "<device> <kind>", and the dashboard shows it beside an
 * icon that already says the kind, so it read "Efe Temp Temperature". Only a trailing
 * word matching the device class is dropped, and never the whole name.
 */

import { describe, expect, it } from 'bun:test';
import { shortSensorName } from '../ui/ambient';

describe('shortSensorName', () => {
  it('drops the kind the icon already shows', () => {
    expect(shortSensorName('Efe Temp Temperature', 'temperature')).toBe('Efe Temp');
    expect(shortSensorName('Efe Temp Humidity', 'humidity')).toBe('Efe Temp');
  });

  it('ignores case', () => {
    expect(shortSensorName('office HUMIDITY', 'humidity')).toBe('office');
  });

  it('keeps a name that does not end in its kind', () => {
    expect(shortSensorName('Printer enclosure', 'temperature')).toBe('Printer enclosure');
  });

  it('only drops a whole trailing word', () => {
    expect(shortSensorName('Nothumidity', 'humidity')).toBe('Nothumidity');
  });

  it('never leaves an empty name', () => {
    expect(shortSensorName('Temperature', 'temperature')).toBe('Temperature');
  });

  it('keeps the name as it is when there is no device class to go on', () => {
    expect(shortSensorName('Room Temperature', '')).toBe('Room Temperature');
  });
});
