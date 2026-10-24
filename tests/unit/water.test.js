import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect, beforeEach } from 'vitest';
import { newRound, ROOT } from '../helpers/load-game.js';
import { LANDED } from '../milestones.js';

// G7 footprints (regression: the user likes them) and W3 "wading washes the feet".
// M9 W2-W5 (docs/SPEC.md "Water"), each gated on its own flag, further down.
const DT = 1 / 60;
let g, game, main = null;

/** Rendered terrain at a world point (tiles are drawn from their corner sample). */
const renderedType = (x, y) => {
  const ts = g.CFG.TILE_SIZE;
  return g.getTerrainTypeAt(Math.floor(x / ts) * ts, Math.floor(y / ts) * ts);
};

/** World direction the player walks while holding `key` (measured, not assumed). */
function walkDir(key) {
  const p = g.player, x0 = p.x, y0 = p.y;
  g.keys[key] = true;
  for (let i = 0; i < 5; i++) g.updatePlayer(DT);
  g.keys[key] = false;
  const dx = p.x - x0, dy = p.y - y0, l = Math.hypot(dx, dy);
  p.x = x0; p.y = y0;
  return { x: dx / l, y: dy / l };
}

/** Find a spot with `n` world units of the given terrain kind ahead along `dir`. */
function findStrip(pred, dir, len) {
  for (let r = 0; r < 60000; r += 40) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      let ok = true;
      for (let s = 0; s <= len && ok; s += 10) ok = pred(x + dir.x * s, y + dir.y * s);
      if (ok) return { x, y };
    }
  }
  return null;
}

function stepPlayer(seconds) {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    g.gameTime += DT;
    g.updatePlayer(DT);
  }
}

const footprints = () => g.bloodPools.filter((d) => d.kind === g.DECAL_FOOT);

beforeEach(() => {
  game = newRound();
  g = game.g;
  main = null;
  g.waveActive = false;
  g.waveTimer = 1e9;
  g.envObjects.length = 0;
  g.player.invincible = 1e9;
});

describe('G7 bloody footprints on land (regression)', () => {
  test.skipIf(!LANDED.M3)('G7: walking through a blood pool on land leaves footprints for ~3 s, then they stop', () => {
    const p = g.player;
    const dir = walkDir('d');
    const land = (x, y) => renderedType(x, y) !== 'water';
    const start = findStrip(land, dir, 900);
    expect(start, 'a long land strip').not.toBeNull();
    p.x = start.x; p.y = start.y;
    g.addDecal(g.DECAL_POOL, p.x, p.y, 24, g.BLOOD_COLORS[3], 0, 30);
    expect(g.isBloodAt(p.x, p.y), 'standing in the pool').toBe(true);
    const t0 = g.gameTime;
    g.keys.d = true;
    stepPlayer(5);
    g.keys.d = false;
    const prints = footprints();
    expect(prints.length, 'footprints printed').toBeGreaterThan(3);
    const ages = prints.map((d) => d.createdAt - t0);
    expect(Math.max(...ages), 'footprints stop after ~3 s off the pool').toBeLessThanOrEqual(3.5);
    expect(Math.min(...ages), 'they start right away').toBeLessThan(0.5);
  });
});

