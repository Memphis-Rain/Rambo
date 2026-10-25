// Mocked Xbox pads for the M10 and M11 e2e suites (docs/SPEC.md M10/M11 "Acceptance (Anna)").
// padMock is installed with page.addInitScript before any game script runs. It serves up to
// four standard-mapping fake pads through navigator.getGamepads(); window.__padConnect /
// __padDisconnect hot-plug any slot, __padSet / __padRelease drive one, and every rumble
// effect lands in window.__rumbleCalls tagged with its pad index (`pad`), so each pad has
// its own spy. padIO() is the test-side driver for one pad.
import { T } from './fixtures.js';

// Standard mapping (Xbox labels)
export const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16 };

// ---------------------------------------------------------------------
// Page-side mock, installed with page.addInitScript before any game script runs.
// ---------------------------------------------------------------------
export function padMock({ rumble }) {
  const TRIGGERS = [6, 7];
  const pads = [null, null, null, null];
  window.__pads = pads;
  window.__rumbleCalls = [];
  window.__h = (name) => (0, eval)(name);

  const actuator = (kind, index) => ({
    type: 'dual-rumble',
    playEffect(type, params) {
      window.__rumbleCalls.push({ pad: index, t: performance.now(), gt: typeof gameTime === 'number' ? gameTime : 0, type, ...(params || {}) });
      if (kind === 'throw') throw new DOMException('mock: playEffect failed', 'NotSupportedError');
      if (kind === 'reject') return Promise.reject(new DOMException('mock: playEffect rejected', 'NotSupportedError'));
      return Promise.resolve('complete');
    },
    reset() { return Promise.resolve('complete'); },
  });
  // Chrome returns fresh snapshots on every call, so a cached Gamepad never updates.
  const snapshot = (p) => {
    const s = { id: p.id, index: p.index, connected: p.connected, mapping: p.mapping, timestamp: p.timestamp,
      axes: p.axes.slice(), buttons: p.buttons.map((b) => ({ ...b })) };
    if (p.vibrationActuator) s.vibrationActuator = p.vibrationActuator;
    return s;
  };
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => pads.map((p) => (p ? snapshot(p) : null)),
  });
  const bump = (p) => { p.timestamp = Math.max(p.timestamp + 0.001, performance.now()); };
  const fire = (type, gamepad) => {
    const ev = new Event(type);
    Object.defineProperty(ev, 'gamepad', { value: gamepad });
    window.dispatchEvent(ev);
  };

  /**
   * Plug a pad into slot i (0-3; M11 uses 0 and 1, in any order, at any time).
   * opts.rumble 'ok' | 'none' (no vibrationActuator) | 'throw' | 'reject'.
   */
  window.__padConnect = (i = 0, opts = {}) => {
    const kind = opts.rumble || rumble || 'ok';
    const p = {
      id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
      index: i, connected: true, mapping: 'standard', timestamp: performance.now(),
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })),
    };
    if (kind !== 'none') p.vibrationActuator = actuator(kind, i);
    pads[i] = p;
    fire('gamepadconnected', snapshot(p));
    return true;
  };
  window.__padDisconnect = (i = 0) => {
    const p = pads[i];
    if (!p) return false;
    p.connected = false;
    bump(p);
    pads[i] = null;
    fire('gamepaddisconnected', snapshot(p));
    return true;
  };
  /** state.axes replaces the given axes; state.buttons = { index: value | bool } sets those buttons. */
  window.__padSet = (i, state = {}) => {
    const p = pads[i];
    if (!p) throw new Error(`no pad in slot ${i}`);
    if (state.axes) state.axes.forEach((v, k) => { p.axes[k] = v; });
    for (const [k, v] of Object.entries(state.buttons || {})) {
      const idx = Number(k), val = v === true ? 1 : v === false ? 0 : v;
      p.buttons[idx] = { pressed: TRIGGERS.includes(idx) ? val > 0.1 : val >= 0.5, value: val, touched: val > 0 };
    }
    bump(p);
  };
  window.__padRelease = (i = 0) => {
    const p = pads[i];
    if (!p) return;
    p.axes = [0, 0, 0, 0];
    p.buttons = p.buttons.map(() => ({ pressed: false, value: 0, touched: false }));
    bump(p);
  };
  /** Resolve after n display frames (the game polls the pad once per frame, paused or not). */
  window.__frames = (n) => new Promise((resolve) => {
    let k = 0;
    const f = () => (++k >= n ? resolve() : requestAnimationFrame(f));
    requestAnimationFrame(f);
  });
  /** Visible text: the DOM (opacity/visibility aware) plus visible Pixi Text on the stage. */
  window.__screenText = () => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).filter(Boolean);
      if (own.length && el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) out.push(own.join(' '));
    }
    const walk = (o) => {
      if (!o || o.visible === false || o.renderable === false || o.alpha === 0) return;
      if (typeof o.text === 'string' && o.text) out.push(o.text);
      for (const c of o.children || []) walk(c);
    };
    if (typeof app !== 'undefined' && app && app.stage) walk(app.stage);
    return out.join('\n');
  };
}

// ---------------------------------------------------------------------
// Test-side driver for pad slot i. `state` is an expression the page evaluates (through
// window.__h) to the game's polled state for that pad: 'pad' in M10, e.g. 'padOf(1)' for P2.
// Waits are on the game's view of the pad, so a step returns once the game has polled it.
// ---------------------------------------------------------------------
export function padIO(page, i = 0, state = 'pad') {
  const set = (s) => page.evaluate(([k, v]) => window.__padSet(k, v), [i, s]);
  const waitPressed = (b, v) => page.waitForFunction(([name, k, want]) => {
    const p = window.__h(name);
    return !!p && p.pressed[k] === want;
  }, [state, b, v], { timeout: T(5_000) });
  return {
    set,
    connect: (opts = {}) => page.evaluate(([k, o]) => window.__padConnect(k, o), [i, opts]),
    disconnect: () => page.evaluate((k) => window.__padDisconnect(k), i),
    releaseAll: () => page.evaluate((k) => window.__padRelease(k), i),
    /** Press (hold) a button and wait until the game has polled it. */
    async press(b, value = 1) { await set({ buttons: { [b]: value } }); await waitPressed(b, 1); },
    /** Release a button and wait until the game has polled the release. */
    async release(b) { await set({ buttons: { [b]: 0 } }); await waitPressed(b, 0); },
    /** Press and release (one edge). */
    async tap(b) { await this.press(b); await this.release(b); },
    /** Set the sticks and wait until the game's post-deadzone values have caught up. */
    async sticks(lx, ly, rx = 0, ry = 0) {
      await set({ axes: [lx, ly, rx, ry] });
      await page.waitForFunction(([name, ax]) => {
        const p = window.__h(name), raw = [ax[0], ax[1], ax[2], ax[3]];
        if (!p) return false;
        const live = (x, y) => Math.hypot(x, y) > 0.2;
        return (live(raw[0], raw[1]) ? p.lmag > 0 : p.lmag === 0) && (live(raw[2], raw[3]) ? p.rmag > 0 : p.rmag === 0)
          && Math.sign(p.lx) === Math.sign(live(raw[0], raw[1]) ? raw[0] : 0)
          && Math.sign(p.rx) === Math.sign(live(raw[2], raw[3]) ? raw[2] : 0)
          && Math.sign(p.ry) === Math.sign(live(raw[2], raw[3]) ? raw[3] : 0);
      }, [state, [lx, ly, rx, ry]], { timeout: T(5_000) });
    },
  };
}
