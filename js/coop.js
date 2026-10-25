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
//   coopTryJoin(padIndex) -> bool: a join press from a free pad (gamepad.js);
//                      on the title it reserves P2 for the next game
//   coopState()        { n, title2P, titleCount, titleHint, devices:
//                      [{ kbm, pad }] per player, pendingPad }

const _coop = { target: 1, zoomingIn: false, forced: null, pendingPad: null, titleHint: null, titleCount: 0, midX: 0, midY: 0 };
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
  if (n > 0) { _coop.midX = out.x; _coop.midY = out.y; } // K5: the last midpoint (team second wind)
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
  } else if (t > z) {
    // in: starts only past the deadband (or for the last step to exactly 1),
    // then keeps following a rising target until it has to zoom out again,
    // so a partner walking back gives one smooth ease, not 5% steps
    if (!_coop.zoomingIn && (t >= z * (1 + CFG.COOP_ZOOM_DEADBAND) || t === 1)) _coop.zoomingIn = true;
    if (_coop.zoomingIn) cam.z = Math.min(t, z + CFG.COOP_ZOOM_IN_RATE * dt);
  }
  if (cam.z >= 1) _coop.zoomingIn = false;
}

function camZoom() { return { zoom: cam.z, target: _coop.target, forced: _coop.forced !== null }; }

function setCamZoom(z) {
  if (z === null || z === undefined) { _coop.forced = null; return; }
  if (!Number.isFinite(+z)) return;
  _coop.forced = Math.max(CFG.COOP_ZOOM_MIN, Math.min(1, +z));
  cam.z = _coop.forced;
}

// K3b: at COOP_ZOOM_MIN, with the camera on the pair's midpoint, each player
// sits half the screen-space separation from the centre; keep that half
// within the view minus COOP_LEASH_PX on each axis. Only the part of a move
// (mover.x/y -> nx/ny) that widens the separation past the limit is cut: a
// player knocked past it isn't yanked back, and can't walk further out
function coopLeashClamp(mover, other, nx, ny, out, z = CFG.COOP_ZOOM_MIN) {
  const iso = CFG.ISO_SCALE, s = RETRO.PIXEL_SCALE;
  const limX = (W - 2 * CFG.COOP_LEASH_PX * s) / z; // max |separation| in zoom-1 screen units
  const limY = (H - 2 * CFG.COOP_LEASH_PX * s) / z;
  let sx = (nx - other.x) - (ny - other.y), sy = ((nx - other.x) + (ny - other.y)) * iso;
  if (Math.abs(sx) <= limX && Math.abs(sy) <= limY) { out.x = nx; out.y = ny; return out; }
  const ox = (mover.x - other.x) - (mover.y - other.y), oy = ((mover.x - other.x) + (mover.y - other.y)) * iso;
  const lx = Math.max(limX, Math.abs(ox)), ly = Math.max(limY, Math.abs(oy));
  sx = Math.max(-lx, Math.min(lx, sx));
  sy = Math.max(-ly, Math.min(ly, sy));
  out.x = other.x + (sx + sy / iso) * 0.5;
  out.y = other.y + (sy / iso - sx) * 0.5;
  return out;
}

// The leash for player p's own move this frame, from (ox, oy) to p.x/p.y
// (updatePlayer; 2P only): (a) against the camera target, at the current
// zoom (at COOP_ZOOM_MIN that is the K3b leash; above it the zoom-out at 3/s
// outruns any move, so it only bites while the zoom lags behind a dodge and
// keeps the partner inside too), (b) against the DRAWN view, which eases
// behind the target: the mover's feet never come within COOP_LEASH_PX
// low-res px of its edge. Knockback is not a move and stays exempt.
function coopApplyLeash(p, ox, oy) {
  if (players.length < 2 || !playerStanding(p)) return;
  const z = Math.max(CFG.COOP_ZOOM_MIN, cam.z);
  for (let i = 0; i < players.length; i++) {
    const o = players[i];
    if (o === p || !coopCounted(o)) continue;
    const nx = p.x, ny = p.y;
    p.x = ox; p.y = oy;
    coopLeashClamp(p, o, nx, ny, _coopV, z);
    p.x = _coopV.x; p.y = _coopV.y;
  }
  _coopDrawnClamp(p, ox, oy);
}

// K3b (b): only the part of the move that widens the feet's distance past
// the limit from the drawn view centre (cam.x, cam.y at cam.z) is cut
function _coopDrawnClamp(p, ox, oy) {
  const iso = CFG.ISO_SCALE, m = CFG.COOP_LEASH_PX * RETRO.PIXEL_SCALE, z = cam.z;
  const hx = (W / 2 - m) / z, hy = (H / 2 - m) / z; // zoom-1 iso units from the centre
  let sx = (p.x - p.y) - cam.x, sy = (p.x + p.y) * iso - cam.y;
  if (Math.abs(sx) <= hx && Math.abs(sy) <= hy) return;
  const lx = Math.max(hx, Math.abs((ox - oy) - cam.x)), ly = Math.max(hy, Math.abs((ox + oy) * iso - cam.y));
  sx = Math.max(-lx, Math.min(lx, sx));
  sy = Math.max(-ly, Math.min(ly, sy));
  const X = sx + cam.x, Y = (sy + cam.y) / iso; // x - y, x + y
  p.x = (X + Y) * 0.5; p.y = (Y - X) * 0.5;
}

