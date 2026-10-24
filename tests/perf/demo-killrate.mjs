// D3a (a) manual check: demo kill rate over 5 x 60 s against the pre-D3a baseline (plain >= 90% bar).
//   npm run perf:demo -- [--runs 5] [--seconds 60] [--baseline 1.06] [--gpu] [--no-pin] [--port 5178]
// The renderer is pinned to CCD0 unless --no-pin (Q2a protocol; see pin.mjs).
// Writes test-results/perf-demo-<timestamp>.json.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { pinRenderersToCcd0 } from './pin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? def : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true);
};
const runs = Number(arg('runs', 5)), seconds = Number(arg('seconds', 60));
const baseline = Number(arg('baseline', 1.06)), gpu = arg('gpu', false) === true, port = Number(arg('port', 5178));
const pin = arg('no-pin', false) !== true;

const server = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'],
  { cwd: ROOT, env: { ...process.env, BROWSER: 'none' }, stdio: 'ignore' });
const url = `http://localhost:${port}/game.html`;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(url)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}
const browser = await chromium.launch(gpu
  ? { headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] }
  : { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(url);
  const pinning = pin ? pinRenderersToCcd0(browser) : { pinned: false, reason: '--no-pin' };
  console.log(`renderer pinning: ${JSON.stringify(pinning)}`);
  await page.waitForFunction(() => !document.getElementById('start-btn').disabled, null, { timeout: 30_000 });
  const results = [];
  for (let r = 0; r < runs; r++) {
    await page.evaluate(() => { CFG.DEMO_IDLE_SECONDS = 1e9; CFG.DEMO_MAX_SECONDS = 1e9; startDemo(); });
    await page.waitForFunction(() => demoState().active && waveActive);
    const k0 = await page.evaluate(() => ({ kills, t: gameTime }));
    await page.waitForTimeout(seconds * 1000);
    const k1 = await page.evaluate(() => ({ kills, t: gameTime }));
    await page.evaluate(() => stopDemo());
    results.push({ kills: k1.kills - k0.kills, gameSecs: k1.t - k0.t });
    console.log(`run ${r + 1}: ${results[r].kills} kills in ${results[r].gameSecs.toFixed(1)} game-s`);
  }
  const kills = results.reduce((a, x) => a + x.kills, 0), gameSecs = results.reduce((a, x) => a + x.gameSecs, 0);
  const rate = kills / gameSecs;
  const out = { date: new Date().toISOString(), pinning, runs: results, rate, baseline, ratio: rate / baseline, pass: rate >= 0.9 * baseline };
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  const file = path.join(ROOT, 'test-results', `perf-demo-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log(`saved ${file}`);
  process.exitCode = out.pass ? 0 : 1;
} finally {
  await browser.close();
  server.kill();
}
