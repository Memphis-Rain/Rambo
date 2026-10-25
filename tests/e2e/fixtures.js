import { test as base, expect } from '@playwright/test';

// Wall-clock budget multiplier. CI runners (2 vCPU, software WebGL) run the game
// 5-15x slower than a dev machine, and dt is clamped at 0.05 s, so game time can
// fall far behind wall time there. Tests wait on game state; timeouts use T().
export const TIME_SCALE = Number(process.env.E2E_TIME_SCALE || (process.env.CI ? 6 : 1));
export const T = (ms) => Math.round(ms * TIME_SCALE);

// Q1 allowlist: console errors that are known noise.
const ALLOWED_ERRORS = [
  (msg) => /favicon\.ico/.test(msg.url) || (/404/.test(msg.text) && /favicon/.test(msg.url + msg.text)),
];

/**
 * `page` fails the test on any uncaught exception or console.error (Q1).
 * `game` is a small driver for the classic-script globals.
 */
export const test = base.extend({
  consoleErrors: async ({}, use) => {
    await use([]);
  },

  // Per-test Q1 exceptions: push a RegExp for an error the test itself provokes.
  allowedErrors: async ({}, use) => {
    await use([]);
  },

  page: async ({ page, consoleErrors, allowedErrors }, use, testInfo) => {
    // E2E_CPU_THROTTLE=6 approximates the CI runner locally (Chromium CDP throttling).
    if (process.env.E2E_CPU_THROTTLE) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.E2E_CPU_THROTTLE) });
    }
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const entry = { text: msg.text(), url: msg.location()?.url || '' };
      if (!ALLOWED_ERRORS.some((ok) => ok(entry))) consoleErrors.push(`console.error: ${entry.text} (${entry.url})`);
    });
    page.on('pageerror', (err) => consoleErrors.push(`uncaught: ${err.stack || err.message}`));
    page.on('requestfailed', (req) => {
      if (!/favicon\.ico/.test(req.url())) consoleErrors.push(`request failed: ${req.url()}`);
    });

    await use(page);

    if (consoleErrors.length) {
      await testInfo.attach('console-errors.txt', { body: consoleErrors.join('\n'), contentType: 'text/plain' });
    }
    const unexpected = consoleErrors.filter((e) => !allowedErrors.some((re) => re.test(e)));
    expect(unexpected, 'Q1: no uncaught errors or console.error').toEqual([]);
  },

  game: async ({ page }, use) => {
    await use(new GameDriver(page));
  },
});

export { expect };

class GameDriver {
  constructor(page) {
    this.page = page;
  }

  /** Open game.html and wait until PixiJS is initialised. */
  async boot() {
    await this.page.goto('/game.html');
    await this.page.waitForFunction(() => typeof app !== 'undefined' && app && app.renderer, null, { timeout: T(30_000) });
    // M5: the button stays disabled until font, Pixi and input are ready.
    await expect(this.page.locator('#start-btn')).toBeEnabled({ timeout: T(10_000) });
  }

  /** Click START MISSION and wait for the loop to tick. */
  async start() {
    await this.page.click('#start-btn');
    await this.page.waitForFunction(() => gameStarted && gameTime > 0.1, null, { timeout: T(10_000) });
  }

  /** Read a value from the page's global scope (top-level let/const included). */
  eval(fn, arg) {
    return this.page.evaluate(fn, arg);
  }

  /** Keep the game calm: no waves, player can't die. */
  async freezeWaves() {
    await this.page.evaluate(() => {
      waveActive = false;
      waveTimer = 1e9;
      enemies.length = 0;
      player.invincible = 1e9;
    });
  }

  /**
   * Move the player (and camera) onto a spot whose surrounding 3x3 rendered tiles are dry
   * land. The world seed changes per load and the spawn is often water, where blood becomes
   * a cloud (W3) and gibs sink (W4) instead of leaving decals.
   */
  async toLand() {
    const at = await this.page.evaluate(() => {
      const ts = CFG.TILE_SIZE;
      const dry = (x, y) => getTerrainTypeAt(Math.floor(x / ts) * ts, Math.floor(y / ts) * ts) !== 'water';
      for (let r = 0; r < 20000; r += ts) {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2, x = Math.round(Math.cos(a) * r), y = Math.round(Math.sin(a) * r);
          let ok = true;
          for (let dx = -2; dx <= 2 && ok; dx++) for (let dy = -2; dy <= 2 && ok; dy++) ok = dry(x + dx * ts, y + dy * ts);
          if (ok) {
            player.x = x; player.y = y; player.vx = 0; player.vy = 0;
            const s = toScreen(x, y);
            cam.x = cam.tx = s.x; cam.y = cam.ty = s.y;
            return { x, y };
          }
        }
      }
      return null;
    });
    if (!at) throw new Error('toLand: no dry area found');
    await this.advance(0.2);
    return at;
  }

  /** Wait for game time to advance by `seconds` (game time, not wall time). */
  async advance(seconds) {
    const t0 = await this.page.evaluate(() => gameTime);
    await this.page.waitForFunction((target) => gameTime >= target, t0 + seconds, { timeout: T(30_000) + seconds * 1000 * TIME_SCALE * 4 });
  }

  /** Save a screenshot as a test artifact (T7). */
  async snap(testInfo, name) {
    const body = await this.page.screenshot();
    await testInfo.attach(name, { body, contentType: 'image/png' });
    return body;
  }

  /**
   * Soft visual check: sample the stage through Pixi's extract API and count
   * distinct colours, so a blank or single-colour frame fails without pixel diffs.
   */
  async distinctColors() {
    return this.page.evaluate(() => {
      const { pixels } = app.renderer.extract.pixels({ target: app.stage, frame: new PIXI.Rectangle(0, 0, W, H) });
      const seen = new Set();
      const step = 4 * 97; // sample ~1% of pixels
      for (let i = 0; i < pixels.length; i += step) {
        seen.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
      }
      return seen.size;
    });
  }
}