// K3b: the camera follows 3x faster while a counted player's feet are within
// COOP_ZOOM_MARGIN low-res px of the drawn edge (2P), so a partner isn't left
// near the edge while the camera eases after a reversal; 1 otherwise (1P: always)
function coopCamFollowMult() {
  if (players.length < 2) return 1;
  const iso = CFG.ISO_SCALE, m = CFG.COOP_ZOOM_MARGIN * RETRO.PIXEL_SCALE, z = cam.z;
  const hx = (W / 2 - m) / z, hy = (H / 2 - m) / z;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!coopCounted(p)) continue;
    if (Math.abs((p.x - p.y) - cam.x) > hx || Math.abs((p.x + p.y) * iso - cam.y) > hy) return 3;
  }
  return 1;
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

// K2 drop-in: P2 beside P1 (screen-right), full health, P1's weapon with a
// full magazine, default grenades; padIndex = P2's pad (null: none yet)
function coopJoin(padIndex) {
  if (!player || players.length >= 2) return null;
  const p = createPlayer();
  p.num = 2;
  p.pad = padIndex === undefined || padIndex === null ? null : padIndex;
  p.ctl = newCtl(p.pad);
  p.x = player.x + 30; p.y = player.y - 30;
  if (typeof resolveEnvCollision === 'function') resolveEnvCollision(p, 10);
  p.weapon = player.weapon;
  p.magAmmo = WEAPONS[p.weapon].mag;
  p.angle = p.aimAngle = player.aimAngle;
  players.push(p);
  if (p.pad !== null && typeof padAttachP2 === 'function') padAttachP2(p.pad);
  // Start aiming where P1 aims (no snap to screen-right on the first frame)
  const a = padAimOf(1);
  a.dirX = Math.cos(p.aimAngle); a.dirY = Math.sin(p.aimAngle);
  a.x = p.x + a.dirX * a.dist; a.y = p.y + a.dirY * a.dist;
  const v = worldToView(a.x, a.y, _coopV);
  p.ctl.mouseX = v.x; p.ctl.mouseY = v.y;
  return p;
}

// A Start / A (or lone-pad View) press from a pad no player owns
function coopTryJoin(padIndex) {
  if (typeof demoActive !== 'undefined' && demoActive) return false;
  if (players.length >= 2) { // re-attach a P2 whose pad dropped
    const p2 = players[1];
    if (!p2 || p2.pad !== null) return false;
    p2.pad = padIndex; p2.ctl.padIndex = padIndex;
    padAttachP2(padIndex);
    return true;
  }
  if (!gameStarted) { // title: reserve P2 for the next game
    if (_coop.pendingPad !== null) return false;
    _coop.pendingPad = padIndex;
    padAttachP2(padIndex);
    return true;
  }
  if (paused || !coopJoin(padIndex)) return false;
  showNotification('PLAYER 2 JOINS!', 2);
  return true;
}

// gamepad.js: P2's pad dropped (a title reservation is dropped with it)
function coopPadLost() { _coop.pendingPad = null; }

// startGame(): the pad reserved on the title (resetRound clears it)
function coopPendingPad() { return _coop.pendingPad; }

// End of update(): P2's one-frame edges, as main.js does for P1's mouse
function coopEndFrame() {
  for (let i = 1; i < players.length; i++) {
    const p = players[i];
    if (p && p.ctl) p.ctl.mouseJustPressed = false;
  }
}

// Title: "2P PRESS START" with 2+ pads, "2P PRESS VIEW ON PAD" with a lone
// pad P1 hasn't used; the player count reads 1P / 2P (gameLoop, title only)
function _coopTitleHint() {
  if (_coop.pendingPad !== null) return '';
  const n = typeof _padCount === 'function' ? _padCount() : 0;
  if (n >= 2) return '2P PRESS START';
  if (n === 1 && !padUsedByP1()) return '2P PRESS VIEW ON PAD';
  return '';
}

function coopTitleTick() {
  const hint = _coopTitleHint(), count = _coop.pendingPad !== null ? 2 : 1;
  if (hint === _coop.titleHint && count === _coop.titleCount) return;
  _coop.titleHint = hint; _coop.titleCount = count;
  const h = document.getElementById('coop-hint'), c = document.getElementById('coop-count');
  if (h) { h.textContent = hint; h.style.display = hint ? '' : 'none'; }
  if (c) c.textContent = count + 'P';
}

function coopState() {
  const devices = [];
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p) { devices.push(null); continue; }
    devices.push(i === 0
      ? { kbm: true, pad: pad.connected ? pad.index : null }
      : { kbm: false, pad: p.pad });
  }
  const hint = _coopTitleHint();
  return {
    n: players.length, title2P: !gameStarted && hint !== '', titleHint: hint,
    titleCount: _coop.pendingPad !== null || players.length > 1 ? 2 : 1,
    devices, pendingPad: _coop.pendingPad,
  };
}

