/* global __g13, __g13hp */
import { test, expect, T } from './fixtures.js';
import { LANDED } from '../milestones.js';

// G13 head-to-toe hits (docs/SPEC.md). User report: "shooting works only when
// aiming at their legs, headshots are impossible".
//
// Measurement: the world is drawn into a low-res RenderTexture and shown scaled
// by PIXEL_SCALE, with worldContainer at (worldOffsetX, worldOffsetY) screen px.
// So a worldContainer child's drawn rect in CSS px (= page.mouse space) is
// worldOffset + g.position + g.getLocalBounds(). Verified at x1 and x3: it equals
// g.getBounds() * PIXEL_SCALE, its bottom-centre sits at the foot point
// toScreen(e.x, e.y) + worldOffset (plus the shadow), and an outline drawn at it
// in the DOM frames the sprite in screenshots.
//
// G13_MEASURE=1 runs these before the milestone flag flips (to see the bug).
test.skip(!(LANDED.G13 || process.env.G13_MEASURE), 'G13 not landed (tests/milestones.js)');

/** Press F6 until retroState().scale === target (R6 cycles 1 -> 2 -> 3 -> 4). */
async function setPixelScale(game, target) {
  for (let i = 0; i < 4; i++) {
    if ((await game.eval(() => retroState().scale)) === target) return;
    await game.page.keyboard.press('F6');
  }
  expect(await game.eval(() => retroState().scale)).toBe(target);
}

const PARTS = { head: 0.15, torso: 0.45, legs: 0.85 };
// Screen directions from the player, as world unit vectors (toScreen x = wx - wy, y = (wx + wy) * ISO)
const DIRS = {
  left: [-Math.SQRT1_2, Math.SQRT1_2],
  right: [Math.SQRT1_2, -Math.SQRT1_2],
  up: [-Math.SQRT1_2, -Math.SQRT1_2],
  down: [Math.SQRT1_2, Math.SQRT1_2],
};
const BOSS = 'boss'; // spawnBoss(1) picks base type floor(1 * 1.2) = 1 (Runner), x2.5 size
const TARGETS = [...Array(12).keys(), BOSS];
const DIST = 230;

/**
 * Boot, start, freeze waves, set the pixel scale, and install page helpers:
 * player parked on dry ground with no env objects within 480 units (trunks,
 * crates and barrels would block shots), Railgun (spread 0) selected.
 */
