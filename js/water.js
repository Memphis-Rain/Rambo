// =====================================================================
// WATER (M9 W2-W5) - wading; blood in water follows in W3-W5
// =====================================================================
// Contract (renderer / combat / tests):
//   ent.submerge         0..1, ramps over CFG.WADE_RAMP s on entering /
//                        leaving a rendered water tile (player, enemies)
//   entityDrawnH(ent)    drawn body height when dry (screen units)
//   entityWaterlineH(ent) screen height of the waterline above the feet:
//                        WADE_HIDE (0.45) x submerge x drawn height. The
//                        renderer hides everything below it.
//   entityVisibleH(ent)  drawn height above the waterline
//   aimPointOf(ent, out) where to aim at ent: its feet when dry, a point on
//                        the visible body column while wading (G13 pick,
//                        enemy fire, demo bot)
//   spawnWaterSplash(x, y)  a round going into the water (W2: a hit below
//                        the waterline is a splash, not a hit)
//   waterFxStats()       { clouds, splashes, decalsBlocked, camoRebakes }
//
// W3 blood in water: blood decals (pool, splat, smear, gib, foot) whose
//   point is on a rendered water tile are blocked (decalsBlocked) and become
//   bloodClouds[] { x, y, r0, r, t, life, vx, vy } instead (expand to 2 r0
//   over 4 s, fade in steps over ~8 s, drift). Footprints never print on
//   water and wading resets bloodyFeet.
// W4 corpses in water: body.inWater, body.sinkT (s since it touched water),
//   body.sinkPhase 'float' (0.5 s) | 'sink' (2.5 s, body.sinkFrac 0..1 =
//   how far the waterline has risen) | 'dissolve' (1.5 s, body.dissolve 0..1);
//   a big blood cloud at the dissolve; then spliced from bodies[]. Gibs in
//   water: gib.inWater, gib.sinkT; gone after CFG.GIB_SINK_S, no decal.
// W5 per-tile blood concentration: waterBloodAt(x, y) -> { c, band } (band
//   0..4); events add at once (hit 0.02 / 1 tile, gib 0.05 / 2, kill 0.15 /
//   3, x (1 - d / (R + 1)), capped at 1); a 4 Hz tick diffuses between
//   4-neighbour water tiles, decays (half-life 180 s) and prunes c < 0.02:
//   such tiles read and draw as c 0 / band 0, but keep their trace down to
//   CFG.W5_STORE_MIN so diffusion conserves blood (a thin spread would
//   otherwise be destroyed every tick).
//   waterBloodTiles: Map key -> { i, j, c, band }; waterBloodVersion bumps
//   when any band changes (the renderer's overlay redraw trigger).
//   waterCamoBakes: the renderer counts water-camo bakes (no per-frame rebake)
//
// W2 hit geometry (G13 column under water): the visible body is the column
// capsule from the waterline point A' (kw = bodyColumnK(waterline)) to the
// head B, radius r x (1 - 0.4 submerge) (0.6 r fully in: its bottom cap is
// the "waterline ring"). A path that crosses the visible capsule hits; one
// that only crosses the submerged column (feet A to A', radius r) and whose
// onward path won't reach the visible capsule goes into the water: splash,
// no damage. Contact explosives keep the whole dry body region (G13c).

const WADE_HIDE = 0.45;     // fraction of the drawn body hidden when fully in
const WADE_RING = 0.4;      // hit radius shrinks by this x submerge
const _waterFx = { splashes: 0, decalsBlocked: 0 };
const bloodClouds = [];
const waterBloodTiles = new Map();
let waterBloodVersion = 0;
let waterCamoBakes = 0;      // pixi-terrain.js counts every water-camo bake
const _wbWet = new Map();    // tile key -> rendered water? (terrain is fixed per world)
let _wbTickT = 0;
const MAX_BLOOD_CLOUDS = 80;
const W5_BANDS = [0.02, 0.2, 0.45, 0.75]; // band 1..4 thresholds (4 stepped tint bands)

