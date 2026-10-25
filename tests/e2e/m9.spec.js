import { test, expect, T } from './fixtures.js';
import { LANDED } from '../milestones.js';
import { pinRenderersToCcd0 } from '../perf/pin.mjs';

// M9 water and fire, e2e half (docs/SPEC.md W2, W5 and the M9 perf line). Each test is gated
// on its own flag in tests/milestones.js. Unit halves: tests/unit/water.test.js, fire.test.js.
//
// Josh's provisional hook names are passed into the page and called as window[name], so a
// rename changes one line here (and needs no lint config entry).
const HOOKS = {
  drawnBounds: 'spDrawnBounds', // (ent) -> { x, y, w, h, waterY }: what is drawn, world-screen units
  visibleH: 'entityVisibleH',   // (ent) -> drawn body height above the waterline, world-screen units
  waterFx: 'waterFxStats',      // () -> { clouds, splashes, decalsBlocked, camoRebakes }
  waterBlood: 'waterBloodAt',   // (x, y) -> { c, band } (band 0..4, 0 = none)
  burnStats: 'burnStats',       // () -> { burning, max, ignitions, extinguished }
};

async function startCalm(game) {
  await game.boot();
  await game.eval(() => { CFG.DEMO_IDLE_SECONDS = 1e9; });
  await game.start();
  await game.freezeWaves();
  await game.eval(() => { unlockedWeapons = WEAPONS.length; player.invincible = 1e9; });
}

/** Post-FX (dither, CRT) change neither sprite bounds nor aim; under SwiftShader they dominate the frame. */
async function postFxOff(game) {
  await game.eval(() => {
    RETRO.DITHER = false; RETRO.CRT = false;
    if (typeof _applyRetroToggles === 'function') _applyRetroToggles();
  });
}

/** Press F6 until retroState().scale === target (R6 cycles 1 -> 2 -> 3 -> 4). */
async function setPixelScale(game, target) {
  for (let i = 0; i < 4; i++) {
    if ((await game.eval(() => retroState().scale)) === target) return;
    await game.page.keyboard.press('F6');
  }
  expect(await game.eval(() => retroState().scale)).toBe(target);
}

/** Park the player (camera snapped) at p, let the chunks bake, then clear env objects within r
 *  (canopies would cover the measured sprites and tiles; trunks would stop shots). */
async function parkAt(game, p, r = 700) {
  const park = (q) => {
    player.x = q.x; player.y = q.y; player.vx = 0; player.vy = 0;
    const s = toScreen(q.x, q.y);
    cam.x = cam.tx = s.x; cam.y = cam.ty = s.y;
  };
  await game.eval(park, p);
  await game.advance(1);
  await game.eval(({ p, r }) => {
    for (let i = envObjects.length - 1; i >= 0; i--) if (Math.hypot(envObjects[i].x - p.x, envObjects[i].y - p.y) < r) envObjects.splice(i, 1);
  }, { p, r });
  await game.eval(park, p);
  await game.advance(0.2);
}

// Screen directions from the player, as world unit vectors (toScreen x = wx - wy, y = (wx + wy) * ISO).
const DIRS = { left: [-Math.SQRT1_2, Math.SQRT1_2], right: [Math.SQRT1_2, -Math.SQRT1_2] };
const BOSS = 'boss'; // spawnEnemy(1, x, y, bossData): Runner base, x2.5 size (as spawnBoss(1))
const TARGETS = [...Array(12).keys(), BOSS];
const label = (t) => (t === BOSS ? 'boss' : t === 'player' ? 'player' : `t${t}`);

// =====================================================================
// W2 wading
// =====================================================================
/** In-page: a water tile with 3x3 water around it nearest the player, and a land tile with 3x3
 *  land around it 3-4 tiles away (both blocks then fit on screen with the entity). */
const FIND_WADE_SITE = () => {
  const ts = CFG.TILE_SIZE;
  const wet = (i, j) => getTerrainTypeAt(i * ts, j * ts) === 'water';
  const block = (i, j, want) => {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (wet(i + a, j + b) !== want) return false;
    return true;
  };
  const c = (i, j) => ({ x: (i + 0.5) * ts, y: (j + 0.5) * ts });
  const ci = Math.floor(player.x / ts), cj = Math.floor(player.y / ts);
  for (let R = 0; R < 80; R++) {
    for (let i = ci - R; i <= ci + R; i++) {
      for (let j = cj - R; j <= cj + R; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== R || !block(i, j, true)) continue;
        for (const r of [3, 4]) {
          for (let a = -r; a <= r; a++) {
            for (let b = -r; b <= r; b++) {
              if (Math.max(Math.abs(a), Math.abs(b)) === r && block(i + a, j + b, false)) return { W: c(i, j), L: c(i + a, j + b) };
            }
          }
        }
      }
    }
  }
  return null;
};

