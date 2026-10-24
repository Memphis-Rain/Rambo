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
//   waterFxStats()       { splashes }
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
const _waterFx = { splashes: 0 };

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
  const top = ent === player ? PLAYER_BODY_H : ENEMY_BODY_H * (ent.size || 1);
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
  if (player) _wadeStep(player, waterTileAt(player.x, player.y), dt);
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

function waterFxStats() { return { splashes: _waterFx.splashes }; }

function resetWater() {
  _waterFx.splashes = 0;
}
