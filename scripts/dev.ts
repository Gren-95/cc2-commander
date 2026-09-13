#!/usr/bin/env bun
/**
 * The development loop, replacing `vite` + `concurrently`.
 *
 * Builds `dist/`, starts the service, and rebuilds-and-restarts when anything under
 * `src/` or `index.html` changes. The service serves the built SPA itself, so there is
 * one port (`SERVICE_PORT`, default 8088) rather than vite's 5173 proxying to it — which
 * also means the dev setup now matches production instead of approximating it, and the
 * proxy table for `/ws`, `/api`, `/octoprint` and `/moonraker` is gone with it.
 *
 * ## What is lost, plainly
 *
 * **Hot module replacement.** Vite swapped a changed module into a running page without
 * a reload, keeping dashboard state. This does a full rebuild and restart, so the browser
 * needs a refresh. The rebuild is ~550ms, which is why that is tolerable rather than
 * merely acknowledged.
 *
 * The restart is not optional: `spa.ts` walks `dist/` once at startup by design, so a
 * rebuild without one leaves the service serving filenames that no longer exist — the
 * failure that cost an afternoon on 2026-09-13 and now 404s loudly instead of silently
 * serving HTML as JavaScript.
 */

import { watch } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
/** Coalesce the burst of events an editor's save produces into one rebuild. */
const DEBOUNCE_MS = 120;

let service: Bun.Subprocess | null = null;
let rebuilding = false;
let queued = false;

function startService(): void {
  service = Bun.spawn(['bun', 'src/server/index.ts'], {
    cwd: ROOT,
    stdio: ['inherit', 'inherit', 'inherit'],
    env: process.env,
  });
}

async function stopService(): Promise<void> {
  if (!service) return;
  service.kill();
  await service.exited;
  service = null;
}

async function rebuild(reason: string): Promise<void> {
  if (rebuilding) {
    queued = true;
    return;
  }
  rebuilding = true;
  console.log(`\n· ${reason} — rebuilding`);

  const build = Bun.spawn(['bun', 'scripts/build.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const code = await build.exited;

  if (code !== 0) {
    // Leave the old service running: a syntax error should cost you a refresh, not the
    // dashboard you were looking at.
    console.error('· build failed — the previous build is still being served');
  } else {
    await stopService();
    startService();
  }

  rebuilding = false;
  if (queued) {
    queued = false;
    await rebuild('queued change');
  }
}

await rebuild('initial build');

let timer: ReturnType<typeof setTimeout> | null = null;
const schedule = (file: string) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void rebuild(file), DEBOUNCE_MS);
};

// `src/server/**` is included deliberately: those changes need the restart too, and a
// separate watcher for them would be a second thing to keep in step.
watch(join(ROOT, 'src'), { recursive: true }, (_event, file) => {
  if (file) schedule(file);
});
watch(join(ROOT, 'index.html'), () => schedule('index.html'));

console.log('· watching src/ and index.html — edit and refresh the browser');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void stopService().then(() => process.exit(0));
  });
}
