import { describe, test, expect, beforeEach } from 'vitest';
import { newRound } from '../helpers/load-game.js';
import { LANDED } from '../milestones.js';

const type = (g, name) => g.ENEMY_TYPES.findIndex((t) => t.name === name);

let game, g;
beforeEach(() => {
  game = newRound();
  g = game.g;
});

describe('T3 combat: damage application', () => {
  test('T3: damageEnemy subtracts HP, flashes and knocks back along the bullet angle', () => {
    const e = g.spawnEnemy(type(g, 'Heavy'), 100, 0);
    const hp = e.hp;
    g.damageEnemy(e, 30, 0);
    expect(e.hp).toBeCloseTo(hp - 30);
    expect(e.hitFlash).toBeGreaterThan(0);
    expect(e.knockbackX).toBeGreaterThan(0);
    expect(e.knockbackY).toBeCloseTo(0);
    expect(g.enemies).toContain(e);
  });

  test('T3: knockback is smaller for bigger enemies', () => {
    const small = g.spawnEnemy(type(g, 'Runner'), 100, 0);
    const big = g.spawnEnemy(type(g, 'Juggernaut'), -100, 0);
    g.damageEnemy(small, 1, 0);
    g.damageEnemy(big, 1, 0);
    expect(big.knockbackX).toBeLessThan(small.knockbackX);
  });

  test('T3: lethal damage kills, removes the enemy and leaves a body and blood', () => {
    const e = g.spawnEnemy(type(g, 'Militia'), 50, 50);
    g.damageEnemy(e, e.hp + 1, 0);
    expect(e.dead).toBe(true);
    expect(g.enemies).not.toContain(e);
    expect(g.kills).toBe(1);
    expect(g.bodies.length).toBe(1);
    expect(g.bloodPools.length).toBeGreaterThan(0);
    expect(g.particles.some((p) => p.type === 'blood')).toBe(true);
  });

  test('T3: a dead enemy cannot be killed twice', () => {
    const e = g.spawnEnemy(type(g, 'Militia'), 0, 0);
    g.killEnemy(e, 0);
    g.killEnemy(e, 0);
    g.damageEnemy(e, 999, 0);
    expect(g.kills).toBe(1);
  });
});

describe('T3 combat: shields before HP', () => {
  test('T3: enemy shield absorbs damage before HP', () => {
    const e = g.spawnEnemy(type(g, 'Shielded'), 0, 0);
    const hp = e.hp, shield = e.shieldHp;
    expect(shield).toBeGreaterThan(0);
    g.damageEnemy(e, shield / 2, 0);
    expect(e.hp).toBe(hp);
    expect(e.shieldHp).toBeCloseTo(shield / 2);
  });

  test('T3: damage past a breaking enemy shield overflows into HP', () => {
    const e = g.spawnEnemy(type(g, 'Shielded'), 0, 0);
    const hp = e.hp, shield = e.shieldHp;
    g.damageEnemy(e, shield + 10, 0);
    expect(e.shieldHp).toBe(0);
    expect(e.hp).toBeCloseTo(hp - 10);
  });

  test('T3: player shield absorbs damage before HP', () => {
    const p = g.player;
    g.damagePlayer(100);
    expect(p.shield).toBe(g.CFG.PLAYER_MAX_SHIELD - 100);
    expect(p.hp).toBe(g.CFG.PLAYER_MAX_HP);
    expect(g.shieldRegenTimer).toBe(0);
  });

  test('T3: damage past the player shield overflows into HP', () => {
    const p = g.player;
    g.damagePlayer(g.CFG.PLAYER_MAX_SHIELD + 50);
    expect(p.shield).toBe(0);
    expect(p.hp).toBe(g.CFG.PLAYER_MAX_HP - 50);
  });

  test('T3: player takes no damage while invincible or dodging', () => {
    const p = g.player;
    p.invincible = 1;
    g.damagePlayer(500);
    p.invincible = 0;
    p.dodging = true;
    g.damagePlayer(500);
    expect(p.shield).toBe(g.CFG.PLAYER_MAX_SHIELD);
    expect(p.hp).toBe(g.CFG.PLAYER_MAX_HP);
  });

  test('T3: lethal damage triggers SECOND WIND instead of death', () => {
    const p = g.player;
    p.shield = 0;
    g.damagePlayer(p.hp + 100);
    expect(p.hp).toBeCloseTo(p.maxHp * 0.3);
    expect(p.shield).toBeCloseTo(p.maxShield * 0.2);
    expect(p.invincible).toBe(2);
    expect(game.calls.showNotification.map((n) => n.text)).toContain('SECOND WIND!');
  });

  test('T3: shield regenerates only after SHIELD_REGEN_DELAY', () => {
    const p = g.player;
    p.shield = 0;
    g.shieldRegenTimer = 0;
    g.updatePlayer(g.CFG.SHIELD_REGEN_DELAY / 2);
    expect(p.shield).toBe(0);
    g.updatePlayer(g.CFG.SHIELD_REGEN_DELAY / 2 + 0.5);
    expect(p.shield).toBeCloseTo(g.CFG.SHIELD_REGEN * (g.CFG.SHIELD_REGEN_DELAY / 2 + 0.5));
  });
});

