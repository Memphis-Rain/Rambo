import { test, expect, T } from './fixtures.js';
import { LANDED } from '../milestones.js';
import { pinRenderersToCcd0 } from '../perf/pin.mjs';
import { padMock } from './padmock.js';

// M7 performance hardening (P1-P4, Q2a). Skipped until M7 is marked landed.
// CI runs on SwiftShader, so only relative criteria are asserted here; the absolute
// Q2a budget is checked with `npm run perf:sustained -- --gpu` on the reference machine.
test.skip(!LANDED.M7, 'M7 not landed (tests/milestones.js)');

async function startCalm(game) {
  await game.boot();
  await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
  await game.start();
  await game.freezeWaves();
  await game.eval(() => { unlockedWeapons = WEAPONS.length; player.invincible = 1e9; });
}

/** In-page gore driver (the same scenario as the perf explorer): 40 enemies kept alive,
 *  ~10 kills/s mixing gib and corpse deaths, an r=150 explosion every 0.5 s. */
const GORE = () => {
  window.__gore = { kills: 0, booms: 0, start: performance.now() };
  const ring = (n, r) => {
    for (let i = enemies.length; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      spawnEnemy(i % 6, player.x + Math.cos(a) * r, player.y + Math.sin(a) * r);
    }
  };
  const tick = (now) => {
    const g = window.__gore;
    if (g.stop) return;
    const el = (now - g.start) / 1000;
    ring(40, 220);
    while (g.kills < el * 10 && enemies.length) {
      const e = enemies[(g.kills * 7) % enemies.length];
      if (g.kills % 2) damageEnemy(e, e.hp * 3, Math.random() * 6.28, SRC_EXPLOSIVE);
      else killEnemy(e, Math.random() * 6.28);
      g.kills++;
    }
    while (g.booms < el * 2) {
      spawnExplosion(player.x + 150 * Math.cos(g.booms), player.y + 150 * Math.sin(g.booms), 150);
      g.booms++;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

/** Median perfLog.totalCpuMs sampled every frame for `seconds`. */
/** Median perfLog.totalCpuMs over the GAME-time window [from, to) seconds after `t0`. */
const medianCpu = ({ t0, from, to }) => new Promise((resolve) => {
  const xs = [];
  const tick = () => {
    const el = gameTime - t0;
    if (el >= from) xs.push(perfLog.totalCpuMs);
    if (el < to) requestAnimationFrame(tick);
    else { xs.sort((a, b) => a - b); resolve({ median: xs[xs.length >> 1], p99: xs[Math.floor(xs.length * 0.99)], n: xs.length }); }
  };
  requestAnimationFrame(tick);
});

test.describe('M7 / Q2a', () => {
  // On the 2-CCD Ryzen dev box Windows can migrate the renderer to the busier CCD after
  // ~60 s (Josh's P1 root cause), so the renderer is pinned to CCD0 there (Q2a protocol).
  // GitHub runners have no CCD split; pinning is a no-op off Windows.
  test('P1/Q2a: sustained gore keeps CPU frame time flat (minute 1.5 within 15% of minute 0.5)', { tag: '@perf' }, async ({ game, page }, testInfo) => {
    test.skip(!LANDED.P1, 'P1 not landed (tests/milestones.js)');
    test.setTimeout(T(180_000));
    await startCalm(game);
    const pinning = process.env.E2E_NO_PIN ? { pinned: false, reason: 'E2E_NO_PIN' } : pinRenderersToCcd0();
    testInfo.annotations.push({ type: 'pinning', description: JSON.stringify(pinning) });
    console.log(`[P1] pinning ${JSON.stringify(pinning)}`);
    // Steady load in both windows: start with the decal store at its cap, so the late
    // window doesn't carry more decals than the early one (only drift over time counts).
    await game.eval(() => {
      for (let i = 0; i < CFG.MAX_BLOOD_POOLS; i++) {
        const a = i * 2.399963, r = 40 + (i % 97) * 5;
        addDecal(i % 7, player.x + Math.cos(a) * r, player.y + Math.sin(a) * r, 4 + (i % 6), 0x8a0a0a, a);
      }
    });
    await game.eval(GORE);
    // Corpses fade after CFG.BODY_FADE_END (25 s), so the body count only reaches steady
    // state after ~25 s of gore; measure the early window after that.
    // Windows in GAME time: a slow CI runner covers few game-seconds per wall-second, and
    // wall windows then landed before the corpse/decal load reached steady state.
    const t0 = await game.eval(() => gameTime);
    const early = await game.eval(medianCpu, { t0, from: 30, to: 45 }); // before the old ~60 s step-up
    const late = await game.eval(medianCpu, { t0, from: 75, to: 90 });  // past it
    await game.eval(() => { window.__gore.stop = true; });
    const ratio = late.median / early.median;
    const summary = `early median=${early.median.toFixed(2)}ms p99=${early.p99.toFixed(2)} late median=${late.median.toFixed(2)}ms p99=${late.p99.toFixed(2)} ratio=${ratio.toFixed(3)}`;
    console.log(`[P1] ${summary}`);
    testInfo.annotations.push({ type: 'sustained', description: summary });
    expect(ratio, 'Q2a: sustained median within 15%').toBeLessThanOrEqual(1.15);
  });

  // M11 acceptance (Perf): 2P with 40 enemies + gore at zoom 0.6, the worst case (the most
  // world on screen), meets the same Q2 bars as 1P. On CI (SwiftShader) only the sustained
  // ratio is asserted, as for P1; the absolute numbers are logged next to P1's.
  test('M11PERF: 2P at zoom 0.6 with 40 enemies + gore keeps CPU frame time flat (game 75-90 s within 15% of 30-45 s)', { tag: '@perf' }, async ({ game, page }, testInfo) => {
    test.skip(!LANDED.K3 || !LANDED.K6, 'M11 K3/K6 not landed (tests/milestones.js)');
    test.setTimeout(T(180_000));
    await page.addInitScript(padMock, { rumble: 'ok' });
    await startCalm(game);
    // P2 on a plugged-in pad (a P2 without one auto-pauses, C6), next to P1; zoom held at 0.6
    await page.evaluate(() => window.__padConnect(1));
    const setup = await game.eval(() => {
      const p2 = coopJoin(1);
      for (const p of players) p.invincible = 1e9;
      p2.x = player.x + 60; p2.y = player.y; p2.vx = 0; p2.vy = 0;
      setCamZoom(0.6);
      return { n: players.length };
    });
    expect(setup.n, '2P').toBe(2);
    const pinning = process.env.E2E_NO_PIN ? { pinned: false, reason: 'E2E_NO_PIN' } : pinRenderersToCcd0();
    testInfo.annotations.push({ type: 'pinning', description: JSON.stringify(pinning) });
    // Steady load in both windows, as P1: the decal store at its cap from the start
    await game.eval(() => {
      for (let i = 0; i < CFG.MAX_BLOOD_POOLS; i++) {
        const a = i * 2.399963, r = 40 + (i % 97) * 5;
        addDecal(i % 7, player.x + Math.cos(a) * r, player.y + Math.sin(a) * r, 4 + (i % 6), 0x8a0a0a, a);
      }
    });
    await game.eval(GORE);
    const t0 = await game.eval(() => gameTime);
    const early = await game.eval(medianCpu, { t0, from: 30, to: 45 });
    const late = await game.eval(medianCpu, { t0, from: 75, to: 90 });
    const end = await game.eval(() => {
      window.__gore.stop = true;
      return { zoom: camZoom().zoom, n: players.length, standing: players.filter((p) => p.state === 'up').length, enemies: enemies.length };
    });
    const ratio = late.median / early.median;
    const summary = `2P zoom ${end.zoom} (${end.standing}/${end.n} standing, ${end.enemies} enemies): early median=${early.median.toFixed(2)}ms p99=${early.p99.toFixed(2)} late median=${late.median.toFixed(2)}ms p99=${late.p99.toFixed(2)} ratio=${ratio.toFixed(3)}`;
    console.log(`[M11PERF] ${summary}`);
    testInfo.annotations.push({ type: 'sustained 2P', description: summary });
    expect(end, 'the scene stayed 2P at zoom 0.6 with both players up').toMatchObject({ zoom: 0.6, n: 2, standing: 2 });
    expect(ratio, 'Q2a: sustained median within 15% (2P, zoom 0.6)').toBeLessThanOrEqual(1.15);
  });

  test('P2/Q2a: perfLog.totalCpuMs = build + retro + stage, and covers update plus every app.render in the frame', async ({ game }, testInfo) => {
    await startCalm(game);
    const r = await game.eval(() => new Promise((resolve) => {
      // Independent measurement of render(): wrap the renderer.
      const orig = app.renderer.render.bind(app.renderer);
      let renderMs = 0;
      app.renderer.render = (...args) => { const t = performance.now(); try { return orig(...args); } finally { renderMs += performance.now() - t; } };
      const rows = [];
      let frames = 0;
      const tick = () => {
        // Values from the frame that just completed, against the render() time accumulated over it.
        if (frames > 2) {
          rows.push({ total: perfLog.totalCpuMs, build: perfLog.buildMs, retro: perfLog.retroMs, stage: perfLog.stageMs,
            update: perfLog.updateMs, render: renderMs });
        }
        renderMs = 0;
        if (++frames < 120) requestAnimationFrame(tick);
        else { app.renderer.render = orig; resolve(rows); }
      };
      requestAnimationFrame(tick);
    }));
    for (const k of ['total', 'build', 'retro', 'stage', 'update']) {
      expect(r.every((x) => Number.isFinite(x[k])), `P2: perfLog.${k === 'total' ? 'totalCpuMs' : k + 'Ms'} is a number`).toBe(true);
    }
    for (const x of r) {
      expect(x.total, 'P2: totalCpuMs = buildMs + retroMs + stageMs').toBeCloseTo(x.build + x.retro + x.stage, 6);
      expect(x.build + 1e-9, 'P2: buildMs includes updateMs').toBeGreaterThanOrEqual(x.update);
    }
    // rAF and the ticker can be a frame apart, so compare medians.
    const med = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
    const total = med(r.map((x) => x.total));
    const parts = med(r.map((x) => x.update + x.render));
    const summary = `totalCpuMs median=${total.toFixed(2)} (build ${med(r.map((x) => x.build)).toFixed(2)} + retro ${med(r.map((x) => x.retro)).toFixed(2)} + stage ${med(r.map((x) => x.stage)).toFixed(2)}) vs update+render() ${parts.toFixed(2)}`;
    console.log(`[P2] ${summary}`);
    testInfo.annotations.push({ type: 'P2', description: summary });
    // Informational only (Ralph): the retro pass may call a renderer reference captured
    // before this wrap, so the exact-sum check above is the real proof.
    testInfo.annotations.push({ type: 'P2 cross-check', description: `total ${total.toFixed(2)} vs update+render() ${parts.toFixed(2)}` });
  });

  test('P3: walking for 30 s causes no terrain-driven frame over 16.7 ms', { tag: '@perf' }, async ({ game, page }, testInfo) => {
    test.skip(!!process.env.CI, 'absolute ms budget: dev/reference machine only (Q2a)');
    test.setTimeout(T(90_000));
    await startCalm(game);
    await game.eval(() => {
      window.__walk = { frames: 0, maxTerrain: 0, bad: [], chunks0: chunkCache.size };
      const tick = () => {
        const w = window.__walk;
        if (w.stop) return;
        const t = perfLog.terrainMs, total = perfLog.totalCpuMs;
        w.frames++;
        w.maxTerrain = Math.max(w.maxTerrain, t);
        // Terrain-caused: over budget, and under budget without the terrain time.
        if (total > 16.7 && total - t <= 16.7) w.bad.push({ total: +total.toFixed(1), terrain: +t.toFixed(1), chunks: chunkCache.size });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    // Walk in a square so new chunks keep baking (W, D, S, A for 7.5 s each).
    for (const k of ['w', 'd', 's', 'a']) {
      await page.keyboard.down(k);
      await page.waitForTimeout(7_500);
      await page.keyboard.up(k);
    }
    const w = await game.eval(() => { window.__walk.stop = true; return { ...window.__walk, chunks1: chunkCache.size }; });
    const summary = `frames=${w.frames} maxTerrainMs=${w.maxTerrain.toFixed(1)} chunks ${w.chunks0}->${w.chunks1} terrainFramesOver16.7=${w.bad.length}`;
    console.log(`[P3] ${summary}`);
    testInfo.annotations.push({ type: 'P3', description: summary + ' ' + JSON.stringify(w.bad.slice(0, 5)) });
    expect(w.bad, 'P3: terrain-caused frames over 16.7 ms').toEqual([]);
    // P3 budget: ~4 ms of chunk baking per frame, plus the rest of the terrain pass
    // (water overlay ~2-3 ms on SwiftShader), with slack.
    expect(w.maxTerrain, 'P3: per-frame terrain time within the bake budget').toBeLessThanOrEqual(8);
  });

  test('P4: decal draw calls stay <= 16 during continuous gore at MAX_BLOOD_POOLS', { tag: '@perf' }, async ({ game, page }, testInfo) => {
    test.setTimeout(T(90_000));
    await startCalm(game);
    await game.eval(() => {
      // Prefill with growing pools so the cap is hit while new pools keep growing.
      for (let i = 0; i < CFG.MAX_BLOOD_POOLS; i++) {
        const a = i * 2.399963, r = 40 + (i % 97) * 5;
        addDecal(DECAL_POOL, player.x + Math.cos(a) * r, player.y + Math.sin(a) * r, 3, 0x8a0a0a, 0, 12 + (i % 9));
      }
    });
    expect(await game.eval(() => typeof decalStats === 'function'), 'P4 hook: decalStats()').toBe(true);
    await game.eval(GORE);
    await page.waitForTimeout(4_000);
    const r = await game.eval(() => new Promise((resolve) => {
      const draws = [], pools = [];
      const t0 = performance.now();
      const tick = (now) => {
        draws.push(decalStats().draws);
        pools.push(bloodPools.length);
        if (now - t0 < 10_000) requestAnimationFrame(tick);
        else {
          window.__gore.stop = true;
          const sorted = draws.slice().sort((a, b) => a - b);
          resolve({ median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1], frames: draws.length,
            minPools: Math.min(...pools), max_: CFG.MAX_BLOOD_POOLS, kills: window.__gore.kills, stats: decalStats() });
        }
      };
      requestAnimationFrame(tick);
    }));
    const summary = `decal draws during gore median=${r.median} max=${r.max} over ${r.frames} frames; pools >= ${r.minPools}/${r.max_}; kills=${r.kills}; last=${JSON.stringify(r.stats)}`;
    console.log(`[P4] ${summary}`);
    testInfo.annotations.push({ type: 'P4', description: summary });
    expect(r.minPools, 'decal store at the cap throughout').toBeGreaterThanOrEqual(r.max_ * 0.85);
    expect(r.kills, 'gore actually ran').toBeGreaterThanOrEqual(100);
    expect(r.max, 'P4: decal draws during continuous gore').toBeLessThanOrEqual(16);
  });
});
