import { test, expect, T } from './fixtures.js';
import { LANDED } from '../milestones.js';

// T12 / M8 physical environment, e2e half (spec 2a33306, rulings E10, D3b).
// The Q1 console guard from fixtures.js applies to every test.
// Frame-time numbers are recorded as annotations; the 16.7 ms bar (Q2a) is a soft
// check off CI only (SwiftShader), the real-GPU number comes from `npm run perf:bfg`.
test.skip(!LANDED.M8, 'M8 not landed (tests/milestones.js)');

const ON_CI = !!process.env.CI;

async function startCalm(game) {
  await game.boot();
  await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
  await game.start();
  await game.freezeWaves();
  await game.eval(() => { unlockedWeapons = WEAPONS.length; player.invincible = 1e9; });
}

/** In-page: centre of the most forested chunk neighbourhood near the origin, by the
 *  generator's own isForest rule (count of forest chunks in its 3x3) minus the share of
 *  water in it (trees are rejected on water); nearest wins a tie, centre on dry land.
 *  The noise permutation is random per page load, so this searches every time. */
const FIND_FOREST = () => {
  const cs = CFG.CHUNK_SIZE * CFG.TILE_SIZE;
  const info = new Map();
  const chunk = (cx, cy) => {
    const k = cx + ',' + cy;
    if (!info.has(k)) {
      let wet = 0;
      for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) if (getTerrainTypeAt((cx + (i + 0.5) / 5) * cs, (cy + (j + 0.5) / 5) * cs) === 'water') wet++;
      info.set(k, { forest: fbm(cx * cs * 0.001, cy * cs * 0.001, 3) + 0.5 > 0.5, dry: 1 - wet / 25 });
    }
    return info.get(k);
  };
  let best = null;
  for (let cy = -20; cy <= 20; cy++) {
    for (let cx = -20; cx <= 20; cx++) {
      let n = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const c = chunk(cx + i, cy + j); if (c.forest) n += c.dry; }
      const x = (cx + 0.5) * cs, y = (cy + 0.5) * cs, d = Math.hypot(x, y);
      if (getTerrainTypeAt(x, y) === 'water') continue;
      if (!best || n > best.n + 1e-9 || (Math.abs(n - best.n) < 1e-9 && d < best.d)) best = { x, y, n: +n.toFixed(2), d: Math.round(d) };
    }
  }
  return best;
};

/** Teleport player + camera (no smoothing lag) and let the chunks bake. */
async function teleport(game, x, y) {
  await game.eval(([px, py]) => {
    player.x = px; player.y = py;
    const s = toScreen(px, py);
    cam.x = cam.tx = s.x; cam.y = cam.ty = s.y;
  }, [x, y]);
  await game.advance(0.5);
}

/** Wait (game time) until no env object is moving, nothing queued and all debris baked. */
async function waitEnvAsleep(game, timeout = 30_000) {
  await game.page.waitForFunction(() => {
    const s = envStats();
    return s.active === 0 && s.queued === 0 && s.debris === 0;
  }, null, { timeout: T(timeout) });
}