describe('W3 wading washes the feet', () => {
  test.skipIf(!LANDED.W3)('W3: footprints never print on water, and leaving water resets bloodyFeet', () => {
    const p = g.player;
    const dir = walkDir('d');
    // land (blood) -> water -> land
    const strip = (x, y) => renderedType(x, y) !== 'water';
    let start = null;
    for (let r = 0; r < 60000 && !start; r += 40) {
      for (let k = 0; k < 16 && !start; k++) {
        const a = (k / 16) * Math.PI * 2, x = Math.cos(a) * r, y = Math.sin(a) * r;
        // 60u of land, then >= 80u of water within the next 300u, then land again
        if (!strip(x, y) || !strip(x + dir.x * 60, y + dir.y * 60)) continue;
        let inWater = 0, back = false;
        for (let s = 70; s < 600; s += 10) {
          const w = !strip(x + dir.x * s, y + dir.y * s);
          if (w) inWater += 10; else if (inWater >= 80) { back = true; break; }
        }
        if (back) start = { x, y };
      }
    }
    expect(start, 'a land -> water -> land path').not.toBeNull();
    p.x = start.x; p.y = start.y;
    g.addDecal(g.DECAL_POOL, p.x, p.y, 24, g.BLOOD_COLORS[3], 0, 30);
    g.keys.d = true;
    let sawWater = false, leftWater = false, feetAfter = null;
    for (let i = 0; i < Math.round(8 / DT) && !leftWater; i++) {
      g.gameTime += DT;
      g.updatePlayer(DT);
      const wet = renderedType(p.x, p.y) === 'water';
      if (wet) sawWater = true;
      else if (sawWater) { leftWater = true; feetAfter = p.bloodyFeet; }
    }
    g.keys.d = false;
    expect(sawWater && leftWater, 'walked through the water').toBe(true);
    expect(feetAfter, 'feet washed on leaving the water').toBeLessThanOrEqual(0);
    const wetPrints = footprints().filter((d) => renderedType(d.x, d.y) === 'water');
    expect(wetPrints, 'no footprints on water tiles').toEqual([]);
  });
});

// =====================================================================
// M9 water W2-W5 (docs/SPEC.md "Water"). Each test is gated on its own flag.
// Provisional hooks (Josh): if a name changes when the item lands, change it here only.
// =====================================================================
const wfx = {
  clouds: () => g.bloodClouds,            // W3: [{ x, y, r, t, life }]
  stats: () => g.waterFxStats(),          // { clouds, splashes, decalsBlocked, camoRebakes }
  blood: (p) => g.waterBloodAt(p.x, p.y), // W5: { c, band } (band 0..4, 0 = none)
  sinkPhase: (b) => b.sinkPhase,          // W4: 'float' | 'sink' | 'dissolve'
  inWater: (b) => b.inWater === true,     // W4
};
// W5 increments (spec): amount within a radius in tiles, linear falloff.
const W5 = { hit: [0.02, 1], gib: [0.05, 2], kill: [0.15, 3] };
// Assumption (open question for Josh): an event adds to the tile concentrations at once and
// the 4 Hz tick only diffuses, decays, prunes and redraws. If events are queued until the
// next tick instead, step exactly one tick here.
function afterEvent() {}

// main.js isn't loaded headless (its async init needs a GPU). Its per-frame update() and
// resetRound() are evaluated in the game context, so the M9 update calls Josh adds (blood
// clouds, sinking, the 4 Hz W5 tick) run here too. Camera and notifications are no-ops.
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8');
function mainFunction(name) {
  const start = MAIN_SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`js/main.js: function ${name}() not found`);
  let depth = 0;
  for (let k = MAIN_SRC.indexOf('{', start); k < MAIN_SRC.length; k++) {
    if (MAIN_SRC[k] === '{') depth++;
    else if (MAIN_SRC[k] === '}' && --depth === 0) return MAIN_SRC.slice(start, k + 1);
  }
  throw new Error(`js/main.js: unbalanced braces in ${name}()`);
}
function mainHooks() {
  if (main) return main;
  for (const k of ['app', 'renderer', 'stage', 'worldContainer', 'terrainContainer', 'effectsContainer', 'uiContainer']) {
    if (!g[k]) g[k] = g.PIXI;
  }
  game.run(`var updateCamera = typeof updateCamera === 'function' ? updateCamera : function () {};
var updateNotification = typeof updateNotification === 'function' ? updateNotification : function () {};
var _renderLayersReady = true;
var __m9Update = (function () { return ${mainFunction('update')}; })();
var __m9ResetRound = (function () { return ${mainFunction('resetRound')}; })();`);
  main = { update: game.run('__m9Update'), resetRound: game.run('__m9ResetRound') };
  return main;
}
/** Run the real per-frame update for `seconds`; `each(i)` returning true stops early (returns the time). */
function mainStep(seconds, dt = DT, each) {
  const u = mainHooks().update;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    u(dt);
    if (each && each(i) === true) return (i + 1) * dt;
  }
  return Infinity;
}

