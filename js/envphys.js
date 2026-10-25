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
//   baked     true once a felled tree's stump + log remain exists: from then
//             HIDE the standing sprite (the remain replaces it). While
//             state is 'falling' or ('fallen' && !baked) draw the tree rotated
//             by `fall` along fallDir (foreshortened in iso). A 'falling'
//             tree may wait (shock front / stagger / active-set queue) with
//             fall = 0: it still looks standing and keeps its trunk collision
//             until the fall starts (`snapped` = trunk has snapped).
//   destroyed objects (state 'destroyed': crate, sandbag, bush, boulder,
//             ruins, exploded barrel): hide the sprite (debris/decals remain).
//   type, x, y, height, radius  copied from the object
//   logLen, logR, stumpR        felled-tree geometry (world units)
//   logGone   the log was splintered by an explosion (E11): stump only
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
//
// Structural remains (E10, world state; never gore decals): envRemains[] of
// records, envRemainsVersion bumps on change. Bake them per chunk.
//   remain 'log': x, y = stump base, ax, ay, bx, by = log capsule (world),
//     logR, stumpR, variant (0 tree, 1 pine, 2 dead tree), scorch (0-3),
//     barkColor, cutColor, fallDirX/fallDirY.
//     Fallen crown (flattened, darker canopy blob lying at the far end):
//       crownX, crownY  world centre (log end pushed ~0.35 x crownR further
//                       along fallDir)
//       crownR          world radius (~0.75 x canopy radius; 0 = no crown,
//                       dead trees)
//       crownColor      0xRRGGBB (leaf/needle green x 0.6, darker with scorch)
//       crownVariant    0 broadleaf, 1 pine
//     logGone   true once an explosion splintered the log (E11): draw only
//               the stump, NO log and NO crown (envRemainsVersion bumps)
//   remain 'rubble': x, y, type ('boulder'|'ruins'), radius, remainColor.
//
// Hooks (E9): envState(id), envStats(), resetEnvState(), envBlast(),
// updateEnv(dt); globals envLogs (every intact fallen-log capsule; hook/debug only,
// never scanned per frame), envDebris, envRemains, envRemainsVersion.
// Spatial query: envLogsNear(x, y, rad) -> n; the logs whose capsule may lie
// within rad of (x, y) are envLogHits[0..n-1] (shared buffer, reused by the
// next query). E11: logs are hurdles: envLogSlow(x, y, rad) is the speed
// factor (CFG.ENV_LOG_CLIMB while overlapping a capsule, else 1); an
// explosion with f > CFG.ENV_LOG_SPLINTER_F splinters a log (capsule gone).
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
// E5: logs bucketed by terrain chunk (numeric key cx * 100003 + cy); a log
// sits in every chunk its capsule AABB touches. Queries only visit the
// chunks around the entity, so cost does not grow with logs felled elsewhere.
const _envLogGrid = new Map();
const envLogHits = [];         // envLogsNear() result buffer
let _envLogQ = 0;              // query stamp (dedup logs spanning chunks)
// E10: structural remains (stump + log of felled trees, rubble footprint of
// shattered boulders/ruins) are WORLD STATE, not gore decals: the renderer
// bakes them per chunk from this list, so gore can never recycle them.
const envRemains = [];
let envRemainsVersion = 0;     // bumps whenever envRemains changes
const envDebris = [];          // E4: flying debris pieces
const _envDebrisFree = [];
let _envFelled = 0;
let _envBlastSeq = 0;
let _envToppleFrameN = 0;      // topples activated this frame (staggering)
let _envLandFrameN = 0;        // landings processed this frame
let _envInLoop = false;        // inside the active-set loop (no eviction then)
let _envFrame = 0;             // updateEnv frame stamp (object liveness)
let _envSweepT = 0;            // store sweep timer (E7 memory)
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
const ENV_CROWN_TREE = 0x22bb55, ENV_CROWN_PINE = 0x11aa44; // canopy greens of the tree sprites (procedural-tree3d.js)
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
  // collision follows what is drawn: a tree waiting to fall (fall = 0)
  // still shows its trunk, so it keeps blocking with it
  else if (r.state === 'fallen' || (r.state === 'falling' && r.snapped)) o.collision = r.stumpR;
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

