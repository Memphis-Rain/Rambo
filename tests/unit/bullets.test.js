import { describe, test, expect, beforeEach } from 'vitest';
import { newRound } from '../helpers/load-game.js';
import { LANDED } from '../milestones.js';

// G12 swept bullet hits and G2a knockback cap (spec 545f085).
// Skipped until each flag is marked landed in tests/milestones.js.

const RAILGUN = 8, M16 = 3;
const typeIdx = (g, name) => g.ENEMY_TYPES.findIndex((t) => t.name === name);

let g;
beforeEach(() => {
  g = newRound().g;
  g.unlockedWeapons = g.WEAPONS.length;
  g.waveActive = false;
  g.waveTimer = 1e9;
});

/** Point the mouse at a world position (no frame drawn yet, so the offset is W/2 - cam). */
function aimAt(wx, wy) {
  const s = g.toScreen(wx, wy);
  g.mouseX = s.x + g.W / 2 - g.cam.x;
  g.mouseY = s.y + g.H / 2 - g.cam.y;
}

/** Fire one shot of `weapon` through the real input path at (wx, wy). */
function fireAt(weapon, wx, wy) {
  const p = g.player;
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
}

function stepBullets(dt, frames) {
  for (let i = 0; i < frames && g.bullets.length; i++) {
    g.updateBullets(dt);
    g.processPendingDamage();
  }
}

/** A stationary enemy that survives any hit. */
function dummy(type, x, y) {
  const e = g.spawnEnemy(type, x, y);
  e.hp = e.maxHp = 1e7;
  return e;
}

function resetShot() {
  g.bullets.length = 0;
  g.enemies.length = 0;
  g.player.x = 0; g.player.y = 0;
  g.player.vx = 0; g.player.vy = 0;
}

describe('G12 swept bullet hits', () => {
  const todo = !LANDED.G12;

  for (const dt of [1 / 60, 0.05]) {
    test.skipIf(todo)(`G12: Railgun hits >= 95% of aimed shots on a stationary target at 300 units (dt ${dt.toFixed(3)})`, () => {
      const rand = g.seededRand(12);
      let hits = 0;
      const N = 100;
      for (let i = 0; i < N; i++) {
        resetShot();
        const a = rand() * Math.PI * 2;
        // About 300 units; varied so a lucky step phase at exactly 300 can't hide tunnelling.
        const r = 280 + rand() * 40;
        const e = dummy(typeIdx(g, 'Militia'), Math.cos(a) * r, Math.sin(a) * r);
        fireAt(RAILGUN, e.x, e.y);
        expect(g.bullets.length, 'railgun fired').toBe(1);
        stepBullets(dt, 60);
        if (e.hp < e.maxHp) hits++;
      }
      expect(hits / N).toBeGreaterThanOrEqual(0.95);
    });
  }

  test.skipIf(todo)('G12: a non-piercing bullet hits the nearest enemy on its path, not one behind it', () => {
    const rand = g.seededRand(3);
    for (let i = 0; i < 20; i++) {
      resetShot();
      const a = rand() * Math.PI * 2;
      const ux = Math.cos(a), uy = Math.sin(a);
      // Nearest is first in the array so iteration order can't fake the result.
      const near = dummy(typeIdx(g, 'Militia'), ux * 110, uy * 110);
      const far = dummy(typeIdx(g, 'Militia'), ux * 150, uy * 150);
      fireAt(M16, far.x, far.y);
      const b = g.bullets[0];
      expect(b.pierce).toBeFalsy();
      // Make it fast enough that one 0.05 s step crosses both enemies.
      const sp = Math.hypot(b.vx, b.vy);
      b.vx = (b.vx / sp) * 4000;
      b.vy = (b.vy / sp) * 4000;
      stepBullets(0.05, 10);
      expect(near.hp, `shot ${i}: nearest enemy hit`).toBeLessThan(near.maxHp);
      expect(far.hp, `shot ${i}: enemy behind untouched`).toBe(far.maxHp);
      expect(g.bullets.length, 'non-piercing bullet consumed').toBe(0);
    }
  });

  test.skipIf(todo)('G12: a piercing bullet damages each enemy at most once', () => {
    for (const dt of [1 / 240, 1 / 60]) {
      resetShot();
      // A big target the bullet overlaps for many small steps.
      const e = g.spawnEnemy(typeIdx(g, 'Heavy'), 300, 0, { name: 'Wall', hp: 1e7 });
      const behind = dummy(typeIdx(g, 'Militia'), 420, 0);
      fireAt(RAILGUN, 300, 0);
      stepBullets(dt, 200);
      expect(e.maxHp - e.hp, `dt ${dt}: one railgun hit`).toBeCloseTo(g.WEAPONS[RAILGUN].dmg, 6);
      expect(behind.maxHp - behind.hp, `dt ${dt}: pierces to the next enemy once`).toBeCloseTo(g.WEAPONS[RAILGUN].dmg, 6);
    }
  });

  test.skipIf(todo)('G12: an enemy bullet cannot tunnel past the player', () => {
    const rand = g.seededRand(8);
    for (let i = 0; i < 20; i++) {
      resetShot();
      g.player.invincible = 0;
      g.player.dodging = false;
      g.player.shield = g.player.maxShield;
      const a = rand() * Math.PI * 2;
      const officer = g.spawnEnemy(typeIdx(g, 'Officer'), Math.cos(a) * 250, Math.sin(a) * 250);
      officer.fireTimer = 0;
      g.updateEnemies(0.001);
      const b = g.bullets.find((x) => x.owner === 'enemy');
      expect(b, 'officer fired').toBeTruthy();
      g.enemies.length = 0;
      // Re-aim exactly at the player at 4000 units/s: one 0.05 s step jumps 200 units.
      const dx = g.player.x - b.x, dy = g.player.y - b.y, d = Math.hypot(dx, dy);
      b.vx = (dx / d) * 4000;
      b.vy = (dy / d) * 4000;
      const shield = g.player.shield;
      stepBullets(0.05, 10);
      expect(g.player.shield, `shot ${i}: player hit`).toBeLessThan(shield);
    }
  });
});

