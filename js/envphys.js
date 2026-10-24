// =====================================================================
// ENVIRONMENT PHYSICS (M8 E2-E9) - pure logic, no PIXI (runs headless).
//
// Env objects (pixi-terrain.js) react to explosions and bullets: trees
// sway, scorch and topple; crates/sandbags break; boulders/ruins crack and
// shatter under the BFG. Only affected objects get a state record, and only
// moving ones are simulated (active set <= CFG.ENV_ACTIVE_MAX); everything
// that has come to rest is handed to the decal (bake) path.
//
// ---------------------------------------------------------------------
// DATA CONTRACT FOR THE RENDERER (read-only for it)
// ---------------------------------------------------------------------
// Per env object: `envObjState(obj)` returns its state record, or null when
// the object was never affected (draw it as today). It also attaches the
// record to `obj._env` (null = untouched); `obj._env` is valid once
// updateEnv() has run, but objects spawned during the current render (chunk
// regeneration) need envObjState(obj) to pick up their persisted state.
// Record fields:
//   state     'standing'|'scorched'|'falling'|'fallen'|'destroyed'
//   sway      radians, signed screen-space lean of the top (+ = leans to
//             screen +x / right). Damped spring, 0 when at rest. Apply as a
//             skew/rotation about the base (trees, pines, bushes, dead trees).
//   swayDirX, swayDirY  world unit vector of the last push (optional use)
//   scorch    0..3 stepped canopy/body darkening (persistent)
//   cracked   boulder/ruins cracked (still solid)
//   fall      0..1 topple rotation progress about the base (eased; 1 = flat)
//   fallDirX, fallDirY  world unit vector the tree falls toward
//   baked     true once a felled tree's stump + log decals exist: from then
//             HIDE the standing sprite (the decals replace it). While
//             state is 'falling' or ('fallen' && !baked) draw the tree rotated
//             by `fall` along fallDir (foreshortened in iso).
//   destroyed objects (state 'destroyed': crate, sandbag, bush, boulder,
//             ruins, exploded barrel): hide the sprite (debris/decals remain).
//   type, x, y, height, radius  copied from the object
//   logLen, logR, stumpR        felled-tree geometry (world units)
//
// Debris (flying pieces): global array `envDebris`, pooled. Fields per piece:
//   x, y (world), z (height above ground, screen-up), rot (radians),
//   kind (DEBRIS_WOOD 0, DEBRIS_SAND 1, DEBRIS_STONE 2, DEBRIS_BARK 3,
//   DEBRIS_LEAF 4), color (0xRRGGBB), size (world px, ~1-4).
//   Settled pieces are removed and become decals (below).
//
// Decals (bloodPools, via addDecal; see particles.js for the kinds):
//   DECAL_WOOD 7, DECAL_RUBBLE 8, DECAL_SAND 9, DECAL_LEAF 10: settled
//     debris; x, y, radius = piece size, color, angle = rot.
//   DECAL_STUMP 11: x, y = tree base, radius = stump radius, color = bark,
//     color2 = cut-wood colour, variant (0 tree, 1 pine, 2 dead tree),
//     scorch (0-3), envId.
//   DECAL_LOG 12: x, y = log CENTRE, angle = world-space direction of the
//     log (atan2(fallDirY, fallDirX)), len = log length (world units),
//     width = log diameter, radius = len / 2 (extent), color = bark,
//     color2 = cut-wood colour, variant, scorch, envId.
//
// Hooks (E9): envState(id), envStats(), resetEnvState(), envBlast(),
// updateEnv(dt); globals envLogs (fallen-log capsules), envDebris.
// =====================================================================

const DEBRIS_WOOD = 0, DEBRIS_SAND = 1, DEBRIS_STONE = 2, DEBRIS_BARK = 3, DEBRIS_LEAF = 4;

// Object categories (by env type)
const ENVK_NONE = 0, ENVK_TREE = 1, ENVK_DEAD = 2, ENVK_BUSH = 3, ENVK_BOX = 4, ENVK_STONE = 5, ENVK_BARREL = 6;
function _envKind(type) {
  switch (type) {
    case 'tree': case 'pine': return ENVK_TREE;
    case 'deadtree': return ENVK_DEAD;
    case 'bush': return ENVK_BUSH;
    case 'crate': case 'sandbag': return ENVK_BOX;
    case 'boulder': case 'ruins': return ENVK_STONE;
    case 'barrel': return ENVK_BARREL;
    default: return ENVK_NONE;
  }
}

