import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect, beforeEach } from 'vitest';
import { newRound, ROOT } from '../helpers/load-game.js';
import { LANDED } from '../milestones.js';

// M10 Xbox controller (docs/SPEC.md M10 C1-C6, "Acceptance (Anna)"). Written against Josh's
// provisional hooks before js/gamepad.js exists; skipped until M10 is marked landed in
// tests/milestones.js. A fake standard-mapping pad is served by a stubbed
// navigator.getGamepads() that returns fresh snapshots on every call, as Chrome does.
// main.js isn't loaded (its async init needs a GPU), so a "frame" is what gameLoop does:
// pollGamepad(), then main.js's update() (extracted, as in fire.test.js) unless paused.
const todo = !LANDED.M10;
const DT = 1 / 60;
const DZ = 0.2;
const DEG = Math.PI / 180;

// Standard mapping (Xbox labels)
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16 };
const TRIGGERS = [BTN.LT, BTN.RT];

// ---------------------------------------------------------------------
// Provisional hooks (Josh, M10). If a name changes when M10 lands, change it here only.
// ---------------------------------------------------------------------
const hook = {
  poll: () => g.pollGamepad(),
  pad: () => g.pad, // { connected, index, id, lx, ly, rx, ry, lmag, rmag, value, pressed, justPressed }
  stick: (x, y, dz, out) => g.padStick(x, y, dz, out), // -> out { x, y, mag }
  deadzone: (m, dz) => g.padDeadzone(m, dz),
  device: () => g.inputDevice, // 'kbm' | 'pad'
  aim: () => g.padAim, // { x, y, dirX, dirY, dist, has }
  assist: (px, py, dx, dy, maxDist, deg) => g.padAssistTarget(px, py, dx, dy, maxDist, deg),
  stats: () => g.padStats(), // { connected, inputDevice, disconnectPauses, rumblePlayed, rumbleSkipped, toasts }
  rumble: (weak, strong, ms) => g.padRumble(weak, strong, ms),
};

// ---------------------------------------------------------------------
// Headless main.js pieces
// ---------------------------------------------------------------------
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8');
function mainFunction(name) {
  const start = MAIN_SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`js/main.js: function ${name}() not found`);
  let depth = 0;
  for (let k = MAIN_SRC.indexOf('{', start); k < MAIN_SRC.length; k++) {
    if (MAIN_SRC[k] === '{') depth++;
    else if (MAIN_SRC[k] === '}' && --depth === 0) return MAIN_SRC.slice(start, k + 1);
  }
  throw new Error(`js/main.js: unbalanced braces in ${name}()`);
}
function withMain(game) {
  const { g: gg, run } = game;
  for (const k of ['app', 'renderer', 'stage', 'worldContainer', 'terrainContainer', 'effectsContainer', 'uiContainer']) {
    if (!gg[k]) gg[k] = gg.PIXI;
  }
  run(`var updateCamera = typeof updateCamera === 'function' ? updateCamera : function () {};
var updateNotification = typeof updateNotification === 'function' ? updateNotification : function () {};
var __m10Update = (function () { return ${mainFunction('update')}; })();`);
  return run('__m10Update');
}
/** Install main.js's real keyboard/mouse listeners (wherever Josh hooks the 'kbm' switch). */
function installMainInput(game) {
  game.run(`var _swallowClicksUntil = 0;
${mainFunction('_realInput')}
${mainFunction('initInput')}
initInput();`);
}

// ---------------------------------------------------------------------
// Fake pad + sandbox state (fresh per test)
// ---------------------------------------------------------------------
let g, game, update, pads, clock, effects, listeners, started;

function makePad(index = 0, { rumble = 'ok' } = {}) {
  const p = {
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    index, connected: true, mapping: 'standard', timestamp: clock.ms,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })),
  };
  if (rumble !== 'none') {
    p.vibrationActuator = {
      type: 'dual-rumble',
      playEffect(type, params) {
        effects.push({ t: clock.ms, type, ...(params || {}) });
        if (rumble === 'throw') throw new Error('mock: playEffect failed');
        return Promise.resolve('complete');
      },
      reset() { return Promise.resolve('complete'); },
    };
  }
  return p;
}
/** A Chrome-like snapshot: new objects per getGamepads() call, same actuator. */
function snapshot(p) {
  const s = { id: p.id, index: p.index, connected: p.connected, mapping: p.mapping, timestamp: p.timestamp,
    axes: p.axes.slice(), buttons: p.buttons.map((b) => ({ ...b })) };
  if (p.vibrationActuator) s.vibrationActuator = p.vibrationActuator;
  return s;
}
function dispatch(type, ev) {
  for (const fn of listeners[type] || []) fn(ev);
}
function connect(index = 0, opts) {
  pads[index] = makePad(index, opts);
  dispatch('gamepadconnected', { type: 'gamepadconnected', gamepad: snapshot(pads[index]) });
}
function bump(p) { p.timestamp = Math.max(p.timestamp + 0.001, clock.ms); }
/** Set button i of pad 0 (true/false or an analog value); triggers report pressed above 0.1 like real pads. */
function btn(i, v) {
  const val = v === true ? 1 : v === false ? 0 : v;
  pads[0].buttons[i] = { pressed: TRIGGERS.includes(i) ? val > 0.1 : val >= 0.5, value: val, touched: val > 0 };
  bump(pads[0]);
}
function axes(lx, ly, rx = 0, ry = 0) {
  pads[0].axes = [lx, ly, rx, ry];
  bump(pads[0]);
}

