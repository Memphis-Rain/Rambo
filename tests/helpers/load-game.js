// Loads the game's classic <script> files into a node:vm context so their
// shared global scope (top-level let/const/function) can be tested headless.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Pure game logic, in game.html load order. No rendering modules.
export const LOGIC_FILES = [
  'js/config.js',
  'js/utils.js',
  'js/audio.js',
  'js/state.js',
  'js/particles.js',
  'js/world.js',
  'js/combat.js',
];

// Scripts game.html loads, in order (excluding the PixiJS library itself).
export function gameHtmlScripts() {
  const html = fs.readFileSync(path.join(ROOT, 'game.html'), 'utf8');
  return [...html.matchAll(/<script\s+[^>]*src="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((src) => !src.startsWith('lib/'));
}

// Deterministic PRNG so noise tables and Math.random-driven logic are reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A value that absorbs any property access, call, or construction. Used as the
// PIXI stub so rendering modules can be evaluated without a GPU.
export function noopProxy() {
  const target = function () {};
  const handler = {
    get(_t, prop) {
      if (prop === 'then') return undefined; // don't look like a Promise
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === Symbol.iterator) return function* () {};
      return proxy;
    },
    set() { return true; },
    apply() { return proxy; },
    construct() { return proxy; },
  };
  const proxy = new Proxy(target, handler);
  return proxy;
}

function makeElement() {
  const ctx2d = noopProxy();
  return {
    style: {},
    textContent: '',
    width: 0,
    height: 0,
    addEventListener() {},
    removeEventListener() {},
    getContext: () => ctx2d,
    appendChild() {},
  };
}

function makeDocument() {
  const elements = new Map();
  return {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    createElement: () => makeElement(),
    addEventListener() {},
    body: makeElement(),
  };
}

/**
 * Evaluate classic scripts in a fresh vm context.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.files] - paths relative to the repo root, in load order
 * @param {number} [opts.seed] - seed for the context's Math.random
 * @param {object} [opts.stubs] - extra globals defined before the scripts run;
 *   a script's own function declaration with the same name replaces the stub
 * @returns game handle: `g` (live proxy to globals, including let/const), `run(code)`,
 *   and `calls` (recorded calls to the default addShake/showNotification stubs)
 */
export function loadGame({ files = LOGIC_FILES, seed = 1, stubs = {} } = {}) {
  const seededMath = Object.create(null);
  for (const key of Object.getOwnPropertyNames(Math)) seededMath[key] = Math[key];
  seededMath.random = mulberry32(seed);

  const calls = { addShake: [], showNotification: [] };
  const sandbox = {
    console,
    Math: seededMath,
    performance: { now: () => 0 },
    setTimeout: () => 0,
    clearTimeout() {},
    requestAnimationFrame: () => 0,
    document: makeDocument(),
    PIXI: noopProxy(),
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
    // main.js provides these in the browser; stub them when main.js isn't loaded.
    addShake: (mag) => { calls.addShake.push(mag); },
    showNotification: (text, duration) => { calls.showNotification.push({ text, duration }); },
    ...stubs,
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);

  for (const file of files) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }

  const run = (code) => vm.runInContext(code, context);
  const isIdent = (name) => typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name);

  // Top-level let/const live in the script scope, not on the global object,
  // so read and write them by evaluating code in the context.
  const g = new Proxy({}, {
    get(_t, name) {
      if (!isIdent(name)) return undefined;
      return run(`typeof ${name} === 'undefined' ? undefined : ${name}`);
    },
    set(_t, name, value) {
      context.__testValue = value;
      run(`${name} = __testValue`);
      delete context.__testValue;
      return true;
    },
    has(_t, name) {
      return isIdent(name) && run(`typeof ${name} !== 'undefined'`);
    },
  });

  return { g, run, calls, context };
}

/** Load the logic files and start a fresh round the way startGame() does. */
export function newRound(opts) {
  const game = loadGame(opts);
  const { g } = game;
  g.W = 1280;
  g.H = 720;
  g.player = g.createPlayer();
  return game;
}
