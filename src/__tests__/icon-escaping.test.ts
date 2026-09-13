/**
 * Icons are markup, so they must not travel inside a value that will be escaped.
 *
 * `icon()` and `iconSolo()` return HTML strings. The repo already states the rule for
 * one direction — use `iconText()` rather than `innerHTML` when the surrounding text is
 * a filename or a printer error, or a crafted filename becomes script execution. This
 * file guards the *other* direction, which had no rule and shipped a bug:
 *
 *     compactPayload() returned `${icon('ok')} OK`
 *     renderSlogRow() rendered  `${highlightMatch(summary)}`
 *     highlightMatch()  calls   escapeHtml(text)
 *
 * so every successful response in the MQTT log drew the literal text
 * `<i class="bi bi-check-circle-fill …"></i> OK` across the row. Nothing threw, nothing
 * looked wrong in the source, and no gate could see it.
 *
 * A source scan rather than a render test on purpose: the shape is textual, it can
 * appear in any module, and the cost of checking every file is a few milliseconds.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(import.meta.dirname, '..', 'ui');

function sources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const name of readdirSync(UI)) {
    const path = join(UI, name);
    if (!name.endsWith('.ts') || statSync(path).isDirectory()) continue;
    out.push({ file: name, text: readFileSync(path, 'utf8') });
  }
  return out;
}

/** Blank out comments while KEEPING the line count, so offenders report a real line. */
function code(text: string): string {
  const blankLines = (m: string) => m.replace(/[^\n]/g, ' ');
  return text.replace(/\/\*[\s\S]*?\*\//g, blankLines).replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Every icon call that sits *inside the arguments* of an escaping call.
 *
 * The distinction is the whole point. `${icon('ok')} ${escapeHtml(text)}` is correct and
 * common — the glyph is markup, the text beside it is escaped. `escapeHtml(\`${icon('ok')}
 * OK\`)` is the bug. A line-contains-both check calls eleven correct sites wrong, so this
 * walks to the matching close paren instead.
 */
function iconsInsideEscaping(text: string): number[] {
  const lines: number[] = [];
  const call = /\b(?:escapeHtml|highlightMatch)\s*\(/g;
  for (let m = call.exec(text); m; m = call.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    const args = text.slice(m.index + m[0].length, i);
    if (/\bicon(?:Solo)?\s*\(/.test(args)) {
      lines.push(text.slice(0, m.index).split('\n').length);
    }
  }
  return lines;
}

describe('icons never cross an escaping boundary', () => {
  it('has sources to scan at all', () => {
    // Guard the guard: a bad path would make every assertion below pass vacuously.
    const files = sources();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.file === 'structured-log.ts')).toBe(true);
  });

  it('never escapes a value built from an icon', () => {
    const offenders: string[] = [];
    for (const { file, text } of sources()) {
      for (const line of iconsInsideEscaping(code(text))) offenders.push(`${file}:${line}`);
    }
    expect(offenders).toEqual([]);
  });

  it('never assigns an icon to textContent', () => {
    // The documented half of the rule: `iconText()` exists for exactly this, because a
    // glyph assigned as text is at best a stray `<i>` on screen and at worst the reason
    // someone reaches for innerHTML on a line that interpolates a filename.
    const offenders: string[] = [];
    for (const { file, text } of sources()) {
      for (const [i, line] of code(text).split('\n').entries()) {
        if (!/\.textContent\s*=/.test(line)) continue;
        if (/\bicon(?:Solo)?\s*\(/.test(line)) offenders.push(`${file}:${i + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('still catches the shape it was written for, and spares the correct one', () => {
    // The scan is only worth having if it fails on the original bug and passes on the
    // eleven sites that emit a glyph beside separately-escaped text.
    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: these are source
    // fixtures — the scan's input is other people's code, so the placeholders have to
    // survive as literal text rather than being interpolated here.
    const bug = "return escapeHtml(`${icon('ok')} OK`);";
    const fine = "html += `<span>${icon('ok')} ${escapeHtml(subInfo.text)}</span>`;";
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of fixtures
    expect(iconsInsideEscaping(bug)).toEqual([1]);
    expect(iconsInsideEscaping(fine)).toEqual([]);
  });
});