/** Advance the wall clock and game time without a frame (for the rumble rate limit). */
function tick(ms) { clock.ms += ms; g.gameTime += ms / 1000; }
/** n in-game frames in gameLoop order: poll, then update unless paused. */
function frame(n = 1, dt = DT) {
  for (let i = 0; i < n; i++) {
    clock.ms += dt * 1000;
    hook.poll();
    if (!g.paused) update(dt);
  }
}
/** n title-screen frames (gameStarted false): poll, then the D1 idle timer. */
function titleFrame(n = 1) {
  for (let i = 0; i < n; i++) {
    clock.ms += DT * 1000;
    hook.poll();
    g.updateDemoIdle(DT);
  }
}

// Dry ground with room to move: the terrain is the same in every round (seeded loader).
let _dry = null;
function findHome() {
  if (_dry) return _dry;
  const ts = g.CFG.TILE_SIZE;
  const wet = (x, y) => g.getTerrainTypeAt(Math.floor(x / ts) * ts, Math.floor(y / ts) * ts) === 'water';
  const R = 600;
  for (let r = 0; r < 30000 && !_dry; r += 80) {
    for (let a = 0; a < 16 && !_dry; a++) {
      const x = Math.cos((a / 16) * Math.PI * 2) * r, y = Math.sin((a / 16) * Math.PI * 2) * r;
      let ok = true;
      for (let dx = -R; dx <= R && ok; dx += 40) {
        for (let dy = -R; dy <= R && ok; dy += 40) if (dx * dx + dy * dy <= R * R && wet(x + dx, y + dy)) ok = false;
      }
      if (ok) _dry = { x, y };
    }
  }
  if (!_dry) throw new Error('no dry area found');
  return _dry;
}

beforeEach(() => {
  if (todo) return;
  pads = [null, null, null, null];
  clock = { ms: 1000 };
  effects = [];
  listeners = {};
  started = 0;
  game = newRound({
    stubs: {
      navigator: { getGamepads: () => pads.map((p) => (p ? snapshot(p) : null)), userAgent: 'vitest' },
      performance: { now: () => clock.ms },
      addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
      // main.js functions the pad may call on the title / for the demo (main.js isn't loaded)
      startGame: () => { started++; g.gameStarted = true; },
      resetRound: () => {},
    },
  });
  g = game.g;
  update = withMain(game);
  g.gameStarted = true;
  g.waveActive = false;
  g.waveTimer = 1e9;
  g.enemies.length = 0;
  g.envObjects.length = 0;
  g.CFG.DEMO_IDLE_SECONDS = 1e9;
  const home = findHome();
  const p = g.player;
  p.x = home.x; p.y = home.y; p.invincible = 1e9;
  const sp = g.toScreen(p.x, p.y);
  g.cam.x = g.cam.tx = sp.x; g.cam.y = g.cam.ty = sp.y;
  connect(0);
  hook.poll();
});

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const speed = () => Math.hypot(g.player.vx, g.player.vy);
/** Screen-space angle of the world vector (dx, dy). */
const screenAngle = (dx, dy) => { const s = g.toScreen(dx, dy); return Math.atan2(s.y, s.x); };
/** padAim's world offset from the player and its screen angle. */
function aimInfo() {
  const a = hook.aim(), p = g.player;
  const dx = a.x - p.x, dy = a.y - p.y;
  return { a, d: Math.hypot(dx, dy), worldAngle: Math.atan2(dy, dx), screenAngle: screenAngle(dx, dy) };
}
/** A stationary, harmless enemy at (dist, angle in degrees) from the player. */
function enemyAt(dist, deg, { boss = false } = {}) {
  const p = g.player;
  const e = boss ? g.spawnEnemy(1, p.x, p.y, { name: 'M10 BOSS', hp: 1e9 }) : g.spawnEnemy(0, p.x, p.y);
  e.x = p.x + Math.cos(deg * DEG) * dist; e.y = p.y + Math.sin(deg * DEG) * dist;
  e.vx = 0; e.vy = 0; e.speed = 0; e.fireTimer = 1e9;
  e.hp = e.maxHp = 1e9; e.shieldHp = e.maxShieldHp = 0;
  e.knockbackX = 0; e.knockbackY = 0; e.stunTimer = 0;
  return e;
}
/** Angle of the newest player bullet. */
function lastShotAngle() {
  const b = [...g.bullets].reverse().find((q) => q.owner === 'player');
  return b ? Math.atan2(b.vy, b.vx) : null;
}
/** Wrap a game function (global binding) and record its calls. */
function spy(name) {
  const calls = [];
  const orig = g[name];
  g[name] = (...args) => { calls.push(args); return orig(...args); };
  return calls;
}

