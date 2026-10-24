import { describe, test, expect } from 'vitest';
import { loadGame } from '../helpers/load-game.js';

const { g } = loadGame({ files: ['js/config.js'] });
const { CFG, WEAPONS, ENEMY_TYPES, BOSS_NAMES } = g;

const CSS_HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
// combat.js maps keys 1-9, 0, - to weapon slots.
const WEAPON_KEYS = 11;

describe('T3 config.js', () => {
  test('T3: CFG numeric settings are finite and positive', () => {
    for (const [key, v] of Object.entries(CFG)) {
      if (typeof v === 'boolean') continue;
      expect(typeof v, key).toBe('number');
      expect(Number.isFinite(v), key).toBe(true);
      expect(v, key).toBeGreaterThan(0);
    }
    expect(CFG.BODY_FADE_END).toBeGreaterThan(CFG.BODY_FADE_START);
  });

  test('T3: every weapon has the required fields', () => {
    expect(WEAPONS.length).toBeGreaterThan(0);
    expect(WEAPONS.length).toBeLessThanOrEqual(WEAPON_KEYS);
    for (const w of WEAPONS) {
      const id = w.name;
      expect(typeof w.name).toBe('string');
      expect(w.rate, id).toBeGreaterThan(0);
      expect(w.dmg, id).toBeGreaterThan(0);
      expect(w.spread, id).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(w.count) && w.count >= 1, `${id}.count`).toBe(true);
      expect(w.speed, id).toBeGreaterThan(0);
      expect(w.color, id).toMatch(CSS_HEX);
      expect(typeof w.auto, id).toBe('boolean');
      expect(w.mag, id).toBeGreaterThan(0);
      expect(w.reload, id).toBeGreaterThan(0);
      expect(typeof w.unlock, id).toBe('number');
      expect(w.kickback, id).toBeGreaterThanOrEqual(0);
      expect(w.shellSize, id).toBeGreaterThanOrEqual(0);
      if (w.explosive) expect(w.radius, `${id}.radius`).toBeGreaterThan(0);
      if (w.chain) expect(w.chainRange, `${id}.chainRange`).toBeGreaterThan(0);
    }
  });

  test('T3: weapon names are unique', () => {
    const names = WEAPONS.map((w) => w.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('T3: unlock scores start at 0 and strictly ascend', () => {
    expect(WEAPONS[0].unlock).toBe(0);
    for (let i = 1; i < WEAPONS.length; i++) {
      expect(WEAPONS[i].unlock, WEAPONS[i].name).toBeGreaterThan(WEAPONS[i - 1].unlock);
    }
  });

  test('T3: every enemy type is valid', () => {
    expect(ENEMY_TYPES.length).toBeGreaterThan(0);
    for (const t of ENEMY_TYPES) {
      const id = t.name;
      expect(typeof t.name).toBe('string');
      expect(t.hp, id).toBeGreaterThan(0);
      expect(t.speed, id).toBeGreaterThan(0);
      expect(t.dmg, id).toBeGreaterThan(0);
      expect(t.range, id).toBeGreaterThan(0);
      expect(t.color, id).toMatch(CSS_HEX);
      expect(t.size, id).toBeGreaterThan(0);
      expect(t.score, id).toBeGreaterThan(0);
      expect(Number.isInteger(t.wave) && t.wave >= 1, `${id}.wave`).toBe(true);
      if (t.shoots) {
        expect(t.fireRate, `${id}.fireRate`).toBeGreaterThan(0);
        expect(t.bulletSpeed, `${id}.bulletSpeed`).toBeGreaterThan(0);
      }
      if (t.hasShield) expect(t.shieldHp, `${id}.shieldHp`).toBeGreaterThan(0);
      if (t.explodeOnDeath) expect(t.explodeRadius, `${id}.explodeRadius`).toBeGreaterThan(0);
    }
  });

  test('T3: enemy names are unique and wave 1 has at least one enemy', () => {
    const names = ENEMY_TYPES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(ENEMY_TYPES.some((t) => t.wave === 1)).toBe(true);
  });

  test('T3: BOSS_NAMES has one boss per unlockable weapon', () => {
    // spawnBoss(i) uses BOSS_NAMES[i-1] for weapons 1..n-1.
    expect(BOSS_NAMES.length).toBe(WEAPONS.length - 1);
    for (const n of BOSS_NAMES) expect(typeof n).toBe('string');
    expect(new Set(BOSS_NAMES).size).toBe(BOSS_NAMES.length);
  });
});

// Q4: gameplay numbers stay unchanged during the visual overhaul unless the spec says otherwise.
describe('Q4 gameplay lock', () => {
  test('Q4: weapon stats and unlock scores', () => {
    const stats = WEAPONS.map(({ name, rate, dmg, spread, count, speed, mag, reload, unlock }) =>
      ({ name, rate, dmg, spread, count, speed, mag, reload, unlock }));
    expect(stats).toEqual([
      { name: 'Pistol', rate: 0.28, dmg: 30, spread: 0.04, count: 1, speed: 900, mag: 15, reload: 1.0, unlock: 0 },
      { name: 'Uzi', rate: 0.07, dmg: 14, spread: 0.13, count: 1, speed: 800, mag: 32, reload: 1.2, unlock: 400 },
      { name: 'Shotgun', rate: 0.55, dmg: 18, spread: 0.25, count: 7, speed: 650, mag: 6, reload: 1.8, unlock: 1200 },
      { name: 'M16', rate: 0.09, dmg: 22, spread: 0.06, count: 1, speed: 1000, mag: 30, reload: 1.5, unlock: 2500 },
      { name: 'Minigun', rate: 0.035, dmg: 11, spread: 0.18, count: 1, speed: 900, mag: 200, reload: 3.0, unlock: 5000 },
      { name: 'RPG', rate: 0.9, dmg: 250, spread: 0.02, count: 1, speed: 450, mag: 1, reload: 2.0, unlock: 9000 },
      { name: 'Plasma', rate: 0.12, dmg: 55, spread: 0.04, count: 1, speed: 1100, mag: 40, reload: 1.8, unlock: 16000 },
      { name: 'Tesla', rate: 0.14, dmg: 45, spread: 0.08, count: 1, speed: 1200, mag: 50, reload: 2.0, unlock: 25000 },
      { name: 'Railgun', rate: 1.4, dmg: 600, spread: 0, count: 1, speed: 4000, mag: 3, reload: 2.5, unlock: 40000 },
      { name: 'BFG', rate: 2.0, dmg: 800, spread: 0.02, count: 1, speed: 350, mag: 1, reload: 3.0, unlock: 60000 },
      { name: 'Disintegrator', rate: 0.04, dmg: 38, spread: 0.03, count: 2, speed: 1600, mag: 120, reload: 2.5, unlock: 85000 },
    ]);
  });

  test('Q4: enemy stats', () => {
    const stats = ENEMY_TYPES.map(({ name, hp, speed, dmg, range, score, wave }) =>
      ({ name, hp, speed, dmg, range, score, wave }));
    expect(stats).toEqual([
      { name: 'Militia', hp: 45, speed: 55, dmg: 6, range: 28, score: 10, wave: 1 },
      { name: 'Runner', hp: 25, speed: 130, dmg: 4, range: 22, score: 15, wave: 3 },
      { name: 'Heavy', hp: 180, speed: 30, dmg: 14, range: 32, score: 30, wave: 5 },
      { name: 'Officer', hp: 65, speed: 45, dmg: 10, range: 280, score: 25, wave: 7 },
      { name: 'Berserker', hp: 130, speed: 115, dmg: 16, range: 30, score: 45, wave: 8 },
      { name: 'Bomber', hp: 40, speed: 90, dmg: 60, range: 28, score: 35, wave: 9 },
      { name: 'Commando', hp: 90, speed: 80, dmg: 8, range: 200, score: 35, wave: 10 },
      { name: 'Medic', hp: 55, speed: 42, dmg: 5, range: 180, score: 50, wave: 11 },
      { name: 'Sniper', hp: 35, speed: 20, dmg: 35, range: 550, score: 40, wave: 13 },
      { name: 'Shielded', hp: 100, speed: 38, dmg: 12, range: 250, score: 55, wave: 14 },
      { name: 'Tank', hp: 600, speed: 18, dmg: 45, range: 250, score: 100, wave: 16 },
      { name: 'Juggernaut', hp: 1200, speed: 12, dmg: 60, range: 280, score: 200, wave: 20 },
    ]);
  });

  test('Q4: player survivability constants', () => {
    const { PLAYER_MAX_HP, PLAYER_REGEN, PLAYER_MAX_SHIELD, SHIELD_REGEN, SHIELD_REGEN_DELAY,
      SPECIAL_MAX_CHARGE, SPECIAL_RADIUS, SPECIAL_DAMAGE, COMBO_TIMEOUT, PLAYER_SPEED } = CFG;
    expect({ PLAYER_MAX_HP, PLAYER_REGEN, PLAYER_MAX_SHIELD, SHIELD_REGEN, SHIELD_REGEN_DELAY,
      SPECIAL_MAX_CHARGE, SPECIAL_RADIUS, SPECIAL_DAMAGE, COMBO_TIMEOUT, PLAYER_SPEED }).toEqual({
      PLAYER_MAX_HP: 800, PLAYER_REGEN: 5, PLAYER_MAX_SHIELD: 300, SHIELD_REGEN: 40,
      SHIELD_REGEN_DELAY: 3.0, SPECIAL_MAX_CHARGE: 15, SPECIAL_RADIUS: 220, SPECIAL_DAMAGE: 150,
      COMBO_TIMEOUT: 2.0, PLAYER_SPEED: 200,
    });
  });
});