const _envStore = new Map();   // E7: stable object id -> state record (whole session)
let _envEpoch = 1;             // bumped by resetEnvState: forces objects to re-attach
let _envAnon = 0;              // ids for objects created without one (tests)
const _envActive = [];         // E8: records being simulated
const _envQueue = [];          // topples waiting for a free active slot
const envLogs = [];            // E5: records of felled trees (log capsules)
const envDebris = [];          // E4: flying debris pieces
const _envDebrisFree = [];
let _envFelled = 0;
let _envBlastSeq = 0;
let _envToppleFrameN = 0;      // topples started this frame (staggering)
let _envLandFrameN = 0;        // landings processed this frame
let _envCheckT = 0;
// E6: set while a falling tree NOT caused by the player hurts enemies;
// killEnemy() then awards no score / combo / kill / special charge
let envNoCredit = false;

const ENV_LEAF_COLORS = [0x3f6a2a, 0x4f7f30, 0x2f5a22, 0x6a8a3a, 0x7a8f36];
const ENV_NEEDLE_COLORS = [0x2a4a2a, 0x355a30, 0x1f3a20, 0x46603a];
const ENV_BARK_COLORS = [0x5a3a1e, 0x4a2e16, 0x6e4a28];
const ENV_DEADWOOD_COLORS = [0x6a5a48, 0x5a4a3a, 0x7c6c58];
const ENV_CRATE_COLORS = [0x7a5428, 0xa07038, 0x5a3c1a];
const ENV_SAND_COLORS = [0xa08e60, 0xb8a474, 0xcfbf8e];
const ENV_STONE_COLORS = [0x56564c, 0x62625a, 0x828278, 0x74746a];
const ENV_RUIN_COLORS = [0x7a766c, 0x9a968a, 0x5e5a52];
const ENV_CUT_WOOD = 0xc8a070;
const _ENV_DEBRIS_DECAL = [DECAL_WOOD, DECAL_SAND, DECAL_RUBBLE, DECAL_WOOD, DECAL_LEAF]; // by DEBRIS_* kind

const OPT_LEAF = { friction: 0.95, shrink: false, zGravity: 90, fadeStart: 0.25 };
const OPT_LEAF_SPLAT = { friction: 0.95, shrink: false, zGravity: 90, fadeStart: 0, splat: DECAL_LEAF };
const OPT_BARK = { friction: 0.97, shrink: false, zGravity: 600, bounce: 0.3, fadeStart: 0.2 };

function _pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

// ---------------------------------------------------------------------
// Attach / records (E7)
// ---------------------------------------------------------------------
// Default collision of an object that has none in the generator: dead-tree
// trunks, crates and sandbags are solid (E5); destroyed ones lose it.
function _envDefaultCollision(o) {
  switch (o.type) {
    case 'deadtree': return CFG.ENV_DEADTREE_R;
    case 'crate': return CFG.ENV_CRATE_R;
    case 'sandbag': return Math.max(8, (o.width || 36) * CFG.ENV_SANDBAG_RF);
    default: return 0;
  }
}

// Lazy attach: returns the object's state record (null if untouched) and
// applies a persisted state to a freshly (re)generated object. Cheap
// after the first call per object (one compare).
function envObjState(o) {
  if (o._envAt === _envEpoch) return o._env;
  o._envAt = _envEpoch;
  if (o.id === undefined) o.id = 'env~' + (++_envAnon);
  if (o.collision === undefined) {
    const c = _envDefaultCollision(o);
    if (c > 0) o.collision = c;
  }
  const r = _envStore.size ? _envStore.get(o.id) : undefined;
  o._env = r || null;
  if (r) { r.obj = o; _envApplyObj(o, r); }
  return o._env;
}

// Mirror a record's state onto its object (collision, barrel flags)
function _envApplyObj(o, r) {
  if (r.kind === ENVK_BARREL) {
    if (r.state === 'destroyed') { o.exploded = true; o.hp = 0; }
    return;
  }
  if (r.state === 'destroyed') o.collision = 0;
  else if (r.state === 'falling' || r.state === 'fallen') o.collision = r.stumpR;
  else if (r.baseCol) o.collision = r.baseCol;
}

function _envDefaultHp(type) {
  switch (type) {
    case 'tree': case 'pine': return CFG.ENV_TREE_HP;
    case 'deadtree': return CFG.ENV_DEADTREE_HP;
    case 'bush': return CFG.ENV_BUSH_HP;
    case 'crate': return CFG.ENV_CRATE_HP;
    case 'sandbag': return CFG.ENV_SANDBAG_HP;
    case 'barrel': return 30;
    default: return CFG.ENV_TREE_HP;
  }
}