async function setupArena(game, scale) {
  await game.boot();
  await game.start();
  await game.freezeWaves();
  await setPixelScale(game, scale);
  // Post-FX (dither, CRT) don't affect aim mapping, picking or sprite bounds, but under
  // software WebGL they are full-resolution passes at x1 and dominate the frame cost.
  await game.eval(() => {
    RETRO.DITHER = false; RETRO.CRT = false;
    if (typeof _applyRetroToggles === 'function') _applyRetroToggles();
  });
  await game.eval(() => {
    const dry = (x, y) => {
      for (const r of [0, 100, 200, 300, 400]) {
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2;
          if (getTerrainTypeAt(x + Math.cos(ang) * r, y + Math.sin(ang) * r) === 'water') return false;
        }
      }
      return true;
    };
    let spot = null;
    for (let r = 0; r <= 3000 && !spot; r += 150) {
      for (let a = 0; a < 12 && !spot; a++) {
        const x = player.x + Math.cos((a / 12) * Math.PI * 2) * r, y = player.y + Math.sin((a / 12) * Math.PI * 2) * r;
        if (dry(x, y)) spot = { x, y };
      }
    }
    if (!spot) throw new Error('G13 setup: no dry spot found');
    unlockedWeapons = WEAPONS.length;
    player.weapon = WEAPONS.findIndex((w) => w.name === 'Railgun');
    player.magAmmo = WEAPONS[player.weapon].mag;
    window.__g13 = {
      spot,
      list: [],
      clearEnv() {
        for (let i = envObjects.length - 1; i >= 0; i--) {
          const o = envObjects[i];
          if (Math.hypot(o.x - spot.x, o.y - spot.y) < 480) envObjects.splice(i, 1);
        }
      },
      parkPlayer() {
        player.x = spot.x; player.y = spot.y; player.vx = 0; player.vy = 0;
        player.fireTimer = 0; player.reloading = false; player.reloadTimer = 0; player.spinUp = 0;
        player.magAmmo = WEAPONS[player.weapon].mag;
        player.dodging = false; player.fidgetT = 0; player.idleT = 0;
        const sp = toScreen(player.x, player.y);
        cam.x = cam.tx = sp.x; cam.y = cam.ty = sp.y;
        shakeMag = 0; shakeX = 0; shakeY = 0;
      },
      spawn(target, x, y) {
        const e = target === 'boss' ? spawnEnemy(1, x, y, { name: 'G13 BOSS', hp: 1e9 }) : spawnEnemy(target, x, y);
        e.home = { x, y };
        this.list.push(e);
        this.reset(e);
        return this.list.length - 1;
      },
      reset(e) {
        e.x = e.home.x; e.y = e.home.y; e.vx = 0; e.vy = 0; e.speed = 0;
        e.hp = e.maxHp = 1e9; e.shieldHp = e.maxShieldHp = 0; // a hit = hp drop
        e.knockbackX = 0; e.knockbackY = 0; e.stunTimer = 0; e.hitFlash = 0;
        e.fireTimer = 1e9; // no enemy shots (explosive rounds would shake the camera)
      },
      clearEnemies() {
        enemies.length = 0;
        this.list.length = 0;
      },
      // Everything back in place before a shot
      prep() {
        this.lastShot = null;
        this.parkPlayer();
        for (const e of this.list) this.reset(e);
        bullets.length = 0;
      },
      // Drawn rect of a worldContainer child, in CSS px (page.mouse space)
      rectOf(g) {
        const lb = g.getLocalBounds();
        const x = worldOffsetX + g.x - g.pivot.x + lb.minX, y = worldOffsetY + g.y - g.pivot.y + lb.minY;
        return { x, y, w: lb.maxX - lb.minX, h: lb.maxY - lb.minY };
      },
      bounds(i) {
        const e = this.list[i], g = e._spG;
        if (!g || !g.visible || g._owner !== e) return null;
        const f = toScreen(e.x, e.y);
        const gb = g.getBounds(), s = RETRO.PIXEL_SCALE;
        return {
          ...this.rectOf(g),
          footX: f.x + worldOffsetX, footY: f.y + worldOffsetY,
          global: { x: gb.minX * s, y: gb.minY * s, w: (gb.maxX - gb.minX) * s, h: (gb.maxY - gb.minY) * s },
        };
      },
      hits() { return this.list.map((e) => e.hp < 1e9); },
      frames(n) {
        return new Promise((done) => { const f = () => (n-- <= 0 ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); });
      },
      // prep(), let it render, return the drawn bounds of list[i]
      async prepBounds(i, n = 3) {
        this.prep();
        await this.frames(n);
        return this.bounds(i);
      },
      awaitShot(ti, ms) {
        const t0 = performance.now(); // prep() cleared lastShot; the round may already be out
        let shot = null;
        return new Promise((done, fail) => {
          const step = () => {
            if (performance.now() - t0 > ms) return fail(new Error(`G13: shot not ${shot ? 'resolved' : 'fired'} in ${ms} ms`));
            const b = bullets.find((q) => q.owner === 'player');
            if (!shot && this.lastShot) shot = this.lastShot;
            if (shot) {
              const e = this.list[ti];
              if ((e && e.hp < 1e9) || !b || Math.hypot(b.x - player.x, b.y - player.y) > 700) {
                return done({ shot, res: { hits: this.hits(), hx: e.home.x, hy: e.home.y, r: 15 * e.size } });
              }
            }
            requestAnimationFrame(step);
          };
          step();
        });
      },
      weapon(name) {
        player.weapon = WEAPONS.findIndex((w) => w.name === name);
        player.magAmmo = WEAPONS[player.weapon].mag;
        return WEAPONS[player.weapon];
      },
      explosions: [],
    };
    // Record each player round at the moment it is fired (aim state of that frame:
    // a page round trip takes several frames, by then a hit has knocked the target away)
    const push0 = bullets.push;
    bullets.push = function (...items) {
      for (const b of items) {
        if (b.owner === 'player' && !__g13.lastShot) {
          __g13.lastShot = { mwx: mouseWorldX, mwy: mouseWorldY, bx: b.x, by: b.y, vx: b.vx, vy: b.vy, aim: player.aimAngle };
        }
      }
      return push0.apply(this, items);
    };
    // Spy on explosion centres (rocket detonation test); calls resolve through the global binding
    const spawnExplosion0 = window.spawnExplosion;
    window.spawnExplosion = function (x, y, radius, byPlayer, src) {
      __g13.explosions.push({ x, y, radius, byPlayer });
      return spawnExplosion0.apply(this, arguments);
    };
  });
  await game.eval(() => { __g13.parkPlayer(); __g13.clearEnv(); });
  await game.advance(0.3); // chunks around the new spot
  await game.eval(() => { __g13.parkPlayer(); __g13.clearEnv(); });
}

/**
 * Aim point on the drawn body: the body axis (foot x, clamped into the rect), at
 * `frac` of the way from the top of the drawn rect down to the feet (the rect's
 * bottom can be a gun pointing down or the shadow, not the body).
 */
function aimPoint(b, frac) {
  const x = Math.min(b.x + b.w - 2, Math.max(b.x + 1, b.footX));
  const bottom = Math.min(b.y + b.h, b.footY);
  return { x: Math.round(x), y: Math.round(b.y + (bottom - b.y) * frac) };
}

/**
 * Fire one Railgun round with the real mouse at a screen point, after prep().
 * Returns which tracked enemies took damage plus root-cause data (cursor world
 * point and the bullet's path) for target index `ti`.
 */
