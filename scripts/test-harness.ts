#!/usr/bin/env bun
/**
 * Serves the UI modules to the browser tests.
 *
 * The suites under `src/__tests__/browser` exercise modules that manipulate the DOM, so
 * the module has to reach a real page. This bundles the ones under test into one ESM
 * file exposing them on `window.T`, and serves it next to a blank document.
 *
 * Rebuilt on every request rather than once at startup: the run takes ~200ms and a stale
 * bundle would fail in a way that looks like a broken test rather than a stale build,
 * the exact confusion the SPA route table caused in production.
 */

import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** What the browser suites import. Keep in step with their `T.` references. */
const EXPOSED = {
  focusTrap: 'src/ui/focus-trap.ts',
  listControls: 'src/ui/list-controls.ts',
  relativeTime: 'src/ui/relative-time.ts',
  serviceStatus: 'src/ui/service-status.ts',
  about: 'src/ui/about.ts',
  uiSettings: 'src/ui/ui-settings.ts',
  storageMigration: 'src/ui/storage-migration.ts',
  dryerPanel: 'src/ui/dryer-panel.ts',
  printDialog: 'src/ui/print-dialog.ts',
  lightSwitches: 'src/ui/light-switches.ts',
  charts: 'src/ui/charts.ts',
  chartStore: 'src/chart-store.ts',
  segmented: 'src/ui/segmented.ts',
  stepper: 'src/ui/stepper.ts',
  stateClasses: 'src/ui/state-classes.ts',
  canvas: 'src/ui/canvas.ts',
  files: 'src/ui/files.ts',
  fileBrowsing: 'src/ui/file-browsing.ts',
  busyGuard: 'src/ui/busy-guard.ts',
  fileActions: 'src/ui/file-actions.ts',
  deepLink: 'src/ui/deep-link.ts',
};

async function bundle(): Promise<string> {
  const entry = `${Object.entries(EXPOSED)
    .map(([name, path]) => `import * as ${name} from '${join(ROOT, path)}';`)
    .join('\n')}
globalThis.T = { ${Object.keys(EXPOSED).join(', ')} };
// Signals readiness; the fixture waits on it rather than on an arbitrary timeout.
globalThis.__ready = true;`;

  const result = await Bun.build({
    entrypoints: ['./harness-entry.ts'],
    target: 'browser',
    // The entry exists only in memory, there is no file to keep in sync with EXPOSED.
    plugins: [
      {
        name: 'virtual-entry',
        setup(build) {
          build.onResolve({ filter: /^\.\/harness-entry\.ts$/ }, () => ({
            path: 'harness-entry.ts',
            namespace: 'virtual',
          }));
          build.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({
            contents: entry,
            loader: 'ts',
          }));
        },
      },
    ],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('harness bundle failed');
  }
  return await result.outputs[0].text();
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>harness</title></head>
<body><script type="module" src="/harness.js"></script></body></html>`;

Bun.serve({
  port: 5199,
  hostname: '127.0.0.1',
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === '/ready') return new Response('ok');
    if (pathname === '/harness.js') {
      return new Response(await bundle(), {
        headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' },
      });
    }
    return new Response(PAGE, { headers: { 'Content-Type': 'text/html' } });
  },
});

console.log('test harness on http://127.0.0.1:5199');
