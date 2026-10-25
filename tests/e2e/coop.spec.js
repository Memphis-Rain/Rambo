import { test, expect, T } from './fixtures.js';
import { LANDED } from '../milestones.js';
import { padMock, padIO, BTN } from './padmock.js';
import { FIND_M9_SPOT } from '../perf/m9-load.mjs';

// M11 local 2-player co-op in the browser (docs/SPEC.md M11, "Acceptance (Anna)"). Two mocked
// standard-mapping pads (tests/e2e/padmock.js: slots 0 and 1, hot-plug, a rumble spy per pad)
// plus keyboard+mouse. Drafted against Josh's provisional hooks (H below); each test skips
// until its K flag in tests/milestones.js is true. The Q1 console guard applies throughout.
test.skip(!LANDED.K1, 'M11 K1 not landed (tests/milestones.js)');

// Provisional hook names (Josh, M11), read in the page through window.__h (a global eval).
// If a name changes when a K item lands, change it here only.
const H = {
  state: 'coopState()', // { n, title2P, titleHint, titleCount, devices: [{ kbm, pad }] }
  padOf: (i) => `padOf(${i})`, // per-player pad state (M10 `pad` shape)
  zoom: 'camZoom()', // { zoom, target }
  setZoom: 'setCamZoom', // (z | null)
  w2v: 'worldToView', // (wx, wy) -> CSS px, zoom-aware
  v2w: 'viewToWorld', // (x, y) -> ground point, zoom-aware
  hud: 'hudBoxes()', // { p1, p2, minimap, boss, stats }: CSS px rects (K4)
  rings: 'footRings()', // [{ x, y, visible }] per player, ring centre in CSS px (2P)
};

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
async function boot(game, page, { pads = 2 } = {}) {
  await page.addInitScript(padMock, { rumble: 'ok' });
  await game.boot();
  await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; if (demoState().active) stopDemo(); });
  for (let i = 0; i < pads; i++) await page.evaluate((k) => window.__padConnect(k), i);
}
/** P1's pad (slot 0, polled as P1's) and P2's pad (slot 1, polled as P2's once joined). */
const pad1 = (page) => padIO(page, 0, H.padOf(0));
const pad2 = (page) => padIO(page, 1, H.padOf(1));
/** Before P2 joins there is no padOf(1): drive slot 1 raw and wait on the game's reaction. */
async function rawTap(page, i, b) {
  await page.evaluate(([k, btn]) => window.__padSet(k, { buttons: { [btn]: 1 } }), [i, b]);
  await page.evaluate(() => window.__frames(4));
  await page.evaluate(([k, btn]) => window.__padSet(k, { buttons: { [btn]: 0 } }), [i, b]);
  await page.evaluate(() => window.__frames(4));
}
const frames = (page, n) => page.evaluate((k) => window.__frames(k), n);
const text = (page) => page.evaluate(() => window.__screenText());

/** Start a calm 2P round: P1 used pad 0, P2 joined on pad 1; no waves, both invulnerable, open dry ground. */
async function twoPlayers(game, page) {
  await game.start();
  await game.freezeWaves();
  await game.toLand();
  await pad1(page).sticks(0.6, 0);
  await pad1(page).sticks(0, 0);
  await rawTap(page, 1, BTN.START);
  await page.waitForFunction(() => players.length === 2, null, { timeout: T(5_000) });
  await game.eval(() => {
    for (let i = envObjects.length - 1; i >= 0; i--) {
      if (Math.hypot(envObjects[i].x - player.x, envObjects[i].y - player.y) < 1200) envObjects.splice(i, 1);
    }
    for (const p of players) p.invincible = 1e9;
    bullets.length = 0;
  });
}
/** Both players at offsets from P1's spot, still. */
const placeBoth = (game, d1, d2) => game.eval(([a, b]) => {
  const o = window.__coopHome || (window.__coopHome = { x: players[0].x, y: players[0].y });
  players[0].x = o.x + a.x; players[0].y = o.y + a.y;
  players[1].x = o.x + b.x; players[1].y = o.y + b.y;
  for (const p of players) { p.vx = 0; p.vy = 0; }
}, [d1, d2]);
/** World offset along screen x for `css` CSS px at zoom 1. */
const screenRight = (css) => ({ x: css / 2, y: -css / 2 });
/** A harmless still enemy at (x, y) world. */
const dummy = (game, x, y, hp = 1e9) => game.eval(([ex, ey, h]) => {
  const e = spawnEnemy(0, ex, ey);
  e.vx = 0; e.vy = 0; e.speed = 0; e.fireTimer = 1e9; e.hp = e.maxHp = h; e.shieldHp = e.maxShieldHp = 0;
  (window.__dummies ||= []).push(e);
  return window.__dummies.length - 1;
}, [x, y, hp]);
/** On-screen CSS rect of a world sprite (its Pixi bounds in the low-res RT, times PIXEL_SCALE): zoom-proof. */
const drawnRect = (game, expr) => game.eval((ex) => {
  const o = (0, eval)(ex);
  // players are drawn into _sp.playerG (P1) and _sp.p2G (P2); enemies into their own _spG
  const gr = o === players[0] ? _sp.playerG : o === players[1] ? _sp.p2G : o && o._spG;
  if (!gr || !gr.visible) return null;
  const b = gr.getBounds(), s = RETRO.PIXEL_SCALE;
  return { x: b.minX * s, y: b.minY * s, w: (b.maxX - b.minX) * s, h: (b.maxY - b.minY) * s };
}, expr);
const inView = (r, W, H, m = 0) => r && r.x >= m && r.y >= m && r.x + r.w <= W - m && r.y + r.h <= H - m;
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ---------------------------------------------------------------------
// K1: one player is the old game
// ---------------------------------------------------------------------
test('K1: 1P: players holds exactly one player and player is players[0], through a started round', async ({ game, page }) => {
  await boot(game, page, { pads: 0 });
  await game.start();
  expect(await game.eval(() => ({ n: players.length, same: players[0] === player }))).toEqual({ n: 1, same: true });
  await page.keyboard.down('d');
  await game.advance(0.3);
  await page.keyboard.up('d');
  expect(await game.eval(() => players[0] === player)).toBe(true);
});

// ---------------------------------------------------------------------
// K2: join
// ---------------------------------------------------------------------
test('K2: title: with two pads the title blinks "2P PRESS START"; Start on pad 2 makes it 2P; A on pad 1 starts a 2P game', async ({ game, page }) => {
  test.skip(!LANDED.K2, 'K2 not landed');
  await boot(game, page);
  await page.waitForFunction(() => /2P PRESS START/.test(window.__screenText()), null, { timeout: T(5_000) });
  await pad1(page).sticks(0.6, 0); // P1 uses pad 0 (no demo running, so no game starts)
  await pad1(page).sticks(0, 0);
  await rawTap(page, 1, BTN.START);
  await page.waitForFunction((h) => window.__h(h).titleCount === 2, H.state, { timeout: T(5_000) });
  expect(await game.eval(() => gameStarted), 'P2 joining does not start the game').toBe(false);
  await pad1(page).tap(BTN.A);
  await page.waitForFunction(() => gameStarted && gameTime > 0.1, null, { timeout: T(10_000) });
  expect(await game.eval(() => players.length)).toBe(2);
});