async function fireAt(game, pt, ti) {
  const page = game.page;
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  // One round trip (each costs ~200 ms under software WebGL): wait in the page for
  // the round to leave (magazine count: it can hit and vanish in its first frame),
  // then for it to resolve. mouseup clears mouseJustPressed, so release only after.
  const { shot, res } = await game.eval(({ ti, ms }) => __g13.awaitShot(ti, ms), { ti, ms: T(10_000) });
  await page.mouse.up();
  // Root cause: where the cursor maps on the ground vs the enemy, and how far the ray passes
  const dx = shot.mwx - res.hx, dy = shot.mwy - res.hy;
  const sp = Math.hypot(shot.vx, shot.vy), ux = shot.vx / sp, uy = shot.vy / sp;
  const rx = res.hx - shot.bx, ry = res.hy - shot.by;
  const missBy = Math.abs(rx * uy - ry * ux); // ray-to-enemy-centre distance (world units)
  return { hits: res.hits, aim: shot.aim, rc: { dx, dy, dist: Math.hypot(dx, dy), sdx: dx - dy, sdy: (dx + dy) * 0.55, missBy, r: res.r } };
}

async function placeAndRender(game, target, dir, dist = DIST) {
  const i = await game.eval(({ target, dir, dist }) => {
    __g13.clearEnemies();
    __g13.prep();
    return __g13.spawn(target, __g13.spot.x + dir[0] * dist, __g13.spot.y + dir[1] * dist);
  }, { target, dir, dist });
  await game.advance(0.12);
  return i;
}

/** Distance for this target/direction that keeps the whole sprite on screen (small CI viewport). */
const fitCache = new Map(); // per target: the 'up' distance only depends on the sprite height
async function fitDistance(game, target, dirName) {
  if (dirName !== 'up') return DIST;
  if (fitCache.has(target)) return fitCache.get(target);
  const i = await placeAndRender(game, target, DIRS.up, 120);
  const { h, H: vh } = await game.eval((i) => ({ h: __g13.bounds(i).h, H }), i);
  // Feet at H/2 - d*sqrt2*ISO; keep the top >= 24 px below the screen edge
  const d = (vh / 2 - 24 - h) / (Math.SQRT2 * 0.55);
  const fit = Math.max(120, Math.min(DIST, Math.floor(d)));
  fitCache.set(target, fit);
  return fit;
}

const label = (t) => (t === BOSS ? 'boss' : `t${t}`);

for (const scale of [1, 3]) {
  // 156 real mouse shots per scale: tagged @long so CI runs it in the sharded perf/long job.
  test(`G13: zero-spread shots at the drawn head, torso and legs hit (12 types + boss, 4 iso directions, x${scale})`, { tag: '@long' }, async ({ game }, testInfo) => {
    // 156 real-mouse shots; each page round trip costs ~0.2 s under software WebGL
    test.setTimeout(T(600_000));
    await setupArena(game, scale);
    const wep = await game.eval(() => WEAPONS[player.weapon]);
    expect(wep.name).toBe('Railgun');
    expect(wep.spread).toBe(0);

    const tally = { head: [0, 0], torso: [0, 0], legs: [0, 0] };
    const misses = [];
    const rcRows = [];
    for (const target of TARGETS) {
      for (const [dirName, dir] of Object.entries(DIRS)) {
        const dist = await fitDistance(game, target, dirName);
        const i = await placeAndRender(game, target, dir, dist);
        for (const [part, frac] of Object.entries(PARTS)) {
          const b = await game.eval((i) => __g13.prepBounds(i), i);
          expect(b, `${label(target)} ${dirName}: sprite rendered`).not.toBeNull();
          // Measurement sanity: local and global bounds agree, the feet sit at the bottom of the rect
          expect(Math.abs(b.global.x - b.x) + Math.abs(b.global.y - b.y)).toBeLessThanOrEqual(2);
          expect(b.footX).toBeGreaterThan(b.x);
          expect(b.footX).toBeLessThan(b.x + b.w);
          expect(b.footY).toBeGreaterThan(b.y + b.h * 0.5); // a gun can hang below the feet
          expect(b.footY).toBeLessThanOrEqual(b.y + b.h + 1);
          const pt = aimPoint(b, frac);
          const { hits, rc } = await fireAt(game, pt, i);
          tally[part][1]++;
          if (hits[i]) tally[part][0]++;
          else misses.push(`${label(target)}/${dirName}/${part}`);
          if (part === 'head') rcRows.push({ target: label(target), dir: dirName, hit: hits[i], ...rc });
        }
      }
    }

    const rate = (p) => tally[p][0] / tally[p][1];
    const summary = Object.keys(PARTS).map((p) => `${p} ${(rate(p) * 100).toFixed(1)}% (${tally[p][0]}/${tally[p][1]})`).join(', ');
    testInfo.annotations.push({ type: `G13 hit rate x${scale}`, description: summary });
    testInfo.annotations.push({ type: `G13 misses x${scale}`, description: misses.join(' ') || 'none' });
    // Root-cause evidence (not asserted): cursor-on-head ground point vs the enemy's feet
    const fmt = (v) => v.toFixed(1).padStart(6);
    const table = rcRows.filter((r) => ['t0', 't2', 't11', 'boss'].includes(r.target)).map((r) =>
      `${r.target.padEnd(5)} ${r.dir.padEnd(6)} world d=(${fmt(r.dx)},${fmt(r.dy)}) |d|=${fmt(r.dist)} screen d=(${fmt(r.sdx)},${fmt(r.sdy)}) ray passes ${fmt(r.missBy)} from centre (r=${r.r.toFixed(1)}) ${r.hit ? 'HIT' : 'miss'}`);
    testInfo.annotations.push({ type: `G13 root cause x${scale}`, description: table.join(' | ') });
    console.log(`G13 x${scale}: ${summary}\nmisses: ${misses.join(' ')}\ncursor on head -> mouseWorld minus enemy (x, y):\n${table.join('\n')}`);

    for (const p of Object.keys(PARTS)) {
      expect(rate(p), `G13 x${scale}: ${p} hit rate (${summary})`).toBeGreaterThanOrEqual(0.95);
    }
  });
}

