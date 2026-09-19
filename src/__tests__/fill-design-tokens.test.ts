/**
 * index.html cannot import the design tokens, so the build fills `{{NAME}}` in from
 * `src/ui/design.ts`. What matters: the real document fills completely, the selected tab is
 * the state table's delta applied (not a copy that can drift), and a typo stops the build
 * instead of shipping `{{…}}` as a class name.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fillDesignTokens } from '../../scripts/fill-design-tokens';
import { CARD_SHELL, FAN_RANGE, MAIN_TAB } from '../ui/design';
import { STATE_UTILITIES } from '../ui/state-utilities';

describe('fillDesignTokens', () => {
  it('fills a token', () => {
    expect(fillDesignTokens('<div class="{{CARD_SHELL}}">')).toBe(`<div class="${CARD_SHELL}">`);
  });

  it('derives a state from the state table rather than copying it', () => {
    const active = fillDesignTokens('{{MAIN_TAB active}}').split(' ');
    const delta = STATE_UTILITIES.active['main-tab'];
    expect(active.slice(0, 2)).toEqual(['main-tab', 'active']);
    for (const c of delta.add.split(' ')) expect(active).toContain(c);
    for (const c of delta.remove.split(' ')) expect(active).not.toContain(c);
  });

  it('stops on a name design.ts does not export', () => {
    expect(() => fillDesignTokens('{{NOT_A_TOKEN}}')).toThrow(/NOT_A_TOKEN/);
  });

  it('stops on a state the table has no delta for', () => {
    expect(() => fillDesignTokens('{{MAIN_TAB sideways}}')).toThrow(/sideways/);
  });

  it('stops on anything left half-written', () => {
    expect(() => fillDesignTokens('{{ lower }}')).toThrow(/could not fill/);
  });
});

describe('the real index.html', () => {
  const raw = readFileSync(join(import.meta.dir, '../../index.html'), 'utf8');
  const filled = fillDesignTokens(raw);

  it('fills completely', () => {
    expect(filled).not.toContain('{{');
  });

  it('writes each repeated element once, as a token', () => {
    expect(raw.split('{{CARD_SHELL}}').length - 1).toBe(12);
    expect(raw.split('{{FAN_RANGE}}').length - 1).toBe(3);
    expect(raw.split('{{MAIN_TAB').length - 1).toBe(4);
    // …and does not also carry a literal copy of what the tokens stand for.
    for (const t of [CARD_SHELL, FAN_RANGE, MAIN_TAB]) expect(raw).not.toContain(t);
  });
});