test('K2: title with one pad and kbm says "2P PRESS VIEW ON PAD"; Start/A on that lone pad never join P2', async ({ game, page }) => {
  test.skip(!LANDED.K2, 'K2 not landed');
  await boot(game, page, { pads: 1 });
  await page.waitForFunction(() => /2P PRESS VIEW ON PAD/.test(window.__screenText()), null, { timeout: T(5_000) });
  await padIO(page, 0, 'pad').tap(BTN.START); // M10: starts the game
  await page.waitForFunction(() => gameStarted && gameTime > 0.1, null, { timeout: T(10_000) });
  await padIO(page, 0, 'pad').tap(BTN.A);
  await game.advance(0.3);
  expect(await game.eval(() => players.length), 'Start/A keep their M10 meaning').toBe(1);
});

test('K2: drop-in mid-game: kbm P1 + a pad, View/Back spawns P2 next to P1 with "PLAYER 2 JOINS!"', async ({ game, page }) => {
  test.skip(!LANDED.K2, 'K2 not landed');
  await boot(game, page, { pads: 1 });
  await game.start();
  await game.freezeWaves();
  await game.advance(0.5);
  await rawTap(page, 0, BTN.BACK);
  await page.waitForFunction(() => players.length === 2, null, { timeout: T(5_000) });
  await page.waitForFunction(() => /PLAYER 2 JOINS!/.test(window.__screenText()), null, { timeout: T(5_000) });
  const s = await game.eval(() => ({ d: Math.hypot(players[1].x - players[0].x, players[1].y - players[0].y), hp: players[1].hp, maxHp: players[1].maxHp }));
  expect(s.d).toBeLessThan(120);
  expect(s.hp, 'full health (spec 496fd74)').toBe(s.maxHp);
});