test('G13: aiming one body-width beside the drawn sprite misses', async ({ game }, testInfo) => {
  test.setTimeout(T(240_000));
  await setupArena(game, 1);
  let shots = 0, missed = 0;
  const stray = [];
  // Screen-up and screen-down of the player, cursor 1 body width right / left of
  // the rect at torso height: the ray passes beside the body on screen.
  // (Beside a screen-left/right enemy the ray would visibly cross the body.)
  for (const target of TARGETS) {
    for (const dirName of ['up', 'down']) {
      const dist = await fitDistance(game, target, dirName);
      const i = await placeAndRender(game, target, DIRS[dirName], dist);
      for (const side of [1, -1]) {
        const b = await game.eval((i) => __g13.prepBounds(i), i);
        expect(b).not.toBeNull();
        const x = side > 0 ? b.x + b.w + b.w : b.x - b.w;
        const { hits } = await fireAt(game, { x: Math.round(x), y: aimPoint(b, PARTS.torso).y }, i);
        shots++;
        if (!hits[i]) missed++;
        else stray.push(`${label(target)}/${dirName}/${side > 0 ? 'right' : 'left'}`);
      }
    }
  }
  const summary = `misses ${missed}/${shots} (${((missed / shots) * 100).toFixed(1)}%)`;
  testInfo.annotations.push({ type: 'G13 side misses', description: `${summary}; hits: ${stray.join(' ') || 'none'}` });
  console.log(`G13 beside the sprite: ${summary}; hits: ${stray.join(' ') || 'none'}`);
  expect(missed / shots, summary).toBeGreaterThanOrEqual(0.95);
});

test('G13: with one enemy behind another, a shot at the FRONT enemy\'s head hits the front enemy', async ({ game }, testInfo) => {
  test.setTimeout(T(120_000));
  await setupArena(game, 3);
  // [front, back]: the back enemy stands where the front one's head maps to on
  // the ground, i.e. screen-up and behind it (smaller x+y depth), so its sprite
  // sits under the front enemy's head on screen.
  const pairs = [[0, 0], [2, 10], [3, 11], [1, 2]];
  const rows = [];
  for (const [front, back] of pairs) {
    for (const dirName of ['left', 'right']) {
      const dir = DIRS[dirName];
      const fi = await placeAndRender(game, front, dir);
      const fb = await game.eval((i) => __g13.bounds(i), fi);
      const head = aimPoint(fb, PARTS.head);
      const bi = await game.eval(({ head, back }) => {
        const g = toWorld(head.x - worldOffsetX, head.y - worldOffsetY);
        return __g13.spawn(back, g.x, g.y);
      }, { head, back });
      await game.eval(() => __g13.prep());
      await game.advance(0.12);
      const layout = await game.eval(({ fi, bi }) => {
        const f = __g13.list[fi], b = __g13.list[bi];
        return { fb: __g13.bounds(fi), bb: __g13.bounds(bi), frontZ: f._spG.zIndex, backZ: b._spG.zIndex,
          gap: Math.hypot(f.x - b.x, f.y - b.y),
          angF: Math.atan2(f.y - player.y, f.x - player.x), angB: Math.atan2(b.y - player.y, b.x - player.x) };
      }, { fi, bi });
      const pt = aimPoint(layout.fb, PARTS.head);
      const inRect = (r) => pt.x >= r.x && pt.x < r.x + r.w && pt.y >= r.y && pt.y < r.y + r.h;
      // Setup sanity: the cursor is on both sprites and the front one is drawn on top
      expect(inRect(layout.fb) && inRect(layout.bb), `${front}/${back} ${dirName}: cursor over both sprites`).toBe(true);
      expect(layout.frontZ).toBeGreaterThan(layout.backZ);
      const { hits, aim } = await fireAt(game, pt, fi);
      const near = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 0.01;
      const aimAt = near(aim, layout.angF) ? 'front' : near(aim, layout.angB) ? 'back' : 'ground';
      rows.push({ pair: `${label(front)} front / ${label(back)} back`, dir: dirName, front: hits[fi], back: hits[bi], gap: layout.gap, aimAt });
    }
  }
  const text = rows.map((r) => `${r.pair} (${r.dir}, ${r.gap.toFixed(0)}u apart): aimed at the ${r.aimAt} point, front ${r.front ? 'HIT' : 'miss'}, back ${r.back ? 'HIT' : 'miss'}`);
  testInfo.annotations.push({ type: 'G13 front/back', description: text.join(' | ') });
  console.log(`G13 front/back:\n${text.join('\n')}`);
  for (const r of rows) {
    expect(r.front, `${r.pair} ${r.dir}: the front enemy takes the shot`).toBe(true);
    expect(r.back, `${r.pair} ${r.dir}: the back enemy doesn't steal it`).toBe(false);
  }
});