// Get or create the record of an object
function _envRecord(o) {
  let r = envObjState(o);
  if (r) return r;
  const kind = _envKind(o.type);
  const hp = _envDefaultHp(o.type);
  const dead = kind === ENVK_DEAD;
  r = {
    id: o.id, type: o.type, kind, obj: o,
    x: o.x, y: o.y, height: o.height || 0, radius: o.radius || 0,
    baseCol: o.collision || 0,
    state: 'standing', hp, maxHp: hp,
    scorch: 0, cracked: false,
    sway: 0, swayV: 0, swayDirX: 1, swayDirY: 0,
    fall: 0, fallT: 0, fallDur: 0, fallDelay: 0, fallDirX: 1, fallDirY: 0,
    byPlayer: false, landed: false, baked: false, bakeT: 0,
    logLen: 0, logR: dead ? CFG.ENV_LOG_R * 0.7 : CFG.ENV_LOG_R,
    stumpR: dead ? CFG.ENV_STUMP_R * 0.8 : CFG.ENV_STUMP_R,
    ax: 0, ay: 0, bx: 0, by: 0,
    active: false, queued: false, blastSeq: 0,
    stumpDecal: null, logDecal: null,
  };
  _envStore.set(r.id, r);
  o._env = r;
  return r;
}

function _envSyncObj(r) { if (r.obj) _envApplyObj(r.obj, r); }

function _envActivate(r) {
  if (r.active) return true;
  if (_envActive.length >= CFG.ENV_ACTIVE_MAX) return false;
  r.active = true;
  _envActive.push(r);
  return true;
}

// ---------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------
// Leaves from a crown at (x, y), height top (defaults: the standing crown)
function _envLeafBurst(r, n, ux, uy, power, x = r.x, y = r.y, top = r.kind === ENVK_BUSH ? 10 : Math.max(20, r.height * 0.6)) {
  if (n <= 0) return;
  const pal = r.type === 'pine' ? ENV_NEEDLE_COLORS : ENV_LEAF_COLORS;
  const dark = 1 - r.scorch * 0.18;
  const spread = Math.max(8, r.radius * 0.6);
  for (let i = 0; i < n; i++) {
    const a = Math.atan2(uy, ux) + randRange(-1.3, 1.3);
    const sp = randRange(20, 90) * power;
    let c = _pick(pal);
    if (r.scorch) c = shadeHex(c, dark);
    spawnParticle(x + randRange(-spread, spread), y + randRange(-spread, spread),
      Math.cos(a) * sp, Math.sin(a) * sp, randRange(1.6, 2.8), randRange(1.1, 1.9), c, 'leaf',
      (i & 7) === 0 ? OPT_LEAF_SPLAT : OPT_LEAF, top + randRange(-10, 10), randRange(10, 70) * power);
  }
}

function _envSmokePuff(x, y, z, n) {
  for (let i = 0; i < n; i++) {
    spawnParticle(x + randRange(-8, 8), y + randRange(-8, 8), randRange(-8, 8), randRange(-8, 8),
      randRange(0.8, 1.5), randRange(3, 5), i & 1 ? 0x3a3430 : 0x524a42, 'smoke', OPT_SMOKE, z + randRange(-6, 6), randRange(15, 35));
  }
}

function _envDust(x, y, n, spread) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = randRange(15, 60);
    spawnParticle(x + Math.cos(a) * spread * Math.random(), y + Math.sin(a) * spread * Math.random(),
      Math.cos(a) * sp, Math.sin(a) * sp, randRange(0.5, 1.0), randRange(3, 6),
      i & 1 ? 0x8a7a5a : 0x9a8a6a, 'smoke', OPT_DUST, 2, randRange(5, 25));
  }
}

// Pooled debris piece (E4/E8). When the pool is full the oldest settles
// and bakes first.
function spawnEnvDebris(x, y, z, vx, vy, vz, kind, color, size) {
  if (envDebris.length >= CFG.MAX_DEBRIS) {
    const old = envDebris.shift();
    _envSettleDebris(old);
    _envDebrisFree.push(old);
  }
  const d = _envDebrisFree.pop() || {};
  d.x = x; d.y = y; d.z = z; d.vx = vx; d.vy = vy; d.vz = vz;
  d.rot = Math.random() * Math.PI * 2; d.rotSpeed = randRange(-14, 14);
  d.kind = kind; d.color = color; d.size = size;
  d.life = 5; d.rest = 0;
  envDebris.push(d);
  return d;
}

function _envSettleDebris(d) {
  d.z = 0;
  addDecal(_ENV_DEBRIS_DECAL[d.kind] | 0, d.x, d.y, d.size, d.color, d.rot);
}

