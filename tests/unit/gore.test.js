import { describe, test, expect, beforeEach } from 'vitest';
import { newRound } from '../helpers/load-game.js';
import { LANDED } from '../milestones.js';

// M3 hooks. Skipped until M3 is marked landed in tests/milestones.js.
const todo = !LANDED.M3;

let g;
beforeEach(() => {
  g = newRound().g;
  g.player.x = 5000; // keep bombers/explosions from touching the player
});

const militia = () => g.spawnEnemy(0, 0, 0);

describe('G5 gibs', () => {
  test.skipIf(todo)('G5: explosive kill bursts into 5-8 gibs in the same call', () => {
    const e = militia();
    g.damageEnemy(e, e.hp + 1, 0, g.SRC_EXPLOSIVE);
    expect(e.dead).toBe(true);
    expect(g.gibs.length).toBeGreaterThanOrEqual(5);
    expect(g.gibs.length).toBeLessThanOrEqual(8);
    for (const gib of g.gibs) {
      expect([0, 1, 2, 3, 4]).toContain(gib.part);
      for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'size', 'life']) expect(Number.isFinite(gib[k]), k).toBe(true);
    }
  });

  test.skipIf(todo)('G5: BFG and Railgun kills gib', () => {
    for (const src of [g.SRC_BFG, g.SRC_RAIL]) {
      const { g: r } = newRound();
      const e = r.spawnEnemy(0, 0, 0);
      r.damageEnemy(e, e.hp + 1, 0, src);
      expect(r.gibs.length).toBeGreaterThanOrEqual(5);
    }
  });

  test.skipIf(todo)('G5: overkill (damage >= 2x remaining HP) gibs without a source', () => {
    const e = militia();
    g.damageEnemy(e, e.hp * 2, 0);
    expect(g.gibs.length).toBeGreaterThanOrEqual(5);
  });

  test.skipIf(todo)('G5: a bomber death gibs', () => {
    const e = g.spawnEnemy(g.ENEMY_TYPES.findIndex((t) => t.name === 'Bomber'), 0, 0);
    g.damageEnemy(e, e.hp + 1, 0);
    expect(g.gibs.length).toBeGreaterThanOrEqual(5);
  });

  test.skipIf(todo)('G5: a normal kill leaves a falling corpse with 3-5 spurts, not gibs', () => {
    const e = militia();
    g.damageEnemy(e, e.hp + 1, 0);
    expect(g.gibs.length).toBe(0);
    expect(g.bodies.length).toBe(1);
    const body = g.bodies[0];
    expect(body.fall).toBeGreaterThanOrEqual(0);
    expect(body.fall).toBeLessThanOrEqual(1);
    expect(body.spurts).toBeGreaterThanOrEqual(3);
    expect(body.spurts).toBeLessThanOrEqual(5);
  });

  test.skipIf(todo)('G5: gibs are capped at CFG.MAX_GIBS', () => {
    for (let i = 0; i < 60; i++) {
      const e = g.spawnEnemy(0, i * 3, 0);
      g.damageEnemy(e, e.hp + 1, 0, g.SRC_EXPLOSIVE);
      g.processPendingDamage();
    }
    expect(g.gibs.length).toBeLessThanOrEqual(g.CFG.MAX_GIBS);
  });
});

describe('G4 decals', () => {
  test.skipIf(todo)('G4: bloodPools never exceeds CFG.MAX_BLOOD_POOLS', () => {
    for (let i = 0; i < 1500; i++) {
      const e = g.spawnEnemy(0, (i % 50) * 10, Math.floor(i / 50) * 10);
      g.damageEnemy(e, e.hp + 1, 0);
      if (i % 10 === 0) g.enemies.length = 0;
    }
    expect(g.bloodPools.length).toBeGreaterThan(0);
    expect(g.bloodPools.length).toBeLessThanOrEqual(g.CFG.MAX_BLOOD_POOLS);
  });

  test.skipIf(todo)('G4: decalVersion increments when decals change', () => {
    const v0 = g.decalVersion;
    const e = militia();
    g.damageEnemy(e, e.hp + 1, 0);
    expect(g.decalVersion).toBeGreaterThan(v0);
  });

  test.skipIf(todo)('G4: decal kinds are the specced constants', () => {
    expect([g.DECAL_POOL, g.DECAL_SPLAT, g.DECAL_SCORCH, g.DECAL_FOOT, g.DECAL_SMEAR, g.DECAL_GIB, g.DECAL_ASH])
      .toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('G8 damage numbers', () => {
  test.skipIf(todo)('G8: a hit spawns a damage number', () => {
    const e = g.spawnEnemy(2, 0, 0); // Heavy survives the hit
    g.damageEnemy(e, 20, 0);
    expect(g.dmgNumbers.length).toBe(1);
    expect(g.dmgNumbers[0].value).toBeCloseTo(20);
    expect(g.dmgNumbers[0].kind).toBe(g.DMG_NORMAL);
  });

  test.skipIf(todo)('G8: rapid hits on one target within 0.14 s merge into one number', () => {
    const e = g.spawnEnemy(2, 0, 0);
    g.damageEnemy(e, 10, 0);
    g.damageEnemy(e, 15, 0);
    expect(g.dmgNumbers.length).toBe(1);
    expect(g.dmgNumbers[0].value).toBeCloseTo(25);
  });

  test.skipIf(todo)('G8: shield hits use DMG_SHIELD', () => {
    const e = g.spawnEnemy(g.ENEMY_TYPES.findIndex((t) => t.hasShield), 0, 0);
    g.damageEnemy(e, 5, 0);
    expect(g.dmgNumbers.some((n) => n.kind === g.DMG_SHIELD)).toBe(true);
  });
});

describe('G9 hit-stop', () => {
  test.skipIf(todo)('G9: addHitStop never exceeds 0.1 s', () => {
    g.addHitStop(0.05);
    g.addHitStop(0.05);
    g.addHitStop(0.05);
    expect(g.hitStopTimer).toBeGreaterThan(0);
    expect(g.hitStopTimer).toBeLessThanOrEqual(0.1);
    g.addHitStop(5);
    expect(g.hitStopTimer).toBeLessThanOrEqual(0.1);
  });

  test.skipIf(todo)('G9: an explosive kill triggers hit-stop in 0.03-0.1 s', () => {
    g.hitStopTimer = 0;
    const e = militia();
    g.damageEnemy(e, e.hp + 1, 0, g.SRC_EXPLOSIVE);
    expect(g.hitStopTimer).toBeGreaterThanOrEqual(0.03);
    expect(g.hitStopTimer).toBeLessThanOrEqual(0.1);
  });
});