test('G13: an enemy bullet aimed at the player\'s drawn torso hits the player', async ({ game }, testInfo) => {
  test.setTimeout(T(120_000));
  await setupArena(game, 3);
  await game.eval(() => __g13.clearEnemies());
  const rows = [];
  for (const [dirName, dir] of Object.entries(DIRS)) {
    await game.eval(() => { __g13.prep(); player.invincible = 1e9; });
    await game.advance(0.1);
    const shot = await game.eval((dir) => {
      const g = _sp.playerG;
      const r = __g13.rectOf(g);
      const f = toScreen(player.x, player.y);
      const tx = f.x + worldOffsetX, ty = r.y + r.h * 0.45; // drawn torso, on the body axis
      const aim = toWorld(tx - worldOffsetX, ty - worldOffsetY); // ground point under it
      // Officer-style round from 230 units away, flying through that ground point
      const sx = player.x + dir[0] * 230, sy = player.y + dir[1] * 230;
      const a = Math.atan2(aim.y - sy, aim.x - sx), bs = ENEMY_TYPES[3].bulletSpeed;
      player.invincible = 0; player.dodging = false;
      window.__g13hp = player.hp + player.shield;
      bullets.push({ x: sx, y: sy, vx: Math.cos(a) * bs, vy: Math.sin(a) * bs, dmg: ENEMY_TYPES[3].dmg, life: 2,
        owner: 'enemy', color: '#f44', size: 2, trail: false, explosive: false, radius: 0 });
      // Distance from the player's feet to the bullet's line (world units)
      const ux = Math.cos(a), uy = Math.sin(a);
      return { rect: r, aim, passes: Math.abs((player.x - sx) * uy - (player.y - sy) * ux) };
    }, dir);
    await game.page.waitForFunction(() => player.hp + player.shield < __g13hp || !bullets.some((b) => b.owner === 'enemy'), null, { timeout: T(10_000) });
    const hurt = await game.eval(() => {
      const d = __g13hp - (player.hp + player.shield);
      player.invincible = 1e9;
      return d;
    });
    rows.push({ dir: dirName, hit: hurt > 0, passes: shot.passes, h: shot.rect.h });
  }
  const text = rows.map((r) => `${r.dir}: ${r.hit ? 'HIT' : 'miss'} (line passes ${r.passes.toFixed(1)}u from the feet, sprite ${r.h}px tall)`);
  testInfo.annotations.push({ type: 'G13 enemy bullet vs player', description: text.join(' | ') });
  console.log(`G13 enemy bullet at the player's torso:\n${text.join('\n')}`);
  for (const r of rows) expect(r.hit, `${r.dir}: the round through the drawn torso hits the player`).toBe(true);
});

// ---------------------------------------------------------------------------
// Review of the first G13 hotfix (dev/josh 468eced): edge cases of picking and
// of the body column. Screen-up of a point is world (-1, -1)/sqrt2.
// ---------------------------------------------------------------------------

/** Spawn enemies at world offsets from the player's spot; returns their indices. */
async function placeGroup(game, specs) {
  const idx = await game.eval((specs) => {
    __g13.clearEnemies();
    __g13.prep();
    return specs.map((q) => __g13.spawn(q.target, __g13.spot.x + q.dx, __g13.spot.y + q.dy));
  }, specs);
  await game.advance(0.12);
  return idx;
}

/** A boss as spawnBoss() makes it (base type, x2.5 size), at a world offset from the spot. */
async function placeBoss(game, base, dx, dy) {
  await game.eval(({ base, dx, dy }) => {
    __g13.clearEnemies();
    __g13.prep();
    const x = __g13.spot.x + dx, y = __g13.spot.y + dy;
    const e = spawnEnemy(base, x, y, { name: 'G13 BOSS', hp: 1e9 });
    e.home = { x, y };
    __g13.list.push(e);
    __g13.reset(e);
  }, { base, dx, dy });
  await game.advance(0.12);
  return 0;
}

const along = (dir, d) => ({ dx: dir[0] * d, dy: dir[1] * d });