function waterTileAt(x, y) {
  const ts = CFG.TILE_SIZE; // the rendered tile (E0), same as the water slowdown
  return getTerrainTypeAt(Math.floor(x / ts) * ts, Math.floor(y / ts) * ts) === 'water';
}

function entityDrawnH(ent) { return ENEMY_PICK_H * (ent.size || 1); }
function entityWaterlineH(ent) { return WADE_HIDE * (ent.submerge || 0) * entityDrawnH(ent); }
function entityVisibleH(ent) { return entityDrawnH(ent) - entityWaterlineH(ent); }
function wadeRadius(ent, r) { return r * (1 - WADE_RING * (ent.submerge || 0)); }

function aimPointOf(ent, out) {
  const sub = ent.submerge || 0;
  if (sub <= 0) { out.x = ent.x; out.y = ent.y; return out; }
  const top = ent.num ? PLAYER_BODY_H : ENEMY_BODY_H * (ent.size || 1); // M11: any player
  const k = bodyColumnK((entityWaterlineH(ent) + top) * 0.5);
  out.x = ent.x - k; out.y = ent.y - k;
  return out;
}

function _wadeStep(ent, wet, dt) {
  const s = ent.submerge || 0, k = dt / CFG.WADE_RAMP;
  ent.submerge = wet ? Math.min(1, s + k) : Math.max(0, s - k);
}

// After movement: the depth ramps toward the tile under each entity's feet
function updateWading(dt) {
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (p) _wadeStep(p, waterTileAt(p.x, p.y), dt);
  }
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e.dead) _wadeStep(e, waterTileAt(e.x, e.y), dt);
  }
}

function spawnWaterSplash(x, y) {
  _waterFx.splashes++;
  for (let i = 0; i < 5; i++) {
    const a = Math.random() * Math.PI * 2, sp = randRange(15, 45);
    spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp, randRange(0.3, 0.5), randRange(1, 2),
      i & 1 ? 0xffffff : 0x9fd0f0, 'debris', OPT_SPRAY, 2, randRange(50, 110));
  }
}

function waterFxStats() {
  return { clouds: bloodClouds.length, splashes: _waterFx.splashes, decalsBlocked: _waterFx.decalsBlocked, camoRebakes: waterCamoBakes };
}

// ---------------------------------------------------------------------
// W3: blood clouds
// ---------------------------------------------------------------------
const _WATER_BLOOD_DECAL = [true, true, false, true, true, true, false]; // POOL SPLAT - FOOT SMEAR GIB -
// addDecal() asks first: true = the decal is not placed (on water)
function waterBlocksDecal(kind, x, y, size) {
  if (!_WATER_BLOOD_DECAL[kind] || !waterTileAt(x, y)) return false;
  _waterFx.decalsBlocked++;
  if (kind !== DECAL_FOOT) spawnBloodCloud(x, y, Math.max(3, size * 1.5));
  return true;
}

// A dithered red blob on the water; merges into a cloud nearby. Small drops
// (gib drip trails) merge into any cloud within reach and never take the
// last slots, so they can't evict the big ones (pools, a dissolving corpse)
function spawnBloodCloud(x, y, r) {
  const small = r < 5;
  const reach = small ? 28 : 0;
  for (let i = bloodClouds.length - 1; i >= 0; i--) {
    const c = bloodClouds[i];
    const dx = c.x - x, dy = c.y - y, rr = Math.max(c.r, reach);
    if ((small || c.t < 1.5) && dx * dx + dy * dy < rr * rr) {
      c.r0 = Math.min(40, Math.sqrt(c.r0 * c.r0 + r * r * 0.5));
      return c;
    }
  }
  if (small && bloodClouds.length >= MAX_BLOOD_CLOUDS - 16) return null;
  if (bloodClouds.length >= MAX_BLOOD_CLOUDS) {
    // evict the smallest of the oldest few
    let k = 0;
    for (let i = 1; i < 8 && i < bloodClouds.length; i++) if (bloodClouds[i].r0 < bloodClouds[k].r0) k = i;
    bloodClouds.splice(k, 1);
  }
  const a = Math.random() * Math.PI * 2, sp = randRange(1, 4);
  const c = { x, y, r0: r, r, t: 0, life: CFG.BLOOD_CLOUD_LIFE, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, seed: (Math.random() * 1e9) | 0 };
  bloodClouds.push(c);
  return c;
}

