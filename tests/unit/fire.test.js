import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect, beforeEach } from 'vitest';
import { loadGame, newRound, ROOT } from '../helpers/load-game.js';
import { LANDED } from '../milestones.js';

// M9 flamethrower, burning enemies and burning trees (docs/SPEC.md F1-F4). Each item is
// gated on its own flag in tests/milestones.js; the game code doesn't exist yet, so these
// are written against Josh's provisional hooks below.
const DT = 1 / 60;

// ---------------------------------------------------------------------
// Provisional hooks (Josh, M9). If a name changes when the item lands, change it here only.
// ---------------------------------------------------------------------
const FLAME = 'Flamethrower';
const hook = {
  flames: () => g.flames,                            // pooled flame particles { owner, x, y, z, vx, vy, t, life }
  groundFires: () => g.groundFires,                  // { x, y, t, life }; leaves a DECAL_SCORCH when it ends
  burnT: (e) => e.burnT || 0,                        // burn seconds left (> 0 = burning)
  panicT: (e) => e.panicT || 0,                      // seconds to the next panic direction change
  burnStats: () => g.burnStats(),                    // { burning, max: 30, ignitions, extinguished }
  heat: (o) => g.envState(o.id).heat || 0,           // F3: 0..1, ignites at 1
  fire: (o) => g.envState(o.id).fire || 0,           // F3: seconds left burning (0 = none)
  charred: (o) => g.envState(o.id).charred === true, // F3: burnt out
  trunkMax: (o) => g.envState(o.id).trunkMax,        // E13 trunk HP (a charred tree has 300)
  trunkHp: (o) => g.envState(o.id).trunkHp,
  burningTrees: () => g.envStats().burningTrees,     // F3: capped at 24
  bodyCharred: (b) => b.charred === true,            // F2: burn death leaves a charred corpse
};
const isPlayerFlame = (f) => f.owner === 'player' || f.owner === g.player;

// ---------------------------------------------------------------------
// Headless frame loop. main.js isn't loaded (its async init needs a GPU), so its per-frame
// update() is evaluated in the game context: whatever update calls Josh adds for M9
// (flames, burning, fire spread) runs here too. Camera and notifications are no-ops.
// ---------------------------------------------------------------------
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
function withMain(game) {
  const { g: gg, run } = game;
  for (const k of ['app', 'renderer', 'stage', 'worldContainer', 'terrainContainer', 'effectsContainer', 'uiContainer']) {
    if (!gg[k]) gg[k] = gg.PIXI;
  }
  run(`var updateCamera = typeof updateCamera === 'function' ? updateCamera : function () {};
var updateNotification = typeof updateNotification === 'function' ? updateNotification : function () {};
var __m9Update = (function () { return ${mainFunction('update')}; })();`);
  return run('__m9Update');
}

let g, update, home, pins, firing, seq = 0;

/** Rendered terrain at a world point (tiles are drawn from their corner sample). */
const renderedType = (x, y) => {
  const ts = g.CFG.TILE_SIZE;
  return g.getTerrainTypeAt(Math.floor(x / ts) * ts, Math.floor(y / ts) * ts);
};
// The terrain is the same in every round (seeded loader), so search once per file.
let _dry = null, _pond = null;
/** Centre of a disc of dry land, radius 600: room for every scenario below. */
function findHome() {
  if (_dry) return _dry;
  const R = 600;
  for (let r = 0; r < 30000 && !_dry; r += 80) {
    for (let a = 0; a < 16 && !_dry; a++) {
      const x = Math.cos((a / 16) * Math.PI * 2) * r, y = Math.sin((a / 16) * Math.PI * 2) * r;
      let ok = true;
      for (let dx = -R; dx <= R && ok; dx += 40) {
        for (let dy = -R; dy <= R && ok; dy += 40) if (dx * dx + dy * dy <= R * R && renderedType(x + dx, y + dy) === 'water') ok = false;
      }
      if (ok) _dry = { x, y };
    }
  }
  if (!_dry) throw new Error('no dry area found');
  return _dry;
}
/** Centre of a water tile whose 3x3 neighbourhood is all water. */
function findPond() {
  if (_pond) return _pond;
  const ts = g.CFG.TILE_SIZE;
  const wet = (i, j) => g.getTerrainTypeAt(i * ts, j * ts) === 'water';
  for (let R = 0; R < 200 && !_pond; R++) {
    for (let i = -R; i <= R && !_pond; i++) {
      for (let j = -R; j <= R && !_pond; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== R) continue;
        let ok = true;
        for (let a = -1; a <= 1 && ok; a++) for (let b = -1; b <= 1 && ok; b++) ok = wet(i + a, j + b);
        if (ok) _pond = { x: (i + 0.5) * ts, y: (j + 0.5) * ts };
      }
    }
  }
  if (!_pond) throw new Error('no pond found');
  return _pond;
}