// E13: trunk HP by type (0 = no trunk to fell)
function _envTrunkMax(type) {
  switch (type) {
    case 'tree': return CFG.ENV_TRUNK_HP_TREE;
    case 'pine': return CFG.ENV_TRUNK_HP_PINE;
    case 'deadtree': return CFG.ENV_TRUNK_HP_DEAD;
    default: return 0;
  }
}

// Get or create the record of an object
function _envRecord(o) {
  let r = envObjState(o);
  if (r && !r.pruned) return r;
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
    snapped: false, byPlayer: false, landed: false, baked: false, bakeT: 0,
    logLen: 0, logR: dead ? CFG.ENV_LOG_R * 0.7 : CFG.ENV_LOG_R,
    stumpR: dead ? CFG.ENV_STUMP_R * 0.8 : CFG.ENV_STUMP_R,
    ax: 0, ay: 0, bx: 0, by: 0,
    active: false, queued: false, blastSeq: 0,
    inLogs: false, inRemains: false, pruned: false,
    // E13: trunk HP, dominant recent shot direction (dmg-weighted, decaying)
    trunkHp: _envTrunkMax(o.type), trunkMax: _envTrunkMax(o.type),
    shotX: 0, shotY: 0, shotT: 0, notch: false, notchDirX: 0, notchDirY: 0,
    // F3: heat under the stream (0..1), fire seconds left, burnt out
    heat: 0, heatSeen: -1, heating: false, fire: 0, spreadT: 0, charred: false,
  };
  _envStore.set(r.id, r);
  o._env = r;
  return r;
}

function _envSyncObj(r) { if (r.obj) _envApplyObj(r.obj, r); }

// Cosmetic activation (sway): never takes a slot a queued topple is waiting for
function _envActivate(r) {
  if (r.active) return true;
  if (_envActive.length >= CFG.ENV_ACTIVE_MAX || _envQueue.length) return false;
  r.active = true;
  _envActive.push(r);
  return true;
}

// A record that only sways (no lasting change): safe to evict / forget
function _envSwayOnly(r) {
  return r.state === 'standing' && r.scorch === 0 && !r.cracked && r.hp >= r.maxHp && !r.queued && !r.remain &&
    r.trunkHp >= r.trunkMax && !(r.heat > 0) && !(r.fire > 0) && !r.charred && !r.heating;
}

// Remove r from the active set (index i) and put it to sleep; a sway-only
// record is dropped from the store too (E7 memory: nothing to persist)
function _envSleep(r, i) {
  r.sway = 0; r.swayV = 0;
  r.active = false;
  const last = _envActive.pop();
  if (last !== r) _envActive[i] = last;
  if (_envSwayOnly(r)) _envForget(r);
}

function _envForget(r) {
  if (_envStore.get(r.id) === r) _envStore.delete(r.id);
  r.pruned = true;
  if (r.obj && r.obj._env === r) r.obj._env = null;
  r.obj = null;
}

// E8: a topple always wins a slot: when the set is full, evict a record that
// is only swaying (it just loses its cosmetic sway). Not while updateEnv
// iterates the set (a landing can set off a bomber -> blast -> topple); such
// topples queue and get a slot at the next drain, a frame later.
function _envActivateTopple(r) {
  if (r.active) return true;
  if (_envActive.length >= CFG.ENV_ACTIVE_MAX) {
    if (_envInLoop) return false;
    let j = _envActive.length - 1;
    for (; j >= 0; j--) {
      const a = _envActive[j];
      if (a.state !== 'falling' && !(a.state === 'fallen' && !a.baked)) break;
    }
    if (j < 0) return false; // every slot is a falling/settling tree
    _envSleep(_envActive[j], j);
  }
  r.active = true;
  _envActive.push(r);
  // stagger simultaneous topple starts (shock front + a few frames each)
  r.fallDelay += _envToppleFrameN * CFG.ENV_TOPPLE_STAGGER;
  _envToppleFrameN++;
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
  r.fallDelay = delay; // shock front; E8 stagger is added when it gets a slot
  r.snapped = false;   // the trunk snaps (stump-only collision) when the fall starts
  r.byPlayer = !!byPlayer;
  r.logLen = Math.max(20, (r.height || 50) * CFG.ENV_LOG_LEN);
  if (!_envActivateTopple(r) && !r.queued) { r.queued = true; _envQueue.push(r); }
}