// ---------------------------------------------------------------------
// C1/C2: deadzone and rescale
// ---------------------------------------------------------------------
describe('M10 deadzone', () => {
  test.skipIf(todo)('M10: CFG defaults: deadzone 0.20, aim assist on at 5 deg, rumble on', () => {
    expect(g.CFG.PAD_DEADZONE).toBe(0.2);
    expect(g.CFG.PAD_AIM_ASSIST).toBe(true);
    expect(g.CFG.PAD_ASSIST_DEG).toBe(5);
    expect(g.CFG.PAD_RUMBLE).toBe(true);
  });

  test.skipIf(todo)('M10: padDeadzone: 0 at and below 0.20, (m - 0.2) / 0.8 above, clamped to 1', () => {
    expect(hook.deadzone(0, DZ)).toBe(0);
    expect(hook.deadzone(0.19, DZ), '0.19 -> 0').toBe(0);
    expect(hook.deadzone(0.2, DZ), 'at the deadzone -> 0').toBe(0);
    const eps = hook.deadzone(0.2 + 1e-4, DZ);
    expect(eps, '0.2 + eps -> ~0 (no jump at the edge)').toBeGreaterThanOrEqual(0);
    expect(eps).toBeLessThan(1e-3);
    expect(hook.deadzone(0.6, DZ), '0.6 -> 0.5').toBeCloseTo(0.5, 6);
    expect(hook.deadzone(1, DZ), '1 -> 1').toBeCloseTo(1, 6);
    expect(hook.deadzone(1.5, DZ), 'clamped to 1').toBeCloseTo(1, 6);
  });

  test.skipIf(todo)('M10: padStick: radial deadzone, magnitude rescaled, direction kept, clamped to 1', () => {
    const out = { x: NaN, y: NaN, mag: NaN };
    const s = (x, y) => { const r = hook.stick(x, y, DZ, out); return { x: r.x, y: r.y, mag: r.mag }; };
    expect(hook.stick(0.5, 0, DZ, out), 'writes into and returns out (no allocation)').toBe(out);

    for (const [x, y] of [[0, 0], [0.19, 0], [0, -0.19], [0.2, 0], [0.1, 0.1]]) {
      const r = s(x, y);
      expect([r.x, r.y, r.mag], `(${x}, ${y}) is inside the deadzone`).toEqual([0, 0, 0]);
    }
    let r = s(0.6, 0);
    expect(r.mag, '0.6 -> 0.5').toBeCloseTo(0.5, 6);
    expect(r.x).toBeCloseTo(0.5, 6);
    expect(r.y).toBeCloseTo(0, 6);
    r = s(0, -0.6);
    expect(r.y, 'negative axes keep their sign').toBeCloseTo(-0.5, 6);
    r = s(0.3, 0.4); // |v| = 0.5 -> 0.375, direction (0.6, 0.8)
    expect(r.mag).toBeCloseTo(0.375, 6);
    expect(r.x, 'direction kept').toBeCloseTo(0.225, 6);
    expect(r.y).toBeCloseTo(0.3, 6);
    r = s(1, 0);
    expect(r.mag, 'full tilt -> 1').toBeCloseTo(1, 6);
    r = s(1, 1); // |v| = 1.414 (square gates report corners)
    expect(r.mag, 'clamped to 1').toBeCloseTo(1, 6);
    expect(r.x, 'clamped along the same direction').toBeCloseTo(Math.SQRT1_2, 6);
    expect(r.y).toBeCloseTo(Math.SQRT1_2, 6);
    // Radial, not per axis: each axis is 0.177 (< 0.2) but the stick is at 0.25.
    const c = 0.25 * Math.SQRT1_2;
    r = s(c, -c);
    expect(r.mag, 'a 0.25 diagonal is live').toBeCloseTo(0.0625, 6);
    expect(r.x).toBeGreaterThan(0);
    expect(r.y).toBeLessThan(0);
    expect(Math.atan2(r.y, r.x)).toBeCloseTo(-Math.PI / 4, 6);
  });

  test.skipIf(todo)('M10: pollGamepad exposes post-deadzone sticks and raw button values', () => {
    axes(0.6, 0, 0.1, -0.6);
    btn(BTN.RT, 0.25);
    hook.poll();
    const pad = hook.pad();
    expect(pad.connected).toBe(true);
    expect(pad.index).toBe(0);
    expect(pad.lx).toBeCloseTo(0.5, 6);
    expect(pad.ly).toBeCloseTo(0, 6);
    expect(pad.lmag).toBeCloseTo(0.5, 6);
    // Right stick (0.1, -0.6): |v| = 0.608, so it is live although x alone is under 0.2.
    const m = Math.hypot(0.1, 0.6), rmag = (m - DZ) / (1 - DZ);
    expect(pad.rmag).toBeCloseTo(rmag, 6);
    expect(pad.rx, 'radial: the small x component survives').toBeCloseTo((0.1 / m) * rmag, 6);
    expect(pad.ry).toBeCloseTo((-0.6 / m) * rmag, 6);
    expect(pad.value[BTN.RT], 'analog value').toBeCloseTo(0.25, 6);
  });

  test.skipIf(todo)('M10: polling allocates no per-frame state (same pad, arrays and padAim objects)', () => {
    const pad = hook.pad(), aim = hook.aim();
    const arrays = [pad.value, pad.pressed, pad.justPressed];
    for (let i = 0; i < 10; i++) { axes(i % 2 ? 0.8 : 0, 0, 0, i % 3 ? -0.9 : 0); btn(BTN.A, i % 2 === 0); hook.poll(); }
    expect(hook.pad()).toBe(pad);
    expect(hook.aim()).toBe(aim);
    for (let k = 0; k < 3; k++) expect([hook.pad().value, hook.pad().pressed, hook.pad().justPressed][k]).toBe(arrays[k]);
  });
});

