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
  zoom: () => g.camZoom(), // { zoom, target, forced }
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
  // main.js's one-line private state (e.g. K3's _camMid) that the extracted functions use
  const priv = [...MAIN_SRC.matchAll(/^(?:const|let) (_\w+ = [^\n]*;)$/gm)].map((m) => `var ${m[1]}`).join('\n');
  run(`${priv}
${mainFunction('updateCamera')}
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
    expect(p2.hp, 'full HP: maxHp (spec 496fd74)').toBe(p2.maxHp);
    expect(p2.weapon).toBe(3);
    expect(p2.magAmmo).toBe(g.WEAPONS[3].mag);
    expect(p2.grenades).toBe(fresh.grenades);
    expect(p2).not.toBe(p1);
    expect(p1.hp, 'P1 untouched (bar regen)').toBeCloseTo(40, 0);
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
    frame();
    const a = { x: p1.x, y: p1.y }, b = { x: p2.x, y: p2.y }, aim1 = { ...H.aimOf(0) };
    rig.axes(1, 1, 0, 0, 1); frame(30);
    expect(Math.hypot(p2.x - b.x, p2.y - b.y), 'P2 moved').toBeGreaterThan(20);
    expect(Math.hypot(p1.x - a.x, p1.y - a.y), 'P1 did not').toBeLessThan(1);
    expect(H.padOf(1).lmag).toBeGreaterThan(0);
    expect(H.padOf(0).lmag).toBe(0);
    expect(H.aimOf(1).has).toBe(true);
    expect({ ...H.aimOf(0) }, 'P1 aim untouched by pad 1').toEqual(aim1);
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
    frame();
    const aim1 = { ...H.aimOf(0) };
    rig.axes(1, 0, 0, 1, 0); frame(3); // P2 aims screen-right with the right stick
    const d = H.aimOf(1), off = 4.3 * Math.PI / 180;
    const e = dummy(p2.x + (d.dirX * Math.cos(off) - d.dirY * Math.sin(off)) * 250, p2.y + (d.dirX * Math.sin(off) + d.dirY * Math.cos(off)) * 250);
    g.unlockedWeapons = 1; p2.weapon = 0; p2.fireTimer = 0; p2.magAmmo = g.WEAPONS[0].mag; p2.reloading = false;
    g.bullets.length = 0;
    rig.btn(1, BTN.RT, 1); frame(2); rig.btn(1, BTN.RT, 0); frame();
    const b = g.bullets.find((q) => q.owner === 'player' && q.by === 1);
    const want = Math.atan2(e.y - p2.y, e.x - p2.x), got = Math.atan2(b.vy, b.vx);
    expect(Math.abs(Math.atan2(Math.sin(got - want), Math.cos(got - want))), 'assisted onto the enemy (within pistol spread)').toBeLessThan(g.WEAPONS[0].spread + 0.01);
    expect({ ...H.aimOf(0) }, 'P1 aim untouched').toEqual(aim1);
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
    expect(g.padState().disconnectWho, 'the overlay names P2 (pixi-hud.js: "P2 CONTROLLER DISCONNECTED")').toBe(2);
    expect(H.players()).toContain(p2);
  });
});

// =====================================================================
// K2.1 device edge cases (Ralph's K2+K3 review, Josh's K2.1 fixes)
// =====================================================================
describe('M11 K2.1 device edge cases', () => {
  beforeEach(setup);
  const todo = !LANDED.K2 || !LANDED.K2_1;
  const pads = () => H.state().devices.map((d) => d.pad);

  test.skipIf(todo)('K2.1: both pads drop, pad 0 returns first and P1 presses Start: pad 0 is P1\'s again, P2 re-claims pad 1, no swap', () => {
    twoPads();
    rig.disconnect(0); frame(); rig.disconnect(1); frame();
    expect(g.paused).toBe(true);
    rig.connect(0); frame(3);
    expect(g.paused, 'a pad coming back alone does not resume').toBe(true);
    tap(0, BTN.START);
    expect(pads()[0], 'pad 0 is P1\'s again').toBe(0);
    expect(pads()[1], 'P2 did not take pad 0').not.toBe(0);
    rig.connect(1); frame(3);
    tap(1, BTN.START);
    expect(pads(), 'no swap').toEqual([0, 1]);
  });

  test.skipIf(todo)('K2.1: the disconnect pause clears only when the dropped pad\'s owner re-claims it', () => {
    twoPads();
    rig.disconnect(1); frame();
    expect(g.paused).toBe(true);
    tap(0, BTN.START);
    expect(g.paused, 'Start on P1\'s pad does not clear P2\'s disconnect pause').toBe(true);
    expect(pads()[0]).toBe(0);
    rig.connect(1); frame(3);
    expect(g.paused, 'reconnecting alone does not resume').toBe(true);
    tap(1, BTN.START);
    expect(g.paused, 'P2 re-claims its pad: resumed').toBe(false);
    expect(pads()).toEqual([0, 1]);
  });

  test.skipIf(todo)('K2.1: the same in reverse: P1\'s disconnect pause is not cleared by P2\'s Start, only by P1 re-claiming pad 0', () => {
    twoPads();
    rig.disconnect(0); frame();
    expect(g.paused).toBe(true);
    tap(1, BTN.START);
    expect(g.paused, 'Start on P2\'s pad does not clear P1\'s disconnect pause').toBe(true);
    expect(pads()[1]).toBe(1);
    rig.connect(0); frame(3);
    expect(g.paused, 'reconnecting alone does not resume').toBe(true);
    tap(0, BTN.START);
    expect(g.paused, 'P1 re-claims pad 0: resumed').toBe(false);
    expect(pads()).toEqual([0, 1]);
  });

  test.skipIf(todo)('K2.1: a View press refused while paused does not burn the lone-pad join; after unpausing, View joins P2', () => {
    rig.connect(0); frame();
    g.paused = true; // paused from the keyboard (P)
    tap(0, BTN.BACK);
    expect(H.players().length, 'no join while paused').toBe(1);
    g.paused = false; frame();
    tap(0, BTN.BACK);
    expect(H.players().length, 'View joins P2 after unpausing').toBe(2);
    expect(H.state().devices[1].pad).toBe(0);
  });

  test.skipIf(todo)('K2.1: navigator.getGamepads() is called once per frame (1P, 2P, paused)', () => {
    rig.connect(0); frame();
    let c0 = rig.getGamepadsCalls;
    frame(10);
    expect(rig.getGamepadsCalls - c0, '1P').toBe(10);
    setup();
    twoPads();
    c0 = rig.getGamepadsCalls;
    frame(10);
    expect(rig.getGamepadsCalls - c0, '2P').toBe(10);
    g.paused = true;
    c0 = rig.getGamepadsCalls;
    frame(10);
    expect(rig.getGamepadsCalls - c0, 'paused').toBe(10);
  });
});

// =====================================================================
// K2.2 (Ralph's review of 36c8ebd): more device edge cases, down-state input
// =====================================================================
describe('M11 K2.2 review fixes', () => {
  beforeEach(setup);
  const todo = !LANDED.K2_2;
  const pads = () => H.state().devices.map((d) => d.pad);

  test.skipIf(todo)('K2.2: pause, hold View 4+ frames, unpause, tap View: P2 joins (a held View while paused does not mark the pad as P1\'s)', () => {
    rig.connect(0); frame();
    g.paused = true;
    rig.btn(0, BTN.BACK, true); frame(6);
    rig.btn(0, BTN.BACK, false); frame();
    expect(H.players().length, 'no join while paused').toBe(1);
    g.paused = false; frame();
    expect(g.padUsedByP1(), 'the paused View hold did not claim the pad for P1').toBe(false);
    tap(0, BTN.BACK);
    expect(H.players().length, 'View joins P2').toBe(2);
  });

  test.skipIf(todo)('K2.2: a downed P1 pressing B and then revived throws no grenade', () => {
    const [p1, p2] = twoPads();
    place(p1, 0, 0); place(p2, 300, 0);
    p1.invincible = 0; p1.shield = 0; p1.dodging = false;
    H.damage(p1.hp + 50, p1);
    expect(p1.state).toBe('down');
    const g0 = p1.grenades;
    g.grenades.length = 0;
    tap(0, BTN.B); tap(0, BTN.B);
    frame(10);
    place(p2, 30, 0); // partner within revive range
    seconds(1.7);
    expect(p1.state, 'revived').toBe('up');
    frame(30);
    expect(g.grenades.length, 'no grenade in flight after the revive').toBe(0);
    expect(p1.grenades, 'none spent').toBe(g0);
  });

  test.skipIf(todo)('K2.2: chained disconnect pauses: both pads drop, P1 re-claims while P2\'s pad is missing, and P2\'s pause shows at once', () => {
    twoPads();
    rig.disconnect(0); frame(); rig.disconnect(1); frame();
    expect(g.paused).toBe(true);
    rig.connect(0); frame(3);
    tap(0, BTN.START); // P1 re-claims pad 0
    frame(2);
    expect(pads()[0]).toBe(0);
    expect(g.paused, 'still paused').toBe(true);
    expect(g.padState(), 'now for P2').toMatchObject({ disconnectPaused: true, disconnectWho: 2 });
    rig.connect(1); frame(3);
    tap(1, BTN.START); // P2 re-claims pad 1
    expect(g.padState().disconnectPaused, 'no pause left').toBe(false);
    expect(g.paused).toBe(false);
    expect(pads()).toEqual([0, 1]);
  });

  test.skipIf(todo)('K2.2: both pads drop, P2\'s returns first (slot 0), then P1\'s (slot 1): each player re-claims their own pad by id', () => {
    rig.connect(0, { id: 'Mock Pad A (P1)' }); rig.connect(1, { id: 'Mock Pad B (P2)' });
    frame();
    rig.axes(0, 0.6, 0); frame(3); rig.axes(0, 0, 0); frame(); // P1 uses pad A
    tap(1, BTN.START);
    expect(pads()).toEqual([0, 1]);
    rig.disconnect(0); frame(); rig.disconnect(1); frame();
    expect(g.paused).toBe(true);
    // the browser hands out the lowest free slot: P2's pad B comes back as slot 0, P1's A as slot 1
    rig.connect(0, { id: 'Mock Pad B (P2)' }); frame(3);
    rig.connect(1, { id: 'Mock Pad A (P1)' }); frame(3);
    tap(0, BTN.START); // P2 on pad B
    tap(1, BTN.START); // P1 on pad A
    const ids = pads().map((i) => (i === null ? null : rig.pads[i].id));
    expect(ids, 'each player is back on their own pad').toEqual(['Mock Pad A (P1)', 'Mock Pad B (P2)']);
    // the pause clears when its owner re-claims (spec); a later Start may then toggle a normal pause
    expect(g.padState().disconnectPaused, 'no disconnect pause left once both re-claimed').toBe(false);
  });
});

// =====================================================================
// K2.3 (Ralph's review of c7c13c6): identical pad ids, demo exit from a pad, stale pauses
// =====================================================================
describe('M11 K2.3 review fixes', () => {
  beforeEach(setup);
  const todo = !LANDED.K2_3;
  const pads = () => H.state().devices.map((d) => d.pad);
  // the rig's pads all share the default Xbox id unless one is given: identical ids throughout

  test.skipIf(todo)('K2.3: identical ids: P1\'s pad drops and P1 re-claims it; a second pad with the same id then joins P2 on Start', () => {
    rig.connect(0); frame();
    rig.axes(0, 0.6, 0); frame(3); rig.axes(0, 0, 0); frame();
    expect(g.inputDevice).toBe('pad');
    rig.disconnect(0); frame();
    expect(g.padState().disconnectPaused).toBe(true);
    rig.connect(0); frame(2);
    tap(0, BTN.START);
    expect(g.paused, 'P1 re-claimed').toBe(false);
    rig.connect(1); frame();
    tap(1, BTN.START);
    expect(H.players().length, 'P2 joins on the same-id pad').toBe(2);
    expect(pads()).toEqual([0, 1]);
  });

  test.skipIf(todo)('K2.3: identical ids: a stale owner id never hands P2\'s returning pad to P1', () => {
    twoPads();
    rig.disconnect(0); frame(); rig.connect(0); frame(2); tap(0, BTN.START); // P1's loss resolved
    expect(pads()).toEqual([0, 1]);
    rig.disconnect(1); frame();
    expect(g.padState()).toMatchObject({ disconnectPaused: true, disconnectWho: 2 });
    rig.connect(1); frame(3);
    expect(pads()[0], 'P1 keeps pad 0; it did not take the returning pad').toBe(0);
    tap(1, BTN.START);
    expect(pads(), 'P2 re-claims it').toEqual([0, 1]);
    expect(g.paused).toBe(false);
  });

  test.skipIf(todo)('K2.3/D6: a title pad that reserved P2 with View can end a 2P demo with A or a stick', () => {
    game.run('if (typeof _demoShowOverlay === "function") _demoShowOverlay = function () {}; if (typeof _demoSetStartScreen === "function") _demoSetStartScreen = function () {};');
    for (const input of ['A', 'stick']) {
      g.gameStarted = false;
      if (!rig.pads[0]) rig.connect(0);
      titleFrame(2);
      tap(0, BTN.BACK, titleFrame);
      expect(H.state().titleCount, `${input}: P2 reserved on the title`).toBe(2);
      expect(g.startDemo({ coop: true })).toBe(true);
      const step = () => { rig.clock.ms += DT * 1000; g.pollGamepad(); if (g.demoState().active) { g.updateDemo(DT); update(DT); } };
      for (let i = 0; i < 30; i++) step();
      expect(g.demoState().active).toBe(true);
      if (input === 'A') rig.btn(0, BTN.A, true); else rig.axes(0, 0, 0.7);
      step(); step();
      expect(g.demoState().active, `${input} on the reserving pad ends the demo`).toBe(false);
      expect(g.gameStarted, `${input}: back on the title, no game started (D6)`).toBe(false);
      rig.release(0); titleFrame(3);
    }
  });

  test.skipIf(todo)('K2.3: P1 paused with Start, P1\'s pad drops, P1 resumes from the keyboard; a later P2 drop and re-claim leaves no P1 pause behind', () => {
    twoPads();
    tap(0, BTN.START);
    expect(g.paused).toBe(true);
    rig.disconnect(0); frame();
    g.padNoteKey(); g.paused = false; // P on the keyboard: P1 plays on kbm from here
    frame(5);
    rig.disconnect(1); frame();
    expect(g.padState().disconnectWho).toBe(2);
    rig.connect(1); frame();
    tap(1, BTN.START); frame(3);
    expect({ paused: g.paused, dc: g.padState().disconnectPaused, who: g.padState().disconnectWho },
      'no "P1 CONTROLLER DISCONNECTED" chained after P2 re-claims').toEqual({ paused: false, dc: false, who: 0 });
  });

  test.skipIf(todo)('K2.3: in P1\'s disconnect pause with P2 dead and padless, a Start held on an unknown pad resumes once and does not pause again while held', () => {
    const [, p2] = twoPads();
    rig.disconnect(0); frame();
    expect(g.padState().disconnectWho).toBe(1);
    rig.disconnect(1); frame();
    p2.state = 'dead';
    rig.connect(0); frame(2);
    rig.btn(0, BTN.START, true);
    const seen = [];
    for (let i = 0; i < 12; i++) { frame(); seen.push(g.paused); }
    expect(seen.slice(2), 'resumed, and no manual pause while Start is still held').toEqual(seen.slice(2).map(() => false));
    rig.btn(0, BTN.START, false); frame(3);
    expect(g.paused, 'still running after the release').toBe(false);
    tap(0, BTN.START);
    expect(g.paused, 'a fresh Start press afterwards does pause').toBe(true);
  });
});

// =====================================================================
// K2.4 (Ralph's verification of d120401): 1P regressions N1-N3
// =====================================================================
describe('M11 K2.4 1P regressions', () => {
  beforeEach(setup);
  const todo = !LANDED.K2_4;
  const pads = () => H.state().devices.map((d) => d.pad);
  const quietDemo = () => game.run('if (typeof _demoShowOverlay === "function") _demoShowOverlay = function () {}; if (typeof _demoSetStartScreen === "function") _demoSetStartScreen = function () {};');
  const demoStep = (n = 1) => { for (let i = 0; i < n; i++) { rig.clock.ms += DT * 1000; g.pollGamepad(); if (g.demoState().active) g.updateDemo(DT); } };

  for (const b of ['A', 'START']) {
    test.skipIf(todo)(`K2.4 N1 (D6): ${b} on P1's pad during a 1P demo returns to the title without starting a game`, () => {
      quietDemo();
      g.gameStarted = false;
      rig.connect(0); titleFrame(3);
      expect(g.startDemo()).toBe(true);
      demoStep(5);
      rig.btn(0, BTN[b], true); demoStep(2);
      expect(g.demoState().active, 'the demo ended').toBe(false);
      expect({ started, gameStarted: g.gameStarted }, 'no game started (D6)').toEqual({ started: 0, gameStarted: false });
      rig.btn(0, BTN[b], false); titleFrame(3);
      expect(started, 'the release does not start one either').toBe(0);
    });
  }

  test.skipIf(todo)('K2.4 N1 (D6): Start on a free second pad during a demo ends it; no P2 is reserved, nothing starts', () => {
    quietDemo();
    g.gameStarted = false;
    rig.connect(0); rig.connect(1); titleFrame(3);
    expect(g.startDemo()).toBe(true);
    demoStep(5);
    rig.btn(1, BTN.START, true); demoStep(2);
    expect(g.demoState().active).toBe(false);
    expect(H.state().pendingPad, 'no P2 reserved by the demo-exit press').toBe(null);
    expect(started).toBe(0);
    rig.btn(1, BTN.START, false); titleFrame(3);
    expect(started).toBe(0);
  });

  test.skipIf(todo)('K2.4 N2 (M10): on the title, a brand-new pad whose very first press is A starts the game on that press', () => {
    g.gameStarted = false;
    titleFrame(2);
    // Chrome only reveals a pad on its first press: it appears with A already down
    rig.connect(0); rig.btn(0, BTN.A, true);
    titleFrame(1);
    expect(started, 'the revealing A press starts the game').toBe(1);
    rig.btn(0, BTN.A, false); titleFrame(2);
    expect(started, 'once').toBe(1);
  });

  test.skipIf(todo)('K2.4 N3: P1\'s pad drops from slot 0 and is re-claimed at slot 2; a new pad on slot 0 then joins P2 with Start', () => {
    rig.connect(0); frame();
    rig.axes(0, 0.6, 0); frame(3); rig.axes(0, 0, 0); frame();
    rig.disconnect(0); frame();
    expect(g.padState().disconnectPaused).toBe(true);
    rig.connect(2); frame(2);
    tap(2, BTN.START);
    expect(g.paused, 'P1 re-claimed on slot 2').toBe(false);
    expect(pads()[0]).toBe(2);
    rig.connect(0); frame();
    tap(0, BTN.START);
    expect(H.players().length, 'P2 joins on slot 0').toBe(2);
    expect(pads()).toEqual([2, 0]);
  });
});