// Tiles (i, j) cover [i*TS, (i+1)*TS) and are rendered from their corner sample.
const TS = () => g.CFG.TILE_SIZE;
const tileWet = (i, j) => g.getTerrainTypeAt(i * TS(), j * TS()) === 'water';
const centre = (i, j) => ({ x: (i + 0.5) * TS(), y: (j + 0.5) * TS() });
const onWater = (x, y) => renderedType(x, y) === 'water';
// The terrain is identical in every round (seeded loader): search once per file.
const found = {};
function spiral(fn, maxR = 200) {
  for (let R = 0; R < maxR; R++) {
    for (let i = -R; i <= R; i++) {
      for (let j = -R; j <= R; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== R) continue;
        const r = fn(i, j);
        if (r) return r;
      }
    }
  }
  return null;
}
/** Centre of a water tile whose (2r+1)^2 neighbourhood is all water. */
function findPond(r) {
  const key = `pond${r}`;
  if (!(key in found)) {
    found[key] = spiral((i, j) => {
      for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) if (!tileWet(i + a, j + b)) return null;
      return centre(i, j);
    });
  }
  expect(found[key], `a ${2 * r + 1}x${2 * r + 1} block of water`).toBeTruthy();
  return found[key];
}
/** Centres of `n` water tiles in a straight axis-aligned run (index = tile distance from the first). */
function runTiles(n) {
  const key = `run${n}`;
  if (!(key in found)) {
    found[key] = spiral((i, j) => {
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        let ok = true;
        for (let k = 0; k < n && ok; k++) ok = tileWet(i + k * di, j + k * dj);
        if (ok) return [...Array(n).keys()].map((k) => centre(i + k * di, j + k * dj));
      }
      return null;
    });
  }
  expect(found[key], `${n} water tiles in a row`).toBeTruthy();
  return found[key];
}
/** Every tile centre of a connected (4-neighbour) water body of minN..maxN tiles. */
function findWaterBody(minN, maxN) {
  const key = `body${minN}-${maxN}`;
  if (!(key in found)) {
    const seen = new Set();
    found[key] = spiral((i, j) => {
      if (seen.has(`${i},${j}`) || !tileWet(i, j)) return null;
      const q = [[i, j]], tiles = [];
      seen.add(`${i},${j}`);
      while (q.length && tiles.length <= maxN) {
        const [a, b] = q.pop();
        tiles.push([a, b]);
        for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const k = `${a + da},${b + db}`;
          if (!seen.has(k) && tileWet(a + da, b + db)) { seen.add(k); q.push([a + da, b + db]); }
        }
      }
      return tiles.length >= minN && tiles.length <= maxN && !q.length ? tiles.map(([a, b]) => centre(a, b)) : null;
    }, 80);
  }
  expect(found[key], `a pond of ${minN}-${maxN} tiles`).toBeTruthy();
  return found[key];
}
/** A gib already at rest on the ground at p (it lands in the first frame). */
function restingGib(p) {
  const gb = { x: p.x, y: p.y, z: 0.5, vx: 0, vy: 0, vz: -40, rot: 0, rotSpeed: 0, part: g.GIB_MEAT,
    color: 0x8a1010, size: 1.6, life: 6, smear: 0, bloodT: 1, rest: 0 };
  g.gibs.push(gb);
  return gb;
}
function dummyAt(p) {
  const e = g.spawnEnemy(0, p.x, p.y);
  e.hp = e.maxHp = 1e7;
  return e;
}

