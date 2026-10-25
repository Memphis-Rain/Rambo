// =====================================================================
// ATTRACT MODE / CPU DEMO (M6) - bot + demo controller
// The bot drives the player ONLY through the virtual inputs a human
// uses (keys map, mouse screen position, mouseDown/JustPressed,
// right-click, R, Space, weapon keys). It never edits player/enemy state.
// Loaded after combat.js. main.js owns the hooks (see SPEC M6).
// =====================================================================

let demoActive = false;

const DEMO_KEYMAP = ['1','2','3','4','5','6','7','8','9','0','-'];
// Showcase order: the loud stuff first; continues where the last demo stopped
const DEMO_SHOWCASE = [1, 2, 5, 7, 8, 9, 10, 6, 4, 3, 0];
const DEMO_MOUSE_THRESHOLD = 8;   // px of real mouse travel that counts as input (D1)
const DEMO_ENGAGE_RANGE = 900;    // world units: consider enemies for targeting
const DEMO_LEASH = 600;           // fully pulled back toward the origin around here
const DEMO_LEASH_SOFT = 400;      // the leash pull ramps in smoothly from here (no on/off edge)
const DEMO_LEASH_FULL = 550;      // full pull here, so the held-strafe equilibrium stays inside DEMO_LEASH
const DEMO_MOVE_HOLD = 0.4;       // D3a: minimum time a chosen direction is held      // the pull ramps in smoothly from here (no on/off edge)
const DEMO_START_WAVE = 10;       // first demo wave (real play starts at 1)
const DEMO_WAVE_GAP = 1.0;        // max seconds between waves in the demo (ramps faster, D4)
const DEMO_GRENADE_GAP = 4;       // N1: at most one throw per 4 s of game time
const DEMO_GRENADE_MIN = 4;       // N1: enemies within GRENADE_RADIUS of the target point
const DEMO_GRENADE_EVAL = 0.25;   // the cluster search runs at most this often (game s)
const DEMO_PREF_DIST = {
  Pistol: 240, Uzi: 210, Shotgun: 130, M16: 260, Minigun: 230, RPG: 330,
  Plasma: 270, Flamethrower: 180, Railgun: 360, BFG: 380, Disintegrator: 250,
};

// M11 K7: the bot runs once per CPU player; these point at the one it drives:
// its state (P1: _demo itself), its controls (P1: the shared globals via
// _p1Ctl, P2: its ctl) and the player
let _dB = null, _dC = null, _dP = null;
let _demo2 = null;                // P2's bot state in a 2P attract cycle

const _demo = {
  elapsed: 0, idleTimer: 0, endPending: false,
  weaponTimer: 0, showcasePos: 0, weaponIndex: 0, wantWeapon: -1,
  target: null, targetId: -1, nextId: 1,
  pulsed: [],                       // one-frame keys, released next frame
  moveIdx: -1, strafeDir: 1, strafeTimer: 0,
  jx: 0, jy: 0, jtx: 0, jty: 0, jitterTimer: 0,
  originX: 0, originY: 0, patrolA: 0,
  dodgeLock: 0, reloadLock: 0,
  anchorX: null, anchorY: null,    // last real mouse position that counted as input
  overlay: null, styleInjected: false,
  terrain: new Map(),
  lastGrenadeT: -Infinity, grenadesThrown: 0, grenadeEvalT: 0, // N1
  cycle: 0,                        // K7: idle-started attract cycles since load (every 2nd runs 2P)
};

// ---------------------------------------------------------------------
// Pure aim-lead math (D8). Shooter (sx,sy), target (tx,ty) moving with
// (tvx,tvy), bullet speed in world units/s. Returns the world point to aim
// at so a straight bullet meets the target, or the target's current
// position if no intercept exists. No globals, no randomness.
// ---------------------------------------------------------------------
// Optional `out` receives the result instead of a new object (the bot
// passes a scratch object so its per-frame aim allocates nothing).
function demoAimLead(sx, sy, tx, ty, tvx, tvy, bulletSpeed, out) {
  const r = out || { x: 0, y: 0 };
  r.x = tx; r.y = ty;
  const rx = tx - sx, ry = ty - sy;
  const s = bulletSpeed;
  if (!(s > 0) || !isFinite(s) || !isFinite(tvx) || !isFinite(tvy)) return r;
  const a = tvx * tvx + tvy * tvy - s * s;
  const b = 2 * (rx * tvx + ry * tvy);
  const c = rx * rx + ry * ry;
  let t = -1;
  if (Math.abs(a) < 1e-9) {
    if (b < 0) t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
      const lo = Math.min(t1, t2), hi = Math.max(t1, t2);
      t = lo > 0 ? lo : hi > 0 ? hi : -1;
    }
  }
  if (!(t > 0) || !isFinite(t)) return r;
  r.x = tx + tvx * t; r.y = ty + tvy * t;
  return r;
}

// ---------------------------------------------------------------------
// Controller API
// ---------------------------------------------------------------------
function demoState() {
  return {
    active: demoActive,
    elapsed: _demo.elapsed,
    weaponIndex: _demo.weaponIndex,
    targetId: _demo.target ? _demo.targetId : -1,
    idleTimer: _demo.idleTimer,
    grenadesThrown: _demo.grenadesThrown,
    players: players.length, // K7: 2 in a 2P attract cycle
  };
}

