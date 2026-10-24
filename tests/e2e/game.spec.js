import { test, expect, T } from './fixtures.js';
import { LANDED } from '../milestones.js';

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
    // Capture the bullet in the same tick it's seen; it can expire before a second evaluate.
    const handle = await page.waitForFunction(() => {
      const b = bullets.find((b) => b.owner === 'player');
      return b && { vx: b.vx, vy: b.vy, mag: player.magAmmo };
    });
    const shot = await handle.jsonValue();
    await page.mouse.up();
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

  test('G5: an explosive kill bursts into gibs that settle as decals', async ({ game }, testInfo) => {
    test.skip(!LANDED.M3, 'M3 not landed (tests/milestones.js)');
    await game.boot();
    await game.start();
    await game.freezeWaves();
    const burst = await game.eval(() => {
      const e = spawnEnemy(0, player.x + 80, player.y);
      const before = gibs.length;
      damageEnemy(e, e.hp + 1, 0, SRC_EXPLOSIVE);
      return { added: gibs.length - before, dead: !!e.dead };
    });
    expect(burst.dead).toBe(true);
    expect(burst.added).toBeGreaterThanOrEqual(5);
    expect(burst.added).toBeLessThanOrEqual(8);
    await game.advance(0.2);
    await game.snap(testInfo, 'T7-gibs.png');
    // Gibs land within ~1-3 s and become DECAL_GIB decals.
    await game.page.waitForFunction(() => gibs.length === 0, null, { timeout: T(20_000) });
    expect(await game.eval(() => bloodPools.filter((d) => d.kind === DECAL_GIB).length)).toBeGreaterThan(0);
  });
});

test.describe('T4 retro toggles (M1)', () => {
  test('R6/R7: F6/F7/F8 change retroState()', async ({ game, page }, testInfo) => {
    test.skip(!LANDED.M1, 'M1 not landed (tests/milestones.js)');
    await game.boot();
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

/** Press F6 until retroState().scale === target (R6 cycles 1 -> 2 -> 3 -> 4). */
async function setPixelScale(game, target) {
  for (let i = 0; i < 4; i++) {
    if ((await game.eval(() => retroState().scale)) === target) return;
    await game.page.keyboard.press('F6');
  }
  expect(await game.eval(() => retroState().scale)).toBe(target);
}

test.describe('T5 aim', () => {
  for (const scale of [1, 3]) {
    test(`T5: cursor maps to the correct world point at PIXEL_SCALE ${scale}`, async ({ game, page }) => {
      test.skip(scale !== 1 && !LANDED.M1, 'M1 not landed (tests/milestones.js)');
      await game.boot();
      await game.start();
      await game.freezeWaves();
      if (LANDED.M1) await setPixelScale(game, scale);
      const { W: w, H: h } = await game.eval(() => ({ W, H }));
      for (const target of [
        { x: Math.round(w / 2 + 150), y: Math.round(h / 2 - 80) },
        { x: Math.round(w / 2 - 230), y: Math.round(h / 2 + 140) },
      ]) {
        await page.mouse.move(target.x, target.y);
        await game.advance(0.1);
        const r = await game.eval(({ x, y }) => {
          const expected = toWorld(x - W / 2 + cam.x, y - H / 2 + cam.y);
          return { mouseWorldX, mouseWorldY, expected,
            aim: player.aimAngle, expectedAim: Math.atan2(expected.y - player.y, expected.x - player.x) };
        }, target);
        // Q5: within one low-res pixel. One screen pixel is at most ~1 world unit horizontally
        // and 1/(2*ISO_SCALE) ~ 0.9 vertically, so 1 low-res pixel <= scale * 1.
        expect(Math.abs(r.mouseWorldX - r.expected.x)).toBeLessThanOrEqual(scale);
        expect(Math.abs(r.mouseWorldY - r.expected.y)).toBeLessThanOrEqual(scale);
        expect(Math.abs(r.aim - r.expectedAim)).toBeLessThan(0.05);
      }
    });
  }
});

test.describe('R2 pixel-grid camera', () => {
  test('R2: world offset sits on whole low-res pixels while moving', async ({ game, page }) => {
    test.skip(!LANDED.M1, 'M1 not landed (tests/milestones.js)');
    await game.boot();
    await game.start();
    await game.freezeWaves();
    await setPixelScale(game, 3);
    await page.keyboard.down('d');
    for (let i = 0; i < 10; i++) {
      await game.advance(0.05);
      const off = await game.eval(() => ({ x: worldContainer.x, y: worldContainer.y, s: RETRO.PIXEL_SCALE }));
      expect(Math.abs(off.x / off.s - Math.round(off.x / off.s))).toBeLessThan(1e-6);
      expect(Math.abs(off.y / off.s - Math.round(off.y / off.s))).toBeLessThan(1e-6);
    }
    await page.keyboard.up('d');
  });
});

test.describe('T6 perf', () => {
  test('T6: 40 enemies for 5 s holds the fps threshold', { tag: '@perf' }, async ({ game }, testInfo) => {
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
    // Sample CPU frame time across the whole window: perfLog.totalCpuMs is a single
    // frame and gets overwritten every frame, so one GC spike would make it flaky.
    await game.eval(() => {
      window.__t6 = { cpu: [], timer: setInterval(() => window.__t6.cpu.push(perfLog.totalCpuMs), 25) };
    });
    await game.advance(5);
    const perf = await game.eval(() => {
      clearInterval(window.__t6.timer);
      const cpu = window.__t6.cpu.slice().sort((a, b) => a - b);
      const pct = (q) => cpu[Math.min(cpu.length - 1, Math.floor(q * cpu.length))];
      const gl = document.createElement('canvas').getContext('webgl');
      const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return {
        fps: perfLog.fps, // already averaged over the last 60 frames
        samples: cpu.length,
        cpuMedianMs: pct(0.5), cpuP90Ms: pct(0.9), cpuMaxMs: cpu[cpu.length - 1],
        cpuMeanMs: cpu.reduce((a, b) => a + b, 0) / cpu.length,
        enemies: enemies.length,
        gpu: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown',
      };
    });
    await testInfo.attach('perf.json', { body: JSON.stringify(perf, null, 2), contentType: 'application/json' });
    const summary = `fps=${perf.fps} cpu median=${perf.cpuMedianMs.toFixed(1)}ms p90=${perf.cpuP90Ms.toFixed(1)}ms max=${perf.cpuMaxMs.toFixed(1)}ms (${perf.samples} samples) enemies=${perf.enemies} gpu="${perf.gpu}"`;
    console.log(`[T6] ${summary} (min fps ${minFps})`);
    testInfo.annotations.push({ type: 'perf', description: summary });
    expect(perf.samples).toBeGreaterThan(20);
    expect(perf.enemies).toBeGreaterThanOrEqual(40);
    // Q2: judge the typical frame, not a spike. Absolute ms only off CI (Q2a: CI runners
    // check relative criteria only).
    if (!process.env.CI) expect(perf.cpuMedianMs).toBeLessThan(12);
    // With software WebGL (headless/CI) fps measures SwiftShader, not the game: record it only.
    const softwareGl = /swiftshader|llvmpipe|software/i.test(perf.gpu);
    if (!softwareGl) expect(perf.fps).toBeGreaterThanOrEqual(minFps);
  });
});