// The fall starts: trunk snaps, only the stump still blocks
function _envSnap(r) {
  r.snapped = true;
  _envSyncObj(r);
  _envDebrisBurst(r.x, r.y, 4, 3, DEBRIS_BARK, r.kind === ENVK_DEAD ? ENV_DEADWOOD_COLORS : ENV_BARK_COLORS, r.fallDirX, r.fallDirY, 0.7, 1.2, 2.2);
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
      // E10: the rubble footprint stays as world state
      r.remain = 'rubble';
      r.remainColor = pal[0];
      _envAddRemain(r);
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
  if (!r.inLogs && !r.logGone) { r.inLogs = true; envLogs.push(r); _envLogInsert(r); }
  _envFelled++;
  r.bakeT = CFG.ENV_BAKE_DELAY;

  // Impact: dust along the trunk, leaves from the crown, shake (J5a cap)
  const mx = (r.ax + r.bx) * 0.5, my = (r.ay + r.by) * 0.5;
  _envDust(mx, my, 6, r.logLen * 0.45);
  if (r.kind === ENVK_TREE) _envLeafBurst(r, 12, ux, uy, 0.8, r.bx - ux * r.logLen * 0.2, r.by - uy * r.logLen * 0.2, 12);
  _envDebrisBurst(r.bx, r.by, 4, 2, DEBRIS_BARK, r.kind === ENVK_DEAD ? ENV_DEADWOOD_COLORS : ENV_BARK_COLORS, ux, uy, 0.5, 1.2, 2);
  addShake(Math.min(CFG.ENV_FALL_SHAKE, 2 + r.height * 0.04));
  // M10 C4: a soft rumble for a tree falling nearby
  if (typeof padRumble === 'function') {
    for (let i = 0; i < players.length; i++) { // M11 K2: each player's own pad
      const p = players[i];
      if (!p) continue;
      const d = Math.sqrt((p.x - mx) ** 2 + (p.y - my) ** 2);
      if (d < 320) padRumble(0.15 + 0.35 * (1 - d / 320), 0, 160, p);
    }
  }
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
  const pr = rr + 10;
  for (let i = 0; i < players.length; i++) { // M11: every standing player under it
    const p = players[i];
    if (playerStanding(p) && envSegDist2(p.x, p.y, r) < pr * pr) damagePlayer(CFG.ENV_FALL_PLAYER_DMG, p);
  }
}

// Stump + log become a persistent remain, baked by the renderer (E10)
function _envBake(r) {
  r.baked = true;
  r.remain = 'log';
  r.variant = r.type === 'pine' ? 1 : r.kind === ENVK_DEAD ? 2 : 0;
  r.barkColor = shadeHex(r.kind === ENVK_DEAD ? ENV_DEADWOOD_COLORS[0] : ENV_BARK_COLORS[0], 1 - r.scorch * 0.15);
  r.cutColor = ENV_CUT_WOOD;
  // E10: the crown lies flattened (and darker) at the log's far end
  const pine = r.type === 'pine';
  r.crownVariant = pine ? 1 : 0;
  r.crownR = r.kind === ENVK_TREE ? r.radius * CFG.ENV_CROWN_R : 0;
  const push = r.crownR * CFG.ENV_CROWN_PUSH;
  r.crownX = r.bx + r.fallDirX * push;
  r.crownY = r.by + r.fallDirY * push;
  r.crownColor = shadeHex(pine ? ENV_CROWN_PINE : ENV_CROWN_TREE, CFG.ENV_CROWN_DARK * (1 - 0.18 * r.scorch));
  _envAddRemain(r);
}