function fresh() {
  const game = newRound();
  g = game.g;
  update = withMain(game);
  g.unlockedWeapons = g.WEAPONS.length;
  g.waveActive = false;
  g.waveTimer = 1e9;
  g.envObjects.length = 0;
  home = findHome();
  g.player.x = home.x; g.player.y = home.y;
  g.player.invincible = 1e9;
  pins = [() => { g.player.x = home.x; g.player.y = home.y; g.player.vx = 0; g.player.vy = 0; }];
  firing = false;
}

const flameIdx = () => g.WEAPONS.findIndex((w) => w.name === FLAME);
const typeIdx = (name) => g.ENEMY_TYPES.findIndex((t) => t.name === name);

/** Point the mouse at a world position (no frame drawn: offset = W/2 - cam; the camera stays put headless). */
function aimAt(wx, wy) {
  const s = g.toScreen(wx, wy);
  g.mouseX = s.x + g.W / 2 - g.cam.x;
  g.mouseY = s.y + g.H / 2 - g.cam.y;
}
function fireAt(wx, wy) {
  const p = g.player;
  p.weapon = flameIdx();
  p.reloading = false; p.fireTimer = 0;
  aimAt(wx, wy);
  g.mouseDown = true; g.mouseJustPressed = true;
  firing = true;
}
function ceaseFire() {
  g.mouseDown = false; g.mouseJustPressed = false;
  firing = false;
}
/** One game frame (main.js update order), then re-apply the pins. Fuel is kept topped up while firing. */
function frame() {
  if (firing) { g.player.magAmmo = g.WEAPONS[g.player.weapon].mag; g.player.reloading = false; }
  update(DT);
  for (const f of pins) f();
}
function step(seconds, each) {
  for (let i = 0; i < Math.round(seconds / DT); i++) { frame(); if (each && each(i) === true) return (i + 1) * DT; }
  return Infinity;
}
/** Step until pred() (checked after each frame); returns the game seconds it took, or Infinity. */
const stepUntil = (pred, max) => step(max, () => pred());

/** A stationary enemy that survives anything and doesn't attack. */
function dummy(name, x, y, { speed = 0 } = {}) {
  const e = g.spawnEnemy(typeIdx(name), x, y);
  e.hp = e.maxHp = 1e7;
  e.shieldHp = e.maxShieldHp = 0;
  e.fireTimer = 1e9;
  if (speed !== null) e.speed = speed;
  return e;
}
function pin(e, at) {
  const f = () => { e.x = at.x; e.y = at.y; e.vx = 0; e.vy = 0; e.knockbackX = 0; e.knockbackY = 0; };
  pins.push(f);
  f();
  return f;
}
const unpin = (f) => { const i = pins.indexOf(f); if (i >= 0) pins.splice(i, 1); };

/**
 * Ignite `e` with the real flame stream: hold it 70u from the player along `dir`, fire at it
 * until `until()` holds (default: it burns), stop firing and move it to `to` in that same frame,
 * so no flame still in flight touches it again. Returns the frame count it took.
 */
function ignite(e, { to = null, dir = { x: 1, y: 0 }, until = () => hook.burnT(e) > 0 } = {}) {
  const at = { x: g.player.x + dir.x * 70, y: g.player.y + dir.y * 70 };
  const speed = e.speed;
  e.speed = 0;
  const pf = pin(e, at);
  fireAt(at.x, at.y);
  let n = 0, ok = false;
  for (; n < 90 && !ok; n++) { frame(); ok = until(); }
  ceaseFire();
  unpin(pf);
  e.speed = speed;
  if (to) { e.x = to.x; e.y = to.y; e.vx = 0; e.vy = 0; }
  expect(ok, 'ignited by the flame stream within 1.5 s').toBe(true);
  return n;
}

const TREE = { radius: 40, height: 100, collision: 8 };
function place(type, x, y) {
  const o = { x, y, type, ...(type === 'tree' ? TREE : type === 'pine' ? { radius: 30, height: 90, collision: 7 } : { height: 45 }), createdAt: -1, id: `m9fire#${++seq}` };
  g.envObjects.push(o);
  return o;
}
function removeObj(o) { const i = g.envObjects.indexOf(o); if (i >= 0) g.envObjects.splice(i, 1); }
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const ang = (a, b) => { const d = a - b; return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))); };