describe('T3 combat: combo and score', () => {
  test('T3: kill score is type score x (1 + combo x 0.1)', () => {
    const t = g.ENEMY_TYPES[type(g, 'Heavy')];
    g.killEnemy(g.spawnEnemy(type(g, 'Heavy'), 0, 0), 0);
    expect(g.score).toBe(t.score);
    expect(g.combo).toBe(1);
    g.killEnemy(g.spawnEnemy(type(g, 'Heavy'), 0, 0), 0);
    expect(g.score).toBe(t.score + Math.round(t.score * 1.1));
    expect(g.combo).toBe(2);
    expect(g.bestCombo).toBe(2);
    expect(g.comboTimer).toBe(g.CFG.COMBO_TIMEOUT);
  });

  test('T3: a boss kill is worth 10x the base type score', () => {
    g.bossActive = true;
    g.bossTarget = 1;
    const boss = g.spawnEnemy(0, 0, 0, { name: 'Test', hp: 100 });
    g.killEnemy(boss, 0);
    expect(g.score).toBe(g.ENEMY_TYPES[0].score * 10);
  });

  test('T3: combo resets after COMBO_TIMEOUT with no kills', () => {
    g.waveActive = true;
    g.killEnemy(g.spawnEnemy(0, 0, 0), 0);
    g.updateWaves(g.CFG.COMBO_TIMEOUT - 0.1);
    expect(g.combo).toBe(1);
    g.updateWaves(0.2);
    expect(g.combo).toBe(0);
  });

  test('T3: kills charge the shockwave up to SPECIAL_MAX_CHARGE', () => {
    for (let i = 0; i < g.CFG.SPECIAL_MAX_CHARGE + 5; i++) {
      g.killEnemy(g.spawnEnemy(0, 0, 0), 0);
      g.bossActive = true; // keep weapon-unlock bosses out of this test
    }
    expect(g.player.specialCharge).toBe(g.CFG.SPECIAL_MAX_CHARGE);
  });
});

describe('T3 combat: waves', () => {
  test('T3: enemy HP scales by 4% per wave', () => {
    const t = g.ENEMY_TYPES[0];
    g.wave = 10;
    const e = g.spawnEnemy(0, 0, 0);
    expect(e.hp).toBeCloseTo(t.hp * 1.4);
    expect(e.maxHp).toBeCloseTo(t.hp * 1.4);
  });

  test('T3: wave N spawns 5 + 2N + floor(N/2) enemies', () => {
    for (const n of [1, 2, 5, 10, 20]) {
      const { g: r } = newRound();
      r.wave = n - 1;
      r.waveActive = false;
      r.waveTimer = 0;
      r.updateWaves(0.001);
      expect(r.wave).toBe(n);
      expect(r.waveActive).toBe(true);
      expect(r.enemiesThisWave).toBe(Math.min(5 + 2 * n + Math.floor(n * 0.5), r.CFG.MAX_ENEMIES));
    }
  });

  test('T3: waves only spawn enemy types unlocked at that wave', () => {
    g.wave = 4;
    g.waveActive = true;
    g.enemiesThisWave = 500;
    for (let i = 0; i < 400; i++) g.updateWaves(0.05);
    expect(g.enemies.length).toBeGreaterThan(0);
    for (const e of g.enemies) expect(g.ENEMY_TYPES[e.type].wave).toBeLessThanOrEqual(4);
  });

  test('T3: a wave ends when everything spawned is dead', () => {
    g.wave = 1;
    g.waveActive = true;
    g.enemiesThisWave = 2;
    g.enemiesSpawned = 2;
    g.updateWaves(0.01);
    expect(g.waveActive).toBe(false);
    expect(g.waveTimer).toBe(g.waveCooldown);
  });

  test('T3: regular spawns respect MAX_ENEMIES but bosses do not', () => {
    for (let i = 0; i < g.CFG.MAX_ENEMIES + 10; i++) g.spawnEnemy(0, i, 0);
    expect(g.enemies.length).toBe(g.CFG.MAX_ENEMIES);
    g.spawnEnemy(0, 0, 0, { name: 'Boss', hp: 500 });
    expect(g.enemies.length).toBe(g.CFG.MAX_ENEMIES + 1);
  });
});