describe('W2 wading: movement unchanged', () => {
  test.skipIf(!LANDED.W2)('W2: the player still moves at PLAYER_SPEED x 0.55 on water and at full speed on land', () => {
    const p = g.player;
    const dir = walkDir('d');
    const speedOn = (pred, len) => {
      const start = findStrip(pred, dir, len);
      expect(start, 'a strip to walk on').not.toBeNull();
      p.x = start.x; p.y = start.y;
      const x0 = p.x, y0 = p.y;
      g.keys.d = true;
      stepPlayer(0.5);
      g.keys.d = false;
      return Math.hypot(p.x - x0, p.y - y0) / 0.5;
    };
    expect(speedOn((x, y) => onWater(x, y), 100), 'speed on water').toBeCloseTo(g.CFG.PLAYER_SPEED * 0.55, 0);
    expect(speedOn((x, y) => !onWater(x, y), 150), 'speed on land').toBeCloseTo(g.CFG.PLAYER_SPEED, 0);
  });
});

describe('W3 blood in water', () => {
  test.skipIf(!LANDED.W3)('W3: blood particles, drips and gibs landing on water make no decal there, but blood clouds; decalsBlocked counts them', () => {
    const c = findPond(2);
    const onW = (d) => onWater(d.x, d.y);
    const wet0 = g.bloodPools.filter(onW).length;
    const blocked0 = wfx.stats().decalsBlocked;
    for (let k = 0; k < 4; k++) g.spawnBloodSpray(c.x, c.y, (k * Math.PI) / 2, 1.0, 12);
    for (let k = 0; k < 10; k++) g.spawnBloodDrip(c.x + (k - 5) * 6, c.y, 14);
    g.spawnGibs(c.x, c.y, 0, 0, 0.3, 1);
    let maxClouds = 0;
    mainStep(7, DT, () => { maxClouds = Math.max(maxClouds, wfx.clouds().length); });
    expect(g.gibs.length, 'every gib has come down').toBe(0);
    expect(g.bloodPools.filter(onW).length - wet0, 'new decals on water tiles').toBe(0);
    expect(maxClouds, 'blood clouds instead').toBeGreaterThanOrEqual(1);
    expect(wfx.stats().decalsBlocked, 'decalsBlocked').toBeGreaterThan(blocked0);
  });
});

describe('W4 bodies sink and dissolve', () => {
  test.skipIf(!LANDED.W4)('W4: a corpse in water floats, sinks, dissolves (releasing a blood cloud) and is gone within 5 s; never baked', () => {
    const c = findPond(2);
    const e = g.spawnEnemy(0, c.x, c.y);
    const remains0 = g.envRemains.length;
    g.killEnemy(e, 0);
    const b = g.bodies[g.bodies.length - 1];
    expect(b && b.type === e.type, 'a corpse').toBe(true);
    const phases = [];
    let tIn = null, tGone = null, released = false, prevClouds = wfx.clouds().length;
    mainStep(8, DT, (i) => {
      const t = (i + 1) * DT;
      const alive = g.bodies.includes(b);
      if (alive) {
        if (tIn === null && wfx.inWater(b)) tIn = t;
        const ph = wfx.sinkPhase(b);
        if (ph && phases[phases.length - 1] !== ph) phases.push(ph);
      } else if (tGone === null) tGone = t;
      const n = wfx.clouds().length;
      if (n > prevClouds && phases[phases.length - 1] === 'dissolve' && (alive || t - tGone <= 2 * DT)) released = true;
      prevClouds = n;
      expect(g.envRemains.length, 'never baked into the remains store').toBe(remains0);
      return tGone !== null && t - tGone > 0.1;
    });
    expect(phases, 'phases in order').toEqual(['float', 'sink', 'dissolve']);
    expect(tIn, 'flagged inWater').not.toBeNull();
    expect(tGone, 'removed from bodies[]').not.toBeNull();
    expect(tGone - tIn, `gone ${(tGone - tIn).toFixed(2)} s after entering water (spec 0.5 + 2.5 + 1.5)`).toBeLessThanOrEqual(5 + DT);
    expect(tGone - tIn).toBeGreaterThanOrEqual(3.5);
    expect(released, 'a blood cloud released at the dissolve').toBe(true);
  });

  test.skipIf(!LANDED.W4)('W4: a gib that lands in water sinks within ~1 s and leaves no gib decal', () => {
    const c = findPond(2);
    const gibDecals = () => g.bloodPools.filter((d) => d.kind === g.DECAL_GIB && onWater(d.x, d.y)).length;
    const d0 = gibDecals();
    const gib = restingGib(c);
    const t = mainStep(3, DT, () => !g.gibs.includes(gib));
    expect(t, `sank after ${t.toFixed(2)} s`).toBeGreaterThanOrEqual(0.5);
    expect(t).toBeLessThanOrEqual(1.5);
    expect(gibDecals(), 'no gib decal on water').toBe(d0);
  });
});

