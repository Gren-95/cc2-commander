#!/usr/bin/env bun
/**
 * Build the frontend into `dist/`, without Vite.
 *
 * Four steps, each doing one job with the tool that does it best:
 *
 *   1. JS      `Bun.build` on `src/main.ts`
 *   2. CSS     `@tailwindcss/cli` on `src/styles/main.css`
 *   3. assets  copy `public/` over `dist/`
 *   4. HTML    rewrite the two dev-time tags to the hashed outputs
 *
 * ## Why not `bun build ./index.html`
 *
 * Bun's HTML entry point does steps 1 and 4 on its own, and is the obvious thing to
 * reach for. It fails here in two ways, one loud and one silent:
 *
 * - **Loud:** it tries to resolve `/manifest.json` and `/icons/icon-192.png` as modules
 *   and errors. Those are `public/` URLs that exist only in the built output.
 * - **Silent, and the reason for this file:** Bun's CSS parser does not understand
 *   Tailwind v4. It emits `warn: invalid @ rule encountered: '@theme'`, drops the
 *   directives, exits 0, and produces a complete-looking `dist/` in which not one
 *   utility class is defined. Measured: `bg-card`, `rounded-xl`, `tabular-nums` and
 *   `inline-flex` all present in the Tailwind CLI's output, all absent from Bun's.
 *
 * A build that fails by handing you an unstyled site is worse than one that stops, so
 * CSS goes through Tailwind's own CLI and the two halves are joined here.
 *
 * ## Content hashes
 *
 * The filenames carry a hash because `spa.ts` serves `/assets/*` as immutable for a
 * year. A stale name is not a cosmetic problem: the service snapshots `dist/` at
 * startup, so a rebuilt asset under the old name would be served from the old snapshot
 * until someone restarted it.
 */

import { fillDesignTokens } from './fill-design-tokens';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const ASSETS = join(DIST, 'assets');

/** Vite's convention, kept so nothing downstream has to learn a new shape. */
function hashed(name: string, ext: string, content: string | Uint8Array): string {
  const hash = createHash('sha256').update(content).digest('base64url').slice(0, 8);
  return `${name}-${hash}.${ext}`;
}

async function buildJs(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(ROOT, 'src/main.ts')],
    target: 'browser',
    minify: true,
    // Written by hand below, because the font assets Bun emits alongside need to keep
    // the paths the CSS refers to.
    naming: '[name]-[hash].[ext]',
    outdir: ASSETS,
    sourcemap: 'none',
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('JS bundle failed');
  }
  const entry = result.outputs.find((o) => o.kind === 'entry-point');
  if (!entry) throw new Error('JS bundle produced no entry point');
  return entry.path.slice(ASSETS.length + 1);
}

async function buildCss(): Promise<string> {
  const out = join(ASSETS, 'index.css');
  const proc = Bun.spawn(
    [
      'bunx',
      '@tailwindcss/cli',
      '-i',
      join(ROOT, 'src/styles/main.css'),
      '-o',
      out,
      '--minify',
    ],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error(await new Response(proc.stderr).text());
    throw new Error('CSS build failed');
  }

  // Tailwind's CLI resolves `@import` but does NOT rewrite `url()` inside what it
  // imported, and copies nothing. `bootstrap-icons.css` refers to
  // `url(./fonts/bootstrap-icons.woff2?<version>)`, relative to the emitted stylesheet,
  // so the fonts have to land at `assets/fonts/` or every icon renders as a blank box.
  // Vite did this rewriting invisibly, which is exactly why it is easy to lose.
  await cp(join(ROOT, 'node_modules/bootstrap-icons/font/fonts'), join(ASSETS, 'fonts'), {
    recursive: true,
  });

  // Tailwind writes a fixed name; hash it afterwards so /assets/* stays immutable.
  const css = await Bun.file(out).text();
  const name = hashed('index', 'css', css);
  await writeFile(join(ASSETS, name), css);
  await rm(out);
  return name;
}

/**
 * Point index.html at the built files.
 *
 * The dev document references `/src/main.ts` and `/src/styles/main.css` directly: a
 * browser cannot run either, which is what a bundler is for. Everything else in the
 * document, including the `public/` URLs, is already correct for production and is left
 * exactly as written.
 */
async function buildHtml(js: string, css: string): Promise<void> {
  let html = fillDesignTokens(await Bun.file(join(ROOT, 'index.html')).text());

  const before = html;
  html = html.replace('<link rel="stylesheet" href="/src/styles/main.css">', `<link rel="stylesheet" href="/assets/${css}">`);
  html = html.replace('<script type="module" src="/src/main.ts"></script>', `<script type="module" src="/assets/${js}"></script>`);
  if (html === before) throw new Error('index.html entry tags not found: did they move?');
  if (html.includes('/src/')) throw new Error('index.html still references /src/ after rewrite');

  await writeFile(join(DIST, 'index.html'), html);
}

const t0 = performance.now();
// Empty dist/, rather than remove and recreate it.
//
// `rm(DIST)` fails with EBUSY when dist/ is a mount point, which it is whenever the
// build runs in a container with a volume mounted there: you cannot unlink a mounted
// directory. Clearing the contents leaves the mount alone and is otherwise identical:
// what matters is that no file from a previous build survives into this one.
await mkdir(DIST, { recursive: true });
for (const entry of await readdir(DIST)) {
  await rm(join(DIST, entry), { recursive: true, force: true });
}
await mkdir(ASSETS, { recursive: true });

const [js, css] = [await buildJs(), await buildCss()];
await cp(join(ROOT, 'public'), DIST, { recursive: true });
await buildHtml(js, css);

// Every url() the stylesheet names must exist, or the failure is a blank glyph at
// runtime rather than a build error.
const cssText = await Bun.file(join(ASSETS, css)).text();
for (const match of cssText.matchAll(/url\((?!data:)['"]?([^'")?]+)/g)) {
  const ref = match[1].replace(/^\.\//, '');
  const target = ref.startsWith('/') ? join(DIST, ref) : join(ASSETS, ref);
  if (!(await Bun.file(target).exists())) {
    throw new Error(`CSS references ${match[1]} but ${target} was not emitted`);
  }
}

const sizes = await Promise.all(
  (await readdir(ASSETS)).map(async (f) => `${f} ${(Bun.file(join(ASSETS, f)).size / 1024).toFixed(1)}kB`),
);
console.log(`✓ built in ${(performance.now() - t0).toFixed(0)}ms`);
for (const s of sizes.sort()) console.log(`  ${s}`);