// opts.coop: force a 2P cycle (tests); otherwise every 2nd IDLE-started cycle
// is 2P (K7) and a direct startDemo() call is 1P
function startDemo(opts) {
  if (demoActive || gameStarted) return false; // only from the title
  _demoClearInputs();
  resetRound();
  // D4 showcase setup
  unlockedWeapons = WEAPONS.length;
  wave = DEMO_START_WAVE - 1; // updateWaves increments on the first frame
  waveTimer = 0.3;
  waveActive = false;

  _demo.elapsed = 0;
  _demo.idleTimer = 0;
  _demo.endPending = false;
  _demo.weaponTimer = Infinity; // press the first showcase weapon on frame 1
  _demo.wantWeapon = -1;
  _demoInitBot(_demo, player);
  _demo.weaponIndex = player ? player.weapon : 0;
  _demo.terrain.clear();
  // K7: every 2nd attract cycle runs two CPU players (the 2P HUD sells the mode)
  const fromIdle = !!(opts && opts.fromIdle);
  if (fromIdle) _demo.cycle++;
  _demo2 = null;
  const coop = opts && opts.coop !== undefined ? !!opts.coop : fromIdle && _demo.cycle % 2 === 0;
  if (coop && player && typeof coopJoin === 'function') {
    const p2 = coopJoin(null);
    if (p2) {
      p2.ctl.device = 'kbm'; // the bot aims with the virtual mouse, like P1's
      _demo2 = { pulsed: [], showcasePos: 3 }; // a different weapon from P1's
      _demoInitBot(_demo2, p2);
      _demo2.weaponTimer = Infinity;
    }
  }

  demoActive = true;
  gameStarted = true;
  paused = false;
  _demoSetStartScreen(false);
  _demoShowOverlay(true);
  return true;
}

// Per-bot state (the order of the Math.random calls is P1's, as before K7)
function _demoInitBot(b, p) {
  b.target = null; b.targetId = -1;
  b.moveIdx = -1; b.moveHold = 0; b.flipCd = 0; b.dirAge = 0;
  b.huntBest = Infinity; b.huntT = 0;
  b.losBlocked = false; b.losBlockedT = 0;
  b.strafeDir = Math.random() < 0.5 ? -1 : 1;
  b.strafeTimer = 2;
  b.jx = b.jy = b.jtx = b.jty = 0; b.jitterTimer = 0;
  b.dodgeLock = 0; b.reloadLock = 0;
  b.originX = p ? p.x : 0;
  b.originY = p ? p.y : 0;
  b.patrolA = Math.random() * Math.PI * 2;
  b.lastGrenadeT = -Infinity; b.grenadesThrown = 0; b.grenadeEvalT = 0;
  if (b !== _demo) { b.wantWeapon = -1; b.chasingFar = false; b.weaponTimer = 0; }
}

function stopDemo() {
  if (!demoActive) return false;
  demoActive = false;
  _demo.endPending = false;
  _demo.target = null; _demo.targetId = -1;
  _demo2 = null;
  _demoClearInputs();
  resetRound();
  _demoClearInputs();
  gameStarted = false;
  paused = false;
  _demoSetStartScreen(true);
  _demoShowOverlay(false);
  _demo.idleTimer = 0;
  return true;
}

// Title screen idle timer (D1). Called every display frame while !gameStarted.
function updateDemoIdle(dt) {
  if (demoActive || gameStarted || paused) { _demo.idleTimer = 0; return; }
  if (!(dt > 0)) return;
  _demo.idleTimer += dt;
  if (_demo.idleTimer >= CFG.DEMO_IDLE_SECONDS) startDemo({ fromIdle: true });
}

// Real keydown / mousedown / wheel
function demoNoteInput() {
  _demo.idleTimer = 0;
  if (demoActive) stopDemo();
}

// Real mousemove (client coords). Counts as input only past 8 px of travel.
function demoNoteMouseMove(x, y) {
  if (_demo.anchorX === null) { _demo.anchorX = x; _demo.anchorY = y; return false; }
  const dx = x - _demo.anchorX, dy = y - _demo.anchorY;
  if (dx * dx + dy * dy <= DEMO_MOUSE_THRESHOLD * DEMO_MOUSE_THRESHOLD) return false;
  _demo.anchorX = x; _demo.anchorY = y;
  demoNoteInput();
  return true;
}

// Called from damagePlayer mid-update: only flag; end at the next updateDemo
function demoOnPlayerDeath() {
  if (demoActive) _demo.endPending = true;
}

// Called by main.js every simulated frame while demoActive, before update()
function updateDemo(dt) {
  if (!demoActive) return;
  if (_demo.endPending) { stopDemo(); return; }
  _demo.elapsed += dt;
  const maxS = CFG.DEMO_MAX_SECONDS !== undefined ? CFG.DEMO_MAX_SECONDS : 60;
  if (_demo.elapsed >= maxS) { stopDemo(); return; }
  if (!player) return;

  // Release last frame's one-frame presses
  for (const k of _demo.pulsed) keys[k] = false;
  _demo.pulsed.length = 0;
  mouseJustPressed = false;
  mouseRightJustPressed = false;

  // Showcase pacing: short breaks between waves so the screen stays busy
  if (!waveActive && waveTimer > DEMO_WAVE_GAP) waveTimer = DEMO_WAVE_GAP;

  _dB = _demo; _dC = _p1Ctl; _dP = player;
  if (player.state === 'up') _demoBot(dt); // K7: a downed CPU player waits for its partner
  _demo.weaponIndex = player.weapon;

  // K7: P2's bot drives P2's controls
  const p2 = _demo2 && players.length > 1 ? players[1] : null;
  if (p2 && p2.ctl) {
    const c2 = p2.ctl;
    for (const k of _demo2.pulsed) c2.keys[k] = false;
    _demo2.pulsed.length = 0;
    c2.mouseJustPressed = false;
    c2.mouseRightJustPressed = false;
    if (p2.state === 'up') { _dB = _demo2; _dC = c2; _dP = p2; _demoBot(dt); }
  }
  _dB = _demo; _dC = _p1Ctl; _dP = player;
}

