import { test, expect } from './fixtures.js';

test.describe('T4 boot & loop', () => {
  test('T4: boots with no console errors', async ({ game, page }, testInfo) => {
    await game.boot();
    await expect(page.locator('#start-btn')).toBeVisible();
    await expect(page.locator('#start-btn')).toHaveText(/START/);
    await game.snap(testInfo, 'T7-title.png');
  });

  test('T4: START MISSION starts the loop and gameTime increases', async ({ game, page }, testInfo) => {
    await game.boot();
    await game.start();
    await expect(page.locator('#start-screen')).toBeHidden();
    const t1 = await game.eval(() => gameTime);
    await game.advance(0.5);
    const t2 = await game.eval(() => gameTime);
    expect(t2).toBeGreaterThan(t1);
    expect(await game.eval(() => player && player.hp > 0)).toBe(true);
    expect(await game.distinctColors(), 'T7: gameplay frame is not blank').toBeGreaterThan(10);
    await game.snap(testInfo, 'T7-gameplay-x1.png');
  });

  test('T4: pause with P stops gameTime, P again resumes', async ({ game, page }, testInfo) => {
    await game.boot();
    await game.start();
    await page.keyboard.press('p');
    expect(await game.eval(() => paused)).toBe(true);
    const t1 = await game.eval(() => gameTime);
    await page.waitForTimeout(500);
    expect(await game.eval(() => gameTime)).toBe(t1);
    await game.snap(testInfo, 'T7-pause.png');
    await page.keyboard.press('p');
    expect(await game.eval(() => paused)).toBe(false);
    await game.advance(0.2);
  });
});

test.describe('T4 input', () => {
  test.beforeEach(async ({ game }) => {
    await game.boot();
    await game.start();
    await game.freezeWaves();
  });

  for (const [key, axis, sign] of [['w', 'y', -1], ['s', 'y', 1], ['a', 'x', -1], ['d', 'x', 1]]) {
    test(`T4: ${key.toUpperCase()} moves the player ${sign < 0 ? '-' : '+'}${axis} on screen`, async ({ game, page }) => {
      const before = await game.eval(() => toScreen(player.x, player.y));
      await page.keyboard.down(key);
      await game.advance(0.4);
      await page.keyboard.up(key);
      const after = await game.eval(() => toScreen(player.x, player.y));
      const moved = (after[axis] - before[axis]) * sign;
      // 0.4 s at PLAYER_SPEED, allowing for water slowdown and tree collisions.
      expect(moved).toBeGreaterThan(15);
    });
  }

  test('T4: left click shoots bullets toward the cursor', async ({ game, page }) => {
    const { W: w, H: h } = await game.eval(() => ({ W, H }));
    await page.mouse.move(w / 2 + 200, h / 2);
    const mag0 = await game.eval(() => player.magAmmo);
    await page.mouse.down();
    await page.waitForFunction(() => bullets.some((b) => b.owner === 'player'));
    await page.mouse.up();
    const shot = await game.eval(() => {
      const b = bullets.find((b) => b.owner === 'player');
      return { vx: b.vx, vy: b.vy, mag: player.magAmmo };
    });
    expect(shot.mag).toBeLessThan(mag0);
    // Cursor is to the right of the player on screen, so the bullet moves right on screen.
    const screenVx = shot.vx - shot.vy; // toScreen x = wx - wy
    expect(screenVx).toBeGreaterThan(0);
  });
});

test.describe('T4 gore', () => {
  test('T4/G3/G4: a forced kill produces blood particles and pools', async ({ game }, testInfo) => {
    await game.boot();
    await game.start();
    await game.freezeWaves();
    const after = await game.eval(() => {
      const before = { pools: bloodPools.length, bodies: bodies.length };
      for (let i = 0; i < 6; i++) {
        const e = spawnEnemy(0, player.x + 60 + i * 15, player.y + (i % 2) * 20);
        damageEnemy(e, e.hp + 1, 0);
      }
      return {
        pools: bloodPools.length - before.pools,
        bodies: bodies.length - before.bodies,
        bloodParticles: particles.filter((p) => p.type === 'blood').length,
        kills,
      };
    });
    expect(after.kills).toBeGreaterThanOrEqual(6);
    expect(after.pools).toBeGreaterThan(0);
    expect(after.bodies).toBe(6);
    expect(after.bloodParticles).toBeGreaterThan(0);
    await game.advance(0.3);
    expect(await game.eval(() => bloodPools.length)).toBeGreaterThan(0);
    await game.snap(testInfo, 'T7-gore.png');
  });

  // Needs Josh's gib representation (M3) to assert against.
  test.fixme('G5: an explosive kill bursts into gibs', async () => {});
});

