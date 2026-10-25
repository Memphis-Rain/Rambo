// =====================================================================
// FIRE (M9 F1-F3) - flamethrower stream, ground fires, burning enemies
// =====================================================================
// Contract (renderer / audio / tests):
//   flames[]        live flame particles { owner: 'player', x, y, z, vx, vy,
//                   t, life, seed } (pooled; not bullets). They slow to a
//                   stop at ~CFG.FLAME_RANGE, stop on the first enemy or
//                   trunk (no pierce) and light a ground fire where they end.
//   groundFires[]   { x, y, t, life, seed }: short-lived; a DECAL_SCORCH (J2)
//                   is left when one ends.
//   enemy.burnT     burn seconds left (> 0 = burning: DoT CFG.BURN_DPS in
//                   CFG.BURN_TICK ticks); enemy.panicT = seconds to the next
//                   panic direction change, enemy.panicDir (radians); bosses
//                   burn but never panic (panicT stays 0).
//   body.charred    a burn death leaves a charred corpse (less blood)
//   burnStats()     { burning, max, ignitions, extinguished }
//   Trees (F3) live in envphys.js: envFlameHeat(obj), envState(id).heat /
//   fire / charred, envStats().burningTrees.

const flames = [];
const _flameFree = [];
const groundFires = [];
const _burnStats = { ignitions: 0, extinguished: 0 };
let _burnN = 0;            // enemies burning (recounted every updateFire)
let _fireFrame = 0;

function spawnFlame(x, y, angle, wep, by = 0) {
  if (flames.length >= CFG.MAX_FLAMES) return null;
  const f = _flameFree.pop() || {};
  const c = Math.cos(angle), s = Math.sin(angle);
  f.owner = 'player';
  f.x = x; f.y = y; f.z = 12;
  f.dirX = c; f.dirY = s;
  f.t = 0; f.life = CFG.FLAME_LIFE * randRange(0.9, 1.1);
  f.v0 = 2 * CFG.FLAME_RANGE / CFG.FLAME_LIFE; // linear slow-down: reach = v0 x life / 2
  f.vx = c * f.v0; f.vy = s * f.v0;
  f.dmg = wep.dmg;
  f.by = by; // M11 K6: the shooter (players[] index)
  f.seed = (Math.random() * 1e9) | 0;
  flames.push(f);
  return f;
}

function _burningCount() {
  let n = 0;
  for (let i = 0; i < enemies.length; i++) if (enemies[i].burnT > 0 && !enemies[i].dead) n++;
  return n;
}

function _panicPick(e) {
  const p = nearestPlayer(e.x, e.y); // M11: away from the nearest standing player
  const away = p ? Math.atan2(e.y - p.y, e.x - p.x) : Math.random() * Math.PI * 2;
  let a = away + randRange(-1.2, 1.2);
  if (e.panicDir !== undefined) {
    let d = a - e.panicDir;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) < 0.35) a += d >= 0 ? 0.7 : -0.7; // erratic: a real turn every time
  }
  e.panicDir = a;
  e.panicT = randRange(CFG.PANIC_MIN, CFG.PANIC_MAX);
}

// F2: light (or refresh) an enemy's burn; false when the cap holds it off.
// by = whose fire it is (M11 K6 kill credit for the burn)
function igniteEnemy(e, by = 0) {
  if (!e || e.dead || waterTileAt(e.x, e.y)) return false; // water: can't catch fire
  if (!(e.burnT > 0)) {
    if (_burnN >= CFG.BURN_MAX) return false;
    _burnN++;
    _burnStats.ignitions++;
    e.burnTick = CFG.BURN_TICK;
    e.contactT = 0;
    if (!e.isBoss) _panicPick(e);
    playSound('scream', 0.35);
  }
  e.burnT = CFG.BURN_TIME;
  e.burnBy = by;
  return true;
}

function _burnOut(e) {
  e.burnT = 0; e.burnTick = 0;
  e.panicT = 0; e.panicDir = undefined;
}

// F2 panic movement (updateEnemies calls it instead of the attack AI)
function firePanicMove(e, dt) {
  if (e.panicDir === undefined) _panicPick(e);
  const sp = e.speed * CFG.PANIC_SPEED;
  e.vx = Math.cos(e.panicDir) * sp;
  e.vy = Math.sin(e.panicDir) * sp;
  e.walking = true;
}