// =====================================================================
// F1 Flamethrower replaces Tesla
// =====================================================================
describe('F1 flamethrower', () => {
  beforeEach(fresh);
  const within20 = (v, want) => v >= want * 0.8 - 1e-9 && v <= want * 1.2 + 1e-9;

  test.skipIf(!LANDED.F1)('F1: slot 7 (key 8) is the Flamethrower at unlock 25000; Tesla and chain lightning are gone; stats within +-20%', () => {
    const W = g.WEAPONS;
    expect(W[7].name).toBe(FLAME);
    expect(W[7].unlock).toBe(25000);
    expect(W.some((w) => w.name === 'Tesla'), 'no Tesla').toBe(false);
    for (const w of W) {
      expect(w.chain, `${w.name}.chain`).toBeUndefined();
      expect(w.chainRange, `${w.name}.chainRange`).toBeUndefined();
    }
    const f = W[7];
    const want = { rate: 0.05, dmg: 10, mag: 100, reload: 2.0, spread: 0.12 };
    for (const [k, v] of Object.entries(want)) expect(within20(f[k], v), `${k} = ${f[k]} (spec ${v} +-20%)`).toBe(true);
    expect(f.auto, 'held fire').toBe(true);
    expect(f.pierce, 'no pierce').toBeFalsy();
  });

  test.skipIf(!LANDED.F1)('F1: flames are pooled particles (not bullets) that reach ~260u (+-20%) and then expire', () => {
    const p = g.player;
    fireAt(home.x + 400, home.y);
    let maxD = 0, seen = 0;
    step(1.5, () => {
      expect(g.bullets.filter((b) => b.owner === 'player').length, 'flames are not bullets').toBe(0);
      for (const f of hook.flames()) {
        if (!isPlayerFlame(f)) continue;
        seen++;
        maxD = Math.max(maxD, Math.hypot(f.x - p.x, f.y - p.y));
      }
    });
    ceaseFire();
    expect(seen, 'flames were spawned').toBeGreaterThan(0);
    expect(maxD, `furthest flame ${maxD.toFixed(0)}u from the player`).toBeGreaterThanOrEqual(260 * 0.8);
    expect(maxD).toBeLessThanOrEqual(260 * 1.2);
    const t = stepUntil(() => !hook.flames().some(isPlayerFlame), 3);
    expect(t, 'all flames expire within 3 s of releasing the trigger').toBeLessThan(Infinity);
  });

  test.skipIf(!LANDED.F1)('F1: no pierce: a trunk between the player and an enemy stops the stream (control: without it the enemy is hit)', () => {
    // Control first, in its own round: same geometry, no tree.
    let e = dummy('Militia', home.x + 150, home.y);
    const pf = pin(e, { x: home.x + 150, y: home.y });
    fireAt(e.x, e.y);
    step(0.5);
    ceaseFire();
    step(1.5);
    expect(e.hp, 'control: the stream reaches an enemy 150u away').toBeLessThan(1e7);
    unpin(pf);

    fresh();
    const t = place('tree', home.x + 50, home.y); // cone half-width at the trunk (< 5u) < trunk radius 8
    e = dummy('Militia', home.x + 150, home.y);
    pin(e, { x: home.x + 150, y: home.y });
    fireAt(e.x, e.y);
    step(0.5); // shorter than the F3 ignition time (0.8 s - 20%)
    ceaseFire();
    step(1.5);
    expect(e.hp, 'no flame damage behind the trunk').toBe(1e7);
    expect(hook.burnT(e), 'not ignited behind the trunk').toBe(0);
    if (LANDED.F3) expect(hook.heat(t), 'the trunk gained heat (F3)').toBeGreaterThan(0);
  });

  test.skipIf(!LANDED.F1)('F1: flames that land light ground fires, and each ground fire leaves a scorch decal (J2) when it ends', () => {
    const scorches = () => g.bloodPools.filter((d) => d.kind === g.DECAL_SCORCH);
    const s0 = scorches().length;
    const spots = [];
    fireAt(home.x + 200, home.y);
    step(0.6, () => { for (const f of hook.groundFires()) spots.push({ x: f.x, y: f.y }); });
    ceaseFire();
    expect(spots.length, 'ground fires appeared').toBeGreaterThan(0);
    const t = stepUntil(() => hook.groundFires().length === 0, 20);
    expect(t, 'ground fires are short-lived (all out within 20 s)').toBeLessThan(Infinity);
    const sc = scorches().slice(s0);
    expect(sc.length, 'scorch decals left behind').toBeGreaterThan(0);
    expect(spots.some((s) => sc.some((d) => dist(s, d) <= 30)), 'a scorch where a ground fire burned').toBe(true);
  });
});

