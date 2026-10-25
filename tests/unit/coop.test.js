import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect, beforeEach } from 'vitest';
import { newRound, ROOT } from '../helpers/load-game.js';
import { createPadRig, sourceFunction, BTN } from '../helpers/pads.js';
import { LANDED } from '../milestones.js';

// M11 local 2-player co-op (docs/SPEC.md M11 K1-K6, "Acceptance (Anna)"), headless.
// Drafted against Josh's provisional hooks (H below) before the code exists; each block
// skips until its flag in tests/milestones.js is true. The "Q4 1P lock" block has no flag:
// it pins today's 1P numbers, and must stay green through every K step unchanged.
// Two fake pads come from tests/helpers/pads.js (slots 0 and 1, hot-plug, a rumble spy per
// pad). main.js isn't loaded (its async init needs a GPU), so a frame is what gameLoop does:
// pollGamepad(), then main.js's update() (extracted) unless paused.
const DT = 1 / 60;

// ---------------------------------------------------------------------
// Provisional hooks (Josh, M11). If a name changes when a K item lands, change it here only.
// ---------------------------------------------------------------------
const H = {
  players: () => g.players, // players[0] === player
  state: () => g.coopState(), // { n, title2P, titleHint, titleCount, devices: [{ kbm, pad }] }
  padOf: (i) => g.padOf(i), // per-player pad state, same shape as M10 `pad`
  aimOf: (i) => g.padAimOf(i), // per-player padAim
  join: (padIndex) => g.coopJoin(padIndex), // spawns P2 directly -> players[1] | null
  zoom: () => g.camZoom(), // { zoom, target }
  setZoom: (z) => g.setCamZoom(z), // hold z; null releases
  damage: (dmg, p) => g.damagePlayer(dmg, p),
};
const C = () => g.CFG;

// ---------------------------------------------------------------------
// Headless main.js pieces
// ---------------------------------------------------------------------
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8');
const mainFunction = (name) => sourceFunction(MAIN_SRC, name);
/** main.js's update(), updateCamera() and addShake() in the sandbox. */
function withMain(game) {
  const { g: gg, run } = game;
  for (const k of ['app', 'renderer', 'stage', 'worldContainer', 'terrainContainer', 'effectsContainer', 'uiContainer']) {
    if (!gg[k]) gg[k] = gg.PIXI;
  }
  run(`${mainFunction('updateCamera')}
${mainFunction('addShake')}
var updateNotification = typeof updateNotification === 'function' ? updateNotification : function () {};
var __m11Update = (function () { return ${mainFunction('update')}; })();`);
  return run('__m11Update');
}

// ---------------------------------------------------------------------
// Sandbox state (fresh per test)
// ---------------------------------------------------------------------
let g, game, update, rig, started;

/** n in-game frames in gameLoop order: poll, then update unless paused. */
function frame(n = 1, dt = DT) {
  for (let i = 0; i < n; i++) {
    rig.clock.ms += dt * 1000;
    if (typeof g.pollGamepad === 'function') g.pollGamepad();
    if (!g.paused) update(dt);
  }
}
const seconds = (s) => frame(Math.round(s / DT));
/** n title-screen frames (gameStarted false): poll, then the D1 idle timer. */
function titleFrame(n = 1) {
  for (let i = 0; i < n; i++) {
    rig.clock.ms += DT * 1000;
    g.pollGamepad();
    g.updateDemoIdle(DT);
  }
}
/** Press and release button b on pad i, a frame each. */
function tap(i, b, poll = frame) {
  rig.btn(i, b, true); poll();
  rig.btn(i, b, false); poll();
}
const banners = () => game.calls.showNotification.map((c) => c.text);

// Dry ground with room to move: the terrain is the same in every round (seeded loader).
let _dry = null;
function findHome() {
  if (_dry) return _dry;
  const ts = g.CFG.TILE_SIZE;
  const wet = (x, y) => g.getTerrainTypeAt(Math.floor(x / ts) * ts, Math.floor(y / ts) * ts) === 'water';
  const R = 600;
  for (let r = 0; r < 30000 && !_dry; r += 80) {
    for (let a = 0; a < 16 && !_dry; a++) {
      const x = Math.cos((a / 16) * Math.PI * 2) * r, y = Math.sin((a / 16) * Math.PI * 2) * r;
      let ok = true;
      for (let dx = -R; dx <= R && ok; dx += 40) {
        for (let dy = -R; dy <= R && ok; dy += 40) if (dx * dx + dy * dy <= R * R && wet(x + dx, y + dy)) ok = false;
      }
      if (ok) _dry = { x, y };
    }
  }
  if (!_dry) throw new Error('no dry area found');
  return _dry;
}

/** Fresh round, P1 at a dry spot, no waves, no trees, nothing connected. */
function setup() {
  rig = createPadRig();
  started = 0;
  game = newRound({
    stubs: {
      ...rig.stubs(),
      startGame: () => { started++; g.gameStarted = true; },
      resetRound: () => {},
    },
  });
  g = game.g;
  update = withMain(game);
  g.gameStarted = true;
  g.waveActive = false;
  g.waveTimer = 1e9;
  g.enemies.length = 0;
  g.envObjects.length = 0;
  g.CFG.DEMO_IDLE_SECONDS = 1e9;
  const home = findHome();
  const p = g.player;
  p.x = home.x; p.y = home.y;
  const sp = g.toScreen(p.x, p.y);
  g.cam.x = g.cam.tx = sp.x; g.cam.y = g.cam.ty = sp.y;
}