function _updateBloodClouds(dt) {
  let w = 0;
  for (let i = 0; i < bloodClouds.length; i++) {
    const c = bloodClouds[i];
    c.t += dt;
    if (c.t >= c.life) continue;
    c.r = c.r0 * (1 + Math.min(1, c.t / 4)); // 2x over 4 s
    const nx = c.x + c.vx * dt, ny = c.y + c.vy * dt, ts = CFG.TILE_SIZE;
    if (_wbIsWet(Math.floor(nx / ts), Math.floor(ny / ts))) { c.x = nx; c.y = ny; } else { c.vx = c.vy = 0; } // stays on the water
    bloodClouds[w++] = c;
  }
  bloodClouds.length = w;
}

// ---------------------------------------------------------------------
// W4: corpses and gibs in water (particles.js updateCorpses / updateGibs)
// ---------------------------------------------------------------------
// Returns true when the body is gone (caller splices it)
function waterSinkBody(b, dt) {
  if (!b.inWater) {
    if (b.z > 0 || b.vz > 0 || !waterTileAt(b.x, b.y)) return false;
    b.inWater = true; b.sinkT = 0; b.sinkPhase = 'float';
    b.settled = true; b.vx = b.vy = b.vz = 0; b.spin = 0; b.spurts = 0;
    spawnWaterSplash(b.x, b.y);
  }
  const F = CFG.BODY_FLOAT_S, S = CFG.BODY_SINK_S, D = CFG.BODY_DISSOLVE_S;
  b.sinkT += dt;
  if (b.sinkT < F) { b.sinkPhase = 'float'; b.sinkFrac = 0; b.dissolve = 0; return false; }
  if (b.sinkT < F + S) { b.sinkPhase = 'sink'; b.sinkFrac = (b.sinkT - F) / S; b.dissolve = 0; return false; }
  if (b.sinkPhase !== 'dissolve') {
    b.sinkPhase = 'dissolve'; b.sinkFrac = 1;
    spawnBloodCloud(b.x, b.y, 14 * (b.size || 1)); // a big cloud as it goes
    for (let k = 0; k < 4; k++) {
      spawnParticle(b.x + randRange(-6, 6), b.y + randRange(-4, 4), 0, 0, randRange(0.4, 0.8), randRange(1, 1.8),
        0xcfe8ff, 'smoke', OPT_RIPPLE, 0, 0);
    }
  }
  b.dissolve = Math.min(1, (b.sinkT - F - S) / D);
  return b.sinkT >= F + S + D;
}

// A gib touching water: sinks (no bounce, no decal); true when gone
function waterSinkGib(g, dt) {
  if (!g.inWater) {
    if (!waterTileAt(g.x, g.y)) return false;
    g.inWater = true; g.sinkT = 0; g.vx = g.vy = g.vz = 0; g.rotSpeed = 0;
    waterBloodAdd(g.x, g.y, CFG.W5_GIB, 2);
    spawnBloodCloud(g.x, g.y, 4 + g.size * 2);
    return false;
  }
  g.sinkT += dt;
  return g.sinkT >= CFG.GIB_SINK_S;
}

// ---------------------------------------------------------------------
// W5: blood concentration per water tile
// ---------------------------------------------------------------------
function _wbKey(i, j) { return (i + 32768) * 65536 + (j + 32768); }
function _wbIsWet(i, j) {
  const k = _wbKey(i, j);
  let w = _wbWet.get(k);
  if (w === undefined) {
    const ts = CFG.TILE_SIZE;
    w = getTerrainTypeAt(i * ts, j * ts) === 'water';
    _wbWet.set(k, w);
  }
  return w;
}
function _wbBand(c) {
  let b = 0;
  while (b < 4 && c >= W5_BANDS[b]) b++;
  return b;
}
function _wbSet(i, j, c) {
  const k = _wbKey(i, j);
  let t = waterBloodTiles.get(k);
  if (!t) { t = { i, j, c: 0, band: 0 }; waterBloodTiles.set(k, t); }
  t.c = Math.min(1, c);
  const band = _wbBand(t.c);
  if (band !== t.band) { t.band = band; waterBloodVersion++; }
  return t;
}