test('G13: a shot fired from inside an enemy\'s body column, away from it, does not hit it', async ({ game }, testInfo) => {
  test.setTimeout(T(180_000));
  await setupArena(game, 3);
  // The player stands L units screen-up of the enemy's feet: on the ground under
  // the enemy's drawn body (inside its body column), outside its foot circle
  // (15*size), drawn just behind it. 'jboss' = Juggernaut boss (size 5.5), whose
  // column is ~300 units long.
  const cases = [
    { target: 0, L: 25 }, { target: 2, L: 30 }, { target: 10, L: 40 }, { target: 11, L: 45 }, { target: 'jboss', L: 150 },
  ];
  const rows = [];
  for (const c of cases) {
    for (const wname of ['Railgun', 'Pistol']) {
      await game.eval((w) => __g13.weapon(w), wname);
      const d = c.L * Math.SQRT1_2; // enemy feet = spot + L * screen-down
      const [i] = c.target === 'jboss' ? [await placeBoss(game, 11, d, d)] : await placeGroup(game, [{ target: c.target, dx: d, dy: d }]);
      for (const [shotDir, off] of [['east (screen-right)', [300, 0]], ['up-screen', [0, -260]]]) {
        await game.eval(() => __g13.prep());
        await game.advance(0.05);
        const g = await game.eval((i) => {
          const sp = toScreen(player.x, player.y);
          return { px: sp.x + worldOffsetX, py: sp.y + worldOffsetY, b: __g13.bounds(i), r: 15 * __g13.list[i].size };
        }, i);
        const pt = { x: Math.round(g.px + off[0]), y: Math.max(4, Math.round(g.py + off[1])) };
        const inRect = pt.x >= g.b.x && pt.x < g.b.x + g.b.w && pt.y >= g.b.y && pt.y < g.b.y + g.b.h;
        expect(inRect, `${c.target} ${shotDir}: the cursor is off the enemy's sprite (no picking)`).toBe(false);
        const { hits } = await fireAt(game, pt, i);
        rows.push({ who: `${c.target === 'jboss' ? 'jboss' : label(c.target)} L=${c.L} (r=${g.r.toFixed(0)})`, wname, shotDir, hit: hits[i] });
      }
    }
  }
  await game.eval(() => __g13.weapon('Railgun'));
  const text = rows.map((r) => `${r.who} ${r.wname} ${r.shotDir}: ${r.hit ? 'HIT' : 'no hit'}`);
  testInfo.annotations.push({ type: 'G13 start inside the column', description: text.join(' | ') });
  console.log(`G13 shots from inside a body column, fired away:\n${text.join('\n')}`);
  for (const r of rows) expect(r.hit, `${r.who} ${r.wname} ${r.shotDir}: shooting away must not hit`).toBe(false);
});

test('G13: spread rounds along the iso screen-up line hit the FRONT enemy first', async ({ game }, testInfo) => {
  test.setTimeout(T(240_000));
  await setupArena(game, 3);
  // Two enemies on the screen-up line through the player: A at 150 units, B gap
  // units further on. A is nearer along the shot. Cursor on A's torso; spread
  // weapons put the rounds a hair off the axis.
  const rows = [];
  for (const [side, sign] of [['shooter below', 1], ['shooter above', -1]]) {
    for (const [ta, tb, gap] of [[0, 0, 28], [2, 3, 36]]) {
      for (const wname of ['Pistol', 'M16']) {
        await game.eval((w) => __g13.weapon(w), wname);
        const dir = [DIRS.up[0] * sign, DIRS.up[1] * sign];
        const [a, b] = await placeGroup(game, [{ target: ta, ...along(dir, 150) }, { target: tb, ...along(dir, 150 + gap) }]);
        let hitA = 0, hitB = 0, n = 0;
        for (let k = 0; k < 8; k++) {
          const ba = await game.eval((i) => __g13.prepBounds(i), a);
          const { hits } = await fireAt(game, aimPoint(ba, PARTS.torso), a);
          n++;
          if (hits[a]) hitA++;
          if (hits[b]) hitB++;
        }
        rows.push({ what: `${side}: ${label(ta)} front / ${label(tb)} back ${gap}u, ${wname}`, hitA, hitB, n });
      }
    }
  }
  await game.eval(() => __g13.weapon('Railgun'));
  const text = rows.map((r) => `${r.what}: front ${r.hitA}/${r.n}, back ${r.hitB}/${r.n}`);
  testInfo.annotations.push({ type: 'G13 nearest-first on the axis', description: text.join(' | ') });
  console.log(`G13 spread along the screen-up line:\n${text.join('\n')}`);
  for (const r of rows) {
    expect(r.hitB, `${r.what}: the back enemy is never hit first`).toBe(0);
    expect(r.hitA / r.n, `${r.what}: the front enemy takes the rounds`).toBeGreaterThanOrEqual(0.9);
  }
});

