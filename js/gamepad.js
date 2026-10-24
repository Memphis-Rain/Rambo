// =====================================================================
// GAMEPAD (M10) - Xbox / standard-mapping controller via the Gamepad API
// =====================================================================
// The pad drives the same input state as keyboard + mouse (keys[],
// mouseX/Y, mouseDown, mouseJustPressed, mouseRightJustPressed), so the
// game logic is shared; pad-only extras: analog move speed, the twin-stick
// aim point (reticle), the C3 aim assist and rumble.
//
// Contract (HUD / tests):
//   pollGamepad()      once per display frame, top of gameLoop (main.js)
//   pad                { connected, index, id, lx, ly, rx, ry, lmag, rmag,
//                        value[17], pressed[17], justPressed[17] } (standard
//                        mapping indices, PAD_BTN); sticks after the deadzone
//   padStick(x, y, dz, out) -> out {x, y, mag}; padDeadzone(m, dz) (pure,
//                        radial: magnitude rescaled (m - dz) / (1 - dz), <= 1)
//   inputDevice        'kbm' | 'pad' (last used wins)
//   padAim             { x, y, dirX, dirY, dist, has } world aim point =
//                        player + dir x (180 + rmag x 240); the reticle
//   padAssistTarget(px, py, dirX, dirY, maxDist, coneDeg) -> enemy | null
//   padRumble(weak, strong, ms) -> bool (played)
//   padState()         { connected, inputDevice, disconnectPaused, sprint }
//   padStats()         { connected, inputDevice, disconnectPauses,
//                        rumblePlayed, rumbleSkipped, toasts }

const PAD_BTN = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9,
  L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16,
};
const PAD_NB = 17;
const pad = {
  connected: false, index: -1, id: '',
  lx: 0, ly: 0, rx: 0, ry: 0, lmag: 0, rmag: 0,
  value: new Float32Array(PAD_NB), pressed: new Uint8Array(PAD_NB), justPressed: new Uint8Array(PAD_NB),
};
let inputDevice = 'kbm';
const padAim = { x: 0, y: 0, dirX: 1, dirY: 0, dist: 180, has: false };
const _padStats = { disconnectPauses: 0, rumblePlayed: 0, rumbleSkipped: 0, toasts: 0 };
const _padL = { x: 0, y: 0, mag: 0 }, _padR = { x: 0, y: 0, mag: 0 };
const _padOwned = {};          // keys[] entries the pad set (released on device switch)
const _padPulse = [];          // edge keys to clear at the next poll if unconsumed
const _padAimPt = { x: 0, y: 0 };
let _padMouseOwned = false;
let _padSprint = false;
let _padDisconnectPaused = false;
let _padRumbleAt = -1e9;
let _padRumbleUntil = -1e9, _padRumbleStr = 0;   // the effect playing now
let _padRumbleQ = null;                         // strongest effect blocked by the gap
const _padRumbleQBuf = { weak: 0, strong: 0, ms: 0 };
let _padTapT = -1;                              // gameTime the pending taps were set
let _padPrevR = 0;                              // right-stick magnitude last poll (spring-back)
let _padToastPending = false;
let _padMouseAX = null, _padMouseAY = null;

function padDeadzone(m, dz) {
  if (!(m > dz)) return 0;
  return Math.min(1, (m - dz) / (1 - dz));
}

function padStick(x, y, dz, out) {
  const m = Math.sqrt(x * x + y * y);
  const r = padDeadzone(m, dz);
  if (r <= 0) { out.x = 0; out.y = 0; out.mag = 0; return out; }
  out.x = x / m * r; out.y = y / m * r; out.mag = r;
  return out;
}

function _padList() {
  return typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : null;
}

// The pad in use, or the first connected standard-mapping pad
function _padGet() {
  const gps = _padList();
  if (!gps) return null;
  if (pad.index >= 0) {
    const g = gps[pad.index];
    if (g && g.connected) return g;
  }
  for (let i = 0; i < gps.length; i++) {
    const g = gps[i];
    if (g && g.connected && g.mapping === 'standard') { pad.index = i; return g; }
  }
  return null;
}

function _padKey(k, v) {
  if (v) { keys[k] = true; _padOwned[k] = true; }
  else if (_padOwned[k]) { keys[k] = false; delete _padOwned[k]; }
}
function _padTap(k) { keys[k] = true; _padOwned[k] = true; _padPulse.push(k); _padTapT = gameTime; }

