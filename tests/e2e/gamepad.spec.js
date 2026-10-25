import { test, expect, T } from './fixtures.js';
import { LANDED } from '../milestones.js';
import { padMock, padIO, BTN } from './padmock.js';

// M10 Xbox controller in the browser (docs/SPEC.md M10, "Acceptance (Anna)"). The mocked
// pads (tests/e2e/padmock.js, installed before the page loads) serve slot 0 here.
// Skipped until M10 is marked landed in tests/milestones.js.
// The Q1 console guard from fixtures.js applies throughout: any error fails the test.
test.skip(!LANDED.M10, 'M10 not landed (tests/milestones.js)');

// Provisional hook names (Josh, M10). The pad state is top-level let/const in js/gamepad.js,
// which is not a window property, so pages read hooks through window.__h(name) (a global
// eval of the name). If a name changes when M10 lands, change it here only.
const H = { pad: 'pad', aim: 'padAim', stats: 'padStats', device: 'inputDevice', rumble: 'padRumble' };

// ---------------------------------------------------------------------
// Test-side helpers
// ---------------------------------------------------------------------
async function bootWithPad(game, page, { rumble = 'ok', connect = true } = {}) {
  await page.addInitScript(padMock, { rumble });
  await game.boot();
  await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; if (demoState().active) stopDemo(); });
  if (connect) await page.evaluate(() => window.__padConnect(0));
}

/** Start a calm round: no waves, invincible player, no trees or rocks near the player. */
async function arena(game) {
  await game.start();
  await game.freezeWaves();
  await game.eval(() => {
    for (let i = envObjects.length - 1; i >= 0; i--) {
      if (Math.hypot(envObjects[i].x - player.x, envObjects[i].y - player.y) < 800) envObjects.splice(i, 1);
    }
    bullets.length = 0;
  });
}

const padSet = (page, state) => padIO(page, 0, H.pad).set(state);
const frames = (page, n) => page.evaluate((k) => window.__frames(k), n);
const press = (page, b, value = 1) => padIO(page, 0, H.pad).press(b, value);
const release = (page, b) => padIO(page, 0, H.pad).release(b);
const sticks = (page, lx, ly, rx = 0, ry = 0) => padIO(page, 0, H.pad).sticks(lx, ly, rx, ry);

/** padAim relative to the player: distance, world angle and on-screen angle. */
const aimInfo = (game) => game.eval((name) => {
  const a = window.__h(name), dx = a.x - player.x, dy = a.y - player.y, s = toScreen(dx, dy);
  return { x: a.x, y: a.y, dirX: a.dirX, dirY: a.dirY, dist: a.dist, has: a.has, d: Math.hypot(dx, dy),
    world: Math.atan2(dy, dx), screen: Math.atan2(s.y, s.x), px: player.x, py: player.y };
}, H.aim);

const DEG = Math.PI / 180;
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

// ---------------------------------------------------------------------
// Move, aim, fire, kill
// ---------------------------------------------------------------------
test('M10: the left stick moves the player in its screen direction; the right stick aims and keeps its direction on release', async ({ game, page }) => {
  await bootWithPad(game, page);
  await arena(game);

  for (const [lx, ly] of [[1, 0], [0, -1]]) {
    const p0 = await game.eval(() => ({ x: player.x, y: player.y }));
    await sticks(page, lx, ly);
    await page.waitForFunction((p) => Math.hypot(player.x - p.x, player.y - p.y) > 40, p0, { timeout: T(10_000) });
    await sticks(page, 0, 0);
    const moved = await game.eval((p) => { const s = toScreen(player.x - p.x, player.y - p.y); return Math.atan2(s.y, s.x); }, p0);
    expect(angDiff(moved, Math.atan2(ly, lx)) / DEG, `stick (${lx}, ${ly}) moves the player that way on screen`).toBeLessThan(8);
  }
  expect(await game.eval((n) => window.__h(n), H.device), 'pad in use').toBe('pad');

  await sticks(page, 0, 0, 0, 1); // right stick down, full tilt
  await page.waitForFunction((n) => {
    const a = window.__h(n), s = toScreen(a.x - player.x, a.y - player.y);
    return a.has && Math.abs(a.dist - 420) < 2 && Math.abs(Math.atan2(s.y, s.x) - Math.PI / 2) < 0.03;
  }, H.aim, { timeout: T(5_000) });
  const held = await aimInfo(game);
  expect(held.d, 'full tilt: 420u').toBeCloseTo(420, 0);
  expect(await game.eval(() => player.aimAngle) - held.world, 'the player aims at padAim').toBeCloseTo(0, 1);

  await sticks(page, 0, 0, 0, 0);
  await game.advance(0.2);
  const rel = await aimInfo(game);
  expect(angDiff(rel.screen, Math.PI / 2) / DEG, 'released: direction kept').toBeLessThan(2);
  expect(rel.d, 'released: 180u').toBeCloseTo(180, 0);
});

