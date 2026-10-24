import { test, expect, T } from './fixtures.js';
import { LANDED } from '../milestones.js';

// T11 / M6 attract mode (D8 hooks). Skipped until M6 is marked landed in tests/milestones.js.
// The Q1 console guard from fixtures.js applies throughout.

test.skip(!LANDED.M6, 'M6 not landed (tests/milestones.js)');

async function bootTitle(game, idleSeconds) {
  await game.boot();
  // On a slow machine the default 5 s idle can elapse during boot, so hold the demo
  // off, stop one that already started, and reset the idle timer with a real move.
  await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; if (demoState().active) stopDemo(); });
  await game.page.mouse.move(5, 5);
  await game.page.mouse.move(200, 200);
  await game.page.waitForFunction(() => !demoState().active && demoState().idleTimer < 0.5, null, { timeout: T(5_000) });
  await game.eval((s) => { CFG.DEMO_IDLE_SECONDS = s; }, idleSeconds);
}

/** Wait until the running demo has been active for `seconds` of game time. */
async function waitDemoElapsed(game, seconds) {
  await game.page.waitForFunction((s) => !demoState().active || demoState().elapsed >= s, seconds,
    { timeout: T(10_000 + seconds * 4000) });
}

const demo = (game) => game.eval(() => demoState());

async function waitForDemo(game, active, timeout = 15_000) {
  await game.page.waitForFunction((a) => demoState().active === a, active, { timeout: T(timeout) });
}