function _envDebrisBurst(x, y, z, n, kind, pal, ux, uy, power, sizeMin, sizeMax) {
  for (let i = 0; i < n; i++) {
    const a = (ux || uy) ? Math.atan2(uy, ux) + randRange(-1.4, 1.4) : Math.random() * Math.PI * 2;
    const sp = randRange(40, 170) * power;
    spawnEnvDebris(x + randRange(-4, 4), y + randRange(-4, 4), z + randRange(0, 8),
      Math.cos(a) * sp, Math.sin(a) * sp, randRange(80, 260) * Math.sqrt(power),
      kind, _pick(pal), randRange(sizeMin, sizeMax));
  }
}

// Sway impulse along world direction (ux, uy); strength in rad/s
function _envSway(r, ux, uy, strength) {
  if (!_envActivate(r)) return; // E8: active set full -> skip the (cosmetic) sway
  // screen-x component of the push: toScreen x = wx - wy
  let sx = (ux - uy) * 0.7071;
  if (sx > -0.35 && sx < 0.35) sx = sx < 0 ? -0.35 : 0.35; // toward/away from camera: still visibly lean
  r.swayV += sx * strength;
  r.swayDirX = ux; r.swayDirY = uy;
}

// ---------------------------------------------------------------------
// State changes
// ---------------------------------------------------------------------
function _envTopple(r, ux, uy, delay, byPlayer) {
  r.state = 'falling';
  r.fallDirX = ux; r.fallDirY = uy;
  r.fall = 0; r.fallT = 0;
  r.fallDur = randRange(CFG.ENV_FALL_MIN, CFG.ENV_FALL_MAX);
  // E8: stagger simultaneous topples (shock front + a few frames each)
  r.fallDelay = delay + _envToppleFrameN * CFG.ENV_TOPPLE_STAGGER;
  _envToppleFrameN++;
  r.byPlayer = !!byPlayer;
  r.logLen = Math.max(20, (r.height || 50) * CFG.ENV_LOG_LEN);
  _envSyncObj(r); // trunk snapped: only the stump still blocks
  // snap: bark splinters at the base
  _envDebrisBurst(r.x, r.y, 4, 3, DEBRIS_BARK, r.kind === ENVK_DEAD ? ENV_DEADWOOD_COLORS : ENV_BARK_COLORS, ux, uy, 0.7, 1.2, 2.2);
  if (!_envActivate(r) && !r.queued) { r.queued = true; _envQueue.push(r); }
}

function _envDestroy(r, ux, uy, power) {
  r.state = 'destroyed';
  r.hp = 0;
  _envSyncObj(r);
  const p = Math.max(0.5, power);
  switch (r.type) {
    case 'crate':
      _envDebrisBurst(r.x, r.y, 6, 12, DEBRIS_WOOD, ENV_CRATE_COLORS, ux, uy, p, 1.5, 3.5);
      _envDust(r.x, r.y, 3, 6);
      break;
    case 'sandbag':
      _envDebrisBurst(r.x, r.y, 4, 10, DEBRIS_SAND, ENV_SAND_COLORS, ux, uy, p * 0.8, 1.6, 3.2);
      for (let i = 0; i < 8; i++) {
        const a = Math.random() * Math.PI * 2, sp = randRange(20, 80);
        spawnParticle(r.x + randRange(-10, 10), r.y + randRange(-6, 6), Math.cos(a) * sp, Math.sin(a) * sp,
          randRange(0.6, 1.2), randRange(3, 6), _pick(ENV_SAND_COLORS), 'smoke', OPT_DUST, 4, randRange(10, 40));
      }
      break;
    case 'boulder':
    case 'ruins': {
      const pal = r.type === 'ruins' ? ENV_RUIN_COLORS : ENV_STONE_COLORS;
      const n = r.type === 'ruins' ? 14 : 8 + Math.round(r.radius / 4);
      _envDebrisBurst(r.x, r.y, 6, n, DEBRIS_STONE, pal, ux, uy, p, 1.8, 4);
      _envDust(r.x, r.y, 6, 12);
      break;
    }
    case 'bush':
      _envLeafBurst(r, 14, ux, uy, 1.2);
      _envDebrisBurst(r.x, r.y, 6, 4, DEBRIS_LEAF, ENV_LEAF_COLORS, ux, uy, 0.8, 1.5, 2.5);
      break;
    default:
      break;
  }
}