function _envAddRemain(r) {
  if (!r.inRemains) { r.inRemains = true; envRemains.push(r); }
  envRemainsVersion++;
}

// ---------------------------------------------------------------------
// Explosions (E2/E4). spawnExplosion() calls this once per explosion.
// ---------------------------------------------------------------------
// dmg: the explosion's own damage (E13 trunk HP loses f x dmg; default
// CFG.ENV_BLAST_DMG for sources without a round). wet: a water geyser (N1):
// sway/topple as usual but never scorches
function envBlast(x, y, R, byPlayer = false, src = SRC_EXPLOSIVE, dmg = CFG.ENV_BLAST_DMG, wet = false) {
  if (!(R > 0)) return;
  const bfg = src === SRC_BFG || R >= CFG.ENV_BFG_RADIUS;
  const seq = ++_envBlastSeq;
  _envSplinterLogs(x, y, R); // E11
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
    _envBlastOne(r, f, ux, uy, d, byPlayer, bfg, wet, dmg);
  }
}

function _envBlastOne(r, f, ux, uy, d, byPlayer, bfg, wet, dmg) {
  if (r.state === 'destroyed' || r.state === 'falling' || r.state === 'fallen') return;
  const kind = r.kind;
  const scorch = !wet && f > CFG.ENV_SCORCH_F;
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
    // E13: the blast also eats into the trunk (E2 thresholds above still win)
    if (kind !== ENVK_BUSH && _envTrunkDamage(r, f * dmg, ux, uy, byPlayer)) return;
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

// E13: wear the trunk down by dmg pushed along world direction (ux, uy).
// The dmg-weighted push directions decay with CFG.ENV_SHOT_TAU (game time);
// at 0 HP the tree topples along that dominant direction (away from the
// shooters). Returns true if this felled the tree.
function _envTrunkDamage(r, dmg, ux, uy, byPlayer) {
  if (!(r.trunkMax > 0) || !(dmg > 0)) return false;
  if (r.state !== 'standing' && r.state !== 'scorched') return false;
  const k = Math.exp(-Math.max(0, gameTime - r.shotT) / CFG.ENV_SHOT_TAU);
  r.shotX = r.shotX * k + ux * dmg;
  r.shotY = r.shotY * k + uy * dmg;
  r.shotT = gameTime;
  const sl = Math.sqrt(r.shotX * r.shotX + r.shotY * r.shotY);
  const dx = sl > 1e-6 ? r.shotX / sl : ux, dy = sl > 1e-6 ? r.shotY / sl : uy;
  r.trunkHp = Math.max(0, r.trunkHp - dmg);
  if (r.trunkHp <= r.trunkMax * CFG.ENV_TRUNK_NOTCH) {
    if (!r.notch) _envDebrisBurst(r.x, r.y, 6, 3, DEBRIS_BARK, r.kind === ENVK_DEAD ? ENV_DEADWOOD_COLORS : ENV_BARK_COLORS, -dx, -dy, 0.6, 1.2, 2);
    r.notch = true;
    r.notchDirX = -dx; r.notchDirY = -dy; // the side facing the shooters
  }
  if (r.trunkHp > 0) return false;
  if (r.kind === ENVK_TREE) _envLeafBurst(r, CFG.ENV_LEAF_BURST >> 1, dx, dy, 0.8);
  _envTopple(r, dx, dy, 0, byPlayer);
  return true;
}

// ---------------------------------------------------------------------
// F3: burning trees. The flame stream heats a trunk/canopy (heat 0 -> 1 over
// CFG.TREE_IGNITE_S of stream); at 1 the tree burns CFG.TREE_BURN_S, spreads
// to trees within CFG.TREE_SPREAD_R at CFG.TREE_SPREAD_P per second each
// (cap CFG.TREE_BURN_MAX), burns enemies under its canopy, then stands
// charred (a dead tree: E13 trunk HP 300). Persistent like any record (E7).
// ---------------------------------------------------------------------
const _envHeating = [];
const _envBurning = [];
let envFireVersion = 0;   // bumps when a tree ignites or burns out (renderer)

function envFlameHeat(o) {
  const kind = _envKind(o.type);
  if (kind !== ENVK_TREE && kind !== ENVK_DEAD) return;
  const r = _envRecord(o);
  if ((r.state !== 'standing' && r.state !== 'scorched') || r.charred || r.fire > 0) return;
  r.heatSeen = gameTime;
  if (!r.heating) { r.heating = true; _envHeating.push(r); }
}

function _envIgniteTree(r) {
  if (_envBurning.length >= CFG.TREE_BURN_MAX) return false;
  r.fire = CFG.TREE_BURN_S * randRange(0.9, 1.1);
  r.heat = 1; r.spreadT = 0;
  _envBurning.push(r);
  envFireVersion++;
  if (typeof playSound === 'function') playSound('fire', 0.4);
  return true;
}

function _envBurnOut(r) {
  r.fire = 0; r.charred = true; r.heat = 0;
  if (r.scorch < 3) r.scorch = 3;
  if (r.state === 'standing') r.state = 'scorched';
  r.kind = ENVK_DEAD; // a charred bare tree
  r.trunkMax = CFG.ENV_TRUNK_HP_DEAD;
  r.trunkHp = Math.min(r.trunkHp, r.trunkMax);
  r.notch = r.trunkHp <= r.trunkMax * CFG.ENV_TRUNK_NOTCH;
  envFireVersion++;
}

function _updateEnvFire(dt) {
  for (let i = _envHeating.length - 1; i >= 0; i--) {
    const r = _envHeating[i];
    let done = r.fire > 0 || r.charred || (r.state !== 'standing' && r.state !== 'scorched');
    if (!done) {
      if (gameTime - r.heatSeen <= 0.1) r.heat = Math.min(1, r.heat + dt / CFG.TREE_IGNITE_S);
      else r.heat = Math.max(0, r.heat - dt * 0.5);
      if (r.heat >= 1 - 1e-9) { if (_envIgniteTree(r)) done = true; else r.heat = 1; }
      else if (r.heat <= 0) done = true;
    }
    if (done) { r.heating = false; _envHeating[i] = _envHeating[_envHeating.length - 1]; _envHeating.pop(); }
  }
  const pStep = 1 - Math.pow(1 - CFG.TREE_SPREAD_P, 0.1);
  const R = CFG.TREE_SPREAD_R;
  for (let i = _envBurning.length - 1; i >= 0; i--) {
    const r = _envBurning[i];
    if (r.state === 'falling' || r.state === 'fallen' || r.state === 'destroyed') {
      _envBurnOut(r);
    } else {
      r.fire -= dt;
      // spread, checked at 10 Hz
      r.spreadT += dt;
      while (r.spreadT >= 0.1) {
        r.spreadT -= 0.1;
        if (Math.random() < 0.08 && typeof playSound === 'function') playSound('fire', 0.25); // crackle (audio rate-limits it)
        for (let j = 0; j < envObjects.length; j++) {
          const o = envObjects[j];
          const dx = o.x - r.x, dy = o.y - r.y;
          if (dx > R || dx < -R || dy > R || dy < -R || dx * dx + dy * dy > R * R) continue;
          const k = _envKind(o.type);
          if (k !== ENVK_TREE && k !== ENVK_DEAD) continue;
          const q = o._envAt === _envEpoch ? o._env : envObjState(o);
          if (q === r || (q && (q.fire > 0 || q.charred || (q.state !== 'standing' && q.state !== 'scorched')))) continue;
          if (Math.random() < pStep) _envIgniteTree(_envRecord(o));
        }
      }
      // enemies under the canopy burn
      const cr = Math.max(20, r.radius || 30);
      for (let j = enemies.length - 1; j >= 0; j--) {
        const e = enemies[j];
        if (e.dead) continue;
        const dx = e.x - r.x, dy = e.y - r.y;
        if (dx * dx + dy * dy > cr * cr) continue;
        igniteEnemy(e);
        e.hp -= CFG.CANOPY_FIRE_DPS * dt;
        if (e.hp <= 0) killEnemy(e, Math.atan2(dy, dx), SRC_FIRE);
      }
      if (r.fire > 0) continue;
      _envBurnOut(r);
    }
    _envBurning[i] = _envBurning[_envBurning.length - 1];
    _envBurning.pop();
  }
}

// ---------------------------------------------------------------------
// Bullets (E3/E4): combat.js calls this when a bullet path hits an env
// blocker (trunk, stump, crate, sandbag). (hx, hy) = impact point.
// ---------------------------------------------------------------------
// E13: every owner's rounds wear trunks down (byPlayer: credit for the fall);
// a pierce pass applies dmg x CFG.ENV_TRUNK_PIERCE to a trunk
function envBulletHit(o, hx, hy, vx, vy, dmg, byPlayer = false, pierce = false) {
  const kind = _envKind(o.type);
  const sp = Math.sqrt(vx * vx + vy * vy) || 1;
  const ux = vx / sp, uy = vy / sp;
  if (kind === ENVK_TREE || kind === ENVK_DEAD) {
    const r = envObjState(o);
    const felled = r && (r.state === 'falling' || r.state === 'fallen');
    // bark chips fly back toward the shooter, denser as the trunk wears (E13)
    const bark = kind === ENVK_DEAD ? ENV_DEADWOOD_COLORS : ENV_BARK_COLORS;
    const worn = r && r.trunkMax > 0 ? 1 - r.trunkHp / r.trunkMax : 0;
    const chips = 3 + Math.round(worn * 4);
    for (let i = 0; i < chips; i++) {
      const a = Math.atan2(-uy, -ux) + randRange(-1.1, 1.1);
      const s = randRange(40, 120);
      const p = spawnParticle(hx, hy, Math.cos(a) * s, Math.sin(a) * s, randRange(0.5, 0.9), randRange(1, 1.8),
        _pick(bark), 'debris', OPT_BARK, randRange(6, 16), randRange(40, 120));
      p.rotSpeed = randRange(-12, 12);
    }
    if (felled) return; // stump: chips only
    const rec = _envRecord(o);
    if (rec.state === 'destroyed') return;
    if (_envTrunkDamage(rec, pierce ? dmg * CFG.ENV_TRUNK_PIERCE : dmg, ux, uy, byPlayer)) return;
    if (kind === ENVK_TREE) {
      // a leaf or two drift down from the crown, and a tiny sway
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

function _envLogInsert(r) {
  const cs = CFG.CHUNK_SIZE * CFG.TILE_SIZE, m = r.logR;
  const x0 = Math.floor((Math.min(r.ax, r.bx) - m) / cs), x1 = Math.floor((Math.max(r.ax, r.bx) + m) / cs);
  const y0 = Math.floor((Math.min(r.ay, r.by) - m) / cs), y1 = Math.floor((Math.max(r.ay, r.by) + m) / cs);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) {
      const k = cx * 100003 + cy;
      let a = _envLogGrid.get(k);
      if (!a) { a = []; _envLogGrid.set(k, a); }
      a.push(r);
    }
  }
}

// Logs whose capsule may come within rad of (x, y): envLogHits[0..n-1].
// Visits only the chunks the query box touches (1-4 for an entity).
function envLogsNear(x, y, rad) {
  if (!envLogs.length) return 0;
  const cs = CFG.CHUNK_SIZE * CFG.TILE_SIZE;
  const x0 = Math.floor((x - rad) / cs), x1 = Math.floor((x + rad) / cs);
  const y0 = Math.floor((y - rad) / cs), y1 = Math.floor((y + rad) / cs);
  const q = ++_envLogQ;
  let n = 0;
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) {
      const a = _envLogGrid.get(cx * 100003 + cy);
      if (!a) continue;
      for (let i = 0; i < a.length; i++) {
        const r = a[i];
        if (r._logQ === q) continue;
        r._logQ = q;
        const m = rad + r.logR;
        if (x < (r.ax < r.bx ? r.ax : r.bx) - m || x > (r.ax > r.bx ? r.ax : r.bx) + m ||
            y < (r.ay < r.by ? r.ay : r.by) - m || y > (r.ay > r.by ? r.ay : r.by) + m) continue;
        envLogHits[n++] = r;
      }
    }
  }
  return n;
}

