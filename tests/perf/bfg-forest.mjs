// M8 / Q2a manual check (spec E8 clarification): an EVENT = BFG explosion(s) in one frame
// that fell 10+ trees in total; over the following 3 s no frame may exceed 16.7 ms on the
// real GPU, renderer pinned to CCD0 (Q2a protocol, see pin.mjs).
//   npm run perf:bfg -- [--gpu] [--no-pin] [--events 3] [--port 5179]
// Writes test-results/perf-bfg-<timestamp>.json; exits 1 if a qualifying event has a frame over 16.7 ms.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { pinArg, pinRenderersToCcd0 } from './pin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? def : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true);
};
const gpu = arg('gpu', false) === true, pin = arg('no-pin', false) !== true;
const events = Number(arg('events', 3)), port = Number(arg('port', 5179));

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
  await page.evaluate(() => { waveActive = false; waveTimer = 1e9; player.invincible = 1e9; unlockedWeapons = WEAPONS.length; });

  const TREES = ['tree', 'pine', 'deadtree'];
  const results = [];
  let bfgs = 2; // BFGs per event; raised when an event fells fewer than 10 trees
  for (let attempt = 0; results.filter((r) => r.qualifies).length < events && attempt < events + 4; attempt++) {
    // Walk the player across the map until a spot with 60+ standing trees within a
    // chunk-sized radius is loaded.
    const spot = await page.evaluate(async (types) => {
      const R = CFG.CHUNK_SIZE * CFG.TILE_SIZE * 0.6;
      // envObjState() is null for untouched objects, else a record with .state.
      const standing = (o) => { if (!types.includes(o.type)) return false; const r = envObjState(o); return !r || r.state === 'standing'; };
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      for (let step = 0; step < 200; step++) {
        let best = null;
        for (const o of envObjects) {
          if (!standing(o)) continue;
          let n = 0;
          for (const q of envObjects) if (standing(q) && Math.abs(q.x - o.x) < R && Math.abs(q.y - o.y) < R) n++;
          if (!best || n > best.n) best = { x: o.x, y: o.y, n };
        }
        if (best && best.n >= 60) return best;
        player.x += 900; player.y += 300 * Math.sin(step);
        for (let i = 0; i < 10; i++) await frame();
      }
      return null;
    }, TREES);
    if (!spot) { results.push({ error: 'no 60+ tree spot found', qualifies: false }); break; }
    await page.evaluate((s) => { player.x = s.x + 150; player.y = s.y + 150; }, spot);
    await page.waitForTimeout(2000);
    const r = await page.evaluate(({ s, n, types }) => new Promise((resolve) => {
      const standing = (o) => { if (!types.includes(o.type)) return false; const q = envObjState(o); return !q || q.state === 'standing'; };
      // n BFG centres on the densest standing trees around the spot, >= 120 apart.
      const near = envObjects.filter((o) => standing(o) && Math.hypot(o.x - s.x, o.y - s.y) < 500);
      const score = (o) => near.filter((q) => Math.hypot(q.x - o.x, q.y - o.y) < 150).length;
      const centres = [];
      for (const o of near.sort((a, b) => score(b) - score(a))) {
        if (centres.every((c) => Math.hypot(c.x - o.x, c.y - o.y) >= 120)) centres.push(o);
        if (centres.length >= n) break;
      }
      const felled0 = envStats().felled;
      const radius = WEAPONS.find((w) => w.name === 'BFG').radius;
      const cpu = [];
      for (const c of centres) spawnExplosion(c.x, c.y, radius, true, SRC_BFG); // one frame
      const t0 = performance.now();
      const tick = (now) => {
        cpu.push(perfLog.totalCpuMs);
        if (now - t0 < 3000) requestAnimationFrame(tick);
        else {
          const sorted = cpu.slice().sort((a, b) => a - b);
          const felled = envStats().felled - felled0;
          resolve({ trees: s.n, bfgs: centres.length, felled, qualifies: felled >= 10, frames: cpu.length,
            over16_7: cpu.filter((x) => x > 16.7).length, maxMs: sorted[sorted.length - 1],
            p99: sorted[Math.floor(sorted.length * 0.99)], median: sorted[sorted.length >> 1] });
        }
      };
      requestAnimationFrame(tick);
    }), { s: spot, n: bfgs, types: TREES });
    console.log(`event ${attempt + 1}: ${JSON.stringify(r)}`);
    results.push(r);
    if (!r.qualifies) bfgs++;
  }
  const gpuName = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  const qualifying = results.filter((r) => r.qualifies);
  const pass = qualifying.length > 0 && qualifying.every((r) => r.over16_7 === 0);
  const out = { date: new Date().toISOString(), gpu: gpuName, pinning, results, errors, pass: gpu ? pass : `n/a (software GL; frames over 16.7: ${results.map((r) => r.over16_7).join(',')})` };
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  const file = path.join(ROOT, 'test-results', `perf-bfg-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log(`saved ${file}`);
  if (gpu && !pass) process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
