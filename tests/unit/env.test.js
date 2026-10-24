import { describe, test, expect, beforeEach } from 'vitest';
import { loadGame, newRound } from '../helpers/load-game.js';
import { LANDED } from '../milestones.js';

// T12 / M8 physical environment (spec 2a33306, rulings E10). Skipped until M8 is marked landed.
// Thresholds come from CFG.ENV_* (E9); only the spec's own numbers (120 / 40 damage,
// +30% trees, 64 active objects) are written out here.
const todo = !LANDED.M8;

const TRUNKED = new Set(['tree', 'pine', 'deadtree', 'bush', 'boulder']);

/** Load the game and generate `n` chunks headless (render calls hit the PIXI stub). */
function generateWorld({ seed = 1, n = 200 } = {}) {
  const game = loadGame({ seed });
  const { g } = game;
  // Rendering targets are unset without initPixiApp(); point them at the PIXI stub.
  for (const k of ['app', 'renderer', 'stage', 'worldContainer', 'terrainContainer', 'effectsContainer', 'uiContainer']) g[k] = g.PIXI;
  g.W = 1280; g.H = 720;
  g.player = g.createPlayer();
  const side = Math.ceil(Math.sqrt(n));
  const chunks = [];
  for (let i = 0; i < n; i++) chunks.push([(i % side) - (side >> 1), Math.floor(i / side) - (side >> 1)]);
  for (const [cx, cy] of chunks) g.generatePixiChunk(cx, cy);
  return game;
}

/** Terrain type as rendered: each tile is drawn from the sample at its corner. */
function renderedType(g, x, y) {
  const ts = g.CFG.TILE_SIZE;
  return g.getTerrainTypeAt(Math.floor(x / ts) * ts, Math.floor(y / ts) * ts);
}