// E11: logs are hurdles, not walls: anyone whose circle overlaps a log
// capsule climbs over it at CFG.ENV_LOG_CLIMB x speed (bullets fly over).
// Returns the speed factor for an entity of radius rad at (x, y).
function envLogSlow(x, y, rad) {
  const n = envLogsNear(x, y, rad);
  for (let i = 0; i < n; i++) {
    const r = envLogHits[i];
    const rr = rad + r.logR;
    if (envSegDist2(x, y, r) < rr * rr) return CFG.ENV_LOG_CLIMB;
  }
  return 1;
}

// E11: an explosion splinters the logs it hits hard (f > CFG.ENV_LOG_SPLINTER_F,
// f = 1 - distance to the log segment / R): the capsule goes, wood flies,
// the stump stays (remain record: logGone = true)
function _envSplinterLogs(x, y, R) {
  const n = envLogsNear(x, y, R);
  if (!n) return;
  const th = 1 - CFG.ENV_LOG_SPLINTER_F;
  let k = 0;
  for (let i = 0; i < n; i++) _envSplinterBuf[k++] = envLogHits[i]; // the query buffer is reused below
  for (let i = 0; i < k; i++) {
    const r = _envSplinterBuf[i];
    _envSplinterBuf[i] = null;
    const d2 = envSegDist2(x, y, r);
    if (d2 >= R * R * th * th) continue;
    _envSplinterLog(r, x, y);
  }
}
const _envSplinterBuf = [];