test('M10: RT fires along the right-stick aim and kills a stationary enemy', async ({ game, page }) => {
  await bootWithPad(game, page);
  await arena(game);
  await game.eval(() => {
    unlockedWeapons = Math.max(unlockedWeapons, 4);
    player.weapon = 3; // M16: automatic
    player.magAmmo = WEAPONS[3].mag; player.reloading = false; player.fireTimer = 0;
  });
  await sticks(page, 0, 0, 1, 0); // aim screen-right, 420u
  await page.waitForFunction((n) => Math.abs(window.__h(n).dist - 420) < 2, H.aim, { timeout: T(5_000) });
  const a = await aimInfo(game);
  const k0 = await game.eval(([dx, dy]) => {
    const e = spawnEnemy(0, player.x + dx * 250, player.y + dy * 250);
    e.speed = 0; e.vx = 0; e.vy = 0; e.fireTimer = 1e9; e.shieldHp = e.maxShieldHp = 0;
    window.__m10Target = e;
    return kills;
  }, [a.dirX, a.dirY]);

  await press(page, BTN.RT);
  await page.waitForFunction(() => bullets.some((b) => b.owner === 'player'), null, { timeout: T(5_000) });
  await page.waitForFunction((k) => kills > k || window.__m10Target.dead || !enemies.includes(window.__m10Target), k0, { timeout: T(15_000) });
  await release(page, BTN.RT);
  await sticks(page, 0, 0, 0, 0);
  expect(await game.eval(() => kills), 'the enemy in the aim direction was killed').toBeGreaterThan(k0);
});

// ---------------------------------------------------------------------
// B: grenade at the reticle
// ---------------------------------------------------------------------
test('M10: B throws a grenade that lands at the reticle (300u at half tilt; 420u at full)', async ({ game, page }) => {
  await bootWithPad(game, page);
  await arena(game);
  // Record each throw's target and where the grenade first touches down (one frame of travel
  // is the measuring step: the touchdown happens somewhere within the frame that bounces).
  await game.eval(() => {
    window.__throws = [];
    const origThrow = window.throwGrenade, origUpdate = window.updateGrenades;
    window.throwGrenade = function (tx, ty, ...rest) {
      const ok = origThrow.call(this, tx, ty, ...rest);
      if (ok) {
        const rec = { tx, ty, px: player.x, py: player.y, land: null };
        grenades[grenades.length - 1].__m10 = rec;
        window.__throws.push(rec);
      }
      return ok;
    };
    window.updateGrenades = function (dt, ...rest) {
      const prev = grenades.filter((g) => g.__m10 && !g.__m10.land).map((g) => ({ g, x: g.x, y: g.y }));
      origUpdate.call(this, dt, ...rest);
      for (const { g, x, y } of prev) {
        if (g.bounces > 0 || g.inWater || (g.z === 0 && g.vz === 0)) g.__m10.land = { x: g.x, y: g.y, step: Math.hypot(g.x - x, g.y - y) };
      }
    };
  });
  const range = await game.eval(() => CFG.GRENADE_RANGE);

  for (const [rx, want] of [[0.6, 300], [1, Math.min(420, range)]]) {
    await sticks(page, 0, 0, rx, 0);
    await page.waitForFunction(([n, w]) => Math.abs(window.__h(n).dist - w) < 2, [H.aim, want], { timeout: T(5_000) });
    await page.waitForFunction(() => player.grenadeCd <= 0 && player.grenades > 0, null, { timeout: T(5_000) });
    const aim = await aimInfo(game);
    const n0 = await game.eval(() => window.__throws.length);
    await press(page, BTN.B);
    await page.waitForFunction((n) => window.__throws.length > n && window.__throws[n].land, n0, { timeout: T(10_000) });
    await release(page, BTN.B);
    const t = await game.eval((n) => window.__throws[n], n0);
    expect(Math.hypot(t.tx - aim.x, t.ty - aim.y), `thrown at padAim (${want}u)`).toBeLessThan(2);
    expect(Math.hypot(t.land.x - aim.x, t.land.y - aim.y), `lands at the reticle (${want}u)`).toBeLessThan(10 + t.land.step);
    expect(Math.hypot(t.land.x - t.px, t.land.y - t.py), 'within throw range').toBeLessThanOrEqual(range + 10 + t.land.step);
  }
  await sticks(page, 0, 0, 0, 0);
});

