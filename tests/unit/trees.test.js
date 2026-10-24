import { describe, test, expect, beforeEach } from 'vitest';
import { newRound } from '../helpers/load-game.js';
import { LANDED } from '../milestones.js';

// E13 sustained fire cuts trees down (spec M9 + Ralph's rulings): trunk HP 900/750/300;
// a non-pierce round stopped by a trunk applies its dmg, pierce x0.5; an explosion subtracts
// f x its dmg (RPG 250, grenade 200, BFG 800, others 100) with the E2 thresholds on top;
// enemy rounds damage trunks too, but only a player-caused fall credits the player.
// Skipped until E13 is marked landed in tests/milestones.js.
const todo = !LANDED.E13;
const DT = 1 / 60;
let g, seq = 0;

beforeEach(() => {
  g = newRound().g;
  g.unlockedWeapons = g.WEAPONS.length;
  g.waveActive = false;
  g.waveTimer = 1e9;
  g.envObjects.length = 0;
  g.player.x = 0; g.player.y = 0;
  g.player.invincible = 1e9;
});

const DEFAULTS = { tree: { radius: 40, height: 100, collision: 8 }, pine: { radius: 30, height: 90, collision: 7 }, deadtree: { height: 45 } };
function place(type, x, y) {
  const o = { x, y, type, ...DEFAULTS[type], createdAt: -1, id: `e13#${++seq}` };
  g.envObjects.push(o);
  return o;
}
// Trunk HP is its own field; envState().hp stays the E2 blast HP (Josh).
const hp = (o) => g.envState(o.id).trunkHp;
const felled = (o) => ['falling', 'fallen'].includes(g.envState(o.id).state);
const weaponIdx = (name) => g.WEAPONS.findIndex((w) => w.name === name);

/** Aim the mouse at a world point (no frame drawn yet: offset = W/2 - cam). */
function aimAt(wx, wy) {
  const s = g.toScreen(wx, wy);
  g.mouseX = s.x + g.W / 2 - g.cam.x;
  g.mouseY = s.y + g.H / 2 - g.cam.y;
}

/** One frame of the real loop pieces that matter here. */
function frame() {
  g.gameTime += DT;
  g.updatePlayer(DT);
  g.processPendingDamage();
  g.updateBullets(DT);
  g.processPendingDamage();
  g.updateEnv(DT);
}

/** Fire one shot of `name` exactly at (wx, wy) (spread removed), step until it resolves. */
function shootAt(name, wx, wy) {
  const p = g.player;
  p.weapon = weaponIdx(name);
  p.magAmmo = g.WEAPONS[p.weapon].mag; p.reloading = false; p.fireTimer = 0; p.spinUp = 1;
  aimAt(wx, wy);
  const n0 = g.bullets.length;
  g.mouseJustPressed = true; g.mouseDown = true;
  g.updatePlayer(0.0001);
  g.mouseDown = false; g.mouseJustPressed = false;
  for (const b of g.bullets.slice(n0)) {
    const sp = Math.hypot(b.vx, b.vy), dx = wx - b.x, dy = wy - b.y, d = Math.hypot(dx, dy);
    b.vx = (dx / d) * sp; b.vy = (dy / d) * sp;
  }
  for (let i = 0; i < 120 && g.bullets.length; i++) { g.updateBullets(DT); g.processPendingDamage(); }
}

describe('E13 trunk HP', () => {
  test.skipIf(todo)('E13: trunk HP is 900 / 750 / 300 for tree / pine / dead tree', () => {
    const ts = [place('tree', 200, 0), place('pine', 200, 100), place('deadtree', 200, -100)];
    expect(ts.map(hp)).toEqual([900, 750, 300]);
    expect(ts.map((o) => g.envState(o.id).trunkMax)).toEqual([900, 750, 300]);
    expect(g.envState(ts[0].id).hp, 'E2 blast HP unchanged').toBe(100);
  });

  test.skipIf(todo)('E13: a non-pierce round stopped by a trunk applies its dmg; a pierce round x0.5 and passes', () => {
    const t = place('tree', 200, 0);
    shootAt('M16', t.x, t.y);
    expect(hp(t), 'M16 dmg').toBeCloseTo(900 - g.WEAPONS[weaponIdx('M16')].dmg, 6);
    const t2 = place('tree', 0, 200);
    const behind = g.spawnEnemy(2, 0, 320);
    behind.hp = behind.maxHp = 1e7;
    shootAt('Railgun', t2.x, t2.y + 120);
    expect(hp(t2), 'Railgun x0.5').toBeCloseTo(900 - 0.5 * g.WEAPONS[weaponIdx('Railgun')].dmg, 6);
    expect(behind.hp, 'the pierce round went on and hit the enemy behind').toBeLessThan(behind.maxHp);
  });

  test.skipIf(todo)('E13: an RPG explosion subtracts f x 250 from trunk HP', () => {
    // RPG detonates at the dummy's feet (G13c); the tree stands at d from that point.
    const e = g.spawnEnemy(2, 300, 0);
    e.hp = e.maxHp = 1e7; e.speed = 0;
    const R = g.WEAPONS[weaponIdx('RPG')].radius, d = 0.7 * R; // f = 0.3: below the E2 topple threshold
    const t = place('tree', 300, d);
    shootAt('RPG', e.x, e.y);
    expect(hp(t)).toBeCloseTo(900 - (1 - d / R) * 250, 0);
    expect(felled(t)).toBe(false);
  });
});