/** 2P with P1 on pad 0 (used, so locked) and P2 joined from pad 1 by Start. */
function twoPads() {
  rig.connect(0); rig.connect(1);
  frame();
  rig.axes(0, 0.6, 0); frame(3); rig.axes(0, 0, 0); frame(); // P1 uses pad 0
  tap(1, BTN.START);
  const ps = H.players();
  if (ps.length !== 2) throw new Error(`P2 did not join (players: ${ps.length})`);
  return ps;
}
/** Place player p at an offset from P1's home, still. */
function place(p, dx, dy) {
  const h = findHome();
  p.x = h.x + dx; p.y = h.y + dy; p.vx = 0; p.vy = 0;
}
/** A stationary, harmless enemy at (x, y). */
function dummy(x, y, { hp = 1e9 } = {}) {
  const e = g.spawnEnemy(0, x, y);
  e.vx = 0; e.vy = 0; e.speed = 0; e.fireTimer = 1e9;
  e.hp = e.maxHp = hp; e.shieldHp = e.maxShieldHp = 0;
  return e;
}
/** Screen position (low-res px) of world point (x, y) relative to the view centre at the live zoom. */
function lowResFromCentre(x, y) {
  const s = g.toScreen(x, y), z = H.zoom().zoom, ps = g.RETRO.PIXEL_SCALE;
  return { x: ((s.x - g.cam.x) * z) / ps, y: ((s.y - g.cam.y) * z) / ps };
}
/** A bullet shaped like updatePlayer's / updateEnemies' (by: shooter index, players only). */
function shot(x, y, vx, vy, { dmg = 30, owner = 'player', by = 0 } = {}) {
  const b = { x, y, vx, vy, dmg, life: 2, owner, color: '#fff', size: 2.5, trail: false, pierce: 0,
    explosive: false, radius: 0, glow: false, beam: false, disintegrate: false, bfg: false, fresh: true };
  if (owner === 'player') b.by = by;
  g.bullets.push(b);
  return b;
}
const viewLowRes = () => ({ w: g.W / g.RETRO.PIXEL_SCALE, h: g.H / g.RETRO.PIXEL_SCALE });
/** Expected K3a target zoom for world points, from the spec formula (64 low-res px margin). */
function expectedZoom(points) {
  const ps = g.RETRO.PIXEL_SCALE, v = viewLowRes();
  const sc = points.map((q) => g.toScreen(q.x, q.y));
  const mx = sc.reduce((a, s) => a + s.x, 0) / sc.length, my = sc.reduce((a, s) => a + s.y, 0) / sc.length;
  const ex = Math.max(...sc.map((s) => Math.abs(s.x - mx))) / ps, ey = Math.max(...sc.map((s) => Math.abs(s.y - my))) / ps;
  const m = C().COOP_ZOOM_MARGIN ?? 64;
  const fit = Math.min(ex > 0 ? (v.w / 2 - m) / ex : Infinity, ey > 0 ? (v.h / 2 - m) / ey : Infinity);
  return Math.max(C().COOP_ZOOM_MIN, Math.min(1, fit));
}
/** World offset (dx, dy) along the screen x axis that is `lowRes` low-res px at zoom 1. */
const screenRight = (lowRes) => { const d = (lowRes * g.RETRO.PIXEL_SCALE) / 2; return { dx: d, dy: -d }; };

// =====================================================================
// Q4 1P lock: today's single-player numbers (no flag; must never change)
// =====================================================================
describe('M11 Q4 1P lock', () => {
  beforeEach(setup);

  test('Q4: 1P SECOND WIND at 0 HP: 30% HP, 20% shield, 2 s invulnerable, a radius-60 blast at the player, the banner', () => {
    const p = g.player;
    const blasts = [];
    const orig = g.spawnExplosion;
    g.spawnExplosion = (x, y, r, ...rest) => { blasts.push({ x, y, r }); return orig(x, y, r, ...rest); };
    p.shield = 0; p.hp = 5; p.invincible = 0; p.dodging = false;
    g.damagePlayer(50);
    expect(p.hp).toBeCloseTo(p.maxHp * 0.3, 6);
    expect(p.shield).toBeCloseTo(p.maxShield * 0.2, 6);
    expect(p.invincible).toBe(2);
    expect(blasts).toEqual([{ x: p.x, y: p.y, r: 60 }]);
    expect(banners()).toContain('SECOND WIND!');
    expect(banners()).not.toContain('TEAM SECOND WIND!');
  });

  test('Q4: 1P damage while invulnerable or dodging does nothing; the shield absorbs first', () => {
    const p = g.player;
    p.invincible = 1; g.damagePlayer(30);
    expect([p.hp, p.shield]).toEqual([p.maxHp, p.maxShield]);
    p.invincible = 0; p.dodging = true; g.damagePlayer(30);
    expect([p.hp, p.shield]).toEqual([p.maxHp, p.maxShield]);
    p.dodging = false; g.damagePlayer(p.maxShield + 7);
    expect(p.shield).toBe(0);
    expect(p.hp).toBe(p.maxHp - 7);
  });

  test('Q4: 1P wave size is 5 + 2w + floor(w/2) for waves 1-12', () => {
    for (let w = 1; w <= 12; w++) {
      g.enemies.length = 0;
      g.wave = w - 1; g.waveActive = false; g.waveTimer = 0;
      g.updateWaves(DT);
      expect(g.enemiesThisWave, `wave ${w}`).toBe(Math.min(5 + w * 2 + Math.floor(w * 0.5), C().MAX_ENEMIES));
    }
  });

  test('Q4: 1P boss HP is 300 + 250 x weapon index', () => {
    for (let i = 1; i < g.WEAPONS.length; i++) {
      g.enemies.length = 0;
      g.spawnBoss(i);
      const b = g.enemies.find((e) => e.isBoss);
      expect(b.hp, `boss ${i}`).toBe(300 + i * 250);
      expect(b.maxHp).toBe(300 + i * 250);
    }
  });

  test('Q4: 1P unlocks: a score at a weapon threshold spawns its boss', () => {
    g.unlockedWeapons = 1; g.bossActive = false;
    g.score = g.WEAPONS[1].unlock - 1;
    g.checkWeaponUnlocks();
    expect(g.bossActive).toBe(false);
    g.score = g.WEAPONS[1].unlock;
    g.checkWeaponUnlocks();
    expect([g.bossActive, g.bossTarget]).toEqual([true, 1]);
  });

  test('Q4: 1P camera follows the player (no zoom hook needed): target is toScreen(player)', () => {
    const p = g.player;
    p.x += 300; p.y -= 120;
    g.updateCamera(DT);
    const sp = g.toScreen(p.x, p.y);
    expect([g.cam.tx, g.cam.ty]).toEqual([sp.x, sp.y]);
  });

  test.skipIf(!LANDED.K1)('Q4/K1: 1P has exactly one player, and player is players[0]', () => {
    expect(H.players().length).toBe(1);
    expect(H.players()[0]).toBe(g.player);
  });

  test.skipIf(!LANDED.K3)('Q4/K3a: 1P zoom is exactly 1.0, still and after running far', () => {
    frame(10);
    expect(H.zoom()).toMatchObject({ zoom: 1, target: 1 });
    g.player.x += 3000;
    frame(120);
    expect(H.zoom()).toMatchObject({ zoom: 1, target: 1 });
  });

  test.skipIf(!LANDED.K5)('Q4/K5: 1P never goes DOWN: 0 HP is SECOND WIND as before', () => {
    const p = g.player;
    p.shield = 0; p.hp = 1;
    H.damage(10, p);
    expect(p.state ?? 'up').toBe('up');
    expect(p.hp).toBeCloseTo(p.maxHp * 0.3, 6);
    expect(banners()).toContain('SECOND WIND!');
  });

  test.skipIf(!LANDED.K6)('Q4/K6: 1P wave size and boss HP are not scaled (COOP multipliers apply only in 2P)', () => {
    g.wave = 3; g.waveActive = false; g.waveTimer = 0;
    g.updateWaves(DT);
    expect(g.enemiesThisWave).toBe(5 + 4 * 2 + 2);
    g.enemies.length = 0;
    g.spawnBoss(2);
    expect(g.enemies.find((e) => e.isBoss).hp).toBe(800);
  });
});