// G13c (Ralph, spec fe846ac): a contact explosive that hits an enemy's body (foot circle or
// column) explodes at the target's ground position (e.x, e.y), so the target takes full splash.
test('G13/G13c: an RPG aimed at an enemy\'s head detonates at its feet and deals it full splash (all 4 directions)', async ({ game }, testInfo) => {
  test.setTimeout(T(180_000));
  await setupArena(game, 3);
  await game.eval(() => {
    __g13.weapon('RPG');
    // Record every damage event per enemy (game code calls damageEnemy through the global).
    window.__g13dmg = new Map();
    const orig = window.damageEnemy;
    window.damageEnemy = function (e, dmg, ...rest) {
      if (!window.__g13dmg.has(e)) window.__g13dmg.set(e, []);
      window.__g13dmg.get(e).push(dmg);
      return orig.call(this, e, dmg, ...rest);
    };
  });
  const rows = [];
  for (const target of [0, 2, 10, 11]) {
    for (const [dirName, dir] of Object.entries(DIRS)) {
      const dist = await fitDistance(game, target, dirName);
      const i = await placeAndRender(game, target, dir, dist);
      const b = await game.eval((i) => { __g13.explosions.length = 0; window.__g13dmg.clear(); return __g13.prepBounds(i); }, i);
      await fireAt(game, aimPoint(b, PARTS.head), i);
      await game.page.waitForFunction(() => __g13.explosions.length > 0 || !bullets.some((q) => q.owner === 'player'), null, { timeout: T(10_000) });
      const r = await game.eval(({ i, b }) => {
        const e = __g13.list[i], x = __g13.explosions.find((q) => q.byPlayer);
        if (!x) return null;
        // Body column of the drawn sprite: feet -> head-top ground point, k = drawn height / (2 ISO)
        const k = (b.footY - b.y) / (2 * CFG.ISO_SCALE);
        const ax = e.home.x, ay = e.home.y;
        let u = ((x.x - ax) * -k + (x.y - ay) * -k) / (2 * k * k);
        u = Math.max(0, Math.min(1, u));
        const rpg = WEAPONS.find((w) => w.name === 'RPG');
        // Let queued splash damage resolve, then take the target's splash event (<= 0.7 * dmg).
        processPendingDamage();
        const ev = (window.__g13dmg.get(e) || []).filter((d) => d <= rpg.dmg * 0.7 + 1e-6);
        const splash = ev.length ? Math.max(...ev) : 0;
        return { feet: Math.hypot(x.x - ax, x.y - ay), axis: Math.hypot(x.x - (ax - k * u), x.y - (ay - k * u)), u, r: 15 * e.size,
          splashF: splash / (rpg.dmg * 0.7) };
      }, { i, b });
      rows.push({ who: `${label(target)} ${dirName}`, ...(r || { none: true }) });
    }
  }
  await game.eval(() => __g13.weapon('Railgun'));
  const text = rows.map((r) => (r.none ? `${r.who}: no detonation` :
    `${r.who}: ${r.feet.toFixed(1)}u from the feet, ${r.axis.toFixed(1)}u from the column axis (u=${r.u.toFixed(2)}, r=${r.r.toFixed(0)}), target splash f=${r.splashF.toFixed(2)}`));
  testInfo.annotations.push({ type: 'G13 RPG detonation', description: text.join(' | ') });
  console.log(`G13 RPG at the head, explosion centre:\n${text.join('\n')}`);
  for (const r of rows) {
    expect(r.none, `${r.who}: the rocket detonates`).toBeUndefined();
    expect(r.feet, `${r.who}: G13c explosion within 3u of the target's ground position`).toBeLessThanOrEqual(3);
    expect(r.splashF, `${r.who}: G13c target takes full splash (f ~ 1)`).toBeGreaterThanOrEqual(0.95);
  }
});

