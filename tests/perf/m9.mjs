// M9 perf run for the reference machine (manual; not part of CI). Scenario (spec M9 "Order and
// acceptance"): a sustained fight with ~20 burning enemies, ~10 burning trees and a red pond.
//   npm run perf:m9 -- [--minutes 5] [--gpu] [--no-pin] [--port 5178] [--force]
// --gpu launches headed Chromium on the real GPU; without it, SwiftShader (relative numbers only).
// The renderer is pinned to CCD0 unless --no-pin (Q2a protocol; see pin.mjs).
// Checks: Q2a budget (median <= 8 ms, p99 <= 16.7 ms, real GPU only), P1(a) buildMs median <= 3 ms
// (real GPU only) and the sustained ratio (last 20 s vs game 20-40 s) <= 1.15.
// Writes test-results/perf-m9-<timestamp>.json, prints the verdict, exits 1 if a check fails.
// The scene driver is the same as the @perf test in tests/e2e/m9.spec.js.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { pinArg, pinRenderersToCcd0 } from './pin.mjs';
import { LANDED } from '../milestones.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? def : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true);
};
const minutes = Number(arg('minutes', 5));
const gpu = arg('gpu', false) === true;
const port = Number(arg('port', 5178));
const pin = arg('no-pin', false) !== true;
if (!LANDED.M9PERF && arg('force', false) !== true) {
  console.error('M9PERF is not marked landed in tests/milestones.js (the scene needs F1-F3 and W5); pass --force to run anyway.');
  process.exit(2);
}

// Provisional hook names (Josh); same table as tests/e2e/m9.spec.js.
const HOOKS = { waterBlood: 'waterBloodAt', burnStats: 'burnStats' };

/** In-page: a spot with dry land within 240u and a 3x3 pond 280-480u away that is on screen. */
const FIND_M9_SPOT = () => {
  const ts = CFG.TILE_SIZE;
  const wetAt = (x, y) => getTerrainTypeAt(Math.floor(x / ts) * ts, Math.floor(y / ts) * ts) === 'water';
  const dryDisc = (x, y, R) => {
    for (let r = 0; r <= R; r += 40) for (let a = 0; a < 16; a++) { const t = (a / 16) * Math.PI * 2; if (wetAt(x + Math.cos(t) * r, y + Math.sin(t) * r)) return false; }
    return true;
  };
  const pondNear = (x, y) => {
    for (let r = 280; r <= 480; r += 40) {
      for (let a = 0; a < 24; a++) {
        const t = (a / 24) * Math.PI * 2, dx = Math.cos(t) * r, dy = Math.sin(t) * r;
        if (Math.abs(dx - dy) > 400 || Math.abs((dx + dy) * CFG.ISO_SCALE) > 220) continue;
        const i = Math.floor((x + dx) / ts), j = Math.floor((y + dy) / ts);
        let ok = true;
        for (let p = -1; p <= 1 && ok; p++) for (let q = -1; q <= 1 && ok; q++) ok = getTerrainTypeAt((i + p) * ts, (j + q) * ts) === 'water';
        if (ok) return { x: (i + 0.5) * ts, y: (j + 0.5) * ts };
      }
    }
    return null;
  };
  for (let r = 0; r <= 8000; r += 160) {
    for (let a = 0; a < 16; a++) {
      const x = player.x + Math.cos((a / 16) * Math.PI * 2) * r, y = player.y + Math.sin((a / 16) * Math.PI * 2) * r;
      if (!dryDisc(x, y, 240)) continue;
      const pond = pondNear(x, y);
      if (pond) return { spot: { x, y }, pond };
    }
  }
  return null;
};