// =====================================================================
// K2 join and devices
// =====================================================================
describe('M11 K2 join and devices', () => {
  beforeEach(setup);
  const todo = !LANDED.K2;

  test.skipIf(todo)('K2: kbm + one unused pad: View/Back joins P2 on that pad; P1 stays on kbm', () => {
    rig.connect(0); frame();
    expect(H.state().n).toBe(1);
    tap(0, BTN.BACK);
    const ps = H.players();
    expect(ps.length).toBe(2);
    expect(H.state().devices).toEqual([{ kbm: true, pad: null }, { kbm: false, pad: 0 }]);
    expect(banners()).toContain('PLAYER 2 JOINS!');
  });

  test.skipIf(todo)('K2: a lone pad: Start and A never join P2 (Start pauses, A dodges P1: their M10 meaning)', () => {
    rig.connect(0); frame();
    tap(0, BTN.START);
    expect(H.players().length).toBe(1);
    expect(g.paused).toBe(true);
    tap(0, BTN.START);
    expect(g.paused).toBe(false);
    rig.btn(0, BTN.A, true); frame(2);
    expect(g.player.dodging).toBe(true);
    rig.btn(0, BTN.A, false); frame();
    expect(H.players().length).toBe(1);
    expect(banners()).not.toContain('PLAYER 2 JOINS!');
  });

  test.skipIf(todo)('K2: a lone pad P1 has used is P1\'s: View/Back on it does not join P2', () => {
    rig.connect(0); frame();
    rig.axes(0, 0.6, 0); frame(3); rig.axes(0, 0, 0); frame();
    expect(g.inputDevice).toBe('pad');
    tap(0, BTN.BACK);
    expect(H.players().length).toBe(1);
  });

  test.skipIf(todo)('K2: two pads, P1 on pad 0: Start on pad 1 joins P2 on pad 1; A on pad 1 also joins', () => {
    twoPads();
    expect(H.state().devices).toEqual([{ kbm: true, pad: 0 }, { kbm: false, pad: 1 }]);
    setup();
    rig.connect(0); rig.connect(1); frame();
    rig.btn(0, BTN.RT, 0.6); frame(2); rig.btn(0, BTN.RT, 0); frame(); // P1 uses pad 0
    tap(1, BTN.A);
    expect(H.players().length).toBe(2);
    expect(H.state().devices[1]).toEqual({ kbm: false, pad: 1 });
  });

  test.skipIf(todo)('K2: two pads: P1\'s pad index locks once used; Start/A on P1\'s pad keep their M10 meaning', () => {
    twoPads();
    tap(0, BTN.START);
    expect(g.paused, 'Start on P1\'s pad pauses').toBe(true);
    tap(0, BTN.START);
    expect(g.paused).toBe(false);
    expect(H.players().length).toBe(2);
    expect(H.state().devices[0].pad).toBe(0);
  });

  test.skipIf(todo)('K2: two pads, P1 on kbm only: Start on pad 1 joins P2 there, and pad 0 still drives P1', () => {
    rig.connect(0); rig.connect(1); frame();
    tap(1, BTN.START);
    expect(H.players().length).toBe(2);
    expect(H.state().devices[1].pad).toBe(1);
    const [p1, p2] = H.players();
    const a = { x: p1.x, y: p1.y }, b = { x: p2.x, y: p2.y };
    rig.axes(0, 1, 0); frame(30); rig.axes(0, 0, 0); frame();
    expect(Math.hypot(p1.x - a.x, p1.y - a.y), 'pad 0 moved P1').toBeGreaterThan(20);
    expect(Math.hypot(p2.x - b.x, p2.y - b.y), 'P2 did not move').toBeLessThan(1);
    expect(H.state().devices[0]).toEqual({ kbm: true, pad: 0 });
  });

  test.skipIf(todo)('K2: a late second pad (P1 already on pad 0): hot-plugged pad 1 + Start drops P2 in mid-game', () => {
    rig.connect(0); frame();
    rig.axes(0, 0.6, 0); frame(3); rig.axes(0, 0, 0); frame();
    g.gameTime = 50;
    rig.connect(1); frame();
    expect(H.players().length, 'connecting alone does not join').toBe(1);
    tap(1, BTN.START);
    expect(H.players().length).toBe(2);
    expect(H.state().devices).toEqual([{ kbm: true, pad: 0 }, { kbm: false, pad: 1 }]);
  });

  test.skipIf(todo)('K2: drop-in spawns P2 next to P1 with 100 HP, P1\'s selected weapon, default ammo and grenades', () => {
    g.unlockedWeapons = 4;
    g.player.weapon = 3; g.player.grenades = 1; g.player.hp = 40;
    rig.connect(0); frame();
    tap(0, BTN.BACK);
    const [p1, p2] = H.players();
    const fresh = g.createPlayer();
    expect(Math.hypot(p2.x - p1.x, p2.y - p1.y), 'next to P1').toBeLessThan(120);
    expect(p2.hp).toBe(100);
    expect(p2.weapon).toBe(3);
    expect(p2.magAmmo).toBe(g.WEAPONS[3].mag);
    expect(p2.grenades).toBe(fresh.grenades);
    expect(p2).not.toBe(p1);
    expect(p1.hp, 'P1 untouched').toBe(40);
    expect(p1.grenades).toBe(1);
  });

  test.skipIf(todo)('K2: there is no drop-out: Back/Start on P2\'s pad never removes P2', () => {
    twoPads();
    tap(1, BTN.BACK);
    tap(1, BTN.START); tap(1, BTN.START);
    expect(H.players().length).toBe(2);
  });

  test.skipIf(todo)('K2: title: two pads -> "2P PRESS START"; one pad + kbm -> "2P PRESS VIEW ON PAD"; none -> no hint', () => {
    g.gameStarted = false;
    titleFrame(2);
    expect(H.state().title2P).toBe(false);
    rig.connect(0); titleFrame(2);
    expect(H.state()).toMatchObject({ title2P: true, titleHint: '2P PRESS VIEW ON PAD' });
    rig.connect(1); titleFrame(2);
    expect(H.state()).toMatchObject({ title2P: true, titleHint: '2P PRESS START' });
  });

  test.skipIf(todo)('K2: title: P2 joins with the same trigger, the count reads 2P, and A on P1\'s pad then starts a 2P game', () => {
    g.gameStarted = false;
    rig.connect(0); rig.connect(1); titleFrame(2);
    rig.axes(0, 0.6, 0); titleFrame(2); rig.axes(0, 0, 0); titleFrame(); // P1 uses pad 0
    expect(H.state().titleCount).toBe(1);
    tap(1, BTN.START, titleFrame);
    expect(H.state().titleCount).toBe(2);
    expect(started, 'P2 joining does not start the game').toBe(0);
    tap(0, BTN.A, titleFrame);
    expect(started).toBe(1);
  });

  test.skipIf(todo)('K2: each pad drives only its own player (move, aim, fire); padOf/padAimOf are per player', () => {
    const [p1, p2] = twoPads();
    place(p1, 0, 0); place(p2, 0, 200);
    const a = { x: p1.x, y: p1.y }, b = { x: p2.x, y: p2.y };
    rig.axes(1, 1, 0, 0, 1); frame(30);
    expect(Math.hypot(p2.x - b.x, p2.y - b.y), 'P2 moved').toBeGreaterThan(20);
    expect(Math.hypot(p1.x - a.x, p1.y - a.y), 'P1 did not').toBeLessThan(1);
    expect(H.padOf(1).lmag).toBeGreaterThan(0);
    expect(H.padOf(0).lmag).toBe(0);
    expect(H.aimOf(1).has).toBe(true);
    expect(H.aimOf(0).has).toBe(false);
    rig.axes(1, 0, 0); frame();
    g.bullets.length = 0;
    p2.fireTimer = 0; p2.magAmmo = g.WEAPONS[p2.weapon].mag; p2.reloading = false;
    rig.btn(1, BTN.RT, 1); frame(2); rig.btn(1, BTN.RT, 0); frame();
    const mine = g.bullets.filter((q) => q.owner === 'player');
    expect(mine.length, 'P2 fired').toBeGreaterThan(0);
    expect(mine.every((q) => q.by === 1), 'bullets carry by = 1').toBe(true);
    expect(Math.hypot(mine[0].x - p2.x, mine[0].y - p2.y), 'from P2').toBeLessThan(80);
  });

  test.skipIf(todo)('K2: aim assist is per pad: an enemy 4.3 deg off the P2 aim bends only the P2 shot', () => {
    const [p1, p2] = twoPads();
    place(p1, 0, 0); place(p2, 0, 300);
    rig.axes(1, 0, 0, 1, 0); frame(3); // P2 aims screen-right with the right stick
    const d = H.aimOf(1), off = 4.3 * Math.PI / 180;
    const e = dummy(p2.x + (d.dirX * Math.cos(off) - d.dirY * Math.sin(off)) * 250, p2.y + (d.dirX * Math.sin(off) + d.dirY * Math.cos(off)) * 250);
    g.unlockedWeapons = 1; p2.weapon = 0; p2.fireTimer = 0; p2.magAmmo = g.WEAPONS[0].mag; p2.reloading = false;
    g.bullets.length = 0;
    rig.btn(1, BTN.RT, 1); frame(2); rig.btn(1, BTN.RT, 0); frame();
    const b = g.bullets.find((q) => q.owner === 'player' && q.by === 1);
    const want = Math.atan2(e.y - p2.y, e.x - p2.x), got = Math.atan2(b.vy, b.vx);
    expect(Math.abs(Math.atan2(Math.sin(got - want), Math.cos(got - want))), 'assisted onto the enemy (within pistol spread)').toBeLessThan(g.WEAPONS[0].spread + 0.01);
    expect(H.aimOf(0).has, 'P1 aim untouched').toBe(false);
  });

  test.skipIf(todo)('K2/C4: rumble goes only to the pad of the player concerned (shots, damage, blasts)', () => {
    const [p1, p2] = twoPads();
    place(p1, 0, 0); place(p2, 0, 600);
    p1.invincible = 0; p2.invincible = 0;
    rig.effects.length = 0;
    p2.fireTimer = 0; p2.magAmmo = g.WEAPONS[p2.weapon].mag;
    rig.btn(1, BTN.RT, 1); frame(3); rig.btn(1, BTN.RT, 0); frame();
    expect(rig.effectsOf(1).length, 'P2 shot rumbles pad 1').toBeGreaterThan(0);
    expect(rig.effectsOf(0).length, 'not pad 0').toBe(0);

    rig.clock.ms += 200; g.gameTime += 0.2; rig.effects.length = 0;
    H.damage(5, p1);
    expect(rig.effectsOf(0).length, 'P1 damage rumbles pad 0').toBe(1);
    expect(rig.effectsOf(1).length).toBe(0);

    rig.clock.ms += 200; g.gameTime += 0.2; rig.effects.length = 0;
    p2.invincible = 1e9; // a blast measured from P2 only: P1 is 600u away
    g.spawnExplosion(p2.x + 60, p2.y, 130, false, g.SRC_EXPLOSIVE);
    frame();
    expect(rig.effectsOf(1).some((e) => e.strongMagnitude > 0), 'blast near P2 rumbles pad 1').toBe(true);
    expect(rig.effectsOf(0).length, 'P1 is far away: no rumble').toBe(0);
  });

  test.skipIf(todo)('K2/C6: Start/P from either player pauses everything; P2\'s pad disconnecting auto-pauses naming P2', () => {
    const [, p2] = twoPads();
    tap(1, BTN.START);
    expect(g.paused).toBe(true);
    tap(1, BTN.START);
    expect(g.paused).toBe(false);
    rig.disconnect(1); frame();
    expect(g.paused).toBe(true);
    expect(banners().concat(g.padStats().lastToast || []).join('\n')).toMatch(/P2 CONTROLLER DISCONNECTED/);
    expect(H.players()).toContain(p2);
  });
});