// Hand everything the pad holds back to keyboard + mouse
function _padRelease() {
  for (const k in _padOwned) { keys[k] = false; delete _padOwned[k]; }
  _padPulse.length = 0;
  if (_padMouseOwned) { mouseDown = false; _padMouseOwned = false; }
  _padSprint = false;
}

function _padSetDevice(d) {
  if (inputDevice === d) return;
  inputDevice = d;
  if (d === 'kbm') _padRelease();
  const b = typeof document !== 'undefined' ? document.body : null;
  if (b && b.style) b.style.cursor = d === 'pad' ? 'none' : '';
}

// Real mouse travel past 8 px or any key switches back to mouse aim (main.js)
function padNoteMouseMove(x, y) {
  if (inputDevice !== 'pad') { _padMouseAX = x; _padMouseAY = y; return; }
  if (_padMouseAX === null) { _padMouseAX = x; _padMouseAY = y; return; }
  const dx = x - _padMouseAX, dy = y - _padMouseAY;
  if (dx * dx + dy * dy > 64) { _padMouseAX = x; _padMouseAY = y; _padSetDevice('kbm'); }
}
// Returns true when the key only resumed a pad-disconnect pause (swallow it)
function padNoteKey() {
  _padSetDevice('kbm');
  if (!_padDisconnectPaused) return false;
  padResumeFromDisconnect();
  return true;
}

function _padToast() {
  if (!_padToastPending || !gameStarted || demoActive) return;
  _padToastPending = false;
  _padStats.toasts++;
  if (typeof showNotification === 'function') showNotification('CONTROLLER CONNECTED', 2);
}

// C7: body.pad-connected shows the pad legend on the title
function _padBodyClass(on) {
  const b = typeof document !== 'undefined' ? document.body : null;
  if (b && b.classList) b.classList.toggle('pad-connected', on);
}

function _padFound(g) {
  pad.connected = true; pad.id = g.id || '';
  pad.pressed.fill(0); pad.justPressed.fill(0);
  // C6 toast; on the title the legend swap shows it, the toast waits for the game
  _padToastPending = true;
  _padToast();
  _padBodyClass(true);
}

function _padLost() {
  const wasPad = inputDevice === 'pad';
  pad.connected = false; pad.index = -1;
  _padToastPending = false;
  pad.pressed.fill(0); pad.justPressed.fill(0);
  pad.lx = pad.ly = pad.rx = pad.ry = pad.lmag = pad.rmag = 0;
  _padSetDevice('kbm');
  _padBodyClass(false);
  // C6: the pad in use dropped mid-game -> auto-pause
  if (wasPad && gameStarted && !demoActive && !paused) {
    paused = true;
    _padDisconnectPaused = true;
    _padStats.disconnectPauses++;
    lastTime = performance.now();
    _padPauseOverlay();
  }
}

// The HUD pause overlay (no-op headless, before the UI exists)
function _padPauseOverlay() {
  if (typeof renderPauseOverlay === 'function' && typeof uiContainer !== 'undefined' && uiContainer) renderPauseOverlay();
}

function padResumeFromDisconnect() {
  if (!_padDisconnectPaused) return;
  _padDisconnectPaused = false;
  paused = false;
  lastTime = performance.now();
  _padPauseOverlay();
}

function _padTogglePause() {
  if (_padDisconnectPaused) { padResumeFromDisconnect(); return; }
  paused = !paused;
  lastTime = performance.now();
  _padPauseOverlay();
}

// Stick (screen-space) direction -> unit world direction under the iso view
function _padWorldDir(sx, sy, out) {
  const iso = CFG.ISO_SCALE;
  const wx = (sx + sy / iso) * 0.5, wy = (sy / iso - sx) * 0.5;
  const l = Math.sqrt(wx * wx + wy * wy) || 1;
  out.x = wx / l; out.y = wy / l;
  return out;
}

// C3 aim assist: the live enemy whose body lies within +-coneDeg of the ray
// (px, py) + t (dirX, dirY), 0 < t <= maxDist, nearest along the ray
function padAssistTarget(px, py, dirX, dirY, maxDist, coneDeg) {
  const cone = coneDeg * Math.PI / 180;
  let best = null, bestT = Infinity;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead) continue;
    aimPointOf(e, _padAimPt);
    const vx = _padAimPt.x - px, vy = _padAimPt.y - py;
    const t = vx * dirX + vy * dirY;
    if (t <= 0 || t > maxDist || t >= bestT) continue;
    const side = Math.abs(vx * dirY - vy * dirX);
    // the body (radius 15 x size) only has to reach into the cone
    if (Math.atan2(side, t) - Math.atan2(15 * (e.size || 1), t) <= cone) { best = e; bestT = t; }
  }
  return best;
}