describe('T3 combat: bosses and unlocks', () => {
  test('T3: reaching an unlock score spawns a boss instead of unlocking', () => {
    g.score = g.WEAPONS[1].unlock;
    g.checkWeaponUnlocks();
    expect(g.bossActive).toBe(true);
    expect(g.bossTarget).toBe(1);
    expect(g.unlockedWeapons).toBe(1);
    const boss = g.enemies.find((e) => e.isBoss);
    expect(boss.bossName).toBe(g.BOSS_NAMES[0]);
    expect(boss.hp).toBe(300 + 1 * 250);
  });

  test('T3: killing the boss unlocks the weapon', () => {
    g.score = g.WEAPONS[1].unlock;
    g.checkWeaponUnlocks();
    const boss = g.enemies.find((e) => e.isBoss);
    g.damageEnemy(boss, boss.hp + 1, 0);
    expect(g.bossActive).toBe(false);
    expect(g.unlockedWeapons).toBe(2);
  });
});

describe('T3 combat: area damage', () => {
  test('T3: bomber death damages nearby enemies through the deferred queue', () => {
    const bomber = g.spawnEnemy(type(g, 'Bomber'), 0, 0);
    const near = g.spawnEnemy(type(g, 'Heavy'), 20, 0);
    const far = g.spawnEnemy(type(g, 'Heavy'), 500, 0);
    const nearHp = near.hp, farHp = far.hp;
    g.player.x = 5000;
    g.killEnemy(bomber, 0);
    expect(near.hp).toBe(nearHp); // deferred, not applied yet
    g.processPendingDamage();
    expect(near.hp).toBeLessThan(nearHp);
    expect(far.hp).toBe(farHp);
  });

  test('T3: chained bomber explosions terminate and kill the whole chain', () => {
    // Spaced 30 apart: each bomber is inside its neighbour's blast radius, and
    // 80 * (1 - 30/100) = 56 damage exceeds a Bomber's 40 HP.
    const chain = [];
    for (let i = 0; i < 3; i++) chain.push(g.spawnEnemy(type(g, 'Bomber'), i * 30, 0));
    g.player.x = 5000;
    g.killEnemy(chain[0], 0);
    expect(() => g.processPendingDamage()).not.toThrow();
    for (const b of chain) expect(b.dead, `bomber at x=${b.x}`).toBe(true);
    expect(g.enemies.filter((e) => !e.dead)).toHaveLength(0);
    expect(g.kills).toBe(chain.length);
  });

  test('T3: a long bomber chain terminates', () => {
    for (let i = 0; i < 30; i++) g.spawnEnemy(type(g, 'Bomber'), i * 30, 0);
    g.player.x = 50000;
    g.killEnemy(g.enemies[0], 0);
    expect(() => g.processPendingDamage()).not.toThrow();
    expect(g.kills).toBeGreaterThanOrEqual(3);
  });

  test.skipIf(!LANDED.G11)('G11: a 30-bomber chain cascades across frames until every bomber is dead', () => {
    const chain = [];
    // 30 kills pass the Uzi unlock score; with everything unlocked no boss spawns.
    g.unlockedWeapons = g.WEAPONS.length;
    for (let i = 0; i < 30; i++) chain.push(g.spawnEnemy(type(g, 'Bomber'), i * 30, 0));
    g.player.x = 50000;
    g.killEnemy(chain[0], 0);
    // At most 3 rounds per frame (G11 keeps the cap), so allow plenty of frames.
    for (let frame = 0; frame < 30; frame++) g.processPendingDamage();
    for (const b of chain) expect(b.dead, `bomber at x=${b.x}`).toBe(true);
    expect(g.kills).toBe(30);
    expect(g.enemies).toHaveLength(0);
  });

  test.skipIf(!LANDED.G11)('G11: the 3-rounds-per-frame cap is kept', () => {
    const chain = [];
    // 30 kills pass the Uzi unlock score; with everything unlocked no boss spawns.
    g.unlockedWeapons = g.WEAPONS.length;
    for (let i = 0; i < 30; i++) chain.push(g.spawnEnemy(type(g, 'Bomber'), i * 30, 0));
    g.player.x = 50000;
    g.killEnemy(chain[0], 0);
    g.processPendingDamage();
    // One frame must not resolve the whole chain: the rest waits for later frames.
    expect(chain.some((b) => !b.dead)).toBe(true);
  });

  test.skipIf(!LANDED.G11)('G11: the chain also completes through the normal update loop', () => {
    const chain = [];
    // 30 kills pass the Uzi unlock score; with everything unlocked no boss spawns.
    g.unlockedWeapons = g.WEAPONS.length;
    for (let i = 0; i < 30; i++) chain.push(g.spawnEnemy(type(g, 'Bomber'), i * 30, 0));
    g.player.x = 50000;
    g.player.invincible = 1e9;
    g.waveActive = true;
    g.enemiesThisWave = 0;
    g.killEnemy(chain[0], 0);
    for (let frame = 0; frame < 30; frame++) {
      g.processPendingDamage();
      g.updateEnemies(1 / 60);
      g.updateBullets(1 / 60);
      g.processPendingDamage();
    }
    for (const b of chain) expect(b.dead, `bomber at x=${b.x}`).toBe(true);
  });
});