test.describe('T4 retro toggles (M1)', () => {
  test('R6/R7: F6/F7/F8 change retroState()', async ({ game, page }, testInfo) => {
    await game.boot();
    const hasHook = await game.eval(() => typeof retroState === 'function' && typeof window.RETRO === 'object');
    test.skip(!hasHook, 'needs retroState() and window.RETRO from M1 (R7)');
    await game.start();

    const s0 = await game.eval(() => retroState());
    expect(s0.scale).toBe(3);
    expect(s0.rtWidth).toBe(Math.ceil((await game.eval(() => W)) / 3));
    await game.snap(testInfo, 'T7-gameplay-x3.png');

    const scales = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('F6');
      scales.push((await game.eval(() => retroState())).scale);
    }
    expect(scales).toEqual([4, 1, 2, 3]);

    await page.keyboard.press('F7');
    expect((await game.eval(() => retroState())).dither).toBe(!s0.dither);
    await page.keyboard.press('F8');
    expect((await game.eval(() => retroState())).crt).toBe(!s0.crt);
  });
});

test.describe('T5 aim', () => {
  test('T5: cursor maps to the correct world point at the current pixel scale', async ({ game, page }) => {
    await game.boot();
    await game.start();
    await game.freezeWaves();
    const { W: w, H: h } = await game.eval(() => ({ W, H }));
    const target = { x: Math.round(w / 2 + 150), y: Math.round(h / 2 - 80) };
    await page.mouse.move(target.x, target.y);
    await game.advance(0.1);
    const r = await game.eval(({ x, y }) => {
      const expected = toWorld(x - W / 2 + cam.x, y - H / 2 + cam.y);
      const scale = typeof retroState === 'function' ? retroState().scale : 1;
      return { mouseWorldX, mouseWorldY, expected, scale,
        aim: player.aimAngle, expectedAim: Math.atan2(expected.y - player.y, expected.x - player.x) };
    }, target);
    // Within one low-res pixel in screen space (~1 world unit per screen pixel).
    expect(Math.abs(r.mouseWorldX - r.expected.x)).toBeLessThanOrEqual(r.scale * 2);
    expect(Math.abs(r.mouseWorldY - r.expected.y)).toBeLessThanOrEqual(r.scale * 2);
    expect(Math.abs(r.aim - r.expectedAim)).toBeLessThan(0.05);
  });
});

test.describe('T6 perf', () => {
  test('T6: 40 enemies for 5 s holds the fps threshold', async ({ game }, testInfo) => {
    const minFps = Number(process.env.PERF_MIN_FPS ?? 50);
    await game.boot();
    await game.start();
    await game.eval(() => {
      waveActive = false;
      waveTimer = 1e9;
      player.invincible = 1e9;
      for (let i = 0; i < 40; i++) {
        const a = (i / 40) * Math.PI * 2;
        spawnEnemy(i % 4, player.x + Math.cos(a) * 250, player.y + Math.sin(a) * 250);
      }
    });
    await game.page.waitForTimeout(5000);
    const perf = await game.eval(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return {
        fps: perfLog.fps, updateMs: perfLog.updateMs, renderMs: perfLog.renderMs,
        cpuMs: perfLog.totalCpuMs, enemies: enemies.length,
        gpu: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown',
      };
    });
    await testInfo.attach('perf.json', { body: JSON.stringify(perf, null, 2), contentType: 'application/json' });
    console.log(`[T6] fps=${perf.fps} cpu=${perf.cpuMs.toFixed(1)}ms update=${perf.updateMs.toFixed(1)}ms render=${perf.renderMs.toFixed(1)}ms enemies=${perf.enemies} gpu="${perf.gpu}" (min fps ${minFps})`);
    expect(perf.enemies).toBeGreaterThanOrEqual(40);
    // Q2: CPU frame time is meaningful everywhere.
    expect(perf.cpuMs).toBeLessThan(12);
    // With software WebGL (headless/CI) fps measures SwiftShader, not the game: record it only.
    const softwareGl = /swiftshader|llvmpipe|software/i.test(perf.gpu);
    testInfo.annotations.push({ type: 'perf', description: `fps=${perf.fps} cpu=${perf.cpuMs.toFixed(1)}ms gpu=${perf.gpu}` });
    if (!softwareGl) expect(perf.fps).toBeGreaterThanOrEqual(minFps);
  });
});
