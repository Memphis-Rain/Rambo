// =====================================================================
// CO-OP (M11) - 2 players on one screen: shared camera, zoom and leash (K3)
// =====================================================================
// Contract (camera / renderers / tests):
//   cam.z              current world zoom (1 = no zoom; 1P is always 1, Q4)
//   camZoom()          { zoom, target, forced }
//   setCamZoom(z)      force-set and hold z (0 < z <= 1); null releases it
//   coopCounted(p)     a player the camera frames: standing or downed (K5)
//   coopMidpoint(out)  -> number of counted players; out = their mean (world)
//   coopZoomTarget(points, viewW, viewH) -> the largest zoom <= 1 keeping
//                      every point COOP_ZOOM_MARGIN low-res px inside a view
//                      of viewW x viewH low-res px centred on the points'
//                      midpoint, clamped to COOP_ZOOM_MIN (pure)
//   coopLeashClamp(mover, other, nx, ny, out) -> out {x, y}: the allowed
//                      position for `mover` moving to (nx, ny) at
//                      COOP_ZOOM_MIN, so neither player comes within
//                      COOP_LEASH_PX low-res px of the view edge (pure)
//   worldToView(wx, wy, out) / viewToWorld(x, y, out) -> CSS px <-> ground
//                      point through this frame's offset and zoom (Q5)
//   coopJoin(padIndex) -> players[1] (spawned next to P1) or null

const _coop = { target: 1, zoomingIn: false, forced: null };
const _coopMid = { x: 0, y: 0 };
const _coopPts = [];
const _coopV = { x: 0, y: 0 };
const _coopAmbO = { x: 0, y: 0 }; // main.js update(): ambient FX origin

function coopCounted(p) { return !!p && (p.state === 'up' || p.state === 'down'); }

function coopMidpoint(out) {
  let n = 0, sx = 0, sy = 0;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!coopCounted(p)) continue;
    sx += p.x; sy += p.y; n++;
  }
  if (n === 1) { // exact in 1P (Q4): no division rounding
    for (let i = 0; i < players.length; i++) if (coopCounted(players[i])) { out.x = players[i].x; out.y = players[i].y; }
  } else if (n > 1) { out.x = sx / n; out.y = sy / n; }
  return n;
}

function coopZoomTarget(points, viewW, viewH) {
  if (!points || points.length < 2) return 1;
  const iso = CFG.ISO_SCALE, s = RETRO.PIXEL_SCALE, m = CFG.COOP_ZOOM_MARGIN;
  let mx = 0, my = 0;
  for (let i = 0; i < points.length; i++) { mx += points[i].x; my += points[i].y; }
  mx /= points.length; my /= points.length;
  const hw = viewW / 2 - m, hh = viewH / 2 - m;
  let z = 1;
  for (let i = 0; i < points.length; i++) {
    const dx = points[i].x - mx, dy = points[i].y - my;
    const ax = Math.abs(dx - dy) / s, ay = Math.abs((dx + dy) * iso) / s; // low-res px from the centre at zoom 1
    if (ax > 0) z = Math.min(z, hw / ax);
    if (ay > 0) z = Math.min(z, hh / ay);
  }
  return Math.max(CFG.COOP_ZOOM_MIN, Math.min(1, z));
}

// Each frame from updateCamera: ease cam.z toward the target (K3a)
function coopUpdateZoom(dt) {
  if (_coop.forced !== null) { cam.z = _coop.forced; _coop.target = _coop.forced; return; }
  _coopPts.length = 0;
  for (let i = 0; i < players.length; i++) if (coopCounted(players[i])) _coopPts.push(players[i]);
  const s = RETRO.PIXEL_SCALE;
  const t = _coopPts.length < 2 ? 1 : coopZoomTarget(_coopPts, W / s, H / s);
  _coop.target = t;
  const z = cam.z;
  if (t < z) { // out: fast, so a runner never reaches the edge
    _coop.zoomingIn = false;
    cam.z = Math.max(t, z - CFG.COOP_ZOOM_OUT_RATE * dt);
  } else if (t > z) { // in: only past the deadband, then all the way (no breathing)
    if (!_coop.zoomingIn && t >= z * (1 + CFG.COOP_ZOOM_DEADBAND)) _coop.zoomingIn = true;
    if (_coop.zoomingIn) {
      cam.z = Math.min(t, z + CFG.COOP_ZOOM_IN_RATE * dt);
      if (cam.z >= t) _coop.zoomingIn = false;
    }
  } else _coop.zoomingIn = false;
}