function _padScreenX(wx, wy) {
  const ox = worldOffsetX !== null ? worldOffsetX : W / 2 - cam.x;
  return (wx - wy) + ox;
}
function _padScreenY(wx, wy) {
  const oy = worldOffsetY !== null ? worldOffsetY : H / 2 - cam.y;
  return (wx + wy) * CFG.ISO_SCALE + oy;
}

function pollGamepad() {
  // Taps are pulses: drop the unconsumed ones only after a simulated frame
  // that could have used them (not during hit-stop or a dodge roll)
  if (_padPulse.length && gameTime > _padTapT && !(player && player.dodging)) {
    for (const k of _padPulse) if (_padOwned[k]) { keys[k] = false; delete _padOwned[k]; }
    _padPulse.length = 0;
  }
  _padRumbleFlush();
  const g = _padGet();
  if (!g) { if (pad.connected) _padLost(); return; }
  if (!pad.connected) _padFound(g);
  else _padToast();

  let held = false, edge = false;
  for (let i = 0; i < PAD_NB; i++) {
    const b = g.buttons[i];
    const v = b ? (typeof b === 'object' ? b.value || 0 : +b) : 0;
    const down = i === PAD_BTN.LT || i === PAD_BTN.RT
      ? v > (pad.pressed[i] ? CFG.PAD_TRIGGER - 0.05 : CFG.PAD_TRIGGER) // hysteresis
      : !!(b && (b.pressed || v > 0.5));
    pad.justPressed[i] = down && !pad.pressed[i] ? 1 : 0;
    pad.pressed[i] = down ? 1 : 0;
    pad.value[i] = v;
    if (down) held = true;
    if (pad.justPressed[i]) edge = true;
  }
  const ax = g.axes || [];
  padStick(ax[0] || 0, ax[1] || 0, CFG.PAD_DEADZONE, _padL);
  padStick(ax[2] || 0, ax[3] || 0, CFG.PAD_DEADZONE, _padR);
  pad.lx = _padL.x; pad.ly = _padL.y; pad.lmag = _padL.mag;
  pad.rx = _padR.x; pad.ry = _padR.y; pad.rmag = _padR.mag;
  const active = held || pad.lmag > 0 || pad.rmag > 0;
  const jp = pad.justPressed;

  // C5: title / attract mode
  if (typeof demoActive !== 'undefined' && demoActive) {
    if (active) demoNoteInput(); // ends the demo; the press doesn't also start a game (D6)
    return;
  }
  if (!gameStarted) {
    if (active) { _padSetDevice('pad'); demoNoteInput(); }
    if ((jp[PAD_BTN.A] || jp[PAD_BTN.START]) && typeof startGame === 'function') startGame();
    return;
  }
  if (active) _padSetDevice('pad');

  // Pause: Start toggles; A / B also resume (C5)
  if (jp[PAD_BTN.START] || (paused && (jp[PAD_BTN.A] || jp[PAD_BTN.B]))) {
    const resume = paused;
    _padTogglePause();
    if (!resume) return;
    jp.fill(0); // the resume press itself isn't an action
  }
  if (paused || inputDevice !== 'pad' || !player) return;

  // C3 aim: right stick sets the direction; released keeps it; before any
  // right-stick input, follow the left stick
  // Spring-back: a released stick passes through small magnitudes on its way
  // to centre. Rising or steady input aims at once; a falling magnitude only
  // once it holds for a poll, so a release keeps the last aim
  const steady = pad.rmag >= _padPrevR - CFG.PAD_AIM_SETTLE;
  _padPrevR = pad.rmag;
  if (pad.rmag > 0 && steady) {
    _padWorldDir(pad.rx, pad.ry, _padAimPt);
    padAim.dirX = _padAimPt.x; padAim.dirY = _padAimPt.y;
    padAim.dist = CFG.PAD_AIM_MIN + pad.rmag * CFG.PAD_AIM_RANGE;
    padAim.has = true;
  } else if (!padAim.has && pad.lmag > 0) {
    _padWorldDir(pad.lx, pad.ly, _padAimPt);
    padAim.dirX = _padAimPt.x; padAim.dirY = _padAimPt.y;
    padAim.dist = CFG.PAD_AIM_MIN + pad.lmag * CFG.PAD_AIM_RANGE;
  }
  padAim.x = player.x + padAim.dirX * padAim.dist;
  padAim.y = player.y + padAim.dirY * padAim.dist;
  // The reticle drives the cursor path (G13 picking, N1 ground point); the
  // assist moves only the shot onto the enemy's visible torso
  let tx = padAim.x, ty = padAim.y, tz = 0;
  const as = CFG.PAD_AIM_ASSIST ? padAssistTarget(player.x, player.y, padAim.dirX, padAim.dirY, CFG.PAD_ASSIST_RANGE, CFG.PAD_ASSIST_DEG) : null;
  if (as) {
    tx = as.x; ty = as.y;
    tz = entityWaterlineH(as) + (entityDrawnH(as) - entityWaterlineH(as)) * 0.45; // visible torso
  }
  mouseX = _padScreenX(tx, ty);
  mouseY = _padScreenY(tx, ty) - tz;

  // C2 mapping
  const rt = pad.pressed[PAD_BTN.RT];
  if (rt) { mouseDown = true; _padMouseOwned = true; }
  else if (_padMouseOwned) { mouseDown = false; _padMouseOwned = false; }
  if (jp[PAD_BTN.RT]) mouseJustPressed = true;
  if (jp[PAD_BTN.LT]) mouseRightJustPressed = true;
  if (jp[PAD_BTN.A]) _padTap(' ');
  if (jp[PAD_BTN.LB] || jp[PAD_BTN.LEFT]) _padTap('q');
  if (jp[PAD_BTN.RB] || jp[PAD_BTN.RIGHT] || jp[PAD_BTN.Y]) _padTap('e');
  _padKey('r', !!pad.pressed[PAD_BTN.X]);
  if (jp[PAD_BTN.B]) _grenadeWant = true; // combat.js throws at padAim while pad-aiming
  if (jp[PAD_BTN.L3]) _padSprint = !_padSprint;
  if (pad.lmag <= 0) _padSprint = false; // sprint toggle cancels on stop
  _padKey('shift', _padSprint);
  if (edge || pad.lmag > 0 || pad.rmag > 0) player.idleT = 0;
}