// =====================================================================
// F2 Burning enemies panic
// =====================================================================
describe('F2 burning enemies', () => {
  beforeEach(fresh);
  const far = () => ({ x: home.x, y: home.y - 300 }); // dry, away from the stream and its ground fires

  /** Per-frame hp drops { t, d } while stepping `seconds`, the time the burn ended, the max panicT seen. */
  function trackHp(e, seconds) {
    const t0 = g.gameTime, drops = [];
    let tEnd = Infinity, maxPanic = 0;
    let h = e.hp;
    step(seconds, () => {
      if (e.hp < h - 1e-9) drops.push({ t: g.gameTime - t0, d: h - e.hp });
      h = e.hp;
      maxPanic = Math.max(maxPanic, hook.panicT(e));
      if (tEnd === Infinity && hook.burnT(e) <= 0) tEnd = g.gameTime - t0;
    });
    return { drops, tEnd, maxPanic, total: drops.reduce((a, x) => a + x.d, 0) };
  }

  test.skipIf(!LANDED.F2)('F2: a flame hit ignites: 4 s of DoT at 25/s in 0.25 s ticks of 6.25, 100 +- 6.25 in total', () => {
    const e = dummy('Militia', home.x + 70, home.y);
    const ign0 = hook.burnStats().ignitions;
    ignite(e, { to: far() });
    pin(e, far()); // hold it: panic must not carry it into water mid-burn
    expect(hook.burnStats().ignitions, 'ignitions counted').toBe(ign0 + 1);
    expect(hook.burnT(e), 'burn starts at 4 s').toBeGreaterThanOrEqual(4 - 2 * DT);
    expect(hook.burnT(e)).toBeLessThanOrEqual(4 + 1e-9);
    const r = trackHp(e, 6);
    expect(r.total, `DoT total ${r.total.toFixed(2)}`).toBeGreaterThanOrEqual(100 - 6.25 - 1e-6);
    expect(r.total).toBeLessThanOrEqual(100 + 6.25 + 1e-6);
    for (const x of r.drops) expect(x.d, `tick at ${x.t.toFixed(3)} s`).toBeCloseTo(6.25, 6);
    for (let i = 1; i < r.drops.length; i++) {
      expect(Math.abs(r.drops[i].t - r.drops[i - 1].t - 0.25), 'ticks 0.25 s apart').toBeLessThanOrEqual(1.5 * DT);
    }
    expect(Math.abs(r.tEnd - 4), `burn ended after ${r.tEnd.toFixed(3)} s`).toBeLessThanOrEqual(3 * DT);
  });

  test.skipIf(!LANDED.F2)('F2: a further flame hit refreshes the burn to 4 s', () => {
    const e = dummy('Militia', home.x + 70, home.y);
    ignite(e, { to: far() });
    pin(e, far());
    step(2);
    const left = hook.burnT(e);
    expect(left, 'still burning after 2 s').toBeGreaterThan(1.5);
    expect(left).toBeLessThan(2.5);
    ignite(e, { to: far(), until: () => hook.burnT(e) > left + 1 });
    expect(hook.burnT(e), 'refreshed to 4 s').toBeGreaterThanOrEqual(4 - 2 * DT);
    const r = trackHp(e, 6);
    expect(Math.abs(r.tEnd - 4), `burn ended ${r.tEnd.toFixed(3)} s after the refresh`).toBeLessThanOrEqual(3 * DT);
  });

  test.skipIf(!LANDED.F2)('F2: bosses take the full DoT but never panic', () => {
    const boss = g.spawnEnemy(1, home.x + 70, home.y, { name: 'F2 BOSS', hp: 1e7 });
    boss.shieldHp = boss.maxShieldHp = 0;
    expect(boss.isBoss).toBe(true);
    ignite(boss, { to: far() });
    pin(boss, far());
    let maxPanic = hook.panicT(boss);
    const r = trackHp(boss, 6);
    maxPanic = Math.max(maxPanic, r.maxPanic);
    expect(r.total, `boss DoT ${r.total.toFixed(2)}`).toBeGreaterThanOrEqual(100 - 6.25 - 1e-6);
    expect(r.total).toBeLessThanOrEqual(100 + 6.25 + 1e-6);
    expect(maxPanic, 'a boss never panics').toBe(0);
  });

  test.skipIf(!LANDED.F2)('F2: panicking enemies stop attacking (melee and shots); they attack again once the burn is out', () => {
    const p = g.player;
    let melee = 0, shots = 0;
    const dmg0 = g.damagePlayer;
    g.damagePlayer = (...a) => { melee++; return dmg0(...a); };
    const push0 = g.bullets.push;
    g.bullets.push = function (...items) { for (const b of items) if (b.owner === 'enemy') shots++; return push0.apply(this, items); };

    const mil = dummy('Militia', home.x - 70, home.y);
    ignite(mil, { dir: { x: -1, y: 0 } });
    pin(mil, { x: p.x + 20, y: p.y });            // inside its melee range (28)
    const off = dummy('Officer', home.x, home.y + 70);
    ignite(off, { dir: { x: 0, y: 1 } });
    pin(off, { x: p.x, y: p.y + 150 });           // Officer stands and shoots at 0.4-0.6 x range 280
    mil.fireTimer = 0; off.fireTimer = 0;         // would attack at once if not panicking

    // Melee comes only from the Militia, shots only from the Officer. Count a frame's attacks
    // against an enemy that burned both before and after that frame.
    let meleeBurning = 0, shotsBurning = 0;
    for (let i = 0; i < 6 / DT && (hook.burnT(mil) > 0 || hook.burnT(off) > 0); i++) {
      const mb = hook.burnT(mil) > 0, ob = hook.burnT(off) > 0, m0 = melee, s0 = shots;
      frame();
      if (mb && hook.burnT(mil) > 0) meleeBurning += melee - m0;
      if (ob && hook.burnT(off) > 0) shotsBurning += shots - s0;
    }
    expect(hook.burnT(mil) <= 0 && hook.burnT(off) <= 0, 'both burns ended within 6 s').toBe(true);
    expect(meleeBurning, 'no melee attack while the Militia burns').toBe(0);
    expect(shotsBurning, 'no shot while the Officer burns').toBe(0);
    step(3);
    expect(melee, 'control: the Militia attacks once the burn is out').toBeGreaterThan(0);
    expect(shots, 'control: the Officer shoots once the burn is out').toBeGreaterThan(0);
  });

  test.skipIf(!LANDED.F2)('F2: panic changes direction every 0.3-0.7 s, erratically, with a net drift away from the player (8 enemies)', () => {
    const p = g.player;
    const intervals = [], newT = [], turns = [], drift = [];
    let resetsMin = Infinity;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2, dir = { x: Math.cos(a), y: Math.sin(a) };
      const e = dummy('Militia', p.x + dir.x * 70, p.y + dir.y * 70, { speed: null }); // keeps its own speed
      ignite(e, { dir });
      const d0 = dist(e, p);
      let prev = hook.panicT(e), last = null, nResets = 0;
      const marks = [{ x: e.x, y: e.y }];
      const t0 = g.gameTime;
      // panicT jumping up = a new direction was picked (the first one starts the panic)
      if (prev > 0) { last = 0; newT.push(prev); nResets++; }
      stepUntil(() => {
        const pt = hook.panicT(e), t = g.gameTime - t0;
        if (pt > prev + 1e-9) {
          if (last !== null) intervals.push(t - last);
          last = t; newT.push(pt); nResets++;
          marks.push({ x: e.x, y: e.y });
        }
        prev = pt;
        return hook.burnT(e) <= 0;
      }, 8);
      marks.push({ x: e.x, y: e.y });
      for (let i = 2; i < marks.length; i++) {
        const a1 = Math.atan2(marks[i - 1].y - marks[i - 2].y, marks[i - 1].x - marks[i - 2].x);
        const a2 = Math.atan2(marks[i].y - marks[i - 1].y, marks[i].x - marks[i - 1].x);
        turns.push(ang(a1, a2));
      }
      drift.push(dist(e, p) - d0);
      resetsMin = Math.min(resetsMin, nResets);
      g.enemies.length = 0;
      pins.length = 1; // keep the player pin
      step(0.5);
    }
    const msg = `intervals ${intervals.map((x) => x.toFixed(2)).join(' ')}; drift ${drift.map((x) => x.toFixed(0)).join(' ')}`;
    expect(resetsMin, `direction changes per 4 s burn (${msg})`).toBeGreaterThanOrEqual(4);
    for (const t of newT) { expect(t, 'next change in 0.3-0.7 s').toBeGreaterThanOrEqual(0.3 - 2 * DT); expect(t).toBeLessThanOrEqual(0.7 + 1e-9); }
    for (const t of intervals) { expect(t, msg).toBeGreaterThanOrEqual(0.3 - 2 * DT); expect(t, msg).toBeLessThanOrEqual(0.7 + 2 * DT); }
    expect(turns.filter((x) => x > 0.2).length / turns.length, 'erratic: most changes really turn (> 0.2 rad)').toBeGreaterThanOrEqual(0.5);
    const mean = drift.reduce((a, x) => a + x, 0) / drift.length;
    expect(mean, `mean drift away from the player (${msg})`).toBeGreaterThanOrEqual(30);
    expect(drift.filter((x) => x > 0).length, msg).toBeGreaterThanOrEqual(6);
  });

  test.skipIf(!LANDED.F2)('F2: touching a burning enemy for >= 0.3 s ignites with ~50% chance (200 pairs, +-3 sigma)', () => {
    // Batches of 8 pairs on an arc behind the player (the stream points +x, away from them).
    // A is ignited with the stream, then B is held 12u from it for 0.4 s: one contact roll.
    const PER = 8, BATCHES = 25;
    let trials = 0, lit = 0;
    for (let b = 0; b < BATCHES; b++) {
      const slots = [...Array(PER).keys()].map((k) => {
        const a = ((100 + (160 * k) / (PER - 1)) * Math.PI) / 180;
        const at = (r) => ({ x: home.x + Math.cos(a) * r, y: home.y + Math.sin(a) * r });
        return { A: at(200), B: at(212), away: at(330) };
      });
      const As = slots.map((s) => {
        const e = dummy('Militia', s.A.x, s.A.y);
        ignite(e, { to: s.A });
        pin(e, s.A);
        return e;
      });
      expect(As.every((e) => hook.burnT(e) > 0.6), 'every A still burning when the Bs arrive').toBe(true);
      const Bs = slots.map((s) => { const e = dummy('Militia', s.B.x, s.B.y); pin(e, s.B); return e; });
      step(0.4);
      for (let k = 0; k < PER; k++) {
        if (hook.burnT(As[k]) <= 0) continue; // A went out mid-contact: not a valid trial
        trials++;
        if (hook.burnT(Bs[k]) > 0) lit++;
      }
      // Pull the pairs apart (> 100u from everyone) so they can't keep re-igniting each other.
      pins.length = 1;
      slots.forEach((s, k) => { pin(As[k], s.A); pin(Bs[k], s.away); });
      stepUntil(() => g.enemies.every((e) => hook.burnT(e) <= 0), 6);
      expect(hook.burnStats().burning, 'nothing left burning between batches').toBe(0);
      g.enemies.length = 0;
      pins.length = 1;
    }
    expect(trials, 'valid contact trials').toBeGreaterThanOrEqual(190);
    const sd = Math.sqrt(trials * 0.25);
    expect(lit, `${lit}/${trials} ignited by contact`).toBeGreaterThanOrEqual(trials * 0.5 - 3 * sd);
    expect(lit).toBeLessThanOrEqual(trials * 0.5 + 3 * sd);
  }, 120_000);

  test.skipIf(!LANDED.F2)('F2: at most 30 enemies burn at once, even with 60 touching (burnStats().max = 30)', () => {
    expect(hook.burnStats().max).toBe(30);
    const slots = [];
    for (let k = 0; k < 60; k++) slots.push({ x: home.x - 260 + (k % 6) * 12, y: home.y - 60 + Math.floor(k / 6) * 12 });
    const es = slots.map((s) => { const e = dummy('Militia', s.x, s.y); pin(e, s); return e; });
    // ignite()'s own pin runs after the slot pin, so the enemy sits in the stream until lit.
    for (const k of [0, 27, 59]) ignite(es[k], { to: slots[k] });
    let maxN = 0;
    step(8, () => {
      const n = es.filter((e) => hook.burnT(e) > 0).length;
      maxN = Math.max(maxN, n);
      expect(n, 'burning enemies').toBeLessThanOrEqual(30);
      expect(hook.burnStats().burning, 'burnStats().burning').toBeLessThanOrEqual(30);
    });
    expect(maxN, 'the cap was reached (contact spread in a packed crowd)').toBe(30);
  }, 30_000);

  test.skipIf(!LANDED.F2)('F2: water extinguishes a burning enemy instantly (burnStats().extinguished counts it)', () => {
    const e = dummy('Militia', home.x + 70, home.y);
    ignite(e);
    const ext0 = hook.burnStats().extinguished;
    const pond = findPond();
    e.x = pond.x; e.y = pond.y;
    pin(e, pond);
    expect(renderedType(e.x, e.y)).toBe('water');
    const t = stepUntil(() => hook.burnT(e) <= 0, 0.5);
    expect(t, 'out within 2 frames of entering water').toBeLessThanOrEqual(2 * DT + 1e-9);
    expect(hook.burnStats().extinguished).toBe(ext0 + 1);
  });

  test.skipIf(!LANDED.F2)('F2: a burn death leaves a charred corpse', () => {
    const e = dummy('Militia', home.x + 70, home.y);
    ignite(e, { to: far() });
    pin(e, far());
    e.hp = 10; // two DoT ticks
    const n0 = g.bodies.length;
    const t = stepUntil(() => e.dead, 2);
    expect(t, 'the burn killed it').toBeLessThan(Infinity);
    expect(g.bodies.length, 'it left a corpse').toBe(n0 + 1);
    expect(hook.bodyCharred(g.bodies[g.bodies.length - 1]), 'charred').toBe(true);
  });

  test.skipIf(!LANDED.F2)('F2: the player is never ignited: burning enemies pressed against them while they use the flamethrower', () => {
    const p = g.player;
    p.invincible = 0;
    p.hp = p.maxHp; p.shield = p.maxShield;
    const hp0 = p.hp, sh0 = p.shield;
    const es = [];
    for (const d of [{ x: -1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }, { x: -Math.SQRT1_2, y: -Math.SQRT1_2 }]) {
      const e = dummy('Militia', p.x + d.x * 70, p.y + d.y * 70);
      ignite(e, { dir: d });
      pin(e, { x: p.x + d.x * 12, y: p.y + d.y * 12 });
      es.push(e);
    }
    fireAt(home.x + 200, home.y);
    step(2, () => {
      expect(hook.burnT(p), 'player burnT').toBe(0);
      expect(p.hp, 'no damage (burning enemies do not attack, the player does not burn)').toBe(hp0);
      expect(p.shield).toBe(sh0);
    });
    ceaseFire();
    expect(es.every((e) => hook.burnT(e) > 0), 'the enemies burned throughout').toBe(true);
  });
});

