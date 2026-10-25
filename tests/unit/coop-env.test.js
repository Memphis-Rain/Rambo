import { describe, test, expect, beforeEach } from 'vitest';
import { newRound } from '../helpers/load-game.js';
import { LANDED } from '../milestones.js';

// M11 K2.2 (Ralph's review of 36c8ebd): co-op credit and friendly fire through the M8/M9
// environment - tree falls (E6) and tree fires (F3). Headless, hand-placed trees as in
// env.test.js. P2 comes from coopJoin(); pads are not polled here (only env/fire updates run).
const todo = !LANDED.K2_2;
const DT = 1 / 60;
const RPG_R = 130;
const typeIdx = (g, name) => g.ENEMY_TYPES.findIndex((t) => t.name === name);

let g, p1, p2, seq = 0;
function fresh() {
  g = newRound().g;
  g.unlockedWeapons = g.WEAPONS.length;
  g.waveActive = false;
  g.waveTimer = 1e9;
  g.envObjects.length = 0;
  g.enemies.length = 0;
  p1 = g.player;
  p1.x = 0; p1.y = 0;
  p2 = g.coopJoin(1);
  for (const p of [p1, p2]) { p.invincible = 0; p.dodging = false; p.shield = 0; p.specialCharge = 0; }
  p2.x = -400; p2.y = 0;
}
function place(type, x, y) {
  const o = { x, y, type, radius: 40, height: 100, collision: 8, createdAt: -1, id: `coopenv#${++seq}` };
  g.envObjects.push(o);
  return o;
}
function stepUntil(pred, maxSeconds, each) {
  for (let i = 0; i < Math.round(maxSeconds / DT); i++) {
    if (pred()) return i * DT;
    if (each) each();
    g.updateEnv(DT);
    g.updateFire(DT);
    g.processPendingDamage();
  }
  return pred() ? maxSeconds : Infinity;
}
/** Fell the tree at (300, 0) along +x with an explosion credited to players[by] (null: nobody's). */
function fell(t, by) {
  const f = 0.8, d = (1 - f) * RPG_R;
  g.dmgBy = by === null ? 0 : by;
  g.spawnExplosion(t.x - d, t.y, RPG_R, by !== null, g.SRC_EXPLOSIVE);
  g.dmgBy = 0;
  const landed = stepUntil(() => g.envState(t.id).state === 'fallen', 3);
  expect(landed, 'the tree fell').toBeLessThan(3);
}
const UNDER = { x: 330, y: -4 }; // under the trunk once it lies along +x from (300, 0)
const putUnder = (p, dx = 0) => { p.x = UNDER.x + dx; p.y = UNDER.y; p.vx = 0; p.vy = 0; };

