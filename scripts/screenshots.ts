#!/usr/bin/env bun
/**
 * Screenshots of every view, at every size.
 *
 * Built because checking a layout change meant writing a throwaway Playwright script
 * each time, and because "it looks cramped on my phone" is not something a gate can
 * tell you. `bun run gates` says so itself: *no browser and no screenshot*.
 *
 *   bun scripts/screenshots.ts                      every view, every viewport
 *   bun scripts/screenshots.ts --viewport phone     one size
 *   bun scripts/screenshots.ts --view tools/dryer   one view
 *   bun scripts/screenshots.ts --cards              each dashboard card on its own
 *   bun scripts/screenshots.ts --url http://host:8088 --out ./shots
 *   bun scripts/screenshots.ts --password hunter2           when auth is on
 *   bun scripts/screenshots.ts --readme                     the README's pictures, light and dark
 *
 * Navigation goes through `?tab=`/`?subtab=`, not by clicking: a deep link lands on the
 * view in one load, with no guessing about when a click has finished. That is half the
 * reason those parameters exist.
 *
 * NOT part of `bun run gates`. It needs a running service with a real printer behind it,
 * and it asserts nothing: it produces pictures for a person to look at. A gate that
 * needs a printer is a gate that fails on every machine that does not have one.
 */

import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';

/** Sizes worth checking, and why each one. */
const VIEWPORTS = {
  // Below 700px the dashboard becomes the one-card focus rail: a different layout,
  // not a narrower one, so it has to be looked at separately.
  phone: { width: 390, height: 844, label: 'iPhone-ish, focus rail' },
  tablet: { width: 820, height: 1180, label: 'iPad-ish, two columns' },
  desktop: { width: 1440, height: 1000, label: 'the usual' },
  wide: { width: 1920, height: 1080, label: 'four columns' },
} as const;

/** Every view the app has, addressed by deep link. */
const VIEWS = [
  { name: 'dashboard', query: '' },
  { name: 'tools-dryer', query: '?tab=tools&subtab=dryer' },
  { name: 'tools-spool', query: '?tab=tools&subtab=spool' },
  { name: 'tools-stats', query: '?tab=tools&subtab=stats' },
  { name: 'settings', query: '?tab=settings' },
  { name: 'help-about', query: '?tab=help&subtab=about' },
  { name: 'help-help', query: '?tab=help&subtab=help' },
  { name: 'help-debug', query: '?tab=help&subtab=debug' },
] as const;

const args = process.argv.slice(2);
const flag = (name: string, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};
const has = (name: string) => args.includes(`--${name}`);

const BASE = flag('url', 'http://localhost:8088').replace(/\/+$/, '');
const OUT = flag('out', existsSync('/test-results') ? '/test-results/screenshots' : 'screenshots');
const ONLY_VIEWPORT = flag('viewport');
const ONLY_VIEW = flag('view').replace('/', '-');

/**
 * Wait for the dashboard to have real data.
 *
 * `networkidle` is not enough: this app opens a WebSocket and keeps it open, so the
 * network is never idle in the way Playwright means, and the first status frame arrives
 * after load. Shooting too early gets a page full of `--`.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  // As a string, not a closure: this file is typechecked by `tsconfig.server.json`,
  // which has no DOM lib, so a callback mentioning `document` fails the gate even
  // though it only ever runs in the browser.
  await page
    .waitForFunction(
      `(() => {
        const el = document.getElementById('temp-nozzle');
        // Either the dashboard has numbers, or this is not the dashboard.
        return !el || (el.textContent || '').trim() !== '--';
      })()`,
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => {
      // A service with no printer behind it never fills in. Shoot it anyway: an empty
      // dashboard is a legitimate thing to want a picture of.
    });
  // Charts animate in and the segmented fills measure themselves a frame late.
  await page.waitForTimeout(1200);

  // Toasts are transient overlays that sit on top of whatever the shot is of, and the
  // connect toast names the printer's serial, which is not something to publish in a
  // README. Clearing them is right for every screenshot, not just the documented ones.
  await page.evaluate(
    `(() => {
      const c = document.getElementById('toast-container');
      if (c) c.innerHTML = '';
    })()`,
  );
}

/**
 * Sign in once, and hand every later context the resulting cookie.
 *
 * Without this the script photographs the login card (correctly, and uselessly) for
 * every view and every viewport, because `AUTH_PASSWORD` turns the whole app into one
 * overlay. That is exactly what it did between auth landing and this function existing.
 *
 * The password comes from `--password` or `AUTH_PASSWORD`, which is already in the
 * environment of the dev container this usually runs in. Returning `undefined` is the
 * no-auth case, not a failure: a service with auth off shows the dashboard immediately
 * and needs no cookie.
 */
type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

async function signIn(browser: Browser): Promise<StorageState | undefined> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

  const field = page.locator('input[type="password"]').first();
  // A visible password field is the only reliable "auth is on" signal: /api/health
  // answers the same whether or not a password is set.
  if (!(await field.isVisible().catch(() => false))) {
    await context.close();
    return undefined;
  }

  const password = flag('password', process.env.AUTH_PASSWORD ?? '');
  if (!password) {
    await context.close();
    throw new Error(
      'This service wants a password. Pass --password <pw>, or set AUTH_PASSWORD.',
    );
  }

  await field.fill(password);
  await page.locator('button:has-text("Sign in")').first().click();
  // The field is hidden rather than removed, so waiting for it to disappear from the
  // DOM waits forever, which is how the login page ended up in the screenshots.
  await field.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {
    throw new Error('Sign-in did not take: wrong password, or the service refused it.');
  });

  const state = await context.storageState();
  await context.close();
  return state;
}

