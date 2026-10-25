import { test, expect, T } from './fixtures.js';
import { LANDED } from '../milestones.js';
import { padMock, padIO, BTN } from './padmock.js';

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
  hud: 'hudBoxes()', // { p1, p2, minimap }: CSS px rects (K4)
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
  const o = (0, eval)(ex), gr = o && o._spG;
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
  const s = await game.eval(() => ({ d: Math.hypot(players[1].x - players[0].x, players[1].y - players[0].y), hp: players[1].hp }));
  expect(s.d).toBeLessThan(120);
  expect(s.hp).toBe(100);
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
  expect(await game.eval(() => players.map((p) => p.kills))).toEqual([1, 1]);
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

test('K2/C6: P2\'s pad disconnecting auto-pauses with "P2 CONTROLLER DISCONNECTED"; Start on P1\'s pad resumes', async ({ game, page }) => {
  test.skip(!LANDED.K2, 'K2 not landed');
  await boot(game, page);
  await twoPlayers(game, page);
  await page.evaluate(() => window.__padDisconnect(1));
  await page.waitForFunction(() => paused === true, null, { timeout: T(5_000) });
  await page.waitForFunction(() => /P2 CONTROLLER DISCONNECTED/.test(window.__screenText()), null, { timeout: T(5_000) });
  await pad1(page).tap(BTN.START);
  await page.waitForFunction(() => paused === false, null, { timeout: T(5_000) });
  expect(await game.eval(() => players.length), 'P2 stays in the game').toBe(2);
});

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
  await game.eval((h) => window.__h(h)(0.7), H.setZoom);
  await game.advance(0.5);
  const s = await game.eval(() => RETRO.PIXEL_SCALE);
  const p1 = await game.eval(() => ({ x: players[0].x, y: players[0].y }));
  const ei = await dummy(game, p1.x + 220, p1.y - 60);
  await game.advance(0.2);
  // the mapping agrees with what is drawn: the enemy's feet under its sprite
  const m = await game.eval(([h, i]) => { const e = window.__dummies[i]; return window.__h(h)(e.x, e.y); }, [H.w2v, ei]);
  const rect = await drawnRect(game, `window.__dummies[${ei}]`);
  expect(Math.abs(m.x - (rect.x + rect.w / 2)), 'feet x under the drawn sprite').toBeLessThanOrEqual(s + 1);
  expect(m.y, 'feet at the bottom of the drawn sprite').toBeGreaterThan(rect.y + rect.h * 0.6);
  expect(m.y).toBeLessThanOrEqual(rect.y + rect.h + s + 1);
  // T5: the mouse at a CSS point aims at the ground point under it, within 1 low-res px
  for (const [fx, fy] of [[0.3, 0.3], [0.75, 0.6], [0.5, 0.8]]) {
    const pt = await game.eval(([a, b]) => ({ x: Math.round(W * a), y: Math.round(H * b) }), [fx, fy]);
    await page.mouse.move(pt.x, pt.y);
    await game.advance(0.1);
    const r = await game.eval((h2v) => {
      const a = aimPointOf(player, { x: 0, y: 0 });
      return { back: window.__h(h2v)(a.x, a.y) };
    }, H.w2v);
    expect(Math.hypot(r.back.x - pt.x, r.back.y - pt.y), `mouse (${pt.x}, ${pt.y})`).toBeLessThanOrEqual(s);
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
  await page.waitForFunction(() => /HELP!/.test(window.__screenText()), null, { timeout: T(5_000) });
  // P1 walks over with the stick until within revive range
  await pad1(page).sticks(1, -1);
  await page.waitForFunction(() => Math.hypot(players[0].x - players[1].x, players[0].y - players[1].y) < 40, null, { timeout: T(15_000) });
  await pad1(page).sticks(0, 0);
  await page.waitForFunction(() => players[1].state === 'up', null, { timeout: T(10_000) });
  const p2 = await game.eval(() => ({ hp: players[1].hp, maxHp: players[1].maxHp }));
  expect(p2.hp).toBeCloseTo(p2.maxHp * 0.5, 0);
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
