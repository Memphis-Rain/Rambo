// The M9 perf scene, shared by tests/e2e/m9.spec.js (M9PERF, SwiftShader ratio) and
// tests/perf/m9.mjs (npm run perf:m9, real GPU). Both functions run in the page via
// page.evaluate(); hook names come in as `h` (window[h.name]).

/**
 * In-page: a spot with dry land within 240u and a 3x3 pond 280-480u away that is on screen,
 * or null. The world is random per load (utils.js shuffles the noise with Math.random): out
 * to r = 8000 a quarter of worlds had none; out to 32000 none of 300 vm-loaded worlds missed
 * (worst search 0.45 s). Callers still re-roll the world on null (M9_SITE_TRIES).
 */
export const FIND_M9_SPOT = () => {
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
  for (let r = 0; r <= 32000; r += 160) {
    for (let a = 0; a < 16; a++) {
      const x = player.x + Math.cos((a / 16) * Math.PI * 2) * r, y = player.y + Math.sin((a / 16) * Math.PI * 2) * r;
      if (!dryDisc(x, y, 240)) continue;
      const pond = pondNear(x, y);
      if (pond) return { spot: { x, y }, pond };
    }
  }
  return null;
};

/** Worlds to try (a page reload each) before a run fails for want of an M9 site. */
export const M9_SITE_TRIES = 4;

/**
 * In-page steady M9 load. The scene is about load, not aim:
 * - 20 enemies (hp 1e9, no shooting, speed 30 so they really panic-run) stand in a block beside
 *   the player; any that is not burning is lit directly with igniteEnemy (h.ignite). A
 *   non-piercing stream only ever reaches the front of a packed block. Runners past 120u are
 *   pulled back to their slot.
 * - The player holds the flamethrower: on a fresh tree while fewer than 10 burn (15 trees
 *   opposite the pond, re-planted when charred), otherwise into the enemy block, so flames and
 *   ground fires stay in the scene.
 * - A kill in the pond every 3 game-s keeps it red after 20 kills at the start.
 * Samples the scenario every frame into window.__m9load.samples.
 */
export const M9_LOAD = ({ h, spot, pond }) => {
  const pondA = Math.atan2(pond.y - spot.y, pond.x - spot.x);
  const treeA = pondA + Math.PI, enemyA = pondA + Math.PI / 2;
  const S = window.__m9load = { stop: false, seq: 0, t0: gameTime, nextPondKill: 0, trees: [], slots: [], samples: [] };
  for (const r of [130, 170, 205]) for (let k = -2; k <= 2; k++) S.trees.push({ x: spot.x + Math.cos(treeA + (k * 45) / r) * r, y: spot.y + Math.sin(treeA + (k * 45) / r) * r, obj: null });
  for (const r of [95, 125, 155, 185]) for (let k = -2; k <= 2; k++) S.slots.push({ x: spot.x + Math.cos(enemyA + (k * 30) / r) * r, y: spot.y + Math.sin(enemyA + (k * 30) / r) * r, e: null });
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
        if (s.e) { s.e.hp = s.e.maxHp = 1e9; s.e.speed = 30; s.e.fireTimer = 1e9; }
      } else if (Math.hypot(s.e.x - s.x, s.e.y - s.y) > 120) { s.e.x = s.x; s.e.y = s.y; s.e.vx = 0; s.e.vy = 0; }
      if (s.e && !burning(s.e)) window[h.ignite](s.e);
    }
    if (el >= S.nextPondKill) { S.nextPondKill += 3; pondKill(Math.round(el) % 2); }
    const trees = envStats().burningTrees || 0;
    let target = null;
    if (trees < 10) {
      const t = S.trees.find((s) => { const st = envState(s.obj.id); return !st.charred && !((st.fire || 0) > 0); });
      if (t) target = t;
    }
    if (!target) target = S.slots[2].e || S.slots[2];
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
