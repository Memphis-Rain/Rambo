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
//                        player + dir x (180 + rmag x 240); the reticle;
//                        has = an aim direction exists (either stick)
//   padAssistTarget(px, py, dirX, dirY, maxDist, coneDeg) -> enemy | null
//   padRumble(weak, strong, ms, p) -> bool (played); p = the player the event
//                        concerns (default P1): only that player's pad rumbles
//   padState()         { connected, inputDevice, disconnectPaused, sprint,
//                        disconnectWho (0 | 1 | 2: whose pad dropped) }
//   M11 K2: padOf(i) / padAimOf(i) -> player i's pad state / aim (0 = P1 =
//                        pad / padAim); P2's pad drives players[1].ctl only.
//                        P1's pad = the first standard pad not P2's (kept
//                        while connected); Start / A on any other pad joins P2;
//                        View on a lone pad P1 hasn't used joins P2 (coop.js)
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
let _padDisconnectWho = 0;                       // M11: 1 = P1's pad, 2 = P2's
let _padUsedIdx = -1;                            // M11 K2: the pad index P1 has given input with
const _padOwner = new Int8Array(16);             // K2.1: who lost each pad index (1 | 2; 0 = unknown)
const _padOwnerId = new Map();                   // K2.2: who lost a pad with this id (0 = two pads share it)
let _padViewRefused = false;                     // K2.2: a refused View press, until it's released

function _padNoteLoss(id, who) {
  if (!id) return;
  const v = _padOwnerId.get(id);
  _padOwnerId.set(id, v !== undefined && v !== who ? 0 : who);
}
// Who a (re)connected pad at index i belongs to: its id when that tells the
// lost pads apart (browsers may hand a returning pad another slot), else
// the index it was lost from; 0 = unknown
function _padOwnerOf(i, g) {
  const id = g && g.id;
  if (id && _padOwnerId.has(id)) return _padOwnerId.get(id);
  return i < _padOwner.length ? _padOwner[i] : 0;
}
// C4: per pad slot (0 = P1, 1 = P2): last start, the effect playing now, and
// the strongest effect blocked by the gap
function _padRumState() { return { at: -1e9, until: -1e9, str: 0, q: null, qBuf: { weak: 0, strong: 0, ms: 0 } }; }
const _padRum = [_padRumState(), _padRumState()];
let _padTapT = -1;                              // gameTime the pending taps were set
// C3 aim state per pad: rightUsed = RS has aimed (the left stick no longer
// steers the aim); prevR = right-stick magnitude last poll (spring-back)
const _padS1 = { rightUsed: false, prevR: 0 };
const _padShot = { x: 0, y: 0 };                 // _padAimStep: the shot point in CSS px
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

// K2.1: pollGamepad takes ONE getGamepads() snapshot per frame (C1); every
// reader until the next poll shares it (the raw call only before the first poll)
let _padSnap = null, _padN = 0;
function _padList() {
  if (_padSnap !== null) return _padSnap;
  return _padListRaw();
}
function _padListRaw() {
  return typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : null;
}

// The pad in use, or the first connected standard-mapping pad
function _padGet() {
  const gps = _padList();
  if (!gps) return null;
  const p2 = _pad2.index; // M11 K2: never P2's pad
  if (pad.index >= 0 && pad.index !== p2) {
    const g = gps[pad.index];
    if (g && g.connected) return g;
  }
  // K2.1: a pad comes back to whoever lost its index: one P2 lost is P2's to
  // re-claim (Start / A, _padPollFree); unknown pads go to P1 first
  const p2Waits = players.length > 1 && players[1] && players[1].pad === null;
  for (let i = 0; i < gps.length; i++) {
    const g = gps[i];
    if (i === p2 || !g || !g.connected || g.mapping !== 'standard') continue;
    const own = _padOwnerOf(i, g);
    if (p2Waits && own === 2) continue;
    // K2.2: an unknown pad during a disconnect pause waits for a Start press
    // (it goes to the player whose pause is showing: _padPollFree)
    if (_padDisconnectPaused && own === 0 && p2Waits) continue;
    if (pad.index !== i && inputDevice === 'pad') _padUsedIdx = i; // M10 failover: P1 is on pads, it stays P1's
    pad.index = i;
    return g;
  }
  return null;
}