// ---------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------
function _demoClearInputs() {
  for (const k in keys) keys[k] = false;
  mouseDown = false;
  mouseJustPressed = false;
  mouseRightDown = false;
  mouseRightJustPressed = false;
  _demo.pulsed.length = 0;
}

function _demoPress(k) {
  _dC.keys[k] = true;
  _dB.pulsed.push(k);
}

// D3b: would a non-piercing round from (x0,y0) to (x1,y1) hit a tree trunk,
// stump, crate or sandbag first? (same swept test the bullets use)
// A fire CONE, not a line: an obstacle blocks when it sits within its bullet
// radius plus a spread margin (grows with distance, capped) of the segment,
// short of the end point. Rounds fan out by +/- spread, so a zero-width
// line let trunks just off the line eat many shots.
function _demoLosBlocked(x0, y0, x1, y1, spread) {
  const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
  if (len2 <= 0) return false;
  const len = Math.sqrt(len2), ux = dx / len, uy = dy / len;
  const tanS = Math.tan(Math.min(spread, 0.3) * 0.6);
  const pad = 30 + Math.min(20, len * tanS);
  const minX = Math.min(x0, x1) - pad, maxX = Math.max(x0, x1) + pad;
  const minY = Math.min(y0, y1) - pad, maxY = Math.max(y0, y1) + pad;
  for (let i = 0; i < envObjects.length; i++) {
    const o = envObjects[i];
    if (o.x < minX || o.x > maxX || o.y < minY || o.y > maxY) continue;
    const r = envBulletRadius(o);
    if (r <= 0) continue;
    const rx = o.x - x0, ry = o.y - y0;
    const along = rx * ux + ry * uy;
    if (along < -r || along > len - 6) continue; // behind us, or past the target
    const perp = Math.abs(rx * uy - ry * ux);
    if (perp < r + 2 + Math.min(20, Math.max(0, along) * tanS)) return true;
  }
  return false;
}

// Dot product of two moves in WASD key space (< 0: turning back)
function _demoKeyDot(a, b) {
  return ((a.d ? 1 : 0) - (a.a ? 1 : 0)) * ((b.d ? 1 : 0) - (b.a ? 1 : 0)) +
         ((a.s ? 1 : 0) - (a.w ? 1 : 0)) * ((b.s ? 1 : 0) - (b.w ? 1 : 0));
}

// Aim the virtual mouse at a world point (inverse of updatePlayer's mapping)
function _demoAimAt(wx, wy) {
  const sx = wx - wy, sy = (wx + wy) * CFG.ISO_SCALE; // toScreen, inlined
  const hasOff = typeof worldOffsetX !== 'undefined' && worldOffsetX !== null &&
                 typeof worldOffsetY !== 'undefined' && worldOffsetY !== null;
  const z = cam.z; // M11 K3a
  const ox = hasOff ? worldOffsetX : W / 2 - cam.x * z;
  const oy = hasOff ? worldOffsetY : H / 2 - cam.y * z;
  _dC.mouseX = sx * z + ox;
  _dC.mouseY = sy * z + oy;
}

// Per-frame scratch storage (the bot allocates nothing per frame)
const _demoNearE = [], _demoNearD = [], _demoObs = [], _demoLogs = [];
const _demoAim = { x: 0, y: 0 };
const _demoWadeAim = { x: 0, y: 0 };
const _demoPhys = new Float32Array(8);   // per-move water/obstacle penalty (D3a)
const _demoScores = new Float32Array(8); // per-move total score this frame

// The 8 WASD combos and the world direction updatePlayer turns each into
let _demoMoves = null;
function _demoGetMoves() {
  if (_demoMoves) return _demoMoves;
  const iso = CFG.ISO_SCALE;
  _demoMoves = [];
  for (let sy = -1; sy <= 1; sy++) {
    for (let sx = -1; sx <= 1; sx++) {
      if (!sx && !sy) continue;
      const l = Math.sqrt(sx * sx + sy * sy);
      const nx = sx / l, ny = sy / l;
      const wx = nx * 0.5 + ny * 0.5 / iso;
      const wy = -nx * 0.5 + ny * 0.5 / iso;
      const wl = Math.sqrt(wx * wx + wy * wy);
      _demoMoves.push({ w: sy < 0, s: sy > 0, a: sx < 0, d: sx > 0, dx: wx / wl, dy: wy / wl });
    }
  }
  return _demoMoves;
}

