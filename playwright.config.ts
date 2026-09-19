import { existsSync } from 'node:fs';
/**
 * Browser tests.
 *
 * These replace the six suites that ran under `@vitest-environment jsdom`. Everything
 * that does not need a DOM runs under `bun test` instead, which is both faster and one
 * fewer toolchain: vitest is Vite, and removing Vite was the point.
 *
 * The move is not a like-for-like port. jsdom approximates a browser; these run in one.
 * `focus-trap.test.ts` said so itself: *"What jsdom does NOT implement is the native
 * behaviour of the `inert` attribute, so the inert tests assert that the attribute is
 * applied and removed, not that the browser honours it... checked by hand."* Here it is
 * checked by the browser, so that note is gone and the assertion is real.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // Outside `src/__tests__` on purpose: `bun test` claims `*.spec.ts` too, and would
  // try to run these as unit tests. Separate directories keep the two runners from
  // fighting over the same files.
  testDir: 'tests/browser',
  // Every test gets its own page and browser context, and the harness keeps no state, so
  // tests are independent even within a file. (This used to say they shared one page
  // fixture and could not run in parallel. Nothing in tests/browser does that: no
  // `describe.serial`, no `beforeAll`, no shared page.) Checked: 5 runs of the suite x2,
  // fully parallel, 1,120 tests, no failures and nothing flaky.
  fullyParallel: true,
  // Half the cores, not `CI ? 2 : undefined`. The dev container sets CI=1 for an unrelated
  // reason (see `reuseExistingServer`), which pinned local runs to 2 workers on a 12-core
  // machine. Measured there: 2 workers 9.1s, 6 workers 5.8s, 10 workers 6.0s -- past
  // about half the cores, browsers contend for CPU. On a 4-core CI runner this is still 2.
  workers: '50%',
  forbidOnly: !!process.env.CI,
  // Written outside the project when those directories exist, the dev container mounts
  // volumes at `/test-results` and `/playwright-report` precisely so a test run leaves
  // nothing in the checkout. Falls back to the defaults everywhere else.
  outputDir: existsSync('/test-results') ? '/test-results/run' : undefined,
  reporter: process.env.CI
    ? [['github'], ['list']]
    : existsSync('/playwright-report')
      ? [['list'], ['html', { outputFolder: '/playwright-report/html', open: 'never' }]]
      : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5199',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun scripts/test-harness.ts',
    url: 'http://127.0.0.1:5199/ready',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
  },
});
