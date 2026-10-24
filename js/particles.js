// =====================================================================
// PARTICLE SYSTEM - pooled particles with optional z-height physics,
// persistent ground decals, gibs, corpses, shells and damage numbers.
// Pure logic (no PIXI) so it runs headless in the unit tests.
// =====================================================================

// Colours are parsed once at spawn time; the renderer only reads numbers.
const _colorCache = new Map();
function colorToHex(c) {
  if (typeof c === 'number') return c;
  let v = _colorCache.get(c);
  if (v !== undefined) return v;
  if (c[0] === '#') {
    const h = c.slice(1);
    v = h.length === 3 ? parseInt(h[0]+h[0]+h[1]+h[1]+h[2]+h[2], 16) : parseInt(h, 16);
  } else {
    const m = c.match(/\d+/g);
    v = m ? ((+m[0] << 16) | (+m[1] << 8) | +m[2]) : 0xffffff;
  }
  if (_colorCache.size < 256) _colorCache.set(c, v);
  return v;
}

function shadeHex(hex, f) {
  const r = Math.min(255, ((hex >> 16) & 0xff) * f) | 0;
  const g = Math.min(255, ((hex >> 8) & 0xff) * f) | 0;
  const b = Math.min(255, (hex & 0xff) * f) | 0;
  return (r << 16) | (g << 8) | b;
}

// World offset of a screen-space vector (inverse of toScreen without allocating)
function screenDeltaToWorldX(sx, sy) { return (sx + sy / CFG.ISO_SCALE) * 0.5; }
function screenDeltaToWorldY(sx, sy) { return (sy / CFG.ISO_SCALE - sx) * 0.5; }

const BLOOD_COLORS = [0xa01010, 0x8a0c0c, 0xb81818, 0x700808, 0xc42020];
function bloodColor() { return BLOOD_COLORS[(Math.random() * BLOOD_COLORS.length) | 0]; }

// =====================================================================
// PARTICLES
// =====================================================================
const _particleFree = [];
let _particleRecycle = 0;
const _NO_OPTS = {};

// opts: gravity (world-y, legacy), friction, shrink, grow, growRate, alpha,
// fadeStart, rotation, rotSpeed, zGravity, bounce, splat (decal kind on landing), shape
// z / vz: height above ground and its velocity (screen-up)
function spawnParticle(x, y, vx, vy, life, size, color, type='default', opts=_NO_OPTS, z=0, vz=0) {
  let p;
  if (particles.length >= CFG.MAX_PARTICLES) {
    p = particles[_particleRecycle++ % particles.length];
  } else {
    p = _particleFree.pop() || {};
    particles.push(p);
  }
  p.x = x; p.y = y; p.z = z;
  p.vx = vx; p.vy = vy; p.vz = vz;
  p.life = life; p.maxLife = life;
  p.size = size; p.color = colorToHex(color); p.type = type;
  p.gravity = opts.gravity || 0;
  p.friction = opts.friction || 0.98;
  p.shrink = opts.shrink !== undefined ? opts.shrink : true;
  p.grow = opts.grow || false;
  p.growRate = opts.growRate || 0;
  p.alpha = opts.alpha || 1;
  p.fadeStart = opts.fadeStart !== undefined ? opts.fadeStart : 0.5;
  p.rotation = opts.rotation || 0;
  p.rotSpeed = opts.rotSpeed || 0;
  p.zGravity = opts.zGravity || 0;
  p.bounce = opts.bounce || 0;
  p.splat = opts.splat || 0;
  p.shape = opts.shape || 0;
  p.owner = null;
  return p;
}

function _removeParticle(i) {
  const p = particles[i];
  const last = particles.pop();
  if (last !== p) particles[i] = last;
  if (_particleFree.length < CFG.MAX_PARTICLES) _particleFree.push(p);
}