// =====================================================================
// K5: down, revive, team second wind (2P only; 1P keeps SECOND WIND)
// =====================================================================
function _coopAnyStanding() {
  for (let i = 0; i < players.length; i++) if (playerStanding(players[i])) return true;
  return false;
}

// damagePlayer at 0 HP in 2P
function coopDown(p) {
  p.state = 'down';
  p.hp = 0;
  p.downT = CFG.COOP_DOWN_TIME;
  p._downTicked = false;
  p.reviveT = 0;
  p.dodging = false; p.reloading = false; p.vx = 0; p.vy = 0; p.walking = false;
  p.bleedT = 0;
  spawnBloodSpray(p.x, p.y, Math.random() * Math.PI * 2, 1.2, 10);
  if (!_coopAnyStanding()) coopTeamSecondWind();
}

// Nobody standing: the downed get up on the spot, the dead respawn beside the
// first downed one (or at the last midpoint), all with the SECOND WIND values
function coopTeamSecondWind() {
  if (typeof demoActive !== 'undefined' && demoActive) demoOnPlayerDeath(); // D6: same moment as 1P
  let first = null;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p || p.state !== 'down') continue;
    if (!first) first = p;
    p.state = 'up'; p.downT = 0; p.reviveT = 0;
    secondWind(p);
  }
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p || p.state !== 'dead') continue;
    _coopRespawnAt(p, first ? first.x : _coop.midX, first ? first.y : _coop.midY);
    secondWind(p);
  }
  showNotification('TEAM SECOND WIND!', 1.5);
}

function _coopRespawnAt(p, x, y) {
  p.state = 'up'; p.downT = 0; p.reviveT = 0;
  p.x = x + 30; p.y = y - 30;
  if (typeof resolveEnvCollision === 'function') resolveEnvCollision(p, 10);
  p.vx = 0; p.vy = 0; p.dodging = false; p.reloading = false; p.submerge = 0;
}

function _coopDie(p) {
  p.state = 'dead'; p.downT = 0; p.reviveT = 0;
  const a = Math.random() * Math.PI * 2;
  spawnGibs(p.x, p.y, a, 0, 1.25, 1); // G5: bloody
  spawnBloodSpray(p.x, p.y, a, 2.2, 12);
  spawnBloodSpray(p.x, p.y, a + Math.PI, 1.4, 12);
  bloodDecal(DECAL_POOL, p.x, p.y, 4, BLOOD_COLORS[3], 0, randRange(16, 26));
  addShake(4);
  playSound('hit', 0.6);
  if (!_coopAnyStanding()) coopTeamSecondWind();
}

// After the players moved (update): bleed, count down, revive
function coopUpdateDown(dt) {
  if (players.length < 2) return;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p || p.state !== 'down') continue;
    if (!(p.downT > 0) && !p._downTicked) p.downT = CFG.COOP_DOWN_TIME; // K2.2: a zero timer can't kill on entry
    p._downTicked = true;
    p.downT -= dt;
    p.bleedT = (p.bleedT || 0) - dt;
    if (p.bleedT <= 0) { // lying, bleeding
      p.bleedT = 0.45;
      spawnBloodSpray(p.x, p.y, Math.random() * Math.PI * 2, 0.35, 3);
    }
    // the partner stands within COOP_REVIVE_RANGE for COOP_REVIVE_TIME
    let near = false;
    for (let j = 0; j < players.length; j++) {
      const o = players[j];
      if (o !== p && playerStanding(o) && dist(o.x, o.y, p.x, p.y) <= CFG.COOP_REVIVE_RANGE) near = true;
    }
    p.reviveT = near ? p.reviveT + dt : 0;
    if (p.reviveT >= CFG.COOP_REVIVE_TIME) {
      p.state = 'up'; p.downT = 0; p.reviveT = 0;
      p.hp = p.maxHp * CFG.COOP_REVIVE_HP;
      p.invincible = CFG.COOP_REVIVE_INVULN;
      playSound('pickup', 0.6);
    } else if (p.downT <= 0) _coopDie(p);
  }
}

// updateWaves at each wave start: the dead respawn beside the partner at full health
function coopOnWaveStart() {
  if (players.length < 2) return;
  let partner = null;
  for (let i = 0; i < players.length; i++) if (playerStanding(players[i])) { partner = players[i]; break; }
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p || p.state !== 'dead') continue;
    _coopRespawnAt(p, partner ? partner.x : _coop.midX, partner ? partner.y : _coop.midY);
    p.hp = p.maxHp; p.shield = p.maxShield;
    p.invincible = CFG.COOP_REVIVE_INVULN;
  }
}

function resetCoop() {
  players.length = 1;
  cam.z = 1;
  _coop.target = 1; _coop.zoomingIn = false; _coop.forced = null;
  _coop.pendingPad = null; _coop.titleHint = null;
  if (typeof padAttachP2 === 'function') padAttachP2(-1);
}