/** In-page steady M9 load: see M9_LOAD in tests/e2e/m9.spec.js (kept identical). */
const M9_LOAD = ({ h, spot, pond }) => {
  const pondA = Math.atan2(pond.y - spot.y, pond.x - spot.x);
  const treeA = pondA + Math.PI, enemyA = pondA + Math.PI / 2;
  const S = window.__m9load = { stop: false, seq: 0, t0: gameTime, nextPondKill: 0, trees: [], slots: [], samples: [] };
  for (const r of [130, 170, 205]) for (let k = -2; k <= 2; k++) S.trees.push({ x: spot.x + Math.cos(treeA + (k * 45) / r) * r, y: spot.y + Math.sin(treeA + (k * 45) / r) * r, obj: null });
  for (const r of [95, 113, 131, 149]) for (let k = -2; k <= 2; k++) S.slots.push({ x: spot.x + Math.cos(enemyA + (k * 18) / r) * r, y: spot.y + Math.sin(enemyA + (k * 18) / r) * r, e: null });
  const plant = (s) => {
    s.obj = { x: s.x, y: s.y, type: 'tree', radius: 40, height: 100, collision: 8, createdAt: -1, id: `m9load#${S.seq++}` };
    envObjects.push(s.obj);
  };
  S.trees.forEach(plant);
  const pondKill = (gib) => {
    const a = Math.random() * Math.PI * 2;
    const e = spawnEnemy(0, pond.x + Math.cos(a) * 20, pond.y + Math.sin(a) * 20);
    if (e) killEnemy(e, a, gib ? SRC_EXPLOSIVE : SRC_BULLET);
  };
  for (let i = 0; i < 20; i++) pondKill(i % 2);
  const flame = WEAPONS.findIndex((w) => w.name === 'Flamethrower');
  const burning = (e) => (e.burnT || 0) > 0;
  const tick = () => {
    if (S.stop) { mouseDown = false; return; }
    const el = gameTime - S.t0;
    for (const s of S.trees) {
      if (envState(s.obj.id).charred) {
        const i = envObjects.indexOf(s.obj);
        if (i >= 0) envObjects.splice(i, 1);
        plant(s);
      }
    }
    for (const s of S.slots) {
      if (!s.e || s.e.dead || !enemies.includes(s.e)) {
        s.e = spawnEnemy([0, 1, 2, 4][S.seq++ % 4], s.x, s.y);
        if (s.e) { s.e.hp = s.e.maxHp = 1e9; s.e.speed = 0; s.e.fireTimer = 1e9; }
      } else if (Math.hypot(s.e.x - s.x, s.e.y - s.y) > 120) { s.e.x = s.x; s.e.y = s.y; }
    }
    if (el >= S.nextPondKill) { S.nextPondKill += 3; pondKill(Math.round(el) % 2); }
    const trees = envStats().burningTrees || 0;
    let target = null;
    if (trees < 10) {
      const t = S.trees.find((s) => { const st = envState(s.obj.id); return !st.charred && !((st.fire || 0) > 0); });
      if (t) target = t;
    }
    if (!target) {
      const cold = S.slots.filter((s) => s.e && !burning(s.e)).sort((p, q) => Math.hypot(p.e.x - spot.x, p.e.y - spot.y) - Math.hypot(q.e.x - spot.x, q.e.y - spot.y));
      target = cold.length ? cold[0].e : S.slots[10];
    }
    player.x = spot.x; player.y = spot.y; player.vx = 0; player.vy = 0;
    player.weapon = flame; player.magAmmo = WEAPONS[flame].mag; player.reloading = false;
    const sp = toScreen(target.x, target.y);
    mouseX = sp.x + (worldOffsetX !== null ? worldOffsetX : W / 2 - cam.x);
    mouseY = sp.y + (worldOffsetY !== null ? worldOffsetY : H / 2 - cam.y);
    mouseDown = true;
    S.samples.push({ t: el, enemies: window[h.burnStats]().burning, trees, band: window[h.waterBlood](pond.x, pond.y).band });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const server = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'],
  { cwd: ROOT, env: { ...process.env, BROWSER: 'none' }, stdio: 'ignore' });
const url = `http://localhost:${port}/game.html`;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(url)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch(gpu
  ? { headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu', pinArg()] }
  : { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', pinArg()] });
let failed;
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
  await page.goto(url);
  const pinning = pin ? pinRenderersToCcd0() : { pinned: false, reason: '--no-pin' };
  console.log(`renderer pinning: ${JSON.stringify(pinning)}`);
  await page.waitForFunction(() => !document.getElementById('start-btn').disabled, null, { timeout: 30_000 });
  await page.evaluate(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
  await page.click('#start-btn');
  await page.waitForFunction(() => gameStarted && gameTime > 0.2);
  const gpuName = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  const missing = await page.evaluate((h) => Object.values(h).filter((n) => typeof window[n] !== 'function')
    .concat(WEAPONS.some((w) => w.name === 'Flamethrower') ? [] : ['WEAPONS Flamethrower']), HOOKS);
  if (missing.length) throw new Error(`M9 hooks missing: ${missing.join(', ')}`);

  await page.evaluate(() => { waveActive = false; waveTimer = 1e9; enemies.length = 0; player.invincible = 1e9; unlockedWeapons = WEAPONS.length; });
  const site = await page.evaluate(FIND_M9_SPOT);
  if (!site) throw new Error('no dry spot beside an on-screen pond');
  const park = (p) => {
    player.x = p.x; player.y = p.y; player.vx = 0; player.vy = 0;
    const s = toScreen(p.x, p.y);
    cam.x = cam.tx = s.x; cam.y = cam.ty = s.y;
  };
  await page.evaluate(park, site.spot);
  await page.waitForTimeout(1500); // chunks around the spot bake
  await page.evaluate((p) => {
    for (let i = envObjects.length - 1; i >= 0; i--) if (Math.hypot(envObjects[i].x - p.x, envObjects[i].y - p.y) < 450) envObjects.splice(i, 1);
    // Steady decal load from the start (as the P1 run): the store at its cap.
    for (let i = 0; i < CFG.MAX_BLOOD_POOLS; i++) {
      const a = i * 2.399963, r = 40 + (i % 97) * 5;
      addDecal(i % 7, p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, 4 + (i % 6), 0x8a0a0a, a);
    }
  }, site.spot);
  await page.evaluate(M9_LOAD, { h: HOOKS, ...site });
  // Per-frame sampling, windows in GAME time.
  await page.evaluate(() => {
    const s = window.__s = { t: [], cpu: [], build: [], stage: [], retro: [], dt: [], last: performance.now(), t0: window.__m9load.t0 };
    const tick = (now) => {
      if (window.__m9load.stop) return;
      s.t.push(gameTime - s.t0); s.cpu.push(perfLog.totalCpuMs); s.dt.push(now - s.last); s.last = now;
      s.build.push(perfLog.buildMs); s.stage.push(perfLog.stageMs); s.retro.push(perfLog.retroMs);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const total = minutes * 60;
  await page.waitForFunction((end) => gameTime - window.__m9load.t0 >= end, total, { timeout: total * 1000 * 20 + 60_000, polling: 1000 });
  const s = await page.evaluate(() => {
    window.__m9load.stop = true;
    const w = window.__s;
    return { t: w.t, cpu: w.cpu, build: w.build, stage: w.stage, retro: w.retro, dt: w.dt, scene: window.__m9load.samples };
  });
  const window_ = (from, to, xs = s.cpu) => xs.filter((_, i) => s.t[i] >= from && s.t[i] < to).sort((a, b) => a - b);
  const stat = (xs) => ({ median: xs[xs.length >> 1], p99: xs[Math.floor(xs.length * 0.99)], n: xs.length });
  const early = stat(window_(20, 40));
  const late = stat(window_(total - 20, total));
  const all = stat(window_(20, total));
  const build = stat(window_(20, total, s.build));
  const parts = {};
  for (const k of ['build', 'retro', 'stage']) parts[k] = { early: stat(window_(20, 40, s[k])).median, late: stat(window_(total - 20, total, s[k])).median };
  const sceneMed = (k) => { const xs = s.scene.filter((q) => q.t >= 20).map((q) => q[k]).sort((a, b) => a - b); return xs[xs.length >> 1]; };
  let run = 0, longest = 0;
  for (const d of s.dt) { run = d > 1000 / 60 + 0.5 ? run + d : 0; longest = Math.max(longest, run); }
  const result = {
    date: new Date().toISOString(), gpu: gpuName, minutes, viewport: '1920x1080', pinning,
    scene: { spot: site.spot, pond: site.pond, medianBurningEnemies: sceneMed('enemies'), medianBurningTrees: sceneMed('trees'), pondBandEnd: s.scene[s.scene.length - 1].band },
    cpu: { all, early, late, sustainedRatio: late.median / early.median, build, parts },
    longestBelow60fpsMs: Math.round(longest), errors,
    verdict: {
      sustained: late.median / early.median <= 1.15,
      budgetQ2a: gpu ? all.median <= 8 && all.p99 <= 16.7 : 'n/a (software GL)',
      below60fps: gpu ? longest <= 1000 : 'n/a (software GL)',
      buildP1a: gpu ? build.median <= 3 : 'n/a (software GL)',
      noErrors: errors.length === 0,
    },
  };
  failed = Object.values(result.verdict).some((v) => v === false);
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  const out = path.join(ROOT, 'test-results', `perf-m9-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`saved ${out}`);
  console.log(`M9 perf verdict: ${failed ? 'FAIL' : 'PASS'} ${JSON.stringify(result.verdict)}`);
} finally {
  await browser.close();
  server.kill();
}
if (failed) process.exitCode = 1;
