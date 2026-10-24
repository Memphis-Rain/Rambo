import { test, expect, T } from './fixtures.js';
import { LANDED } from '../milestones.js';

// N1 grenades in the browser: the real F key, and the demo bot's throw rule.
test.skip(!LANDED.N1, 'N1 not landed (tests/milestones.js)');

test('N1: a real F keypress throws one grenade toward the cursor, which explodes', async ({ game, page }) => {
  await game.boot();
  await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
  await game.start();
  await game.freezeWaves();
  const { W: w, H: h } = await game.eval(() => ({ W, H }));
  await page.mouse.move(w / 2 + 160, h / 2 + 40);
  await game.advance(0.1);
  const before = await game.eval(() => ({ ammo: player.grenades, stats: grenadeStats() }));
  await page.keyboard.down('f');
  await game.advance(0.7); // held past the cooldown: still one throw
  await page.keyboard.up('f');
  const thrown = await game.eval(() => ({ ammo: player.grenades, live: grenades.length, ground: { x: mouseGroundX, y: mouseGroundY }, p: { x: player.x, y: player.y } }));
  expect(thrown.ammo, 'one grenade used').toBe(before.ammo - 1);
  await page.waitForFunction((n) => grenadeStats().exploded + grenadeStats().geysers > n,
    before.stats.exploded + before.stats.geysers, { timeout: T(10_000) });
  const r = Math.hypot(thrown.ground.x - thrown.p.x, thrown.ground.y - thrown.p.y);
  expect(r, 'the cursor ground point is within throw range').toBeLessThanOrEqual(await game.eval(() => CFG.GRENADE_RANGE) + 1);
});

test('N1: the demo bot throws only at clusters (>= 4 enemies within 140u), from outside 140u, >= 4 s apart', { tag: '@perf' }, async ({ game }, testInfo) => {
  test.setTimeout(T(240_000));
  await game.boot();
  await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; CFG.DEMO_MAX_SECONDS = 1e9; });
  await game.eval(() => {
    window.__throws = [];
    const orig = window.throwGrenade;
    window.throwGrenade = function (tx, ty, ...rest) {
      const ok = orig.call(this, tx, ty, ...rest);
      if (ok && demoState().active) {
        const near = enemies.filter((e) => !e.dead && Math.hypot(e.x - tx, e.y - ty) <= 140).length;
        window.__throws.push({ t: gameTime, tx, ty, px: player.x, py: player.y, near });
      }
      return ok;
    };
    startDemo();
  });
  // Up to 90 game-s of demo, or until 4 throws.
  await game.page.waitForFunction(() => window.__throws.length >= 4 || demoState().elapsed >= 90, null, { timeout: T(200_000) });
  const throws = await game.eval(() => window.__throws);
  const range = await game.eval(() => CFG.GRENADE_RANGE);
  const rows = throws.map((q, i) => ({
    gap: i ? q.t - throws[i - 1].t : null,
    self: Math.hypot(q.tx - q.px, q.ty - q.py),
    near: q.near,
  }));
  const summary = rows.map((r) => `gap ${r.gap === null ? '-' : r.gap.toFixed(2)}s, ${r.self.toFixed(0)}u from the bot, ${r.near} enemies within 140u`).join(' | ');
  console.log(`[N1 demo] ${throws.length} throws: ${summary}`);
  testInfo.annotations.push({ type: 'N1 demo throws', description: `${throws.length}: ${summary}` });
  expect(throws.length, 'the demo bot throws grenades at wave 10').toBeGreaterThan(0);
  for (const r of rows) {
    if (r.gap !== null) expect(r.gap, 'at most one throw per 4 s').toBeGreaterThanOrEqual(4 - 1e-6);
    expect(r.self, 'never within 140u of itself').toBeGreaterThan(140);
    expect(r.self, 'within throw range').toBeLessThanOrEqual(range + 1);
    expect(r.near, '>= 4 enemies within 140u of the target').toBeGreaterThanOrEqual(4);
  }
});
