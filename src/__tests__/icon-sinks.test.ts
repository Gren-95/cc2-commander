/**
 * `icon()` and `iconSolo()` return HTML. That is only right where HTML is understood.
 *
 * A canvas paints exactly the characters it is given, `textContent` and attributes are text,
 * and a toast or a native dialog shows what it is handed. Put an icon in any of them and the
 * markup itself appears on screen, which is what the charts did, drawing
 * `<i class="bi bi-search …">` across their top edge whenever they were zoomed. It came in
 * with the sweep that replaced emoji (which are text, and so worked in all of these) with
 * icons, and nothing looked at the places where an emoji had been fine.
 *
 * This reads the source, whole statements at a time: the bug it exists for spanned several
 * lines, and a check that looks one line at a time does not see it.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Places that show text, not markup. */
const TEXT_SINKS = [
  /fillText\(/g,
  /strokeText\(/g,
  /\.textContent\s*=/g,
  /\.innerText\s*=/g,
  /\.(?:title|alt|placeholder|ariaLabel)\s*=/g,
  /setAttribute\(/g,
  /\btoast\(/g,
  /\b(?:confirm|alert|prompt)\(/g,
  /document\.title\s*=/g,
  /new Notification\(/g,
];

const ICON_CALL = /\b(?:icon|iconSolo)\(/;
/** Longer than this is a runaway match, not one statement. */
const MAX_STATEMENT = 600;

/** Every `sink(…)` statement in `source` whose text contains an icon call. */
export function iconsInTextSinks(source: string): { line: number; statement: string }[] {
  const found: { line: number; statement: string }[] = [];
  for (const sink of TEXT_SINKS) {
    for (const match of source.matchAll(sink)) {
      const start = match.index ?? 0;
      const end = source.indexOf(';', start);
      const statement = source.slice(start, end === -1 ? start + MAX_STATEMENT : end);
      if (statement.length > MAX_STATEMENT || !ICON_CALL.test(statement)) continue;
      found.push({
        line: source.slice(0, start).split('\n').length,
        statement: statement.replace(/\s+/g, ' ').slice(0, 120),
      });
    }
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/**
 * `${expr}` as text, for fixtures that are source code. Built in two pieces because the
 * linter flags a placeholder inside an ordinary string, which is exactly what these are not.
 */
const ph = (expr: string) => `$` + `{${expr}}`;

describe('the check itself', () => {
  // A guard that cannot see the bug it guards against is worse than none, so it is shown
  // the exact shapes that matter, including the multi-line one a per-line check misses.
  it('sees an icon drawn onto a canvas, across several lines', () => {
    const source = `
      ctx.fillText(
        \`\${icon('singleLayer')} \${zoomLabel} (dblclick to reset)\`,
        PADDING.left + 4,
        PADDING.top + 2,
      );`;
    expect(iconsInTextSinks(source)).toHaveLength(1);
  });

  it.each([
    ['textContent', `el.textContent = \`${ph("icon('ok')")} Saved\`;`],
    ['a title property', "btn.title = iconSolo('close');"],
    ['setAttribute', `el.setAttribute('aria-label', \`${ph("icon('add')")} Add\`);`],
    ['a toast', `toast(\`${ph("icon('ok')")} Done\`, 'success');`],
    ['a native dialog', `if (!confirm(\`${ph("icon('warning')")} Sure?\`)) return;`],
  ])('sees an icon in %s', (_name, source) => {
    expect(iconsInTextSinks(source)).toHaveLength(1);
  });

  it('leaves alone an icon that goes where markup is understood', () => {
    expect(iconsInTextSinks(`el.innerHTML = \`${ph("icon('ok')")} Saved\`;`)).toEqual([]);
    expect(iconsInTextSinks(`ctx.fillText(\`${ph('value')}°\`, x, y);`)).toEqual([]);
  });
});

describe('the app', () => {
  const root = join(import.meta.dir, '..');

  it('puts no icon into something that shows text', () => {
    const problems = sourceFiles(root).flatMap((file) =>
      iconsInTextSinks(readFileSync(file, 'utf8')).map(
        (hit) => `${file.replace(`${root}/`, 'src/')}:${hit.line}  ${hit.statement}`,
      ),
    );
    expect(problems).toEqual([]);
  });
});