function _envSplinterLog(r, x, y) {
  r.logGone = true;
  _envLogRemove(r);
  const bark = r.kind === ENVK_DEAD ? ENV_DEADWOOD_COLORS : ENV_BARK_COLORS;
  for (let j = 0; j < 4; j++) {
    const t = (j + 0.5) / 4;
    const px = r.ax + (r.bx - r.ax) * t, py = r.ay + (r.by - r.ay) * t;
    let ux = px - x, uy = py - y;
    const d = Math.sqrt(ux * ux + uy * uy);
    if (d > 0.01) { ux /= d; uy /= d; } else { ux = 0; uy = 0; }
    _envDebrisBurst(px, py, 3, 3, DEBRIS_WOOD, ENV_CRATE_COLORS, ux, uy, 0.9, 1.4, 3);
    _envDebrisBurst(px, py, 3, 1, DEBRIS_BARK, bark, ux, uy, 0.8, 1.2, 2.2);
  }
  _envDust((r.ax + r.bx) * 0.5, (r.ay + r.by) * 0.5, 4, r.logLen * 0.4);
  envRemainsVersion++;
}

function _envLogRemove(r) {
  if (!r.inLogs) return;
  r.inLogs = false;
  const i = envLogs.indexOf(r);
  if (i >= 0) { envLogs[i] = envLogs[envLogs.length - 1]; envLogs.pop(); }
  const cs = CFG.CHUNK_SIZE * CFG.TILE_SIZE, m = r.logR;
  const x0 = Math.floor((Math.min(r.ax, r.bx) - m) / cs), x1 = Math.floor((Math.max(r.ax, r.bx) + m) / cs);
  const y0 = Math.floor((Math.min(r.ay, r.by) - m) / cs), y1 = Math.floor((Math.max(r.ay, r.by) + m) / cs);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) {
      const k = cx * 100003 + cy, a = _envLogGrid.get(k);
      if (!a) continue;
      const j = a.indexOf(r);
      if (j >= 0) { a[j] = a[a.length - 1]; a.pop(); }
      if (!a.length) _envLogGrid.delete(k);
    }
  }
}