// =====================================================================
// F3 Burning trees
// =====================================================================
describe('F3 burning trees', () => {
  beforeEach(fresh);

  /** Stream at the trunk of `t` (player pinned where it stands) until it ignites; returns { tHeat, tIgn } in game s. */
  function igniteTree(t) {
    let tHeat = null, tIgn = null;
    fireAt(t.x, t.y);
    step(3, () => {
      const h = hook.heat(t);
      expect(h, 'heat in [0, 1]').toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(1 + 1e-9);
      if (tHeat === null && h > 0) tHeat = g.gameTime;
      if (hook.fire(t) > 0) { tIgn = g.gameTime; return true; }
      return false;
    });
    ceaseFire();
    expect(tIgn, 'the tree ignited under the stream').not.toBeNull();
    return { tHeat, tIgn };
  }

  test.skipIf(!LANDED.F3)('F3: a trunk under the stream ignites after ~0.8 s (+-20%), burns ~6 s (+-20%) and ends charred with trunkMax 300', () => {
    const t = place('tree', home.x + 80, home.y);
    const { tHeat, tIgn } = igniteTree(t);
    expect(tIgn - tHeat, `heat 0 -> 1 in ${(tIgn - tHeat).toFixed(3)} s of stream`).toBeGreaterThanOrEqual(0.64);
    expect(tIgn - tHeat).toBeLessThanOrEqual(0.96);
    expect(hook.burningTrees()).toBe(1);
    const burn = stepUntil(() => hook.fire(t) <= 0, 12);
    expect(burn, `burned for ${burn.toFixed(2)} s`).toBeGreaterThanOrEqual(4.8);
    expect(burn).toBeLessThanOrEqual(7.2);
    step(0.1);
    expect(hook.charred(t), 'charred').toBe(true);
    expect(hook.trunkMax(t), 'a charred bare tree has 300 trunk HP (E13)').toBe(300);
    expect(hook.trunkHp(t)).toBeLessThanOrEqual(300);
    expect(hook.burningTrees()).toBe(0);
  });

  test.skipIf(!LANDED.F3)('F3: fire spreads to trees within 90u at ~35%/s (300 neighbours, P(lit within 2 s) +-3 sigma) and never to a tree 110u away', () => {
    // Source S; 3 neighbours at 70u, 120 deg apart (> 90u from each other); a far tree at 110u
    // (> 90u from S and from every neighbour). The stream comes from 180 deg and passes >= 60u
    // from every other trunk (canopy radius 40). One trial at a time; the next starts once
    // nothing burns.
    const L = { x: home.x + 60, y: home.y };
    const NB = [0, 120, 240].map((d) => (d * Math.PI) / 180);
    const FAR = (60 * Math.PI) / 180;
    const WINDOW = 2.0 + 2 * DT;
    let n = 0, lit = 0, farLit = 0;
    pins[0] = () => { g.player.x = L.x - 80; g.player.y = L.y; g.player.vx = 0; g.player.vy = 0; };
    pins[0]();
    for (let k = 0; k < 100; k++) {
      const S = place('tree', L.x, L.y);
      const Ns = NB.map((a) => place('tree', L.x + Math.cos(a) * 70, L.y + Math.sin(a) * 70));
      const F = place('tree', L.x + Math.cos(FAR) * 110, L.y + Math.sin(FAR) * 110);
      igniteTree(S);
      const got = new Set();
      let far = false;
      step(WINDOW, () => {
        Ns.forEach((o, i) => { if (hook.fire(o) > 0) got.add(i); });
        if (hook.fire(F) > 0) far = true;
      });
      // F must stay unlit for the whole trial (S and any lit neighbour burn out).
      stepUntil(() => {
        if (hook.fire(F) > 0) far = true;
        return hook.burningTrees() === 0;
      }, 30);
      n += Ns.length; lit += got.size; if (far) farLit++;
      expect(hook.burningTrees(), 'trial over: nothing burning').toBe(0);
      for (const o of [S, ...Ns, F]) removeObj(o);
    }
    const p = 1 - 0.65 * 0.65; // P(lit within 2 s) at 35% per second
    const sd = Math.sqrt((p * (1 - p)) / n);
    expect(farLit, 'a tree 110u away never caught fire').toBe(0);
    expect(lit / n, `${lit}/${n} neighbours lit within 2 s (expect ${p.toFixed(3)})`).toBeGreaterThanOrEqual(p - 3 * sd);
    expect(lit / n).toBeLessThanOrEqual(p + 3 * sd);
  }, 180_000);

  test.skipIf(!LANDED.F3)('F3: at most 24 trees burn at once (dense 10x10 grove)', () => {
    const grove = [];
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) grove.push(place('tree', home.x - 180 + i * 40, home.y - 180 + j * 40));
    pins[0] = () => { g.player.x = home.x - 260; g.player.y = home.y - 180; };
    pins[0]();
    igniteTree(grove[0]);
    let maxN = 0;
    step(25, () => {
      const n = grove.filter((o) => hook.fire(o) > 0).length;
      maxN = Math.max(maxN, n);
      expect(n, 'burning trees').toBeLessThanOrEqual(24);
      expect(hook.burningTrees(), 'envStats().burningTrees').toBeLessThanOrEqual(24);
    });
    expect(maxN, 'the cap was reached').toBe(24);
  }, 60_000);

  test.skipIf(!LANDED.F3)('F3: a burning canopy ignites an enemy under it and damages it at ~10/s (on top of the 25/s burn)', () => {
    const t = place('tree', home.x + 80, home.y);
    igniteTree(t);
    const spot = { x: t.x, y: t.y + 25 }; // under the canopy (radius 40), beside the stream
    stepUntil(() => !hook.flames().some((f) => isPlayerFlame(f) && dist(f, spot) < 60), 2);
    const e = dummy('Militia', spot.x, spot.y);
    pin(e, spot);
    const WIN = 3.5;
    let tLit = Infinity, burnS = 0;
    const hp0 = e.hp, t0 = g.gameTime;
    step(WIN, () => {
      if (hook.burnT(e) > 0) { burnS += DT; if (tLit === Infinity) tLit = g.gameTime - t0; }
    });
    expect(tLit, 'the canopy fire ignited it').toBeLessThanOrEqual(1);
    expect(hook.fire(t), 'the tree burned through the window').toBeGreaterThan(0);
    const canopy = hp0 - e.hp - 25 * burnS; // the burn DoT itself is checked in F2
    expect(canopy / WIN, `canopy damage ${(canopy / WIN).toFixed(2)}/s`).toBeGreaterThanOrEqual(7);
    expect(canopy / WIN).toBeLessThanOrEqual(13);
  });
});