test('G13: the cursor on the top of a boss\'s drawn head picks the boss', async ({ game }, testInfo) => {
  test.setTimeout(T(180_000));
  await setupArena(game, 3);
  const rows = [];
  // Screen down-right of the player (world +x), so even the Juggernaut boss fits on 960x540
  for (const base of [1, 2, 7, 11]) {
    const i = await placeBoss(game, base, 200, 0);
    // The idle bob moves a boss's drawn top by ~1 art pixel (~6 px at boss size, x3), so read
    // the bounds over both bob phases (~1 s) and use the LOWER top: the cursor then sits on
    // the head whichever phase is drawn when the pick happens.
    // (bounds() is synchronous; prepBounds() is async and must not be used inside this loop.)
    const b = await game.eval(async (i) => {
      await __g13.prepBounds(i);
      let best = null, lo = Infinity, hi = -Infinity;
      const t0 = gameTime;
      await new Promise((resolve) => {
        const tick = () => {
          const q = __g13.bounds(i);
          if (q) {
            lo = Math.min(lo, q.h); hi = Math.max(hi, q.h);
            if (!best || q.y > best.y) best = q;
          }
          if (gameTime - t0 < 1.5) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
      });
      const e = __g13.list[i];
      const pose = { angle: +(e.angle || 0).toFixed(2), key: e._spG && e._spG._key, healGlow: +(e.healGlow || 0).toFixed(2), attackT: +(e.attackT || 0).toFixed(2), recoilT: +(e.recoilT || 0).toFixed(2), stun: +(e.stunTimer || 0).toFixed(2) };
      return { ...best, hMin: lo, hMax: hi, pose };
    }, i);
    const body = Math.min(b.y + b.h, b.footY) - b.y;
    // Top ~10% of the head: 3% of the drawn body height below the top edge, on the body axis
    const pt = { x: aimPoint(b, 0).x, y: Math.round(b.y + Math.max(2, body * 0.03)) };
    await game.page.mouse.move(pt.x, pt.y);
    await game.advance(0.08);
    const aim = await game.eval(({ pt, i }) => {
      const e = __g13.list[i];
      const picked = typeof pickEnemyAtScreen === 'function' ? pickEnemyAtScreen(pt.x - worldOffsetX, pt.y - worldOffsetY) === e : null;
      let d = player.aimAngle - Math.atan2(e.y - player.y, e.x - player.x);
      d = Math.atan2(Math.sin(d), Math.cos(d));
      return { picked, aimErrDeg: Math.abs(d) * 180 / Math.PI };
    }, { pt, i });
    const { hits } = await fireAt(game, pt, i);
    rows.push({ who: `boss(base ${base}) ${Math.round(b.h)}px tall (drawn ${Math.round(b.hMin)}-${Math.round(b.hMax)}px over 1.5 s, pose ${JSON.stringify(b.pose)})`, hit: hits[i], ...aim, below: pt.y - Math.round(b.y) });
  }
  const text = rows.map((r) => `${r.who}, cursor ${r.below}px below its top: aim ${r.aimErrDeg.toFixed(1)} deg off its feet, ` +
    `pickEnemyAtScreen ${r.picked === null ? 'n/a' : r.picked ? 'picks it' : 'NO'}, shot ${r.hit ? 'HIT' : 'miss'}`);
  testInfo.annotations.push({ type: 'G13 boss head-top pick', description: text.join(' | ') });
  console.log(`G13 boss head-top pick:\n${text.join('\n')}`);
  for (const r of rows) {
    expect(r.aimErrDeg, `${r.who}: the aim snaps to the picked boss`).toBeLessThan(1);
    if (r.picked !== null) expect(r.picked, `${r.who}: pickEnemyAtScreen returns the boss`).toBe(true);
    expect(r.hit, `${r.who}: the shot hits`).toBe(true);
  }
});

test('G13: while an enemy is picked, the player\'s gun points at its torso', async ({ game }, testInfo) => {
  test.setTimeout(T(120_000));
  await setupArena(game, 3);
  const rows = [];
  // Close and tall targets, where the cursor (on the head) and the torso differ most
  for (const [target, dirName, dist] of [[0, 'right', 100], [2, 'left', 120], [11, 'right', 160], [BOSS, 'left', 200], [3, 'down', 140]]) {
    const i = await placeAndRender(game, target, DIRS[dirName], dist);
    const b = await game.eval((i) => __g13.prepBounds(i), i);
    const head = aimPoint(b, PARTS.head), torso = aimPoint(b, PARTS.torso);
    // Deterministic: no random idle fidget (it moves the drawn barrel tip), the camera has
    // settled, and the angle is the median over 12 consecutive frames (the tip sits on the
    // art-pixel grid and the idle bob moves it by a pixel).
    await game.eval(() => { player.idleT = 0; player.fidgetT = 0; });
    await game.page.mouse.move(head.x, head.y);
    await game.advance(0.5);
    const r = await game.eval(({ torso }) => new Promise((resolve) => {
      const errs = [];
      const tick = () => {
        player.idleT = 0; player.fidgetT = 0;
        if (_sp.pTipValid) {
          // Drawn barrel tip -> enemy torso, vs the drawn aim angle (P.aim = player.angle)
          const tx = _sp.pTipX + worldOffsetX, ty = _sp.pTipY + worldOffsetY;
          let d = player.angle - Math.atan2(torso.y - ty, torso.x - tx);
          d = Math.atan2(Math.sin(d), Math.cos(d));
          errs.push(Math.abs(d) * 180 / Math.PI);
        }
        if (errs.length < 12) requestAnimationFrame(tick);
        else {
          errs.sort((a, b) => a - b);
          resolve({ errDeg: errs[errs.length >> 1], minDeg: errs[0], maxDeg: errs[errs.length - 1] });
        }
      };
      requestAnimationFrame(tick);
    }), { torso });
    rows.push({ who: `${label(target)} ${dirName} ${dist}u`, ...(r || { errDeg: NaN }) });
  }
  const text = rows.map((r) => `${r.who}: gun ${r.errDeg.toFixed(2)} deg off (frames ${r.minDeg?.toFixed(2)}-${r.maxDeg?.toFixed(2)}) the line from the barrel tip to the torso`);
  testInfo.annotations.push({ type: 'G13 gun angle', description: text.join(' | ') });
  console.log(`G13 gun angle with the cursor on the head:\n${text.join('\n')}`);
  // Bar 12 deg, not 10 (Ralph's rule for a geometric residual): the angle is measured from the
  // DRAWN barrel tip, which sits off the aim origin (player centre), so at close range the
  // line tip->torso differs from centre->torso by a fixed amount (t0 at 100u: 10.2-10.7 deg in
  // every run), plus one low-res art pixel of quantization (~1-1.5 deg at 100-140u; t3 below
  // at 140u: 8.3-10.1 deg across runs). Per-run sampling noise is removed above (median of 12).
  for (const r of rows) expect(r.errDeg, `${r.who}: the gun points at the picked enemy's torso`).toBeLessThanOrEqual(12);
});