// ---------------------------------------------------------------------
// Update (called from update(dt) in main.js)
// ---------------------------------------------------------------------
function updateEnv(dt) {
  _envLandFrameN = 0;
  const frame = ++_envFrame;

  // E7: attach persisted state to objects spawned since last frame; stamp
  // the live ones (the store sweep detaches records of unloaded objects)
  for (let i = 0; i < envObjects.length; i++) {
    const o = envObjects[i];
    if (o._envAt !== _envEpoch) envObjState(o);
    o._envSeen = frame;
  }
  _envSweepT -= dt;
  if (_envSweepT <= 0) { _envSweepT = CFG.ENV_STORE_SWEEP; _envSweepStore(frame); }

  // E8: queued topples take free slots first (evicting sway-only records),
  // so bullet sways can never starve them
  while (_envQueue.length) {
    const r = _envQueue[0];
    if (!_envActivateTopple(r)) break;
    _envQueue.shift();
    r.queued = false;
  }

  const K = CFG.ENV_SWAY_K, C = CFG.ENV_SWAY_DAMP;
  _envInLoop = true;
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
        if (!r.snapped) _envSnap(r);
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
    if (!moving && r.sway < 0.01 && r.sway > -0.01 && r.swayV < 0.05 && r.swayV > -0.05) _envSleep(r, i);
  }
  _envInLoop = false;
  _envToppleFrameN = 0; // after the loop: counts topples from bullets (before updateEnv) too

  _updateEnvFire(dt);   // F3
  updateEnvDebris(dt);
}