// ---------------------------------------------------------------------
// A dodge, Start pause
// ---------------------------------------------------------------------
test('M10: A dodge rolls, once per press', async ({ game, page }) => {
  await bootWithPad(game, page);
  await arena(game);
  await game.eval(() => {
    window.__dodges = 0;
    let was = false;
    const f = () => { const d = !!(player && player.dodging); if (d && !was) window.__dodges++; was = d; requestAnimationFrame(f); };
    requestAnimationFrame(f);
  });
  await press(page, BTN.A);
  await page.waitForFunction(() => window.__dodges === 1, null, { timeout: T(5_000) });
  await game.advance(1.5); // held past DODGE_DURATION + DODGE_COOLDOWN
  expect(await game.eval(() => window.__dodges), 'a held A rolls once').toBe(1);
  await release(page, BTN.A);
  await press(page, BTN.A);
  await page.waitForFunction(() => window.__dodges === 2, null, { timeout: T(5_000) });
  await release(page, BTN.A);
});

test('M10: Start pauses and resumes, once per press', async ({ game, page }) => {
  await bootWithPad(game, page);
  await arena(game);
  await press(page, BTN.START);
  await page.waitForFunction(() => paused === true, null, { timeout: T(5_000) });
  await frames(page, 15);
  expect(await game.eval(() => paused), 'a held Start toggles once').toBe(true);
  await release(page, BTN.START);
  const t0 = await game.eval(() => gameTime);
  await frames(page, 10);
  expect(await game.eval(() => ({ paused, gameTime })), 'still paused; time stopped').toEqual({ paused: true, gameTime: t0 });
  await press(page, BTN.START);
  await page.waitForFunction(() => paused === false, null, { timeout: T(5_000) });
  await release(page, BTN.START);
  await game.advance(0.1);
  expect(await game.eval(() => paused)).toBe(false);
});

// ---------------------------------------------------------------------
// Title and attract mode
// ---------------------------------------------------------------------
test('M10: on the title, pad input resets the idle timer and stops the demo without starting a game; then A starts it', async ({ game, page }) => {
  await bootWithPad(game, page);
  // D1 idle reset
  await page.waitForFunction(() => demoState().idleTimer > 0.5, null, { timeout: T(10_000) });
  const idle = await game.eval(() => demoState().idleTimer);
  await press(page, BTN.X);
  await page.waitForFunction((t) => demoState().idleTimer < t, idle, { timeout: T(5_000) });
  await release(page, BTN.X);

  // A ends the demo (D6: the exit input does not also start a game)
  await game.eval(() => startDemo());
  await page.waitForFunction(() => demoState().active, null, { timeout: T(5_000) });
  await press(page, BTN.A);
  await page.waitForFunction(() => !demoState().active, null, { timeout: T(5_000) });
  await release(page, BTN.A);
  await frames(page, 10);
  expect(await game.eval(() => ({ active: demoState().active, gameStarted })), 'back on the title').toEqual({ active: false, gameStarted: false });
  await expect(page.locator('#start-screen')).toBeVisible();

  // A stick past the deadzone ends it too; one inside the deadzone does not
  await game.eval(() => startDemo());
  await page.waitForFunction(() => demoState().active, null, { timeout: T(5_000) });
  await padSet(page, { axes: [0.12, -0.1, 0.1, 0.15] });
  await page.waitForFunction(() => demoState().elapsed >= 0.5, null, { timeout: T(10_000) });
  expect(await game.eval(() => demoState().active), 'sticks inside the deadzone are not input').toBe(true);
  await sticks(page, 0, 0.6);
  await page.waitForFunction(() => !demoState().active, null, { timeout: T(5_000) });
  await sticks(page, 0, 0);
  await frames(page, 5);
  expect(await game.eval(() => gameStarted), 'the stick does not start a game').toBe(false);

  // A on the title starts the game
  await press(page, BTN.A);
  await page.waitForFunction(() => gameStarted && gameTime > 0.1, null, { timeout: T(10_000) });
  await release(page, BTN.A);
  await expect(page.locator('#start-screen')).toBeHidden();
  expect(await game.eval(() => demoState().active)).toBe(false);
});