// =====================================================================
// K3 shared camera, K3a zoom, K3b leash
// =====================================================================
describe('M11 K3 camera, zoom and leash', () => {
  beforeEach(setup);
  const todo = !LANDED.K3;
  const twoUp = () => {
    const [p1, p2] = (rig.connect(0), frame(), tap(0, BTN.BACK), H.players());
    p1.invincible = p2.invincible = 1e9;
    return [p1, p2];
  };

  test.skipIf(todo)('K3: the camera target is the midpoint of the counted players', () => {
    const [p1, p2] = twoUp();
    place(p1, 0, 0); place(p2, 120, 40);
    frame();
    const s = g.toScreen((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
    expect(g.cam.tx).toBeCloseTo(s.x, 6);
    expect(g.cam.ty).toBeCloseTo(s.y, 6);
  });

  test.skipIf(todo)('K3a: CFG defaults: COOP_ZOOM_MIN 0.6', () => {
    expect(C().COOP_ZOOM_MIN).toBe(0.6);
  });

  test.skipIf(todo)('K3a: players close together: zoom is exactly 1.0', () => {
    const [p1, p2] = twoUp();
    place(p1, 0, 0); place(p2, 60, 0);
    frame(60);
    expect(H.zoom()).toMatchObject({ zoom: 1, target: 1 });
  });

  test.skipIf(todo)('K3a: target = largest zoom <= 1 keeping both players 64 low-res px inside the edges (screen-x and screen-y spreads)', () => {
    const [p1, p2] = twoUp();
    const v = viewLowRes();
    for (const frac of [0.6, 0.8, 0.95]) {
      // along screen x: separation of frac x (full width / 0.6) low-res px at zoom 1
      const r = screenRight(((v.w - 128) / 0.6) * frac);
      place(p1, 0, 0); place(p2, r.dx, r.dy);
      frame();
      expect(H.zoom().target, `screen-x spread ${frac}`).toBeCloseTo(expectedZoom([p1, p2]), 4);
    }
    // along screen y (iso: world +x+y goes down the screen)
    const d = ((v.h - 128) / 0.6 * 0.8 * g.RETRO.PIXEL_SCALE) / (2 * C().ISO_SCALE);
    place(p1, 0, 0); place(p2, d, d);
    frame();
    expect(H.zoom().target, 'screen-y spread').toBeCloseTo(expectedZoom([p1, p2]), 4);
    expect(H.zoom().target).toBeLessThan(1);
  });

  test.skipIf(todo)('K3a: the target is clamped at 0.6 however far apart', () => {
    const [p1, p2] = twoUp();
    const r = screenRight(viewLowRes().w * 3);
    place(p1, 0, 0); place(p2, r.dx, r.dy);
    frame();
    expect(H.zoom().target).toBe(C().COOP_ZOOM_MIN);
    seconds(3);
    expect(H.zoom().zoom).toBeCloseTo(C().COOP_ZOOM_MIN, 3);
    expect(H.zoom().zoom).toBeGreaterThanOrEqual(C().COOP_ZOOM_MIN);
  });

  test.skipIf(todo)('K3a: zooming out follows the target (reaches it within 1.5 s, never overshoots)', () => {
    const [p1, p2] = twoUp();
    const r = screenRight(viewLowRes().w * 1.2);
    place(p1, 0, 0); place(p2, r.dx, r.dy);
    frame();
    const target = H.zoom().target;
    expect(target).toBeLessThan(0.95);
    let prev = 1;
    for (let i = 0; i < 90; i++) {
      frame();
      const z = H.zoom().zoom;
      expect(z).toBeLessThanOrEqual(prev + 1e-9);
      expect(z).toBeGreaterThanOrEqual(target - 1e-9);
      prev = z;
    }
    expect(prev).toBeCloseTo(target, 2);
  });

  test.skipIf(todo)('K3a: zoom-in deadband: no zoom-in while the target is < 5% above the zoom; at >= 5% it zooms in, slower than out', () => {
    const [p1, p2] = twoUp();
    const sep = (lowRes) => { const r = screenRight(lowRes); place(p1, 0, 0); place(p2, r.dx, r.dy); };
    const v = viewLowRes();
    const sepFor = (z) => (v.w - 128) / z; // separation whose fit is exactly z
    sep(sepFor(0.7)); seconds(3);
    const z0 = H.zoom().zoom;
    expect(z0).toBeCloseTo(0.7, 2);
    sep(sepFor(z0 * 1.04)); seconds(3);
    expect(H.zoom().zoom, 'target 4% above: held').toBeCloseTo(z0, 6);
    sep(sepFor(z0 * 1.06)); frame();
    expect(H.zoom().target).toBeCloseTo(z0 * 1.06, 3);
    seconds(0.25);
    const zin = H.zoom().zoom - z0;
    expect(zin, 'target 6% above: zooming in').toBeGreaterThan(0);
    seconds(6);
    expect(H.zoom().zoom).toBeCloseTo(z0 * 1.06, 2);
    // in runs at 1/s, out at 3/s: over the same 0.25 s, a zoom-out step of the same size moves more
    const zIn = H.zoom().zoom;
    sep(sepFor(zIn - (z0 * 1.06 - z0))); frame();
    seconds(0.25);
    expect(zIn - H.zoom().zoom, 'zoom-out faster than zoom-in').toBeGreaterThan(zin);
  });

  test.skipIf(todo)('K3a: back together, the zoom returns to exactly 1.0', () => {
    const [p1, p2] = twoUp();
    const r = screenRight(viewLowRes().w);
    place(p1, 0, 0); place(p2, r.dx, r.dy); seconds(2);
    expect(H.zoom().zoom).toBeLessThan(1);
    place(p2, 40, 0); seconds(8);
    expect(H.zoom()).toMatchObject({ zoom: 1, target: 1 });
  });

  test.skipIf(todo)('K3a: setCamZoom holds a zoom; null hands it back to the camera', () => {
    const [p1, p2] = twoUp();
    place(p1, 0, 0); place(p2, 40, 0);
    H.setZoom(0.7); frame(30);
    expect(H.zoom().zoom).toBe(0.7);
    H.setZoom(null); seconds(8);
    expect(H.zoom().zoom).toBe(1);
  });

  test.skipIf(todo)('K3a: dead players do not count for the midpoint or the zoom; downed players do', () => {
    const [p1, p2] = twoUp();
    const r = screenRight(viewLowRes().w);
    place(p1, 0, 0); place(p2, r.dx, r.dy);
    p2.state = 'dead'; frame();
    const s1 = g.toScreen(p1.x, p1.y);
    expect([g.cam.tx, g.cam.ty]).toEqual([s1.x, s1.y]);
    expect(H.zoom().target).toBe(1);
    p2.state = 'down'; frame();
    expect(H.zoom().target).toBeLessThan(1);
  });

  test.skipIf(todo)('K3b: below max zoom-out there is no leash: moving apart runs at full speed', () => {
    const [p1, p2] = twoUp();
    const r = screenRight(viewLowRes().w * 0.6);
    place(p1, 0, 0); place(p2, r.dx, r.dy); seconds(2);
    expect(H.zoom().zoom).toBeGreaterThan(C().COOP_ZOOM_MIN + 0.1);
    const at = { x: p2.x, y: p2.y };
    rig.axes(0, 1, 0); frame(12); rig.axes(0, 0, 0); // P2 (on pad 0 here) runs screen-right for 0.2 s
    expect(Math.hypot(p2.x - at.x, p2.y - at.y), 'not clamped while zoom > min').toBeGreaterThan(0.8 * C().PLAYER_SPEED * 0.2);
    expect(H.zoom().zoom).toBeGreaterThan(C().COOP_ZOOM_MIN);
  });

  test.skipIf(todo)('K3b: at COOP_ZOOM_MIN a player running away is clamped; both stay >= 48 low-res px inside the view edges', () => {
    const [p1, p2] = twoUp();
    place(p1, 0, 0); place(p2, 40, -40);
    rig.axes(0, 1, 0); // P2 (pad 0 here) runs screen-right for 10 s
    for (let i = 0; i < 600; i++) {
      frame();
      if (H.zoom().zoom > C().COOP_ZOOM_MIN + 1e-6) continue;
      const v = viewLowRes();
      for (const p of [p1, p2]) {
        const s = lowResFromCentre(p.x, p.y);
        expect(v.w / 2 - Math.abs(s.x), `frame ${i}: x margin`).toBeGreaterThanOrEqual(48 - 1);
        expect(v.h / 2 - Math.abs(s.y), `frame ${i}: y margin`).toBeGreaterThanOrEqual(48 - 1);
      }
    }
    rig.axes(0, 0, 0);
    expect(H.zoom().zoom, 'it got to max zoom-out').toBeCloseTo(C().COOP_ZOOM_MIN, 3);
    // moving back toward P1 is free
    const d0 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    rig.axes(0, -1, 0); frame(20); rig.axes(0, 0, 0);
    expect(Math.hypot(p2.x - p1.x, p2.y - p1.y)).toBeLessThan(d0 - 20);
  });

  test.skipIf(todo)('K3b: knockback may push past the leash; the next outward move is clamped (no teleport back)', () => {
    const [p1, p2] = twoUp();
    const r = screenRight(viewLowRes().w * 2.5);
    place(p1, 0, 0); place(p2, r.dx, r.dy); seconds(3);
    expect(H.zoom().zoom).toBeCloseTo(C().COOP_ZOOM_MIN, 3);
    const d0 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    let last = { x: p2.x, y: p2.y };
    rig.axes(0, 1, 0);
    for (let i = 0; i < 60; i++) {
      frame();
      expect(Math.hypot(p2.x - last.x, p2.y - last.y), 'no snap').toBeLessThan(C().PLAYER_SPEED * DT * 2 + 1);
      last = { x: p2.x, y: p2.y };
    }
    rig.axes(0, 0, 0);
    expect(Math.hypot(p2.x - p1.x, p2.y - p1.y), 'separation does not grow').toBeLessThanOrEqual(d0 + 1);
  });

  test.skipIf(todo)('K3: shake stays global and capped at SHAKE_MAX, whatever the zoom', () => {
    twoUp();
    H.setZoom(0.6);
    g.addShake(1e3);
    expect(g.shakeMag).toBe(C().SHAKE_MAX);
    H.setZoom(null);
  });
});

// =====================================================================
// K5 down, revive, TEAM SECOND WIND
// =====================================================================
describe('M11 K5 down, revive and team second wind', () => {
  beforeEach(setup);
  const todo = !LANDED.K5;
  const twoUp = () => {
    rig.connect(0); frame(); tap(0, BTN.BACK);
    const [p1, p2] = H.players();
    place(p1, 0, 0); place(p2, 300, 0);
    p1.invincible = p2.invincible = 0; p1.shield = p2.shield = 0;
    return [p1, p2];
  };
  const down = (p) => { p.invincible = 0; p.dodging = false; p.shield = 0; H.damage(p.hp + 50, p); };

  test.skipIf(todo)('K5: CFG defaults: down 8 s, revive within 50u for 1.5 s, back at 50% HP with 1 s invulnerability', () => {
    expect(C()).toMatchObject({ COOP_DOWN_TIME: 8, COOP_REVIVE_RANGE: 50, COOP_REVIVE_TIME: 1.5, COOP_REVIVE_HP: 0.5, COOP_REVIVE_INVULN: 1 });
  });

  test.skipIf(todo)('K5: 2P, a player at 0 HP goes DOWN (no SECOND WIND); the partner is untouched', () => {
    const [p1, p2] = twoUp();
    down(p2);
    expect(p2.state).toBe('down');
    expect(p2.downT).toBeCloseTo(8, 6);
    expect(p1.state).toBe('up');
    expect(banners()).not.toContain('SECOND WIND!');
    expect(banners()).not.toContain('TEAM SECOND WIND!');
  });

  test.skipIf(todo)('K5: a downed player cannot act (move, fire, throw, dodge)', () => {
    const [, p2] = twoUp();
    down(p2);
    const at = { x: p2.x, y: p2.y, g: p2.grenades };
    g.bullets.length = 0;
    rig.axes(0, 1, 0, 1, 0); rig.btn(0, BTN.RT, 1); rig.btn(0, BTN.B, 1); rig.btn(0, BTN.A, 1);
    frame(30);
    rig.release(0); frame();
    expect(Math.hypot(p2.x - at.x, p2.y - at.y)).toBeLessThan(1);
    expect(g.bullets.filter((b) => b.by === 1).length).toBe(0);
    expect(p2.grenades).toBe(at.g);
    expect(p2.dodging).toBe(false);
  });

  test.skipIf(todo)('K5: enemies ignore a downed player', () => {
    const [p1, p2] = twoUp();
    place(p1, 0, 0); place(p2, 600, 0);
    const e = dummy(p2.x + 40, p2.y); e.speed = 60;
    down(p2);
    seconds(1.5);
    expect(e.target).toBe(p1);
    expect(Math.hypot(e.x - p2.x, e.y - p2.y), 'walking away from P2 toward P1').toBeGreaterThan(40);
  });

  test.skipIf(todo)('K5: revive: partner within 50u for 1.5 s -> up at 50% HP, 1 s invulnerable; not at 1.4 s', () => {
    const [p1, p2] = twoUp();
    down(p2);
    place(p1, 300 - 45, 0); // 45u from P2
    seconds(1.4);
    expect(p2.state).toBe('down');
    expect(p2.reviveT).toBeGreaterThan(1.3);
    seconds(0.15);
    expect(p2.state).toBe('up');
    expect(p2.hp).toBeCloseTo(p2.maxHp * 0.5, 6);
    expect(p2.invincible).toBeGreaterThan(0.9);
    expect(p2.invincible).toBeLessThanOrEqual(1);
  });

  test.skipIf(todo)('K5: revive range: at 55u nothing happens; the down timer keeps running', () => {
    const [p1, p2] = twoUp();
    down(p2);
    place(p1, 300 - 55, 0);
    seconds(2);
    expect(p2.state).toBe('down');
    expect(p2.reviveT || 0).toBe(0);
    expect(p2.downT).toBeCloseTo(6, 1);
  });

  test.skipIf(todo)('K5: after 8 s down the player is dead: gibbed; back at the next wave start next to the partner with 100 HP', () => {
    const [p1, p2] = twoUp();
    down(p2);
    const gibs0 = g.gibs.length;
    seconds(7.9);
    expect(p2.state).toBe('down');
    seconds(0.2);
    expect(p2.state).toBe('dead');
    expect(g.gibs.length, 'gibbed (G-series)').toBeGreaterThan(gibs0);
    seconds(2);
    expect(p2.state, 'stays dead until the next wave').toBe('dead');
    g.waveActive = false; g.waveTimer = 0;
    frame(2);
    expect(p2.state).toBe('up');
    expect(p2.hp).toBe(100);
    expect(Math.hypot(p2.x - p1.x, p2.y - p1.y)).toBeLessThan(120);
  });

  test.skipIf(todo)('K5: TEAM SECOND WIND when both are down: both stand on the spot at 30% HP, 20% shield, 2 s invulnerable, blasts, timers cleared', () => {
    const [p1, p2] = twoUp();
    const blasts = [];
    const orig = g.spawnExplosion;
    g.spawnExplosion = (x, y, r, ...rest) => { blasts.push({ x, y, r }); return orig(x, y, r, ...rest); };
    down(p2);
    seconds(1);
    const at1 = { x: p1.x, y: p1.y }, at2 = { x: p2.x, y: p2.y };
    down(p1);
    for (const [p, at] of [[p1, at1], [p2, at2]]) {
      expect(p.state).toBe('up');
      expect(p.hp).toBeCloseTo(p.maxHp * 0.3, 6);
      expect(p.shield).toBeCloseTo(p.maxShield * 0.2, 6);
      expect(p.invincible).toBe(2);
      expect([p.x, p.y]).toEqual([at.x, at.y]);
      expect(p.downT || 0).toBe(0);
      expect(p.reviveT || 0).toBe(0);
      expect(blasts).toContainEqual({ x: at.x, y: at.y, r: 60 });
    }
    expect(banners()).toContain('TEAM SECOND WIND!');
    expect(banners()).not.toContain('SECOND WIND!');
    const t = g.gameTime;
    frame(10);
    expect(g.gameTime).toBeGreaterThan(t);
    expect(g.paused).toBe(false);
  });

  test.skipIf(todo)('K5: TEAM SECOND WIND with one dead: the dead respawns next to the downed one, same values', () => {
    const [p1, p2] = twoUp();
    down(p2); seconds(8.2);
    expect(p2.state).toBe('dead');
    place(p1, -500, 200);
    down(p1);
    expect(p1.state).toBe('up');
    expect(p2.state).toBe('up');
    expect(Math.hypot(p2.x - p1.x, p2.y - p1.y), 'next to the downed P1').toBeLessThan(120);
    for (const p of [p1, p2]) {
      expect(p.hp).toBeCloseTo(p.maxHp * 0.3, 6);
      expect(p.invincible).toBe(2);
    }
  });

  test.skipIf(todo)('K5: no TEAM SECOND WIND while one player is standing', () => {
    const [p1, p2] = twoUp();
    down(p2);
    seconds(3);
    expect(p1.state).toBe('up');
    expect(p2.state).toBe('down');
    expect(banners()).not.toContain('TEAM SECOND WIND!');
  });

  test.skipIf(todo)('K5/D6: in the demo, demoOnPlayerDeath fires at TEAM SECOND WIND, not when one goes down', () => {
    const [p1, p2] = twoUp();
    const calls = [];
    g.demoOnPlayerDeath = () => calls.push(g.gameTime);
    g.demoActive = true;
    g.CFG.DEMO_DAMAGE_MULT = 1;
    down(p2);
    expect(calls.length).toBe(0);
    down(p1);
    expect(calls.length).toBe(1);
  });
});

// =====================================================================
// K6 rules in 2P
// =====================================================================
describe('M11 K6 rules in 2P', () => {
  beforeEach(setup);
  const todo = !LANDED.K6;
  const twoUp = () => {
    rig.connect(0); frame(); tap(0, BTN.BACK);
    const [p1, p2] = H.players();
    p1.invincible = p2.invincible = 1e9;
    return [p1, p2];
  };
  /** An enemy that never moves or shoots (its target is still picked every frame). */
  const walker = (x, y) => dummy(x, y);

  test.skipIf(todo)('K6: CFG defaults: enemies x1.5, boss HP x1.5, friendly fire off', () => {
    expect(C()).toMatchObject({ COOP_ENEMY_MULT: 1.5, COOP_BOSS_HP_MULT: 1.5, COOP_FRIENDLY_FIRE: false });
  });

  test.skipIf(todo)('K6: an enemy targets the nearest standing player', () => {
    const [p1, p2] = twoUp();
    place(p1, 0, 0); place(p2, 800, 0);
    const a = walker(100, 0), b = walker(700, 0);
    a.x += p1.x; a.y += p1.y; b.x += p1.x; b.y += p1.y;
    seconds(1.2);
    expect(a.target).toBe(p1);
    expect(b.target).toBe(p2);
  });

  test.skipIf(todo)('K6: hysteresis: no switch when the other player is 20% closer; a switch at 30%; at most one re-pick per 1 s', () => {
    const [p1, p2] = twoUp();
    const h = findHome();
    place(p1, 0, 0); place(p2, 0, 2000);
    const e = walker(h.x + 400, h.y);
    seconds(1.2);
    expect(e.target).toBe(p1);
    const d1 = Math.hypot(e.x - p1.x, e.y - p1.y);
    // P2 at 0.8 x d1 from the enemy (20% closer): stays on P1
    p2.x = e.x; p2.y = e.y + 0.8 * d1;
    seconds(2.5);
    expect(e.target, '20% closer: no switch').toBe(p1);
    // 0.7 x d1 (30% closer): switches within one re-pick period
    p2.y = e.y + 0.7 * d1;
    seconds(1.05);
    expect(e.target, '30% closer: switch').toBe(p2);
    // swap immediately: P1 now much closer, but no re-pick for 1 s after the switch
    const t0 = g.gameTime;
    p1.x = e.x; p1.y = e.y - 0.3 * d1;
    p2.y = e.y + 2 * d1;
    const switchedAt = [];
    let cur = e.target;
    while (g.gameTime - t0 < 2) {
      frame();
      if (e.target !== cur) { switchedAt.push(g.gameTime - t0); cur = e.target; }
    }
    expect(switchedAt.length).toBe(1);
    expect(switchedAt[0]).toBeGreaterThan(0.0);
    expect(switchedAt[0]).toBeLessThanOrEqual(1 + DT);
  });

  test.skipIf(todo)('K6: 2P wave size is ceil(1P size x 1.5); boss HP x 1.5', () => {
    twoUp();
    for (let w = 1; w <= 8; w++) {
      g.enemies.length = 0;
      g.wave = w - 1; g.waveActive = false; g.waveTimer = 0;
      g.updateWaves(DT);
      expect(g.enemiesThisWave, `wave ${w}`).toBe(Math.min(Math.ceil((5 + w * 2 + Math.floor(w * 0.5)) * 1.5), C().MAX_ENEMIES));
    }
    for (let i = 1; i < g.WEAPONS.length; i++) {
      g.enemies.length = 0;
      g.spawnBoss(i);
      expect(g.enemies.find((e) => e.isBoss).maxHp, `boss ${i}`).toBe((300 + i * 250) * 1.5);
    }
  });

  test.skipIf(todo)('K6: friendly fire off: P1\'s bullets pass through P2; P1\'s explosion does not hurt or push P2', () => {
    const [p1, p2] = twoUp();
    place(p1, 0, 0); place(p2, 120, 0);
    p2.invincible = 0; p2.shield = 0;
    const hp = p2.hp;
    const e = dummy(p1.x + 300, p1.y);
    shot(p1.x + 20, p1.y, 900, 0, { by: 0 });
    seconds(0.5);
    expect(p2.hp, 'bullet passed through P2').toBe(hp);
    expect(e.hp, 'and reached the enemy').toBeLessThan(1e9);
    const at = { x: p2.x, y: p2.y };
    g.spawnExplosion(p2.x + 10, p2.y, 130, true, g.SRC_EXPLOSIVE, 0);
    frame(10);
    expect(p2.hp, 'no explosion damage').toBe(hp);
    expect(Math.hypot(p2.x - at.x, p2.y - at.y), 'no knockback').toBeLessThan(1);
  });

  test.skipIf(todo)('K6/F-series: the flamethrower never ignites a player', () => {
    const [p1, p2] = twoUp();
    place(p1, 0, 0); place(p2, 80, 0);
    const flame = g.WEAPONS.findIndex((w) => w.name === 'Flamethrower');
    g.unlockedWeapons = g.WEAPONS.length;
    p1.weapon = flame; p1.magAmmo = g.WEAPONS[flame].mag; p1.fireTimer = 0;
    p1.aimAngle = 0;
    g.mouseDown = true;
    seconds(1);
    g.mouseDown = false;
    expect(p2.burnT || 0).toBe(0);
    expect(p1.burnT || 0).toBe(0);
  });

  test.skipIf(todo)('K6: kills and score go to the shooter; global score is the team total; combo is per player', () => {
    const [p1, p2] = twoUp();
    place(p1, 0, 0); place(p2, 0, 400);
    const s0 = g.score;
    const e = dummy(p2.x + 60, p2.y, { hp: 1 });
    shot(p2.x + 20, p2.y, 900, 0, { by: 1 });
    seconds(0.3);
    expect(g.enemies.includes(e)).toBe(false);
    expect(p2.kills).toBe(1);
    expect(p1.kills || 0).toBe(0);
    expect(p2.score).toBeGreaterThan(0);
    expect(g.score - s0).toBe(p2.score);
    expect(p2.combo).toBe(1);
    expect(p1.combo || 0).toBe(0);
  });

  test.skipIf(todo)('K6: unlocks use the team total: two scores each below a threshold that add up to it spawn its boss', () => {
    const [p1, p2] = twoUp();
    g.unlockedWeapons = 1; g.bossActive = false;
    const need = g.WEAPONS[1].unlock;
    p1.score = Math.ceil(need * 0.6); p2.score = need - p1.score;
    g.score = p1.score + p2.score;
    g.checkWeaponUnlocks();
    expect([g.bossActive, g.bossTarget]).toEqual([true, 1]);
  });

  test.skipIf(todo)('K6: both players get the unlocks', () => {
    const [p1, p2] = twoUp();
    g.unlockedWeapons = 3;
    p2.weapon = 0;
    rig.btn(0, BTN.RB, true); frame(); rig.btn(0, BTN.RB, false); frame();
    rig.btn(0, BTN.RB, true); frame(); rig.btn(0, BTN.RB, false); frame();
    expect(p2.weapon, 'P2 (pad 0 here) cycles into the unlocked weapons').toBe(2);
    expect(p1.weapon, 'P1 untouched').toBe(0);
  });

  test.skipIf(todo)('K6: pickups: whoever touches one first gets it', () => {
    const [p1, p2] = twoUp();
    place(p1, 0, 0); place(p2, 400, 0);
    p1.hp = 50; p2.hp = 50;
    g.pickups.push({ x: p2.x, y: p2.y, type: 'health', amount: 25, life: 30 });
    frame(2);
    expect(p2.hp).toBe(75);
    expect(p1.hp).toBe(50);
  });

  test.skipIf(todo)('K6: enemy rounds hit whichever player they reach', () => {
    const [p1, p2] = twoUp();
    place(p1, 0, 0); place(p2, 0, 500);
    p2.invincible = 0; p2.shield = 0;
    const hp1 = p1.hp, hp2 = p2.hp;
    shot(p2.x - 60, p2.y, 600, 0, { dmg: 10, owner: 'enemy' });
    seconds(0.3);
    expect(p2.hp).toBeLessThan(hp2);
    expect(p1.hp).toBe(hp1);
  });
});