// Shared option objects (no per-spawn allocation in hot paths)
const OPT_BLOOD_DROP = { friction: 0.985, shrink: false, zGravity: 720, splat: 1 /* DECAL_SPLAT */, fadeStart: 0 };
// Droplets that just soak in on landing (keeps the persistent decal budget for bigger marks)
const OPT_BLOOD_DROP_SOAK = { friction: 0.985, shrink: false, zGravity: 720, fadeStart: 0.3 };
const OPT_BLOOD_MIST = { friction: 0.88, shrink: false, fadeStart: 0.6, alpha: 0.85 };
const OPT_DRIP = { friction: 1, shrink: false, zGravity: 500, splat: 1, fadeStart: 0 };
const OPT_FIRE = { friction: 0.9, shrink: false, fadeStart: 0 };
const OPT_SMOKE = { friction: 0.94, shrink: false, grow: true, growRate: 10, fadeStart: 0.5, alpha: 0.8 };
const OPT_DEBRIS = { friction: 0.99, shrink: false, zGravity: 650, bounce: 0.35, fadeStart: 0.15 };
const OPT_SPARK = { friction: 0.9, shrink: false, fadeStart: 0 };
const OPT_FLASH = { shrink: false, fadeStart: 0 };
const OPT_MUZZLE = { shrink: false, fadeStart: 0, friction: 1 };
const OPT_TRAIL = { shrink: true, fadeStart: 0 };
const OPT_DUST = { friction: 0.9, shrink: false, grow: true, growRate: 6, fadeStart: 0.5, alpha: 0.7 };

// =====================================================================
// DECALS - persistent ground marks. Stored in bloodPools so the existing
// batched blood-pool render path (and its counters) still apply.
// =====================================================================
const DECAL_POOL = 0, DECAL_SPLAT = 1, DECAL_SCORCH = 2, DECAL_FOOT = 3,
      DECAL_SMEAR = 4, DECAL_GIB = 5, DECAL_ASH = 6;
let decalVersion = 0;          // bumped whenever the decal set's visuals change
const _growingDecals = [];
const _decalFree = [];

function addDecal(kind, x, y, size, color, angle=0, maxSize=0, color2=0) {
  if (bloodPools.length >= CFG.MAX_BLOOD_POOLS) {
    // Recycle the oldest in one chunk so the batched layer rebuilds rarely
    const removed = bloodPools.splice(0, Math.max(1, CFG.MAX_BLOOD_POOLS >> 3));
    for (const d of removed) { d.growing = false; _decalFree.push(d); }
  }
  const d = _decalFree.pop() || {};
  d.kind = kind; d.x = x; d.y = y;
  d.radius = size; d.maxRadius = Math.max(size, maxSize);
  d.color = color; d.color2 = color2; d.angle = angle;
  d.seed = (Math.random() * 0x7fffffff) | 0;
  d.createdAt = gameTime;
  d.alpha = 1;
  d.growing = maxSize > size;
  d._step = Math.floor(size / 3);
  bloodPools.push(d);
  // A recycled decal may still sit in the growing list; never add it twice
  if (d.growing && !d._inGrow) { d._inGrow = true; _growingDecals.push(d); }
  if (kind === DECAL_POOL || (kind === DECAL_SPLAT && size >= 2.5)) markBloodAt(x, y, d.maxRadius);
  decalVersion++;
  return d;
}

// D6: forget all decal bookkeeping (the decal list itself is bloodPools)
function resetDecalState() {
  _bloodMap.clear();
  for (const d of _growingDecals) d._inGrow = false;
  _growingDecals.length = 0;
  decalVersion++;
}

function updateDecals(dt) {
  for (let i = _growingDecals.length - 1; i >= 0; i--) {
    const d = _growingDecals[i];
    if (d.growing) {
      d.radius += dt * 9;
      if (d.radius >= d.maxRadius) { d.radius = d.maxRadius; d.growing = false; }
      // Visual changes in whole art-pixel steps only
      const step = Math.floor(d.radius / 3);
      if (step !== d._step) { d._step = step; decalVersion++; }
    }
    if (!d.growing) {
      d._inGrow = false;
      const last = _growingDecals.pop();
      if (last !== d) _growingDecals[i] = last;
    }
  }
}