describe('G2a knockback cap', () => {
  const todo = !LANDED.G2A;

  const push = (dmg) => {
    const e = dummy(typeIdx(g, 'Militia'), 100, 0);
    g.damageEnemy(e, dmg, 0);
    return Math.hypot(e.knockbackX, e.knockbackY);
  };

  test.skipIf(todo)('G2a: knockback keeps scaling past 140 damage up to a 900 cap', () => {
    const kb140 = push(140);
    const kb300 = push(300);
    const kb800 = push(800);
    expect(kb300).toBeGreaterThan(kb140);
    expect(kb800).toBeGreaterThan(kb300);
    expect(kb800).toBeLessThanOrEqual(900 + 1e-6);
    expect(push(5000)).toBeCloseTo(kb800, 6); // capped
  });

  test.skipIf(todo)('G2a: resist factors and the size divisor still apply', () => {
    const small = push(800);
    const heavy = dummy(typeIdx(g, 'Juggernaut'), -100, 0);
    g.damageEnemy(heavy, 800, Math.PI);
    expect(Math.hypot(heavy.knockbackX, heavy.knockbackY)).toBeLessThan(small);
  });

  test.skipIf(todo)('G2a: after a max-damage push into a tree or rock the enemy is never inside it', () => {
    for (const [kind, r] of [['tree', 18], ['rock', 14], ['boulder', 26]]) {
      for (const typeName of ['Militia', 'Runner', 'Heavy']) {
        resetShot();
        g.envObjects.length = 0;
        g.envObjects.push({ type: kind, x: 0, y: 0, collision: r });
        g.player.x = 5000;
        const t = g.ENEMY_TYPES[typeIdx(g, typeName)];
        const er = 8 * t.size;
        const e = dummy(typeIdx(g, typeName), -(r + er + 2), 0);
        g.damageEnemy(e, 5000, 0); // pushed straight at the obstacle
        for (let f = 0; f < 60; f++) {
          g.updateEnemies(1 / 60);
          const d = Math.hypot(e.x, e.y);
          expect(d, `${typeName} vs ${kind}, frame ${f}`).toBeGreaterThanOrEqual(r + er - 0.5);
        }
      }
    }
  });
});

// G12a (spec 49f3e2a): a pierce round hits an enemy once per pass for
// dmg * max(1, round(chord / (speed / 60))), reproducing the old 60 fps damage.
// Golden hit counts measured with main@5c5fb60's per-frame point test at 60 fps,
// centre pass, target 300 units away (spread over 260-340 units: Plasma 3/9,
// Disintegrator 2-3/6-7, Railgun 0-1/2-3).
const GOLDEN = [
  { weapon: 'Plasma', target: 'Tank', boss: false, hits: 3 },
  { weapon: 'Plasma', target: 'Juggernaut', boss: true, hits: 9 },
  { weapon: 'Disintegrator', target: 'Tank', boss: false, hits: 2 },
  { weapon: 'Disintegrator', target: 'Juggernaut', boss: true, hits: 6 },
  { weapon: 'Railgun', target: 'Tank', boss: false, hits: 1 },
  { weapon: 'Railgun', target: 'Juggernaut', boss: true, hits: 3 },
];

/** Damage per bullet, in hits, for one pass through a stationary target (lateral offset in units). */
function passHits(weaponName, targetName, boss, fps, lateral = 0) {
  const { g: r } = newRound();
  r.unlockedWeapons = r.WEAPONS.length;
  const wi = r.WEAPONS.findIndex((w) => w.name === weaponName);
  const ti = r.ENEMY_TYPES.findIndex((t) => t.name === targetName);
  const e = boss ? r.spawnEnemy(ti, 300, 0, { name: 'Golden', hp: 1e9 }) : r.spawnEnemy(ti, 300, 0);
  e.hp = e.maxHp = 1e9;
  e.shieldHp = 0;
  const p = r.player;
  p.weapon = wi; p.magAmmo = r.WEAPONS[wi].mag; p.fireTimer = 0; p.spinUp = 1;
  const s = r.toScreen(300, 0);
  r.mouseX = s.x + r.W / 2; r.mouseY = s.y + r.H / 2;
  r.mouseJustPressed = true; r.mouseDown = true;
  r.updatePlayer(0.0001);
  r.mouseDown = false;
  const n = r.bullets.length;
  // Remove spread: aim every bullet exactly through (target + lateral offset across the path).
  for (const b of r.bullets) {
    const sp = Math.hypot(b.vx, b.vy);
    const dx = e.x - b.x, dy = e.y + lateral - b.y, d = Math.hypot(dx, dy);
    b.vx = (dx / d) * sp; b.vy = (dy / d) * sp;
  }
  for (let i = 0; i < fps * 3 && r.bullets.length; i++) { r.updateBullets(1 / fps); r.processPendingDamage(); }
  return { hits: (e.maxHp - e.hp) / r.WEAPONS[wi].dmg / n, radius: 15 * e.size, speed: r.WEAPONS[wi].speed };
}

