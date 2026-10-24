import { defineConfig, devices } from '@playwright/test';

const PORT = 5173;

export default defineConfig({
  testDir: 'tests/e2e',
  // testDir already keeps other agents' worktrees (under worktrees/) out of collection.
  outputDir: 'test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // The game loop is CPU-heavy (software WebGL in headless Chromium).
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 720 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        launchOptions: {
          // Headless Chromium has no GPU; allow the SwiftShader WebGL fallback.
          args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
        },
      },
    },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/game.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { BROWSER: 'none' },
  },
});