// Coarse "is there blood here" grid for bloody footprints
const _bloodMap = new Map();
const BLOOD_CELL = 12;
function _bloodKey(gx, gy) { return (gx + 32768) * 65536 + (gy + 32768); }
function markBloodAt(x, y, r) {
  if (_bloodMap.size > 40000) _bloodMap.clear();
  const rr = Math.max(4, r * 0.8);
  const gx0 = Math.floor((x - rr) / BLOOD_CELL), gx1 = Math.floor((x + rr) / BLOOD_CELL);
  const gy0 = Math.floor((y - rr) / BLOOD_CELL), gy1 = Math.floor((y + rr) / BLOOD_CELL);
  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gy = gy0; gy <= gy1; gy++) _bloodMap.set(_bloodKey(gx, gy), 1);
  }
}
function isBloodAt(x, y) {
  return _bloodMap.has(_bloodKey(Math.floor(x / BLOOD_CELL), Math.floor(y / BLOOD_CELL)));
}

// =====================================================================
// BLOOD
// =====================================================================
// Cone of arcing droplets along the bullet direction; droplets land as splats
function spawnBloodSpray(x, y, angle, intensity=1, z=12) {
  const count = Math.floor(10 + intensity * 16);
  for (let i = 0; i < count; i++) {
    const a = angle + randRange(-0.55, 0.55);
    const speed = randRange(50, 230) * Math.min(intensity, 2.2);
    spawnParticle(x, y, Math.cos(a) * speed, Math.sin(a) * speed,
      randRange(0.8, 1.6), randRange(1.2, 3.2), bloodColor(), 'blood', (i & 1) ? OPT_BLOOD_DROP : OPT_BLOOD_DROP_SOAK,
      z + randRange(-4, 4), randRange(40, 220) * (0.6 + intensity * 0.3));
  }
  // Short mist puff at the wound
  for (let i = 0; i < Math.floor(2 + intensity * 2); i++) {
    const a = angle + randRange(-0.9, 0.9);
    const speed = randRange(20, 70);
    spawnParticle(x, y, Math.cos(a) * speed, Math.sin(a) * speed,
      randRange(0.12, 0.25), randRange(3, 6), 0xc01818, 'mist', OPT_BLOOD_MIST, z, randRange(0, 30));
  }
  if (intensity >= 1.5) {
    addDecal(DECAL_POOL, x + randRange(-6, 6), y + randRange(-6, 6), 3, BLOOD_COLORS[3], 0, randRange(8, 14) * intensity);
  }
}

// Rhythmic arterial pulse (G6): a high arc from a wound point
function spawnArterialPulse(x, y, z, dirAngle, strength=1) {
  const n = Math.floor(8 + strength * 6);
  for (let i = 0; i < n; i++) {
    const a = dirAngle + randRange(-0.35, 0.35);
    const speed = randRange(40, 130) * strength;
    spawnParticle(x, y, Math.cos(a) * speed, Math.sin(a) * speed,
      3, randRange(1.4, 2.8), bloodColor(), 'blood', OPT_BLOOD_DROP,
      z, randRange(140, 260) * strength);
  }
}

function spawnBloodDrip(x, y, z) {
  spawnParticle(x + randRange(-3, 3), y + randRange(-3, 3), 0, 0, 2, randRange(1.2, 2),
    BLOOD_COLORS[1], 'blood', OPT_DRIP, z, 0);
}