// Burn damage: a light hit (no knockback / stun / blood spray / flash), kill by fire
function burnDamage(e, d) {
  if (e.dead) return;
  e.hp -= d; // no hit flash: the flames are the feedback (no white strobe every tick)
  spawnDamageNumber(e, e.x, e.y, Math.round(d), DMG_NORMAL, 22 * e.size + 16);
  dmgBy = e.burnBy || 0; // M11 K6
  if (e.hp <= 0) killEnemy(e, e.panicDir || 0, SRC_FIRE);
  dmgBy = 0;
}

// A flame lick: contact damage without the bullet path's blood spray, stun
// and knockback (F2 "less blood"; a boss in the stream keeps attacking).
// Shields still absorb it through damageEnemy.
function flameHit(e, dmg, angle) {
  if (e.dead) return;
  if (ENEMY_TYPES[e.type].hasShield && e.shieldHp > 0) { damageEnemy(e, dmg, angle, SRC_FIRE); return; }
  e.hp -= dmg;
  e.hitFlash = HIT_FLASH_TIME;
  spawnDamageNumber(e, e.x, e.y, Math.round(dmg), DMG_NORMAL, 22 * e.size + 16);
  if (e.hp <= 0) killEnemy(e, angle, SRC_FIRE);
}

function _steamPuff(x, y, n) {
  for (let k = 0; k < n; k++) {
    spawnParticle(x + randRange(-6, 6), y + randRange(-4, 4), randRange(-10, 10), randRange(-10, 10),
      randRange(0.5, 0.9), randRange(3, 5), 0xd8dde0, 'smoke', OPT_SMOKE, randRange(6, 16), randRange(20, 40));
  }
}

function _spawnGroundFire(x, y) {
  if (waterTileAt(x, y)) { _steamPuff(x, y, 1); return; }
  for (let i = groundFires.length - 1; i >= 0; i--) {
    const g = groundFires[i];
    const dx = g.x - x, dy = g.y - y;
    if (dx * dx + dy * dy < 16 * 16) { g.life = Math.max(g.life, g.t + randRange(1.2, 2)); return; }
  }
  if (groundFires.length >= CFG.GROUND_FIRE_MAX) _endGroundFire(0);
  groundFires.push({ x, y, t: 0, life: randRange(1.2, 2.2), seed: (Math.random() * 1e9) | 0 });
}

function _endGroundFire(i) {
  const g = groundFires[i];
  addDecal(DECAL_SCORCH, g.x, g.y, randRange(4, 7), 0x16100c, Math.random() * Math.PI); // J2
  groundFires.splice(i, 1);
}

function _updateFlames(dt) {
  for (let i = flames.length - 1; i >= 0; i--) {
    const f = flames[i];
    f.t += dt;
    const k = Math.max(0, 1 - f.t / f.life);
    const v = f.v0 * k;
    f.vx = f.dirX * v; f.vy = f.dirY * v;
    const px = f.x, py = f.y;
    const dx = f.vx * dt, dy = f.vy * dt, len2 = dx * dx + dy * dy;
    f.x += dx; f.y += dy;
    let nearT = 2, nearE = null, nearO = null;
    const minX = Math.min(px, f.x) - 60, maxX = Math.max(px, f.x) + 60;
    const minY = Math.min(py, f.y) - 60, maxY = Math.max(py, f.y) + 60;
    // Trunks / crates stop the stream; flames licking a canopy heat it (F3)
    for (let j = 0; j < envObjects.length; j++) {
      const o = envObjects[j];
      if (o.x < minX || o.x > maxX || o.y < minY || o.y > maxY) continue;
      const tree = o.type === 'tree' || o.type === 'pine' || o.type === 'deadtree';
      if (tree && o.radius) {
        const cx = f.x - o.x, cy = f.y - o.y, cr = o.radius * 0.6;
        if (cx * cx + cy * cy < cr * cr) envFlameHeat(o);
      }
      const hr = envBulletRadius(o);
      if (!hr || len2 === 0) continue;
      const t = segCircleT(px, py, dx, dy, len2, o.x, o.y, hr);
      if (t >= 0 && t < nearT) { nearT = t; nearO = o; nearE = null; }
    }
    for (let j = 0; j < enemies.length; j++) {
      const e = enemies[j];
      if (e.dead || len2 === 0) continue;
      const r = 15 * e.size + 4;
      if (e.x + r < minX || e.x - r > maxX || e.y + r < minY || e.y - r > maxY) continue;
      const t = segCircleT(px, py, dx, dy, len2, e.x, e.y, r);
      if (t >= 0 && t < nearT) { nearT = t; nearE = e; nearO = null; }
    }
    if (nearE || nearO) {
      f.x = px + dx * nearT; f.y = py + dy * nearT;
      if (nearE) {
        dmgBy = f.by; // M11 K6
        flameHit(nearE, f.dmg, Math.atan2(f.dirY, f.dirX));
        dmgBy = 0;
        igniteEnemy(nearE, f.by);
      } else {
        const tt = nearO.type;
        if (tt === 'tree' || tt === 'pine' || tt === 'deadtree') envFlameHeat(nearO);
      }
      flames.splice(i, 1); _flameFree.push(f);
      continue;
    }
    if (f.t >= f.life) {
      _spawnGroundFire(f.x, f.y);
      flames.splice(i, 1); _flameFree.push(f);
    }
  }
}