// C4: dual-rumble where supported, silent elsewhere; one effect per 50 ms
function padRumble(weak, strong, ms) {
  // never during attract mode (the bot's shots must not shake an idle pad)
  if (!CFG.PAD_RUMBLE || inputDevice !== 'pad' || !pad.connected || demoActive) return false;
  const now = performance.now();
  const str = Math.max(weak, strong);
  if (now < _padRumbleUntil && str < _padRumbleStr) { _padStats.rumbleSkipped++; return false; } // weaker: never cuts a stronger one
  if (now - _padRumbleAt < CFG.PAD_RUMBLE_GAP_MS) {
    _padStats.rumbleSkipped++;
    if (!_padRumbleQ || str > Math.max(_padRumbleQ.weak, _padRumbleQ.strong)) {
      _padRumbleQ = _padRumbleQBuf; _padRumbleQ.weak = weak; _padRumbleQ.strong = strong; _padRumbleQ.ms = ms;
    }
    return false;
  }
  return _padRumblePlay(weak, strong, ms, now);
}

function _padRumbleFlush() {
  const q = _padRumbleQ;
  if (!q) return;
  const now = performance.now();
  if (now - _padRumbleAt < CFG.PAD_RUMBLE_GAP_MS) return;
  _padRumbleQ = null;
  if (now < _padRumbleUntil && Math.max(q.weak, q.strong) < _padRumbleStr) return;
  if (CFG.PAD_RUMBLE && inputDevice === 'pad' && pad.connected && !demoActive) _padRumblePlay(q.weak, q.strong, q.ms, now);
}

function _padRumblePlay(weak, strong, ms, now) {
  const g = _padGet();
  const act = g && g.vibrationActuator;
  if (!act || typeof act.playEffect !== 'function') return false;
  const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0);
  try {
    const r = act.playEffect('dual-rumble', {
      startDelay: 0, duration: Math.max(1, Math.min(1000, ms | 0)),
      weakMagnitude: clamp01(weak), strongMagnitude: clamp01(strong),
    });
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch { return false; }
  _padRumbleAt = now;
  _padRumbleUntil = now + Math.max(1, Math.min(1000, ms | 0));
  _padRumbleStr = Math.max(clamp01(weak), clamp01(strong));
  _padStats.rumblePlayed++;
  return true;
}

function padState() {
  return { connected: pad.connected, inputDevice, disconnectPaused: _padDisconnectPaused, sprint: _padSprint };
}

function padStats() {
  return { connected: pad.connected, inputDevice, disconnectPauses: _padStats.disconnectPauses,
    rumblePlayed: _padStats.rumblePlayed, rumbleSkipped: _padStats.rumbleSkipped, toasts: _padStats.toasts };
}