// =====================================================================
// EXPLOSIONS (J1-J3, J5)
// =====================================================================
function spawnExplosion(x, y, radius=80) {
  const k = radius / 80;
  // White core flash (two frames)
  spawnParticle(x, y, 0, 0, 0.035, radius * 0.45, 0xffffff, 'flash', OPT_FLASH, 10, 0);
  // Fireball: expanding rings of frame-stepped fire blobs, rising slightly
  const rings = radius > 150 ? 4 : 3;
  for (let r = 0; r < rings; r++) {
    const n = 8 + r * 5;
    const ringSpeed = (60 + r * 70) * Math.sqrt(k);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + randRange(-0.2, 0.2);
      const sp = ringSpeed * randRange(0.8, 1.15);
      spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
        randRange(0.35, 0.75) * (1 - r * 0.12), randRange(5, 10) * Math.sqrt(k) * (1 - r * 0.15),
        0xffffff, 'fire', OPT_FIRE, randRange(4, 14), randRange(10, 60));
    }
  }
  // Dark smoke columns that linger after the fire
  const smokeCount = Math.floor(8 + radius * 0.08);
  for (let i = 0; i < smokeCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = randRange(10, 60) * Math.sqrt(k);
    spawnParticle(x + Math.cos(a) * radius * 0.2, y + Math.sin(a) * radius * 0.2,
      Math.cos(a) * sp, Math.sin(a) * sp,
      randRange(0.9, 1.8), randRange(5, 9) * Math.sqrt(k),
      i & 1 ? 0x3a3430 : 0x524a42, 'smoke', OPT_SMOKE, randRange(10, 30), randRange(25, 60));
  }
  // Debris shower: dirt clods + tumbling shrapnel that bounce and settle
  const debrisCount = Math.floor(14 + radius * 0.1);
  for (let i = 0; i < debrisCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = randRange(60, 260) * Math.sqrt(k);
    const metal = Math.random() < 0.35;
    const p = spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
      randRange(1.6, 3.2), randRange(1, 2.4),
      metal ? (Math.random() < 0.5 ? 0x8a8a90 : 0x5a5a60) : (Math.random() < 0.5 ? 0x5a4026 : 0x3e2c1a),
      'debris', OPT_DEBRIS, randRange(4, 12), randRange(160, 380) * Math.sqrt(k));
    p.rotSpeed = randRange(-14, 14);
  }
  // Hot sparks
  for (let i = 0; i < 12; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = randRange(200, 420);
    spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp, randRange(0.15, 0.35), 1.2,
      0xffe070, 'spark', OPT_SPARK, randRange(6, 20), randRange(-40, 120));
  }
  // Scorch mark (J2)
  addDecal(DECAL_SCORCH, x, y, radius * 0.38, 0x16100c, Math.random() * Math.PI);

  addShake(Math.min(16, 3 + radius * 0.06));
  if (radius >= 100) addHitStop(radius >= 200 ? 0.06 : 0.04);
  playSound(radius > 150 ? 'big_explosion' : 'explosion', Math.min(1, radius / 100));
}

// =====================================================================
// MUZZLE FLASH, SMOKE, SHELLS, LIGHTNING
// =====================================================================
// angle: world-space aim; scale: weapon-dependent size
// owner: the enemy that fired (renderer snaps the flash to its drawn gun tip)
function spawnMuzzleFlash(x, y, angle, scale=1, z=20, owner=null) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const sAngle = Math.atan2((c + s) * CFG.ISO_SCALE, c - s);
  const p = spawnParticle(x, y, 0, 0, 0.034, 5 * scale, 0xffffff, 'muzzle', OPT_MUZZLE, z, 0);
  p.shape = (Math.random() * 3) | 0;
  p.rotation = sAngle;
  p.owner = owner;
  for (let i = 0; i < 3; i++) {
    const a = angle + randRange(-0.35, 0.35);
    const sp = randRange(140, 260);
    spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp, randRange(0.03, 0.07), 1.2,
      i ? 0xffd040 : 0xffffa0, 'spark', OPT_SPARK, z, randRange(-20, 40));
  }
}

function spawnSmoke(x, y, amount=5) {
  for (let i = 0; i < amount; i++) {
    spawnParticle(x + randRange(-5, 5), y + randRange(-5, 5),
      randRange(-10, 10), randRange(-10, 10),
      randRange(0.4, 1.0), randRange(2.5, 5),
      Math.random() < 0.5 ? 0x9a948c : 0x7c766e, 'smoke', OPT_DUST, randRange(2, 8), randRange(15, 35));
  }
}

const _shellFree = [];
function spawnShellCasing(x, y, angle, size=1) {
  if (shells.length >= CFG.MAX_SHELLS) shells.shift();
  const a = angle + Math.PI / 2 + randRange(-0.4, 0.4);
  const speed = randRange(50, 110);
  const s = _shellFree.pop() || {};
  s.x = x; s.y = y; s.z = 18;
  s.vx = Math.cos(a) * speed; s.vy = Math.sin(a) * speed; s.vz = randRange(80, 150);
  s.life = 4; s.rotation = Math.random() * Math.PI * 2;
  s.rotSpeed = randRange(-18, 18); s.size = size;
  s.bounced = false; s.grounded = false;
  shells.push(s);
}

