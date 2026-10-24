import { test, expect } from './fixtures.js';
import { LANDED } from '../milestones.js';

// M5 retro HUD & title (H1-H4). Skipped until M5 is marked landed in tests/milestones.js.
test.skip(!LANDED.M5, 'M5 not landed (tests/milestones.js)');

const FONT = 'Press Start 2P';

test.describe('M5 title & font', () => {
  test('H4: PRESS START becomes enabled within 5 s', async ({ page }) => {
    const t0 = Date.now();
    await page.goto('/game.html');
    const btn = page.locator('#start-btn');
    await expect(btn).toHaveText(/PRESS START/);
    await expect(btn).toBeEnabled({ timeout: 5_000 });
    console.log(`[H4] start button enabled after ${Date.now() - t0} ms`);
  });

  test('H1: the pixel font loads from assets/fonts and nothing is fetched from another origin', async ({ page }) => {
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    const fontResponse = page.waitForResponse((r) => r.url().includes('/assets/fonts/') && /\.(ttf|woff2?|otf)$/.test(new URL(r.url()).pathname));
    await page.goto('/game.html');
    await expect(page.locator('#start-btn')).toBeEnabled({ timeout: 5_000 });
    const res = await fontResponse;
    expect(res.status()).toBe(200);
    expect(await page.evaluate((f) => document.fonts.check(`16px "${f}"`), FONT)).toBe(true);
    const origin = new URL(page.url()).origin;
    const foreign = requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:'));
    expect(foreign, 'H1: no CDN or other external fetches').toEqual([]);
  });

  test('H1: title, notifications and HUD text use the pixel font', async ({ game, page }) => {
    await game.boot();
    const titleFont = await page.evaluate(() => getComputedStyle(document.getElementById('start-btn')).fontFamily);
    expect(titleFont).toContain(FONT);
    await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
    await game.start();
    const notifFont = await page.evaluate(() => getComputedStyle(document.getElementById('notif')).fontFamily);
    expect(notifFont, 'H3: notifications').toContain(FONT);
    const hud = await game.eval(() => {
      const fonts = [];
      const walk = (n) => {
        if (!n) return;
        if (typeof n.text === 'string' && n.style) {
          const ff = n.style.fontFamily;
          fonts.push({ text: n.text, font: Array.isArray(ff) ? ff.join(',') : String(ff) });
        }
        (n.children || []).forEach(walk);
      };
      walk(uiContainer);
      return fonts;
    });
    expect(hud.length).toBeGreaterThan(0);
    const other = hud.filter((t) => !t.font.includes('Press Start 2P'));
    expect(other, 'H1: HUD Text objects not using the pixel font').toEqual([]);
  });

  test('H4: the title shows the controls including the F6/F7/F8 showcase keys', async ({ game, page }) => {
    await game.boot();
    const text = await page.locator('#start-screen').innerText();
    for (const k of ['WASD', 'F6', 'F7', 'F8']) expect(text).toContain(k);
  });

  test('H3: kill-streak banner shows in the pixel font', async ({ game, page }, testInfo) => {
    await game.boot();
    await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
    await game.start();
    await game.freezeWaves();
    await game.eval(() => showNotification('KILLING SPREE!', 2));
    await expect(page.locator('#notif')).toHaveText('KILLING SPREE!');
    await page.waitForTimeout(500);
    expect(Number(await page.evaluate(() => getComputedStyle(document.getElementById('notif')).opacity))).toBeGreaterThan(0);
    await game.snap(testInfo, 'H3-banner.png');
  });
});

test.describe('M5 / D6 start after demo', () => {
  test('D6: PRESS START works immediately after a keypress exits the demo', async ({ game, page }) => {
    await game.boot();
    await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; startDemo(); });
    await page.waitForFunction(() => demoState().active && demoState().elapsed > 1);
    await page.keyboard.press('x');
    await page.waitForFunction(() => !demoState().active, null, { timeout: 2_000 });
    await expect(page.locator('#start-btn')).toBeEnabled({ timeout: 2_000 });
    await page.click('#start-btn');
    await page.waitForFunction(() => gameStarted && gameTime > 0.2, null, { timeout: 10_000 });
    const s = await game.eval(() => ({ demo: demoState().active, score, kills, unlockedWeapons, hud: uiContainer.visible }));
    expect(s).toEqual({ demo: false, score: 0, kills: 0, unlockedWeapons: 1, hud: true });
  });
});

test.describe('M5 review fixes', () => {
  test('H4: without WebGL the title says WEBGL UNAVAILABLE and shows #boot-error', async ({ page, consoleErrors, allowedErrors }) => {
    allowedErrors.push(/\[RAMBO\] Boot failed/);
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        if (/webgl/i.test(type)) return null;
        return orig.call(this, type, ...rest);
      };
      try { Object.defineProperty(navigator, 'gpu', { get: () => undefined }); } catch { /* not configurable */ }
    });
    await page.goto('/game.html');
    const btn = page.locator('#start-btn');
    await expect(btn).toHaveText('WEBGL UNAVAILABLE', { timeout: 10_000 });
    await expect(btn).toBeDisabled();
    await expect(page.locator('#boot-error')).toBeVisible();
    expect(await page.locator('#boot-error').innerText()).not.toBe('');
    expect(consoleErrors.some((e) => /\[RAMBO\] Boot failed/.test(e)), 'expected boot error logged').toBe(true);
  });

  test('H3: .notification drops its .show class after the banner fades', async ({ game, page }) => {
    await game.boot();
    await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
    await game.start();
    await game.freezeWaves();
    await game.eval(() => showNotification('RAMPAGE!', 0.6));
    await expect(page.locator('#notif')).toHaveClass(/\bshow\b/);
    await expect(page.locator('#notif')).not.toHaveClass(/\bshow\b/, { timeout: 5_000 });
    expect(Number(await page.evaluate(() => getComputedStyle(document.getElementById('notif')).opacity))).toBe(0);
  });
});