function _demoIsWater(wx, wy) {
  const ts = CFG.TILE_SIZE;
  const tx = Math.floor(wx / ts), ty = Math.floor(wy / ts);
  const key = tx * 100003 + ty;
  let v = _demo.terrain.get(key);
  if (v === undefined) {
    if (_demo.terrain.size > 4000) _demo.terrain.clear();
    v = getTerrainTypeAt(tx * ts, ty * ts) === 'water';
    _demo.terrain.set(key, v);
  }
  return v;
}

function _demoThreatWeight(e) {
  const t = ENEMY_TYPES[e.type];
  let w;
  if (t.explodeOnDeath) w = 3.2;              // Bomber
  else if (t.name === 'Berserker') w = 3.0;
  else if (!t.shoots) w = t.speed >= 100 ? 2.0 : 1.6; // melee rushers
  else if (t.name === 'Sniper') w = 1.4;
  else w = 1.0;                                // ranged
  if (e.isBoss) w = Math.max(w, 2.6);
  return w;
}

function _demoOnScreen(p, e) {
  if (players.length > 1) { // K7: the shared (zoomed) camera view
    const sx = (e.x - e.y) - cam.x, sy = (e.x + e.y) * CFG.ISO_SCALE - cam.y;
    return Math.abs(sx) < ((W || 1280) / 2 - 24) / cam.z && Math.abs(sy) < ((H || 720) / 2 - 24) / cam.z;
  }
  // Relative to the player, who the camera follows; keep a margin
  const dx = e.x - p.x, dy = e.y - p.y;
  const sx = dx - dy, sy = (dx + dy) * CFG.ISO_SCALE; // toScreen, inlined
  const hw = (W || 1280) / 2 - 24, hh = (H || 720) / 2 - 24;
  return Math.abs(sx) < hw && Math.abs(sy) < hh;
}

// N1: find a grenade target: a point within GRENADE_RANGE of the player with
// >= DEMO_GRENADE_MIN live enemies inside GRENADE_RADIUS, the player outside
// that radius. Candidates are the enemies themselves, refined to the centroid
// of their cluster when that still qualifies. O(n^2) over <= 80 enemies, so
// the caller gates it (ammo, cooldown, 4 s gap, every DEMO_GRENADE_EVAL s).
// Returns true and fills `out` when a point qualifies.
const _demoGrenE = [];
const _demoGrenPt = { x: 0, y: 0 };
function _demoCountNear(x, y, n, R2) {
  let c = 0;
  for (let j = 0; j < n; j++) {
    const e = _demoGrenE[j], dx = e.x - x, dy = e.y - y;
    if (dx * dx + dy * dy < R2) c++;
  }
  return c;
}
function _demoGrenadePoint(p, out) {
  const R = CFG.GRENADE_RADIUS, R2 = R * R;
  const reach = CFG.GRENADE_RANGE + R; // enemies past this can't share a blast with an in-range point
  let n = 0;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead) continue;
    const dx = e.x - p.x, dy = e.y - p.y;
    if (dx * dx + dy * dy <= reach * reach) _demoGrenE[n++] = e;
  }
  if (n < DEMO_GRENADE_MIN) return false;
  const ok = (x, y) => {
    const dx = x - p.x, dy = y - p.y, d2 = dx * dx + dy * dy;
    return d2 > R2 && d2 <= CFG.GRENADE_RANGE * CFG.GRENADE_RANGE;
  };
  let bestC = 0;
  for (let i = 0; i < n; i++) {
    const c0 = _demoGrenE[i];
    if (!ok(c0.x, c0.y)) continue;
    let c = 0, sx = 0, sy = 0;
    for (let j = 0; j < n; j++) {
      const e = _demoGrenE[j], dx = e.x - c0.x, dy = e.y - c0.y;
      if (dx * dx + dy * dy < R2) { c++; sx += e.x; sy += e.y; }
    }
    if (c < DEMO_GRENADE_MIN || c <= bestC) continue;
    // The cluster centroid lands the blast closer to everyone in it
    const mx = sx / c, my = sy / c;
    const cm = ok(mx, my) ? _demoCountNear(mx, my, n, R2) : 0;
    if (cm >= c) { bestC = cm; out.x = mx; out.y = my; }
    else { bestC = c; out.x = c0.x; out.y = c0.y; }
  }
  for (let i = 0; i < n; i++) _demoGrenE[i] = null;
  return bestC >= DEMO_GRENADE_MIN;
}