function spawnLightning(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const d = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(3, Math.floor(d / 10));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const j = i > 0 && i < steps;
    spawnParticle(x1 + dx * t + (j ? randRange(-8, 8) : 0), y1 + dy * t + (j ? randRange(-8, 8) : 0),
      0, 0, randRange(0.07, 0.14), 1.6, i & 1 ? 0xc0c8ff : 0x7080ff, 'spark', OPT_SPARK, 18, 0);
  }
}

function spawnDisintegration(x, y) {
  for (let j = 0; j < 30; j++) {
    spawnParticle(x + randRange(-10, 10), y + randRange(-10, 10),
      randRange(-40, 40), randRange(-40, 40),
      randRange(0.4, 1.0), randRange(1, 2.5),
      j & 1 ? 0xff40ff : 0xa000ff, 'spark', OPT_SPARK, randRange(0, 36), randRange(30, 120));
  }
  addDecal(DECAL_ASH, x, y, 9, 0x2a2228, Math.random() * Math.PI, 0, 0xa040c0);
}

function spawnShockwaveEffect(x, y) {
  shockwaveEffects.push({
    x, y, radius: 10, maxRadius: CFG.SPECIAL_RADIUS, life: 0.5, maxLife: 0.5
  });
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = randRange(150, 400);
    spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
      randRange(0.3, 0.6), randRange(3, 6), 0xffffff, 'fire', OPT_FIRE, randRange(2, 10), randRange(0, 40));
  }
  for (let i = 0; i < 24; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = randRange(80, 200);
    spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
      randRange(0.5, 1.0), randRange(4, 7), 0x8a7a5a, 'smoke', OPT_DUST, 2, randRange(5, 25));
  }
}

// =====================================================================
// GIBS (G5)
// =====================================================================
const GIB_HEAD = 0, GIB_ARM = 1, GIB_LEG = 2, GIB_TORSO = 3, GIB_MEAT = 4;
const _gibFree = [];
function spawnGibs(x, y, angle, typeIdx, power=1, scale=1) {
  const t = ENEMY_TYPES[typeIdx];
  const uniform = colorToHex(t.color);
  const skin = 0xc08858;
  const n = 5 + ((Math.random() * 4) | 0); // 5-8 chunks
  for (let i = 0; i < n; i++) {
    if (gibs.length >= CFG.MAX_GIBS) {
      // Settle the oldest immediately so the cap never drops gore on the floor
      _settleGib(gibs[0]);
      _gibFree.push(gibs.shift());
    }
    const part = i === 0 ? GIB_HEAD : i < 3 ? GIB_ARM : i < 5 ? GIB_LEG : i < 6 ? GIB_TORSO : GIB_MEAT;
    const a = angle + randRange(-1.4, 1.4);
    const sp = randRange(60, 220) * power;
    const g = _gibFree.pop() || {};
    g.x = x + randRange(-4, 4); g.y = y + randRange(-4, 4); g.z = randRange(6, 20) * scale;
    g.vx = Math.cos(a) * sp; g.vy = Math.sin(a) * sp; g.vz = randRange(160, 360) * Math.sqrt(power);
    g.rot = Math.random() * Math.PI * 2; g.rotSpeed = randRange(-16, 16);
    g.part = part;
    g.color = part === GIB_HEAD ? skin : part === GIB_ARM ? (i & 1 ? skin : uniform) :
              part === GIB_LEG ? shadeHex(uniform, 0.75) : part === GIB_TORSO ? uniform : 0x8a1010;
    g.size = (part === GIB_TORSO ? 2.6 : part === GIB_MEAT ? 1.6 : 2) * Math.max(1, scale);
    g.life = 6; g.smear = 0; g.bloodT = 0; g.rest = 0;
    gibs.push(g);
  }
}

function _settleGib(g) {
  addDecal(DECAL_GIB, g.x, g.y, g.size, 0x8a1010, g.rot, 0, g.color);
}