// ---------------------------------------------------------------------
// C1: edge detection
// ---------------------------------------------------------------------
describe('M10 edge detection', () => {
  test.skipIf(todo)('M10: every button: justPressed is 1 on exactly the first poll of a hold, again after a release', () => {
    for (let i = 0; i < 17; i++) {
      btn(i, 1);
      const seq = [];
      for (let k = 0; k < 6; k++) { hook.poll(); seq.push(hook.pad().justPressed[i]); }
      expect(seq, `button ${i} held for 6 polls`).toEqual([1, 0, 0, 0, 0, 0]);
      expect(hook.pad().pressed[i], `button ${i} pressed while held`).toBe(1);
      btn(i, 0);
      hook.poll();
      expect([hook.pad().pressed[i], hook.pad().justPressed[i]], `button ${i} released`).toEqual([0, 0]);
      btn(i, 1);
      hook.poll();
      expect(hook.pad().justPressed[i], `button ${i} pressed again`).toBe(1);
      btn(i, 0);
      hook.poll();
      g.paused = false; // Start toggles pause; irrelevant here
    }
  });

  test.skipIf(todo)('M10: buttons are edge-detected independently', () => {
    btn(BTN.A, 1);
    hook.poll();
    btn(BTN.X, 1);
    hook.poll();
    const jp = hook.pad().justPressed;
    expect([jp[BTN.A], jp[BTN.X]], 'X pressed while A is held').toEqual([0, 1]);
    btn(BTN.A, 0);
    hook.poll();
    expect([hook.pad().justPressed[BTN.A], hook.pad().justPressed[BTN.X], hook.pad().pressed[BTN.X]]).toEqual([0, 0, 1]);
    btn(BTN.A, 1);
    hook.poll();
    expect([hook.pad().justPressed[BTN.A], hook.pad().justPressed[BTN.X]], 'A again, X still held').toEqual([1, 0]);
  });
});

