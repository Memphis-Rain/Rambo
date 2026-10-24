import { test, expect, T } from './fixtures.js';
import { LANDED } from '../milestones.js';

// Must-fixes from the review of Josh's first build (spec dfe6194): G9 limits,
// D6 decal/HUD isolation, G4 draw-call bound. Skipped until REVIEW1 lands.
test.skip(!LANDED.REVIEW1, 'REVIEW1 not landed (tests/milestones.js)');

/** Count WebGL draw calls. Must run before the page loads (addInitScript). */
async function instrumentDrawCalls(page) {
  await page.addInitScript(() => {
    window.__draws = 0;
    for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!C) continue;
      for (const fn of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
        const orig = C.prototype[fn];
        if (!orig) continue;
        C.prototype[fn] = function (...args) { window.__draws++; return orig.apply(this, args); };
      }
    }
  });
}

/** Median draw calls per display frame over `frames` frames. */
async function drawsPerFrame(game, frames = 40) {
  return game.eval((n) => new Promise((resolve) => {
    const per = [];
    let last = window.__draws;
    const tick = () => {
      per.push(window.__draws - last);
      last = window.__draws;
      if (per.length > n) {
        per.shift(); // first sample spans a partial frame
        per.sort((a, b) => a - b);
        resolve({ median: per[per.length >> 1], max: per[per.length - 1] });
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), frames);
}

async function startCalm(game) {
  await game.boot();
  await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
  await game.start();
  await game.freezeWaves();
}

test.describe('Q2/G4 draw calls', () => {
  test('G4: decal draws stay <= 16 at MAX_BLOOD_POOLS', async ({ game, page }, testInfo) => {
    await instrumentDrawCalls(page);
    await startCalm(game);
    await game.advance(0.5);
    const base = await drawsPerFrame(game);
    const filled = await game.eval(() => {
      for (let i = 0; i < CFG.MAX_BLOOD_POOLS; i++) {
        const a = (i * 2.399963) % (Math.PI * 2), r = 40 + (i % 97) * 5;
        addDecal(i % 7, player.x + Math.cos(a) * r, player.y + Math.sin(a) * r, 4 + (i % 6), 0x8a0a0a, a);
      }
      return { decals: bloodPools.length, max: CFG.MAX_BLOOD_POOLS };
    });
    await game.advance(0.5);
    const full = await drawsPerFrame(game);
    const decalDraws = full.median - base.median;
    const summary = `decals=${filled.decals}/${filled.max} draws/frame base=${base.median} full=${full.median} (max ${full.max}) decalDraws=${decalDraws}`;
    console.log(`[G4] ${summary}`);
    testInfo.annotations.push({ type: 'draw-calls', description: summary });
    expect(filled.decals).toBe(filled.max);
    expect.soft(decalDraws, 'G4: decal draw calls at MAX_BLOOD_POOLS').toBeLessThanOrEqual(16);
  });

  test('Q2: draw calls are bounded with 40 enemies + 50 corpses', async ({ game, page }, testInfo) => {
    await instrumentDrawCalls(page);
    await startCalm(game);
    const counts = await game.eval(() => {
      unlockedWeapons = WEAPONS.length; // 50 kills pass unlock scores; no boss spawns
      for (let i = 0; i < 50; i++) {
        const a = (i / 50) * Math.PI * 2;
        killEnemy(spawnEnemy(i % 4, player.x + Math.cos(a) * 160, player.y + Math.sin(a) * 160), a);
      }
      for (let i = 0; i < 40; i++) {
        const a = (i / 40) * Math.PI * 2;
        spawnEnemy(i % 4, player.x + Math.cos(a) * 280, player.y + Math.sin(a) * 280);
      }
      return { enemies: enemies.length, bodies: bodies.length };
    });
    await game.advance(1.5);
    const d = await drawsPerFrame(game, 60);
    const summary = `enemies=${counts.enemies} corpses=${counts.bodies} draws/frame median=${d.median} max=${d.max}`;
    console.log(`[Q2] ${summary}`);
    testInfo.annotations.push({ type: 'draw-calls', description: summary });
    expect(counts.enemies).toBe(40);
    // Recorded for trend; generous ceiling so only a per-entity draw explosion fails.
    expect.soft(d.median, 'Q2: draw calls per frame').toBeLessThanOrEqual(300);
  });
});

/**
 * Record hit-stops by wrapping the global addHitStop (game code calls it through
 * the global binding). A stop "starts" when a call takes hitStopTimer from 0 to > 0.
 */
const HITSTOP_RECORDER = () => {
  const orig = addHitStop;
  window.__stops = [];
  window.addHitStop = (sec) => {
    const before = hitStopTimer;
    orig(sec);
    if (before <= 0 && hitStopTimer > 0) window.__stops.push({ t: performance.now() / 1000, len: hitStopTimer });
    else if (hitStopTimer > 0 && window.__stops.length) {
      const s = window.__stops[window.__stops.length - 1];
      s.len = Math.max(s.len, hitStopTimer);
    }
  };
};

/** Kills/explosions driven from the frame loop (setInterval is throttled by the busy main thread). */
const runScenario = ({ seconds, killsPerSec, explosionsPerSec }) => new Promise((resolve) => {
  const t0 = gameTime;
  let start = null, last = null, clampedWall = 0, kills = 0, booms = 0;
  const tick = (now) => {
    if (start === null) { start = last = now; requestAnimationFrame(tick); return; }
    const dtWall = (now - last) / 1000;
    last = now;
    clampedWall += Math.min(dtWall, 0.05); // the loop clamps dt to 0.05 s
    const elapsed = (now - start) / 1000;
    while (kills < elapsed * killsPerSec) {
      const a = Math.random() * Math.PI * 2;
      const e = spawnEnemy(kills % 3, player.x + Math.cos(a) * 120, player.y + Math.sin(a) * 120);
      // Mix of regular kills and overkill (Minigun bursts often overkill weak enemies).
      if (e) damageEnemy(e, kills % 2 ? e.hp + 1 : e.hp * 3, a, SRC_BULLET);
      kills++;
    }
    while (booms < elapsed * explosionsPerSec) {
      spawnExplosion(player.x + 200, player.y, 150);
      booms++;
    }
    if (elapsed < seconds) requestAnimationFrame(tick);
    else resolve({ sim: gameTime - t0, clampedWall, wall: elapsed, kills, booms, stops: window.__stops.slice() });
  };
  requestAnimationFrame(tick);
});

function stopStats(stops) {
  let minGap = null;
  for (let i = 1; i < stops.length; i++) {
    // Gap from the end of the previous stop to the start of this one.
    const gap = stops[i].t - (stops[i - 1].t + stops[i - 1].len);
    minGap = minGap === null ? gap : Math.min(minGap, gap);
  }
  return { count: stops.length, maxLen: Math.max(0, ...stops.map((s) => s.len)), minGap };
}

async function armedGame(game) {
  await startCalm(game);
  await game.eval(() => {
    unlockedWeapons = WEAPONS.length;
    player.weapon = 4; // Minigun
    player.magAmmo = WEAPONS[4].mag;
  });
  await game.eval(HITSTOP_RECORDER);
}

test.describe('G9 hit-stop rate', () => {
  test('G9: Minigun at 10 kills/s for 10 s keeps simulated time >= 90% of wall time', async ({ game }, testInfo) => {
    test.setTimeout(T(60_000));
    await armedGame(game);
    const r = await game.eval(runScenario, { seconds: 10, killsPerSec: 10, explosionsPerSec: 0 });
    const st = stopStats(r.stops);
    const ratio = r.sim / r.clampedWall;
    const summary = `sim=${r.sim.toFixed(2)}s clampedWall=${r.clampedWall.toFixed(2)}s wall=${r.wall.toFixed(2)}s ratio=${(ratio * 100).toFixed(1)}% kills=${r.kills} stops=${st.count} maxStop=${st.maxLen.toFixed(3)}s`;
    console.log(`[G9] ${summary}`);
    testInfo.annotations.push({ type: 'hit-stop', description: summary });
    expect(r.kills).toBeGreaterThanOrEqual(95);
    // Compared with wall time after the loop's own 0.05 s dt clamp, so a slow
    // software-WebGL frame rate isn't counted as hit-stop loss.
    expect(ratio, 'G9: simulated time vs wall time').toBeGreaterThanOrEqual(0.9);
    expect(st.count, 'G9: ordinary kills and overkill do not hit-stop').toBe(0);
  });

  test('G9: explosion hit-stops are <= 0.06 s and >= 0.3 s apart', async ({ game }, testInfo) => {
    test.setTimeout(T(60_000));
    await armedGame(game);
    // An explosion (radius 150) every 0.1 s: far more triggers than the cooldown allows.
    const r = await game.eval(runScenario, { seconds: 3, killsPerSec: 0, explosionsPerSec: 10 });
    const st = stopStats(r.stops);
    const summary = `explosions=${r.booms} stops=${st.count} maxStop=${st.maxLen.toFixed(3)}s minGap=${st.minGap?.toFixed(3)}s`;
    console.log(`[G9] ${summary}`);
    testInfo.annotations.push({ type: 'hit-stop', description: summary });
    expect(st.count, 'radius >= 100 explosions do hit-stop').toBeGreaterThan(0);
    expect(st.maxLen, 'G9: single stop <= 0.06 s').toBeLessThanOrEqual(0.06 + 1e-9);
    // Stop length is in game seconds and the start times are wall clock; allow one frame of slack.
    expect(st.minGap, 'G9: >= 0.3 s between stops').toBeGreaterThanOrEqual(0.25);
    expect(st.count, 'G9: cooldown caps the stop rate').toBeLessThanOrEqual(Math.ceil(3 / 0.3) + 1);
  });
});

test.describe('D6 demo isolation', () => {
  test('D6: no blood, bloody feet or decals carry from the demo into a real game', async ({ game, page }) => {
    await game.boot();
    await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
    await game.eval(() => startDemo());
    await page.waitForFunction(() => demoState().active && demoState().elapsed > 1);
    // Make sure there is blood exactly where a new game spawns the player.
    await game.eval(() => {
      addDecal(DECAL_POOL, 0, 0, 20, 0x8a0a0a, 0, 30);
      addDecal(DECAL_SPLAT, 5, 5, 6, 0x8a0a0a);
    });
    await page.waitForFunction(() => bloodPools.length > 0 && isBloodAt(0, 0));
    await game.eval(() => stopDemo());
    await game.start();
    const s = await game.eval(() => ({
      blood: isBloodAt(player.x, player.y), feet: player.bloodyFeet,
      decals: bloodPools.length, gibs: gibs.length, bodies: bodies.length,
    }));
    expect(s.blood, 'isBloodAt(player)').toBe(false);
    expect(s.feet || 0, 'player.bloodyFeet').toBeFalsy();
    expect(s.decals, 'decal store').toBe(0);
    expect(s.gibs).toBe(0);
    expect(s.bodies).toBe(0);
  });

  test('D6: the HUD is hidden on the title after stopDemo()', async ({ game, page }) => {
    await game.boot();
    await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
    await game.eval(() => startDemo());
    await page.waitForFunction(() => demoState().active && demoState().elapsed > 1);
    expect(await game.eval(() => uiContainer.visible), 'HUD visible during the demo').toBe(true);
    await game.eval(() => stopDemo());
    await expect(page.locator('#start-screen')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await game.eval(() => uiContainer.visible), 'D6: uiContainer hidden on the title').toBe(false);
  });
});