function updateGibs(dt) {
  for (let i = gibs.length - 1; i >= 0; i--) {
    const g = gibs[i];
    g.life -= dt;
    g.vz -= 700 * dt;
    g.z += g.vz * dt;
    g.x += g.vx * dt;
    g.y += g.vy * dt;
    if (g.z > 0) {
      g.rot += g.rotSpeed * dt;
      g.bloodT -= dt;
      if (g.bloodT <= 0) {
        g.bloodT = 0.05;
        spawnParticle(g.x, g.y, g.vx * 0.2, g.vy * 0.2, 2, 1.3, bloodColor(), 'blood', OPT_BLOOD_DROP, g.z, 0);
      }
    } else {
      g.z = 0;
      if (g.vz < -90) {
        g.vz = -g.vz * 0.35;            // bounce
        g.rotSpeed *= 0.5;
        addDecal(DECAL_SPLAT, g.x, g.y, 2.5, bloodColor());
      } else {
        g.vz = 0;
        const f = Math.max(0, 1 - 5 * dt);
        g.vx *= f; g.vy *= f;
        g.rotSpeed *= f;
        const spd = Math.abs(g.vx) + Math.abs(g.vy);
        g.smear += spd * dt;
        if (g.smear > 5) { g.smear = 0; addDecal(DECAL_SMEAR, g.x, g.y, 1.6, BLOOD_COLORS[3]); }
        if (spd < 6) g.rest += dt;
      }
    }
    if (g.rest > 0.25 || g.life <= 0) {
      _settleGib(g);
      const last = gibs.pop();
      if (last !== g) gibs[i] = last;
      _gibFree.push(g);
    }
  }
}

// =====================================================================
// CORPSES - fall/knockback animation, smears, arterial spurts (G5, G6)
// =====================================================================
function updateCorpses(dt) {
  for (const b of bodies) {
    if (b.fall === undefined) continue; // legacy body object
    if (b.fall < 1) b.fall = Math.min(1, b.fall + dt / 0.28);
    if (!b.settled) {
      b.vz -= 700 * dt;
      b.z += b.vz * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.spinAngle += b.spin * dt;
      if (b.z <= 0) {
        b.z = 0;
        if (b.vz < -160) {
          b.vz = -b.vz * 0.25;
          addDecal(DECAL_SPLAT, b.x, b.y, 3, bloodColor());
        } else {
          b.vz = 0;
          const f = Math.max(0, 1 - 6 * dt);
          b.vx *= f; b.vy *= f; b.spin *= f;
          const spd = Math.abs(b.vx) + Math.abs(b.vy);
          b.smear += spd * dt;
          if (b.smear > 6) { b.smear = 0; addDecal(DECAL_SMEAR, b.x, b.y, 2.4 * b.size, BLOOD_COLORS[3]); }
          if (spd < 8 && b.fall >= 1) {
            b.settled = true;
            addDecal(DECAL_POOL, b.x, b.y, 3, BLOOD_COLORS[(Math.random() * 2 + 3) | 0], 0, randRange(13, 22) * b.size);
          }
        }
      }
    }
    // Arterial spurts from the neck: 3-5 pulses over ~1.5 s
    if (b.spurts > 0) {
      b.spurtT -= dt;
      if (b.spurtT <= 0) {
        b.spurts--;
        b.spurtT = randRange(0.28, 0.4);
        // Head offset in screen space for the lying pose, converted to world
        const rot = b.fallDir * Math.PI / 2 * b.fall + b.spinAngle;
        const h = 30 * b.size;
        const hsx = Math.sin(rot) * h, hsy = -Math.cos(rot) * h;
        const nx = b.x + screenDeltaToWorldX(hsx, hsy);
        const ny = b.y + screenDeltaToWorldY(hsx, hsy);
        const dir = Math.atan2(screenDeltaToWorldY(hsx, hsy), screenDeltaToWorldX(hsx, hsy));
        spawnArterialPulse(nx, ny, 4 + 10 * (1 - b.fall), dir, 0.8 + b.spurts * 0.15);
      }
    }
  }
}