describe('G12a pierce damage per pass', () => {
  const todo = !LANDED.G12A;

  for (const c of GOLDEN) {
    test.skipIf(todo)(`G12a: ${c.weapon} vs ${c.boss ? 'Juggernaut boss' : c.target} matches the old 60 fps damage (±1 hit) at 30/60/144 fps`, () => {
      const at = [30, 60, 144].map((fps) => passHits(c.weapon, c.target, c.boss, fps).hits);
      expect(at[0], '30 fps == 60 fps').toBeCloseTo(at[1], 6);
      expect(at[2], '144 fps == 60 fps').toBeCloseTo(at[1], 6);
      expect(Math.abs(at[1] - c.hits), `got ${at[1]} hits, golden ${c.hits}`).toBeLessThanOrEqual(1);
    });
  }

  test.skipIf(todo)('G12a: an off-centre pass uses the chord: max(1, round(chord / (speed/60))) hits, same at any fps', () => {
    for (const [weapon, target, boss] of [['Plasma', 'Juggernaut', true], ['Disintegrator', 'Tank', false]]) {
      const probe = passHits(weapon, target, boss, 60, 0);
      const lateral = probe.radius * 0.8;
      const chord = 2 * Math.sqrt(probe.radius ** 2 - lateral ** 2);
      const expected = Math.max(1, Math.round(chord / (probe.speed / 60)));
      for (const fps of [30, 60, 144]) {
        const h = passHits(weapon, target, boss, fps, lateral).hits;
        // The bullet path isn't perfectly straight through the offset point; allow ±1.
        expect(Math.abs(h - expected), `${weapon} vs ${target} @${fps}fps: ${h} vs ${expected}`).toBeLessThanOrEqual(1);
      }
      expect(passHits(weapon, target, boss, 30, lateral).hits).toBeCloseTo(passHits(weapon, target, boss, 144, lateral).hits, 6);
    }
  });
});

describe('G12b barrels on the bullet path', () => {
  const todo = !LANDED.G12A;

  const barrel = (x, y) => {
    const b = { x, y, type: 'barrel', hp: 1e9, maxHp: 1e9, exploded: false, createdAt: -1 };
    g.envObjects.push(b);
    return b;
  };

  test.skipIf(todo)('G12b: the Railgun cannot tunnel through a barrel', () => {
    const rand = g.seededRand(21);
    let hits = 0;
    for (let i = 0; i < 40; i++) {
      resetShot();
      g.envObjects.length = 0;
      const a = rand() * Math.PI * 2, d = 150 + rand() * 100;
      const br = barrel(Math.cos(a) * d, Math.sin(a) * d);
      fireAt(RAILGUN, br.x, br.y);
      for (const b of g.bullets) { // exact aim through the barrel centre
        const sp = Math.hypot(b.vx, b.vy), dx = br.x - b.x, dy = br.y - b.y, dd = Math.hypot(dx, dy);
        b.vx = (dx / dd) * sp; b.vy = (dy / dd) * sp;
      }
      stepBullets(1 / 60, 60);
      if (br.hp < br.maxHp) hits++;
    }
    expect(hits).toBe(40);
  });

  for (const nearer of ['barrel', 'enemy']) {
    test.skipIf(todo)(`G12b: on a non-pierce path the nearer ${nearer} takes the hit`, () => {
      resetShot();
      g.envObjects.length = 0;
      const [bd, ed] = nearer === 'barrel' ? [110, 150] : [150, 110];
      const br = barrel(bd, 0);
      const e = dummy(typeIdx(g, 'Militia'), ed, 0);
      fireAt(M16, 200, 0);
      const b = g.bullets[0];
      b.vy = 0; b.vx = 4000; // crosses both in one 0.05 s step
      stepBullets(0.05, 10);
      if (nearer === 'barrel') {
        expect(br.hp, 'barrel hit').toBeLessThan(br.maxHp);
        expect(e.hp, 'enemy behind untouched').toBe(e.maxHp);
      } else {
        expect(e.hp, 'enemy hit').toBeLessThan(e.maxHp);
        expect(br.hp, 'barrel behind untouched').toBe(br.maxHp);
      }
      expect(g.bullets.length, 'non-piercing bullet consumed').toBe(0);
    });
  }
});
