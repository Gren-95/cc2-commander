import * as design from '../src/ui/design';
import { STATE_UTILITIES } from '../src/ui/state-utilities';

/**
 * Fill `{{NAME}}` and `{{NAME state}}` in index.html from `src/ui/design.ts`.
 *
 * The render modules import the design tokens; index.html cannot, so it used to carry them
 * literally, one copy per element: twelve identical card wrappers, three tabs, three fan
 * sliders, each several hundred characters, free to drift apart. `{{NAME state}}` is the
 * token after that state's delta from `state-classes.ts` (the tab that starts selected),
 * so it is derived, never copied. An unknown name or state stops the build rather than
 * shipping a literal `{{…}}` as a class.
 */
export function fillDesignTokens(html: string): string {
  const out = html.replace(/\{\{\s*([A-Z][A-Z_]*)(?:\s+([a-z][\w-]*))?\s*\}\}/g, (_m, name: string, state?: string) => {
    const token = (design as Record<string, unknown>)[name];
    if (typeof token !== 'string') throw new Error(`index.html asks for {{${name}}}, which src/ui/design.ts does not export`);
    if (!state) return token;
    const classes = token.split(/\s+/);
    const delta = STATE_UTILITIES[state]?.[classes[0]];
    if (!delta) throw new Error(`index.html asks for {{${name} ${state}}}, which has no '${state}' delta for .${classes[0]}`);
    const removed = new Set(delta.remove.split(/\s+/).filter(Boolean));
    return [classes[0], state, ...classes.slice(1).filter((c) => !removed.has(c)), ...delta.add.split(/\s+/)].join(' ');
  });
  if (/\{\{/.test(out)) throw new Error('index.html has a {{…}} the build could not fill');
  return out;
}