/** In-page: measure(target) puts the entity on the land tile, then the water tile, then back,
 *  sampling entityVisibleH once per game frame. Enemies keep the same pose: they stand still and
 *  the player stands at the same offset D from them (so they face the same way) wherever they are. */
const INSTALL_W2 = ({ h, site }) => {
  const { W, L } = site;
  const D = { x: -110, y: -110 }; // world (-1, -1): the player stands screen-up of the enemy
  const park = (p) => {
    player.x = p.x; player.y = p.y; player.vx = 0; player.vy = 0;
    const s = toScreen(p.x, p.y);
    cam.x = cam.tx = s.x; cam.y = cam.ty = s.y;
  };
  const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
  const record = async (ent, dt, hold) => {
    const out = [], t0 = gameTime;
    let last = -1;
    while (gameTime - t0 < dt) {
      await nextFrame();
      hold();
      if (gameTime !== last) { last = gameTime; out.push({ t: gameTime - t0, h: window[h.visibleH](ent) }); }
    }
    return out;
  };
  const median = (rs) => { const s = rs.map((r) => r.h).sort((a, b) => a - b); return s[s.length >> 1]; };
  window.__m9w2 = {
    async measure(target) {
      enemies.length = 0;
      const isPlayer = target === 'player';
      let at = L, ent = player;
      if (!isPlayer) {
        ent = target === 'boss' ? spawnEnemy(1, L.x, L.y, { name: 'W2 BOSS', hp: 1e9 }) : spawnEnemy(target, L.x, L.y);
        ent.hp = ent.maxHp = 1e9; ent.shieldHp = ent.maxShieldHp = 0;
        ent.speed = 0; ent.fireTimer = 1e9;
      }
      const hold = () => {
        player.idleT = 0; player.fidgetT = 0; // no random idle fidget pose
        if (isPlayer) { player.x = at.x; player.y = at.y; player.vx = 0; player.vy = 0; }
        else { ent.x = at.x; ent.y = at.y; ent.vx = 0; ent.vy = 0; player.x = at.x + D.x; player.y = at.y + D.y; }
      };
      const go = (p) => { at = p; hold(); park(isPlayer ? p : { x: p.x + D.x, y: p.y + D.y }); };
      go(L);
      await record(ent, 0.4, hold); // settle on land
      const dry = median(await record(ent, 0.3, hold));
      go(W);
      const enter = await record(ent, 0.6, hold);
      go(L);
      const leave = await record(ent, 0.6, hold);
      if (!isPlayer) enemies.length = 0;
      return {
        dry, enter, leave,
        wet: median(enter.filter((r) => r.t >= 0.4)),
        dryAgain: median(leave.filter((r) => r.t >= 0.4)),
      };
    },
  };
  park(L);
};

