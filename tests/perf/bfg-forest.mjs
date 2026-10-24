// M8 / Q2a manual check: a BFG in a dense forest must not cause a frame over 16.7 ms
// on the real GPU, renderer pinned to CCD0 (Q2a protocol, see pin.mjs).
//   npm run perf:bfg -- [--gpu] [--no-pin] [--blasts 3] [--port 5179]
// Writes test-results/perf-bfg-<timestamp>.json; exits 1 if any frame exceeds 16.7 ms.
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
const blasts = Number(arg('blasts', 3)), port = Number(arg('port', 5179));

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
  for (let b = 0; b < blasts; b++) {
    // Walk the player across the map until a spot with 60+ standing trees within a
    // chunk-sized radius is loaded, then let chunks bake for a moment.
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
    if (!spot) { results.push({ error: 'no 60+ tree spot found' }); continue; }
    await page.evaluate((s) => { player.x = s.x + 150; player.y = s.y + 150; }, spot);
    await page.waitForTimeout(2000);
    const r = await page.evaluate((s) => new Promise((resolve) => {
      const felled0 = envStats().felled;
      const cpu = [];
      const t0 = performance.now();
      spawnExplosion(s.x, s.y, WEAPONS.find((w) => w.name === 'BFG').radius, true, SRC_BFG);
      const tick = (now) => {
        cpu.push(perfLog.totalCpuMs);
        if (now - t0 < 5000) requestAnimationFrame(tick);
        else {
          const sorted = cpu.slice().sort((a, b) => a - b);
          resolve({ trees: s.n, felled: envStats().felled - felled0, frames: cpu.length,
            over16_7: cpu.filter((x) => x > 16.7).length, maxMs: sorted[sorted.length - 1],
            p99: sorted[Math.floor(sorted.length * 0.99)], median: sorted[sorted.length >> 1] });
        }
      };
      requestAnimationFrame(tick);
    }), spot);
    console.log(`blast ${b + 1}: ${JSON.stringify(r)}`);
    results.push(r);
  }
  const gpuName = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  const pass = results.every((r) => !r.error && r.over16_7 === 0);
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
