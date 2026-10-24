import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';

// PW_PORT lets several worktrees run e2e side by side (default 5173, see docs/SPEC.md section 1).
const PORT = Number(process.env.PW_PORT || 5173);
// Run-wide tag so perf tests can find this browser and pin it to CCD0 (tests/perf/pin.mjs
// reads the same variable; workers inherit it).
process.env.RAMBO_PIN_TAG ||= randomBytes(6).toString('hex');
// Same factor as tests/e2e/fixtures.js: CI runners are 5-15x slower (software WebGL, 2 vCPU).
const TIME_SCALE = Number(process.env.E2E_TIME_SCALE || (process.env.CI ? 6 : 1));
// Smaller frame on CI to cut SwiftShader cost; tests size themselves from W/H.
const VIEWPORT = process.env.CI || process.env.E2E_SMALL ? { width: 960, height: 540 } : { width: 1280, height: 720 };

export default defineConfig({
  testDir: 'tests/e2e',
  // testDir already keeps other agents' worktrees (under worktrees/) out of collection.
  // A side run on another PW_PORT gets its own output dir: Playwright cleans outputDir at
  // the start of every run, which would delete a running suite's artifacts.
  outputDir: process.env.PW_PORT && process.env.PW_PORT !== '5173' ? `test-results-${process.env.PW_PORT}` : 'test-results',
  timeout: 60_000 * TIME_SCALE,
  expect: { timeout: 10_000 * TIME_SCALE },
  // Shard by TEST, not by file: per-file sharding left a @perf shard empty (6 tests in 4
  // files). With workers: 1 nothing runs concurrently.
  fullyParallel: true,
  // The game loop is CPU-heavy (software WebGL in headless Chromium).
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // CI also writes JSON so tests/ci/assert-ran.mjs can fail a shard that ran 0 tests.
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: VIEWPORT,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: VIEWPORT,
        launchOptions: {
          // Headless Chromium has no GPU; allow the SwiftShader WebGL fallback.
          args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--rambo-pin-tag=${process.env.RAMBO_PIN_TAG}`],
        },
      },
    },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/game.html`,
    // Never reuse a server already on the port: it may be serving another worktree,
    // which would silently test the wrong code. strictPort makes a busy port fail loudly.
    reuseExistingServer: false,
    timeout: 60_000,
    env: { BROWSER: 'none' },
  },
});