test('M10: Start on the title starts the game (and does not also pause it)', async ({ game, page }) => {
  await bootWithPad(game, page);
  await press(page, BTN.START);
  await page.waitForFunction(() => gameStarted && gameTime > 0.1, null, { timeout: T(10_000) });
  await release(page, BTN.START);
  await game.advance(0.2);
  expect(await game.eval(() => ({ gameStarted, paused }))).toEqual({ gameStarted: true, paused: false });
  await expect(page.locator('#start-screen')).toBeHidden();
});

// ---------------------------------------------------------------------
// Hot-plug
// ---------------------------------------------------------------------
async function disconnectMidGame(game, page) {
  await arena(game);
  await page.evaluate(() => window.__padConnect(0));
  await page.waitForFunction(() => /CONTROLLER CONNECTED/.test(window.__screenText()), null, { timeout: T(5_000) });
  const s0 = await game.eval((n) => window.__h(n)(), H.stats);
  expect(s0.connected, 'padStats: connected').toBe(true);
  await sticks(page, 0.6, 0); // the pad is now the device in use
  await sticks(page, 0, 0);
  expect(await game.eval((n) => window.__h(n), H.device)).toBe('pad');
  await page.evaluate(() => window.__padDisconnect(0));
  await page.waitForFunction(() => paused === true, null, { timeout: T(5_000) });
  const s1 = await game.eval((n) => window.__h(n)(), H.stats);
  expect(s1.disconnectPauses, 'padStats().disconnectPauses + 1').toBe(s0.disconnectPauses + 1);
  expect(s1.connected).toBe(false);
  await page.waitForFunction(() => /CONTROLLER DISCONNECTED/.test(window.__screenText()) && /PRESS START/.test(window.__screenText()),
    null, { timeout: T(5_000) });
}

test('M10: hot-plug: connecting shows CONTROLLER CONNECTED; disconnecting the pad in use auto-pauses; Start resumes', async ({ game, page }) => {
  await bootWithPad(game, page, { connect: false });
  await disconnectMidGame(game, page);
  const t0 = await game.eval(() => gameTime);
  await frames(page, 10);
  expect(await game.eval(() => gameTime), 'paused: time stopped').toBe(t0);
  // Plugging back in alone does not resume; Start does
  await page.evaluate(() => window.__padConnect(0));
  await frames(page, 10);
  expect(await game.eval(() => paused), 'reconnecting alone does not resume').toBe(true);
  await press(page, BTN.START);
  await page.waitForFunction(() => paused === false, null, { timeout: T(5_000) });
  await release(page, BTN.START);
  await game.advance(0.1);
  expect(await game.eval(() => /CONTROLLER DISCONNECTED/.test(window.__screenText())), 'overlay gone').toBe(false);
});

test('M10: hot-plug: after a disconnect pause, any key resumes', async ({ game, page }) => {
  await bootWithPad(game, page, { connect: false });
  await disconnectMidGame(game, page);
  await page.keyboard.press('x');
  await page.waitForFunction(() => paused === false, null, { timeout: T(5_000) });
  await game.advance(0.1);
  expect(await game.eval(() => /CONTROLLER DISCONNECTED/.test(window.__screenText())), 'overlay gone').toBe(false);
});