// ---------------------------------------------------------------------
// Bot brain
// ---------------------------------------------------------------------
function _demoBot(dt) {
  const p = _dP;
  const wep = WEAPONS[p.weapon];
  const moves = _demoGetMoves();
  if (_dB.dodgeLock > 0) _dB.dodgeLock -= dt;
  if (_dB.reloadLock > 0) _dB.reloadLock -= dt;

  // --- Showcase weapon cycle (D4) ---
  _dB.weaponTimer += dt;
  if (_dB.weaponTimer >= CFG.DEMO_WEAPON_CYCLE) {
    _dB.weaponTimer = 0;
    _dB.wantWeapon = DEMO_SHOWCASE[_dB.showcasePos % DEMO_SHOWCASE.length] % WEAPONS.length;
    _dB.showcasePos++;
  }
  // Keep tapping the key until the switch lands (it is ignored mid-dodge)
  if (_dB.wantWeapon >= 0 && _dB.wantWeapon < unlockedWeapons && p.weapon !== _dB.wantWeapon) {
    _demoPress(DEMO_KEYMAP[_dB.wantWeapon]);
  }

  // --- Perception ---
  let nearestMelee = null, nearestMeleeD = Infinity;
  let inSpecial = 0, closeCount = 0;
  let nearN = 0;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead) continue;
    const d = dist(p.x, p.y, e.x, e.y);
    if (d < CFG.SPECIAL_RADIUS) inSpecial++;
    if (d < 150) closeCount++;
    if (d < 300) { _demoNearE[nearN] = e; _demoNearD[nearN] = d; nearN++; }
    const t = ENEMY_TYPES[e.type];
    if (!t.shoots && d < nearestMeleeD) { nearestMelee = e; nearestMeleeD = d; }
  }

  // --- Target selection with hysteresis ---
  let cur = _dB.target;
  if (cur && (cur.dead || enemies.indexOf(cur) < 0)) cur = null;
  let best = null, bestS = Infinity, curS = Infinity;
  let far = null, farD = Infinity;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead) continue;
    const d = dist(p.x, p.y, e.x, e.y);
    if (d > DEMO_ENGAGE_RANGE) { if (d < farD) { farD = d; far = e; } continue; }
    let s = d / _demoThreatWeight(e);
    if (e._demoLosBadUntil > _demo.elapsed) s *= 3; // D3b: its line of fire is blocked
    if (e === cur) curS = s;
    if (s < bestS) { bestS = s; best = e; }
  }
  // Nothing in range but the wave isn't over (e.g. a straggler stuck behind
  // terrain): hunt the nearest one so the next wave can start
  _dB.chasingFar = false;
  if (!best && far) { best = far; _dB.chasingFar = true; }
  if (cur && curS < Infinity && best !== cur && bestS > curS * 0.7) best = cur;
  if (best !== _dB.target) {
    _dB.target = best;
    if (best) {
      if (!best._demoId) best._demoId = _demo.nextId++; // one id space for both bots
      _dB.targetId = best._demoId;
    } else _dB.targetId = -1;
  }
  const tgt = _dB.target;
  const tgtD = tgt ? dist(p.x, p.y, tgt.x, tgt.y) : Infinity;
  const tgtVisible = tgt ? _demoOnScreen(p, tgt) : false;

  // --- Movement: score the 8 achievable directions ---
  _dB.strafeTimer -= dt;
  if (_dB.strafeTimer <= 0) { _dB.strafeDir *= -1; _dB.strafeTimer = randRange(3, 5); } // D3a: deliberate, readable strafing

  let wantX, wantY, wantW;
  if (tgt) {
    const tox = (tgt.x - p.x) / (tgtD || 1), toy = (tgt.y - p.y) / (tgtD || 1);
    let pref = DEMO_PREF_DIST[wep.name] || 250;
    if (ENEMY_TYPES[tgt.type].explodeOnDeath) pref = Math.max(pref, 230);
    // Deadband around the preferred range: without it the radial push flips
    // sign every time the distance crosses pref and the bot see-saws
    const off = tgtD - pref;
    const radial = Math.abs(off) < 40 ? 0 : clamp((off - Math.sign(off) * 40) / 60, -1.2, 1);
    // Blocked line of fire (D3b): strafe harder to open it up
    const strafe = _dB.losBlocked ? 1.6 : 0.9;
    wantX = tox * radial + (-toy) * _dB.strafeDir * strafe;
    wantY = toy * radial + tox * _dB.strafeDir * strafe;
    wantW = 1.6;
  } else {
    // Patrol a slow circle around the origin
    _dB.patrolA += dt * 0.4;
    const px = _dB.originX + Math.cos(_dB.patrolA) * 160;
    const py = _dB.originY + Math.sin(_dB.patrolA) * 160;
    wantX = px - p.x; wantY = py - p.y;
    wantW = 1.0;
  }
  const wl = Math.sqrt(wantX * wantX + wantY * wantY) || 1;
  wantX /= wl; wantY /= wl;

  const dO = dist(p.x, p.y, _dB.originX, _dB.originY);
  let leash = clamp((dO - DEMO_LEASH_SOFT) / (DEMO_LEASH_FULL - DEMO_LEASH_SOFT) * 3, 0, 4);
  // Stragglers keep a wave from ending: hunt them past the leash. Only for an
  // out-of-range target or the last couple of enemies (keying it on
  // visibility toggled the pull at the screen edge)
  const hunting = tgt && (_dB.chasingFar || enemies.length <= 2);
  if (hunting) leash = 0;
  // A straggler hunt that stops closing in for 4 s (e.g. water in the way)
  // wades through: water only slows, while a stalled hunt stalls the wave
  if (hunting) {
    if (tgtD < _dB.huntBest - 40) { _dB.huntBest = tgtD; _dB.huntT = 0; }
    else _dB.huntT += dt;
  } else { _dB.huntBest = Infinity; _dB.huntT = 0; }
  const wade = _dB.huntT > 4;
  const oX = dO > 0 ? (_dB.originX - p.x) / dO : 0, oY = dO > 0 ? (_dB.originY - p.y) / dO : 0;

  let pk = null, pkD = Infinity;
  if (p.hp < p.maxHp * 0.4) {
    for (const k of pickups) {
      if (k.type !== 'health') continue;
      const d = dist(p.x, p.y, k.x, k.y);
      if (d < 700 && d < pkD) { pk = k; pkD = d; }
    }
  }

  let obsN = 0;
  for (let i = 0; i < envObjects.length; i++) {
    const o = envObjects[i];
    const isBarrel = o.type === 'barrel' && !o.exploded;
    if (!o.collision && !isBarrel) continue;
    const dx = o.x - p.x, dy = o.y - p.y;
    if (dx > 170 || dx < -170 || dy > 170 || dy < -170) continue;
    _demoObs[obsN++] = o;
  }
  // E11: fallen logs near us are hurdles (slow to climb): a mild penalty,
  // never boxing the bot in (chunk-bucketed query)
  const logN = envLogsNear(p.x, p.y, 170);
  for (let i = 0; i < logN; i++) _demoLogs[i] = envLogHits[i];

  let bestM = -1, bestScore = -Infinity, curScore = -Infinity;
  for (let mi = 0; mi < moves.length; mi++) {
    const m = moves[mi];
    let sc = wantW * (m.dx * wantX + m.dy * wantY);
    // Crowd repulsion: rushers and bombers push hardest
    for (let ni = 0; ni < nearN; ni++) {
      const ne = _demoNearE[ni], nd = _demoNearD[ni];
      const t = ENEMY_TYPES[ne.type];
      const R = t.explodeOnDeath ? 260 : !t.shoots ? 220 : 160;
      if (nd >= R || nd <= 0) continue;
      const danger = t.explodeOnDeath ? 2.6 : !t.shoots ? 1.6 : 0.5;
      const prox = 1 - nd / R;
      const toward = (m.dx * (ne.x - p.x) + m.dy * (ne.y - p.y)) / nd;
      if (toward > 0) sc -= danger * prox * prox * toward * 2.2;
    }
    // Water lookahead (physical: may break the D3a direction hold)
    const sc0 = sc;
    if (!wade && _demoIsWater(p.x + m.dx * 45, p.y + m.dy * 45)) sc -= 4;
    if (!wade && _demoIsWater(p.x + m.dx * 100, p.y + m.dy * 100)) sc -= 2;
    // Obstacles and barrels
    for (let oi = 0; oi < obsN; oi++) {
      const o = _demoObs[oi];
      if (o.collision) {
        const r = o.collision + 16;
        // Penalty grows with how deep the probe sits inside the obstacle, so
        // it fades in smoothly instead of switching on at the probe edge
        for (let step = 22; step <= 66; step += 22) {
          const lx = p.x + m.dx * step - o.x, ly = p.y + m.dy * step - o.y;
          const d2 = lx * lx + ly * ly;
          if (d2 < r * r) { sc -= 1.5 * (1 - Math.sqrt(d2) / r) * 2 * (88 - step) / 66; break; }
        }
      } else {
        const d = dist(p.x, p.y, o.x, o.y);
        if (d < 160 && d > 0) {
          const toward = (m.dx * (o.x - p.x) + m.dy * (o.y - p.y)) / d;
          if (toward > 0) sc -= 1.2 * (1 - d / 160) * toward;
        }
      }
    }
    for (let li = 0; li < logN; li++) {
      const r = _demoLogs[li];
      const rr = r.logR + 16;
      for (let step = 22; step <= 66; step += 22) {
        const d2 = envSegDist2(p.x + m.dx * step, p.y + m.dy * step, r);
        if (d2 < rr * rr) { sc -= 0.6 * (1 - Math.sqrt(d2) / rr) * 2 * (88 - step) / 66; break; }
      }
    }
    _demoPhys[mi] = sc - sc0; // water + obstacle penalty of this move
    // Stay near the start area
    if (leash > 0) sc += leash * (m.dx * oX + m.dy * oY);
    // Health detour
    if (pk) sc += 2.4 * (m.dx * (pk.x - p.x) + m.dy * (pk.y - p.y)) / (pkD || 1);
    // Stickiness against flicker
    if (mi === _dB.moveIdx) { sc += 0.25; curScore = sc; }
    _demoScores[mi] = sc;
    if (sc > bestScore) { bestScore = sc; bestM = mi; }
  }
  // Boxed in: try the other strafe direction, at most once a second (flipping
  // every frame made the bot reverse diagonals back and forth)
  _dB.flipCd -= dt;
  if (bestScore < -2.5 && tgt && _dB.flipCd <= 0) { _dB.strafeDir *= -1; _dB.flipCd = 1; }
  // D3a: commit to a direction so movement reads as deliberate kiting. Any
  // change waits DEMO_MOVE_HOLD unless the current move is blocked; turning
  // back against it (key-space dot < 0) also needs a clearly better move.
  _dB.moveHold -= dt;
  _dB.dirAge += dt;
  if (_dB.moveIdx >= 0 && bestM !== _dB.moveIdx) {
    const cur = moves[_dB.moveIdx];
    // Only a physical block (water/obstacle ahead) or a dodge may break the
    // hold; crowd pressure is ordinary evasion and waits like any other change
    // Well past the leash and still heading out counts as blocked too
    const outward = leash > 0 && dO > DEMO_LEASH + 75 && cur.dx * oX + cur.dy * oY < 0;
    const blocked = _demoPhys[_dB.moveIdx] < -1.5 || outward;
    if (blocked) {
      // Blocked: turn aside (<= 90 deg) rather than reverse, if any side is open
      let side = -1, sideScore = -Infinity;
      for (let mi = 0; mi < moves.length; mi++) {
        if (_demoKeyDot(cur, moves[mi]) < 0 || _demoPhys[mi] < -1.5) continue;
        if (_demoScores[mi] > sideScore) { sideScore = _demoScores[mi]; side = mi; }
      }
      if (side >= 0 && _demoKeyDot(cur, moves[bestM]) < 0) bestM = side;
    } else {
      const reverse = _demoKeyDot(cur, moves[bestM]) < 0;
      // Turning back needs the direction held a while AND a clearly better move
      if (_dB.moveHold > 0 || (reverse && (_dB.dirAge < 0.8 || bestScore - curScore < 1.0))) bestM = _dB.moveIdx;
    }
  }
  if (bestM !== _dB.moveIdx) { _dB.moveHold = DEMO_MOVE_HOLD; _dB.dirAge = 0; }
  _dB.moveIdx = bestM;

  // --- Dodge roll (melee in range, bomber close, or a bullet about to hit) ---
  let dodgeX = 0, dodgeY = 0, wantDodge = false;
  if (!p.dodging && p.dodgeCooldown <= 0 && _dB.dodgeLock <= 0) {
    if (nearestMelee) {
      const t = ENEMY_TYPES[nearestMelee.type];
      const trig = t.explodeOnDeath ? 90 : nearestMelee.range + 18;
      if (nearestMeleeD < trig && nearestMeleeD > 0) {
        dodgeX = (p.x - nearestMelee.x) / nearestMeleeD;
        dodgeY = (p.y - nearestMelee.y) / nearestMeleeD;
        wantDodge = true;
      }
    }
    if (!wantDodge) {
      for (let i = 0; i < bullets.length; i++) {
        const b = bullets[i];
        if (b.owner !== 'enemy') continue;
        const rx = b.x - p.x, ry = b.y - p.y;
        const vv = b.vx * b.vx + b.vy * b.vy;
        if (vv <= 0) continue;
        const t = -(rx * b.vx + ry * b.vy) / vv;
        if (t <= 0 || t > 0.25) continue;
        const cx = rx + b.vx * t, cy = ry + b.vy * t;
        const cd = Math.sqrt(cx * cx + cy * cy);
        if (cd > 20) continue;
        // Roll perpendicular to the bullet, away from its closest pass
        const vl = Math.sqrt(vv);
        let nx = -b.vy / vl, ny = b.vx / vl;
        if (nx * cx + ny * cy > 0) { nx = -nx; ny = -ny; }
        dodgeX = nx; dodgeY = ny;
        wantDodge = true;
        break;
      }
    }
    if (wantDodge && Math.random() < 0.15) { wantDodge = false; _dB.dodgeLock = 0.3; } // human miss
  }
  if (wantDodge) {
    let bi = bestM, bs = -Infinity;
    for (let mi = 0; mi < moves.length; mi++) {
      const m = moves[mi];
      let sc = m.dx * dodgeX + m.dy * dodgeY;
      if (_demoIsWater(p.x + m.dx * 125, p.y + m.dy * 125)) sc -= 3;
      if (sc > bs) { bs = sc; bi = mi; }
    }
    bestM = bi;
    _demoPress(' ');
    _dB.dodgeLock = 0.6;
    // Keep running the way we rolled instead of snapping straight back
    _dB.moveIdx = bi;
    _dB.moveHold = 0.45; _dB.dirAge = 0;
  }

  const mv = moves[bestM];
  _dC.keys['w'] = mv.w; _dC.keys['a'] = mv.a; _dC.keys['s'] = mv.s; _dC.keys['d'] = mv.d;
  _dC.keys['shift'] = !!pk || dO > DEMO_LEASH + 150 || (nearestMelee !== null && nearestMeleeD < 110) ||
    (tgt !== null && !tgtVisible && tgtD > 500 && dO < DEMO_LEASH);

  // --- Aim: lead the target + smoothed human jitter ---
  _dB.jitterTimer -= dt;
  if (_dB.jitterTimer <= 0) {
    _dB.jitterTimer = randRange(0.12, 0.25);
    const r = (4 + (isFinite(tgtD) ? tgtD : 200) * 0.03) * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    _dB.jtx = Math.cos(a) * r; _dB.jty = Math.sin(a) * r;
  }
  const jk = 1 - Math.exp(-dt * 12);
  _dB.jx += (_dB.jtx - _dB.jx) * jk;
  _dB.jy += (_dB.jty - _dB.jy) * jk;

  if (tgt) {
    const tvx = tgt.stunTimer > 0 ? (tgt.knockbackX || 0) : (tgt.vx || 0);
    const tvy = tgt.stunTimer > 0 ? (tgt.knockbackY || 0) : (tgt.vy || 0);
    // W2: a wading target is hit on its visible column, not at its feet
    const ap = aimPointOf(tgt, _demoWadeAim);
    const aim = demoAimLead(p.x, p.y, ap.x, ap.y, tvx, tvy, wep.speed, _demoAim);
    _demoAimAt(aim.x + _dB.jx, aim.y + _dB.jy);
  } else {
    // Look where we're going
    _demoAimAt(p.x + mv.dx * 160 + _dB.jx, p.y + mv.dy * 160 + _dB.jy);
  }

  // --- Fire ---
  let fire = tgt !== null && tgtVisible && !p.reloading;
  // D3b: don't waste non-piercing fire into trees/crates/sandbags on the line
  _dB.losBlocked = false;
  // Check both the line to the target and the actually aimed (lead + jitter) line
  if (fire && !wep.pierce && (_demoLosBlocked(p.x, p.y, tgt.x, tgt.y, wep.spread) ||
      _demoLosBlocked(p.x, p.y, _demoAim.x + _dB.jx, _demoAim.y + _dB.jy, wep.spread))) {
    fire = false;
    _dB.losBlocked = true;
    _dB.losBlockedT += dt;
    // still blocked after a while: prefer another target for a moment
    if (_dB.losBlockedT > 1.2) { tgt._demoLosBadUntil = _demo.elapsed + 1.5; _dB.losBlockedT = 0; }
  } else _dB.losBlockedT = 0;
  if (fire) {
    // Don't shoot a barrel next to ourselves
    const ax = (tgt.x - p.x) / (tgtD || 1), ay = (tgt.y - p.y) / (tgtD || 1);
    for (let oi = 0; oi < obsN; oi++) {
      const o = _demoObs[oi];
      if (o.type !== 'barrel' || o.exploded) continue;
      const rx = o.x - p.x, ry = o.y - p.y;
      if (rx * rx + ry * ry > 150 * 150) continue;
      const along = rx * ax + ry * ay;
      if (along < 0 || along > tgtD) continue;
      if (Math.abs(rx * ay - ry * ax) < 18) { fire = false; break; }
    }
  }
  if (fire) {
    if (wep.auto) {
      _dC.mouseDown = true;
    } else if (p.fireTimer <= dt && Math.random() < 0.6) { // small human trigger delay
      _dC.mouseDown = true;
      _dC.mouseJustPressed = true;
    } else {
      _dC.mouseDown = false;
    }
  } else {
    _dC.mouseDown = false;
  }

  // --- Reload when low and nobody is close ---
  if (!p.reloading && _dB.reloadLock <= 0 && wep.mag > 1 && p.magAmmo < wep.mag && closeCount === 0) {
    const low = p.magAmmo <= Math.max(1, Math.floor(wep.mag * 0.25));
    const idle = !tgtVisible && p.magAmmo < wep.mag * 0.6;
    if (low || idle) { _demoPress('r'); _dB.reloadLock = 0.5; }
  }

  // --- Grenade (N1): a clustered group out of our own blast radius ---
  // Throws straight at the world point (the demo owns input; F would aim at
  // the virtual cursor, which is busy leading the gun target)
  if (p.grenades > 0 && p.grenadeCd <= 0 && gameTime - _dB.lastGrenadeT >= DEMO_GRENADE_GAP &&
      gameTime >= _dB.grenadeEvalT) {
    _dB.grenadeEvalT = gameTime + DEMO_GRENADE_EVAL;
    if (_demoGrenadePoint(p, _demoGrenPt) && throwGrenade(_demoGrenPt.x, _demoGrenPt.y, p)) {
      _dB.lastGrenadeT = gameTime;
      _dB.grenadesThrown++;
    }
  }

  // --- Shockwave when charged and swarmed ---
  if (p.specialCharge >= CFG.SPECIAL_MAX_CHARGE && p.specialCooldown <= 0 && inSpecial >= 5) {
    _dC.mouseRightJustPressed = true;
  }
}