describe('M11 K2.2 environment credit and friendly fire', () => {
  beforeEach(fresh);

  test.skipIf(todo)('K2.2/E6: a P1-credited tree fall onto P2 deals P2 nothing (friendly fire off)', () => {
    expect(g.CFG.COOP_FRIENDLY_FIRE).toBe(false);
    const t = place('tree', 300, 0);
    putUnder(p2);
    const hp = p2.hp;
    fell(t, 0);
    expect(p2.hp, 'P2 under P1\'s falling tree').toBe(hp);
  });

  test.skipIf(todo)('K2.2/E6: a P2-credited tree fall onto P1 deals P1 nothing', () => {
    const t = place('tree', 300, 0);
    putUnder(p1); p2.x = -400;
    const hp = p1.hp;
    fell(t, 1);
    expect(p1.hp, 'P1 under P2\'s falling tree').toBe(hp);
  });

  test.skipIf(todo)('K2.2/E6: your own tree fall still hurts you as in 1P (ENV_FALL_PLAYER_DMG = 40)', () => {
    const t = place('tree', 300, 0);
    putUnder(p1);
    const hp = p1.hp;
    fell(t, 0);
    expect(hp - p1.hp, 'P1 under P1\'s own falling tree').toBe(g.CFG.ENV_FALL_PLAYER_DMG);
    expect(g.CFG.ENV_FALL_PLAYER_DMG).toBe(40);
  });

  test.skipIf(todo)('K2.2/E6: an uncredited tree fall still hurts both players (40 each)', () => {
    const t = place('tree', 300, 0);
    putUnder(p1, -6); putUnder(p2, 10);
    const h1 = p1.hp, h2 = p2.hp;
    fell(t, null);
    expect(h1 - p1.hp, 'P1').toBe(40);
    expect(h2 - p2.hp, 'P2').toBe(40);
  });

  test.skipIf(todo)('K2.2/E6: a tree fall credits the player whose blast felled it: a fall by P2 kills an enemy, so P2 gets the kill, score and charge', () => {
    for (const by of [1, 0]) {
      fresh();
      const t = place('tree', 300, 0);
      const e = g.spawnEnemy(typeIdx(g, 'Militia'), 345, 3);
      e.hp = e.maxHp = 100; e.speed = 0; e.fireTimer = 1e9; e.shieldHp = e.maxShieldHp = 0;
      const killer = [p1, p2][by], other = [p1, p2][1 - by];
      fell(t, by);
      expect(e.dead || !g.enemies.includes(e), `by=${by}: crushed`).toBe(true);
      expect(killer.kills, `by=${by}: the felling player gets the kill`).toBe(1);
      expect(killer.score, `by=${by}: and the score`).toBeGreaterThan(0);
      expect(killer.specialCharge, `by=${by}: and the charge`).toBe(1);
      expect(other.kills || 0, `by=${by}: the other player does not`).toBe(0);
    }
  });

  /** Heat tree `t` with flames credited to players[by] (fire.js path: dmgBy around envFlameHeat) until it burns. */
  const igniteBy = (t, by) => {
    const lit = stepUntil(() => (g.envState(t.id).fire || 0) > 0, 10, () => { g.dmgBy = by; g.envFlameHeat(t); g.dmgBy = 0; });
    expect(lit, 'the tree caught fire').toBeLessThan(10);
  };
  const victim = (x, y) => {
    const e = g.spawnEnemy(typeIdx(g, 'Militia'), x, y);
    e.hp = e.maxHp = 30; e.speed = 0; e.fireTimer = 1e9; e.shieldHp = e.maxShieldHp = 0;
    return e;
  };

  test.skipIf(todo)('K2.2/F3: an enemy killed under a tree P2 set on fire (canopy fire) credits P2: kills, score, shockwave charge', () => {
    const t = place('tree', 300, 0);
    igniteBy(t, 1);
    const e = victim(305, 8);
    const s0 = { k1: p1.kills || 0, k2: p2.kills || 0, s2: p2.score || 0, team: g.score };
    const died = stepUntil(() => e.dead || !g.enemies.includes(e), 15, () => { e.x = 305; e.y = 8; e.vx = 0; e.vy = 0; });
    expect(died, 'the enemy burned to death').toBeLessThan(15);
    expect(p2.kills - s0.k2, 'P2 kill').toBe(1);
    expect((p1.kills || 0) - s0.k1, 'not P1').toBe(0);
    expect(p2.score, 'P2 score').toBeGreaterThan(s0.s2);
    expect(p2.specialCharge, 'P2 shockwave charge').toBe(1);
    expect(p1.specialCharge, 'not P1\'s').toBe(0);
    expect(g.score - s0.team, 'team total = P2\'s gain').toBe(p2.score - s0.s2);
  });

  test.skipIf(!LANDED.K2_3)('K2.3/F3: P1 flames a tree briefly, then P2 flames it until it lights: the canopy kill credits P2 (the latest heater)', () => {
    const t = place('tree', 300, 0);
    for (let i = 0; i < 5; i++) { g.dmgBy = 0; g.envFlameHeat(t); g.dmgBy = 0; g.updateEnv(DT); }
    expect(g.envState(t.id).fire || 0, 'the brief P1 heat did not light it').toBe(0);
    igniteBy(t, 1);
    const e = victim(305, 8);
    const died = stepUntil(() => e.dead || !g.enemies.includes(e), 15, () => { e.x = 305; e.y = 8; e.vx = 0; e.vy = 0; });
    expect(died).toBeLessThan(15);
    expect(p2.kills, 'P2 kill').toBe(1);
    expect(p1.kills || 0, 'not P1').toBe(0);
  });

  test.skipIf(todo)('K2.2/F3: fire spreading from P2\'s tree to the next keeps P2\'s credit', () => {
    const a = place('tree', 300, 0), b = place('tree', 360, 0);
    igniteBy(a, 1);
    const spread = stepUntil(() => (g.envState(b.id).fire || 0) > 0, 30);
    expect(spread, 'the fire spread to the second tree').toBeLessThan(30);
    const e = victim(365, 8);
    const died = stepUntil(() => e.dead || !g.enemies.includes(e), 15, () => { e.x = 365; e.y = 8; e.vx = 0; e.vy = 0; });
    expect(died).toBeLessThan(15);
    expect(p2.kills, 'P2 kill via the spread fire').toBe(1);
    expect(p1.kills || 0, 'not P1').toBe(0);
  });
});
