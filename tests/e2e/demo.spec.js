import { test, expect } from './fixtures.js';
import { LANDED } from '../milestones.js';

// T11 / M6 attract mode (D8 hooks). Skipped until M6 is marked landed in tests/milestones.js.
// The Q1 console guard from fixtures.js applies throughout.

test.skip(!LANDED.M6, 'M6 not landed (tests/milestones.js)');

async function bootTitle(game, idleSeconds) {
  await game.boot();
  await game.eval((s) => { CFG.DEMO_IDLE_SECONDS = s; }, idleSeconds);
}

const demo = (game) => game.eval(() => demoState());

async function waitForDemo(game, active, timeout = 15_000) {
  await game.page.waitForFunction((a) => demoState().active === a, active, { timeout });
}

test.describe('T11 attract mode', () => {
  test('T11/D1: idle on the title starts the demo after CFG.DEMO_IDLE_SECONDS', async ({ game }, testInfo) => {
    await bootTitle(game, 1);
    expect((await demo(game)).active).toBe(false);
    await waitForDemo(game, true, 10_000);
    await game.snap(testInfo, 'T11-demo-start.png');
  });

  test('T11/D3/D4: the demo kills enemies, advances gameTime and cycles weapons within 20 s', async ({ game }, testInfo) => {
    test.setTimeout(60_000);
    await bootTitle(game, 1);
    await waitForDemo(game, true, 10_000);
    const s0 = await game.eval(() => ({ t: gameTime, kills, weapon: demoState().weaponIndex }));
    const seenWeapons = new Set([s0.weapon]);
    let last = s0;
    for (let i = 0; i < 20; i++) {
      await game.page.waitForTimeout(1000);
      last = await game.eval(() => ({ t: gameTime, kills, weapon: demoState().weaponIndex, active: demoState().active }));
      seenWeapons.add(last.weapon);
      if (!last.active) break;
      if (i === 8) await game.snap(testInfo, 'T11-demo-action.png');
    }
    testInfo.annotations.push({ type: 'demo', description: `kills=${last.kills} gameTime=${last.t.toFixed(1)} weapons=${[...seenWeapons].join(',')}` });
    expect(last.t).toBeGreaterThan(s0.t);
    expect(last.kills).toBeGreaterThan(s0.kills);
    expect(seenWeapons.size, 'D4: weapon cycles every ~8 s').toBeGreaterThan(1);
  });

  test('T11/D6: a keypress exits to the title without starting a game', async ({ game, page }) => {
    await bootTitle(game, 1);
    await waitForDemo(game, true, 10_000);
    await page.keyboard.press('x');
    await waitForDemo(game, false, 2_000);
    await expect(page.locator('#start-screen')).toBeVisible();
    await expect(page.locator('#start-btn')).toBeVisible();
    // The exit input must not also start a real game.
    await page.waitForTimeout(500);
    expect(await game.eval(() => demoState().active)).toBe(false);
    await expect(page.locator('#start-screen')).toBeVisible();
  });

  test('T11/D6: a click exits the demo without starting a game', async ({ game, page }) => {
    await bootTitle(game, 1);
    await waitForDemo(game, true, 10_000);
    const { W: w, H: h } = await game.eval(() => ({ W, H }));
    await page.mouse.click(w / 2, h - 40);
    await waitForDemo(game, false, 2_000);
    await page.waitForTimeout(500);
    await expect(page.locator('#start-screen')).toBeVisible();
  });

  test('T11/D6: a real game after the demo starts from a clean state', async ({ game, page }) => {
    await bootTitle(game, 1);
    await waitForDemo(game, true, 10_000);
    await page.waitForFunction(() => kills > 0, null, { timeout: 20_000 });
    await page.keyboard.press('x');
    await waitForDemo(game, false, 2_000);
    // Keep the demo from re-triggering while we start the real game.
    await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
    await game.start();
    const s = await game.eval(() => ({
      score, kills, unlockedWeapons, combo, bestCombo,
      weapon: player.weapon, hp: player.hp, maxHp: player.maxHp,
      demoActive: demoState().active,
      bodies: bodies.length, pickups: pickups.length,
    }));
    expect(s.demoActive).toBe(false);
    expect(s.score).toBe(0);
    expect(s.kills).toBe(0);
    expect(s.unlockedWeapons).toBe(1);
    expect(s.combo).toBe(0);
    expect(s.bestCombo).toBe(0);
    expect(s.weapon).toBe(0);
    expect(s.hp).toBe(s.maxHp);
    expect(s.pickups).toBe(0);
  });

  test('T11/D1: mouse jitter under 8 px does not reset the idle timer', async ({ game, page }) => {
    await bootTitle(game, 1e9);
    await page.mouse.move(400, 300);
    await page.waitForTimeout(300);
    let prev = (await demo(game)).idleTimer;
    for (const [dx, dy] of [[3, 0], [0, 4], [-5, 2], [2, -6], [5, 5]]) {
      await page.mouse.move(400 + dx, 300 + dy);
      await page.waitForTimeout(250);
      const t = (await demo(game)).idleTimer;
      expect(t, `jitter (${dx},${dy}) reset the idle timer`).toBeGreaterThan(prev);
      prev = t;
    }
    // A real move (> 8 px) does reset it.
    await page.mouse.move(460, 360);
    await page.waitForTimeout(50);
    expect((await demo(game)).idleTimer).toBeLessThan(prev);
  });

  test('T11/D1: the demo never starts during real play or while paused', async ({ game, page }) => {
    await bootTitle(game, 1);
    await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
    await game.start();
    await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1; });
    await page.waitForTimeout(2500);
    expect((await demo(game)).active).toBe(false);
    await page.keyboard.press('p');
    await page.waitForTimeout(2500);
    expect((await demo(game)).active).toBe(false);
  });

  test('T11/D6: the demo ends on its own after CFG.DEMO_MAX_SECONDS and loops title -> demo', async ({ game }) => {
    test.setTimeout(60_000);
    await bootTitle(game, 1);
    expect(await game.eval(() => CFG.DEMO_MAX_SECONDS), 'D8 default').toBe(60);
    await game.eval(() => { CFG.DEMO_MAX_SECONDS = 4; });
    await waitForDemo(game, true, 10_000);
    await waitForDemo(game, false, 15_000);
    await expect(game.page.locator('#start-screen')).toBeVisible();
    // idleTimer restarts from 0 when a demo ends (D6/D8), then the demo comes back.
    expect((await demo(game)).idleTimer).toBeLessThan(1);
    await waitForDemo(game, true, 10_000);
    await waitForDemo(game, false, 15_000);
  });

  test('T11/D8: startDemo()/stopDemo() drive the demo directly', async ({ game, page }) => {
    await bootTitle(game, 1e9);
    await game.eval(() => startDemo());
    await waitForDemo(game, true, 2_000);
    await game.page.waitForFunction(() => demoState().elapsed > 0.5, null, { timeout: 10_000 });
    await game.eval(() => stopDemo());
    await waitForDemo(game, false, 2_000);
    await expect(page.locator('#start-screen')).toBeVisible();
  });

  test('D4: the demo starts at wave 10', async ({ game }) => {
    test.skip(!LANDED.FU1, 'follow-up FU1 not landed (tests/milestones.js)');
    await bootTitle(game, 1);
    await waitForDemo(game, true, 10_000);
    await game.page.waitForFunction(() => wave > 0, null, { timeout: 10_000 });
    expect(await game.eval(() => wave)).toBeGreaterThanOrEqual(10);
    // Wave-10 enemy types are in the spawn pool.
    const types = await game.eval(() => ENEMY_TYPES.filter((t) => t.wave <= wave).map((t) => t.name));
    expect(types).toEqual(expect.arrayContaining(['Berserker', 'Bomber', 'Commando']));
  });

  test('D5: the title overlay does not hide the demo; DEMO banner and prompt are on screen', async ({ game, page }, testInfo) => {
    test.skip(!LANDED.FU1, 'follow-up FU1 not landed (tests/milestones.js)');
    await bootTitle(game, 1);
    await waitForDemo(game, true, 10_000);
    await game.page.waitForFunction(() => demoState().elapsed > 2, null, { timeout: 15_000 });
    // Score/HUD must be visible "as normal", so the full-screen title DOM must not cover the canvas.
    const cover = await game.eval(() => {
      const el = document.getElementById('start-screen');
      const cs = getComputedStyle(el);
      const hidden = cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0;
      return { hidden, top: document.elementFromPoint(W / 2, 40)?.id || '', bottom: document.elementFromPoint(W / 2, H - 30)?.id || '' };
    });
    expect(cover.hidden, 'D5: #start-screen hidden during the demo').toBe(true);
    // Sample over > 1 blink period so a blinking banner is caught in its "on" phase.
    const texts = new Set();
    for (let i = 0; i < 8; i++) {
      for (const t of await game.eval(() => {
        const out = [];
        const walk = (n) => {
          if (!n || n.visible === false || n.worldAlpha === 0) return;
          if (typeof n.text === 'string' && n.text) out.push(n.text);
          (n.children || []).forEach(walk);
        };
        walk(app.stage);
        // The overlay may also be DOM; innerText skips hidden elements.
        out.push(document.body.innerText);
        return out;
      })) texts.add(t.toUpperCase());
      await page.waitForTimeout(250);
    }
    await game.snap(testInfo, 'D5-demo-overlay.png');
    const all = [...texts].join(' | ');
    expect(all, 'D5: DEMO banner').toMatch(/\bDEMO\b/);
    expect(all, 'D5: bottom prompt').toMatch(/PRESS ANY KEY OR CLICK TO PLAY/);
  });
});