function camZoom() { return { zoom: cam.z, target: _coop.target, forced: _coop.forced !== null }; }

function setCamZoom(z) {
  if (z === null || z === undefined) { _coop.forced = null; return; }
  _coop.forced = Math.max(0.05, Math.min(1, +z));
  cam.z = _coop.forced;
}

// K3b: at COOP_ZOOM_MIN, with the camera on the pair's midpoint, each player
// sits half the screen-space separation from the centre; keep that half
// within the view minus COOP_LEASH_PX on each axis
function coopLeashClamp(mover, other, nx, ny, out) {
  const iso = CFG.ISO_SCALE, s = RETRO.PIXEL_SCALE, z = CFG.COOP_ZOOM_MIN;
  const limX = (W - 2 * CFG.COOP_LEASH_PX * s) / z; // max |separation| in zoom-1 screen units
  const limY = (H - 2 * CFG.COOP_LEASH_PX * s) / z;
  let sx = (nx - other.x) - (ny - other.y), sy = ((nx - other.x) + (ny - other.y)) * iso;
  if (Math.abs(sx) <= limX && Math.abs(sy) <= limY) { out.x = nx; out.y = ny; return out; }
  sx = Math.max(-limX, Math.min(limX, sx));
  sy = Math.max(-limY, Math.min(limY, sy));
  out.x = other.x + (sx + sy / iso) * 0.5;
  out.y = other.y + (sy / iso - sx) * 0.5;
  return out;
}

// The leash for player p after its own move this frame (updatePlayer)
function coopApplyLeash(p) {
  if (players.length < 2 || cam.z > CFG.COOP_ZOOM_MIN + 1e-6 || !playerStanding(p)) return;
  for (let i = 0; i < players.length; i++) {
    const o = players[i];
    if (o === p || !coopCounted(o)) continue;
    coopLeashClamp(p, o, p.x, p.y, _coopV);
    p.x = _coopV.x; p.y = _coopV.y;
  }
}

// Spawn rings and ambient FX centre on the camera's midpoint and widen with
// the zoom (1P: P1 and x1, exactly as before)
function coopSpawnOrigin(out) {
  if (!coopMidpoint(out)) { out.x = player.x; out.y = player.y; }
  return out;
}

// This frame's world offset (the snapped one the world was drawn at, Q5)
function _coopOX() { return worldOffsetX !== null ? worldOffsetX : W / 2 - cam.x * cam.z; }
function _coopOY() { return worldOffsetY !== null ? worldOffsetY : H / 2 - cam.y * cam.z; }

function worldToView(wx, wy, out) {
  out = out || {};
  out.x = (wx - wy) * cam.z + _coopOX();
  out.y = (wx + wy) * CFG.ISO_SCALE * cam.z + _coopOY();
  return out;
}

function viewToWorld(x, y, out) {
  const w = toWorld((x - _coopOX()) / cam.z, (y - _coopOY()) / cam.z);
  out = out || {};
  out.x = w.x; out.y = w.y;
  return out;
}

// K2 fills in devices; for now P2 spawns beside P1 (tests, K3 tuning)
function coopJoin(padIndex) {
  if (!player || players.length >= 2) return null;
  const p = createPlayer();
  p.num = 2;
  p.pad = padIndex === undefined ? null : padIndex;
  p.x = player.x + 40; p.y = player.y + 40;
  p.weapon = player.weapon;
  p.magAmmo = WEAPONS[p.weapon].mag;
  players.push(p);
  return p;
}

function resetCoop() {
  players.length = 1;
  cam.z = 1;
  _coop.target = 1; _coop.zoomingIn = false; _coop.forced = null;
}
