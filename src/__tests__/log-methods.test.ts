import { describe, expect, it } from 'bun:test';
import { SUB_STATUS_NAMES } from '../types';
import { METHOD_NAMES } from '../ui/log-methods';

// METHOD_NAMES is the most readable list of methods in the repo, so it is where issues
// copy method numbers from. These pin the rows that were corrected, so a later "fix" that
// restores the old labels goes red instead of misleading the next issue.
describe('METHOD_NAMES', () => {
  it('labels 1043 as SetDeviceName, and has no 1060', () => {
    expect(METHOD_NAMES[1043]).toBe('SetDeviceName');
    expect(METHOD_NAMES[1060]).toBeUndefined();
  });

  it('labels capacity once, at 1048', () => {
    expect(METHOD_NAMES[1048]).toBe('GetCapacity');
    const capacity = Object.entries(METHOD_NAMES).filter(([, name]) => name.includes('Capacity'));
    expect(capacity).toEqual([['1048', 'GetCapacity']]);
  });

  it('never gives one operation two numbers', () => {
    const names = Object.values(METHOD_NAMES).map((n) => n.replace(/\?$/, ''));
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    expect(duplicates).toEqual([]);
  });

  it('labels OTA at 1039, not 1064', () => {
    expect(METHOD_NAMES[1039]).toBe('OTAUpgrade');
    expect(METHOD_NAMES[1064]).toBeUndefined();
  });

  it('labels home status at 1006, not 1065', () => {
    expect(METHOD_NAMES[1006]).toBe('GetHomeStatus');
    expect(METHOD_NAMES[1065]).toBeUndefined();
  });

  it('labels fan status at 1004, not 1066', () => {
    expect(METHOD_NAMES[1004]).toBe('GetFanStatus');
    expect(METHOD_NAMES[1066]).toBeUndefined();
  });

  it('labels 1063 as a tentative SetAIDetectionSettings, and names no other row like the auto-report', () => {
    expect(METHOD_NAMES[1063]).toBe('SetAIDetectionSettings?');
    const autoReportLike = Object.entries(METHOD_NAMES).filter(([, name]) =>
      /AutoReport|StatusEvent/.test(name),
    );
    expect(autoReportLike).toEqual([['6000', 'StatusEvent']]);
  });

  it('removes 2010 and 2011, and marks 2007 as unconfirmed', () => {
    expect(METHOD_NAMES[2010]).toBeUndefined();
    expect(METHOD_NAMES[2011]).toBeUndefined();
    expect(METHOD_NAMES[2007]).toBe('SetMonoFilament?');
  });

  // 1064-1066 only: 1061/1062/1063 are deliberately kept as '?'-marked guesses despite
  // colliding with SUB_STATUS_NAMES, because nothing here has seen them answer as methods
  // and removing the rows would delete the only place that could label one if they do.
  // 1064-1066 carry no such uncertainty: they were flat copies of sub-status names.
  it('never reuses the 1064/1065/1066 sub-status numbers as method labels', () => {
    const collisions = Object.keys(METHOD_NAMES)
      .map(Number)
      .filter((n) => n === 1064 || n === 1065 || n === 1066)
      .filter((n) => n in SUB_STATUS_NAMES);
    expect(collisions).toEqual([]);
  });
});