// A felled trunk hits the ground (E2 impact, E5 log capsule, E6 damage)
function _envLand(r) {
  r.state = 'fallen';
  r.fall = 1;
  r.landed = true;
  const ux = r.fallDirX, uy = r.fallDirY;
  r.ax = r.x + ux * (r.stumpR + 2); r.ay = r.y + uy * (r.stumpR + 2);
  r.bx = r.x + ux * r.logLen; r.by = r.y + uy * r.logLen;
  if (envLogs.indexOf(r) < 0) envLogs.push(r);
  _envFelled++;
  r.bakeT = CFG.ENV_BAKE_DELAY;

  // Impact: dust along the trunk, leaves from the crown, shake (J5a cap)
  const mx = (r.ax + r.bx) * 0.5, my = (r.ay + r.by) * 0.5;
  _envDust(mx, my, 6, r.logLen * 0.45);
  if (r.kind === ENVK_TREE) _envLeafBurst(r, 12, ux, uy, 0.8, r.bx - ux * r.logLen * 0.2, r.by - uy * r.logLen * 0.2, 12);
  _envDebrisBurst(r.bx, r.by, 4, 2, DEBRIS_BARK, r.kind === ENVK_DEAD ? ENV_DEADWOOD_COLORS : ENV_BARK_COLORS, ux, uy, 0.5, 1.2, 2);
  addShake(Math.min(CFG.ENV_FALL_SHAKE, 2 + r.height * 0.04));
  if (typeof playSound === 'function') playSound('hit', 0.5);

  // E6: everyone under the trunk takes damage once
  const rr = r.logR;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!e || e.dead) continue;
    const er = rr + 8 * (e.size || 1);
    if (envSegDist2(e.x, e.y, r) < er * er) {
      // pushed off sideways, away from the log axis
      const side = (e.x - r.x) * -uy + (e.y - r.y) * ux;
      const ang = Math.atan2(side >= 0 ? ux : -ux, side >= 0 ? -uy : uy);
      envNoCredit = !r.byPlayer;
      damageEnemy(e, CFG.ENV_FALL_ENEMY_DMG, ang, SRC_BULLET);
      envNoCredit = false;
    }
  }
  if (player) {
    const pr = rr + 10;
    if (envSegDist2(player.x, player.y, r) < pr * pr) damagePlayer(CFG.ENV_FALL_PLAYER_DMG);
  }
}

// Stump + log go into the decal (bake) layer
function _envBake(r) {
  r.baked = true;
  const variant = r.type === 'pine' ? 1 : r.kind === ENVK_DEAD ? 2 : 0;
  const bark = shadeHex(r.kind === ENVK_DEAD ? ENV_DEADWOOD_COLORS[0] : ENV_BARK_COLORS[0], 1 - r.scorch * 0.15);
  const s = addDecal(DECAL_STUMP, r.x, r.y, r.stumpR, bark, 0, 0, ENV_CUT_WOOD);
  s.variant = variant; s.scorch = r.scorch; s.envId = r.id;
  const len = Math.hypot(r.bx - r.ax, r.by - r.ay);
  const l = addDecal(DECAL_LOG, (r.ax + r.bx) * 0.5, (r.ay + r.by) * 0.5, len * 0.5, bark,
    Math.atan2(r.fallDirY, r.fallDirX), 0, ENV_CUT_WOOD);
  l.len = len; l.width = r.logR * 2; l.variant = variant; l.scorch = r.scorch; l.envId = r.id;
  r.stumpDecal = s; r.logDecal = l;
}

function _envDecalAlive(d, r, kind) { return !!d && d.kind === kind && d.envId === r.id; }

// ---------------------------------------------------------------------
// Explosions (E2/E4). spawnExplosion() calls this once per explosion.
// ---------------------------------------------------------------------
function envBlast(x, y, R, byPlayer = false, src = SRC_EXPLOSIVE) {
  if (!(R > 0)) return;
  const bfg = src === SRC_BFG || R >= CFG.ENV_BFG_RADIUS;
  const seq = ++_envBlastSeq;
  for (let i = 0; i < envObjects.length; i++) {
    const o = envObjects[i];
    const dx = o.x - x, dy = o.y - y;
    if (dx >= R || dx <= -R || dy >= R || dy <= -R) continue;
    const d2 = dx * dx + dy * dy;
    if (d2 >= R * R) continue;
    const kind = _envKind(o.type);
    if (kind === ENVK_NONE || kind === ENVK_BARREL) continue;
    const r = _envRecord(o);
    if (r.blastSeq === seq) continue; // duplicate object with the same id
    r.blastSeq = seq;
    const d = Math.sqrt(d2);
    const f = 1 - d / R;
    let ux, uy;
    if (d > 0.01) { ux = dx / d; uy = dy / d; } else { const a = Math.random() * Math.PI * 2; ux = Math.cos(a); uy = Math.sin(a); }
    _envBlastOne(r, f, ux, uy, d, byPlayer, bfg);
  }
}