// =====================================================================
// K3 shared camera, K3a zoom, K3b leash
// =====================================================================
describe('M11 K3 camera, zoom and leash', () => {
  beforeEach(setup);
  const todo = !LANDED.K3;
  /** 2P via coopJoin (no join press): enough for the camera and zoom, which read players[]. P2's
   * pad must be plugged in, or the next poll auto-pauses for it (K2/C6). */
  const twoUp = () => {
    rig.connect(1); frame();
    const p2 = H.join(1);
    if (!p2) throw new Error('coopJoin returned null');
    const [p1] = H.players();
    p1.invincible = p2.invincible = 1e9;
    return [p1, p2];
  };
  /** Low-res px of a world offset's screen projection at zoom 1. */
  const lowRes = (dx, dy) => { const s = g.toScreen(dx, dy), ps = g.RETRO.PIXEL_SCALE; return { x: s.x / ps, y: s.y / ps }; };
  /** The leash limit: at COOP_ZOOM_MIN, both players >= COOP_LEASH_PX inside the view edges. */
  const leashOk = (a, b, slack = 0.01) => {
    const v = viewLowRes(), z = C().COOP_ZOOM_MIN, m = C().COOP_LEASH_PX, d = lowRes(a.x - b.x, a.y - b.y);
    return Math.abs(d.x) * z <= v.w - 2 * m + slack && Math.abs(d.y) * z <= v.h - 2 * m + slack;
  };
  // Separations below are screen-x, in low-res px at zoom 1 (what screenRight() takes).
  /** The separation at the leash limit. */
  const limitLow = () => (viewLowRes().w - 2 * C().COOP_LEASH_PX) / C().COOP_ZOOM_MIN;
  /** A fraction of the view width. */
  const lowW = (f) => viewLowRes().w * f;

  test.skipIf(todo)('K3a: CFG defaults (spec K3a/K3b; rates are linear, in zoom units per second)', () => {
    expect(C()).toMatchObject({ COOP_ZOOM_MIN: 0.6, COOP_ZOOM_MARGIN: 64, COOP_ZOOM_OUT_RATE: 3, COOP_ZOOM_IN_RATE: 1, COOP_ZOOM_DEADBAND: 0.05, COOP_LEASH_PX: 48 });
  });

  test.skipIf(todo)('K3a: coopZoomTarget (pure) is 1 for fewer than 2 points and for players close together', () => {
    const v = viewLowRes(), h = findHome();
    expect(g.coopZoomTarget([], v.w, v.h)).toBe(1);
    expect(g.coopZoomTarget([{ x: h.x, y: h.y }], v.w, v.h)).toBe(1);
    expect(g.coopZoomTarget([{ x: h.x, y: h.y }, { x: h.x + 60, y: h.y }], v.w, v.h)).toBe(1);
  });

  test.skipIf(todo)('K3a: coopZoomTarget (pure) is the largest zoom <= 1 keeping 64 low-res px margins, on screen x and y, at PIXEL_SCALE 3 and 1', () => {
    const h = findHome();
    for (const ps of [3, 1]) {
      g.RETRO.PIXEL_SCALE = ps;
      const v = viewLowRes();
      for (const frac of [0.5, 0.8, 0.95]) {
        const r = screenRight(((v.w - 128) / 0.6) * frac);
        const pts = [{ x: h.x, y: h.y }, { x: h.x + r.dx, y: h.y + r.dy }];
        expect(g.coopZoomTarget(pts, v.w, v.h), `x${ps} screen-x ${frac}`).toBeCloseTo(expectedZoom(pts), 6);
      }
      const d = (((v.h - 128) / 0.6) * 0.8 * ps) / (2 * C().ISO_SCALE); // world +x+y runs down the screen
      const pts = [{ x: h.x, y: h.y }, { x: h.x + d, y: h.y + d }];
      expect(g.coopZoomTarget(pts, v.w, v.h), `x${ps} screen-y`).toBeCloseTo(expectedZoom(pts), 6);
      expect(g.coopZoomTarget(pts, v.w, v.h)).toBeLessThan(1);
    }
  });

  test.skipIf(todo)('K3a: coopZoomTarget (pure) is clamped at 0.6 however far apart', () => {
    const v = viewLowRes(), h = findHome(), r = screenRight(lowW(3));
    expect(g.coopZoomTarget([{ x: h.x, y: h.y }, { x: h.x + r.dx, y: h.y + r.dy }], v.w, v.h)).toBe(0.6);
  });

  test.skipIf(todo)('K3: the camera target is the midpoint of the counted players', () => {
    const [p1, p2] = twoUp();
    place(p1, 0, 0); place(p2, 120, 40);
    frame();
    const s = g.toScreen((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
    expect(g.cam.tx).toBeCloseTo(s.x, 6);
    expect(g.cam.ty).toBeCloseTo(s.y, 6);
  });

  test.skipIf(todo)('K3a: players close together: zoom is exactly 1.0', () => {
    const [p1, p2] = twoUp();
    place(p1, 0, 0); place(p2, 60, 0);
    frame(60);
    expect(H.zoom()).toMatchObject({ zoom: 1, target: 1 });
  });

  test.skipIf(todo)('K3a: camZoom().target is the K3a target of the players, live', () => {
    const [p1, p2] = twoUp();
    const r = screenRight(lowW(0.9));
    place(p1, 0, 0); place(p2, r.dx, r.dy);
    frame();
    expect(H.zoom().target).toBeCloseTo(expectedZoom([p1, p2]), 6);
    expect(H.zoom().target).toBeLessThan(1);
  });

  test.skipIf(todo)('K3a: zooming out is linear at COOP_ZOOM_OUT_RATE (3/s) down to the target, never past it', () => {
    const [p1, p2] = twoUp();
    const r = screenRight(lowW(1.4));
    place(p1, 0, 0); place(p2, r.dx, r.dy);
    frame();
    const target = H.zoom().target;
    expect(target).toBeLessThan(0.9);
    let prev = H.zoom().zoom;
    for (let i = 0; i < 60; i++) {
      frame();
      const z = H.zoom().zoom;
      expect(prev - z, `frame ${i}: step`).toBeCloseTo(Math.min(C().COOP_ZOOM_OUT_RATE * DT, prev - target), 6);
      expect(z).toBeGreaterThanOrEqual(target - 1e-9);
      prev = z;
    }
    expect(prev).toBeCloseTo(target, 6);
  });

  test.skipIf(todo)('K3a: zoom-in deadband: held while the target is < 5% above the zoom; at >= 5% it zooms in linearly at COOP_ZOOM_IN_RATE (1/s)', () => {
    const [p1, p2] = twoUp();
    const v = viewLowRes();
    const sepFor = (z) => (v.w - 128) / z; // the separation whose fit is exactly z
    const sep = (low) => { const r = screenRight(low); place(p1, 0, 0); place(p2, r.dx, r.dy); };
    sep(sepFor(0.7)); seconds(1);
    const z0 = H.zoom().zoom;
    expect(z0).toBeCloseTo(0.7, 6);
    sep(sepFor(z0 * 1.04)); seconds(3);
    expect(H.zoom().target).toBeCloseTo(z0 * 1.04, 6);
    expect(H.zoom().zoom, 'target 4% above: held').toBe(z0);
    sep(sepFor(z0 * 1.06));
    const prev = H.zoom().zoom;
    frame();
    expect(H.zoom().zoom - prev, 'one frame of zoom-in').toBeCloseTo(C().COOP_ZOOM_IN_RATE * DT, 6);
    seconds(1);
    expect(H.zoom().zoom).toBeCloseTo(z0 * 1.06, 6);
  });

  test.skipIf(todo)('K3a: back together the zoom returns to exactly 1.0, also from inside the deadband of 1', () => {
    const [p1, p2] = twoUp();
    const near = screenRight((viewLowRes().w - 128) / 0.97); // fit 0.97: within 5% of 1
    place(p1, 0, 0); place(p2, near.dx, near.dy); seconds(1);
    expect(H.zoom().zoom).toBeCloseTo(0.97, 6);
    place(p2, 40, 0); seconds(1);
    expect(H.zoom()).toMatchObject({ zoom: 1, target: 1 });
    const far = screenRight(lowW(3));
    place(p2, far.dx, far.dy); seconds(1);
    expect(H.zoom().zoom).toBe(C().COOP_ZOOM_MIN);
    place(p2, 40, 0); seconds(1);
    expect(H.zoom()).toMatchObject({ zoom: 1, target: 1 });
  });

  test.skipIf(todo)('K3a: setCamZoom holds a clamped zoom (forced); NaN is ignored; null hands it back', () => {
    const [p1, p2] = twoUp();
    place(p1, 0, 0); place(p2, 40, 0);
    H.setZoom(0.7); frame(30);
    expect(H.zoom()).toMatchObject({ zoom: 0.7, forced: true });
    H.setZoom(NaN); frame();
    expect(H.zoom().zoom).toBe(0.7);
    H.setZoom(0.2); frame();
    expect(H.zoom().zoom).toBe(0.6);
    H.setZoom(5); frame();
    expect(H.zoom().zoom).toBe(1);
    H.setZoom(0.7); frame();
    H.setZoom(null); seconds(1);
    expect(H.zoom()).toMatchObject({ zoom: 1, forced: false });
  });

  test.skipIf(todo)('K3a: dead players do not count for the midpoint or the zoom; downed players do', () => {
    const [p1, p2] = twoUp();
    const r = screenRight(lowW(1));
    place(p1, 0, 0); place(p2, r.dx, r.dy);
    p2.state = 'dead'; frame();
    const s1 = g.toScreen(p1.x, p1.y);
    expect([g.cam.tx, g.cam.ty]).toEqual([s1.x, s1.y]);
    expect(H.zoom().target).toBe(1);
    p2.state = 'down'; p2.hp = 0; p2.downT = C().COOP_DOWN_TIME ?? 8; frame(); // a real DOWN (K5 bleeds out a player with no downT)
    expect(H.zoom().target).toBeLessThan(1);
  });

  test.skipIf(todo)('K3a: in 1P worldToView/viewToWorld equal toScreen + worldOffset and invert each other', () => {
    g.worldOffsetX = 640; g.worldOffsetY = 360;
    const h = findHome();
    const v = g.worldToView(h.x + 50, h.y - 20), s = g.toScreen(h.x + 50, h.y - 20);
    expect(v.x).toBeCloseTo(s.x + g.worldOffsetX, 6);
    expect(v.y).toBeCloseTo(s.y + g.worldOffsetY, 6);
    const w = g.viewToWorld(v.x, v.y);
    expect(w.x).toBeCloseTo(h.x + 50, 6);
    expect(w.y).toBeCloseTo(h.y - 20, 6);
  });

  test.skipIf(todo)('K3b: coopLeashClamp (pure): an outward move is cut at the leash limit; inward and still moves are untouched', () => {
    const v = viewLowRes(), z = C().COOP_ZOOM_MIN, m = C().COOP_LEASH_PX, h = findHome();
    const other = { x: h.x, y: h.y };
    const r0 = screenRight(limitLow() - 10), r1 = screenRight(limitLow() + 30), rin = screenRight(limitLow() - 40);
    const mover = { x: h.x + r0.dx, y: h.y + r0.dy };
    const out = { x: 0, y: 0 };
    g.coopLeashClamp(mover, other, h.x + r1.dx, h.y + r1.dy, out);
    expect(leashOk(out, other), 'clamped inside the limit').toBe(true);
    expect(Math.abs(Math.abs(lowRes(out.x - other.x, out.y - other.y).x) * z - (v.w - 2 * m)), 'cut at the limit').toBeLessThan(0.5);
    g.coopLeashClamp(mover, other, h.x + rin.dx, h.y + rin.dy, out);
    expect([out.x, out.y], 'inward: untouched').toEqual([h.x + rin.dx, h.y + rin.dy]);
    g.coopLeashClamp(mover, other, mover.x, mover.y, out);
    expect([out.x, out.y], 'still: untouched').toEqual([mover.x, mover.y]);
  });

  test.skipIf(todo)('K3b: coopLeashClamp (pure): a player knocked past the leash is not yanked back; outward is cut, inward is free', () => {
    const h = findHome();
    const other = { x: h.x, y: h.y };
    const rk = screenRight(limitLow() + 100), rOut = screenRight(limitLow() + 120), rIn = screenRight(limitLow() + 80);
    const mover = { x: h.x + rk.dx, y: h.y + rk.dy };
    const out = { x: 0, y: 0 };
    const sep = (q) => Math.abs(lowRes(q.x - other.x, q.y - other.y).x);
    g.coopLeashClamp(mover, other, mover.x, mover.y, out);
    expect([out.x, out.y], 'standing still past the leash: stays').toEqual([mover.x, mover.y]);
    g.coopLeashClamp(mover, other, h.x + rOut.dx, h.y + rOut.dy, out);
    expect(sep(out), 'outward: separation does not grow').toBeLessThanOrEqual(sep(mover) + 1e-6);
    expect(sep(out), 'and is not pulled in either').toBeGreaterThan(sep(mover) - 1);
    g.coopLeashClamp(mover, other, h.x + rIn.dx, h.y + rIn.dy, out);
    expect([out.x, out.y], 'inward: free').toEqual([h.x + rIn.dx, h.y + rIn.dy]);
  });

  test.skipIf(todo)('K3b: coopLeashClamp (pure): a move along the limit keeps its screen-down part', () => {
    const h = findHome();
    const other = { x: h.x, y: h.y };
    const r = screenRight(limitLow() - 1);
    const mover = { x: h.x + r.dx, y: h.y + r.dy };
    const out = { x: 0, y: 0 };
    const down = 20 / (2 * C().ISO_SCALE), rr = screenRight(30); // 20 CSS px screen-down, 30 screen-right
    g.coopLeashClamp(mover, other, mover.x + down + rr.dx, mover.y + down + rr.dy, out);
    expect(leashOk(out, other)).toBe(true);
    expect(g.toScreen(out.x - mover.x, out.y - mover.y).y, 'screen-down part kept').toBeCloseTo(20, 0);
  });

  test.skipIf(todo || !LANDED.K2)('K3b: away from the limit the leash does not cut: moving apart runs at full speed', () => {
    rig.connect(0); frame(); tap(0, BTN.BACK);
    const [p1, p2] = H.players();
    p1.invincible = p2.invincible = 1e9;
    const r = screenRight(lowW(0.6));
    place(p1, 0, 0); place(p2, r.dx, r.dy); seconds(1);
    expect(H.zoom().zoom).toBeGreaterThan(C().COOP_ZOOM_MIN + 0.1);
    const at = { x: p2.x, y: p2.y };
    rig.axes(0, 1, 0); frame(12); rig.axes(0, 0, 0); // P2 (on pad 0 here) runs screen-right for 0.2 s
    expect(Math.hypot(p2.x - at.x, p2.y - at.y), 'not clamped away from the limit').toBeGreaterThan(0.8 * C().PLAYER_SPEED * 0.2);
  });

  test.skipIf(todo || !LANDED.K2)('K3b: at COOP_ZOOM_MIN a runner is held at 48 low-res px inside the view, against the camera target and the drawn view (run, sprint, dodge)', () => {
    for (const mode of ['run', 'sprint', 'dodge']) {
      setup();
      rig.connect(0); frame(); tap(0, BTN.BACK);
      const [p1, p2] = H.players();
      p1.invincible = p2.invincible = 1e9;
      place(p1, 0, 0); place(p2, 40, -40);
      rig.axes(0, 1, 0); // P2 (pad 0 here) runs screen-right for 10 s
      if (mode === 'sprint') { frame(); tap(0, BTN.L3); }
      // Smallest margin of either player's feet to the view edge in low-res px, against the camera
      // target (the midpoint the leash math uses) and the drawn camera (cam.x/y, which eases
      // toward the target). Spec edec532: >= 48 against both on every frame of own moves.
      // (No knockback in this run: knockback is exempt.)
      let atMin = 0, maxSpeed = 0, dodges = 0, wasDodging = false;
      const worst = { target: { m: Infinity }, drawn: { m: Infinity } };
      for (let i = 0; i < 600; i++) {
        if (mode === 'dodge' && i % 40 === 0) { rig.btn(0, BTN.A, true); frame(); rig.btn(0, BTN.A, false); }
        frame();
        maxSpeed = Math.max(maxSpeed, Math.hypot(p2.vx, p2.vy));
        if (p2.dodging && !wasDodging) dodges++;
        wasDodging = !!p2.dodging;
        if (H.zoom().zoom > C().COOP_ZOOM_MIN + 1e-6) continue;
        atMin++;
        const v = viewLowRes(), z = H.zoom().zoom, ps = g.RETRO.PIXEL_SCALE;
        for (const p of [p1, p2]) {
          const s = g.toScreen(p.x, p.y);
          for (const [k, cx, cy] of [['target', g.cam.tx, g.cam.ty], ['drawn', g.cam.x, g.cam.y]]) {
            const m = Math.min(v.w / 2 - Math.abs(((s.x - cx) * z) / ps), v.h / 2 - Math.abs(((s.y - cy) * z) / ps));
            if (m < worst[k].m) worst[k] = { m, frame: i, who: p === p1 ? 'P1' : 'P2' };
          }
        }
      }
      rig.axes(0, 0, 0); frame();
      expect(atMin, `${mode}: frames at max zoom-out`).toBeGreaterThan(100);
      expect(worst.target.m, `${mode}: margin vs the camera target ${JSON.stringify(worst.target)}`).toBeGreaterThanOrEqual(C().COOP_LEASH_PX - 0.01);
      expect(worst.target.m, `${mode}: held at the leash, not short of it`).toBeLessThan(C().COOP_LEASH_PX + 0.5);
      expect(worst.drawn.m, `${mode}: feet vs the drawn view ${JSON.stringify(worst.drawn)}`).toBeGreaterThanOrEqual(C().COOP_LEASH_PX - 0.01);
      if (mode === 'sprint') expect(maxSpeed, 'sprint was on').toBeGreaterThan(C().PLAYER_SPEED * 1.1);
      if (mode === 'dodge') expect(dodges, 'dodged repeatedly').toBeGreaterThanOrEqual(5);
      const d0 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      rig.axes(0, -1, 0); frame(20); rig.axes(0, 0, 0);
      expect(Math.hypot(p2.x - p1.x, p2.y - p1.y), `${mode}: moving back is free`).toBeLessThan(d0 - 20);
    }
  });

  test.skipIf(todo)('K3: shake stays global and capped at SHAKE_MAX, whatever the zoom', () => {
    twoUp();
    H.setZoom(0.6); frame();
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
    expect(p2.hp, '50% of maxHp (plus a frame of regen)').toBeCloseTo(p2.maxHp * 0.5, 0);
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
    expect(p2.hp, 'full HP: maxHp (spec 496fd74)').toBe(p2.maxHp);
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

  test.skipIf(todo)("K6: the shockwave charge is per player: only that player's own kills fill it", () => {
    const [p1, p2] = twoUp();
    place(p1, 0, 0); place(p2, 0, 400);
    p1.specialCharge = 0; p2.specialCharge = 0;
    for (let k = 0; k < 3; k++) {
      dummy(p2.x + 60, p2.y, { hp: 1 });
      shot(p2.x + 20, p2.y, 900, 0, { by: 1 });
      seconds(0.3);
    }
    expect(p2.kills).toBe(3);
    expect(p2.specialCharge, 'P2 kills fill P2').toBe(Math.min(3, C().SPECIAL_MAX_CHARGE));
    expect(p1.specialCharge, 'not P1').toBe(0);
    dummy(p1.x + 60, p1.y, { hp: 1 });
    shot(p1.x + 20, p1.y, 900, 0, { by: 0 });
    seconds(0.3);
    expect(p1.specialCharge, 'P1 kill fills P1').toBe(1);
    expect(p2.specialCharge, 'P2 unchanged').toBe(Math.min(3, C().SPECIAL_MAX_CHARGE));
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
    expect(p2.hp, 'P2 got the +25 (plus a frame of regen)').toBeCloseTo(75, 0);
    expect(p1.hp, 'P1 did not').toBeCloseTo(50, 0);
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