describe('W5 water reddens with blood', () => {
  /** Linear falloff along a run of water tiles: full at the event tile, 0 beyond R tiles. */
  function checkFalloff(kind, vals) {
    const [A, R] = W5[kind];
    const msg = `${kind} (+${A} within ${R}): c along the run = ${vals.map((v) => v.toFixed(4)).join(' ')}`;
    expect(vals[0], msg).toBeGreaterThanOrEqual(A * 0.95);
    expect(vals[0], msg).toBeLessThanOrEqual(A * 1.05);
    expect(vals[R + 1], `${msg}: nothing beyond ${R} tiles`).toBeLessThanOrEqual(1e-9);
    expect(vals[R], `${msg}: the edge tile gets at most half`).toBeLessThanOrEqual(A / 2 + 1e-9);
    expect(vals[1], `${msg}: it falls off`).toBeLessThan(vals[0] - 0.1 * A);
    for (let k = 1; k < vals.length; k++) expect(vals[k], `${msg}: non-increasing`).toBeLessThanOrEqual(vals[k - 1] + 1e-9);
    // Linear: equal steps between consecutive non-zero tiles.
    const nz = vals.filter((v) => v > 1e-9).length;
    for (let k = 1; k + 1 < nz; k++) {
      expect(Math.abs(vals[k] - vals[k + 1] - (vals[0] - vals[1])), `${msg}: linear steps`).toBeLessThanOrEqual(0.1 * A);
    }
  }
  const cAlong = (T) => T.map((t) => wfx.blood(t).c);

  test.skipIf(!LANDED.W5)('W5: a hit in water adds +0.02 within 1 tile, linear falloff', () => {
    const T = runTiles(W5.hit[1] + 2);
    g.damageEnemy(dummyAt(T[0]), 1, 0);
    afterEvent();
    checkFalloff('hit', cAlong(T));
  });

  test.skipIf(!LANDED.W5)('W5: a gib landing in water adds +0.05 within 2 tiles, linear falloff', () => {
    const T = runTiles(W5.gib[1] + 2);
    const gib = restingGib(T[0]);
    for (let i = 0; i < 3 / DT && g.gibs.includes(gib); i++) g.updateGibs(DT); // gibs only: no W5 tick
    expect(g.gibs.includes(gib), 'the gib came down').toBe(false);
    afterEvent();
    checkFalloff('gib', cAlong(T));
  });

  test.skipIf(!LANDED.W5)('W5: a kill in water adds +0.15 within 3 tiles, linear falloff; c is capped at 1 (top band 4)', () => {
    const T = runTiles(W5.kill[1] + 2);
    // A gibbing kill leaves no corpse, so the +0.15 is the kill's own (its gibs are still airborne).
    g.killEnemy(g.spawnEnemy(0, T[0].x, T[0].y), 0, g.SRC_EXPLOSIVE);
    afterEvent();
    checkFalloff('kill', cAlong(T));
    for (let k = 0; k < 10; k++) g.killEnemy(g.spawnEnemy(0, T[0].x, T[0].y), 0, g.SRC_EXPLOSIVE);
    afterEvent();
    const b = wfx.blood(T[0]);
    expect(b.c, 'capped at 1').toBeLessThanOrEqual(1);
    expect(b.c).toBeGreaterThanOrEqual(0.99);
    expect(b.band, 'top band at c = 1').toBe(4);
  });

  test.skipIf(!LANDED.W5)('W5: after 180 game-s idle the blood in a whole pond has halved (+-10%)', () => {
    // Fill a whole connected pond close to c = 1, so diffusion inside it moves almost nothing,
    // with gibbing kills (no corpse whose dissolve would add later), let the gibs sink (W4) and
    // the clouds fade (W3), then idle 180 s.
    const tiles = findWaterBody(9, 150);
    for (let pass = 0; pass < 5; pass++) {
      for (const t of tiles) { const e = g.spawnEnemy(0, t.x, t.y); if (e) g.killEnemy(e, 0, g.SRC_EXPLOSIVE); }
    }
    mainStep(16, DT);
    expect(g.gibs.length, 'every gib has come down').toBe(0);
    expect(g.bodies.filter((b) => onWater(b.x, b.y)).length, 'no corpse left in the water').toBe(0);
    const c0 = tiles.map((t) => wfx.blood(t).c);
    expect(Math.min(...c0), `setup: every tile reddened (min c ${Math.min(...c0).toFixed(3)})`).toBeGreaterThan(0.2);
    mainStep(180, 1 / 30);
    const c1 = tiles.map((t) => wfx.blood(t).c);
    const sum = (xs) => xs.reduce((a, x) => a + x, 0);
    const ratios = c1.map((c, k) => c / c0[k]).sort((a, b) => a - b);
    const total = sum(c1) / sum(c0), median = ratios[ratios.length >> 1];
    const msg = `${tiles.length} tiles: total ${sum(c0).toFixed(2)} -> ${sum(c1).toFixed(2)} (x${total.toFixed(3)}), median tile x${median.toFixed(3)}`;
    expect(total, msg).toBeGreaterThanOrEqual(0.45);
    expect(total, msg).toBeLessThanOrEqual(0.55);
    expect(median, msg).toBeGreaterThanOrEqual(0.45);
    expect(median, msg).toBeLessThanOrEqual(0.55);
  }, 60_000);

  test.skipIf(!LANDED.W5)('W5: tiles that fall below c = 0.02 are pruned (read 0, band 0); a stronger tile is not', () => {
    const T = runTiles(4);
    g.damageEnemy(dummyAt(T[0]), 1, 0); // +0.02 at T[0]
    afterEvent();
    expect(wfx.blood(T[0]).c, 'the hit registered').toBeGreaterThan(0.0199);
    g.enemies.length = 0; g.particles.length = 0; // nothing else adds blood
    mainStep(1);
    for (const t of T) expect(wfx.blood(t), 'pruned').toEqual(expect.objectContaining({ c: 0, band: 0 }));
    g.killEnemy(g.spawnEnemy(0, T[0].x, T[0].y), 0, g.SRC_EXPLOSIVE); // +0.15
    afterEvent();
    mainStep(1);
    expect(wfx.blood(T[0]).c, 'a 0.15 tile survives 1 s').toBeGreaterThan(0.1);
  });

  test.skipIf(!LANDED.W5)('W5: resetRound clears the blood state', () => {
    const T = runTiles(2);
    g.killEnemy(g.spawnEnemy(0, T[0].x, T[0].y), 0, g.SRC_EXPLOSIVE);
    afterEvent();
    expect(wfx.blood(T[0]).c).toBeGreaterThan(0);
    mainHooks().resetRound();
    expect(wfx.blood(T[0]), 'cleared').toEqual(expect.objectContaining({ c: 0, band: 0 }));
  });
});