// M11 K2: has P1 used the pad it holds? (kept across a reconnect at the same
// index; a pad P1 has used never joins P2 by View)
function padUsedByP1() { return pad.connected && pad.index >= 0 && pad.index === _padUsedIdx; }

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
  padResumeFromDisconnect(true); // a key always resumes, every chained pause too (K2.1, K2.2)
  return true;
}

function _padToast() {
  if (!_padToastPending || !gameStarted || demoActive) return;
  _padToastPending = false;
  _padStats.toasts++;
  if (typeof showNotification === 'function') showNotification('CONTROLLER CONNECTED', 2);
}

// C7: body.pad-connected shows the pad legend on the title
let _padLegend = false;
function _padBodyClass(on) {
  _padLegend = on;
  const b = typeof document !== 'undefined' ? document.body : null;
  if (b && b.classList) b.classList.toggle('pad-connected', on);
}

function _padFound(g) {
  pad.connected = true; pad.id = g.id || '';
  _padP1Missing = false; // K2.2
  pad.pressed.fill(0); pad.justPressed.fill(0);
  // C6 toast; on the title the legend swap shows it, the toast waits for the game
  _padToastPending = true;
  _padToast();
  _padBodyClass(true);
}

function _padLost() {
  const wasPad = inputDevice === 'pad';
  if (pad.index >= 0 && pad.index < _padOwner.length && (wasPad || pad.index === _padUsedIdx)) {
    _padOwner[pad.index] = 1; // K2.1
    _padNoteLoss(pad.id, 1);
  }
  if (wasPad && gameStarted && !demoActive) _padP1Missing = true; // K2.2: P1 lost the pad it was playing with
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
    _padDisconnectWho = 1;
    _padStats.disconnectPauses++;
    lastTime = performance.now();
    _padPauseOverlay();
  }
}

// The HUD pause overlay (no-op headless, before the UI exists)
function _padPauseOverlay() {
  if (typeof renderPauseOverlay === 'function' && typeof uiContainer !== 'undefined' && uiContainer) renderPauseOverlay();
}

// K2.2 (double drop): when the pause owner re-claims a pad and the other
// active player's pad is still missing, the pause passes straight to that
// player; a keyboard key (fromKey) clears every pause (the keyboard escape)
let _padP1Missing = false;                       // P1's pad in use dropped and P1 hasn't re-claimed one
function _padP2Missing() { return players.length > 1 && !!players[1] && players[1].pad === null && players[1].state !== 'dead'; }

function padResumeFromDisconnect(fromKey) {
  if (!_padDisconnectPaused) return;
  if (fromKey) _padP1Missing = false;
  else {
    const next = _padDisconnectWho !== 2 && _padP2Missing() ? 2 : _padDisconnectWho !== 1 && _padP1Missing ? 1 : 0;
    if (next) { _padDisconnectWho = next; _padPauseOverlay(); return; }
  }
  _padDisconnectPaused = false;
  _padDisconnectWho = 0;
  paused = false;
  lastTime = performance.now();
  _padPauseOverlay();
}