test.describe('T11 attract mode', () => {
  test('T11/D1: idle on the title starts the demo after CFG.DEMO_IDLE_SECONDS', async ({ game }, testInfo) => {
    await bootTitle(game, 1);
    expect((await demo(game)).active).toBe(false);
    await waitForDemo(game, true, 10_000);
    await game.snap(testInfo, 'T11-demo-start.png');
  });

  test('T11/D3/D4: the demo kills enemies, advances gameTime and cycles weapons within 20 s', async ({ game }, testInfo) => {
    test.setTimeout(T(60_000) * 2);
    await bootTitle(game, 1);
    await waitForDemo(game, true, 10_000);
    const s0 = await game.eval(() => ({ t: gameTime, kills, weapon: demoState().weaponIndex }));
    const seenWeapons = new Set([s0.weapon]);
    let last = s0;
    // Sample once per second of DEMO time (game time), up to 20 s.
    for (let i = 1; i <= 20; i++) {
      await waitDemoElapsed(game, i);
      last = await game.eval(() => ({ t: gameTime, kills, weapon: demoState().weaponIndex, active: demoState().active }));
      seenWeapons.add(last.weapon);
      if (!last.active) break;
      if (i === 9) await game.snap(testInfo, 'T11-demo-action.png');
    }
    testInfo.annotations.push({ type: 'demo', description: `kills=${last.kills} gameTime=${last.t.toFixed(1)} weapons=${[...seenWeapons].join(',')}` });
    expect(last.t).toBeGreaterThan(s0.t);
    expect(last.kills).toBeGreaterThan(s0.kills);
    expect(seenWeapons.size, 'D4: weapon cycles every ~8 s').toBeGreaterThan(1);
  });

  test('T11/D6: a keypress exits to the title without starting a game', async ({ game, page }) => {
    await bootTitle(game, 1);
    await waitForDemo(game, true, 10_000);
    await page.keyboard.press('x');
    await waitForDemo(game, false, 2_000);
    // The D6 loop would legitimately restart the demo after 1 s idle; stop that here.
    await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
    await expect(page.locator('#start-screen')).toBeVisible();
    await expect(page.locator('#start-btn')).toBeVisible();
    // The exit input must not also start a real game.
    await page.waitForTimeout(500);
    expect(await game.eval(() => demoState().active)).toBe(false);
    await expect(page.locator('#start-screen')).toBeVisible();
  });

  test('T11/D6: a click exits the demo without starting a game', async ({ game, page }) => {
    await bootTitle(game, 1);
    await waitForDemo(game, true, 10_000);
    const { W: w, H: h } = await game.eval(() => ({ W, H }));
    await page.mouse.click(w / 2, h - 40);
    await waitForDemo(game, false, 2_000);
    await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
    await page.waitForTimeout(500);
    await expect(page.locator('#start-screen')).toBeVisible();
  });

  test('T11/D6: a real game after the demo starts from a clean state', async ({ game, page }) => {
    await bootTitle(game, 1);
    await waitForDemo(game, true, 10_000);
    await page.waitForFunction(() => kills > 0, null, { timeout: T(20_000) });
    await page.keyboard.press('x');
    await waitForDemo(game, false, 2_000);
    // Keep the demo from re-triggering while we start the real game.
    await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
    await game.start();
    const s = await game.eval(() => ({
      score, kills, unlockedWeapons, combo, bestCombo,
      weapon: player.weapon, hp: player.hp, maxHp: player.maxHp,
      demoActive: demoState().active,
      bodies: bodies.length, pickups: pickups.length,
    }));
    expect(s.demoActive).toBe(false);
    expect(s.score).toBe(0);
    expect(s.kills).toBe(0);
    expect(s.unlockedWeapons).toBe(1);
    expect(s.combo).toBe(0);
    expect(s.bestCombo).toBe(0);
    expect(s.weapon).toBe(0);
    expect(s.hp).toBe(s.maxHp);
    expect(s.pickups).toBe(0);
  });

  test('T11/D1: mouse jitter under 8 px does not reset the idle timer', async ({ game, page }) => {
    await bootTitle(game, 1e9);
    await page.mouse.move(400, 300);
    await page.waitForFunction(() => demoState().idleTimer > 0.3, null, { timeout: T(5_000) });
    let prev = (await demo(game)).idleTimer;
    for (const [dx, dy] of [[3, 0], [0, 4], [-5, 2], [2, -6], [5, 5]]) {
      await page.mouse.move(400 + dx, 300 + dy);
      // A reset would drop the timer below prev; otherwise it keeps counting up.
      await page.waitForFunction((p) => demoState().idleTimer > p + 0.1 || demoState().idleTimer < p, prev, { timeout: T(5_000) });
      const t = (await demo(game)).idleTimer;
      expect(t, `jitter (${dx},${dy}) reset the idle timer`).toBeGreaterThan(prev);
      prev = t;
    }
    // A real move (> 8 px) does reset it.
    await page.mouse.move(460, 360);
    await page.waitForFunction((p) => demoState().idleTimer < p, prev, { timeout: T(5_000) });
  });

  test('T11/D1: the demo never starts during real play or while paused', async ({ game, page }) => {
    await bootTitle(game, 1);
    await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
    await game.start();
    await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1; });
    await game.advance(2.5); // 2.5 s of game time with no input
    expect((await demo(game)).active).toBe(false);
    await page.keyboard.press('p');
    expect(await game.eval(() => paused)).toBe(true);
    await page.waitForTimeout(T(2_500));
    expect((await demo(game)).active).toBe(false);
  });

  test('T11/D6: the demo ends on its own after CFG.DEMO_MAX_SECONDS and loops title -> demo', async ({ game }) => {
    test.setTimeout(T(60_000) * 2);
    await bootTitle(game, 1);
    expect(await game.eval(() => CFG.DEMO_MAX_SECONDS), 'D8 default').toBe(60);
    await game.eval(() => { CFG.DEMO_MAX_SECONDS = 4; });
    await waitForDemo(game, true, 10_000);
    await waitForDemo(game, false, 15_000);
    await expect(game.page.locator('#start-screen')).toBeVisible();
    // idleTimer restarts from 0 when a demo ends (D6/D8), then the demo comes back.
    expect((await demo(game)).idleTimer).toBeLessThan(1);
    await waitForDemo(game, true, 10_000);
    await waitForDemo(game, false, 15_000);
  });

  test('T11/D8: startDemo()/stopDemo() drive the demo directly', async ({ game, page }) => {
    await bootTitle(game, 1e9);
    await game.eval(() => startDemo());
    await waitForDemo(game, true, 2_000);
    await waitDemoElapsed(game, 0.5);
    await game.eval(() => stopDemo());
    await waitForDemo(game, false, 2_000);
    await expect(page.locator('#start-screen')).toBeVisible();
  });

  test('D4: the demo starts at wave 10', async ({ game }) => {
    test.skip(!LANDED.FU1, 'follow-up FU1 not landed (tests/milestones.js)');
    await bootTitle(game, 1);
    await waitForDemo(game, true, 10_000);
    // The counter sits at 9 for ~0.3 s; the first wave that actually runs must be 10.
    await game.page.waitForFunction(() => waveActive, null, { timeout: T(10_000) });
    expect(await game.eval(() => wave)).toBeGreaterThanOrEqual(10);
    // Wave-10 enemy types are in the spawn pool.
    const types = await game.eval(() => ENEMY_TYPES.filter((t) => t.wave <= wave).map((t) => t.name));
    expect(types).toEqual(expect.arrayContaining(['Berserker', 'Bomber', 'Commando']));
  });

  test('D5: the title overlay does not hide the demo; DEMO banner and prompt are on screen', async ({ game, page }, testInfo) => {
    test.skip(!LANDED.FU1, 'follow-up FU1 not landed (tests/milestones.js)');
    await bootTitle(game, 1);
    await waitForDemo(game, true, 10_000);
    await waitDemoElapsed(game, 2);
    // Score/HUD must be visible "as normal", so the full-screen title DOM must not cover the canvas.
    const cover = await game.eval(() => {
      const el = document.getElementById('start-screen');
      const cs = getComputedStyle(el);
      const hidden = cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0;
      return { hidden, top: document.elementFromPoint(W / 2, 40)?.id || '', bottom: document.elementFromPoint(W / 2, H - 30)?.id || '' };
    });
    expect(cover.hidden, 'D5: #start-screen hidden during the demo').toBe(true);
    // Sample over > 1 blink period so a blinking banner is caught in its "on" phase.
    const texts = new Set();
    for (let i = 0; i < 8; i++) {
      for (const t of await game.eval(() => {
        const out = [];
        const walk = (n) => {
          if (!n || n.visible === false || n.worldAlpha === 0) return;
          if (typeof n.text === 'string' && n.text) out.push(n.text);
          (n.children || []).forEach(walk);
        };
        walk(app.stage);
        // The overlay may also be DOM; innerText skips hidden elements.
        out.push(document.body.innerText);
        return out;
      })) texts.add(t.toUpperCase());
      await page.waitForTimeout(250);
    }
    await game.snap(testInfo, 'D5-demo-overlay.png');
    const all = [...texts].join(' | ');
    expect(all, 'D5: DEMO banner').toMatch(/\bDEMO\b/);
    expect(all, 'D5: bottom prompt').toMatch(/PRESS ANY KEY OR CLICK TO PLAY/);
  });

  // D3a bar (spec ca242e3), over 3 x 30 s demo runs at wave 10. KILLS_BASELINE is the
  // kill rate of the pre-D3a bot (87a27f1), measured with this same scenario.
  const KILLS_BASELINE = Number(process.env.D3A_KILLS_BASELINE || 1.06); // kills per game-second, 87a27f1 (measured 1.06-1.07)

  test('D3a/B6: the demo bot reads as deliberate (few reversals, no jitter in place, kill rate kept)', { tag: '@perf' }, async ({ game }, testInfo) => {
    test.skip(!LANDED.D3A && !process.env.D3A_MEASURE, 'D3A not landed (tests/milestones.js)');
    test.setTimeout(T(180_000));
    await bootTitle(game, 1e9);
    const runs = [];
    for (let run = 0; run < 3; run++) {
      await game.eval(() => { CFG.DEMO_MAX_SECONDS = 1e9; startDemo(); });
      runs.push(await game.eval((seconds) => new Promise((resolve) => {
        const samples = [];
        let start = null;
        const kills0 = kills, gt0 = gameTime;
        const tick = (now) => {
          if (start === null) start = now;
          const x = (keys.d ? 1 : 0) - (keys.a ? 1 : 0), y = (keys.s ? 1 : 0) - (keys.w ? 1 : 0);
          samples.push({ t: (now - start) / 1000, x, y, px: player.x, py: player.y, dodge: !!player.dodging });
          if (now - start < seconds * 1000 && demoState().active) requestAnimationFrame(tick);
          else {
            // Reversal: a new direction against the last non-zero one (dot < 0) within 0.4 s.
            const rev = [];
            let last = null;
            for (const q of samples) {
              if (!q.x && !q.y) continue;
              if (last && q.x * last.x + q.y * last.y < 0 && q.t - last.t < 0.4) rev.push(q.t);
              last = q;
            }
            // Jitter in place: >= 3 reversals within 1 s, net/path displacement < 0.3, no dodge in that second.
            let jitter = 0, lastWindowEnd = -1;
            for (let k = 2; k < rev.length; k++) {
              if (rev[k] - rev[k - 2] > 1 || rev[k - 2] < lastWindowEnd) continue;
              const w = samples.filter((q) => q.t >= rev[k - 2] && q.t <= rev[k]);
              let path = 0;
              for (let m = 1; m < w.length; m++) path += Math.hypot(w[m].px - w[m - 1].px, w[m].py - w[m - 1].py);
              const net = Math.hypot(w[w.length - 1].px - w[0].px, w[w.length - 1].py - w[0].py);
              if (!w.some((q) => q.dodge) && path > 0 && net / path < 0.3) { jitter++; lastWindowEnd = rev[k]; }
            }
            resolve({ secs: samples[samples.length - 1].t, gameSecs: gameTime - gt0, reversals: rev.length, jitter, kills: kills - kills0 });
          }
        };
        requestAnimationFrame(tick);
      }), 30));
      await game.eval(() => stopDemo());
    }
    const sum = (k) => runs.reduce((a, r) => a + r[k], 0);
    // Kill rate per game-second, so a slow software-GL frame rate doesn't skew it.
    const secs = sum('secs'), revRate = sum('reversals') / secs, jitter = sum('jitter'), killRate = sum('kills') / sum('gameSecs');
    const summary = `secs=${secs.toFixed(1)} reversals=${sum('reversals')} (${revRate.toFixed(2)}/s) jitterWindows=${jitter} kills=${sum('kills')} (${killRate.toFixed(2)}/game-s, baseline ${KILLS_BASELINE || 'n/a'})`;
    console.log(`[D3a] ${summary}`);
    testInfo.annotations.push({ type: 'D3a', description: summary });
    expect(revRate, 'D3a: average reversals per second').toBeLessThanOrEqual(0.8);
    expect(jitter, 'D3a: jitter-in-place windows per 90 s').toBeLessThanOrEqual(3);
    // D3a (b): a 90 s sample has ~±10% Poisson noise, so fail only when the rate is
    // significantly below 90% of baseline (rate + 2 standard errors < bar). The plain
    // >= 90% bar over 5 x 60 s runs in the manual `npm run perf:demo`.
    if (KILLS_BASELINE) {
      const upper = killRate + (2 * Math.sqrt(sum('kills'))) / sum('gameSecs');
      expect(upper, `D3a: kill rate ${killRate.toFixed(3)} (+2 SE = ${upper.toFixed(3)}) vs 90% of ${KILLS_BASELINE}`).toBeGreaterThanOrEqual(0.9 * KILLS_BASELINE);
    }
  });
});