// E7 memory: records of objects no longer in envObjects (chunk unloaded)
// drop their object reference (envObjState re-attaches on regeneration),
// and sway-only records at rest are forgotten.
function _envSweepStore(frame) {
  for (const r of _envStore.values()) {
    if (r.obj && r.obj._envSeen !== frame) r.obj = null;
    if (!r.active && _envSwayOnly(r)) _envForget(r);
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
  _envHeating.length = 0;
  _envBurning.length = 0;
  envFireVersion++;
  envLogs.length = 0;
  _envLogGrid.clear();
  _envInLoop = false;
  _envSweepT = 0;
  envRemains.length = 0;
  envRemainsVersion++;
  for (const d of envDebris) _envDebrisFree.push(d);
  envDebris.length = 0;
  _envFelled = 0;
  _envToppleFrameN = 0;
  _envLandFrameN = 0;
  envNoCredit = false;
}

// E9: { state, hp, sway } (+ scorch, cracked, fall; E13 trunk/notch/shot dir) for an object id
function envState(id) {
  const r = _envStore.get(id);
  if (r) {
    const sl = Math.sqrt(r.shotX * r.shotX + r.shotY * r.shotY) || 1;
    return { state: r.state, hp: r.hp, sway: r.sway, scorch: r.scorch, cracked: r.cracked, fall: r.fall,
      trunkHp: r.trunkHp, trunkMax: r.trunkMax, notch: r.notch, notchDirX: r.notchDirX, notchDirY: r.notchDirY,
      shotDirX: r.shotX / sl, shotDirY: r.shotY / sl, fallDirX: r.fallDirX, fallDirY: r.fallDirY,
      heat: r.heat, fire: r.fire, charred: r.charred };
  }
  let hp = CFG.ENV_TREE_HP, trunk = 0;
  for (let i = 0; i < envObjects.length; i++) {
    if (envObjects[i].id === id) { hp = _envDefaultHp(envObjects[i].type); trunk = _envTrunkMax(envObjects[i].type); break; }
  }
  return { state: 'standing', hp, sway: 0, scorch: 0, cracked: false, fall: 0,
    trunkHp: trunk, trunkMax: trunk, notch: false, notchDirX: 0, notchDirY: 0,
    shotDirX: 0, shotDirY: 0, fallDirX: 1, fallDirY: 0, heat: 0, fire: 0, charred: false };
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
    burningTrees: _envBurning.length, // F3
  };
}