describe('T3 combat: player', () => {
  test('T3: firing spawns player bullets and uses ammo', () => {
    const p = g.player;
    g.mouseX = g.W / 2 + 100;
    g.mouseY = g.H / 2;
    g.mouseJustPressed = true;
    g.updatePlayer(0.016);
    expect(g.bullets.length).toBe(g.WEAPONS[0].count);
    expect(g.bullets[0].owner).toBe('player');
    expect(g.bullets[0].dmg).toBe(g.WEAPONS[0].dmg);
    expect(p.magAmmo).toBe(g.WEAPONS[0].mag - 1);
    expect(p.fireTimer).toBeCloseTo(g.WEAPONS[0].rate);
  });

  test('T3: shotgun fires its pellet count', () => {
    g.unlockedWeapons = g.WEAPONS.length;
    g.player.weapon = 2;
    g.player.magAmmo = g.WEAPONS[2].mag;
    g.mouseJustPressed = true;
    g.updatePlayer(0.016);
    expect(g.bullets.length).toBe(g.WEAPONS[2].count);
  });

  test('T3: an empty magazine starts a reload that refills it', () => {
    const p = g.player;
    p.magAmmo = 0;
    g.updatePlayer(0.016);
    expect(p.reloading).toBe(true);
    g.updatePlayer(g.WEAPONS[0].reload + 0.1);
    expect(p.reloading).toBe(false);
    expect(p.magAmmo).toBe(g.WEAPONS[0].mag);
  });

  test('T3: W moves the player up the screen at PLAYER_SPEED', () => {
    const p = g.player;
    // Keep the player off water (0.55x slowdown) so the speed check is exact.
    p.x = 0; p.y = 0;
    const onWater = g.getTerrainTypeAt(0, 0) === 'water';
    g.keys.w = true;
    const before = g.toScreen(p.x, p.y);
    g.updatePlayer(0.1);
    const after = g.toScreen(p.x, p.y);
    expect(after.y).toBeLessThan(before.y);
    expect(after.x).toBeCloseTo(before.x, 5);
    const moved = Math.hypot(p.x, p.y);
    expect(moved).toBeCloseTo(g.CFG.PLAYER_SPEED * 0.1 * (onWater ? 0.55 : 1), 5);
  });

  test('T3: enemy bullets hurt the player', () => {
    g.bullets.push({ x: 0, y: 0, vx: 0, vy: 0, dmg: 40, life: 1, owner: 'enemy', size: 2 });
    g.updateBullets(0.016);
    expect(g.player.shield).toBe(g.CFG.PLAYER_MAX_SHIELD - 40);
    expect(g.bullets.length).toBe(0);
  });

  test('T3: health pickups heal up to max HP', () => {
    const p = g.player;
    p.hp = p.maxHp - 20;
    g.pickups.push({ x: 0, y: 0, type: 'health', life: 10, amount: 50 });
    g.updatePickups(0.016);
    expect(p.hp).toBe(p.maxHp);
    expect(g.pickups.length).toBe(0);
  });
});