test.describe('T12 environment physics', () => {
  test('E2/E9/E10e: an RPG explosion beside a tree topples it (falling -> fallen) and its remains bake and stay drawn', async ({ game, page }, testInfo) => {
    await startCalm(game);
    // An isolated tree near the start, then stand 150 units from it so it is on screen.
    const tree = await game.eval(() => {
      const ok = (o) => o.type === 'tree' && Math.hypot(o.x, o.y) > 200 &&
        envObjects.every((q) => q === o || !q.collision || Math.hypot(q.x - o.x, q.y - o.y) > 100);
      const t = envObjects.filter(ok).sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y))[0];
      return t && { id: t.id, x: t.x, y: t.y, collision: t.collision };
    });
    expect(tree, 'an isolated tree near the start').toBeTruthy();
    await teleport(game, tree.x, tree.y + 150);
    expect(await game.eval((id) => envState(id).state, tree.id)).toBe('standing');

    // RPG-class explosion (radius of the RPG) at f = 0.8, the player as source.
    const right = await game.eval((t) => {
      const R = WEAPONS.find((w) => w.name === 'RPG').radius;
      spawnExplosion(t.x - 0.2 * R, t.y, R, true, SRC_EXPLOSIVE);
      return envState(t.id).state;
    }, tree);
    expect(right, 'falling right after the blast').toBe('falling');
    // Record the state sequence frame by frame until the remains are baked.
    const seq = await game.eval((id) => new Promise((resolve) => {
      const states = [];
      const tick = () => {
        const s = envState(id).state;
        if (states[states.length - 1] !== s) states.push(s);
        const baked = envRemains.some((r) => r.id === id && r.remain === 'log');
        if (baked || states.length > 5) resolve({ states, baked });
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }), tree.id);
    expect(seq.states, 'state sequence').toEqual(['falling', 'fallen']);
    expect(seq.baked, 'stump + log baked into the remains store').toBe(true);
    await game.advance(0.3);
    const after = await game.eval((id) => ({
      collision: envObjects.find((o) => o.id === id).collision,
      layer: typeof envLayerStats === 'function' ? envLayerStats() : null,
      felled: envStats().felled,
    }), tree.id);
    expect(after.collision, 'stump circle').toBe(await game.eval(() => CFG.ENV_STUMP_R));
    expect(after.felled).toBe(1);
    expect(after.layer, 'envLayerStats() hook').toBeTruthy();
    expect(after.layer.draws, 'remains layer drawn').toBeGreaterThanOrEqual(1);
    await game.snap(testInfo, 'E2-felled-tree.png');

    // E10e: gore far past the decal cap does not recycle the remains.
    await game.eval((t) => {
      for (let i = 0; i < CFG.MAX_BLOOD_POOLS * 3; i++) {
        addDecal(DECAL_POOL, t.x + (i % 60) - 30, t.y + ((i * 7) % 60) - 30, 3, 0x8a0a0a, 0);
      }
    }, tree);
    await game.advance(0.3);
    const flooded = await game.eval((id) => ({
      pools: bloodPools.length, max: CFG.MAX_BLOOD_POOLS,
      remain: envRemains.some((r) => r.id === id && r.remain === 'log'),
      log: envLogs.some((r) => r.id === id),
      layer: envLayerStats(),
    }), tree.id);
    testInfo.annotations.push({ type: 'E10e', description: JSON.stringify(flooded) });
    expect(flooded.pools).toBeLessThanOrEqual(flooded.max);
    expect(flooded.remain && flooded.log, 'log remain + capsule kept').toBe(true);
    expect(flooded.layer.draws, 'remains still drawn after the gore flood').toBeGreaterThanOrEqual(1);
    await game.snap(testInfo, 'E10e-after-gore-flood.png');
  });

  test('E7: resetRound restores an intact world', async ({ game }) => {
    await startCalm(game);
    const t = await game.eval(() => {
      const o = envObjects.filter((q) => q.type === 'tree' && Math.hypot(q.x, q.y) > 200)
        .sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y))[0];
      const collision = o.collision;
      spawnExplosion(o.x - 26, o.y, 130, true, SRC_EXPLOSIVE);
      return { id: o.id, collision };
    });
    await game.page.waitForFunction((id) => envRemains.some((r) => r.id === id), t.id, { timeout: T(15_000) });
    // A new mission (startGame -> resetRound), then let the chunks regenerate.
    await game.eval(() => startGame());
    await game.page.waitForFunction((id) => gameStarted && gameTime > 0.3 && envObjects.some((o) => o.id === id), t.id, { timeout: T(15_000) });
    const s = await game.eval((id) => ({
      state: envState(id).state,
      collision: envObjects.find((o) => o.id === id).collision,
      logs: envLogs.length, remains: envRemains.length, stats: envStats(),
      layerChunks: typeof envLayerStats === 'function' ? envLayerStats().chunks : -1,
    }), t.id);
    expect(s.state).toBe('standing');
    expect(s.collision, 'trunk collision back').toBe(t.collision);
    expect(s.logs + s.remains, 'no logs or remains').toBe(0);
    expect(s.stats).toMatchObject({ active: 0, debris: 0, felled: 0 });
    expect(s.layerChunks, 'remains layer emptied').toBe(0);
  });

  test('E8/Q2a: BFG explosions in a forest fell 10+ trees; per-frame CPU time recorded (<= 16.7 ms off CI)', async ({ game }, testInfo) => {
    test.setTimeout(T(120_000));
    await startCalm(game);
    const spot = await game.eval(FIND_FOREST);
    expect(spot, 'a forest area').toBeTruthy();
    await teleport(game, spot.x, spot.y);
    await game.advance(1); // outer ring baked, steady state
    const bfgR = await game.eval(() => WEAPONS.find((w) => w.name === 'BFG').radius);
    // Densest BFG centres: one BFG topples only the trees within (1 - ENV_TOPPLE_F) * R
    // (112 units), which at the generator's forest density is ~5 trees. Pick disjoint
    // centres (densest first, max 3) until 10+ trees will topple, all fired in one frame.
    const plan = await game.eval((R) => {
      const rr = R * (1 - CFG.ENV_TOPPLE_F) - 2;
      const trees = envObjects.filter((o) => (o.type === 'tree' || o.type === 'pine') && Math.hypot(o.x - player.x, o.y - player.y) < 700);
      const cnt = (x, y, used) => trees.filter((t) => !used.has(t) && Math.hypot(t.x - x, t.y - y) < rr);
      const used = new Set(), centres = [];
      while (used.size < 10 && centres.length < 3) {
        let best = null;
        for (const c of trees) { const n = cnt(c.x, c.y, used); if (!best || n.length > best.n.length) best = { x: c.x, y: c.y, n }; }
        if (!best || !best.n.length) break;
        best.n.forEach((t) => used.add(t));
        centres.push({ x: best.x, y: best.y, n: best.n.length });
      }
      return { centres, expected: used.size };
    }, bfgR);
    testInfo.annotations.push({ type: 'forest', description: `at (${spot.x}, ${spot.y}), ${spot.n}/9 forest chunks; BFG centres ${JSON.stringify(plan.centres)}` });
    expect(plan.centres[0].n, 'one BFG fells several trees (E2)').toBeGreaterThanOrEqual(4);
    expect(plan.expected, 'trees in the topple radius of the planned BFGs').toBeGreaterThanOrEqual(10);
    await teleport(game, plan.centres[0].x, plan.centres[0].y);

    const r = await game.eval(([R, centres]) => new Promise((resolve) => {
      const before = perfLog.totalCpuMs;
      for (const c of centres) spawnExplosion(c.x, c.y, R, true, SRC_BFG);
      const frames = [];
      const t0 = gameTime;
      const tick = () => {
        frames.push(perfLog.totalCpuMs);
        const s = envStats();
        if ((gameTime - t0 > 1.5 && s.active === 0 && s.queued === 0 && s.debris === 0) || gameTime - t0 > 8) {
          const sorted = frames.slice().sort((a, b) => a - b);
          resolve({ before, frames: frames.length, max: sorted[sorted.length - 1], p95: sorted[Math.floor(sorted.length * 0.95)],
            median: sorted[sorted.length >> 1], over: frames.filter((x) => x > 16.7).length, felled: s.felled,
            worst: frames.map((x, i) => [i, +x.toFixed(2)]).sort((a, b) => b[1] - a[1]).slice(0, 5), gameSecs: gameTime - t0 });
        } else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }), [bfgR, plan.centres]);
    const summary = `${plan.centres.length} BFG(s) felled ${r.felled}; ${r.frames} frames over ${r.gameSecs.toFixed(1)} game-s: totalCpuMs median ${r.median.toFixed(2)}, p95 ${r.p95.toFixed(2)}, max ${r.max.toFixed(2)}, frames > 16.7 ms: ${r.over}; worst [frame, ms] ${JSON.stringify(r.worst)}`;
    console.log(`[E8/Q2a] ${summary}`);
    testInfo.annotations.push({ type: 'E8/Q2a', description: summary });
    expect(r.felled, '10+ trees felled').toBeGreaterThanOrEqual(10);
    if (!ON_CI) expect.soft(r.max, 'Q2a: no frame over 16.7 ms after the BFG (soft, SwiftShader)').toBeLessThanOrEqual(16.7);
  });

  test('G4/E8: decal draws stay <= 16 while a forest is destroyed and after', async ({ game }, testInfo) => {
    test.setTimeout(T(120_000));
    await startCalm(game);
    const spot = await game.eval(FIND_FOREST);
    await teleport(game, spot.x, spot.y);
    await game.advance(1);
    const r = await game.eval(() => new Promise((resolve) => {
      const R = WEAPONS.find((w) => w.name === 'BFG').radius;
      const cx = player.x, cy = player.y;
      const offs = [[0, 0], [200, 0], [-200, 0], [0, 200], [0, -200], [150, 150], [-150, -150]];
      let k = 0, maxD = 0, maxEnv = 0;
      const draws = [];
      const t0 = gameTime;
      const tick = () => {
        if (k < offs.length && gameTime - t0 > k * 0.4) {
          spawnExplosion(cx + offs[k][0], cy + offs[k][1], R, true, SRC_BFG);
          // Each blast's own gore (gibs) on top: a few kills right there.
          for (let i = 0; i < 4; i++) {
            const e = spawnEnemy(i % 6, cx + offs[k][0] + i * 10, cy + offs[k][1]);
            damageEnemy(e, e.hp * 3, Math.random() * 6.28, SRC_EXPLOSIVE);
          }
          k++;
        }
        const d = decalStats().draws;
        draws.push(d);
        maxD = Math.max(maxD, d);
        maxEnv = Math.max(maxEnv, envLayerStats().draws);
        const s = envStats();
        if ((k === offs.length && s.active === 0 && s.queued === 0 && s.debris === 0) || gameTime - t0 > 20) {
          resolve({ maxDuring: maxD, maxEnv, frames: draws.length, felled: s.felled, pools: bloodPools.length, stats: decalStats(), env: envLayerStats() });
        } else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    await game.advance(1);
    const after = await game.eval(() => ({ decal: decalStats(), env: envLayerStats() }));
    const summary = `felled ${r.felled}; decal draws max during ${r.maxDuring} over ${r.frames} frames, after ${after.decal.draws}; env remains layer max ${r.maxEnv}, after ${after.env.draws} (${after.env.chunks} chunks); pools ${r.pools}`;
    console.log(`[G4/E8] ${summary}`);
    testInfo.annotations.push({ type: 'G4/E8', description: summary });
    expect(r.felled, 'forest destroyed (10+ trees felled)').toBeGreaterThanOrEqual(10);
    expect(r.maxDuring, 'G4: decal draws during the destruction').toBeLessThanOrEqual(16);
    expect(after.decal.draws, 'G4: decal draws after the forest is destroyed').toBeLessThanOrEqual(16);
  });

  test('D3b: in demo runs at wave 10 in a forest, < 15% of the bot\'s shots end on environment objects', { tag: '@perf' }, async ({ game }, testInfo) => {
    test.setTimeout(T(240_000));
    await game.boot();
    await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; if (demoState().active) stopDemo(); });
    const spot = await game.eval(FIND_FOREST);
    expect(spot, 'a forest area').toBeTruthy();
    // Classify every player bullet that leaves `bullets` during updateBullets():
    //  enemy  - it was passed to bulletHitEnemy this frame (non-piercing hit)
    //  env    - envBulletHit was called this frame with its exact velocity (stopped by a
    //           trunk / stump / crate / sandbag; an RPG/BFG that detonated on one counts too)
    //  barrel - hitBarrel called this frame and the bullet is neither of the above
    //  expiry - life ran out
    // Piercing rounds never end on a hit; they count when they expire.
    await game.eval(() => {
      const c = window.__d3b = { enemy: 0, env: 0, barrel: 0, expiry: 0, other: 0, on: false, byWeapon: {} };
      const tally = (kind) => {
        c[kind]++;
        const w = c.byWeapon[WEAPONS[player.weapon].name] ||= { ended: 0, env: 0 };
        w.ended++;
        if (kind === 'env') w.env++;
      };
      let hitE = new Set(), envV = [], barrelN = 0;
      const wrap = (name, pre) => {
        const orig = window[name];
        window[name] = function (...args) { pre(...args); return orig.apply(this, args); };
      };
      wrap('bulletHitEnemy', (b) => hitE.add(b));
      wrap('envBulletHit', (o, hx, hy, vx, vy) => envV.push(vx, vy));
      wrap('hitBarrel', () => { barrelN++; });
      const origUpdate = window.updateBullets;
      window.updateBullets = function (dt) {
        if (!c.on) return origUpdate.call(this, dt);
        const mine = bullets.filter((b) => b.owner === 'player');
        hitE = new Set(); envV = []; barrelN = 0;
        const r = origUpdate.call(this, dt);
        const still = new Set(bullets);
        for (const b of mine) {
          if (still.has(b)) continue;
          if (b.life <= 0) { tally('expiry'); continue; }
          if (hitE.has(b)) { tally('enemy'); continue; }
          let env = false;
          for (let i = 0; i < envV.length; i += 2) if (envV[i] === b.vx && envV[i + 1] === b.vy) { env = true; break; }
          if (env && !b.pierce) tally('env');
          else if (barrelN) tally('barrel');
          else c.other++;
        }
        return r;
      };
    });

    const runs = [];
    let measured = 0;
    for (let run = 0; run < 4 && measured < 60; run++) {
      await game.eval((s) => {
        CFG.DEMO_MAX_SECONDS = 1e9;
        startDemo();
        // Forest-heavy area: move the bot and its leash origin into the forest.
        player.x = s.x; player.y = s.y;
        _demo.originX = s.x; _demo.originY = s.y;
        const sp = toScreen(s.x, s.y);
        cam.x = cam.tx = sp.x; cam.y = cam.ty = sp.y;
      }, spot);
      // Let waves start and chunks bake before counting.
      await game.page.waitForFunction(() => !demoState().active || (demoState().elapsed > 2 && wave >= 10), null, { timeout: T(30_000) });
      const r = await game.eval((seconds) => new Promise((resolve) => {
        const c = window.__d3b;
        const c0 = { ...c };
        const t0 = gameTime, w0 = wave;
        let trunks = 0, samples = 0;
        const trunks0 = envObjects.filter((o) => (o.type === 'tree' || o.type === 'pine' || o.type === 'deadtree') &&
          Math.hypot(o.x - player.x, o.y - player.y) < 400).length;
        const all0 = envObjects.length, d0 = Math.hypot(player.x - _demo.originX, player.y - _demo.originY);
        c.on = true;
        const tick = () => {
          if (samples++ % 30 === 0) {
            trunks += envObjects.filter((o) => (o.type === 'tree' || o.type === 'pine' || o.type === 'deadtree') &&
              Math.hypot(o.x - player.x, o.y - player.y) < 400).length;
          }
          if (demoState().active && gameTime - t0 < seconds) { requestAnimationFrame(tick); return; }
          c.on = false;
          const d = {};
          for (const k of ['enemy', 'env', 'barrel', 'expiry', 'other']) d[k] = c[k] - c0[k];
          resolve({ ...d, gameSecs: gameTime - t0, wave0: w0, wave1: wave, trunksNear: trunks / Math.ceil(samples / 30),
            dist: Math.hypot(player.x - _demo.originX, player.y - _demo.originY), trunks0, all0, d0, active: demoState().active });
        };
        requestAnimationFrame(tick);
      }), 30);
      runs.push(r);
      measured += r.gameSecs;
      if (await game.eval(() => demoState().active)) await game.eval(() => stopDemo());
    }
    const tot = { enemy: 0, env: 0, barrel: 0, expiry: 0, other: 0 };
    for (const r of runs) for (const k of Object.keys(tot)) tot[k] += r[k];
    const ended = tot.enemy + tot.env + tot.barrel + tot.expiry;
    const share = tot.env / Math.max(1, ended);
    const summary = `${runs.length} runs, ${measured.toFixed(1)} game-s at waves ${runs.map((r) => `${r.wave0}-${r.wave1}`).join(', ')}; ` +
      `bullets ended: enemy ${tot.enemy}, env ${tot.env}, barrel ${tot.barrel}, expiry ${tot.expiry} (other ${tot.other}); ` +
      `env share ${(share * 100).toFixed(1)}%; trunks within 400: ${runs.map((r) => r.trunksNear.toFixed(0)).join(', ')}; spot ${JSON.stringify(spot)}; ` +
      JSON.stringify(runs.map((r) => ({ trunks0: r.trunks0, all0: r.all0, d0: r.d0, dist: r.dist })));
    const byWeapon = await game.eval(() => window.__d3b.byWeapon);
    console.log(`[D3b] ${summary}`);
    console.log(`[D3b] by weapon (approx: weapon held when the bullet ended) ${JSON.stringify(byWeapon)}`);
    testInfo.annotations.push({ type: 'D3b by weapon', description: JSON.stringify(byWeapon) });
    testInfo.annotations.push({ type: 'D3b', description: summary });
    expect(measured, 'game-seconds of demo measured').toBeGreaterThanOrEqual(30);
    expect(ended, 'the bot fired').toBeGreaterThanOrEqual(100);
    expect(runs.every((r) => r.wave0 >= 10), 'measured from wave 10').toBe(true);
    expect(Math.min(...runs.map((r) => r.trunksNear)), 'forest-heavy: trunks within 400 units of the bot').toBeGreaterThanOrEqual(15);
    expect(share, 'D3b: share of demo shots that end on environment objects').toBeLessThan(0.15);
  });
});

// M8R: fixes from the manager's M8 review. Gated on LANDED.M8R; M8R_MEASURE=1 runs them early.
test.describe('M8R review fixes', () => {
  test.skip(!(LANDED.M8R || process.env.M8R_MEASURE), 'M8R not landed (tests/milestones.js)');

  test('M8R: remains-layer Graphics stay bounded by the loaded chunks while roaming, and remains reappear on return', async ({ game }, testInfo) => {
    test.setTimeout(T(180_000));
    await startCalm(game);
    expect(await game.eval(() => typeof envLayerStats), 'envLayerStats() hook').toBe('function');
    const spot = await game.eval(FIND_FOREST);
    const cs = await game.eval(() => CFG.CHUNK_SIZE * CFG.TILE_SIZE);
    const fellHere = () => game.eval(() => {
      const R = WEAPONS.find((w) => w.name === 'RPG').radius;
      const ts = envObjects.filter((o) => (o.type === 'tree' || o.type === 'pine') && envState(o.id).state === 'standing' &&
        Math.hypot(o.x - player.x, o.y - player.y) < 300).slice(0, 3);
      for (const t of ts) spawnExplosion(t.x - 0.2 * R, t.y, R, true, SRC_EXPLOSIVE);
      return ts.map((t) => t.id);
    });
    await teleport(game, spot.x, spot.y);
    const first = await fellHere();
    expect(first.length, 'trees felled at the start').toBeGreaterThan(0);
    await waitEnvAsleep(game);
    const samples = [];
    for (let k = 1; k <= 16; k++) {
      await teleport(game, spot.x + k * 2 * cs, spot.y + (k % 2) * cs);
      await fellHere();
      await waitEnvAsleep(game);
      samples.push(await game.eval(() => {
        // Loaded chunks that hold at least one remain (same chunk key as chunkCache)
        const cs2 = CFG.CHUNK_SIZE * CFG.TILE_SIZE;
        const keys = new Set(envRemains.map((r) => Math.floor(r.x / cs2) + ',' + Math.floor(r.y / cs2)).filter((k) => chunkCache.has(k)));
        return { layer: envLayerStats().chunks, loaded: chunkCache.size, loadedWithRemains: keys.size, remains: envRemains.length };
      }));
    }
    const summary = samples.map((s) => `${s.layer}/${s.loadedWithRemains}/${s.loaded}(${s.remains})`).join(' ');
    testInfo.annotations.push({ type: 'M8R remains-layer Graphics / loaded chunks with remains / loaded chunks (remains)', description: summary });
    console.log(`[M8R remains] ${summary}`);
    for (const [i, s] of samples.entries()) {
      expect(s.layer, `stop ${i + 1}: remains-layer Graphics <= loaded chunks`).toBeLessThanOrEqual(s.loaded);
      expect(s.layer, `stop ${i + 1}: remains-layer Graphics <= loaded chunks that hold remains (none kept for unloaded chunks)`).toBeLessThanOrEqual(s.loadedWithRemains);
    }
    // Back to the start: the first felled trees are drawn again.
    await teleport(game, spot.x, spot.y);
    await game.advance(0.5);
    const back = await game.eval((ids) => ({
      kept: ids.filter((id) => envRemains.some((r) => r.id === id && r.remain === 'log')).length,
      draws: envLayerStats().draws,
    }), first);
    expect(back.kept, 'remains kept in the store').toBe(first.length);
    expect(back.draws, 'remains drawn again on return').toBeGreaterThanOrEqual(1);
  });
});
