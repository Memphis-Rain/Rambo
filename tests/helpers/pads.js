// Fake Xbox pads for the headless M10 and M11 unit suites (docs/SPEC.md M10/M11 "Acceptance
// (Anna)"). A rig serves up to four standard-mapping pads through a stubbed
// navigator.getGamepads() that returns fresh snapshots on every call, as Chrome does, on a
// fake clock. Pads hot-plug in any slot at any time; every rumble effect is recorded in
// rig.effects tagged with its pad index (`pad`), so each pad has its own spy.
//
//   const rig = createPadRig();
//   game = newRound({ stubs: { ...rig.stubs(), startGame: ... } });
//   rig.connect(0); rig.connect(1); rig.btn(1, BTN.START, true);

// Standard mapping (Xbox labels)
export const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16 };
export const TRIGGERS = [BTN.LT, BTN.RT];
const PAD_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';

export function createPadRig() {
  const rig = {
    pads: [null, null, null, null],
    clock: { ms: 1000 },
    effects: [],
    listeners: {},
    getGamepadsCalls: 0, // navigator.getGamepads() calls (K2.1: once per frame)
  };
  const { pads, clock, effects, listeners } = rig;

  /** A pad in slot `index`: rumble 'ok' | 'none' (no vibrationActuator) | 'throw'. */
  rig.makePad = (index = 0, { rumble = 'ok', id = PAD_ID } = {}) => {
    const p = {
      id, index, connected: true, mapping: 'standard', timestamp: clock.ms,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })),
    };
    if (rumble !== 'none') {
      p.vibrationActuator = {
        type: 'dual-rumble',
        playEffect(type, params) {
          effects.push({ pad: index, t: clock.ms, type, ...(params || {}) });
          if (rumble === 'throw') throw new Error('mock: playEffect failed');
          return Promise.resolve('complete');
        },
        reset() { return Promise.resolve('complete'); },
      };
    }
    return p;
  };
  /** A Chrome-like snapshot: new objects per getGamepads() call, same actuator. */
  rig.snapshot = (p) => {
    const s = { id: p.id, index: p.index, connected: p.connected, mapping: p.mapping, timestamp: p.timestamp,
      axes: p.axes.slice(), buttons: p.buttons.map((b) => ({ ...b })) };
    if (p.vibrationActuator) s.vibrationActuator = p.vibrationActuator;
    return s;
  };
  rig.dispatch = (type, ev) => {
    for (const fn of listeners[type] || []) fn(ev);
  };
  /** Globals for newRound({ stubs }): getGamepads, the fake clock and window listeners. */
  rig.stubs = () => ({
    navigator: { getGamepads: () => { rig.getGamepadsCalls++; return pads.map((p) => (p ? rig.snapshot(p) : null)); }, userAgent: 'vitest' },
    performance: { now: () => clock.ms },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  });
  rig.connect = (index = 0, opts) => {
    pads[index] = rig.makePad(index, opts);
    rig.dispatch('gamepadconnected', { type: 'gamepadconnected', gamepad: rig.snapshot(pads[index]) });
    return pads[index];
  };
  rig.disconnect = (index = 0) => {
    const p = pads[index];
    if (!p) return false;
    p.connected = false;
    rig.bump(p);
    pads[index] = null;
    rig.dispatch('gamepaddisconnected', { type: 'gamepaddisconnected', gamepad: rig.snapshot(p) });
    return true;
  };
  rig.bump = (p) => { p.timestamp = Math.max(p.timestamp + 0.001, clock.ms); };
  /** Set button b of pad `index` (true/false or an analog value); triggers report pressed above 0.1 like real pads. */
  rig.btn = (index, b, v) => {
    const p = pads[index];
    if (!p) throw new Error(`no pad in slot ${index}`);
    const val = v === true ? 1 : v === false ? 0 : v;
    p.buttons[b] = { pressed: TRIGGERS.includes(b) ? val > 0.1 : val >= 0.5, value: val, touched: val > 0 };
    rig.bump(p);
  };
  rig.axes = (index, lx, ly, rx = 0, ry = 0) => {
    const p = pads[index];
    if (!p) throw new Error(`no pad in slot ${index}`);
    p.axes = [lx, ly, rx, ry];
    rig.bump(p);
  };
  /** Release every button and centre both sticks of pad `index`. */
  rig.release = (index) => {
    const p = pads[index];
    if (!p) return;
    p.axes = [0, 0, 0, 0];
    p.buttons = p.buttons.map(() => ({ pressed: false, value: 0, touched: false }));
    rig.bump(p);
  };
  /** Effects played on pad `index` only. */
  rig.effectsOf = (index) => effects.filter((e) => e.pad === index);
  return rig;
}

// ---------------------------------------------------------------------
// Headless main.js pieces (main.js isn't loaded: its async init needs a GPU)
// ---------------------------------------------------------------------
/** The source of `function name(...) {...}` from a classic script's text. */
export function sourceFunction(src, name, file = 'js/main.js') {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${file}: function ${name}() not found`);
  let depth = 0;
  for (let k = src.indexOf('{', start); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(start, k + 1);
  }
  throw new Error(`${file}: unbalanced braces in ${name}()`);
}