test.describe('W2 wading', () => {
  test.skip(!LANDED.W2, 'W2 not landed (tests/milestones.js)');

  test('W2: the player, all 12 enemy types and a boss show <= 55% of their dry body height in water, and the waterline ramps in and out without popping (10-90% >= 0.6 x WADE_RAMP, ramp >= 0.2 s)', async ({ game }, testInfo) => {
    test.setTimeout(T(300_000));
    await startCalm(game);
    await postFxOff(game);
    const site = await game.eval(FIND_WADE_SITE);
    expect(site, 'a 3x3 pond and 3x3 dry land 3-4 tiles apart').toBeTruthy();
    await parkAt(game, { x: (site.W.x + site.L.x) / 2, y: (site.W.y + site.L.y) / 2 });
    await game.eval(INSTALL_W2, { h: HOOKS, site });
    const { scale, ramp } = await game.eval(() => ({ scale: retroState().scale, ramp: CFG.WADE_RAMP }));
    // Guard: the transition bar scales with the ramp, so the ramp can't be shrunk to pass it.
    expect(ramp, 'CFG.WADE_RAMP (spec ~0.25 s)').toBeGreaterThanOrEqual(0.2);
    const rows = [];
    for (const target of ['player', ...TARGETS]) {
      rows.push({ who: label(target), ...(await game.eval((t) => window.__m9w2.measure(t), target)) });
    }
    const text = rows.map((r) => `${r.who}: dry ${r.dry} wet ${r.wet} (${((r.wet / r.dry) * 100).toFixed(0)}%) back ${r.dryAgain}`);
    testInfo.annotations.push({ type: 'W2 visible height (world-screen units)', description: text.join(' | ') });
    console.log(`W2 x${scale}, ramp ${ramp} s:\n${text.join('\n')}`);
    // One art pixel = `scale` world-screen units. Per game frame the visible height may change by
    // the ramp's own slope over that frame's dt (0.45 x height x dt / ramp: under 1 art pixel per
    // 1/60 s for a normal enemy), plus 1 art pixel of rounding and 1 for the idle bob. A pop (the
    // whole 45% in one frame) is far above that at any frame rate the game allows (dt <= 0.05).
    for (const r of rows) {
      expect(r.dry, `${r.who}: drawn on land`).toBeGreaterThan(0);
      expect(r.wet, `${r.who}: visible height in water <= 55% of dry (+1 art px)`).toBeLessThanOrEqual(0.55 * r.dry + scale);
      expect(Math.abs(r.dryAgain - r.dry), `${r.who}: full height again on land`).toBeLessThanOrEqual(scale);
      for (const [phase, recs, from, to] of [['entering', r.enter, r.dry, r.wet], ['leaving', r.leave, r.wet, r.dry]]) {
        let prev = { t: 0, h: from }, mid = 0;
        for (const x of recs) {
          const allow = 2 * scale + 0.45 * r.dry * ((x.t - prev.t) / ramp);
          expect(Math.abs(x.h - prev.h), `${r.who} ${phase}: change at ${x.t.toFixed(3)} s (${prev.h} -> ${x.h})`).toBeLessThanOrEqual(allow + 1e-6);
          if (x.h > Math.min(from, to) + scale && x.h < Math.max(from, to) - scale) mid++;
          prev = x;
        }
        expect(mid, `${r.who} ${phase}: in-between heights (a ramp, not a pop)`).toBeGreaterThanOrEqual(2);
        // Ralph: frame-rate proof. The transition from 10% to 90% of the cut takes >= 0.6 x
        // CFG.WADE_RAMP (accepts linear and eased ramps), which also catches a "fast ramp" that
        // per-frame bounds could miss at low fps. CFG.WADE_RAMP itself must stay >= 0.2 s.
        const cut = to - from;
        const at10 = recs.find((x) => (x.h - from) / cut >= 0.1);
        const at90 = recs.find((x) => (x.h - from) / cut >= 0.9);
        expect(at10 && at90, `${r.who} ${phase}: the transition completes`).toBeTruthy();
        // Both crossings are sampled at frame boundaries, so the measured span can be short by up
        // to one frame: allow the largest frame step seen in this transition.
        const frameDt = Math.max(...recs.slice(1).map((x, k) => x.t - recs[k].t));
        expect(at90.t - at10.t, `${r.who} ${phase}: 10% -> 90% of the cut takes >= 0.6 x ${ramp} s (minus one frame, ${frameDt.toFixed(3)} s)`)
          .toBeGreaterThanOrEqual(0.6 * ramp - frameDt - 1e-6);
      }
    }
  });

  // Real-mouse aim at x3, like the G13 tests in aim.spec.js (78 shots, tagged @long: the CI
  // long job for x3 runs it with the G13 x3 test).
  test('W2: zero-spread shots at the visible head and torso of wading enemies hit (>= 95%); a shot at the submerged legs splashes and does no damage (12 types + boss, x3)', { tag: '@long' }, async ({ game }, testInfo) => {
    test.setTimeout(T(600_000));
    await startCalm(game);
    await setPixelScale(game, 3);
    await postFxOff(game);
    const site = await game.eval(FIND_WADE_SITE);
    expect(site, 'a 3x3 pond').toBeTruthy();
    await parkAt(game, site.W, 480);
    await game.eval(({ h, W }) => {
      player.weapon = WEAPONS.findIndex((w) => w.name === 'Railgun');
      player.magAmmo = WEAPONS[player.weapon].mag;
      const m = window.__m9 = {
        W, spot: W, list: [], lastShot: null,
        park() {
          const p = this.spot;
          player.x = p.x; player.y = p.y; player.vx = 0; player.vy = 0;
          player.fireTimer = 0; player.reloading = false; player.reloadTimer = 0; player.spinUp = 0;
          player.magAmmo = WEAPONS[player.weapon].mag;
          player.dodging = false; player.fidgetT = 0; player.idleT = 0;
          const sp = toScreen(p.x, p.y);
          cam.x = cam.tx = sp.x; cam.y = cam.ty = sp.y;
          shakeMag = 0; shakeX = 0; shakeY = 0;
        },
        place(target, dir) {
          enemies.length = 0; this.list.length = 0;
          this.spot = { x: W.x - dir[0] * 230, y: W.y - dir[1] * 230 }; // the enemy is `dir` of the player
          const e = target === 'boss' ? spawnEnemy(1, W.x, W.y, { name: 'W2 BOSS', hp: 1e9 }) : spawnEnemy(target, W.x, W.y);
          this.list.push(e);
          this.prep();
          return 0;
        },
        reset(e) {
          e.x = W.x; e.y = W.y; e.vx = 0; e.vy = 0; e.speed = 0;
          e.hp = e.maxHp = 1e9; e.shieldHp = e.maxShieldHp = 0; // a hit = an hp drop
          e.knockbackX = 0; e.knockbackY = 0; e.stunTimer = 0; e.hitFlash = 0; e.fireTimer = 1e9;
        },
        prep() { this.lastShot = null; this.park(); for (const e of this.list) this.reset(e); bullets.length = 0; },
        bounds(i) {
          const e = this.list[i], b = window[h.drawnBounds](e);
          if (!b) return null;
          const f = toScreen(e.x, e.y);
          return {
            x: worldOffsetX + b.x, y: worldOffsetY + b.y, w: b.w, h: b.h,
            waterY: typeof b.waterY === 'number' ? worldOffsetY + b.waterY : null,
            footX: f.x + worldOffsetX, footY: f.y + worldOffsetY,
          };
        },
        frames(n) { return new Promise((done) => { const f = () => (n-- <= 0 ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); }); },
        async prepBounds(i, n = 3) { this.prep(); await this.frames(n); return this.bounds(i); },
        splashes() { return window[h.waterFx]().splashes; },
        awaitShot(i, ms) {
          const t0 = performance.now();
          return new Promise((done, fail) => {
            const tick = () => {
              if (performance.now() - t0 > ms) return fail(new Error(`W2: shot not resolved in ${ms} ms`));
              const e = this.list[i], b = bullets.find((q) => q.owner === 'player');
              if (this.lastShot && (e.hp < 1e9 || !b || Math.hypot(b.x - player.x, b.y - player.y) > 700)) {
                return done({ hit: e.hp < 1e9, splashes: this.splashes() });
              }
              requestAnimationFrame(tick);
            };
            tick();
          });
        },
      };
      // Mark the moment a player round is fired (a page round trip takes several frames).
      const push0 = bullets.push;
      bullets.push = function (...items) {
        for (const b of items) if (b.owner === 'player' && !m.lastShot) m.lastShot = { x: b.x, y: b.y };
        return push0.apply(this, items);
      };
    }, { h: HOOKS, W: site.W });
    const wep = await game.eval(() => WEAPONS[player.weapon]);
    expect([wep.name, wep.spread]).toEqual(['Railgun', 0]);

    async function fireAt(pt) {
      await game.page.mouse.move(pt.x, pt.y);
      await game.page.mouse.down();
      const res = await game.eval((ms) => window.__m9.awaitShot(0, ms), T(10_000));
      await game.page.mouse.up();
      return res;
    }
    const axisX = (b) => Math.round(Math.min(b.x + b.w - 2, Math.max(b.x + 1, b.footX)));
    // Fractions of the VISIBLE body (top of the drawn sprite down to the waterline).
    const PARTS = { head: 0.25, torso: 0.6 };
    const tally = { head: [0, 0], torso: [0, 0] }, legs = { n: 0, noHit: 0, splash: 0 }, misses = [];
    for (const target of TARGETS) {
      for (const [dirName, dir] of Object.entries(DIRS)) {
        await game.eval(({ target, dir }) => window.__m9.place(target, dir), { target, dir });
        await game.advance(0.5); // past the 0.25 s wading ramp
        for (const [part, frac] of Object.entries(PARTS)) {
          const b = await game.eval(() => window.__m9.prepBounds(0));
          expect(b, `${label(target)} ${dirName}: drawn`).not.toBeNull();
          expect(b.waterY, `${label(target)} ${dirName}: a waterline between the head and the feet`).not.toBeNull();
          expect(b.waterY).toBeGreaterThan(b.y);
          expect(b.waterY).toBeLessThan(b.footY);
          const { hit } = await fireAt({ x: axisX(b), y: Math.round(b.y + (b.waterY - b.y) * frac) });
          tally[part][1]++;
          if (hit) tally[part][0]++; else misses.push(`${label(target)}/${dirName}/${part}`);
        }
        // Halfway down the submerged part: not on the visible sprite (no G13 pick), so the round
        // flies at the ground point there, across the hidden legs, beside the shrunken foot ring.
        const b = await game.eval(() => window.__m9.prepBounds(0));
        const s0 = await game.eval(() => window.__m9.splashes());
        const res = await fireAt({ x: axisX(b), y: Math.round(b.waterY + (b.footY - b.waterY) * 0.5) });
        legs.n++;
        if (!res.hit) legs.noHit++; else misses.push(`${label(target)}/${dirName}/legs HIT`);
        if (res.splashes > s0) legs.splash++; else misses.push(`${label(target)}/${dirName}/legs no splash`);
      }
    }
    const rate = (p) => tally[p][0] / tally[p][1];
    const summary = `head ${(rate('head') * 100).toFixed(1)}%, torso ${(rate('torso') * 100).toFixed(1)}%, submerged legs: no damage ${legs.noHit}/${legs.n}, splash ${legs.splash}/${legs.n}`;
    testInfo.annotations.push({ type: 'W2 aim in water x3', description: `${summary}; ${misses.join(' ') || 'no misses'}` });
    console.log(`W2 aim in water x3: ${summary}\n${misses.join(' ')}`);
    expect(rate('head'), summary).toBeGreaterThanOrEqual(0.95);
    expect(rate('torso'), summary).toBeGreaterThanOrEqual(0.95);
    expect(legs.noHit / legs.n, summary).toBeGreaterThanOrEqual(0.95);
    expect(legs.splash / legs.n, summary).toBeGreaterThanOrEqual(0.95);
  });
});