// =====================================================================
// DAMAGE NUMBERS (G8)
// =====================================================================
const DMG_NORMAL = 0, DMG_CRIT = 1, DMG_SHIELD = 2;
const _dmgFree = [];
function spawnDamageNumber(target, x, y, value, kind=DMG_NORMAL, z=40) {
  // Rapid-fire hits on the same target merge into one rising number
  const prev = target && target._dmgNum;
  if (prev && prev.owner === target && prev.age < 0.14 && prev.kind === kind && prev.life > 0) {
    prev.value += value;
    prev.age = 0;
    return prev;
  }
  if (dmgNumbers.length >= CFG.MAX_DMG_NUMBERS) _dmgFree.push(dmgNumbers.shift());
  const n = _dmgFree.pop() || {};
  n.owner = target; n.x = x; n.y = y; n.z = z;
  n.vx = randRange(-25, 25); n.vy = randRange(-25, 25); n.vz = randRange(150, 210);
  n.value = value; n.kind = kind;
  n.life = kind === DMG_CRIT ? 1.0 : 0.75; n.maxLife = n.life; n.age = 0;
  dmgNumbers.push(n);
  if (target) target._dmgNum = n;
  return n;
}

function updateDamageNumbers(dt) {
  for (let i = dmgNumbers.length - 1; i >= 0; i--) {
    const n = dmgNumbers[i];
    n.life -= dt; n.age += dt;
    if (n.life <= 0) {
      dmgNumbers.splice(i, 1);
      if (n.owner && n.owner._dmgNum === n) n.owner._dmgNum = null;
      n.owner = null;
      _dmgFree.push(n);
      continue;
    }
    n.vz -= 520 * dt;
    n.z = Math.max(0, n.z + n.vz * dt);
    n.x += n.vx * dt; n.y += n.vy * dt;
  }
}

// =====================================================================
// UPDATE
// =====================================================================
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { _removeParticle(i); continue; }
    p.vx *= p.friction;
    p.vy *= p.friction;
    p.vy += p.gravity * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.grow) p.size += p.growRate * dt;
    else if (p.shrink) p.size *= (1 - dt * 2);
    p.rotation += p.rotSpeed * dt;
    if (p.zGravity !== 0 || p.vz !== 0) {
      p.vz -= p.zGravity * dt;
      p.z += p.vz * dt;
      if (p.z <= 0 && p.vz < 0) {
        p.z = 0;
        if (p.splat) {
          addDecal(p.splat, p.x, p.y, p.size, p.color);
          _removeParticle(i);
          continue;
        }
        if (p.bounce > 0 && p.vz < -60) {
          p.vz = -p.vz * p.bounce;
          p.vx *= 0.55; p.vy *= 0.55;
        } else {
          p.vz = 0; p.zGravity = 0;
          p.vx *= 0.2; p.vy *= 0.2;
          p.rotSpeed = 0;
        }
      }
    }
  }

  // Shell casings: arc out, bounce once, settle (J6)
  for (let i = shells.length - 1; i >= 0; i--) {
    const s = shells[i];
    s.life -= dt;
    if (s.life <= 0) { shells.splice(i, 1); _shellFree.push(s); continue; }
    if (s.grounded) continue;
    s.vz -= 650 * dt;
    s.z += s.vz * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.rotation += s.rotSpeed * dt;
    if (s.z <= 0) {
      s.z = 0;
      if (!s.bounced) {
        s.bounced = true;
        s.vz = -s.vz * 0.35;
        s.vx *= 0.5; s.vy *= 0.5; s.rotSpeed *= 0.5;
      } else {
        s.grounded = true;
        s.vx = 0; s.vy = 0; s.vz = 0;
        s.rotation = Math.round(s.rotation / (Math.PI / 2)) * (Math.PI / 2);
      }
    }
  }

  updateDecals(dt);
  updateGibs(dt);
  updateCorpses(dt);
  updateDamageNumbers(dt);

  // Shockwave effects
  for (let i = shockwaveEffects.length - 1; i >= 0; i--) {
    const sw = shockwaveEffects[i];
    sw.life -= dt;
    if (sw.life <= 0) { shockwaveEffects.splice(i, 1); continue; }
    const t = 1 - sw.life / sw.maxLife;
    sw.radius = sw.maxRadius * t;
  }
}