// F3 persistence on generated chunks with the real unload path (pattern: env.test.js E7).
describe('F3 persistence (generated chunks)', () => {
  let w, cs, upd;
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

  beforeEach(() => {
    const game = loadGame();
    w = game.g;
    for (const k of ['app', 'renderer', 'stage', 'worldContainer', 'terrainContainer', 'effectsContainer', 'uiContainer']) w[k] = w.PIXI;
    w.W = 1280; w.H = 720;
    w.player = w.createPlayer();
    w.unlockedWeapons = w.WEAPONS.length;
    w.waveActive = false; w.waveTimer = 1e9;
    w.player.invincible = 1e9;
    upd = withMain(game);
    cs = w.CFG.CHUNK_SIZE * w.CFG.TILE_SIZE;
    goto(...HOME());
  });

  test.skipIf(!LANDED.F3)('F3: a burnt (charred) tree stays charred after a chunk unload + regenerate (E7)', () => {
    const ts = w.CFG.TILE_SIZE;
    const wet = (x, y) => w.getTerrainTypeAt(Math.floor(x / ts) * ts, Math.floor(y / ts) * ts) === 'water';
    const inHome = (o) => Math.floor(o.x / cs) === 3 && Math.floor(o.y / cs) === 3;
    let t = null, from = null;
    for (const o of w.envObjects) {
      if (o.type !== 'tree' || !inHome(o)) continue;
      if (!w.envObjects.every((q) => q === o || !q.collision || Math.hypot(q.x - o.x, q.y - o.y) > 120)) continue;
      from = [[-70, 0], [70, 0], [0, -70], [0, 70]].map(([dx, dy]) => ({ x: o.x + dx, y: o.y + dy })).find((p) => !wet(p.x, p.y));
      if (from) { t = o; break; }
    }
    expect(t, 'an isolated tree in chunk 3,3 with dry ground beside it').toBeTruthy();
    const pinP = () => { w.player.x = from.x; w.player.y = from.y; w.player.vx = 0; w.player.vy = 0; };
    pinP();
    const fr = () => { w.player.magAmmo = w.WEAPONS[w.player.weapon].mag; w.player.reloading = false; upd(DT); pinP(); };
    w.player.weapon = w.WEAPONS.findIndex((x) => x.name === FLAME);
    const s = w.toScreen(t.x, t.y);
    w.mouseX = s.x + w.W / 2 - w.cam.x; w.mouseY = s.y + w.H / 2 - w.cam.y;
    w.mouseDown = true; w.mouseJustPressed = true;
    let lit = false;
    for (let i = 0; i < 3 / DT && !lit; i++) { fr(); lit = (w.envState(t.id).fire || 0) > 0; }
    w.mouseDown = false; w.mouseJustPressed = false;
    expect(lit, 'ignited').toBe(true);
    for (let i = 0; i < 12 / DT && !w.envState(t.id).charred; i++) fr();
    expect(w.envState(t.id).charred, 'burnt out and charred').toBe(true);

    unloadAndReturn();
    const t2 = w.envObjects.find((o) => o.id === t.id);
    expect(t2, 'tree regenerated with the same id').toBeTruthy();
    w.updateEnv(DT); // attaches persisted state to the regenerated object
    const st = w.envState(t.id);
    expect(st.charred, 'still charred').toBe(true);
    expect(st.fire || 0, 'not burning again').toBe(0);
    expect(st.trunkMax, 'trunk HP of a charred tree').toBe(300);
  }, 30_000);
});

// =====================================================================
// F4 Demo bot uses the flamethrower
// =====================================================================
describe('F4 demo bot', () => {
  test.skipIf(!LANDED.F4)('F4: DEMO_PREF_DIST has Flamethrower = 180 and no Tesla entry', () => {
    const { g: d } = loadGame();
    expect(d.DEMO_PREF_DIST.Flamethrower).toBe(180);
    expect(Object.keys(d.DEMO_PREF_DIST)).not.toContain('Tesla');
  });
});