// =====================================================================
// W5 water reddens with blood
// =====================================================================
/** In-page: K = a water tile with 3x3 water around it nearest the player; C = another water tile
 *  5-7 tiles away (beyond the 3-tile kill radius) as clean reference; M = their midpoint, so both
 *  are on screen with the player centred between them. */
const FIND_POND_PAIR = () => {
  const ts = CFG.TILE_SIZE;
  const wet = (i, j) => getTerrainTypeAt(i * ts, j * ts) === 'water';
  const c = (i, j) => ({ x: (i + 0.5) * ts, y: (j + 0.5) * ts });
  const ci = Math.floor(player.x / ts), cj = Math.floor(player.y / ts);
  for (let R = 0; R < 80; R++) {
    for (let i = ci - R; i <= ci + R; i++) {
      for (let j = cj - R; j <= cj + R; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== R) continue;
        let ok = true;
        for (let a = -1; a <= 1 && ok; a++) for (let b = -1; b <= 1 && ok; b++) ok = wet(i + a, j + b);
        if (!ok) continue;
        for (let a = -7; a <= 7; a++) {
          for (let b = -7; b <= 7; b++) {
            const d = Math.hypot(a, b);
            if (d < 5 || d > 7 || !wet(i + a, j + b)) continue;
            const K = c(i, j), C = c(i + a, j + b);
            return { K, C, M: { x: (K.x + C.x) / 2, y: (K.y + C.y) / 2 } };
          }
        }
      }
    }
  }
  return null;
};

