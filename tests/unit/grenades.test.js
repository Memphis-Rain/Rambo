import { describe, test, expect, beforeEach } from 'vitest';
import { newRound } from '../helpers/load-game.js';
import { LANDED } from '../milestones.js';

// N1 grenades (spec M9 + Ralph's rulings): splash 0.7*200*(1-d/140), no direct hit; geyser
// R 98; no self-damage; SRC_EXPLOSIVE; ammo 3 / cap 6 / pickup +1 (6%, bosses too) / +1 per
// wave from wave 2; F key-down once per press, 0.5 s cooldown; raw cursor ground point
// clamped to 420u. Skipped until N1 is marked landed in tests/milestones.js.
const todo = !LANDED.N1;
let g;

beforeEach(() => {
  g = newRound().g;
  g.waveActive = false;
  g.waveTimer = 1e9;
  g.envObjects.length = 0;
  g.player.x = 0; g.player.y = 0;
  g.player.invincible = 0;
});

/** Step grenade physics in game time until `pred()` or `max` seconds; returns seconds. */
function stepUntil(dt, pred, max = 5) {
  let t = 0;
  while (t < max && !pred()) { g.gameTime += dt; g.updateGrenades(dt); g.processPendingDamage(); t += dt; }
  return t;
}

/** Record damage events: [{ target, dmg, src }]. */
function recordDamage() {
  const events = [];
  const orig = g.damageEnemy;
  g.damageEnemy = (target, dmg, angle, src, ...rest) => { events.push({ target, dmg, src }); return orig(target, dmg, angle, src, ...rest); };
  return { events, restore: () => { g.damageEnemy = orig; } };
}

describe('N1 throwing', () => {
  test.skipIf(todo)('N1: CFG values match the rulings', () => {
    const C = g.CFG;
    expect([C.GRENADE_DMG, C.GRENADE_RADIUS, C.GRENADE_FUSE, C.GRENADE_RANGE, C.GRENADE_AMMO_START, C.GRENADE_AMMO_MAX, C.GRENADE_COOLDOWN, C.GRENADE_DROP_CHANCE])
      .toEqual([200, 140, 1.8, 420, 3, 6, 0.5, 0.06]);
    expect(Math.round(C.GRENADE_RADIUS * C.GRENADE_GEYSER_SCALE)).toBe(98);
  });

  test.skipIf(todo)('N1: a throw lands near the target; farther targets clamp to 420u', () => {
    for (const [tx, expectR] of [[200, 200], [1500, 420]]) {
      const { g: r } = newRound();
      g = r;
      g.envObjects.length = 0;
      g.player.x = 0; g.player.y = 0;
      expect(g.throwGrenade(tx, 0), 'thrown').toBe(true);
      const gr = g.grenades[0];
      let landed = null, wasUp = false;
      stepUntil(1 / 60, () => {
        if (gr.z > 1) wasUp = true;
        if (wasUp && gr.z <= 0.01 && !landed) landed = { x: gr.x, y: gr.y };
        return !!landed || !g.grenades.includes(gr);
      }, 3);
      expect(landed, 'it lands before exploding').not.toBeNull();
      expect(Math.hypot(landed.x, landed.y), `first landing for a target at ${tx}u`).toBeCloseTo(expectR, -1); // within ~5u
    }
  });

  test.skipIf(todo)('N1: ammo decrements; 0.5 s cooldown; no throw with 0 ammo', () => {
    const p = g.player;
    expect(p.grenades).toBe(3);
    expect(g.throwGrenade(100, 0)).toBe(true);
    expect(p.grenades).toBe(2);
    expect(g.throwGrenade(100, 0), 'cooldown blocks an immediate throw').toBe(false);
    // The cooldown counts down in updateGrenades (game time), like the real loop.
    const wait = (s) => { for (let i = 0; i < Math.round(s * 60); i++) { g.updatePlayer(1 / 60); g.updateGrenades(1 / 60); } };
    wait(0.45);
    expect(g.throwGrenade(100, 0), 'still cooling down at 0.45 s').toBe(false);
    wait(0.07);
    expect(g.throwGrenade(100, 0), 'ready after 0.5 s').toBe(true);
    wait(0.52);
    expect(g.throwGrenade(100, 0)).toBe(true);
    expect(p.grenades).toBe(0);
    wait(0.52);
    expect(g.throwGrenade(100, 0), 'no ammo').toBe(false);
  });

  test.skipIf(todo)('N1: F is key-down, once per press, toward the raw cursor ground point', () => {
    const s = g.toScreen(250, 0);
    g.mouseX = s.x + g.W / 2 - g.cam.x;
    g.mouseY = s.y + g.H / 2 - g.cam.y;
    g.keys.f = true;
    for (let i = 0; i < 40; i++) { g.updatePlayer(1 / 60); g.updateGrenades(1 / 60); } // held for > the cooldown
    expect(g.grenades.length, 'one grenade per press').toBe(1);
    expect(Math.hypot(g.mouseGroundX - 250, g.mouseGroundY), 'raw ground point').toBeLessThan(2);
    g.keys.f = false;
    g.updatePlayer(1 / 60); g.updateGrenades(1 / 60);
    g.keys.f = true;
    g.updatePlayer(1 / 60);
    expect(g.grenades.length, 'a new press throws again').toBe(2);
  });
});