describe('E0 no trees in water', () => {
  test.skipIf(todo)('E0: no tree, pine, dead tree, bush or boulder stands on a rendered water tile (200 chunks)', () => {
    const { g } = generateWorld({ n: 200 });
    const objs = g.envObjects.filter((o) => TRUNKED.has(o.type));
    expect(objs.length, 'objects generated').toBeGreaterThan(1000);
    // The world must actually contain water for the check to mean anything.
    let waterTiles = 0;
    const ts = g.CFG.TILE_SIZE, sz = g.CFG.CHUNK_SIZE;
    for (let x = -8 * sz; x < 8 * sz; x++) for (let y = -8 * sz; y < 8 * sz; y++) if (g.getTerrainTypeAt(x * ts, y * ts) === 'water') waterTiles++;
    expect(waterTiles, 'water tiles in the sampled world').toBeGreaterThan(50);
    const wet = objs.filter((o) => renderedType(g, o.x, o.y) === 'water')
      .map((o) => ({ type: o.type, x: Math.round(o.x), y: Math.round(o.y), unsnapped: g.getTerrainTypeAt(o.x, o.y) }));
    expect(wet, `${wet.length} of ${objs.length} trunks on rendered water`).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// E1 tree density
// ---------------------------------------------------------------------
// Method: the pre-M8 generator is not in the tree any more, so its tree loop is
// reproduced below verbatim from `git show 982e2e9:js/pixi-terrain.js` (the last
// commit before 44eba13 "M8 E0 + E1"):
//   numTrees = isForest ? floor(30 + rng2()*20) : floor(5 + rng2()*12)
//   skip |x|,|y| < 150 (spawn area); skip if getTerrainTypeAt is water at the
//   point or at +-30 on either axis; then one rng2() for the type and 2 (tree,
//   pine) or 1 (bush, dead tree) for its size.
// It runs against the same seededRand / fbm / getTerrainTypeAt in the same vm
// context, chunk by chunk, and is compared with the objects the NEW
// generatePixiChunk() actually places for the same chunk (trees, pines, bushes
// and dead trees: everything the "Trees and bushes" loop spawns). Comparing
// placed objects (not attempts) includes the effect of the changed E0 check.
const TREE_LOOP = new Set(['tree', 'pine', 'bush', 'deadtree']);

function oldTreeCount(g, cx, cy) {
  const sz = g.CFG.CHUNK_SIZE, ts = g.CFG.TILE_SIZE;
  const rng2 = g.seededRand(cx * 12345 + cy * 67890);
  const isForest = g.fbm(cx * sz * ts * 0.001, cy * sz * ts * 0.001, 3) + 0.5 > 0.5;
  const numTrees = isForest ? Math.floor(30 + rng2() * 20) : Math.floor(5 + rng2() * 12);
  const T = g.getTerrainTypeAt;
  let n = 0;
  for (let i = 0; i < numTrees; i++) {
    const ox = (cx * sz + rng2() * sz) * ts;
    const oy = (cy * sz + rng2() * sz) * ts;
    if (Math.abs(ox) < 150 && Math.abs(oy) < 150) continue;
    if (T(ox, oy) === 'water' || T(ox + 30, oy) === 'water' || T(ox - 30, oy) === 'water' ||
      T(ox, oy + 30) === 'water' || T(ox, oy - 30) === 'water') continue;
    const treeType = rng2();
    if (treeType < 0.75) { rng2(); rng2(); } else rng2();
    n++;
  }
  return { n, isForest };
}

describe('E1 more trees', () => {
  test.skipIf(todo)('E1: tree density is +30% +-5% against the pre-M8 generator for the same chunks, forest and open ground alike', () => {
    const { g } = generateWorld({ n: 0 });
    const acc = { forest: { old: 0, now: 0 }, open: { old: 0, now: 0 } };
    for (let cx = -10; cx < 10; cx++) {
      for (let cy = -10; cy < 10; cy++) {
        const before = g.envObjects.length;
        g.generatePixiChunk(cx, cy);
        const placed = g.envObjects.slice(before).filter((o) => TREE_LOOP.has(o.type)).length;
        const old = oldTreeCount(g, cx, cy);
        const a = old.isForest ? acc.forest : acc.open;
        a.old += old.n; a.now += placed;
      }
    }
    const ratio = (a) => a.now / a.old;
    const total = { old: acc.forest.old + acc.open.old, now: acc.forest.now + acc.open.now };
    const msg = `old/new: forest ${acc.forest.old}/${acc.forest.now}, open ${acc.open.old}/${acc.open.now}`;
    expect(acc.forest.old, 'forest chunks sampled').toBeGreaterThan(1000);
    expect(acc.open.old, 'open chunks sampled').toBeGreaterThan(500);
    expect(ratio(total), `overall ${msg}`).toBeGreaterThanOrEqual(1.25);
    expect(ratio(total), `overall ${msg}`).toBeLessThanOrEqual(1.35);
    for (const k of ['forest', 'open']) {
      expect(ratio(acc[k]), `${k}: ${msg}`).toBeGreaterThanOrEqual(1.25);
      expect(ratio(acc[k]), `${k}: ${msg}`).toBeLessThanOrEqual(1.35);
    }
    // The clear spawn area is kept.
    const inSpawn = g.envObjects.filter((o) => TREE_LOOP.has(o.type) && Math.abs(o.x) < 150 && Math.abs(o.y) < 150);
    expect(inSpawn, 'no tree in the clear spawn area').toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Headless round with hand-placed env objects (E2-E6, E8, E10a)
// ---------------------------------------------------------------------
const RPG_R = 130; // WEAPONS RPG radius (asserted below)
const DT = 1 / 60;
const typeIdx = (g, name) => g.ENEMY_TYPES.findIndex((t) => t.name === name);

let g;
let seq = 0;
function fresh() {
  g = newRound().g;
  g.unlockedWeapons = g.WEAPONS.length;
  g.waveActive = false;
  g.waveTimer = 1e9;
  g.envObjects.length = 0;
  g.player.x = 0; g.player.y = 0;
}

const DEFAULTS = {
  tree: { radius: 40, height: 100, collision: 8 },
  pine: { radius: 30, height: 90, collision: 7 },
  deadtree: { height: 45 },
  bush: { radius: 18 },
  crate: {},
  sandbag: { width: 40 },
  boulder: { radius: 22, collision: 14 },
  ruins: { width: 30, height: 25 },
};

/** Put an env object into the world, shaped like the generator's objects (stable id). */
function place(type, x, y, extra = {}) {
  const o = { x, y, type, ...DEFAULTS[type], createdAt: -1, ...extra, id: `test#${++seq}` };
  g.envObjects.push(o);
  return o;
}

/** A player explosion of radius R placed so that `o` sits at f = 1 - d/R, blast coming from angle `from`. */
function blastAt(o, f, { R = RPG_R, from = Math.PI, byPlayer = true, src } = {}) {
  const d = (1 - f) * R;
  const x = o.x + Math.cos(from) * d, y = o.y + Math.sin(from) * d;
  g.spawnExplosion(x, y, R, byPlayer, src === undefined ? g.SRC_EXPLOSIVE : src);
  return { x, y };
}

function stepEnv(seconds, each) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    g.updateEnv(DT);
    if (each) each(i);
  }
}

/** Step until `pred()` holds; returns the game seconds it took, or Infinity. */
function stepUntil(pred, maxSeconds) {
  for (let i = 0; i < Math.round(maxSeconds / DT); i++) {
    if (pred()) return i * DT;
    g.updateEnv(DT);
  }
  return pred() ? maxSeconds : Infinity;
}

const felled = (id) => ['falling', 'fallen'].includes(g.envState(id).state);
const logOf = (o) => g.envLogs.find((r) => r.id === o.id);

/** Point the mouse at a world position (no frame drawn yet, so the offset is W/2 - cam). */
function aimAt(wx, wy) {
  const s = g.toScreen(wx, wy);
  g.mouseX = s.x + g.W / 2 - g.cam.x;
  g.mouseY = s.y + g.H / 2 - g.cam.y;
}

/** Fire one shot of the named weapon through the real input path, then re-aim its
 *  rounds exactly at (wx, wy) so spread can't decide the outcome. Returns the new bullets. */
function shoot(name, wx, wy) {
  const weapon = g.WEAPONS.findIndex((w) => w.name === name);
  const p = g.player;
  const n0 = g.bullets.length;
  p.weapon = weapon;
  p.magAmmo = g.WEAPONS[weapon].mag;
  p.reloading = false;
  p.fireTimer = 0;
  p.spinUp = 1;
  aimAt(wx, wy);
  g.mouseJustPressed = true;
  g.mouseDown = true;
  g.updatePlayer(0.001);
  g.mouseDown = false;
  g.mouseJustPressed = false;
  const shots = g.bullets.slice(n0);
  for (const b of shots) {
    const sp = Math.hypot(b.vx, b.vy), dx = wx - b.x, dy = wy - b.y, d = Math.hypot(dx, dy);
    b.vx = (dx / d) * sp; b.vy = (dy / d) * sp;
  }
  return shots;
}

function stepBullets(frames = 120) {
  for (let i = 0; i < frames && g.bullets.length; i++) {
    g.updateBullets(DT);
    g.processPendingDamage();
  }
}

/** A stationary enemy that survives any hit. */
function dummy(name, x, y) {
  const e = g.spawnEnemy(typeIdx(g, name), x, y);
  e.hp = e.maxHp = 1e7;
  return e;
}

const barkChips = () => g.particles.filter((p) => p.type === 'debris' &&
  (g.ENV_BARK_COLORS.includes(p.color) || g.ENV_DEADWOOD_COLORS.includes(p.color))).length;
const playerHealth = () => g.player.hp + g.player.shield;

/** An enemy bullet shaped like the one updateEnemies() pushes (combat.js), aimed exactly. */
function enemyBullet(x, y, tx, ty, { speed = 400, explosive = false } = {}) {
  const d = Math.hypot(tx - x, ty - y);
  const b = {
    x, y, vx: ((tx - x) / d) * speed, vy: ((ty - y) / d) * speed,
    dmg: 10, life: 2, owner: 'enemy', color: '#f44', size: 2, trail: false,
    explosive, radius: explosive ? 60 : 0,
  };
  g.bullets.push(b);
  return b;
}

describe('M8 environment physics (headless)', () => {
  beforeEach(fresh);

  test.skipIf(todo)('E9: hooks and CFG thresholds exist', () => {
    for (const fn of ['envState', 'envStats', 'envBlast', 'updateEnv', 'resetEnvState', 'resolveEnvCollision']) {
      expect(typeof g[fn], fn).toBe('function');
    }
    for (const k of ['ENV_SCORCH_F', 'ENV_TOPPLE_F', 'ENV_DEADTREE_TOPPLE_F', 'ENV_BREAK_F', 'ENV_CRACK_F', 'ENV_TREE_HP', 'ENV_STUMP_R', 'ENV_LOG_R']) {
      expect(typeof g.CFG[k], `CFG.${k}`).toBe('number');
    }
    expect(g.CFG.MAX_DEBRIS, 'CFG.MAX_DEBRIS default').toBe(300);
    expect(g.WEAPONS.find((w) => w.name === 'RPG').radius).toBe(RPG_R);
    const t = place('tree', 100, 0);
    expect(g.envState(t.id)).toMatchObject({ state: 'standing', hp: g.CFG.ENV_TREE_HP, sway: 0 });
    expect(g.envStats()).toMatchObject({ active: 0, debris: 0, felled: 0 });
  });

  // -------------------------------------------------------------- E2
  test.skipIf(todo)('E2: a weak blast (small f) only sways the tree, away from the blast, and it settles', () => {
    const t = place('tree', 300, 0);
    const f = g.CFG.ENV_SCORCH_F / 2;
    blastAt(t, f, { from: Math.PI }); // blast to the west: pushed toward world +x = screen +x
    let peak = 0, settledAt = Infinity;
    stepEnv(4, (i) => {
      const s = g.envState(t.id).sway;
      if (Math.abs(s) > Math.abs(peak)) peak = s;
      if (settledAt === Infinity && g.envStats().active === 0) settledAt = (i + 1) * DT;
    });
    const s = g.envState(t.id);
    expect(s.state, 'still standing').toBe('standing');
    expect(s.scorch, 'not scorched').toBe(0);
    expect(s.hp, 'blast damage f * CFG.ENV_BLAST_DMG').toBeCloseTo(g.CFG.ENV_TREE_HP - f * g.CFG.ENV_BLAST_DMG, 6);
    expect(peak, 'swayed toward screen +x (away from a blast in the west)').toBeGreaterThan(0.005);
    expect(settledAt, 'sway settles and the tree leaves the active set').toBeLessThan(2.5);
    expect(s.sway, 'at rest').toBe(0);

    // Mirror: blast from the east leans it the other way.
    const t2 = place('tree', -300, 0);
    blastAt(t2, f, { from: 0 });
    let peak2 = 0;
    stepEnv(0.5, () => { const v = g.envState(t2.id).sway; if (Math.abs(v) > Math.abs(peak2)) peak2 = v; });
    expect(peak2, 'blast from the east leans toward screen -x').toBeLessThan(-0.005);
  });

  test.skipIf(todo)('E2: the strongest non-toppling sway settles in ~1.5 s (damped spring)', () => {
    const t = place('tree', 300, 0);
    blastAt(t, g.CFG.ENV_TOPPLE_F - 0.02, { from: Math.PI * 0.75 });
    const settled = stepUntil(() => g.envStats().active === 0, 5);
    expect(felled(t.id)).toBe(false);
    // "~1.5 s": accept 0.75-2.5 s for the largest sway a standing tree can get.
    expect(settled, 'seconds until the sway is at rest').toBeGreaterThan(0.75);
    expect(settled, 'seconds until the sway is at rest').toBeLessThan(2.5);
  });

  test.skipIf(todo)('E2: f above CFG.ENV_SCORCH_F scorches (persistent), below it does not', () => {
    const a = place('tree', 300, 0);
    const b = place('tree', -300, 0);
    blastAt(a, g.CFG.ENV_SCORCH_F + 0.05);
    blastAt(b, g.CFG.ENV_SCORCH_F - 0.05);
    stepEnv(3);
    expect(g.envState(a.id)).toMatchObject({ state: 'scorched', scorch: 1 });
    expect(g.envState(b.id)).toMatchObject({ state: 'standing', scorch: 0 });
    expect(felled(a.id) || felled(b.id), 'neither topples').toBe(false);
  });

  test.skipIf(todo)('E2: f above CFG.ENV_TOPPLE_F topples the tree away from the blast over ~0.6-0.9 s; log and stump bake', () => {
    for (const type of ['tree', 'pine']) {
      fresh();
      const t = place(type, 300, 40);
      const blast = blastAt(t, g.CFG.ENV_TOPPLE_F + 0.05, { from: Math.PI * 0.8 });
      expect(g.envState(t.id).state, `${type}: falling right after the blast`).toBe('falling');
      // Time the rotation: from the first frame fall > 0 until state = fallen.
      let start = -1, landed = -1;
      stepEnv(3, (i) => {
        const s = g.envState(t.id);
        if (start < 0 && s.fall > 0) start = i;
        if (landed < 0 && s.state === 'fallen') landed = i;
      });
      expect(landed, `${type}: landed`).toBeGreaterThan(0);
      const dur = (landed - start + 1) * DT;
      expect(dur, `${type}: fall duration (s)`).toBeGreaterThanOrEqual(g.CFG.ENV_FALL_MIN - 2 * DT);
      expect(dur, `${type}: fall duration (s)`).toBeLessThanOrEqual(g.CFG.ENV_FALL_MAX + 2 * DT);
      expect(g.CFG.ENV_FALL_MIN).toBeGreaterThanOrEqual(0.6);
      expect(g.CFG.ENV_FALL_MAX).toBeLessThanOrEqual(0.9);
      const log = logOf(t);
      expect(log, `${type}: a log capsule exists`).toBeTruthy();
      // Away from the blast: the log's far end lies on the other side of the stump.
      const away = (log.bx - t.x) * (t.x - blast.x) + (log.by - t.y) * (t.y - blast.y);
      expect(away, `${type}: fell away from the blast`).toBeGreaterThan(0);
      expect(g.envRemains.includes(log), `${type}: stump + log baked into the remains store`).toBe(true);
      expect(log.baked).toBe(true);
      expect(g.envStats().felled).toBe(1);
      expect(g.envStats().active, 'asleep again').toBe(0);
    }
  });

  test.skipIf(todo)('E2: repeated sub-threshold blasts accumulate damage and topple the tree', () => {
    const t = place('tree', 300, 0);
    const f = g.CFG.ENV_TOPPLE_F - 0.05;
    blastAt(t, f);
    stepEnv(2);
    expect(felled(t.id), 'one blast below the topple threshold leaves it standing').toBe(false);
    let n = 1;
    while (!felled(t.id) && n < 10) { blastAt(t, f); stepEnv(2); n++; }
    expect(felled(t.id), 'cumulative damage topples it').toBe(true);
    expect(n, 'blasts needed').toBe(Math.ceil(g.CFG.ENV_TREE_HP / (f * g.CFG.ENV_BLAST_DMG)));
  });

  test.skipIf(todo)('E2: one RPG-sized blast in a grove fells several trees at once', () => {
    const trees = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      trees.push(place('tree', 300 + Math.cos(a) * 30, Math.sin(a) * 30));
    }
    g.spawnExplosion(300, 0, RPG_R, true, g.SRC_EXPLOSIVE);
    stepEnv(4);
    expect(trees.filter((t) => g.envState(t.id).state === 'fallen').length).toBe(8);
  });

  // -------------------------------------------------------------- E3
  test.skipIf(todo)('E3: small arms never fell a tree; bullets chip bark and give a tiny sway', () => {
    const t = place('tree', 120, 0);
    const chips0 = barkChips();
    shoot('M16', t.x, t.y);
    let peak = 0;
    for (let i = 0; i < 30; i++) { g.updateBullets(DT); g.updateEnv(DT); peak = Math.max(peak, Math.abs(g.envState(t.id).sway)); }
    expect(barkChips(), 'bark chips from one hit').toBeGreaterThan(chips0);
    expect(peak, 'tiny sway from one hit').toBeGreaterThan(0);
    // Tinier than the weakest blast sway (f = 0.2)
    const ref = place('tree', -300, 0);
    blastAt(ref, 0.2);
    let refPeak = 0;
    stepEnv(0.6, () => { refPeak = Math.max(refPeak, Math.abs(g.envState(ref.id).sway)); });
    expect(peak, 'bullet sway < a weak blast sway').toBeLessThan(refPeak);

    for (const name of ['Pistol', 'Uzi', 'Shotgun', 'M16', 'Minigun', 'Tesla', 'Plasma', 'Railgun', 'Disintegrator']) {
      for (let i = 0; i < 60; i++) {
        shoot(name, t.x, t.y);
        g.updateBullets(DT); g.updateBullets(DT); g.updateEnv(DT);
        g.bullets.length = 0;
      }
      expect(felled(t.id), `${name}: 60 shots never fell the tree`).toBe(false);
    }
    stepEnv(3);
    expect(['standing', 'scorched']).toContain(g.envState(t.id).state);
  });

  // -------------------------------------------------------------- E4
  test.skipIf(todo)('E4: crates and sandbags are destroyed above CFG.ENV_BREAK_F, not below', () => {
    expect(g.CFG.ENV_BREAK_F).toBeCloseTo(0.3, 6);
    const above = [place('crate', 300, 0), place('sandbag', 300, 300)];
    const below = [place('crate', -300, 0), place('sandbag', -300, -300)];
    for (const o of above) blastAt(o, g.CFG.ENV_BREAK_F + 0.03);
    for (const o of below) blastAt(o, g.CFG.ENV_BREAK_F - 0.03);
    for (const o of above) expect(g.envState(o.id).state, `${o.type} at f > break`).toBe('destroyed');
    for (const o of below) expect(g.envState(o.id).state, `${o.type} at f < break`).not.toBe('destroyed');
    expect(g.envStats().debris, 'splinters / sand fly as debris').toBeGreaterThan(0);
    // Debris settles and bakes into the decal pool (wood / sand kinds).
    const decals0 = g.bloodPools.length;
    stepEnv(6);
    expect(g.envStats().debris, 'all debris settled').toBe(0);
    const baked = g.bloodPools.slice(decals0).filter((d) => d.kind === g.DECAL_WOOD || d.kind === g.DECAL_SAND);
    expect(baked.length, 'settled debris baked as wood/sand decals').toBeGreaterThan(0);
  });

  test.skipIf(todo)('E4: crates break after enough bullet damage', () => {
    const c = place('crate', 120, 0);
    let shots = 0;
    while (g.envState(c.id).state !== 'destroyed' && shots < 50) { shoot('Pistol', c.x, c.y); stepBullets(); shots++; }
    expect(g.envState(c.id).state).toBe('destroyed');
    expect(shots, 'pistol shots to break a crate').toBe(Math.ceil(g.CFG.ENV_CRATE_HP / g.WEAPONS[0].dmg));
  });

  test.skipIf(todo)('E4: dead trees snap above CFG.ENV_DEADTREE_TOPPLE_F (lower than live trees)', () => {
    expect(g.CFG.ENV_DEADTREE_TOPPLE_F).toBeCloseTo(0.4, 6);
    expect(g.CFG.ENV_DEADTREE_TOPPLE_F).toBeLessThan(g.CFG.ENV_TOPPLE_F);
    const snap = place('deadtree', 300, 0);
    const keep = place('deadtree', -300, 0);
    const live = place('tree', 0, 300);
    const f = g.CFG.ENV_DEADTREE_TOPPLE_F + 0.03;
    blastAt(snap, f);
    blastAt(keep, g.CFG.ENV_DEADTREE_TOPPLE_F - 0.03);
    blastAt(live, f);
    stepEnv(3);
    expect(g.envState(snap.id).state, 'dead tree above its threshold').toBe('fallen');
    expect(felled(keep.id), 'dead tree below its threshold').toBe(false);
    expect(felled(live.id), 'a live tree at the same f stays up').toBe(false);
  });

  test.skipIf(todo)('E4: boulders and ruins crack above CFG.ENV_CRACK_F and shatter under a BFG', () => {
    const b = place('boulder', 300, 0);
    const r = place('ruins', -300, 0);
    const soft = place('boulder', 0, 300);
    blastAt(b, g.CFG.ENV_CRACK_F + 0.05);
    blastAt(r, g.CFG.ENV_CRACK_F + 0.05);
    blastAt(soft, g.CFG.ENV_CRACK_F - 0.05);
    expect(g.envState(b.id)).toMatchObject({ cracked: true });
    expect(g.envState(r.id)).toMatchObject({ cracked: true });
    expect(g.envState(b.id).state).not.toBe('destroyed');
    expect(g.envState(soft.id).cracked, 'below the crack threshold').toBe(false);
    expect(b.collision, 'a cracked boulder is still solid').toBe(14);
    const bfgR = g.WEAPONS.find((w) => w.name === 'BFG').radius;
    blastAt(b, g.CFG.ENV_SHATTER_F + 0.05, { R: bfgR, src: g.SRC_BFG });
    expect(g.envState(b.id).state, 'shattered by the BFG').toBe('destroyed');
    expect(g.envRemains.some((x) => x.id === b.id && x.remain === 'rubble'), 'rubble footprint kept').toBe(true);
  });

  // -------------------------------------------------------------- E5
  test.skipIf(todo)('E5: a fallen log blocks the player and enemies, but bullets fly over it; the stump is a small circle', () => {
    const p = g.player;
    // Which world direction does holding S walk? (measured, not assumed)
    g.keys.s = true;
    for (let i = 0; i < 10; i++) g.updatePlayer(DT);
    g.keys.s = false;
    const ul = Math.hypot(p.x, p.y), ux = p.x / ul, uy = p.y / ul;
    const nx = -uy, ny = ux; // perpendicular
    p.x = 0; p.y = 0;
    // Tree 100 ahead and 40 to the side; it falls along +n, across the walking path.
    const t = place('tree', ux * 100 - nx * 40, uy * 100 - ny * 40);
    blastAt(t, 0.8, { from: Math.atan2(-ny, -nx) });
    stepEnv(3);
    const log = logOf(t);
    expect(log, 'log capsule').toBeTruthy();
    expect(t.collision, 'stump circle').toBe(g.CFG.ENV_STUMP_R);
    expect(t.collision, 'stump is smaller than the trunk').toBeLessThan(8);
    expect(log.logLen, 'log reaches across the path').toBeGreaterThan(60);

    // Before E11a logs were walls; E11a makes them hurdles (tested separately below).
    if (LANDED.E11) return;
    // Player walks into the log and is stopped by it.
    g.keys.s = true;
    let maxAlong = 0;
    for (let i = 0; i < 180; i++) { g.updatePlayer(DT); maxAlong = Math.max(maxAlong, p.x * ux + p.y * uy); }
    g.keys.s = false;
    expect(maxAlong, 'player never crosses the log').toBeLessThanOrEqual(100 - log.logR - 10 + 0.5);
    expect(maxAlong, 'player walked up to the log').toBeGreaterThan(100 - log.logR - 10 - 5);

    // An enemy on the far side chasing the player never ends a frame inside the capsule.
    const e = g.spawnEnemy(typeIdx(g, 'Militia'), ux * 160, uy * 160);
    const er = log.logR + 8 * e.size;
    let minD = Infinity;
    for (let i = 0; i < 240; i++) { g.updateEnemies(DT); minD = Math.min(minD, Math.sqrt(g.envSegDist2(e.x, e.y, log))); }
    expect(minD, 'enemy blocked by the log capsule').toBeGreaterThanOrEqual(er - 0.5);
    g.enemies.length = 0;

    // Bullets fly over: a shot across the log hits the enemy behind it.
    p.x = 0; p.y = 0;
    const behind = dummy('Militia', ux * 200, uy * 200);
    shoot('M16', behind.x, behind.y);
    stepBullets();
    expect(behind.hp, 'bullet flew over the log').toBeLessThan(behind.maxHp);

    // The stump still stops a round aimed through it.
    g.enemies.length = 0;
    const sx = t.x - p.x, sy = t.y - p.y, sl = Math.hypot(sx, sy);
    const back = dummy('Militia', t.x + (sx / sl) * 60, t.y + (sy / sl) * 60);
    shoot('M16', t.x, t.y);
    stepBullets();
    expect(back.hp, 'stump stops a non-piercing round').toBe(back.maxHp);
  });

  test.skipIf(todo)('E5: destroyed crates and sandbags lose their collision; intact ones block', () => {
    for (const type of ['crate', 'sandbag']) {
      fresh();
      const o = place(type, 150, 0);
      const ent = { x: 150 - 12, y: 0 };
      g.resolveEnvCollision(ent, 10);
      expect(Math.hypot(ent.x - o.x, ent.y - o.y), `${type}: intact blocks`).toBeGreaterThan(12.5);
      const e1 = dummy('Militia', 300, 0);
      shoot('M16', 300, 0);
      stepBullets();
      expect(e1.hp, `${type}: intact stops a bullet`).toBe(e1.maxHp);

      blastAt(o, 0.6);
      expect(g.envState(o.id).state).toBe('destroyed');
      expect(o.collision || 0, `${type}: no collision once destroyed`).toBe(0);
      const ent2 = { x: 150 - 3, y: 0 };
      g.resolveEnvCollision(ent2, 10);
      expect(ent2, `${type}: destroyed does not push`).toEqual({ x: 147, y: 0 });
      shoot('M16', 300, 0);
      stepBullets();
      expect(e1.hp, `${type}: destroyed lets bullets through`).toBeLessThan(e1.maxHp);
    }
  });

  // -------------------------------------------------------------- E6
  function fellOnto({ byPlayer = true, enemyHp = 1e7 } = {}) {
    // Tree at (300, 0), height 100 -> log along +x from the stump; blast from the west.
    const t = place('tree', 300, 0);
    const e = g.spawnEnemy(typeIdx(g, 'Militia'), 345, 3);
    e.hp = e.maxHp = enemyHp;
    const clear = g.spawnEnemy(typeIdx(g, 'Militia'), 345, 60);
    clear.hp = clear.maxHp = 1e7;
    g.player.x = 330; g.player.y = -4;
    g.player.invincible = 0; g.player.dodging = false;
    const hits = [];
    const orig = g.damageEnemy;
    g.damageEnemy = (target, dmg, ...rest) => { hits.push({ target, dmg }); return orig(target, dmg, ...rest); };
    return { t, e, clear, hits, restore: () => { g.damageEnemy = orig; }, blast: () => blastAt(t, 0.8, { byPlayer }) };
  }

  test.skipIf(todo)('E6: a falling trunk deals 120 to enemies and 40 to the player, once', () => {
    const s = fellOnto();
    try {
      const hp0 = playerHealth();
      s.blast();
      expect(s.e.hp, 'the explosion itself does not hurt enemies here').toBe(s.e.maxHp);
      expect(playerHealth(), 'the explosion itself does not hurt the player here').toBe(hp0);
      const landed = stepUntil(() => g.envState(s.t.id).state === 'fallen', 3);
      expect(landed).toBeLessThan(3);
      expect(s.e.maxHp - s.e.hp, 'enemy under the trunk').toBe(120);
      expect(hp0 - playerHealth(), 'player under the trunk').toBe(40);
      expect(s.clear.hp, 'enemy beside the trunk is untouched').toBe(s.clear.maxHp);
      stepEnv(5);
      expect(s.hits.filter((h) => h.target === s.e).length, 'applied once').toBe(1);
      expect(s.e.maxHp - s.e.hp, 'still 120 after the log settled').toBe(120);
      expect(hp0 - playerHealth(), 'still 40 after the log settled').toBe(40);
      expect(g.CFG.ENV_FALL_ENEMY_DMG).toBe(120);
      expect(g.CFG.ENV_FALL_PLAYER_DMG).toBe(40);
    } finally { s.restore(); }
  });

  test.skipIf(todo)('E6/E10d: a trunk kill credits score and combo when the player\'s explosion felled it, not otherwise', () => {
    for (const byPlayer of [true, false]) {
      fresh();
      const s = fellOnto({ byPlayer, enemyHp: 100 });
      try {
        g.combo = 2;
        const before = { score: g.score, kills: g.kills, combo: g.combo };
        s.blast();
        stepUntil(() => g.envState(s.t.id).state === 'fallen', 3);
        expect(s.e.dead, `byPlayer=${byPlayer}: crushed`).toBe(true);
        if (byPlayer) {
          expect(g.kills, 'kill credited').toBe(before.kills + 1);
          expect(g.combo, 'combo advanced').toBe(before.combo + 1);
          expect(g.score, 'score includes the combo multiplier').toBe(before.score + Math.round(g.ENEMY_TYPES[s.e.type].score * (1 + before.combo * 0.1)));
        } else {
          expect({ score: g.score, kills: g.kills, combo: g.combo }, 'no credit for a fall the player did not cause').toEqual(before);
        }
      } finally { s.restore(); }
    }
  });

  // -------------------------------------------------------------- E8
  test.skipIf(todo)('E8: under a huge multi-blast the active set stays <= 64 and debris <= CFG.MAX_DEBRIS', () => {
    expect(g.CFG.ENV_ACTIVE_MAX).toBeLessThanOrEqual(64);
    const rand = g.seededRand(5);
    const trees = [];
    for (let i = 0; i < 220; i++) {
      const a = rand() * Math.PI * 2, r = 60 + rand() * 200;
      trees.push(place(rand() < 0.7 ? 'tree' : 'pine', 1000 + Math.cos(a) * r, Math.sin(a) * r));
    }
    for (let i = 0; i < 60; i++) {
      const a = rand() * Math.PI * 2, r = 40 + rand() * 200;
      place(['crate', 'sandbag', 'boulder', 'ruins'][i % 4], 1000 + Math.cos(a) * r, Math.sin(a) * r);
    }
    const bfgR = g.WEAPONS.find((w) => w.name === 'BFG').radius;
    let maxActive = 0, maxDebris = 0;
    const check = () => {
      const s = g.envStats();
      maxActive = Math.max(maxActive, s.active);
      maxDebris = Math.max(maxDebris, s.debris, g.envDebris.length);
    };
    for (const [dx, dy] of [[0, 0], [120, 0], [-120, 0], [0, 120], [0, -120]]) {
      g.spawnExplosion(1000 + dx, dy, bfgR, true, g.SRC_BFG);
      check();
      stepEnv(0.05, check);
    }
    stepEnv(12, check);
    const s = g.envStats();
    expect(maxActive, 'active physics set').toBeLessThanOrEqual(64);
    expect(maxActive, 'the cap was actually reached').toBeGreaterThanOrEqual(g.CFG.ENV_ACTIVE_MAX);
    expect(maxDebris, 'debris pieces').toBeLessThanOrEqual(g.CFG.MAX_DEBRIS);
    expect(maxDebris, 'the debris cap was actually reached').toBeGreaterThanOrEqual(g.CFG.MAX_DEBRIS * 0.9);
    expect(s.felled, 'more trees felled than fit in the active set (queued ones fall later)').toBeGreaterThan(64);
    expect(trees.filter((t) => g.envState(t.id).state === 'falling').length, 'nothing left mid-fall').toBe(0);
    expect(s.active, 'all asleep again').toBe(0);
    expect(s.debris, 'all debris baked').toBe(0);
  });

  // -------------------------------------------------------------- E10a
  test.skipIf(todo)('E10a: a non-piercing bullet stops at a trunk; the enemy behind is not hit', () => {
    for (const type of ['tree', 'pine', 'deadtree', 'crate', 'sandbag']) {
      fresh();
      const o = place(type, 120, 0);
      const e = dummy('Militia', 250, 0);
      const [b] = shoot('M16', 250, 0);
      expect(b.pierce).toBeFalsy();
      let lastX = 0;
      for (let i = 0; i < 120 && g.bullets.includes(b); i++) { g.updateBullets(DT); lastX = b.x; }
      expect(g.bullets.includes(b), `${type}: bullet consumed`).toBe(false);
      expect(e.hp, `${type}: enemy behind untouched`).toBe(e.maxHp);
      expect(lastX, `${type}: stopped at the trunk`).toBeLessThan(o.x + 1);
      expect(lastX, `${type}: stopped at the trunk`).toBeGreaterThan(o.x - 25);
    }
  });

  test.skipIf(todo)('E10a: pierce rounds (Railgun, Plasma, Disintegrator) pass through a trunk, chip it and still hit the enemy behind', () => {
    for (const name of ['Railgun', 'Plasma', 'Disintegrator']) {
      fresh();
      const t = place('tree', 120, 0);
      const e = dummy('Militia', 250, 0);
      const chips0 = barkChips();
      const shots = shoot(name, 250, 0);
      expect(shots.length, `${name} fired`).toBeGreaterThan(0);
      expect(shots.every((b) => b.pierce), `${name} is piercing`).toBe(true);
      for (let i = 0; i < 40; i++) g.updateBullets(DT);
      expect(e.hp, `${name}: enemy behind the trunk hit`).toBeLessThan(e.maxHp);
      expect(barkChips(), `${name}: chips from the pass`).toBeGreaterThan(chips0);
      expect(felled(t.id), `${name}: tree still up`).toBe(false);
    }
  });

  test.skipIf(todo)('E10a: an RPG explodes on a trunk and the blast feeds E2', () => {
    const t = place('tree', 150, 0);
    const far = dummy('Militia', 400, 0);
    const booms = [];
    const orig = g.spawnExplosion;
    g.spawnExplosion = (x, y, R, byPlayer, src) => { booms.push({ x, y, R, byPlayer, src }); return orig(x, y, R, byPlayer, src); };
    try {
      shoot('RPG', 400, 0);
      stepBullets(240);
    } finally { g.spawnExplosion = orig; }
    expect(booms.length, 'one explosion').toBe(1);
    expect(booms[0].x, 'detonated at the trunk').toBeGreaterThan(t.x - 20);
    expect(booms[0].x, 'detonated at the trunk').toBeLessThan(t.x + 1);
    expect(booms[0]).toMatchObject({ R: RPG_R, byPlayer: true });
    expect(far.hp, 'the enemy beyond the blast is not hit').toBe(far.maxHp);
    expect(felled(t.id), 'point-blank blast topples the tree').toBe(true);
  });

  test.skipIf(todo)('E10a: enemy bullets are blocked by a trunk between the shooter and the player; tank shells explode on it', () => {
    g.player.invincible = 0; g.player.dodging = false;
    // Control: no tree, the bullet hits.
    let hp0 = playerHealth();
    enemyBullet(250, 0, 0, 0);
    stepBullets();
    expect(playerHealth(), 'control: hit without cover').toBeLessThan(hp0);

    fresh();
    g.player.invincible = 0; g.player.dodging = false;
    place('tree', 120, 0);
    hp0 = playerHealth();
    const b = enemyBullet(250, 0, 0, 0);
    stepBullets();
    expect(g.bullets.includes(b), 'bullet consumed').toBe(false);
    expect(playerHealth(), 'the trunk took the bullet').toBe(hp0);

    const booms = [];
    const orig = g.spawnExplosion;
    g.spawnExplosion = (x, y, R, byPlayer, src) => { booms.push({ x, y, R, byPlayer }); return orig(x, y, R, byPlayer, src); };
    try {
      enemyBullet(250, 0, 0, 0, { speed: 350, explosive: true });
      stepBullets();
    } finally { g.spawnExplosion = orig; }
    expect(booms.length, 'tank shell exploded').toBe(1);
    expect(booms[0].x, 'on the trunk').toBeGreaterThan(119);
    expect(booms[0].x, 'on the trunk').toBeLessThan(145);
    expect(booms[0].byPlayer, 'an enemy shell is not the player\'s explosion').toBe(false);
  });
});

// ---------------------------------------------------------------------
// E7 / E10e on generated chunks with the real unload path (renderPixiTerrain)
// ---------------------------------------------------------------------
describe('M8 persistence (generated chunks)', () => {
  let w;
  let cs;
  /** Move player + camera and run the real terrain pass (chunk bake + cleanup). */
  function goto(x, y) {
    w.player.x = x; w.player.y = y;
    const s = w.toScreen(x, y);
    w.cam.x = s.x; w.cam.y = s.y;
    w.renderPixiTerrain();
  }
  const HOME = () => [cs * 3.5, cs * 3.5];
  function unloadAndReturn() {
    for (let k = 1; k <= 30; k++) goto(HOME()[0] + k * cs, HOME()[1]);
    expect(w.envChunks.has('3,3'), 'chunk 3,3 unloaded').toBe(false);
    goto(...HOME());
    expect(w.envChunks.has('3,3'), 'chunk 3,3 regenerated').toBe(true);
  }
  const objById = (id) => w.envObjects.find((o) => o.id === id);
  function settle(seconds) { for (let i = 0; i < Math.round(seconds / DT); i++) w.updateEnv(DT); }

  /** A tree in chunk 3,3 with nothing else solid within 120 units, felled toward +x and baked. */
  function fellTreeInHome() {
    const inHome = (o) => Math.floor(o.x / cs) === 3 && Math.floor(o.y / cs) === 3;
    const t = w.envObjects.find((o) => o.type === 'tree' && inHome(o) &&
      w.envObjects.every((q) => q === o || !q.collision || Math.hypot(q.x - o.x, q.y - o.y) > 120));
    expect(t, 'an isolated tree in chunk 3,3').toBeTruthy();
    w.spawnExplosion(t.x - 0.2 * RPG_R, t.y, RPG_R, true, w.SRC_EXPLOSIVE);
    settle(3);
    const log = w.envLogs.find((r) => r.id === t.id);
    expect(log && log.baked, 'felled and baked').toBe(true);
    return { t, log };
  }

  /** Entity dropped on the middle of the log axis is pushed fully out of the capsule. */
  function logBlocks(log) {
    const ent = { x: (log.ax + log.bx) / 2 + 0.5, y: (log.ay + log.by) / 2 + 0.5 };
    w.resolveEnvCollision(ent, 10);
    return Math.sqrt(w.envSegDist2(ent.x, ent.y, log)) >= log.logR + 10 - 1e-6;
  }

  beforeEach(() => {
    w = generateWorld({ n: 0 }).g;
    cs = w.CFG.CHUNK_SIZE * w.CFG.TILE_SIZE;
    goto(...HOME());
  });

  test.skipIf(todo)('E7: destruction state survives a chunk unload + regenerate (stable id); resetEnvState restores an intact world', () => {
    const { t, log } = fellTreeInHome();
    const crate = w.envObjects.find((o) => (o.type === 'crate' || o.type === 'sandbag') &&
      Math.abs(Math.floor(o.x / cs) - 3) <= 1 && Math.abs(Math.floor(o.y / cs) - 3) <= 1);
    expect(crate, 'a crate or sandbag near chunk 3,3').toBeTruthy();
    w.spawnExplosion(crate.x + 10, crate.y, RPG_R, true, w.SRC_EXPLOSIVE);
    settle(6);
    expect(w.envState(crate.id).state).toBe('destroyed');
    const scorch = w.envState(t.id).scorch;

    unloadAndReturn();
    const t2 = objById(t.id), c2 = objById(crate.id);
    expect(t2, 'tree regenerated with the same id').toBeTruthy();
    expect(t2, 'it is a new object').not.toBe(t);
    expect([t2.x, t2.y, t2.type]).toEqual([t.x, t.y, t.type]);
    w.updateEnv(DT); // attaches persisted state to the regenerated objects
    expect(w.envState(t.id)).toMatchObject({ state: 'fallen', scorch });
    expect(t2.collision, 'regenerated tree is a stump').toBe(w.CFG.ENV_STUMP_R);
    expect(w.envLogs.includes(log) && logBlocks(log), 'log still blocks').toBe(true);
    expect(w.envState(crate.id).state).toBe('destroyed');
    expect(c2.collision || 0, 'regenerated crate has no collision').toBe(0);

    // What resetRound() calls for a new round (the e2e test drives resetRound itself).
    w.resetEnvState();
    expect(w.envState(t.id).state).toBe('standing');
    expect(w.envState(crate.id).state).toBe('standing');
    expect(t2.collision, 'trunk collision restored').toBe(8);
    expect(w.envLogs.length + w.envRemains.length, 'no logs or remains').toBe(0);
    expect(w.envStats()).toMatchObject({ active: 0, debris: 0, felled: 0 });
    unloadAndReturn();
    w.updateEnv(DT);
    expect(objById(t.id).collision, 'still intact after regenerating').toBe(8);
    expect(objById(crate.id).collision, 'crate solid again').toBeGreaterThan(0);
  });

  test.skipIf(todo)('E10e: a felled tree\'s stump and log stay in the remains store and collidable after gore floods the decals and after chunk regeneration', () => {
    const { t, log } = fellTreeInHome();
    const remains = () => w.envRemains.filter((r) => r.id === t.id && r.remain === 'log');
    expect(remains().length, 'one log remain').toBe(1);
    const DECAL_STUMP = 11, DECAL_LOG = 12;
    expect(w.bloodPools.some((d) => d.kind === DECAL_STUMP || d.kind === DECAL_LOG), 'remains are not gore decals').toBe(false);
    const v0 = w.envRemainsVersion;

    // (1) Gore far past the decal cap.
    const N = w.CFG.MAX_BLOOD_POOLS * 3;
    for (let i = 0; i < N; i++) w.addDecal(w.DECAL_POOL, log.x + (i % 50) - 25, log.y + ((i * 7) % 50) - 25, 3, 0x8a0a0a, 0);
    expect(w.bloodPools.length, 'decal pool at its cap').toBeLessThanOrEqual(w.CFG.MAX_BLOOD_POOLS);
    expect(remains().length, 'log remain survives the flood').toBe(1);
    expect(w.envRemainsVersion, 'remains store untouched by gore').toBe(v0);
    expect(w.envLogs.includes(log) && logBlocks(log), 'log still collidable').toBe(true);
    const stumpEnt = { x: t.x + 1, y: t.y + 0.5 };
    w.resolveEnvCollision(stumpEnt, 10);
    expect(Math.hypot(stumpEnt.x - t.x, stumpEnt.y - t.y), 'stump still collidable').toBeGreaterThanOrEqual(w.CFG.ENV_STUMP_R + 10 - 1e-6);

    // (2) Unload and regenerate the chunk.
    unloadAndReturn();
    w.updateEnv(DT);
    expect(remains().length, 'log remain survives regeneration').toBe(1);
    expect(remains()[0].baked).toBe(true);
    expect(w.envLogs.includes(log) && logBlocks(log), 'log still collidable after regeneration').toBe(true);
    const t2 = objById(t.id);
    expect(t2.collision, 'regenerated stump').toBe(w.CFG.ENV_STUMP_R);
    const ent = { x: t2.x + 1, y: t2.y + 0.5 };
    w.resolveEnvCollision(ent, 10);
    expect(Math.hypot(ent.x - t2.x, ent.y - t2.y), 'regenerated stump collidable').toBeGreaterThanOrEqual(w.CFG.ENV_STUMP_R + 10 - 1e-6);
  });
});

// ---------------------------------------------------------------------
// M8R: fixes from the manager's M8 review. Gated on LANDED.M8R; set
// M8R_MEASURE=1 to run them before the flag flips (as D3A_MEASURE does).
// ---------------------------------------------------------------------
const todoR = !(LANDED.M8R || process.env.M8R_MEASURE);

describe('M8R review fixes (headless)', () => {
  beforeEach(fresh);

  test.skipIf(todoR)('M8R: melee enemies do not stall on a felled log; they go around an end and reach the player', () => {
    // Log along +x from a tree at (300, 0), height 115 -> logLen = 115 * CFG.ENV_LOG_LEN.
    const t = place('tree', 300, 0, { height: 115 });
    blastAt(t, 0.8, { from: Math.PI });
    stepEnv(3);
    const log = logOf(t);
    expect(log, 'log capsule').toBeTruthy();
    const mx = (log.ax + log.bx) / 2, my = (log.ay + log.by) / 2;
    const p = g.player;
    p.invincible = 1e9;
    // Player just behind the MIDDLE of the log; enemies 70 units out on the other side.
    p.x = mx; p.y = my + log.logR + 10 + 4;
    const half = Math.hypot(log.bx - log.ax, log.by - log.ay) / 2;
    for (const name of ['Militia', 'Runner', 'Heavy']) {
      g.enemies.length = 0;
      const type = typeIdx(g, name), et = g.ENEMY_TYPES[type];
      const e = g.spawnEnemy(type, mx, my - 70);
      e.hp = e.maxHp = 1e7;
      // N: going around an end is at most ~ half the log + both side distances + a
      // clearance margin each way; allow 2.5x that path at the type's walking speed, + 1 s.
      const path = half + 70 + (p.y - my) + 4 * (log.logR + 8 * e.size);
      const N = 2.5 * path / et.speed + 1;
      // "Reached" = within the enemy's own melee range (updateEnemies attacks at d <= e.range).
      // Stalled on the far side of the log it stays >= logR + 8*size + logR + 14 away (> range).
      const reach = e.range;
      let reachedAt = Infinity;
      for (let i = 0; i < Math.round(N / DT) && reachedAt === Infinity; i++) {
        g.updateEnemies(DT);
        if (Math.hypot(e.x - p.x, e.y - p.y) <= reach) reachedAt = (i + 1) * DT;
      }
      expect(reachedAt, `${name} (speed ${et.speed}) reaches the player within N = ${N.toFixed(1)} s; ended at (${e.x.toFixed(0)}, ${e.y.toFixed(0)}), player (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`).toBeLessThanOrEqual(N);
    }
  });

  test.skipIf(todoR)('M8R: under sustained small-arms fire a BFG\'s queued topples all start within ~0.5 s; no stump-only tree stands upright', () => {
    const rand = g.seededRand(9);
    const trees = [];
    for (let i = 0; i < 200; i++) {
      const a = rand() * Math.PI * 2, r = 20 + rand() * 240;
      trees.push(place(rand() < 0.7 ? 'tree' : 'pine', 520 + Math.cos(a) * r, Math.sin(a) * r));
    }
    const stumpR = g.CFG.ENV_STUMP_R;
    const upright = new Map(); // id -> seconds upright with only the stump collision
    let standingStump = [];
    const fire = () => {
      const t = trees[(rand() * trees.length) | 0];
      shoot('Minigun', t.x, t.y);
      g.updateBullets(DT);
      g.updateEnv(DT);
      for (const o of trees) {
        const s = g.envState(o.id);
        if (o.collision !== stumpR) continue;
        if (s.state === 'standing' || s.state === 'scorched') standingStump.push(o.id);
        if (s.state === 'standing' || s.state === 'scorched' || (s.state === 'falling' && s.fall === 0)) {
          upright.set(o.id, (upright.get(o.id) || 0) + DT);
        }
      }
    };
    for (let i = 0; i < 240; i++) fire(); // 4 s of fire first: bullet sways compete for the active set
    const bfgR = g.WEAPONS.find((w) => w.name === 'BFG').radius;
    g.spawnExplosion(520, 0, bfgR, true, g.SRC_BFG);
    const queued0 = g.envStats().queued;
    let drainedAt = queued0 === 0 ? 0 : Infinity;
    for (let i = 0; i < 360; i++) {
      fire();
      if (drainedAt === Infinity && g.envStats().queued === 0) drainedAt = (i + 1) * DT;
    }
    const nFelled = trees.filter((o) => felled(o.id)).length;
    const worst = Math.max(0, ...upright.values());
    expect(nFelled, 'the BFG felled many trees').toBeGreaterThan(10);
    expect.soft(drainedAt, `queue (${queued0} topples queued at the blast) empty within 0.5 s`).toBeLessThanOrEqual(0.5);
    expect.soft([...new Set(standingStump)], 'state standing/scorched while collision is the stump circle').toEqual([]);
    expect.soft(worst, 'longest time a tree stood upright with only its stump collision (s)').toBeLessThanOrEqual(0.5);
  });

  test.skipIf(todoR)('M8R: a tree the player did not fell crushes a bomber; its chain kills give the player no score or combo', () => {
    const t = place('tree', 300, 0);
    const bomber = g.spawnEnemy(typeIdx(g, 'Bomber'), 345, 3);
    expect(g.ENEMY_TYPES[bomber.type].explodeOnDeath).toBe(true);
    const chain = [[345, 50], [395, 40], [330, -60]].map(([x, y]) => {
      const e = g.spawnEnemy(typeIdx(g, 'Militia'), x, y);
      e.hp = e.maxHp = 5;
      return e;
    });
    g.player.x = 0; g.player.y = 600;
    g.combo = 3;
    const before = { score: g.score, kills: g.kills, combo: g.combo, special: g.player.specialCharge };
    blastAt(t, 0.8, { byPlayer: false });
    stepUntil(() => g.envState(t.id).state === 'fallen', 3);
    for (let i = 0; i < 5; i++) g.processPendingDamage();
    expect(bomber.dead, 'bomber crushed').toBe(true);
    expect(chain.every((e) => e.dead), 'its explosion killed the enemies around it').toBe(true);
    expect({ score: g.score, kills: g.kills, combo: g.combo, special: g.player.specialCharge },
      'no score / kills / combo / special charge for a chain the player did not start').toEqual(before);
  });
});

// ---------------------------------------------------------------------
// E11a: logs are hurdles (spec E11). Gated on LANDED.E11.
// ---------------------------------------------------------------------
describe('E11a logs are hurdles', () => {
  const todoE = !(LANDED.M8 && LANDED.E11);
  beforeEach(() => { fresh(); g.player.invincible = 1e9; });

  test.skipIf(todoE)('E11a: the player climbs over a log at x0.35 speed instead of being stopped', () => {
    const p = g.player;
    g.keys.s = true;
    for (let i = 0; i < 10; i++) g.updatePlayer(DT);
    g.keys.s = false;
    const ul = Math.hypot(p.x, p.y), ux = p.x / ul, uy = p.y / ul, nx = -uy, ny = ux;
    p.x = 0; p.y = 0;
    const t = place('tree', ux * 100 - nx * 40, uy * 100 - ny * 40);
    blastAt(t, 0.8, { from: Math.atan2(-ny, -nx) }); // topples; splintering only hits existing logs
    stepEnv(3);
    const log = logOf(t);
    expect(log, 'log capsule exists').toBeTruthy();
    const pr = 10; // player body radius used by resolveEnvCollision
    const inside = () => g.envSegDist2(p.x, p.y, log) < (log.logR + pr) ** 2;
    const speeds = [];
    g.keys.s = true;
    for (let i = 0; i < 300; i++) {
      const x0 = p.x, y0 = p.y;
      const wasInside = inside();
      g.updatePlayer(DT);
      if (wasInside && inside()) speeds.push(Math.hypot(p.x - x0, p.y - y0) / DT);
    }
    g.keys.s = false;
    const along = p.x * ux + p.y * uy;
    expect(along, 'player ended up beyond the log').toBeGreaterThan(100 + log.logR + pr);
    expect(speeds.length, 'frames spent climbing').toBeGreaterThan(3);
    const med = speeds.slice().sort((a, b) => a - b)[speeds.length >> 1];
    const mx = (log.x + log.bx) / 2, my = (log.y + log.by) / 2, ts = g.CFG.TILE_SIZE;
    const terrainMult = g.getTerrainTypeAt(Math.floor(mx / ts) * ts, Math.floor(my / ts) * ts) === 'water' ? 0.55 : 1;
    expect(med / (g.CFG.PLAYER_SPEED * terrainMult), 'climb speed / normal speed').toBeGreaterThan(0.35 * 0.8);
    expect(med / (g.CFG.PLAYER_SPEED * terrainMult), 'climb speed / normal speed').toBeLessThan(0.35 * 1.2);
  });

  test.skipIf(todoE)('E11a: a ring of logs felled tangentially around the player never encloses them (all 8 directions, no dodge)', () => {
    const p = g.player;
    // 8 trees on a 55-unit ring, 96-unit logs (height 120 x ENV_LOG_LEN 0.8): with
    // wall-logs this is a closed pen (the explorer's 6-log hexagon, tightened).
    const N = 8;
    const trees = [];
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2;
      trees.push(place('tree', Math.cos(a) * 55, Math.sin(a) * 55, { height: 120 }));
    }
    // Each tree falls along the tangent (a + 90 deg); the blast comes from the opposite side.
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2;
      blastAt(trees[k], 0.8, { from: a - Math.PI / 2, R: 40 }); // R=40: neighbours 60 away are untouched
    }
    stepEnv(3);
    expect(g.envLogs.length, 'logs around the player').toBeGreaterThanOrEqual(N - 1);
    for (const keyset of [['w'], ['s'], ['a'], ['d'], ['w', 'a'], ['w', 'd'], ['s', 'a'], ['s', 'd']]) {
      p.x = 0; p.y = 0; p.dodging = false;
      for (const k of keyset) g.keys[k] = true;
      let out = false;
      for (let i = 0; i < 6 / DT; i++) {
        g.updatePlayer(DT);
        expect(p.dodging, 'no dodge used').toBeFalsy();
        if (Math.hypot(p.x, p.y) > 110) { out = true; break; }
      }
      for (const k of keyset) g.keys[k] = false;
      expect(out, `walked out holding ${keyset.join('+')}`).toBe(true);
    }
  });

  test.skipIf(todoE)('E11a: an explosion with f > 0.5 splinters a log; a weaker one leaves it', () => {
    const t = place('tree', 100, 0);
    blastAt(t, 0.8, { from: Math.PI });
    stepEnv(3);
    const log = logOf(t);
    expect(log, 'log').toBeTruthy();
    const mid = { x: (log.x + log.bx) / 2, y: (log.y + log.by) / 2 };
    // Weak blast (f = 0.3 at the log's middle): log stays.
    g.spawnExplosion(mid.x + 0.7 * RPG_R, mid.y, RPG_R, true, g.SRC_EXPLOSIVE);
    stepEnv(1);
    expect(logOf(t), 'f = 0.3 keeps the log').toBeTruthy();
    const v0 = g.envRemainsVersion;
    // Strong blast (f = 0.7): splinters it.
    g.spawnExplosion(mid.x + 0.3 * RPG_R, mid.y, RPG_R, true, g.SRC_EXPLOSIVE);
    stepEnv(2);
    expect(logOf(t), 'f = 0.7 splinters the log (capsule removed)').toBeFalsy();
    expect(g.envRemainsVersion, 'remains updated').toBeGreaterThan(v0);
  });
});