// An event at (x, y): amt x (1 - d / (R + 1)) on every water tile within R tiles
function waterBloodAdd(x, y, amt, R) {
  const ts = CFG.TILE_SIZE;
  const ci = Math.floor(x / ts), cj = Math.floor(y / ts);
  for (let di = -R; di <= R; di++) {
    for (let dj = -R; dj <= R; dj++) {
      const d = Math.sqrt(di * di + dj * dj);
      if (d > R + 1e-9) continue;
      const i = ci + di, j = cj + dj;
      if (!_wbIsWet(i, j)) continue;
      const t = waterBloodTiles.get(_wbKey(i, j));
      _wbSet(i, j, (t ? t.c : 0) + amt * (1 - d / (R + 1)));
    }
  }
}

function waterBloodAt(x, y) {
  const ts = CFG.TILE_SIZE;
  const t = waterBloodTiles.get(_wbKey(Math.floor(x / ts), Math.floor(y / ts)));
  return t && t.band > 0 ? { c: t.c, band: t.band } : { c: 0, band: 0 }; // < 0.02 = pruned
}

const _wbDelta = new Map();
const _WB_N = [[1, 0], [-1, 0], [0, 1], [0, -1]];
// 4 Hz: diffuse into connected water, decay (half-life), prune
function _tickWaterBlood(step) {
  if (!waterBloodTiles.size) return;
  const D = Math.min(0.2, CFG.W5_DIFFUSE * step);
  _wbDelta.clear();
  for (const [k, t] of waterBloodTiles) {
    for (const [di, dj] of _WB_N) {
      const i = t.i + di, j = t.j + dj;
      if (!_wbIsWet(i, j)) continue;
      const k2 = _wbKey(i, j);
      const o = waterBloodTiles.get(k2);
      if (o && k2 < k) continue; // each existing pair once
      const flow = D * (t.c - (o ? o.c : 0)) * 0.25;
      if (flow === 0) continue;
      // into a clean tile only if the trace would be kept: blood stays put
      // rather than being spread thin and pruned away (conservation)
      if (!o && flow < CFG.W5_STORE_MIN) continue;
      _wbDelta.set(k, (_wbDelta.get(k) || 0) - flow);
      _wbDelta.set(k2, (_wbDelta.get(k2) || 0) + flow);
    }
  }
  const decay = Math.pow(0.5, step / CFG.W5_HALF_LIFE);
  for (const [k, dc] of _wbDelta) {
    const t = waterBloodTiles.get(k);
    if (t) t.c += dc;
    else if (dc > 0) { const i = Math.floor(k / 65536) - 32768, j = (k % 65536) - 32768; _wbSet(i, j, dc); }
  }
  for (const [k, t] of waterBloodTiles) {
    const c = t.c * decay;
    if (c < CFG.W5_STORE_MIN) { if (t.band) waterBloodVersion++; waterBloodTiles.delete(k); continue; }
    _wbSet(t.i, t.j, c);
  }
}

// update(): blood clouds every frame, the concentration tick at <= 4 Hz
function updateWater(dt) {
  _updateBloodClouds(dt);
  _wbTickT += dt;
  if (_wbTickT >= CFG.W5_TICK) { const s = _wbTickT; _wbTickT = 0; _tickWaterBlood(s); }
}

function resetWater() {
  _waterFx.splashes = 0;
  _waterFx.decalsBlocked = 0;
  bloodClouds.length = 0;
  waterBloodTiles.clear();
  _wbWet.clear();
  _wbTickT = 0;
  waterBloodVersion++;
}