function _envBlastOne(r, f, ux, uy, d, byPlayer, bfg) {
  if (r.state === 'destroyed' || r.state === 'falling' || r.state === 'fallen') return;
  const kind = r.kind;
  const scorch = f > CFG.ENV_SCORCH_F;
  if (scorch && r.scorch < 3) {
    r.scorch++;
    if (r.state === 'standing') r.state = 'scorched';
  }

  if (kind === ENVK_TREE || kind === ENVK_DEAD || kind === ENVK_BUSH) {
    r.hp -= f * CFG.ENV_BLAST_DMG;
    const th = kind === ENVK_DEAD ? CFG.ENV_DEADTREE_TOPPLE_F : CFG.ENV_TOPPLE_F;
    if (f > th || r.hp <= 0) {
      r.hp = 0;
      if (kind === ENVK_BUSH) { _envDestroy(r, ux, uy, f * 1.5); return; }
      if (kind === ENVK_TREE) _envLeafBurst(r, Math.round(f * CFG.ENV_LEAF_BURST), ux, uy, 0.5 + f);
      _envTopple(r, ux, uy, d / CFG.ENV_SHOCK_SPEED, byPlayer);
      return;
    }
    _envSway(r, ux, uy, f * CFG.ENV_SWAY_IMPULSE);
    if (kind !== ENVK_DEAD) _envLeafBurst(r, Math.round(f * CFG.ENV_LEAF_BURST), ux, uy, 0.5 + f);
    if (scorch) _envSmokePuff(r.x, r.y, kind === ENVK_BUSH ? 8 : Math.max(16, r.height * 0.6), 3);
  } else if (kind === ENVK_BOX) {
    r.hp -= f * CFG.ENV_BLAST_DMG;
    if (f > CFG.ENV_BREAK_F || r.hp <= 0) _envDestroy(r, ux, uy, 0.6 + f);
  } else if (kind === ENVK_STONE) {
    if (bfg && f > CFG.ENV_SHATTER_F) _envDestroy(r, ux, uy, 0.6 + f);
    else if (f > CFG.ENV_CRACK_F && !r.cracked) {
      r.cracked = true;
      _envDebrisBurst(r.x, r.y, 6, 3, DEBRIS_STONE, r.type === 'ruins' ? ENV_RUIN_COLORS : ENV_STONE_COLORS, ux, uy, 0.6, 1.2, 2.2);
    }
  }
}

// ---------------------------------------------------------------------
// Bullets (E3/E4): combat.js calls this when a bullet path hits an env
// blocker (trunk, stump, crate, sandbag). (hx, hy) = impact point.
// ---------------------------------------------------------------------
function envBulletHit(o, hx, hy, vx, vy, dmg) {
  const kind = _envKind(o.type);
  const sp = Math.sqrt(vx * vx + vy * vy) || 1;
  const ux = vx / sp, uy = vy / sp;
  if (kind === ENVK_TREE || kind === ENVK_DEAD) {
    const r = envObjState(o);
    const felled = r && (r.state === 'falling' || r.state === 'fallen');
    // bark chips fly back toward the shooter
    const bark = kind === ENVK_DEAD ? ENV_DEADWOOD_COLORS : ENV_BARK_COLORS;
    for (let i = 0; i < 3; i++) {
      const a = Math.atan2(-uy, -ux) + randRange(-1.1, 1.1);
      const s = randRange(40, 120);
      const p = spawnParticle(hx, hy, Math.cos(a) * s, Math.sin(a) * s, randRange(0.5, 0.9), randRange(1, 1.8),
        _pick(bark), 'debris', OPT_BARK, randRange(6, 16), randRange(40, 120));
      p.rotSpeed = randRange(-12, 12);
    }
    if (felled) return; // stump: chips only
    if (kind === ENVK_TREE) {
      // a leaf or two drift down from the crown, and a tiny sway (never fells)
      const rec = _envRecord(o);
      _envLeafBurst(rec, 1 + (Math.random() < 0.5 ? 1 : 0), ux, uy, 0.3);
      _envSway(rec, ux, uy, CFG.ENV_BULLET_SWAY);
    }
    return;
  }
  if (kind === ENVK_BOX) {
    const r = _envRecord(o);
    if (r.state === 'destroyed') return;
    r.hp -= dmg;
    const pal = o.type === 'crate' ? ENV_CRATE_COLORS : ENV_SAND_COLORS;
    for (let i = 0; i < 2; i++) {
      const a = Math.atan2(-uy, -ux) + randRange(-1, 1), s = randRange(30, 90);
      spawnParticle(hx, hy, Math.cos(a) * s, Math.sin(a) * s, randRange(0.4, 0.8), randRange(1, 1.6),
        _pick(pal), o.type === 'crate' ? 'debris' : 'smoke', o.type === 'crate' ? OPT_BARK : OPT_DUST, 6, randRange(30, 90));
    }
    if (r.hp <= 0) _envDestroy(r, ux, uy, 0.8);
  }
}