// who = the player whose pad pressed Start (1 | 2). K2.1: a disconnect pause
// belongs to the player whose pad dropped; only that player's pad (or a key)
// clears it
function _padTogglePause(who = 1) {
  if (_padDisconnectPaused) { if (who === _padDisconnectWho) padResumeFromDisconnect(); return; }
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

// World -> CSS px through this frame's offset and the K3a zoom
function _padScreenX(wx, wy) {
  const ox = worldOffsetX !== null ? worldOffsetX : W / 2 - cam.x * cam.z;
  return (wx - wy) * cam.z + ox;
}
function _padScreenY(wx, wy) {
  const oy = worldOffsetY !== null ? worldOffsetY : H / 2 - cam.y * cam.z;
  return (wx + wy) * CFG.ISO_SCALE * cam.z + oy;
}

// Read gamepad g into pad state st (buttons with edges, sticks after the
// deadzone); returns 1 if any button is held, | 2 if any was just pressed
function _padRead(g, st) {
  let held = false, edge = false;
  for (let i = 0; i < PAD_NB; i++) {
    const b = g.buttons[i];
    const v = b ? (typeof b === 'object' ? b.value || 0 : +b) : 0;
    const down = i === PAD_BTN.LT || i === PAD_BTN.RT
      ? v > (st.pressed[i] ? CFG.PAD_TRIGGER - 0.05 : CFG.PAD_TRIGGER) // hysteresis
      : !!(b && (b.pressed || v > 0.5));
    st.justPressed[i] = down && !st.pressed[i] ? 1 : 0;
    st.pressed[i] = down ? 1 : 0;
    st.value[i] = v;
    if (down) held = true;
    if (st.justPressed[i]) edge = true;
  }
  const ax = g.axes || [];
  padStick(ax[0] || 0, ax[1] || 0, CFG.PAD_DEADZONE, _padL);
  padStick(ax[2] || 0, ax[3] || 0, CFG.PAD_DEADZONE, _padR);
  st.lx = _padL.x; st.ly = _padL.y; st.lmag = _padL.mag;
  st.rx = _padR.x; st.ry = _padR.y; st.rmag = _padR.mag;
  return (held ? 1 : 0) | (edge ? 2 : 0);
}

// C3 aim for one pad (st) and its player p: right stick sets the direction;
// released keeps it; before any right-stick input, follow the left stick.
// Spring-back: a released stick passes through small magnitudes on its way
// to centre. Rising or steady input aims at once; a falling magnitude only
// once it holds for a poll, so a release keeps the last aim. Leaves the shot
// point (the assist moves it onto the enemy's visible torso) in _padShot
function _padAimStep(st, aim, S, p) {
  const steady = st.rmag >= S.prevR - CFG.PAD_AIM_SETTLE;
  S.prevR = st.rmag;
  if (st.rmag > 0) {
    if (steady || !S.rightUsed) {
      _padWorldDir(st.rx, st.ry, _padAimPt);
      aim.dirX = _padAimPt.x; aim.dirY = _padAimPt.y;
    }
    S.rightUsed = true; aim.has = true;
  } else if (!S.rightUsed && st.lmag > 0) {
    _padWorldDir(st.lx, st.ly, _padAimPt);
    aim.dirX = _padAimPt.x; aim.dirY = _padAimPt.y;
    aim.has = true;
  }
  // C3: distance = 180 + magnitude x 240 (a released stick -> 180u, direction kept)
  aim.dist = CFG.PAD_AIM_MIN + st.rmag * CFG.PAD_AIM_RANGE;
  aim.x = p.x + aim.dirX * aim.dist;
  aim.y = p.y + aim.dirY * aim.dist;
  // The reticle drives the cursor path (G13 picking, N1 ground point); the
  // assist moves only the shot onto the enemy's visible torso
  let tx = aim.x, ty = aim.y, tz = 0;
  const as = CFG.PAD_AIM_ASSIST ? padAssistTarget(p.x, p.y, aim.dirX, aim.dirY, CFG.PAD_ASSIST_RANGE, CFG.PAD_ASSIST_DEG) : null;
  if (as) {
    tx = as.x; ty = as.y;
    tz = entityWaterlineH(as) + (entityDrawnH(as) - entityWaterlineH(as)) * 0.45; // visible torso
  }
  _padShot.x = _padScreenX(tx, ty);
  _padShot.y = _padScreenY(tx, ty) - tz * cam.z;
}

function pollGamepad() {
  _padSnap = _padListRaw();
  let n = 0;
  if (_padSnap) for (let i = 0; i < _padSnap.length; i++) if (_padSnap[i] && _padSnap[i].connected && _padSnap[i].mapping === 'standard') n++;
  _padN = n;
  _pollGamepadBody();
  if (n === 0 && _padLegend) _padBodyClass(false); // K2.2: no pad left -> no pad legend (e.g. P2's pad unplugged on the title)
}

// Only View held, no other button or stick (a held refused View, K2.2)
function _padOnlyView() {
  if (pad.lmag > 0 || pad.rmag > 0) return false;
  for (let i = 0; i < PAD_NB; i++) if (pad.pressed[i] && i !== PAD_BTN.BACK) return false;
  return true;
}

function _pollGamepadBody() {
  // Taps are pulses: drop the unconsumed ones only after a simulated frame
  // that could have used them (not during hit-stop or a dodge roll)
  if (_padPulse.length && gameTime > _padTapT && !(player && player.dodging)) {
    for (const k of _padPulse) if (_padOwned[k]) { keys[k] = false; delete _padOwned[k]; }
    _padPulse.length = 0;
  }
  _padRumbleFlush();
  _padPollP2(); // M11 K2
  const g = _padGet();
  _padPollFree();
  if (!g) { if (pad.connected) _padLost(); return; }
  if (!pad.connected) _padFound(g);
  else _padToast();

  const hb = _padRead(g, pad);
  const held = (hb & 1) !== 0, edge = (hb & 2) !== 0;
  const active = held || pad.lmag > 0 || pad.rmag > 0;
  const jp = pad.justPressed;

  // M11 K2: View on a lone pad P1 hasn't used hands it to P2 (P1 stays on kbm);
  // K2.1: a View press that can't join (paused...) doesn't count as P1's input
  const viewTry = jp[PAD_BTN.BACK] && !padUsedByP1() && _padCount() === 1 && typeof coopTryJoin === 'function';
  if (viewTry && coopTryJoin(pad.index)) return;
  // K2.2: a refused View stays non-P1 input until it is released (a held
  // View alone neither marks the pad as P1's nor switches P1 to it)
  if (viewTry) _padViewRefused = true;
  else if (!pad.pressed[PAD_BTN.BACK]) _padViewRefused = false;
  const p1Act = active && !(_padViewRefused && _padOnlyView());
  if (p1Act && !demoActive) _padUsedIdx = pad.index;

  // C5: title / attract mode
  if (typeof demoActive !== 'undefined' && demoActive) {
    if (active) demoNoteInput(); // ends the demo; the press doesn't also start a game (D6)
    return;
  }
  if (!gameStarted) {
    if (active) { if (p1Act) _padSetDevice('pad'); demoNoteInput(); }
    if ((jp[PAD_BTN.A] || jp[PAD_BTN.START]) && typeof startGame === 'function') startGame();
    return;
  }
  if (p1Act) _padSetDevice('pad');

  // Pause: Start toggles; A / B also resume (C5)
  let swallow = false; // the resume press itself isn't an action
  if (jp[PAD_BTN.START] || (paused && (jp[PAD_BTN.A] || jp[PAD_BTN.B]))) {
    const resume = paused;
    _padTogglePause(1);
    if (!resume) return;
    swallow = true;
  }
  if (paused || inputDevice !== 'pad' || !player) return;

  _padAimStep(pad, padAim, _padS1, player); // C3
  mouseX = _padShot.x;
  mouseY = _padShot.y;

  // C2 mapping
  const rt = pad.pressed[PAD_BTN.RT];
  if (rt) { mouseDown = true; _padMouseOwned = true; }
  else if (_padMouseOwned) { mouseDown = false; _padMouseOwned = false; }
  if (!swallow) {
    if (jp[PAD_BTN.RT]) mouseJustPressed = true;
    if (jp[PAD_BTN.LT]) mouseRightJustPressed = true;
    if (jp[PAD_BTN.A]) _padTap(' ');
    if (jp[PAD_BTN.LB] || jp[PAD_BTN.LEFT]) _padTap('q');
    if (jp[PAD_BTN.RB] || jp[PAD_BTN.RIGHT] || jp[PAD_BTN.Y]) _padTap('e');
    if (jp[PAD_BTN.X]) _padTap('r'); // reload once per press
    if (jp[PAD_BTN.B] && playerStanding(player)) _grenadeWant = true; // combat.js throws at padAim while pad-aiming (K2.2: not queued while down)
  }
  if (jp[PAD_BTN.L3]) _padSprint = !_padSprint;
  if (pad.lmag <= 0) _padSprint = false; // sprint toggle cancels on stop
  _padKey('shift', _padSprint);
  if (edge || pad.lmag > 0 || pad.rmag > 0) player.idleT = 0;
}

// C4 + K2: the pad slot an event for player p rumbles (0 = P1's, 1 = P2's), or
// -1: never during attract mode (the bot's shots must not shake an idle pad),
// never for a player not on a pad
function _padRumSlot(p) {
  if (!CFG.PAD_RUMBLE || demoActive) return -1;
  if (!p || p === player) return inputDevice === 'pad' && pad.connected ? 0 : -1;
  return players.length > 1 && p === players[1] && _pad2.connected ? 1 : -1;
}

// C4: dual-rumble where supported, silent elsewhere; one effect per 50 ms per pad
function padRumble(weak, strong, ms, p) {
  const k = _padRumSlot(p);
  if (k < 0) return false;
  const R = _padRum[k];
  const now = performance.now();
  const str = Math.max(weak, strong);
  if (now < R.until && str < R.str) { _padStats.rumbleSkipped++; return false; } // weaker: never cuts a stronger one
  if (now - R.at < CFG.PAD_RUMBLE_GAP_MS) {
    _padStats.rumbleSkipped++;
    if (!R.q || str > Math.max(R.q.weak, R.q.strong)) {
      R.q = R.qBuf; R.q.weak = weak; R.q.strong = strong; R.q.ms = ms;
    }
    return false;
  }
  return _padRumblePlay(k, weak, strong, ms, now);
}

function _padRumbleFlush() {
  for (let k = 0; k < _padRum.length; k++) {
    const R = _padRum[k], q = R.q;
    if (!q) continue;
    const now = performance.now();
    if (now - R.at < CFG.PAD_RUMBLE_GAP_MS) continue;
    R.q = null;
    if (now < R.until && Math.max(q.weak, q.strong) < R.str) continue;
    if (_padRumSlot(k === 0 ? player : players[1]) === k) _padRumblePlay(k, q.weak, q.strong, q.ms, now);
  }
}

function _padRumblePlay(k, weak, strong, ms, now) {
  const g = k === 0 ? _padGet() : _pad2Get();
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
  const R = _padRum[k];
  R.at = now;
  R.until = now + Math.max(1, Math.min(1000, ms | 0));
  R.str = Math.max(clamp01(weak), clamp01(strong));
  _padStats.rumblePlayed++;
  return true;
}

function padState() {
  return { connected: pad.connected, inputDevice, disconnectPaused: _padDisconnectPaused, sprint: _padSprint,
    disconnectWho: _padDisconnectWho };
}

// =====================================================================
// M11 K2: P2's pad
// =====================================================================
const _pad2 = {
  connected: false, index: -1, id: '',
  lx: 0, ly: 0, rx: 0, ry: 0, lmag: 0, rmag: 0,
  value: new Float32Array(PAD_NB), pressed: new Uint8Array(PAD_NB), justPressed: new Uint8Array(PAD_NB),
};
const padAim2 = { x: 0, y: 0, dirX: 1, dirY: 0, dist: 180, has: false };
const _padS2 = { rightUsed: false, prevR: 0, sprint: false };
const _padFreeBtn = new Uint8Array(16); // free pads: Start | A bits last poll (join edges)

function padOf(i) { return i === 1 ? _pad2 : pad; }
function padAimOf(i) { return i === 1 ? padAim2 : padAim; }

function _padCount() {
  if (_padSnap !== null) return _padN;
  const gps = _padListRaw();
  let n = 0;
  if (gps) for (let i = 0; i < gps.length; i++) if (gps[i] && gps[i].connected && gps[i].mapping === 'standard') n++;
  return n;
}

// K2.1: a lone pad handed to P2 leaves P1 quietly (no toast / legend change /
// disconnect pause: the pad is still connected, it's just P2's now)
function _padHandOff() {
  pad.connected = false; pad.index = -1;
  _padToastPending = false;
  pad.pressed.fill(0); pad.justPressed.fill(0);
  pad.lx = pad.ly = pad.rx = pad.ry = pad.lmag = pad.rmag = 0;
  _padSetDevice('kbm');
}

function _pad2Get() {
  const gps = _padList();
  const g = gps && _pad2.index >= 0 ? gps[_pad2.index] : null;
  return g && g.connected ? g : null;
}

// Give pad index i to P2 (coop.js join) / take it back with -1 (round reset)
function padAttachP2(i) {
  _pad2.index = i; _pad2.connected = i >= 0; _pad2.id = '';
  _pad2.pressed.fill(0); _pad2.justPressed.fill(0); _pad2.value.fill(0);
  _pad2.lx = _pad2.ly = _pad2.rx = _pad2.ry = _pad2.lmag = _pad2.rmag = 0;
  _padS2.rightUsed = false; _padS2.prevR = 0; _padS2.sprint = false;
  padAim2.dirX = 1; padAim2.dirY = 0; padAim2.dist = CFG.PAD_AIM_MIN; padAim2.has = false;
  _padRum[1] = _padRumState();
  if (i < 0) return;
  const g = _pad2Get();
  if (g) { _pad2.id = g.id || ''; _padRead(g, _pad2); _pad2.justPressed.fill(0); } // the join press is not an action
  if (i === pad.index && pad.connected) _padHandOff(); // a lone pad leaves P1 (P1 stays on kbm)
  if (_padUsedIdx === i) _padUsedIdx = -1;
  if (i < _padOwner.length) _padOwner[i] = 2;
}

// Start / A on a pad that is neither P1's nor P2's joins P2 (or re-attaches
// a P2 whose pad dropped)
function _padPollFree() {
  const gps = _padList();
  if (!gps || typeof coopTryJoin !== 'function') return;
  for (let i = 0; i < gps.length && i < _padFreeBtn.length; i++) {
    const g = gps[i];
    let b = 0;
    if (g && g.connected && g.mapping === 'standard' && i !== pad.index && i !== _pad2.index && _padOwnerOf(i, g) !== 1) {
      const st = g.buttons[PAD_BTN.START], a = g.buttons[PAD_BTN.A];
      b = (st && (st.pressed || st.value > 0.5) ? 1 : 0) | (a && (a.pressed || a.value > 0.5) ? 2 : 0);
    }
    const jp = b & ~_padFreeBtn[i];
    _padFreeBtn[i] = b;
    if (jp && _padDisconnectPaused && _padDisconnectWho === 1 && (jp & 1) && _padOwnerOf(i, g) === 0) { // K2.2
      _padOwner[i] = 0; pad.index = i; _padP1Missing = false; padResumeFromDisconnect(); // P1's pause: P1 takes it (picked up next poll)
      continue;
    }
    if (jp && coopTryJoin(i) && _padDisconnectPaused && _padDisconnectWho === 2) padResumeFromDisconnect();
  }
}

function _pad2Lost() {
  const p2 = players.length > 1 ? players[1] : null;
  if (_pad2.index >= 0 && _pad2.index < _padOwner.length) _padOwner[_pad2.index] = 2; // K2.1: it comes back to P2
  _padNoteLoss(_pad2.id, 2);
  padAttachP2(-1);
  if (typeof coopPadLost === 'function') coopPadLost();
  if (!p2) return;
  p2.pad = null;
  _ctlRelease(p2.ctl);
  // C6 + K2: P2's pad dropped mid-game -> auto-pause, naming the player
  if (gameStarted && !demoActive && !paused) {
    paused = true;
    _padDisconnectPaused = true;
    _padDisconnectWho = 2;
    _padStats.disconnectPauses++;
    lastTime = performance.now();
    _padPauseOverlay();
  }
}

function _ctlTap(c, k) { c.keys[k] = true; c.pulse.push(k); c.tapT = gameTime; }
function _ctlRelease(c) {
  if (!c) return;
  for (const k in c.keys) c.keys[k] = false;
  c.pulse.length = 0;
  c.mouseDown = false; c.mouseJustPressed = false; c.mouseRightJustPressed = false; c.grenadeWant = false;
}

// P2's pad -> players[1].ctl (the same C2 mapping as P1's pad)
function _padPollP2() {
  if (_pad2.index < 0) return;
  const g = _pad2Get();
  if (!g) { _pad2Lost(); return; }
  const p = players.length > 1 ? players[1] : null;
  const c = p && p.ctl;
  if (c && c.pulse.length && gameTime > c.tapT && !p.dodging) {
    for (const k of c.pulse) c.keys[k] = false;
    c.pulse.length = 0;
  }
  const hb = _padRead(g, _pad2);
  if (!c || !gameStarted || demoActive) { // joined on the title: wait for the game
    if (!gameStarted && (hb || _pad2.lmag > 0 || _pad2.rmag > 0) && typeof demoNoteInput === 'function') demoNoteInput(); // keeps the title (no attract mode)
    return;
  }
  const jp = _pad2.justPressed;
  // Pause: Start from either player pauses everything; A / B also resume (C5)
  let swallow = false;
  if (jp[PAD_BTN.START] || (paused && (jp[PAD_BTN.A] || jp[PAD_BTN.B]))) {
    const resume = paused;
    _padTogglePause(2);
    if (!resume) return;
    swallow = true;
  }
  if (paused || !playerStanding(p)) { c.mouseDown = false; return; }

  _padAimStep(_pad2, padAim2, _padS2, p);
  c.mouseX = _padShot.x;
  c.mouseY = _padShot.y;
  c.mouseDown = !!_pad2.pressed[PAD_BTN.RT];
  if (!swallow) {
    if (jp[PAD_BTN.RT]) c.mouseJustPressed = true;
    if (jp[PAD_BTN.LT]) c.mouseRightJustPressed = true;
    if (jp[PAD_BTN.A]) _ctlTap(c, ' ');
    if (jp[PAD_BTN.LB] || jp[PAD_BTN.LEFT]) _ctlTap(c, 'q');
    if (jp[PAD_BTN.RB] || jp[PAD_BTN.RIGHT] || jp[PAD_BTN.Y]) _ctlTap(c, 'e');
    if (jp[PAD_BTN.X]) _ctlTap(c, 'r');
    if (jp[PAD_BTN.B]) c.grenadeWant = true;
  }
  if (jp[PAD_BTN.L3]) _padS2.sprint = !_padS2.sprint;
  if (_pad2.lmag <= 0) _padS2.sprint = false;
  c.keys.shift = _padS2.sprint;
  if ((hb & 2) || _pad2.lmag > 0 || _pad2.rmag > 0) p.idleT = 0;
}

function padStats() {
  return { connected: pad.connected, inputDevice, disconnectPauses: _padStats.disconnectPauses,
    rumblePlayed: _padStats.rumblePlayed, rumbleSkipped: _padStats.rumbleSkipped, toasts: _padStats.toasts };
}