// ---------------------------------------------------------------------
// Rumble
// ---------------------------------------------------------------------
test('M10: rumble: shots and a near explosion call playEffect(dual-rumble) with capped values, at most one per 50 ms', async ({ game, page }) => {
  await bootWithPad(game, page);
  await arena(game);
  await game.eval(() => {
    unlockedWeapons = Math.max(unlockedWeapons, 5);
    player.weapon = 4; // Minigun: a shot every 35 ms once spun up
    player.magAmmo = WEAPONS[4].mag; player.reloading = false; player.fireTimer = 0;
    window.__rumbleCalls.length = 0;
  });
  await press(page, BTN.RT);
  await game.advance(1.0);
  await release(page, BTN.RT);
  const shots = await game.eval(() => window.__rumbleCalls.slice());
  expect(shots.length, 'shots rumble').toBeGreaterThan(2);
  for (let i = 0; i < shots.length; i++) {
    const c = shots[i];
    expect(c.type).toBe('dual-rumble');
    expect(c.weakMagnitude, 'weak motor for shots').toBeGreaterThan(0);
    expect(c.weakMagnitude).toBeLessThanOrEqual(1);
    expect(c.strongMagnitude).toBeGreaterThanOrEqual(0);
    expect(c.strongMagnitude).toBeLessThanOrEqual(1);
    expect(c.duration, 'shot rumble <= 60 ms').toBeLessThanOrEqual(60);
    // Wall clock or game time, whichever the limiter uses (game time never runs ahead of wall
    // time, but where in a frame the effect fires varies by a few ms).
    if (i) expect(Math.max(c.t - shots[i - 1].t, (c.gt - shots[i - 1].gt) * 1000), 'at most one effect per 50 ms').toBeGreaterThanOrEqual(49.5);
  }

  // A near explosion: the strong motor, capped
  await game.advance(0.1); // past the 50 ms window (game time never runs ahead of wall time)
  await game.eval(() => { window.__rumbleCalls.length = 0; spawnExplosion(player.x + 60, player.y, 130, true, SRC_EXPLOSIVE); });
  await game.advance(0.1);
  const boom = await game.eval(() => window.__rumbleCalls.slice());
  expect(boom.some((c) => c.strongMagnitude > 0), 'an explosion 60u away rumbles the strong motor').toBe(true);
  for (const c of boom) {
    expect(c.strongMagnitude).toBeLessThanOrEqual(1);
    expect(c.weakMagnitude).toBeLessThanOrEqual(1);
    expect(c.duration).toBeGreaterThan(0);
    expect(c.duration).toBeLessThanOrEqual(1000);
  }

  // Direct calls: clamped, and a second effect within 50 ms is skipped
  await game.advance(0.1);
  const r = await game.eval((n) => {
    const s0 = window.__h(n.stats)();
    const n0 = window.__rumbleCalls.length;
    const first = window.__h(n.rumble)(5, -3, 1e5);
    const second = window.__h(n.rumble)(0.5, 0.5, 30);
    const s1 = window.__h(n.stats)();
    return { first, second, calls: window.__rumbleCalls.slice(n0), skipped: s1.rumbleSkipped - s0.rumbleSkipped, played: s1.rumblePlayed - s0.rumblePlayed };
  }, H);
  expect(r.first, 'padRumble plays').toBe(true);
  expect(r.second, 'a second effect in the same 50 ms is skipped').toBe(false);
  expect(r.calls.length).toBe(1);
  expect(r.calls[0]).toMatchObject({ type: 'dual-rumble', weakMagnitude: 1, strongMagnitude: 0 });
  expect(r.calls[0].duration, 'duration capped').toBeLessThanOrEqual(1000);
  expect([r.played, r.skipped]).toEqual([1, 1]);
});

for (const kind of ['none', 'throw', 'reject']) {
  const label = { none: 'without vibrationActuator', throw: 'whose playEffect throws', reject: 'whose playEffect rejects' }[kind];
  test(`M10: rumble on a pad ${label} fails silently`, async ({ game, page }) => {
    await bootWithPad(game, page, { rumble: kind });
    await arena(game);
    await game.eval(() => {
      unlockedWeapons = Math.max(unlockedWeapons, 2);
      player.weapon = 1; player.magAmmo = WEAPONS[1].mag; player.reloading = false; player.fireTimer = 0;
    });
    await press(page, BTN.RT);
    await page.waitForFunction(() => bullets.some((b) => b.owner === 'player'), null, { timeout: T(5_000) });
    await game.advance(0.5);
    await release(page, BTN.RT);
    await game.eval(() => spawnExplosion(player.x + 60, player.y, 130, true, SRC_EXPLOSIVE));
    await game.advance(0.2);
    const r = await game.eval((n) => ({ ret: window.__h(n.rumble)(1, 1, 50), stats: window.__h(n.stats)(), calls: window.__rumbleCalls.length }), H);
    if (kind !== 'reject') {
      expect(r.ret, 'padRumble returns false').toBe(false);
      expect(r.stats.rumblePlayed, 'nothing counted as played').toBe(0);
    }
    if (kind === 'none') expect(r.calls).toBe(0);
    // Let any pending promise settle inside the test: an unhandled rejection fails the Q1 guard.
    await frames(page, 10);
  });
}
