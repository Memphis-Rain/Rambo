import { test, expect } from './fixtures.js';
import { LANDED } from '../milestones.js';

// Batch 2 fixes for the exploratory bugs B1-B7 on release point 1.
// Skipped until BATCH2 is marked landed in tests/milestones.js.
test.skip(!LANDED.BATCH2, 'BATCH2 not landed (tests/milestones.js)');

async function startCalm(game) {
  await game.boot();
  await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
  await game.start();
  await game.freezeWaves();
}

/** Aim error in low-res px for a set of screen points (same mapping as T5). */
async function aimErrors(game, page, points) {
  const errs = [];
  for (const pt of points) {
    await page.mouse.move(pt.x, pt.y);
    await game.advance(0.08);
    errs.push(await game.eval(({ x, y }) => {
      const s = retroState().scale;
      // Where the game's aim world point is drawn on screen, using the offset it was drawn at.
      const sp = toScreen(mouseWorldX, mouseWorldY);
      return Math.hypot(sp.x + worldOffsetX - x, sp.y + worldOffsetY - y) / s;
    }, pt));
  }
  return errs;
}

for (const dsf of [1.25, 1.5, 2]) {
  test.describe(`B1 HiDPI at devicePixelRatio ${dsf}`, () => {
    test.use({ deviceScaleFactor: dsf });

    test(`B1: world, HUD and aim fill the real viewport at DPR ${dsf}`, async ({ game, page }, testInfo) => {
      await startCalm(game);
      const s = await game.eval(() => {
        const r = retroState();
        const b = uiContainer.getBounds();
        return { W, H, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, ...r,
          hud: { minX: b.minX ?? b.x, minY: b.minY ?? b.y, maxX: b.maxX ?? b.x + b.width, maxY: b.maxY ?? b.y + b.height } };
      });
      testInfo.annotations.push({ type: 'hidpi', description: JSON.stringify(s) });
      expect(s.dpr).toBeCloseTo(dsf, 5);
      expect(s.W, 'W is CSS px').toBe(s.iw);
      expect(s.H, 'H is CSS px').toBe(s.ih);
      expect(s.rtWidth * s.scale, 'low-res RT covers the width').toBeGreaterThanOrEqual(s.iw);
      expect(s.rtHeight * s.scale, 'low-res RT covers the height').toBeGreaterThanOrEqual(s.ih);
      // HUD panels sit at the real corners: bottom-left panel and top-right stats.
      expect(s.hud.minX).toBeLessThan(40);
      expect(s.hud.minY).toBeLessThan(40);
      expect(s.hud.maxX).toBeGreaterThan(s.iw - 40);
      expect(s.hud.maxY).toBeGreaterThan(s.ih - 40);
      const errs = await aimErrors(game, page, [
        { x: Math.round(s.iw * 0.8), y: Math.round(s.ih * 0.2) },
        { x: Math.round(s.iw * 0.15), y: Math.round(s.ih * 0.85) },
        { x: Math.round(s.iw * 0.95), y: Math.round(s.ih * 0.95) },
      ]);
      expect(Math.max(...errs), 'Q5 aim error in low-res px').toBeLessThanOrEqual(1);
      await game.snap(testInfo, `B1-dpr-${dsf}.png`);
    });
  });
}