describe('E13 felling by sustained fire', () => {
  test.skipIf(todo)('E13: sustained minigun fire fells a tree in 3-5 s, away from the shooter (+-45 deg)', () => {
    const t = place('tree', 120, 60);
    const p = g.player;
    p.weapon = weaponIdx('Minigun');
    p.magAmmo = 1e6; // the magazine isn't what's being measured
    aimAt(t.x, t.y);
    g.mouseDown = true;
    let tFell = Infinity;
    for (let i = 0; i < 8 / DT; i++) {
      p.magAmmo = 1e6;
      frame();
      if (felled(t)) { tFell = (i + 1) * DT; break; }
    }
    g.mouseDown = false;
    expect(tFell, `minigun felled the tree after ${tFell.toFixed(2)} s`).toBeGreaterThanOrEqual(3);
    expect(tFell).toBeLessThanOrEqual(5);
    for (let i = 0; i < 2 / DT; i++) g.updateEnv(DT);
    const log = g.envLogs.find((l) => l.id === t.id);
    expect(log, 'log').toBeTruthy();
    const fall = Math.atan2(log.by - log.ay, log.bx - log.ax);
    const away = Math.atan2(t.y - p.y, t.x - p.x);
    let d = fall - away;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    expect(Math.abs(d) * 180 / Math.PI, 'falls away from the shooter').toBeLessThanOrEqual(45);
  });

  test.skipIf(todo)('E13: a notch shows once trunk HP is <= 50%', () => {
    const t = place('tree', 200, 0);
    const notch = () => g.envState(t.id).notch === true;
    while (hp(t) > 0.55 * 900) shootAt('M16', t.x, t.y);
    expect(notch(), 'no notch above 50%').toBe(false);
    while (hp(t) > 0.5 * 900) shootAt('M16', t.x, t.y);
    expect(notch(), 'notch at <= 50%').toBe(true);
  });

  test.skipIf(todo)('E13: fewer small-arms shots than the trunk HP leave the tree standing (replaces E3 "never fell")', () => {
    for (const name of ['Pistol', 'Uzi', 'M16']) {
      const t = place('tree', 200, seq * 40);
      const dmg = g.WEAPONS[weaponIdx(name)].dmg;
      const n = Math.floor((0.9 * 900) / dmg);
      for (let i = 0; i < n; i++) shootAt(name, t.x, t.y);
      expect(felled(t), `${name}: ${n} shots (${n * dmg} dmg) < 900`).toBe(false);
    }
  });
});

describe('E13 credit', () => {
  test.skipIf(todo)('E13: a tree felled by enemy fire gives the player no score', () => {
    const t = place('tree', 300, 0);
    // A weak enemy under the fall path dies to the trunk (E6), but the fall wasn't the player's.
    const victim = g.spawnEnemy(0, 300, 60);
    victim.hp = 1; victim.speed = 0;
    const score0 = g.score, combo0 = g.combo, kills0 = g.kills;
    for (let k = 0; k < 40 && !felled(t); k++) {
      // Enemy round from the far side so the tree falls toward the victim (away from the shooter).
      g.bullets.push({ x: 300, y: -200, vx: 0, vy: 900, dmg: 60, life: 2, owner: 'enemy', color: '#f44', size: 2, trail: false });
      for (let i = 0; i < 40 && g.bullets.length; i++) { g.updateBullets(DT); g.processPendingDamage(); }
    }
    expect(felled(t), 'enemy fire felled the tree').toBe(true);
    for (let i = 0; i < 3 / DT; i++) { g.updateEnv(DT); g.processPendingDamage(); }
    expect(g.score, 'no score for an enemy-caused fall').toBe(score0);
    expect(g.combo, 'no combo').toBe(combo0);
    if (victim.dead) expect(g.kills, 'kill not credited to the player').toBe(kills0);
  });
});