/** In-page: mean colour of a 9x9 grid of points within +-24u of a tile centre, from ONE extract
 *  of the displayed stage (CSS px = worldOffset + toScreen, as verified in aim.spec.js). */
const TILE_COLOURS = ({ K, C }) => {
  const { pixels, width, height } = app.renderer.extract.pixels({ target: app.stage, frame: new PIXI.Rectangle(0, 0, W, H) });
  const res = width / W;
  const sample = (p) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let dx = -32; dx <= 32; dx += 4) {
      for (let dy = -32; dy <= 32; dy += 4) {
        const s = toScreen(p.x + dx, p.y + dy);
        const x = Math.round((s.x + worldOffsetX) * res), y = Math.round((s.y + worldOffsetY) * res);
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = (y * width + x) * 4;
        r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; n++;
      }
    }
    return { r: r / n, g: g / n, b: b / n, n };
  };
  return { K: sample(K), C: sample(C) };
};

/** In-page: kill `n` enemies around K, alternating corpse and gib deaths. */
const KILL_AT = ({ K, n }) => {
  for (let i = 0; i < n; i++) {
    const a = i * 2.4;
    const e = spawnEnemy(i % 3, K.x + Math.cos(a) * 20, K.y + Math.sin(a) * 20);
    if (e) killEnemy(e, a, i % 2 ? SRC_EXPLOSIVE : SRC_BULLET);
  }
};