describe('N1 ammo', () => {
  test.skipIf(todo)('N1: pickups add 1 up to the cap of 6', () => {
    const p = g.player;
    for (let i = 0; i < 5; i++) {
      g.pickups.push({ x: 0, y: 0, type: 'grenade', life: 15, amount: 1 });
      g.updatePickups(1 / 60);
    }
    expect(p.grenades, 'capped at 6').toBe(6);
  });

  test.skipIf(todo)('N1: +1 at the start of each wave from wave 2 (not wave 1), capped at 6', () => {
    const p = g.player;
    const startWave = () => { g.waveActive = false; g.waveTimer = 0; g.updateWaves(0.001); };
    g.wave = 0;
    startWave();
    expect(g.wave).toBe(1);
    expect(p.grenades, 'wave 1 gives nothing').toBe(3);
    startWave();
    expect(g.wave).toBe(2);
    expect(p.grenades, 'wave 2 gives +1').toBe(4);
    for (let i = 0; i < 4; i++) startWave();
    expect(p.grenades, 'capped').toBe(6);
  });

  test.skipIf(todo)('N1: enemies drop a grenade pickup 6% of the time (3000 kills), bosses included', () => {
    let drops = 0;
    for (let i = 0; i < 3000; i++) {
      const before = g.pickups.length;
      g.killEnemy(g.spawnEnemy(0, 500, 0), 0);
      drops += g.pickups.slice(before).filter((q) => q.type === 'grenade').length;
      g.pickups.length = 0;
      g.bossActive = true; // keep unlock bosses out
    }
    // 6% of 3000 = 180, sd ~13: +-3 sd
    expect(drops).toBeGreaterThanOrEqual(141);
    expect(drops).toBeLessThanOrEqual(219);
    let bossDrops = 0;
    for (let i = 0; i < 400; i++) {
      const before = g.pickups.length;
      g.killEnemy(g.spawnEnemy(0, 500, 0, { name: 'B', hp: 10 }), 0);
      bossDrops += g.pickups.slice(before).filter((q) => q.type === 'grenade').length;
      g.pickups.length = 0;
    }
    expect(bossDrops, 'bosses drop grenades too').toBeGreaterThan(0);
  });
});

