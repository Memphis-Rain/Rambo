// Q2a sustained-perf run for the reference machine (manual; not part of CI).
//   npm run perf:sustained -- [--minutes 5] [--gpu] [--no-pin] [--port 5177]
// --gpu launches headed Chromium on the real GPU; without it, SwiftShader (relative numbers only).
// The renderer is pinned to CCD0 unless --no-pin (Q2a protocol; see pin.mjs). Run once with
// --no-pin as well: the P1(a) absolute check (median <= 3 ms at minute 2) is for unpinned runs.
// Writes test-results/perf-sustained-<timestamp>.json and prints the Q2a verdict.
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
const minutes = Number(arg('minutes', 5));
const gpu = arg('gpu', false) === true;
const port = Number(arg('port', 5177));
const pin = arg('no-pin', false) !== true;

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
  const gpuName = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  // Same gore driver as tests/e2e/perf.spec.js, plus per-frame sampling.
  await page.evaluate(() => {
    waveActive = false; waveTimer = 1e9; player.invincible = 1e9; unlockedWeapons = WEAPONS.length;
    const s = window.__s = { t: [], cpu: [], dt: [], kills: 0, booms: 0, start: performance.now(), last: performance.now() };
    const tick = (now) => {
      const el = (now - s.start) / 1000;
      for (let i = enemies.length; i < 40; i++) {
        const a = Math.random() * Math.PI * 2;
        spawnEnemy(i % 6, player.x + Math.cos(a) * 220, player.y + Math.sin(a) * 220);
      }
      while (s.kills < el * 10 && enemies.length) {
        const e = enemies[(s.kills * 7) % enemies.length];
        if (s.kills % 2) damageEnemy(e, e.hp * 3, Math.random() * 6.28, SRC_EXPLOSIVE); else killEnemy(e, Math.random() * 6.28);
        s.kills++;
      }
      while (s.booms < el * 2) { spawnExplosion(player.x + 150 * Math.cos(s.booms), player.y + 150 * Math.sin(s.booms), 150); s.booms++; }
      s.t.push(el); s.cpu.push(perfLog.totalCpuMs); s.dt.push(now - s.last); s.last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.waitForTimeout(minutes * 60_000 + 2_000);
  const s = await page.evaluate(() => ({ t: window.__s.t, cpu: window.__s.cpu, dt: window.__s.dt }));
  const window_ = (from, to) => s.cpu.filter((_, i) => s.t[i] >= from && s.t[i] < to).sort((a, b) => a - b);
  const stat = (xs) => ({ median: xs[xs.length >> 1], p99: xs[Math.floor(xs.length * 0.99)], n: xs.length });
  const early = stat(window_(20, 40));                            // around minute 0.5
  const late = stat(window_(minutes * 60 - 20, minutes * 60));    // last 20 s
  const all = stat(s.cpu.slice().sort((a, b) => a - b));
  const minute2 = minutes * 60 >= 130 ? stat(window_(110, 130)) : null;
  // Longest run of frame intervals over 1000/60 ms (fps below 60).
  let run = 0, longest = 0;
  for (const d of s.dt) { run = d > 1000 / 60 + 0.5 ? run + d : 0; longest = Math.max(longest, run); }
  const result = {
    date: new Date().toISOString(), gpu: gpuName, minutes, viewport: '1920x1080', pinning,
    cpu: { all, early, late, minute2, sustainedRatio: late.median / early.median },
    longestBelow60fpsMs: Math.round(longest), errors,
    verdict: {
      sustained: late.median / early.median <= 1.15,
      below60fps: gpu ? longest <= 1000 : 'n/a (software GL)',
      budget40Gore: gpu ? all.median <= 8 && all.p99 <= 16.7 : 'n/a (software GL)',
      // P1(a): unpinned, 40 + gore, median <= 3 ms at minute 2 (after the water overlay bake).
      p1aUnpinnedMinute2: pinning.pinned ? 'n/a (pinned run)' : !gpu ? 'n/a (software GL)' : minute2 ? minute2.median <= 3 : 'n/a (run >= 2.2 min)',
    },
  };
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  const out = path.join(ROOT, 'test-results', `perf-sustained-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`saved ${out}`);
} finally {
  await browser.close();
  server.kill();
}