test.describe('W5 water reddens', () => {
  test.skip(!LANDED.W5, 'W5 not landed (tests/milestones.js)');

  test('W5: 20 kills in a pond take its tiles to band >= 2, visibly redder than clean water (hue ratio R >= 1.4/1.8 x G and B, dither+CRT on)', async ({ game }, testInfo) => {
    test.setTimeout(T(180_000));
    await startCalm(game);
    const s = await game.eval(FIND_POND_PAIR);
    expect(s, 'a 3x3 pond tile with other water 5-7 tiles away').toBeTruthy();
    await parkAt(game, s.M);
    await game.eval(KILL_AT, { K: s.K, n: 20 });
    // Corpses sink and dissolve (W4, <= 5 s); blood clouds fade (W3, ~8 s).
    await game.advance(15);
    const r = await game.eval(({ h, K, C }) => {
      const ts = CFG.TILE_SIZE, bands = [];
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) bands.push(window[h.waterBlood](K.x + a * ts, K.y + b * ts).band);
      return { bands, centre: window[h.waterBlood](K.x, K.y).band, clean: window[h.waterBlood](C.x, C.y) };
    }, { h: HOOKS, ...s });
    testInfo.annotations.push({ type: 'W5 bands', description: `kill tile + neighbours: ${r.bands.join(' ')}; reference ${JSON.stringify(r.clean)}` });
    expect(Math.min(...r.bands), `bands around the kills: ${r.bands.join(' ')}`).toBeGreaterThanOrEqual(2);
    expect(r.clean.band, 'the reference tile is clean water (band 0)').toBe(0);
    // Spec b0cdc51: measured as drawn, with dither and CRT ON (the look players see).
    await game.eval(() => {
      RETRO.DITHER = true; RETRO.CRT = true;
      if (typeof _applyRetroToggles === 'function') _applyRetroToggles();
    });
    await game.advance(0.3);
    const px = await game.eval(TILE_COLOURS, s);
    await game.snap(testInfo, 'w5-red-pond.png');
    const red = (q) => q.r - (q.g + q.b) / 2;
    const summary = `red tile rgb(${px.K.r.toFixed(0)},${px.K.g.toFixed(0)},${px.K.b.toFixed(0)}) redness ${red(px.K).toFixed(1)}; clean tile rgb(${px.C.r.toFixed(0)},${px.C.g.toFixed(0)},${px.C.b.toFixed(0)}) redness ${red(px.C).toFixed(1)}`;
    testInfo.annotations.push({ type: 'W5 pixels', description: summary });
    console.log(`W5: ${summary}`);
    expect(px.K.n, 'samples on screen').toBeGreaterThan(40);
    expect(px.C.n, 'samples on screen').toBeGreaterThan(40);
    expect(px.C.b, `clean water reads blue (${summary})`).toBeGreaterThan(px.C.r);
    expect(red(px.K) - red(px.C), `band >= 2 water is visibly redder (${summary})`).toBeGreaterThanOrEqual(20);
    // Spec b0cdc51 hue bar on the averaged tile colour: band 2 -> R >= 1.4 x G and >= 1.4 x B;
    // band 3+ -> >= 1.8x (rgb(77,77,46) "olive" fails both).
    const k = r.centre >= 3 ? 1.8 : 1.4;
    expect(px.K.r, `band ${r.centre}: R >= ${k} x G (${summary})`).toBeGreaterThanOrEqual(k * px.K.g);
    expect(px.K.r, `band ${r.centre}: R >= ${k} x B (${summary})`).toBeGreaterThanOrEqual(k * px.K.b);
  });

  test('W5: the water camo is not rebaked during a fight (camera still), and the blood state updates at <= 4 Hz', async ({ game }, testInfo) => {
    test.setTimeout(T(240_000));
    await startCalm(game);
    const s = await game.eval(FIND_POND_PAIR);
    expect(s, 'a 3x3 pond tile').toBeTruthy();
    await parkAt(game, s.M);
    const rebakes = () => game.eval((h) => window[h.waterFx]().camoRebakes, HOOKS);
    // Baseline once the chunks around the new spot have baked (count steady for 1 game-s).
    let base = await rebakes();
    for (let k = 0; k < 10; k++) {
      await game.advance(1);
      const n = await rebakes();
      if (n === base) break;
      base = n;
    }
    // 10 game-s of fight at the pond: 5 kills/s, corpses and gibs, player and camera still.
    await game.eval(({ K, M }) => {
      const f = window.__m9fight = { done: false, kills: 0, t0: gameTime };
      const tick = () => {
        const el = gameTime - f.t0;
        player.x = M.x; player.y = M.y; player.vx = 0; player.vy = 0;
        while (f.kills < Math.min(el, 10) * 5) {
          const a = f.kills * 2.4;
          const e = spawnEnemy(f.kills % 3, K.x + Math.cos(a) * 30, K.y + Math.sin(a) * 30);
          if (e) killEnemy(e, a, f.kills % 2 ? SRC_EXPLOSIVE : SRC_BULLET);
          f.kills++;
        }
        if (el >= 10) { f.done = true; return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, s);
    await game.page.waitForFunction(() => window.__m9fight && window.__m9fight.done, null, { timeout: T(120_000) });
    const during = await rebakes();
    // Let the last corpses dissolve (their events end), then watch a tile with an in-between
    // concentration while nothing adds blood: it may only change on the W5 tick.
    await game.advance(7);
    const r = await game.eval(({ h, K, seconds }) => new Promise((resolve) => {
      const ts = CFG.TILE_SIZE, cands = [];
      for (let a = -4; a <= 4; a++) {
        for (let b = -4; b <= 4; b++) {
          const x = K.x + a * ts, y = K.y + b * ts;
          if (getTerrainTypeAt(Math.floor(x / ts) * ts, Math.floor(y / ts) * ts) !== 'water') continue;
          const c = window[h.waterBlood](x, y).c;
          if (c > 0.05 && c < 0.95) cands.push({ x, y, c });
        }
      }
      cands.sort((p, q) => Math.abs(p.c - 0.5) - Math.abs(q.c - 0.5));
      const tile = cands[0] || K;
      const c0 = window[h.waterBlood](tile.x, tile.y).c;
      let prev = c0, changes = 0, last = gameTime;
      const t0 = gameTime;
      const tick = () => {
        if (gameTime !== last) {
          last = gameTime;
          const c = window[h.waterBlood](tile.x, tile.y).c;
          if (Math.abs(c - prev) > 1e-12) changes++;
          prev = c;
        }
        if (gameTime - t0 < seconds) requestAnimationFrame(tick);
        else resolve({ changes, span: gameTime - t0, c0, c1: prev, candidates: cands.length });
      };
      requestAnimationFrame(tick);
    }), { h: HOOKS, K: s.K, seconds: 5 });
    const after = await rebakes();
    const summary = `camoRebakes ${base} -> ${during} (fight) -> ${after}; tile c ${r.c0.toFixed(4)} -> ${r.c1.toFixed(4)} with ${r.changes} changes in ${r.span.toFixed(2)} game-s`;
    testInfo.annotations.push({ type: 'W5 updates', description: summary });
    console.log(`W5: ${summary}`);
    expect(during, `no camo rebake during the fight (${summary})`).toBe(base);
    expect(after, summary).toBe(base);
    expect(r.candidates, 'a tile with an in-between concentration near the kills').toBeGreaterThan(0);
    expect(r.changes, `at most 4 updates per game-s (${summary})`).toBeLessThanOrEqual(4 * r.span + 1);
    expect(r.changes, `it does decay (${summary})`).toBeGreaterThanOrEqual(2);
  });
});

// =====================================================================
// M9 perf: burning enemies + burning trees + a red pond (Q2a sustained ratio)
// =====================================================================
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
        if (Math.abs(dx - dy) > 400 || Math.abs((dx + dy) * CFG.ISO_SCALE) > 220) continue; // on a 960x540 screen
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

/**
 * In-page steady M9 load (same driver as tests/perf/m9.mjs): the player holds the flamethrower;
 * 15 trees opposite the pond are re-planted when charred and the stream lights a fresh one while
 * fewer than 10 burn; 20 enemies (hp 1e9, standing in a packed block beside the player so contact
 * spreads the fire) are pulled back when they run off and re-lit by the stream; a kill in the pond
 * every 3 game-s keeps it red after 20 kills at the start. Samples the scenario every frame.
 */
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

/** Median perfLog.totalCpuMs over the GAME-time window [from, to) seconds after `t0` (P1 pattern). */
const medianCpu = ({ t0, from, to }) => new Promise((resolve) => {
  const xs = [];
  const tick = () => {
    const el = gameTime - t0;
    if (el >= from) xs.push(perfLog.totalCpuMs);
    if (el < to) requestAnimationFrame(tick);
    else { xs.sort((a, b) => a - b); resolve({ median: xs[xs.length >> 1], p99: xs[Math.floor(xs.length * 0.99)], n: xs.length }); }
  };
  requestAnimationFrame(tick);
});

test.describe('M9 perf', () => {
  // CI (SwiftShader) checks only the relative sustained ratio; the absolute Q2a budget and
  // buildMs <= 3 are checked on the real GPU with `npm run perf:m9 -- --gpu`.
  test('M9PERF: 20 burning enemies, 10 burning trees and a red pond keep CPU frame time flat (game 75-90 s within 15% of 30-45 s)', { tag: '@perf' }, async ({ game }, testInfo) => {
    test.skip(!LANDED.M9PERF, 'M9PERF not landed (tests/milestones.js)');
    test.setTimeout(T(240_000));
    await startCalm(game);
    const pinning = process.env.E2E_NO_PIN ? { pinned: false, reason: 'E2E_NO_PIN' } : pinRenderersToCcd0();
    testInfo.annotations.push({ type: 'pinning', description: JSON.stringify(pinning) });
    const site = await game.eval(FIND_M9_SPOT);
    expect(site, 'a dry spot beside an on-screen pond').toBeTruthy();
    await parkAt(game, site.spot, 450);
    // Steady decal load in both windows (as P1): start with the store at its cap.
    await game.eval((p) => {
      for (let i = 0; i < CFG.MAX_BLOOD_POOLS; i++) {
        const a = i * 2.399963, r = 40 + (i % 97) * 5;
        addDecal(i % 7, p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, 4 + (i % 6), 0x8a0a0a, a);
      }
    }, site.spot);
    await game.eval(M9_LOAD, { h: HOOKS, ...site });
    const t0 = await game.eval(() => window.__m9load.t0);
    const early = await game.eval(medianCpu, { t0, from: 30, to: 45 });
    const late = await game.eval(medianCpu, { t0, from: 75, to: 90 });
    const scene = await game.eval(() => {
      const S = window.__m9load;
      S.stop = true;
      const med = (k) => { const xs = S.samples.filter((q) => q.t >= 30).map((q) => q[k]).sort((a, b) => a - b); return xs[xs.length >> 1]; };
      return { enemies: med('enemies'), trees: med('trees'), band: S.samples[S.samples.length - 1].band };
    });
    const ratio = late.median / early.median;
    const summary = `early median=${early.median.toFixed(2)}ms p99=${early.p99.toFixed(2)} late median=${late.median.toFixed(2)}ms p99=${late.p99.toFixed(2)} ratio=${ratio.toFixed(3)}; ` +
      `median burning enemies ${scene.enemies}, burning trees ${scene.trees}, pond band ${scene.band}`;
    console.log(`[M9PERF] ${summary}`);
    testInfo.annotations.push({ type: 'M9 sustained', description: summary });
    // The load was really there (loose: the stream alternates between trees and enemies).
    expect(scene.enemies, `burning enemies (${summary})`).toBeGreaterThanOrEqual(10);
    expect(scene.trees, `burning trees (${summary})`).toBeGreaterThanOrEqual(4);
    expect(scene.band, 'the pond stayed red').toBeGreaterThanOrEqual(2);
    expect(ratio, 'Q2a: sustained median within 15%').toBeLessThanOrEqual(1.15);
  });
});