// ---------------------------------------------------------------------
// C2: every mapped button acts exactly once per press (full frames)
// ---------------------------------------------------------------------
describe('M10 mapping', () => {
  /**
   * Hold `b` for `holdFrames`, release for 2 frames, hold again: returns count() after each
   * hold. `each` runs after every frame (to sample state or keep the action possible).
   */
  function twoPresses(b, holdFrames, count, each) {
    const run = (n) => { for (let k = 0; k < n; k++) { frame(); if (each) each(); } };
    btn(b, 1); run(holdFrames);
    const first = count();
    btn(b, 0); run(2);
    btn(b, 1); run(holdFrames);
    const second = count();
    btn(b, 0); run(2);
    return [first, second];
  }

  test.skipIf(todo)('M10: A dodge rolls once per press (held past the cooldown)', () => {
    let starts = 0, was = false;
    const each = () => { const d = g.player.dodging; if (d && !was) starts++; was = d; };
    const holdFrames = Math.ceil((g.CFG.DODGE_DURATION + g.CFG.DODGE_COOLDOWN + 0.3) / DT);
    expect(twoPresses(BTN.A, holdFrames, () => starts, each)).toEqual([1, 2]);
  });

  test.skipIf(todo)('M10: B throws one grenade per press, toward padAim (the N1 ground point)', () => {
    const throws = spy('throwGrenade');
    axes(0, 0, 0.6, 0); // aim at half tilt: 300u
    frame(3);
    const a = aimInfo();
    expect(a.d, 'precondition: 300u aim point').toBeCloseTo(300, -1);
    const holdFrames = Math.ceil((g.CFG.GRENADE_COOLDOWN + 0.3) / DT);
    expect(twoPresses(BTN.B, holdFrames, () => g.grenadeStats().thrown)).toEqual([1, 2]);
    expect(throws.length).toBeGreaterThanOrEqual(2);
    const [tx, ty] = throws[0];
    expect(Math.hypot(tx - a.a.x, ty - a.a.y), 'thrown at the reticle world point').toBeLessThan(2);
  });

  test.skipIf(todo)('M10: X reloads once per press (a held X is not a held R)', () => {
    const p = g.player, mag = g.WEAPONS[p.weapon].mag;
    let starts = 0, was = false;
    const each = () => {
      if (p.reloading && !was) starts++;
      was = p.reloading;
      if (!p.reloading && p.magAmmo === mag) p.magAmmo = mag - 1; // keep a reload possible
    };
    const holdFrames = Math.ceil((g.WEAPONS[p.weapon].reload * 2 + 0.3) / DT);
    p.magAmmo = mag - 1;
    expect(twoPresses(BTN.X, holdFrames, () => starts, each), 'held through a finished reload: no second one').toEqual([1, 2]);
  });

  const SWITCHES = [
    ['Y', BTN.Y, +1], ['RB', BTN.RB, +1], ['D-pad right', BTN.RIGHT, +1],
    ['LB', BTN.LB, -1], ['D-pad left', BTN.LEFT, -1],
  ];
  for (const [label, b, dir] of SWITCHES) {
    test.skipIf(todo)(`M10: ${label} switches to the ${dir > 0 ? 'next' : 'previous'} weapon once per press`, () => {
      g.unlockedWeapons = 4;
      g.player.weapon = 0;
      const want = (n) => ((n * dir) % 4 + 4) % 4;
      expect(twoPresses(b, 20, () => g.player.weapon)).toEqual([want(1), want(2)]);
    });
  }

  test.skipIf(todo)('M10: LT fires the shockwave once per press, only past 0.3', () => {
    const shocks = spy('spawnShockwaveEffect');
    const charge = () => { g.player.specialCharge = g.CFG.SPECIAL_MAX_CHARGE; };
    btn(BTN.LT, 0.25); // reported pressed by the browser, but under the 0.3 threshold
    for (let k = 0; k < 20; k++) { charge(); frame(); }
    expect(shocks.length, 'LT at 0.25 does nothing').toBe(0);
    btn(BTN.LT, 0); frame(2);
    charge();
    const holdFrames = Math.ceil(1.0 / DT); // > the 0.5 s special cooldown
    expect(twoPresses(BTN.LT, holdFrames, () => shocks.length, charge), 'recharged every frame: still once per press').toEqual([1, 2]);
  });

  test.skipIf(todo)('M10: RT acts as the left mouse button past 0.3: one pistol shot per pull, auto weapons keep firing', () => {
    const p = g.player;
    const shots = () => g.WEAPONS[p.weapon].mag - p.magAmmo;
    p.weapon = 0; p.magAmmo = g.WEAPONS[0].mag; p.fireTimer = 0;
    btn(BTN.RT, 0.25);
    frame(20);
    expect(shots(), 'RT at 0.25 does not fire').toBe(0);
    btn(BTN.RT, 0); frame(2);
    expect(twoPresses(BTN.RT, 60, shots), 'semi-auto pistol: one shot per pull').toEqual([1, 2]);

    g.unlockedWeapons = 2;
    p.weapon = 1; p.magAmmo = g.WEAPONS[1].mag; p.fireTimer = 0; p.reloading = false;
    btn(BTN.RT, 1);
    frame(30); // 0.5 s at rate 0.07
    expect(shots(), 'auto weapon fires while RT is held').toBeGreaterThan(3);
    btn(BTN.RT, 0); frame(1);
  });

  test.skipIf(todo)('M10: Start toggles pause once per press (polled while paused)', () => {
    expect(g.paused).toBe(false);
    btn(BTN.START, 1); frame(30);
    expect(g.paused, 'held Start: paused once').toBe(true);
    btn(BTN.START, 0); frame(5);
    expect(g.paused, 'release does not toggle').toBe(true);
    btn(BTN.START, 1); frame(30);
    expect(g.paused, 'second press resumes').toBe(false);
    btn(BTN.START, 0); frame(2);
    expect(g.paused).toBe(false);
  });

  test.skipIf(todo)('M10: L3 toggles sprint while moving; stopping cancels it', () => {
    const S = g.CFG.PLAYER_SPEED, F = g.CFG.SPRINT_MULT;
    axes(1, 0); frame(3);
    expect(speed(), 'walking').toBeCloseTo(S, 0);
    btn(BTN.L3, 1); frame(3);
    expect(speed(), 'L3 sprints').toBeCloseTo(S * F, 0);
    btn(BTN.L3, 0); frame(3);
    expect(speed(), 'toggle: still sprinting after the release').toBeCloseTo(S * F, 0);
    axes(0, 0); frame(3);
    expect(speed(), 'stopped').toBe(0);
    axes(1, 0); frame(3);
    expect(speed(), 'stopping cancelled the sprint').toBeCloseTo(S, 0);
    btn(BTN.L3, 1); frame(2); btn(BTN.L3, 0); frame(2);
    expect(speed()).toBeCloseTo(S * F, 0);
    btn(BTN.L3, 1); frame(2); btn(BTN.L3, 0); frame(2);
    expect(speed(), 'a second L3 press toggles it off').toBeCloseTo(S, 0);
  });

  test.skipIf(todo)('M10: the left stick moves in its screen direction; speed scales with tilt, full from 0.9', () => {
    const S = g.CFG.PLAYER_SPEED, p = g.player;
    for (const [lx, ly] of [[1, 0], [0, -1], [-Math.SQRT1_2, Math.SQRT1_2], [0.6, 0.8]]) {
      axes(lx, ly);
      const x0 = p.x, y0 = p.y;
      frame(10);
      const moved = screenAngle(p.x - x0, p.y - y0);
      expect(angDiff(moved, Math.atan2(ly, lx)) / DEG, `stick (${lx.toFixed(2)}, ${ly.toFixed(2)}) moves that way on screen`).toBeLessThan(2);
      axes(0, 0); frame(1);
    }
    axes(0.95, 0); frame(2);
    expect(speed(), 'full speed at 0.95').toBeCloseTo(S, 0);
    axes(0.55, 0); frame(2);
    expect(speed(), 'partial tilt is slower').toBeGreaterThan(0.25 * S);
    expect(speed()).toBeLessThan(0.75 * S);
    axes(0.15, 0); frame(2);
    expect(speed(), 'inside the deadzone: no drift').toBe(0);
  });
});