describe('N1 fuse and explosion', () => {
  for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
    test.skipIf(todo)(`N1: the fuse is 1.8 s +- 1 frame at dt 1/${Math.round(1 / dt)}`, () => {
      // Throw inside a frame, as the real loop does (updatePlayer then updateGrenades): the
      // throw frame doesn't age the grenade, so time is counted from the throw frame on.
      const exploded0 = g.grenadeStats().exploded + g.grenadeStats().geysers;
      g.throwGrenade(150, 0);
      g.updateGrenades(dt);
      const t = stepUntil(dt, () => g.grenadeStats().exploded + g.grenadeStats().geysers > exploded0, 4);
      // Ralph's rule: never early, at most one frame late.
      expect(t, `exploded after ${t.toFixed(4)} s (early)`).toBeGreaterThanOrEqual(1.8 - 1e-9);
      expect(t - 1.8, `exploded after ${t.toFixed(4)} s`).toBeLessThanOrEqual(dt + 1e-9);
    });
  }

  test.skipIf(todo)('N1: land explosion = splash 0.7*200*(1-d/140), no direct hit, SRC_EXPLOSIVE, no self-damage, envBlast + scorch', () => {
    const p = g.player;
    p.x = 60; p.y = 0; // inside the radius: must take no damage
    const shield0 = p.shield, hp0 = p.hp;
    const ds = [0, 70, 130, 145];
    const es = ds.map((d) => { const e = g.spawnEnemy(2, 0, d + 0.001); e.hp = e.maxHp = 1e7; return e; });
    const rec = recordDamage();
    const origBlast = g.envBlast;
    let blasts = 0;
    g.envBlast = (...a) => { blasts++; return origBlast(...a); };
    const scorch0 = g.bloodPools.filter((d) => d.kind === g.DECAL_SCORCH).length;
    g.grenadeExplode({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 1.8, fuse: 1.8, bounces: 0, inWater: false, sinkT: 0 });
    g.processPendingDamage();
    rec.restore();
    g.envBlast = origBlast;
    for (let k = 0; k < es.length; k++) {
      const got = rec.events.filter((ev) => ev.target === es[k]);
      const want = ds[k] < 140 ? 0.7 * 200 * (1 - ds[k] / 140) : 0;
      const sum = got.reduce((a, ev) => a + ev.dmg, 0);
      expect(sum, `enemy at ${ds[k]}u`).toBeCloseTo(want, 1);
      for (const ev of got) expect(ev.src, 'kill source').toBe(g.SRC_EXPLOSIVE);
    }
    expect(rec.events.some((ev) => ev.dmg >= 200 - 1e-6), 'no direct-hit event').toBe(false);
    expect(p.hp, 'no self-damage (hp)').toBe(hp0);
    expect(p.shield, 'no self-damage (shield)').toBe(shield0);
    expect(blasts, 'envBlast fired').toBeGreaterThan(0);
    expect(g.bloodPools.filter((d) => d.kind === g.DECAL_SCORCH).length, 'scorch decal').toBeGreaterThan(scorch0);
  });

  test.skipIf(todo)('N1: in water it blows a geyser: R 98 splash, no scorch, no fireball explosion', () => {
    const ds = [0, 60, 97, 110];
    const es = ds.map((d) => { const e = g.spawnEnemy(2, d + 0.001, 0); e.hp = e.maxHp = 1e7; return e; });
    const rec = recordDamage();
    const origExp = g.spawnExplosion;
    let explosions = 0;
    g.spawnExplosion = (...a) => { explosions++; return origExp(...a); };
    const scorch0 = g.bloodPools.filter((d) => d.kind === g.DECAL_SCORCH).length;
    const c0 = typeof g.waterBloodAt === 'function' ? g.waterBloodAt(0, 0).c : null;
    g.grenadeExplode({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 1.8, fuse: 1.8, bounces: 0, inWater: true, sinkT: 0 });
    g.processPendingDamage();
    rec.restore();
    g.spawnExplosion = origExp;
    for (let k = 0; k < es.length; k++) {
      const sum = rec.events.filter((ev) => ev.target === es[k]).reduce((a, ev) => a + ev.dmg, 0);
      const want = ds[k] < 98 ? 0.7 * 200 * (1 - ds[k] / 98) : 0;
      expect(sum, `enemy at ${ds[k]}u from the geyser`).toBeCloseTo(want, 1);
    }
    expect(explosions, 'no fireball explosion in water').toBe(0);
    expect(g.bloodPools.filter((d) => d.kind === g.DECAL_SCORCH).length, 'no scorch').toBe(scorch0);
    if (c0 !== null) expect(g.waterBloodAt(0, 0).c, 'W5 concentration unaffected').toBe(c0);
  });
});