// Radius with which an env object stops/catches bullets (0 = none)
function envBulletRadius(o) {
  const t = o.type;
  if (t !== 'tree' && t !== 'pine' && t !== 'deadtree' && t !== 'crate' && t !== 'sandbag') return 0;
  if (o._envAt !== _envEpoch) envObjState(o);
  return o.collision || 0;
}

// Barrels exploding persist too (E7)
function envMarkDestroyed(o) {
  const r = _envRecord(o);
  r.state = 'destroyed';
  r.hp = 0;
}

// ---------------------------------------------------------------------
// Geometry (E5)
// ---------------------------------------------------------------------
// Squared distance from (px, py) to a felled tree's log segment
function envSegDist2(px, py, r) {
  const dx = r.bx - r.ax, dy = r.by - r.ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - r.ax) * dx + (py - r.ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = r.ax + dx * t - px, qy = r.ay + dy * t - py;
  return qx * qx + qy * qy;
}

// Push an entity (circle) out of every fallen-log capsule (movement only:
// bullets fly over logs)
function resolveEnvLogs(entity, entityRadius) {
  for (let i = 0; i < envLogs.length; i++) {
    const r = envLogs[i];
    const rr = entityRadius + r.logR;
    const ex = entity.x, ey = entity.y;
    if (ex < Math.min(r.ax, r.bx) - rr || ex > Math.max(r.ax, r.bx) + rr ||
        ey < Math.min(r.ay, r.by) - rr || ey > Math.max(r.ay, r.by) + rr) continue;
    const dx = r.bx - r.ax, dy = r.by - r.ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((ex - r.ax) * dx + (ey - r.ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = r.ax + dx * t, qy = r.ay + dy * t;
    let ox = ex - qx, oy = ey - qy;
    const d2 = ox * ox + oy * oy;
    if (d2 >= rr * rr) continue;
    let d = Math.sqrt(d2);
    if (d < 1e-4) { ox = -r.fallDirY; oy = r.fallDirX; d = 1; } // on the axis: push sideways
    else { ox /= d; oy /= d; }
    const push = rr - (d2 < 1e-8 ? 0 : d);
    entity.x += ox * push;
    entity.y += oy * push;
  }
}

// ---------------------------------------------------------------------
// Update (called from update(dt) in main.js)
// ---------------------------------------------------------------------
function updateEnv(dt) {
  _envToppleFrameN = 0;
  _envLandFrameN = 0;

  // E7: attach persisted state to objects spawned since last frame
  for (let i = 0; i < envObjects.length; i++) {
    const o = envObjects[i];
    if (o._envAt !== _envEpoch) envObjState(o);
  }

  // E8: queued topples take free slots
  while (_envQueue.length && _envActive.length < CFG.ENV_ACTIVE_MAX) {
    const r = _envQueue.shift();
    r.queued = false;
    _envActivate(r);
  }

  const K = CFG.ENV_SWAY_K, C = CFG.ENV_SWAY_DAMP;
  for (let i = _envActive.length - 1; i >= 0; i--) {
    const r = _envActive[i];
    // Damped spring sway (semi-implicit Euler, stable at dt <= 0.05)
    if (r.sway !== 0 || r.swayV !== 0) {
      r.swayV += (-K * r.sway - C * r.swayV) * dt;
      r.sway += r.swayV * dt;
      if (r.sway > 0.6) { r.sway = 0.6; if (r.swayV > 0) r.swayV = 0; }
      else if (r.sway < -0.6) { r.sway = -0.6; if (r.swayV < 0) r.swayV = 0; }
    }
    if (r.state === 'falling') {
      if (r.fallDelay > 0) r.fallDelay -= dt;
      else {
        r.fallT += dt;
        const k = Math.min(1, r.fallT / r.fallDur);
        r.fall = k * k; // accelerates like a real topple
        if (k >= 1) {
          // E8: at most a few landings (particles, damage) per frame
          if (_envLandFrameN < CFG.ENV_LAND_PER_FRAME) { _envLandFrameN++; _envLand(r); }
        }
      }
    } else if (r.state === 'fallen' && !r.baked) {
      r.bakeT -= dt;
      if (r.bakeT <= 0) _envBake(r);
    }
    // Sleep once settled
    const moving = r.state === 'falling' || (r.state === 'fallen' && !r.baked);
    if (!moving && r.sway < 0.01 && r.sway > -0.01 && r.swayV < 0.05 && r.swayV > -0.05) {
      r.sway = 0; r.swayV = 0;
      r.active = false;
      const last = _envActive.pop();
      if (last !== r) _envActive[i] = last;
    }
  }

  updateEnvDebris(dt);

  // Felled-tree decals can be recycled under MAX_BLOOD_POOLS: re-bake them
  _envCheckT -= dt;
  if (_envCheckT <= 0) {
    _envCheckT = 0.5;
    for (let i = 0; i < envLogs.length; i++) {
      const r = envLogs[i];
      // only near the player: far chunks re-bake when the player comes back
      if (player && (r.x - player.x > 1500 || player.x - r.x > 1500 || r.y - player.y > 1500 || player.y - r.y > 1500)) continue;
      if (r.baked && (!_envDecalAlive(r.stumpDecal, r, DECAL_STUMP) || !_envDecalAlive(r.logDecal, r, DECAL_LOG))) _envBake(r);
    }
  }
}

function updateEnvDebris(dt) {
  let w = 0;
  for (let i = 0; i < envDebris.length; i++) {
    const d = envDebris[i];
    const leaf = d.kind === DEBRIS_LEAF;
    d.life -= dt;
    d.vz -= (leaf ? 140 : 650) * dt;
    if (leaf && d.vz < -45) d.vz = -45;
    d.z += d.vz * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    if (d.z > 0) {
      d.rot += d.rotSpeed * dt;
      if (leaf) { const fr = Math.max(0, 1 - 2.5 * dt); d.vx *= fr; d.vy *= fr; }
    } else {
      d.z = 0;
      if (!leaf && d.vz < -70) {
        d.vz = -d.vz * (d.kind === DEBRIS_SAND ? 0.12 : d.kind === DEBRIS_STONE ? 0.22 : 0.32);
        d.vx *= 0.6; d.vy *= 0.6; d.rotSpeed *= 0.5;
      } else {
        d.vz = 0;
        const fr = Math.max(0, 1 - 6 * dt);
        d.vx *= fr; d.vy *= fr; d.rotSpeed *= fr;
        if (Math.abs(d.vx) + Math.abs(d.vy) < 8) d.rest += dt;
      }
    }
    if (d.rest > 0.15 || d.life <= 0) {
      _envSettleDebris(d);
      _envDebrisFree.push(d);
      continue;
    }
    envDebris[w++] = d;
  }
  envDebris.length = w;
}

// ---------------------------------------------------------------------
// Reset & hooks (E7, E9)
// ---------------------------------------------------------------------
// resetRound() (new game and demo, D6): intact world, nothing in flight
function resetEnvState() {
  for (const r of _envStore.values()) {
    const o = r.obj;
    if (!o) continue;
    if (r.kind === ENVK_BARREL) { o.exploded = false; o.hp = o.maxHp || 30; }
    else if (r.baseCol) o.collision = r.baseCol;
    o._env = null;
    r.obj = null;
  }
  _envStore.clear();
  _envEpoch++;
  for (const r of _envActive) r.active = false;
  _envActive.length = 0;
  _envQueue.length = 0;
  envLogs.length = 0;
  for (const d of envDebris) _envDebrisFree.push(d);
  envDebris.length = 0;
  _envFelled = 0;
  _envToppleFrameN = 0;
  _envLandFrameN = 0;
  _envCheckT = 0;
  envNoCredit = false;
}

// E9: { state, hp, sway } (+ scorch, cracked, fall) for an object id
function envState(id) {
  const r = _envStore.get(id);
  if (r) return { state: r.state, hp: r.hp, sway: r.sway, scorch: r.scorch, cracked: r.cracked, fall: r.fall };
  let hp = CFG.ENV_TREE_HP;
  for (let i = 0; i < envObjects.length; i++) {
    if (envObjects[i].id === id) { hp = _envDefaultHp(envObjects[i].type); break; }
  }
  return { state: 'standing', hp, sway: 0, scorch: 0, cracked: false, fall: 0 };
}

// E9: { active, debris, felled } (+ queued, logs, stored)
function envStats() {
  return {
    active: _envActive.length,
    debris: envDebris.length,
    felled: _envFelled,
    queued: _envQueue.length,
    logs: envLogs.length,
    stored: _envStore.size,
  };
}