// ---------------------------------------------------------------------
// C3: aim point
// ---------------------------------------------------------------------
describe('M10 aim', () => {
  test.skipIf(todo)('M10: aim distance is 180u + rmag x 240u (180..420u) in the right stick\'s screen direction', () => {
    const cases = [
      [[1, 0], 420], [[0.6, 0], 300], [[0, 1], 420], [[-Math.SQRT1_2, -Math.SQRT1_2], 420],
      [[1, 1], 420], // past the unit circle: clamped
      [[0, -0.6], 300],
    ];
    for (const [[rx, ry], want] of cases) {
      axes(0, 0, rx, ry);
      frame(2);
      const a = aimInfo();
      expect(a.a.has, 'padAim.has').toBe(true);
      expect(a.a.dist, `rstick (${rx}, ${ry}): padAim.dist`).toBeCloseTo(want, 0);
      expect(a.d, 'the aim point is dist from the player').toBeCloseTo(want, 0);
      expect(Math.hypot(a.a.dirX, a.a.dirY), 'dir is a unit vector').toBeCloseTo(1, 4);
      expect(angDiff(Math.atan2(a.a.dirY, a.a.dirX), a.worldAngle) / DEG, 'dir points at the aim point').toBeLessThan(0.5);
      expect(angDiff(a.screenAngle, Math.atan2(ry, rx)) / DEG, 'screen direction follows the stick').toBeLessThan(1);
    }
  });

  test.skipIf(todo)('M10: releasing the right stick keeps the last direction at 180u', () => {
    axes(0, 0, 0, 1);
    frame(2);
    const held = aimInfo();
    axes(0, 0, 0, 0.1); // drifting inside the deadzone
    frame(2);
    axes(0, 0, 0, 0);
    frame(5);
    const rel = aimInfo();
    expect(rel.a.dist, 'rmag 0 -> 180u').toBeCloseTo(180, 0);
    expect(rel.d).toBeCloseTo(180, 0);
    expect(angDiff(rel.worldAngle, held.worldAngle) / DEG, 'direction kept').toBeLessThan(0.5);
  });

  test.skipIf(todo)('M10: before any right-stick input the aim follows the left stick; after it, it does not', () => {
    axes(0, -1); frame(3);
    expect(hook.aim().has).toBe(true);
    expect(angDiff(aimInfo().screenAngle, -Math.PI / 2) / DEG, 'follows left stick up').toBeLessThan(3);
    axes(1, 0); frame(3);
    expect(angDiff(aimInfo().screenAngle, 0) / DEG, 'follows left stick right').toBeLessThan(3);
    axes(0, 0, 0, 1); frame(3);
    expect(angDiff(aimInfo().screenAngle, Math.PI / 2) / DEG, 'right stick down').toBeLessThan(3);
    axes(-1, 0, 0, 0); frame(3);
    expect(angDiff(aimInfo().screenAngle, Math.PI / 2) / DEG, 'right stick released: keeps its direction, ignores the left stick').toBeLessThan(3);
  });

  test.skipIf(todo)('M10: while pad-aiming, mouseX/Y are the reticle\'s screen point, so the N1/G13 ground point is padAim', () => {
    axes(0, 0, 0.7, -0.3);
    frame(3);
    const a = hook.aim();
    expect(hook.device()).toBe('pad');
    const ox = g.worldOffsetX !== null ? g.worldOffsetX : g.W / 2 - g.cam.x;
    const oy = g.worldOffsetY !== null ? g.worldOffsetY : g.H / 2 - g.cam.y;
    const w = g.toWorld(g.mouseX - ox, g.mouseY - oy);
    expect(Math.hypot(w.x - a.x, w.y - a.y), 'mouseX/Y map to the aim point').toBeLessThan(2);
    expect(Math.hypot(g.mouseGroundX - a.x, g.mouseGroundY - a.y), 'mouseGroundX/Y (N1) = padAim').toBeLessThan(2);
    expect(angDiff(g.player.aimAngle, Math.atan2(a.y - g.player.y, a.x - g.player.x)) / DEG, 'the player aims at it').toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------
// C3: aim assist
// ---------------------------------------------------------------------
describe('M10 aim assist', () => {
  const A0 = 37; // a non-axis ray, degrees (world)
  const ray = () => [g.player.x, g.player.y, Math.cos(A0 * DEG), Math.sin(A0 * DEG)];

  // Spec C3: assist applies "if an enemy's BODY lies within +-5 deg of the aim ray", so the
  // cone is widened by the body's angular half-width: angle - atan(15 * size / t) <= 5 deg,
  // t = distance along the ray (Josh's implementation; e.g. ~9.3 deg at 200u for size 1).
  test.skipIf(todo)('M10: padAssistTarget picks an enemy whose body is within +-5 deg and 420u, null outside', () => {
    const [px, py, dx, dy] = ray();
    const MARGIN = 0.75; // degrees either side of the boundary
    for (const dist of [60, 200, 300, 410]) {
      for (const sign of [1, -1]) {
        // Boundary for a size-1 enemy at this range (t ~ dist * cos(angle); solve iteratively).
        let bound = 5;
        for (let k = 0; k < 6; k++) bound = 5 + Math.atan(15 / (dist * Math.cos(bound * DEG))) / DEG;
        for (const [off, inside] of [[0, true], [bound - MARGIN, true], [bound + MARGIN, false]]) {
          g.enemies.length = 0;
          const e = enemyAt(dist, A0 + sign * off);
          expect(e.size, 'size-1 enemy').toBe(1);
          const got = hook.assist(px, py, dx, dy, 420, 5);
          const what = `${dist}u at ${(sign * off).toFixed(2)} deg (boundary ${bound.toFixed(2)})`;
          if (inside) expect(got, `${what}: picked`).toBe(e);
          else expect(got, `${what}: not picked`).toBeNull();
        }
      }
    }
    for (const [dist, off] of [[430, 0], [300, 180], [300, 30]]) {
      g.enemies.length = 0;
      enemyAt(dist, A0 + off);
      expect(hook.assist(px, py, dx, dy, 420, 5), `${dist}u at ${off} deg: not picked`).toBeNull();
    }
  });

  test.skipIf(todo)('M10: of several enemies in the cone the nearest along the ray wins; dead ones are skipped; bosses count', () => {
    const [px, py, dx, dy] = ray();
    const far = enemyAt(350, A0 + 1);
    const near = enemyAt(250, A0 - 3);
    enemyAt(200, A0 + 20); // nearer, but outside the cone
    expect(hook.assist(px, py, dx, dy, 420, 5), 'nearest along the ray').toBe(near);
    near.dead = true;
    expect(hook.assist(px, py, dx, dy, 420, 5), 'a dead enemy is skipped').toBe(far);
    g.enemies.length = 0;
    const boss = enemyAt(300, A0 + 2, { boss: true });
    expect(hook.assist(px, py, dx, dy, 420, 5), 'bosses are included').toBe(boss);
  });

  /** Aim with the right stick, release it, and put an enemy 4.5 deg off that ray at 300u. */
  function aimNextToEnemy() {
    const p = g.player;
    p.weapon = 0; p.magAmmo = g.WEAPONS[0].mag; p.fireTimer = 0; p.reloading = false;
    g.WEAPONS[0].spread = 0; // shot angle = aim angle
    axes(0, 0, 0.8, 0.45); frame(3);
    axes(0, 0, 0, 0); frame(2);
    const aimDeg = aimInfo().worldAngle / DEG;
    const e = enemyAt(300, aimDeg - 4.5);
    return { aimDeg, enemyDeg: aimDeg - 4.5, e };
  }

  test.skipIf(todo)('M10: with the pad, a shot 4.5 deg off an enemy goes at the enemy', () => {
    const { enemyDeg } = aimNextToEnemy();
    btn(BTN.RT, 1);
    frame(2);
    const a = lastShotAngle();
    expect(a, 'a shot was fired').not.toBeNull();
    expect(angDiff(a, enemyDeg * DEG) / DEG, 'assisted onto the enemy').toBeLessThan(0.3);
  });

  test.skipIf(todo)('M10: CFG.PAD_AIM_ASSIST = false turns the assist off', () => {
    g.CFG.PAD_AIM_ASSIST = false;
    const { aimDeg } = aimNextToEnemy();
    btn(BTN.RT, 1);
    frame(2);
    expect(angDiff(lastShotAngle(), aimDeg * DEG) / DEG, 'unassisted').toBeLessThan(0.3);
  });

  test.skipIf(todo)('M10: the assist is not applied while the demo is active', () => {
    const { aimDeg } = aimNextToEnemy();
    expect(hook.device(), 'last device: pad').toBe('pad');
    // The demo bot fires through the mouse; put its cursor on the (unassisted) aim ray.
    g.demoActive = true;
    const p = g.player, s = g.toScreen(p.x + Math.cos(aimDeg * DEG) * 180, p.y + Math.sin(aimDeg * DEG) * 180);
    g.mouseX = s.x + g.W / 2 - g.cam.x;
    g.mouseY = s.y + g.H / 2 - g.cam.y;
    g.mouseDown = true; g.mouseJustPressed = true;
    frame(1);
    const a = lastShotAngle();
    expect(a, 'the bot fired').not.toBeNull();
    expect(angDiff(a, aimDeg * DEG) / DEG, 'no snap onto the enemy 4.5 deg away').toBeLessThan(0.3);
  });
});

// ---------------------------------------------------------------------
// Device switching (last used wins)
// ---------------------------------------------------------------------
describe('M10 input device', () => {
  test.skipIf(todo)('M10: last used device wins: button -> pad, key -> kbm, stick past the deadzone -> pad, mouse > 8 px -> kbm', () => {
    installMainInput(game);
    const key = (k) => {
      dispatch('keydown', { key: k, code: `Key${k.toUpperCase()}`, preventDefault() {}, stopPropagation() {} });
      dispatch('keyup', { key: k, code: `Key${k.toUpperCase()}`, preventDefault() {}, stopPropagation() {} });
    };
    const move = (x, y) => dispatch('mousemove', { clientX: x, clientY: y, preventDefault() {} });
    move(100, 100);
    key('x');
    expect(hook.device(), 'a key -> kbm').toBe('kbm');
    btn(BTN.A, 1); hook.poll(); btn(BTN.A, 0); hook.poll();
    expect(hook.device(), 'a pad button -> pad').toBe('pad');
    expect(hook.stats().inputDevice).toBe('pad');
    key('x');
    expect(hook.device(), 'a key -> kbm').toBe('kbm');
    axes(0.15, 0, 0, 0.19); hook.poll(); hook.poll();
    expect(hook.device(), 'sticks inside the deadzone do not switch').toBe('kbm');
    axes(0, 0, 0.5, 0); hook.poll();
    expect(hook.device(), 'right stick past the deadzone -> pad').toBe('pad');
    axes(0, 0, 0, 0); hook.poll();
    move(104, 100);
    expect(hook.device(), 'a 4 px mouse move does not switch').toBe('pad');
    move(130, 100);
    expect(hook.device(), 'a 30 px mouse move -> kbm').toBe('kbm');
    hook.poll();
    expect(hook.device(), 'a centred pad is not input').toBe('kbm');
    axes(-0.7, 0); hook.poll();
    expect(hook.device(), 'left stick past the deadzone -> pad').toBe('pad');
  });
});

// ---------------------------------------------------------------------
// C5: title and attract mode (main.js startGame/resetRound are stubs here)
// ---------------------------------------------------------------------
describe('M10 title and demo input', () => {
  test.skipIf(todo)('M10: on the title, A or Start starts the game once per press', () => {
    for (const b of [BTN.A, BTN.START]) {
      g.gameStarted = false;
      started = 0;
      btn(b, 1);
      titleFrame(10);
      expect(started, `button ${b} starts the game once`).toBe(1);
      expect(g.paused, `the press that starts the game (button ${b}) does not also pause it`).toBe(false);
      btn(b, 0);
      titleFrame(1);
    }
  });

  test.skipIf(todo)('M10: on the title, any button or a stick past the deadzone counts as demo input; a stick inside does not', () => {
    g.gameStarted = false;
    const notes = spy('demoNoteInput');
    axes(0.15, -0.1, 0.1, 0.18);
    titleFrame(10);
    expect(notes.length, 'sticks inside the deadzone are not input').toBe(0);
    axes(0, 0, 0, 0); titleFrame(1);
    btn(BTN.X, 1); titleFrame(1); btn(BTN.X, 0); titleFrame(1);
    expect(notes.length, 'a button is input').toBeGreaterThan(0);
    const n = notes.length;
    axes(0, 0.5); titleFrame(1); axes(0, 0); titleFrame(1);
    expect(notes.length, 'a stick past the deadzone is input').toBeGreaterThan(n);
    expect(started, 'X and the stick do not start a game').toBe(0);
  });
});

// ---------------------------------------------------------------------
// C4: rumble
// ---------------------------------------------------------------------
describe('M10 rumble', () => {
  test.skipIf(todo)('M10: padRumble plays dual-rumble with values clamped to [0, 1], at most one effect per 50 ms', () => {
    tick(100);
    expect(hook.rumble(0.5, 0.25, 30), 'first effect plays').toBe(true);
    expect(effects.length).toBe(1);
    expect(effects[0]).toMatchObject({ type: 'dual-rumble', weakMagnitude: 0.5, strongMagnitude: 0.25, duration: 30 });
    const s0 = hook.stats();
    tick(10);
    expect(hook.rumble(1, 1, 30), '10 ms later: skipped').toBe(false);
    tick(35);
    expect(hook.rumble(1, 1, 30), '45 ms later: skipped').toBe(false);
    expect(effects.length).toBe(1);
    expect(hook.stats().rumbleSkipped - s0.rumbleSkipped).toBe(2);
    tick(10);
    expect(hook.rumble(3, -2, 1e6), '55 ms later: plays').toBe(true);
    const e = effects[1];
    expect(e.type).toBe('dual-rumble');
    expect(e.weakMagnitude, 'clamped to 1').toBe(1);
    expect(e.strongMagnitude, 'clamped to 0').toBe(0);
    expect(e.duration, 'duration clamped to a cap').toBeGreaterThan(0);
    expect(e.duration).toBeLessThanOrEqual(1000);
    expect(hook.stats().rumblePlayed - s0.rumblePlayed).toBe(1);
  });

  test.skipIf(todo)('M10: CFG.PAD_RUMBLE = false plays nothing', () => {
    g.CFG.PAD_RUMBLE = false;
    tick(100);
    expect(hook.rumble(1, 1, 30)).toBe(false);
    expect(effects.length).toBe(0);
  });

  for (const kind of ['none', 'throw']) {
    test.skipIf(todo)(`M10: a pad ${kind === 'none' ? 'without vibrationActuator' : 'whose playEffect throws'}: padRumble returns false and raises nothing`, () => {
      pads[0] = null;
      dispatch('gamepaddisconnected', { type: 'gamepaddisconnected', gamepad: { index: 0, connected: false } });
      hook.poll();
      g.paused = false;
      connect(0, { rumble: kind });
      hook.poll();
      tick(100);
      let r;
      expect(() => { r = hook.rumble(1, 1, 30); }).not.toThrow();
      expect(r).toBe(false);
      // Shots also try to rumble: still no error.
      g.player.weapon = 0; g.player.fireTimer = 0;
      btn(BTN.RT, 1);
      expect(() => frame(5)).not.toThrow();
      expect(g.WEAPONS[0].mag - g.player.magAmmo, 'the shot still fired').toBe(1);
    });
  }

  test.skipIf(todo)('M10: shots rumble the weak motor for <= 60 ms, rate-limited to one effect per 50 ms', () => {
    const p = g.player;
    g.unlockedWeapons = 5;
    p.weapon = 4; p.magAmmo = g.WEAPONS[4].mag; p.fireTimer = 0; p.reloading = false; // Minigun: a shot every 35 ms
    const dt = 1 / 240; // fine frames so shots come faster than 50 ms apart
    const s0 = hook.stats();
    btn(BTN.RT, 1);
    frame(240, dt);
    btn(BTN.RT, 0);
    frame(2, dt);
    const fired = g.WEAPONS[4].mag - p.magAmmo;
    expect(fired, 'the minigun fired').toBeGreaterThan(10);
    expect(effects.length, 'shots rumble').toBeGreaterThan(3);
    expect(effects.length, 'but not one effect per shot').toBeLessThan(fired);
    expect(hook.stats().rumbleSkipped - s0.rumbleSkipped, 'extras are counted as skipped').toBeGreaterThan(0);
    for (let i = 0; i < effects.length; i++) {
      const e = effects[i];
      expect(e.type).toBe('dual-rumble');
      expect(e.weakMagnitude, 'weak motor for shots').toBeGreaterThan(0);
      expect(e.weakMagnitude).toBeLessThanOrEqual(1);
      expect(e.strongMagnitude).toBeGreaterThanOrEqual(0);
      expect(e.strongMagnitude).toBeLessThanOrEqual(1);
      expect(e.duration, 'shot rumble <= 60 ms').toBeLessThanOrEqual(60);
      expect(e.duration).toBeGreaterThan(0);
      if (i) expect(e.t - effects[i - 1].t, 'one effect per 50 ms').toBeGreaterThanOrEqual(50 - 1e-6);
    }
  });
});