// F2: DoT ticks, water, contact spread
function _updateBurning(dt) {
  const frame = ++_fireFrame;
  let burning = 0;
  for (let i = enemies.length - 1; i >= 0; i--) { // backward: a burn kill splices enemies[]
    const e = enemies[i];
    if (!e || e.dead || !(e.burnT > 0)) continue;
    if (waterTileAt(e.x, e.y)) { // water puts it out at once
      _burnOut(e);
      _burnStats.extinguished++;
      _steamPuff(e.x, e.y, 5);
      continue;
    }
    burning++;
    // panic clock (here, not in the movement: a stun must not stretch it)
    if (!e.isBoss) { e.panicT -= dt; if (e.panicT <= 1e-9) _panicPick(e); }
    e.burnT -= dt;
    e.burnTick -= dt;
    while (e.burnTick <= 1e-6 && !e.dead) {
      e.burnTick += CFG.BURN_TICK;
      burnDamage(e, CFG.BURN_DPS * CFG.BURN_TICK);
    }
    if (e.dead) continue;
    if (e.burnT <= 1e-6) { _burnOut(e); continue; }
    // Contact: an unburnt enemy touching a burning one accumulates contact time
    for (let j = 0; j < enemies.length; j++) {
      const o = enemies[j];
      if (o === e || o.dead || o.burnT > 0) continue;
      const rr = 10 * ((e.size || 1) + (o.size || 1));
      const dx = o.x - e.x, dy = o.y - e.y;
      if (dx * dx + dy * dy >= rr * rr || o._contactF === frame) continue;
      o._contactF = frame;
      o._contactBy = e.burnBy || 0; // M11 K6: a spread burn is the igniter's
      o.contactT = (o.contactT || 0) + dt;
    }
  }
  _burnN = burning;
  for (let i = 0; i < enemies.length; i++) {
    const o = enemies[i];
    if (!o.contactT) continue;
    if (o._contactF !== frame || o.burnT > 0) { o.contactT = 0; continue; }
    if (o.contactT >= CFG.CONTACT_IGNITE_T - 1e-9) { // one roll per 0.3 s of touching
      o.contactT = 0;
      if (Math.random() < CFG.CONTACT_IGNITE_P) igniteEnemy(o, o._contactBy || 0);
    }
  }
}

function _updateGroundFires(dt) {
  for (let i = groundFires.length - 1; i >= 0; i--) {
    const g = groundFires[i];
    g.t += dt;
    if (g.t >= g.life) _endGroundFire(i);
  }
}

// update(): after updateBullets
function updateFire(dt) {
  _burnN = _burningCount();
  _updateFlames(dt);
  _updateBurning(dt);
  _updateGroundFires(dt);
}

function burnStats() {
  return { burning: _burningCount(), max: CFG.BURN_MAX, ignitions: _burnStats.ignitions, extinguished: _burnStats.extinguished };
}

function resetFire() {
  for (const f of flames) _flameFree.push(f);
  flames.length = 0;
  groundFires.length = 0;
  _burnStats.ignitions = _burnStats.extinguished = 0;
  _burnN = 0;
}