test.describe('B2 dither stability', () => {
  /**
   * Shift the camera by exactly one low-res pixel and compare the frame with the
   * previous one, offset by that pixel, at low-res block centres. The player
   * (who moves with the camera) and the HUD corners are excluded.
   */
  async function matchAfterShift(game, dither) {
    await game.eval((d) => {
      RETRO.DITHER = d;
      RETRO.CRT = false;
      if (typeof _applyRetroToggles === 'function') _applyRetroToggles();
    }, dither);
    await game.advance(0.3);
    return game.eval(async () => {
      const s = retroState().scale;
      const frame = () => app.renderer.extract.pixels({ target: app.stage, frame: new PIXI.Rectangle(0, 0, W, H) });
      const nextFrames = (n) => new Promise((r) => { const f = () => (--n ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); });
      const ox0 = worldOffsetX, oy0 = worldOffsetY;
      const a = frame();
      // Move player and camera together by one low-res pixel to the screen-left.
      player.x += s / 2; player.y -= s / 2;
      cam.x += s; cam.tx += s;
      await nextFrames(3);
      const b = frame();
      const dx = worldOffsetX - ox0, dy = worldOffsetY - oy0;
      const w = a.width, h = a.height, res = w / W;
      let same = 0, total = 0;
      for (let y = Math.floor(H * 0.15); y < H * 0.85; y += s) {
        for (let x = Math.floor(W * 0.15); x < W * 0.85; x += s) {
          if (Math.abs(x - W / 2) < 70 && Math.abs(y - H / 2) < 90) continue; // player
          const cx = x + s / 2, cy = y + s / 2;
          const bx = Math.round((cx + dx) * res), by = Math.round((cy + dy) * res);
          const ax = Math.round(cx * res), ay = Math.round(cy * res);
          if (bx < 0 || by < 0 || bx >= w || by >= h) continue;
          const ia = (ay * w + ax) * 4, ib = (by * w + bx) * 4;
          total++;
          if (Math.abs(a.pixels[ia] - b.pixels[ib]) + Math.abs(a.pixels[ia + 1] - b.pixels[ib + 1]) + Math.abs(a.pixels[ia + 2] - b.pixels[ib + 2]) <= 6) same++;
        }
      }
      return { match: same / total, dx, dy, s, total };
    });
  }

  test('B2: the dither pattern moves with the world (1 low-res px camera shift)', async ({ game }, testInfo) => {
    await startCalm(game);
    const off = await matchAfterShift(game, false);
    const on = await matchAfterShift(game, true);
    const summary = `dither off match=${(off.match * 100).toFixed(1)}% on=${(on.match * 100).toFixed(1)}% shift=(${on.dx},${on.dy}) scale=${on.s} samples=${on.total}`;
    console.log(`[B2] ${summary}`);
    testInfo.annotations.push({ type: 'dither', description: summary });
    expect(Math.abs(on.dx) + Math.abs(on.dy), 'camera moved').toBeGreaterThan(0);
    expect(off.match, 'baseline (dither off) is stable').toBeGreaterThan(0.85);
    expect(on.match, 'B2: dither on stays world-locked').toBeGreaterThan(0.85);
  });
});

test.describe('B3 decal cap', () => {
  test('B3: moving across chunks does not trim decals below MAX_BLOOD_POOLS', async ({ game }) => {
    await startCalm(game);
    const before = await game.eval(() => {
      for (let i = 0; i < CFG.MAX_BLOOD_POOLS - 10; i++) {
        addDecal(i % 7, player.x + (i % 60) * 8, player.y + Math.floor(i / 60) * 8, 4, 0x8a0a0a);
      }
      return bloodPools.length;
    });
    // Travel far enough to generate and clean up terrain chunks.
    await game.eval(() => new Promise((resolve) => {
      let n = 0;
      const step = () => { player.x += 400; cam.x = toScreen(player.x, player.y).x; if (++n < 20) requestAnimationFrame(step); else resolve(); };
      requestAnimationFrame(step);
    }));
    await game.advance(0.5);
    const after = await game.eval(() => ({ n: bloodPools.length, max: CFG.MAX_BLOOD_POOLS, chunks: chunkCache.size }));
    expect(before).toBe(after.max - 10);
    expect(after.chunks, 'chunk cleanup ran').toBeGreaterThan(0);
    expect(after.n, 'B3: decals kept up to MAX_BLOOD_POOLS').toBeGreaterThanOrEqual(after.max - 10);
    expect(after.n).toBeLessThanOrEqual(after.max);
  });
});

test.describe('B7/J5a shake cap', () => {
  test('B7/J5a: addShake is capped at CFG.SHAKE_MAX', async ({ game }) => {
    await startCalm(game);
    const r = await game.eval(() => { addShake(1000); return { m: shakeMag, cap: CFG.SHAKE_MAX }; });
    expect(r.cap, 'J5a: CFG.SHAKE_MAX').toBe(20);
    expect(r.m).toBeGreaterThan(0);
    expect(r.m, 'J5a: addShake clamps to CFG.SHAKE_MAX').toBeLessThanOrEqual(r.cap);
  });

  test('B7/J5a: shake decay does not depend on the frame rate', async ({ game }) => {
    await startCalm(game);
    const r = await game.eval(() => {
      paused = true;
      const run = (dt, frames) => {
        shakeMag = 0;
        addShake(15);
        for (let i = 0; i < frames; i++) updateCamera(dt);
        return shakeMag;
      };
      const at30 = run(1 / 30, 9);  // 0.3 s
      const at60 = run(1 / 60, 18); // 0.3 s
      paused = false;
      return { at30, at60 };
    });
    // Same game time elapsed: remaining shake should match within 20% (or both ~0).
    const hi = Math.max(r.at30, r.at60), lo = Math.min(r.at30, r.at60);
    expect(hi < 0.2 || lo / hi > 0.8, `30 fps: ${r.at30.toFixed(3)}, 60 fps: ${r.at60.toFixed(3)}`).toBe(true);
  });
});