const THEMES = ['light', 'dark'] as const;

/**
 * The three pictures the README shows, once per theme, into `docs/images/`.
 *
 * They are viewport-sized rather than full-page (a README picture is a front door, not
 * an inventory) which is why the general mode above cannot make them, and why they used
 * to be cropped by hand. Each name becomes `<name>-<theme>.png`, and the README picks
 * between the pair with `prefers-color-scheme`.
 *
 * The theme is forced through the browser's colour scheme rather than by writing the
 * `theme` setting: the app's default is `auto`, which is what a visitor gets, and
 * `index.html` resolves it from `prefers-color-scheme` before the bundle runs. The shot
 * is checked against `data-theme` afterwards, because a dark picture that is really the
 * light theme would ship without anyone noticing.
 *
 * Read-only against the service: page loads, no commands. It does not press Start on the
 * dryer: it photographs the form.
 */
async function readmeShots(): Promise<void> {
  const out = flag('out', 'docs/images');
  await mkdir(out, { recursive: true });

  const browser = await chromium.launch();
  const storageState = await signIn(browser);

  for (const theme of THEMES) {
    const shoot = async (
      name: string,
      viewport: { width: number; height: number },
      query: string,
      take: (page: Page, file: string) => Promise<void>,
    ): Promise<void> => {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 2,
        colorScheme: theme,
        storageState,
      });
      const page = await context.newPage();
      await page.goto(`${BASE}/${query}`, { waitUntil: 'domcontentloaded' });
      await settle(page);

      const applied = await page.evaluate(`document.documentElement.getAttribute('data-theme')`);
      if (applied !== theme) {
        throw new Error(`Asked for the ${theme} theme but the page rendered ${applied}.`);
      }

      const file = join(out, `${name}-${theme}.png`);
      await take(page, file);
      console.log(`  ${file}`);
      await context.close();
    };

    await shoot('dashboard', { width: 1440, height: 1000 }, '', async (page, path) => {
      await page.screenshot({ path });
    });

    // The rail opens on the print-status card, which on an idle printer is two thirds
    // empty. Temperatures fills the screen and shows what the phone layout is for.
    await shoot('phone', { width: 390, height: 844 }, '', async (page, path) => {
      await page.locator('#mobile-focus-rail button[data-focus="temps-card"]').click();
      await page.waitForTimeout(400);
      await page.screenshot({ path });
    });

    // A strip of the Tools tab: from the sub-tab strip down to the Start button, at a
    // width where the form is not stretched across a whole monitor.
    await shoot('filament-dryer', { width: 1100, height: 900 }, '?tab=tools&subtab=dryer', async (page, path) => {
      const strip = await page.locator('[data-subtab-group="tools"]').boundingBox();
      const start = await page.locator('#dryer-start').boundingBox();
      if (!strip || !start) {
        throw new Error(
          'The dryer form is not showing: a session may be running, which is a different picture.',
        );
      }
      // 16px above, not more: the sticky header's bottom border sits just over the strip
      // and reads as a stray line at the top of the picture if the clip reaches it.
      const top = Math.max(0, strip.y - 16);
      await page.screenshot({
        path,
        clip: { x: 0, y: top, width: 1100, height: start.y + start.height + 24 - top },
      });
    });
  }

  await browser.close();
}

async function main(): Promise<void> {
  if (has('readme')) return readmeShots();

  await rm(OUT, { recursive: true, force: true });

  const viewports = Object.entries(VIEWPORTS).filter(
    ([name]) => !ONLY_VIEWPORT || name === ONLY_VIEWPORT,
  );
  const views = VIEWS.filter((v) => !ONLY_VIEW || v.name === ONLY_VIEW);
  if (!viewports.length) throw new Error(`Unknown viewport. Try: ${Object.keys(VIEWPORTS).join(', ')}`);
  if (!views.length) throw new Error(`Unknown view. Try: ${VIEWS.map((v) => v.name).join(', ')}`);

  const browser = await chromium.launch();
  const storageState = await signIn(browser);
  let count = 0;

  for (const [vpName, vp] of viewports) {
    const dir = join(OUT, vpName);
    await mkdir(dir, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2, // legible when someone opens the PNG at 100%
      storageState,
    });
    const page = await context.newPage();

    for (const view of views) {
      await page.goto(`${BASE}/${view.query}`, { waitUntil: 'domcontentloaded' });
      await settle(page);
      const file = join(dir, `${view.name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`  ${file}`);
      count++;

      // One picture per card, from the dashboard only: a full-page shot of fifteen
      // cards is where a cramped one hides.
      if (has('cards') && view.name === 'dashboard') {
        // Below 700px the dashboard is a focus rail showing ONE card, so `:visible`
        // finds exactly one. The rail's "All" button restores the scrolling grid, which
        // is the only way to photograph every card at a phone's width, and a phone's
        // width is where cramped layouts live.
        const all = page.locator('#mobile-focus-rail button[aria-label="Show all cards"]');
        if (await all.count()) {
          await all.first().click();
          await page.waitForTimeout(400);
        }
        const cards = await page.locator('.card:visible').all();
        for (const card of cards) {
          const id = (await card.getAttribute('id')) ?? 'card';
          await card.scrollIntoViewIfNeeded();
          await page.waitForTimeout(120);
          const cardFile = join(dir, `card-${id}.png`);
          await card.screenshot({ path: cardFile }).catch(() => {});
          console.log(`  ${cardFile}`);
          count++;
        }
      }
    }
    await context.close();
  }

  await browser.close();
  console.log(`\n${count} screenshots in ${OUT}/`);
}

await main();