// ---------------------------------------------------------------------
// Overlay (D5) + title screen toggling
// ---------------------------------------------------------------------
function _demoSetStartScreen(show) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('start-screen');
  if (el && el.style) el.style.display = show ? 'flex' : 'none';
}

function _demoGetOverlay() {
  if (_demo.overlay) return _demo.overlay;
  if (typeof document === 'undefined' || !document.createElement) return null;
  if (!_demo.styleInjected) {
    _demo.styleInjected = true;
    const st = document.createElement('style');
    st.id = 'demo-overlay-style';
    st.textContent =
      "#demo-overlay{position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:50;display:none;" +
      "font-family:'Press Start 2P',monospace;-webkit-font-smoothing:none;font-smooth:never;text-align:center}" +
      "#demo-overlay .demo-top{position:absolute;top:56px;left:0;right:0;font-size:32px;letter-spacing:8px;color:#ff2020;" +
      "text-shadow:4px 4px 0 #000,-2px -2px 0 #000,2px -2px 0 #000,-2px 2px 0 #000;animation:demo-blink 0.8s steps(1) infinite}" +
      "#demo-overlay .demo-bottom{position:absolute;bottom:40px;left:0;right:0;font-size:14px;letter-spacing:2px;color:#ffe000;" +
      "text-shadow:3px 3px 0 #000,-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000}" +
      "@keyframes demo-blink{0%{opacity:1}75%{opacity:0}}";
    (document.head || document.documentElement).appendChild(st);
  }
  const ov = document.createElement('div');
  ov.id = 'demo-overlay';
  const top = document.createElement('div');
  top.className = 'demo-top';
  top.textContent = 'DEMO';
  const bottom = document.createElement('div');
  bottom.className = 'demo-bottom';
  bottom.textContent = 'PRESS ANY KEY OR CLICK TO PLAY';
  ov.appendChild(top);
  ov.appendChild(bottom);
  (document.body || document.documentElement).appendChild(ov);
  _demo.overlay = ov;
  return ov;
}

function _demoShowOverlay(show) {
  if (!show && !_demo.overlay) return;
  const ov = _demoGetOverlay();
  if (ov && ov.style) ov.style.display = show ? 'block' : 'none';
}