test('K2: both players move, aim and kill independently', async ({ game, page }) => {
  test.skip(!LANDED.K2, 'K2 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  await placeBoth(game, { x: 0, y: 0 }, { x: 0, y: 160 });
  const at = await game.eval(() => players.map((p) => ({ x: p.x, y: p.y })));
  await pad2(page).sticks(1, 0);
  await game.advance(0.4);
  await pad2(page).sticks(0, 0);
  const moved = await game.eval((a) => players.map((p, i) => Math.hypot(p.x - a[i].x, p.y - a[i].y)), at);
  expect(moved[1], 'P2 moved').toBeGreaterThan(40);
  expect(moved[0], 'P1 did not').toBeLessThan(1);

  // each kills an enemy on its own side with its own pad
  const [p1, p2] = await game.eval(() => players.map((p) => ({ x: p.x, y: p.y })));
  const e1 = await dummy(game, p1.x + 200, p1.y - 200, 1);
  const e2 = await dummy(game, p2.x + 200, p2.y - 200, 1);
  await pad1(page).sticks(0, 0, 1, 0);
  await pad2(page).sticks(0, 0, 1, 0);
  await pad1(page).press(BTN.RT);
  await page.waitForFunction((i) => !enemies.includes(window.__dummies[i]), e1, { timeout: T(10_000) });
  await pad1(page).release(BTN.RT);
  expect(await game.eval((i) => enemies.includes(window.__dummies[i]), e2), 'P1 did not kill P2\'s target').toBe(true);
  await pad2(page).press(BTN.RT);
  await page.waitForFunction((i) => !enemies.includes(window.__dummies[i]), e2, { timeout: T(10_000) });
  await pad2(page).release(BTN.RT);
  if (LANDED.K6) expect(await game.eval(() => players.map((p) => p.kills)), 'K6: kills credited to the shooter').toEqual([1, 1]);
});

test('K2/C4: each pad\'s rumble spy sees only its own player\'s events', async ({ game, page }) => {
  test.skip(!LANDED.K2, 'K2 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  await placeBoth(game, { x: 0, y: 0 }, { x: 0, y: 700 });
  await game.eval(() => { window.__rumbleCalls.length = 0; });
  await pad2(page).press(BTN.RT);
  await game.advance(0.5);
  await pad2(page).release(BTN.RT);
  let calls = await game.eval(() => window.__rumbleCalls.slice());
  expect(calls.filter((c) => c.pad === 1).length, 'P2 shots rumble pad 2').toBeGreaterThan(0);
  expect(calls.filter((c) => c.pad === 0).length, 'not pad 1').toBe(0);
  await game.advance(0.1);
  await game.eval(() => { window.__rumbleCalls.length = 0; players[0].invincible = 0; players[0].shield = 0; damagePlayer(5, players[0]); players[0].invincible = 1e9; });
  await game.advance(0.1);
  calls = await game.eval(() => window.__rumbleCalls.slice());
  expect(calls.filter((c) => c.pad === 0).length, 'P1 damage rumbles pad 1').toBeGreaterThan(0);
  expect(calls.filter((c) => c.pad === 1).length).toBe(0);
});

test('K2/C6: P2\'s pad disconnecting auto-pauses with "P2 CONTROLLER DISCONNECTED"; Start on P1\'s pad does not resume (K2.1), a key does', async ({ game, page }) => {
  test.skip(!LANDED.K2, 'K2 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  await page.evaluate(() => window.__padDisconnect(1));
  await page.waitForFunction(() => paused === true, null, { timeout: T(5_000) });
  await page.waitForFunction(() => /P2 CONTROLLER DISCONNECTED/.test(window.__screenText()), null, { timeout: T(5_000) });
  if (LANDED.K2_1) {
    // spec ruling: only P2's pad re-claiming, or a keyboard key, clears P2's disconnect pause
    await pad1(page).tap(BTN.START);
    await frames(page, 10);
    expect(await game.eval(() => paused), 'Start on P1\'s pad does not clear P2\'s disconnect pause').toBe(true);
  }
  await page.keyboard.press('x'); // the escape hatch when P2's pad is gone for good
  await page.waitForFunction(() => paused === false, null, { timeout: T(5_000) });
  expect(await game.eval(() => players.length), 'P2 stays in the game').toBe(2);
});

// ---------------------------------------------------------------------
// K2.1 device edge cases (Ralph's K2+K3 review)
// ---------------------------------------------------------------------
test('K2.1: after a View join on the title, body.pad-connected stays on and the pad legend stays visible', async ({ game, page }) => {
  test.skip(!LANDED.K2 || !LANDED.K2_1, 'K2.1 not landed');
  await boot(game, page, { pads: 1 });
  await expect(page.locator('#start-screen .pad-controls')).toBeVisible({ timeout: T(5_000) });
  await rawTap(page, 0, BTN.BACK);
  await page.waitForFunction((h) => window.__h(h).titleCount === 2, H.state, { timeout: T(5_000) });
  await frames(page, 30);
  expect(await page.evaluate(() => document.body.classList.contains('pad-connected')), 'body.pad-connected').toBe(true);
  await expect(page.locator('#start-screen .pad-controls'), 'pad legend').toBeVisible();
  await expect(page.locator('#start-screen .kbm-controls')).toBeHidden();
});

test('K2.1: navigator.getGamepads() is called once per frame (title, 1P, 2P)', async ({ game, page }) => {
  test.skip(!LANDED.K2 || !LANDED.K2_1, 'K2.1 not landed');
  await boot(game, page);
  // calls per display frame over 60 frames: rAF ticks and the game's ticker are the same frames
  const perFrame = () => page.evaluate(() => new Promise((done) => {
    const c0 = window.__gpCalls;
    let n = 0;
    const f = () => (++n >= 60 ? done((window.__gpCalls - c0) / n) : requestAnimationFrame(f));
    requestAnimationFrame(f);
  }));
  const title = await perFrame();
  await game.start();
  await game.freezeWaves();
  const one = await perFrame();
  await rawTap(page, 1, BTN.START);
  await page.waitForFunction(() => players.length === 2, null, { timeout: T(5_000) });
  const two = await perFrame();
  for (const [k, v] of [['title', title], ['1P', one], ['2P', two]]) {
    expect(v, `${k}: getGamepads calls per frame`).toBeGreaterThan(0.9);
    expect(v, `${k}: getGamepads calls per frame`).toBeLessThan(1.1);
  }
});

test('K2.1: P2\'s muzzle flash belongs to P2 (drawn at P2\'s gun) even with P1 within 40u', async ({ game, page }) => {
  test.skip(!LANDED.K2 || !LANDED.K2_1, 'K2.1 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  await placeBoth(game, { x: 0, y: 0 }, { x: 25, y: 10 });
  // Record each flash's owner: the renderer snaps an ownerless player flash to P1's gun tip when
  // P1 is within 40u, so P2's flashes must carry P2.
  await game.eval(() => {
    window.__flashes = [];
    const orig = window.spawnMuzzleFlash;
    window.spawnMuzzleFlash = function (x, y, angle, scale, z, owner, ...rest) {
      window.__flashes.push({ owner: players.indexOf(owner), x, y });
      return orig.call(this, x, y, angle, scale, z, owner, ...rest);
    };
    unlockedWeapons = Math.max(unlockedWeapons, 4);
    players[1].weapon = 3; players[1].magAmmo = WEAPONS[3].mag; players[1].reloading = false; players[1].fireTimer = 0;
  });
  await pad2(page).sticks(0, 0, 1, 0);
  await pad2(page).press(BTN.RT);
  await game.advance(0.4);
  await pad2(page).release(BTN.RT);
  const f = await game.eval(() => window.__flashes.slice());
  expect(f.length, 'P2 fired').toBeGreaterThan(0);
  expect(f.map((q) => q.owner), 'every flash owned by P2 (index 1)').toEqual(f.map(() => 1));
});

test('K2.1/K3a: a fast zoom-out 1 -> 0.6 has no frame over 16.7 ms on terrain bakes (soft on SwiftShader; logged)', { tag: '@perf' }, async ({ game, page }, testInfo) => {
  test.skip(!LANDED.K2 || !LANDED.K2_1, 'K2.1 not landed');
  test.setTimeout(T(120_000));
  await boot(game, page);
  await twoPlayers(game, page);
  await game.advance(1); // chunks around the start baked at zoom 1
  const sample = (secs) => page.evaluate((s) => new Promise((done) => {
    const xs = [], t0 = gameTime;
    const f = () => { xs.push(perfLog.totalCpuMs); if (gameTime - t0 < s) requestAnimationFrame(f); else done(xs); };
    requestAnimationFrame(f);
  }), secs);
  const stat = (xs) => { const s = xs.slice().sort((a, b) => a - b); return { n: s.length, median: s[s.length >> 1], max: s[s.length - 1], over: s.filter((x) => x > 16.7).length }; };
  // (a) forced: one step from 1 to 0.6
  await game.eval(() => setCamZoom(0.6));
  const forced = stat(await sample(1.5));
  await game.eval(() => setCamZoom(null));
  await placeBoth(game, { x: 0, y: 0 }, { x: 40, y: 0 });
  await page.waitForFunction(() => camZoom().zoom === 1, null, { timeout: T(15_000) });
  // (b) by the players: P2 thrown far away, the camera zooms out at 3/s into unbaked ground
  const vw = await game.eval(() => W);
  await placeBoth(game, { x: 0, y: 0 }, screenRight(vw * 2));
  const apart = stat(await sample(1.5));
  const summary = `forced 1->0.6: ${JSON.stringify(forced)}; players apart: ${JSON.stringify(apart)} (totalCpuMs)`;
  testInfo.annotations.push({ type: 'zoom-out frames', description: summary });
  console.log(`[K2.1 zoom-out] ${summary}`);
  expect(forced.n).toBeGreaterThan(10);
  if (!process.env.CI) {
    expect.soft(forced.max, 'forced zoom-out: no frame over 16.7 ms (soft, SwiftShader)').toBeLessThanOrEqual(16.7);
    expect.soft(apart.max, 'players apart: no frame over 16.7 ms (soft, SwiftShader)').toBeLessThanOrEqual(16.7);
  }
});

// ---------------------------------------------------------------------
// K2.2 (Ralph's review of 36c8ebd)
// ---------------------------------------------------------------------
test('K2.2: after a title View join, unplugging that pad clears body.pad-connected and hides the pad legend', async ({ game, page }) => {
  test.skip(!LANDED.K2_2, 'K2.2 not landed');
  await boot(game, page, { pads: 1 });
  await rawTap(page, 0, BTN.BACK);
  await page.waitForFunction((h) => window.__h(h).titleCount === 2, H.state, { timeout: T(5_000) });
  await expect(page.locator('#start-screen .pad-controls')).toBeVisible();
  await page.evaluate(() => window.__padDisconnect(0));
  await page.waitForFunction(() => !document.body.classList.contains('pad-connected'), null, { timeout: T(5_000) });
  await expect(page.locator('#start-screen .pad-controls'), 'pad legend hidden').toBeHidden();
  await expect(page.locator('#start-screen .kbm-controls'), 'keyboard legend back').toBeVisible();
});

test('K2.2: a downed player\'s foot ring is hidden or follows them while the camera pans; it never stays at the old screen spot', async ({ game, page }) => {
  test.skip(!LANDED.K2_2, 'K2.2 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  await placeBoth(game, { x: 0, y: 0 }, { x: 150, y: 0 });
  await game.advance(0.3);
  await game.eval(() => { const p = players[1]; p.invincible = 0; p.shield = 0; damagePlayer(p.hp + 10, p); });
  expect(await game.eval(() => players[1].state)).toBe('down');
  // P1 walks away so the camera pans; each frame, P2's ring must be hidden or at P2's feet
  await pad1(page).sticks(-1, 0);
  const bad = await page.evaluate(([ringsH, w2v]) => new Promise((done) => {
    const out = [];
    let n = 0;
    const f = () => {
      const r = window.__h(ringsH)[1], at = window.__h(w2v)(players[1].x, players[1].y);
      if (r && r.visible && Math.hypot(r.x - at.x, r.y - at.y) > 2 * RETRO.PIXEL_SCALE) out.push({ n, ring: { x: r.x, y: r.y }, feet: at });
      if (++n < 60) requestAnimationFrame(f); else done(out);
    };
    requestAnimationFrame(f);
  }), [H.rings, H.w2v]);
  await pad1(page).sticks(0, 0);
  expect(await game.eval(() => camZoom().zoom), 'sanity').toBeGreaterThan(0);
  expect(bad, `frames where P2's visible ring was off P2's feet: ${JSON.stringify(bad.slice(0, 3))}`).toEqual([]);
});

test('K2.2: chained disconnect pauses: after a double drop P1 re-claims, the P2 pause shows; a keyboard key clears all of them', async ({ game, page }) => {
  test.skip(!LANDED.K2_2, 'K2.2 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  await page.evaluate(() => { window.__padDisconnect(0); window.__padDisconnect(1); });
  await page.waitForFunction(() => paused === true, null, { timeout: T(5_000) });
  await page.evaluate(() => window.__padConnect(0));
  await pad1(page).tap(BTN.START);
  await page.waitForFunction(() => /P2 CONTROLLER DISCONNECTED/.test(window.__screenText()), null, { timeout: T(5_000) });
  expect(await game.eval(() => ({ paused, who: padState().disconnectWho }))).toEqual({ paused: true, who: 2 });
  await page.keyboard.press('x');
  await page.waitForFunction(() => paused === false, null, { timeout: T(5_000) });
  await frames(page, 20);
  expect(await game.eval(() => ({ paused, dc: padState().disconnectPaused })), 'a key clears every pause; none comes back').toEqual({ paused: false, dc: false });
});

// ---------------------------------------------------------------------
// K2.4: at zoom 1 terrain takes the main path exactly (W5 regression: the pond drew as land)
// ---------------------------------------------------------------------
for (const mode of ['1P', '2P']) {
  test(`K2.4 (${mode}): after a camera jump at zoom 1 no placeholder diamond is ever visible`, async ({ game, page }) => {
    test.skip(!LANDED.K2_4, 'K2.4 not landed');
    await boot(game, page, { pads: mode === '2P' ? 2 : 0 });
    if (mode === '2P') await twoPlayers(game, page);
    else { await game.start(); await game.freezeWaves(); }
    // A far spot (a fresh, unbaked area)
    const site = await game.eval(FIND_M9_SPOT);
    expect(site, 'a dry spot beside a pond').toBeTruthy();
    // Jump: everyone and the camera at once, then watch every frame
    const r = await page.evaluate(({ spot, pond }) => new Promise((done) => {
      for (const p of players) { p.x = spot.x + (p === players[0] ? 0 : 40); p.y = spot.y; p.vx = 0; p.vy = 0; }
      const s = toScreen(spot.x, spot.y);
      cam.x = cam.tx = s.x; cam.y = cam.ty = s.y;
      // pixi-terrain.js keeps the placeholder diamonds in a top-level Map (_chunkPh, K2.1)
      const map = (() => { try { return (0, eval)('_chunkPh'); } catch { return null; } })();
      const ph = () => (map ? [...map.values()].filter((gr) => gr.visible !== false && gr.parent).length : 0);
      const out = { frames: 0, phFrames: 0, maxPh: 0, zooms: new Set() };
      const f = () => {
        const n = ph();
        if (n) { out.phFrames++; out.maxPh = Math.max(out.maxPh, n); }
        out.zooms.add(camZoom().zoom);
        if (++out.frames < 60) requestAnimationFrame(f); else done({ ...out, zooms: [...out.zooms] });
      };
      requestAnimationFrame(f);
    }), site);
    expect(r.zooms, 'zoom stayed exactly 1').toEqual([1]);
    expect(r.phFrames, `frames with a visible placeholder (max ${r.maxPh})`).toBe(0);
    // The colour side of the regression (the pond drawn as land) is gated by the W5 kills test
    // (m9.spec.js), whose tile sampling is proven on main: repeat it x8 on every K2.4 candidate.
  });
}

// ---------------------------------------------------------------------
// K3: shared camera, zoom, leash
// ---------------------------------------------------------------------
test('K3a: far apart -> zoom < 1 with both players drawn on screen; back together -> zoom exactly 1.0', async ({ game, page }) => {
  test.skip(!LANDED.K3, 'K3 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  const vw = await game.eval(() => W);
  const r = screenRight(vw * 0.9);
  await placeBoth(game, { x: 0, y: 0 }, r);
  await game.advance(2);
  const z = await game.eval((h) => window.__h(h), H.zoom);
  expect(z.zoom).toBeLessThan(1);
  const view = await game.eval(() => ({ W, H, s: RETRO.PIXEL_SCALE }));
  for (const i of [0, 1]) {
    const rect = await drawnRect(game, `players[${i}]`);
    expect(inView(rect, view.W, view.H, 0), `P${i + 1} drawn inside the view: ${JSON.stringify(rect)}`).toBe(true);
  }
  await placeBoth(game, { x: 0, y: 0 }, { x: 40, y: 0 });
  await page.waitForFunction((h) => window.__h(h).zoom === 1, H.zoom, { timeout: T(15_000) });
  expect(await game.eval((h) => window.__h(h), H.zoom)).toMatchObject({ zoom: 1, target: 1 });
});

test('K3a: at zoom 0.7 mouse aim lands within 1 low-res px (T5) and worldToView matches the drawn sprites', async ({ game, page }) => {
  test.skip(!LANDED.K3, 'K3 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  await placeBoth(game, { x: 0, y: 0 }, { x: 60, y: 0 });
  await game.eval((h) => window.__h(h)(1), H.setZoom);
  await game.advance(0.3);
  const s = await game.eval(() => RETRO.PIXEL_SCALE);
  const p1 = await game.eval(() => ({ x: players[0].x, y: players[0].y }));
  const ei = await dummy(game, p1.x + 220, p1.y - 60);
  // The mapping agrees with what is drawn: the enemy's feet (worldToView) sit at the same place
  // in its drawn sprite at zoom 1 and 0.7, i.e. the feet-to-sprite-corner offsets and the sprite
  // size all scale by the zoom (the sprite need not be centred on its feet).
  const layout = async () => {
    await game.advance(0.2);
    const m = await game.eval(([h, i]) => { const e = window.__dummies[i]; return window.__h(h)(e.x, e.y); }, [H.w2v, ei]);
    const r = await drawnRect(game, `window.__dummies[${ei}]`);
    return { dx: m.x - r.x, dy: r.y + r.h - m.y, w: r.w, h: r.h };
  };
  const at1 = await layout();
  await game.eval((h) => window.__h(h)(0.7), H.setZoom);
  const at07 = await layout();
  for (const k of ['dx', 'dy', 'w', 'h']) {
    expect(Math.abs(at07[k] - 0.7 * at1[k]), `${k}: ${at07[k].toFixed(1)} at 0.7 vs ${at1[k].toFixed(1)} at 1`).toBeLessThanOrEqual(s + 1);
  }
  // T5: the mouse at a CSS point aims P1 (kbm) at the ground point under it, within 1 low-res
  // px. No enemies, so the G13 pick can't swap the ground point for an enemy's centre.
  await game.eval(() => { enemies.length = 0; });
  for (const [fx, fy] of [[0.3, 0.3], [0.75, 0.6], [0.5, 0.8]]) {
    const pt = await game.eval(([a, b]) => ({ x: Math.round(W * a), y: Math.round(H * b) }), [fx, fy]);
    await page.mouse.move(pt.x, pt.y);
    await game.advance(0.1);
    const r = await game.eval(([h2v, v2w, q]) => {
      const back = window.__h(h2v)(mouseWorldX, mouseWorldY), w = window.__h(v2w)(q.x, q.y);
      return { back, w, mw: { x: mouseWorldX, y: mouseWorldY }, aim: player.aimAngle, want: Math.atan2(mouseWorldY - player.y, mouseWorldX - player.x) };
    }, [H.w2v, H.v2w, pt]);
    expect(Math.hypot(r.back.x - pt.x, r.back.y - pt.y), `mouse (${pt.x}, ${pt.y}): worldToView(aim ground point)`).toBeLessThanOrEqual(s);
    // 1 low-res px is <= s / zoom world units across, (s / zoom) / (2 ISO_SCALE) down
    expect(Math.abs(r.w.x - r.mw.x), `mouse (${pt.x}, ${pt.y}): viewToWorld x`).toBeLessThanOrEqual(s / 0.7 + 0.5);
    expect(Math.abs(r.w.y - r.mw.y), `mouse (${pt.x}, ${pt.y}): viewToWorld y`).toBeLessThanOrEqual(s / 0.7 + 0.5);
    expect(Math.abs(r.aim - r.want), 'P1 aims at it').toBeLessThan(0.05);
  }
  await game.eval((h) => window.__h(h)(null), H.setZoom);
});

test('K3a: at zoom 0.7 a G13 headshot pick on the drawn head picks that enemy', async ({ game, page }) => {
  test.skip(!LANDED.K3, 'K3 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  await placeBoth(game, { x: 0, y: 0 }, { x: 60, y: 0 });
  await game.eval((h) => window.__h(h)(0.7), H.setZoom);
  const p1 = await game.eval(() => ({ x: players[0].x, y: players[0].y }));
  const ei = await dummy(game, p1.x + 260, p1.y - 40);
  await game.advance(0.4);
  const rect = await drawnRect(game, `window.__dummies[${ei}]`);
  const head = { x: rect.x + rect.w / 2, y: rect.y + rect.h * 0.15 };
  await page.mouse.move(head.x, head.y);
  await game.advance(0.1);
  // the pick is made from the mouse each frame (G13)
  const picked = await game.eval((i) => (typeof _aimPicked !== 'undefined' ? _aimPicked === window.__dummies[i] : null), ei);
  expect(picked, `head at (${head.x.toFixed(0)}, ${head.y.toFixed(0)}) picks the enemy`).toBe(true);
  await game.eval((h) => window.__h(h)(null), H.setZoom);
});

test('K3a: at zoom 0.6 the world reaches every view edge (no blank or unloaded areas)', async ({ game, page }) => {
  test.skip(!LANDED.K3, 'K3 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  await game.eval((h) => window.__h(h)(0.6), H.setZoom);
  // run around so chunk streaming has to keep up at the wider view
  await pad1(page).sticks(1, 0.3);
  await pad2(page).sticks(1, 0.3);
  await game.advance(3);
  await pad1(page).sticks(0, 0);
  await pad2(page).sticks(0, 0);
  await game.advance(0.3);
  const r = await game.eval(() => {
    const { pixels, width, height } = app.renderer.extract.pixels({ target: app.stage, frame: new PIXI.Rectangle(0, 0, W, H) });
    const bg = app.renderer.background.color.toNumber();
    const strips = { top: [0.35, 0.65, 0.01, 0.03], bottom: [0.35, 0.65, 0.97, 0.99], left: [0.005, 0.02, 0.35, 0.65], right: [0.98, 0.995, 0.35, 0.65] };
    const out = {};
    for (const [k, [x0, x1, y0, y1]] of Object.entries(strips)) {
      let n = 0, blank = 0;
      for (let y = Math.floor(height * y0); y < height * y1; y++) {
        for (let x = Math.floor(width * x0); x < width * x1; x++) {
          const i = (y * width + x) * 4, c = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
          n++; if (c === bg || pixels[i + 3] === 0) blank++;
        }
      }
      out[k] = blank / n;
    }
    return out;
  });
  for (const [k, f] of Object.entries(r)) expect(f, `${k} edge blank fraction`).toBeLessThan(0.01);
  await game.eval((h) => window.__h(h)(null), H.setZoom);
});

test('K3a: world-anchored texts (score pop, damage number) keep their zoom-1 pixel size at zoom 0.6', async ({ game, page }) => {
  test.skip(!LANDED.K3, 'K3 not landed');
  await boot(game, page);
  await game.start();
  await game.freezeWaves();
  await game.toLand();
  // P2 via coopJoin on the plugged-in pad 1 (no join press needed for the camera)
  await game.eval(() => { coopJoin(1); for (const p of players) p.invincible = 1e9; });
  // All world text goes into one Graphics (_sp.textG, pixi-sprites.js _spRenderTexts), so with
  // exactly one text alive its bounds are that text's drawn rect (x PIXEL_SCALE = CSS px).
  const textRect = async (kind, z) => {
    await game.eval(([k, zz]) => {
      setCamZoom(zz);
      dmgNumbers.length = 0; floatingTexts.length = 0; enemies.length = 0;
      const p = players[0];
      if (k === 'pop') floatingTexts.push({ x: p.x + 40, y: p.y - 40, text: '+81', life: 30, maxLife: 30, color: '#ff0', size: 14 });
      else dmgNumbers.push({ owner: null, x: p.x + 40, y: p.y - 40, z: 20, vx: 0, vy: 0, vz: 0, value: 81, kind: DMG_NORMAL, life: 30, maxLife: 30, age: 1 });
    }, [kind, z]);
    await frames(page, 3);
    return game.eval(() => {
      const b = _sp.textG.getBounds(), s = RETRO.PIXEL_SCALE;
      return { w: (b.maxX - b.minX) * s, h: (b.maxY - b.minY) * s, s };
    });
  };
  for (const kind of ['pop', 'dmg']) {
    const one = await textRect(kind, 1);
    const far = await textRect(kind, 0.6);
    expect(one.w, `${kind}: drawn at zoom 1`).toBeGreaterThan(0);
    expect(Math.abs(far.w - one.w), `${kind}: width at 0.6 ${far.w} vs 1 ${one.w}`).toBeLessThanOrEqual(one.s);
    expect(Math.abs(far.h - one.h), `${kind}: height at 0.6 ${far.h} vs 1 ${one.h}`).toBeLessThanOrEqual(one.s);
  }
  await game.eval(() => { setCamZoom(null); dmgNumbers.length = 0; floatingTexts.length = 0; });
});

test('K3a: the HUD is not zoomed: HUD panel boxes are identical at zoom 1 and 0.7', async ({ game, page }) => {
  test.skip(!LANDED.K3 || !LANDED.K4, 'K3 + K4 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  await placeBoth(game, { x: 0, y: 0 }, { x: 40, y: 0 });
  await game.advance(0.5);
  const a = await game.eval((h) => window.__h(h), H.hud);
  await game.eval((h) => window.__h(h)(0.7), H.setZoom);
  await game.advance(0.5);
  const b = await game.eval((h) => window.__h(h), H.hud);
  expect(b).toEqual(a);
  await game.eval((h) => window.__h(h)(null), H.setZoom);
});

test('K3b: at the minimum zoom neither player can leave the screen', async ({ game, page }) => {
  test.skip(!LANDED.K3, 'K3 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  await placeBoth(game, { x: 0, y: 0 }, { x: 40, y: -40 });
  await pad1(page).sticks(-1, 0);
  await pad2(page).sticks(1, 0);
  await game.advance(6);
  const z = await game.eval((h) => window.__h(h), H.zoom);
  expect(z.zoom).toBeCloseTo(await game.eval(() => CFG.COOP_ZOOM_MIN), 2);
  const view = await game.eval(() => ({ W, H, s: RETRO.PIXEL_SCALE }));
  for (const i of [0, 1]) {
    const rect = await drawnRect(game, `players[${i}]`);
    expect(inView(rect, view.W, view.H, 40 * view.s), `P${i + 1} at least ~48 low-res px inside: ${JSON.stringify(rect)}`).toBe(true);
  }
  await pad1(page).sticks(0, 0);
  await pad2(page).sticks(0, 0);
});

// ---------------------------------------------------------------------
// K5/K6: rules
// ---------------------------------------------------------------------
test('K6: an enemy chases the nearer player', async ({ game, page }) => {
  test.skip(!LANDED.K6, 'K6 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  await placeBoth(game, { x: 0, y: 0 }, { x: 500, y: 500 });
  const p2 = await game.eval(() => ({ x: players[1].x, y: players[1].y }));
  const ei = await dummy(game, p2.x + 150, p2.y);
  await game.eval((i) => { window.__dummies[i].speed = 60; }, ei);
  await game.advance(2);
  const r = await game.eval((i) => { const e = window.__dummies[i]; return { t: players.indexOf(e.target), d2: Math.hypot(e.x - players[1].x, e.y - players[1].y) }; }, ei);
  expect(r.t).toBe(1);
  expect(r.d2, 'closing on P2').toBeLessThan(150);
});

test('K5: P2 goes down ("HELP!"), P1 stands next to them and revives them', async ({ game, page }) => {
  test.skip(!LANDED.K5, 'K5 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  await placeBoth(game, { x: 0, y: 0 }, { x: 300, y: 0 });
  await game.eval(() => { const p = players[1]; p.invincible = 0; p.shield = 0; damagePlayer(p.hp + 10, p); });
  expect(await game.eval(() => players[1].state)).toBe('down');
  if (LANDED.K5LOOK) await page.waitForFunction(() => /HELP!/.test(window.__screenText()), null, { timeout: T(5_000) });
  // P1 walks over with the stick until within revive range
  const dir = await game.eval(() => { const s = toScreen(players[1].x - players[0].x, players[1].y - players[0].y), d = Math.hypot(s.x, s.y); return { x: s.x / d, y: s.y / d }; });
  await pad1(page).sticks(dir.x, dir.y); // the left stick is in screen space (M10)
  await page.waitForFunction(() => Math.hypot(players[0].x - players[1].x, players[0].y - players[1].y) < 40, null, { timeout: T(15_000) });
  await pad1(page).sticks(0, 0);
  await page.waitForFunction(() => players[1].state === 'up', null, { timeout: T(10_000) });
  const p2 = await game.eval(() => ({ hp: players[1].hp, maxHp: players[1].maxHp }));
  expect(p2.hp, 'back at 50% of maxHp (plus regen since the revive)').toBeGreaterThanOrEqual(p2.maxHp * 0.5);
  expect(p2.hp).toBeLessThan(p2.maxHp * 0.5 + 10);
});

test('K5: both down -> TEAM SECOND WIND: both stand at 30% HP, 2 s invulnerable, and the game continues', async ({ game, page }) => {
  test.skip(!LANDED.K5, 'K5 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  await placeBoth(game, { x: 0, y: 0 }, { x: 300, y: 0 });
  const r = await game.eval(() => {
    for (const p of [players[1], players[0]]) { p.invincible = 0; p.shield = 0; damagePlayer(p.hp + 10, p); }
    return players.map((p) => ({ state: p.state, hp: p.hp / p.maxHp, inv: p.invincible }));
  });
  for (const p of r) expect(p).toEqual({ state: 'up', hp: 0.3, inv: 2 });
  await page.waitForFunction(() => /TEAM SECOND WIND!/.test(window.__screenText()), null, { timeout: T(5_000) });
  const t0 = await game.eval(() => gameTime);
  await frames(page, 20);
  expect(await game.eval(() => ({ paused, gameStarted, later: gameTime }))).toMatchObject({ paused: false, gameStarted: true });
  expect(await game.eval(() => gameTime)).toBeGreaterThan(t0);
});

// ---------------------------------------------------------------------
// K4: HUD fit
// ---------------------------------------------------------------------
/** F6 cycles PIXEL_SCALE (R6), as in game.spec.js. */
async function setPixelScale(game, target) {
  for (let i = 0; i < 4; i++) {
    if ((await game.eval(() => retroState().scale)) === target) return;
    await game.page.keyboard.press('F6');
  }
  expect(await game.eval(() => retroState().scale)).toBe(target);
}

test('K4: the low-HP vignette follows the lowest HP among STANDING players (a downed one shows its HELP ring instead)', async ({ game, page }) => {
  test.skip(!LANDED.K4 || !LANDED.K5, 'K4 + K5 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  await placeBoth(game, { x: 0, y: 0 }, { x: 200, y: 0 });
  const vignette = async (hp1, hp2, downP2 = false) => {
    await game.eval(([a, b, d]) => {
      players[0].hp = players[0].maxHp * a;
      if (d) { const p = players[1]; p.invincible = 0; p.shield = 0; damagePlayer(p.hp + 10, p); p.invincible = 1e9; } else players[1].hp = players[1].maxHp * b;
    }, [hp1, hp2, downP2]);
    await frames(page, 4);
    return game.eval(() => hudElements.vignetteGraphics.visible);
  };
  expect(await vignette(1, 1), 'both healthy: no vignette').toBe(false);
  expect(await vignette(1, 0.1), 'P2 standing at 10%: vignette').toBe(true);
  expect(await vignette(0.1, 1), 'P1 at 10%: vignette').toBe(true);
  expect(await vignette(1, 0, true), 'P2 DOWN, P1 healthy: no vignette').toBe(false);
  expect(await game.eval(() => players[1].state)).toBe('down');
});

test('K4: P2 reads apart from P1: P2\'s light vest is clearly brighter than P1\'s dark top (x1, x3, zoom 0.6)', async ({ game, page }) => {
  test.skip(!LANDED.K4, 'K4 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  await game.eval(() => { RETRO.DITHER = false; RETRO.CRT = false; if (typeof _applyRetroToggles === 'function') _applyRetroToggles(); });
  await placeBoth(game, { x: 0, y: 0 }, { x: 70, y: -70 });
  // mean luma of the torso band (25-60% down the drawn sprite) of each player
  const torso = () => game.eval(() => {
    const out = [];
    const { pixels, width } = app.renderer.extract.pixels({ target: app.stage, frame: new PIXI.Rectangle(0, 0, W, H) });
    for (const gr of [_sp.playerG, _sp.p2G]) {
      const b = gr.getBounds(), s = RETRO.PIXEL_SCALE;
      const x0 = Math.round(b.minX * s), x1 = Math.round(b.maxX * s), y0 = Math.round((b.minY + (b.maxY - b.minY) * 0.25) * s), y1 = Math.round((b.minY + (b.maxY - b.minY) * 0.6) * s);
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0 + Math.round((x1 - x0) * 0.3); x < x1 - Math.round((x1 - x0) * 0.3); x++) {
        const i = (y * width + x) * 4;
        sum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]; n++;
      }
      out.push(n ? sum / n : NaN);
    }
    return out;
  });
  for (const [scale, zoom] of [[1, 1], [3, 1], [3, 0.6]]) {
    await setPixelScale(game, scale);
    await game.eval((z) => setCamZoom(z), zoom);
    await game.advance(0.4);
    const [l1, l2] = await torso();
    expect(l2 - l1, `x${scale} zoom ${zoom}: torso luma P1 ${l1.toFixed(1)} vs P2 ${l2.toFixed(1)}`).toBeGreaterThan(20);
  }
  await game.eval(() => setCamZoom(null));
});

test('K4: the boss bar does not overlap the stats box at 800x600 (1P and 2P)', async ({ game, page }) => {
  test.skip(!LANDED.K4, 'K4 not landed');
  await page.setViewportSize({ width: 800, height: 600 });
  await boot(game, page);
  await game.start();
  await game.freezeWaves();
  await game.eval(() => { spawnBoss(3); bossActive = true; });
  await game.advance(0.5);
  let b = await game.eval((h) => window.__h(h), H.hud);
  expect(b.boss, `1P: boss bar box ${JSON.stringify(b.boss)}`).toBeTruthy();
  expect(overlap(b.boss, b.stats), `1P: boss ${JSON.stringify(b.boss)} vs stats ${JSON.stringify(b.stats)}`).toBe(false);
  await rawTap(page, 1, BTN.START);
  await page.waitForFunction(() => players.length === 2, null, { timeout: T(5_000) });
  await game.advance(0.3);
  b = await game.eval((h) => window.__h(h), H.hud);
  for (const k of ['stats', 'p1', 'p2', 'minimap']) {
    expect(overlap(b.boss, b[k]), `2P: boss ${JSON.stringify(b.boss)} vs ${k} ${JSON.stringify(b[k])}`).toBe(false);
  }
});

for (const [vw, vh] of [[800, 600], [1920, 1080]]) {
  test(`K4: the 2P HUD fits at ${vw}x${vh}: P1 panel, P2 panel and minimap inside the view, no overlap`, async ({ game, page }, testInfo) => {
    test.skip(!LANDED.K4, 'K4 not landed');
    await page.setViewportSize({ width: vw, height: vh });
    await boot(game, page);
    await twoPlayers(game, page);
    await game.advance(0.5);
    const b = await game.eval((h) => window.__h(h), H.hud);
    await game.snap(testInfo, `hud-2p-${vw}x${vh}`);
    for (const k of ['p1', 'p2', 'minimap']) expect(inView(b[k], vw, vh), `${k} inside: ${JSON.stringify(b[k])}`).toBe(true);
    expect(overlap(b.p1, b.p2), 'P1/P2 panels').toBe(false);
    expect(overlap(b.p1, b.minimap), 'P1 panel/minimap').toBe(false);
    expect(overlap(b.p2, b.minimap), 'P2 panel/minimap').toBe(false);
    expect(b.p2.x + b.p2.w, 'P2 panel on the right').toBeGreaterThan(vw * 0.6);
    expect(await text(page)).toMatch(/2P/);
  });
}

// ---------------------------------------------------------------------
// K7: 2P attract mode
// ---------------------------------------------------------------------
/** Title with the demo held off and the idle timer reset by a real move (as demo.spec.js bootTitle). */
async function bootTitleIdle(game, page, idleSeconds) {
  await boot(game, page, { pads: 0 });
  await page.mouse.move(5, 5);
  await page.mouse.move(200, 200);
  await page.waitForFunction(() => !demoState().active && demoState().idleTimer < 0.5, null, { timeout: T(5_000) });
  await game.eval((s) => { CFG.DEMO_IDLE_SECONDS = s; }, idleSeconds);
}
const waitDemo = (page, active, ms = 15_000) => page.waitForFunction((a) => demoState().active === a, active, { timeout: T(ms) });

test('K7: idle-timer attract cycles alternate 1P, 2P, 1P; the 2P cycle runs two CPU players with the 2P HUD', async ({ game, page }) => {
  test.skip(!LANDED.K7, 'K7 not landed');
  test.setTimeout(T(120_000));
  await bootTitleIdle(game, page, 1);
  const seen = [];
  for (let cycle = 1; cycle <= 3; cycle++) {
    await waitDemo(page, true);
    await game.advance(0.5);
    const s = await game.eval((h) => ({ demo: demoState().players, n: players.length, hudP2: !!window.__h(h).p2 }), H.hud);
    seen.push(s);
    await page.keyboard.press('x');
    await waitDemo(page, false, 5_000);
  }
  expect(seen.map((s) => s.demo), 'demoState().players per cycle').toEqual([1, 2, 1]);
  expect(seen.map((s) => s.n), 'players.length per cycle').toEqual([1, 2, 1]);
  expect(seen.map((s) => s.hudP2), '2P HUD per cycle').toEqual([false, true, false]);
});

test('K7: a direct startDemo() stays 1P; startDemo({ coop: true }) runs two CPU players that both kill', async ({ game, page }) => {
  test.skip(!LANDED.K7, 'K7 not landed');
  test.setTimeout(T(90_000));
  await bootTitleIdle(game, page, 1e9);
  for (let i = 0; i < 2; i++) {
    await game.eval(() => startDemo());
    await waitDemo(page, true);
    expect(await game.eval(() => ({ d: demoState().players, n: players.length })), `direct startDemo() #${i + 1}`).toEqual({ d: 1, n: 1 });
    await game.eval(() => stopDemo());
    await waitDemo(page, false, 5_000);
  }
  await game.eval(() => startDemo({ coop: true }));
  await waitDemo(page, true);
  expect(await game.eval(() => ({ d: demoState().players, n: players.length }))).toEqual({ d: 2, n: 2 });
  await page.waitForFunction(() => !demoState().active || (players.length === 2 && players[0].kills > 0 && players[1].kills > 0),
    null, { timeout: T(30_000) });
  const k = await game.eval(() => ({ active: demoState().active, kills: players.map((p) => p.kills) }));
  expect(k.active, 'the demo was still running').toBe(true);
  expect(k.kills[0], 'CPU P1 kills').toBeGreaterThan(0);
  expect(k.kills[1], 'CPU P2 kills').toBeGreaterThan(0);
  await game.eval(() => stopDemo());
});

test('K7: TEAM SECOND WIND in a 2P demo ends it (demoOnPlayerDeath), one down does not', async ({ game, page }) => {
  test.skip(!LANDED.K7, 'K7 not landed');
  await bootTitleIdle(game, page, 1e9);
  await game.eval(() => startDemo({ coop: true }));
  await waitDemo(page, true);
  await game.advance(0.5);
  const down = (i) => game.eval((k) => { const p = players[k]; p.invincible = 0; p.dodging = false; p.shield = 0; damagePlayer(p.hp * 10 + 1e4, p); }, i);
  await down(1);
  await game.advance(0.3);
  expect(await game.eval(() => ({ active: demoState().active, st: players[1].state })), 'one CPU player down: the demo goes on').toEqual({ active: true, st: 'down' });
  await down(0);
  await waitDemo(page, false, 5_000);
  await expect(page.locator('#start-screen')).toBeVisible();
});

test('K7/D6: a real game after a 2P demo starts clean: 1P, score 0, kills 0, 1 weapon, zoom 1', async ({ game, page }) => {
  test.skip(!LANDED.K7, 'K7 not landed');
  await bootTitleIdle(game, page, 1e9);
  await game.eval(() => startDemo({ coop: true }));
  await waitDemo(page, true);
  await page.waitForFunction(() => kills > 0, null, { timeout: T(20_000) });
  await game.eval(() => setCamZoom(null));
  await page.keyboard.press('x');
  await waitDemo(page, false, 5_000);
  await game.start();
  const s = await game.eval((h) => ({
    n: players.length, score, kills, unlockedWeapons, zoom: camZoom().zoom, demo: demoState().active,
    hudP2: !!window.__h(h).p2, p1: { score: player.score || 0, kills: player.kills || 0, hp: player.hp, maxHp: player.maxHp, state: player.state },
  }), H.hud);
  expect(s).toMatchObject({ n: 1, score: 0, kills: 0, unlockedWeapons: 1, zoom: 1, demo: false, hudP2: false });
  expect(s.p1).toEqual({ score: 0, kills: 0, hp: s.p1.maxHp, maxHp: s.p1.maxHp, state: 'up' });
});

test('K7 bot revive (spec 0b04d96): with CPU P2 forced DOWN, CPU P1 reaches revive range and revives within 8 s', async ({ game, page }) => {
  test.skip(!LANDED.K7REVIVE, 'K7 bot revive not landed');
  test.setTimeout(T(60_000));
  await bootTitleIdle(game, page, 1e9);
  await game.eval(() => startDemo({ coop: true }));
  await waitDemo(page, true);
  await game.advance(0.5);
  const r = await game.eval(() => {
    const [p1, p2] = players;
    p1.invincible = 1e9; p1.hp = p1.maxHp; // healthy and kept so: the revive, not a death, is under test
    p2.invincible = 0; p2.dodging = false; p2.shield = 0;
    damagePlayer(p2.hp * 10 + 1e4, p2);
    return { st: p2.state, t0: gameTime, d0: Math.hypot(p1.x - p2.x, p1.y - p2.y) };
  });
  expect(r.st).toBe('down');
  await page.waitForFunction(() => !demoState().active || players[1].state !== 'down', null, { timeout: T(30_000) });
  const e = await game.eval((t0) => ({ active: demoState().active, st: players[1].state, secs: gameTime - t0, hp: players[1].hp / players[1].maxHp }), r.t0);
  expect(e.active, 'the demo is still running').toBe(true);
  expect(e.st, `revived, not dead (started ${r.d0.toFixed(0)}u apart)`).toBe('up');
  expect(e.secs, 'within the 8 s down timer').toBeLessThanOrEqual(8);
  expect(e.hp, 'revived at 50% HP').toBeCloseTo(0.5, 1);
});

test('K7 bot revive (spec 0b04d96): CPU P1 under 25% HP does not go for the revive', async ({ game, page }) => {
  test.skip(!LANDED.K7REVIVE, 'K7 bot revive not landed');
  test.setTimeout(T(60_000));
  await bootTitleIdle(game, page, 1e9);
  await game.eval(() => startDemo({ coop: true }));
  await waitDemo(page, true);
  await game.advance(0.5);
  const t0 = await game.eval(() => {
    const [p1, p2] = players;
    p1.invincible = 1e9;
    // under 25%, held there every frame (regen would lift it past 25% within the 8 s)
    const pin = () => { if (!demoState().active) return; players[0].hp = players[0].maxHp * 0.2; requestAnimationFrame(pin); };
    pin();
    // P2 down 300u away, so a revive would need a deliberate walk
    p2.x = p1.x + 300; p2.y = p1.y; p2.invincible = 0; p2.dodging = false; p2.shield = 0;
    damagePlayer(p2.hp * 10 + 1e4, p2);
    return gameTime;
  });
  await page.waitForFunction((t) => !demoState().active || players[1].state !== 'down' || gameTime - t > 8.5, t0, { timeout: T(40_000) });
  const e = await game.eval(() => ({ active: demoState().active, st: players[1].state }));
  expect(e.active).toBe(true);
  expect(e.st, 'not revived: P2 bled out').toBe('dead');
});
