// =====================================================================
// GRENADES (M9 N1) - thrown on F, ballistic arc, bounce, 1.8 s fuse
// =====================================================================
// Contract (renderer / HUD / demo / tests read these):
//   grenades[]       live grenades { x, y, z, vx, vy, vz, t, fuse, bounces,
//                    inWater, sinkT, spin }  (t = s since the throw)
//   player.grenades  ammo; player.grenadeCd = throw cooldown left (s)
//   throwGrenade(tx, ty) -> bool   player throw toward a world point
//   grenadeExplode(g)              RPG explosion path; geyser in water
//   spawnGeyser(x, y, R)           water column + ripple ring + spray
//   grenadeStats()                 { live, thrown, exploded, geysers, ammo }
// The fuse runs on game time (update dt), so hit-stop pauses it.

const grenades = [];
const _grenadeStats = { thrown: 0, exploded: 0, geysers: 0 };
const GRENADE_HAND_Z = 14;      // release height (art: hand)
const GRENADE_OBST_Z = 30;      // below this, trunks/crates/rocks bounce it
const GRENADE_BOUNCE_VZ = 0.3;  // vertical restitution per bounce
const GRENADE_BOUNCE_V = 0.3;   // horizontal speed kept per bounce
const GRENADE_ROLL_FRICTION = 10;
const OPT_SPRAY = { friction: 1, shrink: false, zGravity: 650, fadeStart: 0.15 }; // no bounce on water
const OPT_RIPPLE = { friction: 1, shrink: false, fadeStart: 0.5, alpha: 0.7 };

function _grenadeOnWater(x, y) {
  const ts = CFG.TILE_SIZE; // same tile snap as the water slowdown (E0)
  return getTerrainTypeAt(Math.floor(x / ts) * ts, Math.floor(y / ts) * ts) === 'water';
}

// Throw from player p (default P1) toward (tx, ty); range clamps to
// GRENADE_RANGE. Arc apex ~0.3 x distance, flight 0.6-0.9 s (N1)
function throwGrenade(tx, ty, p = player) {
  if (!p || p.grenades <= 0 || p.grenadeCd > 0) return false;
  let dx = tx - p.x, dy = ty - p.y;
  let d = Math.sqrt(dx * dx + dy * dy);
  if (d > CFG.GRENADE_RANGE) { dx *= CFG.GRENADE_RANGE / d; dy *= CFG.GRENADE_RANGE / d; d = CFG.GRENADE_RANGE; }
  const T = 0.6 + 0.3 * (d / CFG.GRENADE_RANGE);
  const h = Math.max(8, 0.3 * d);
  // z(t) = z0 + vz t - g t^2 / 2, apex ~h, landing z(T) = 0 at the target
  const g = 8 * h / (T * T), vz = 4 * h / T - GRENADE_HAND_Z / T;
  grenades.push({
    x: p.x, y: p.y, z: GRENADE_HAND_Z,
    vx: dx / T, vy: dy / T, vz, g,
    t: 0, fuse: CFG.GRENADE_FUSE, bounces: 0,
    inWater: false, sinkT: 0, spin: Math.random() * 6.28,
    born: true, // the throw frame's dt doesn't count toward the fuse
    by: p.num - 1, // M11: thrower (players[] index)
  });
  p.grenades--;
  p.grenadeCd = CFG.GRENADE_COOLDOWN;
  _grenadeStats.thrown++;
  playSound('grenade_throw', 0.5);
  return true;
}

function _grenadeObstacleBounce(gr) {
  for (let i = 0; i < envObjects.length; i++) {
    const o = envObjects[i];
    const dx = gr.x - o.x, dy = gr.y - o.y;
    if (dx > 60 || dx < -60 || dy > 60 || dy < -60) continue;
    if (o._envAt !== _envEpoch) envObjState(o);
    const r = (o.collision || 0) + 3;
    if (r <= 3) continue;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r * r || d2 === 0) continue;
    const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
    const vn = gr.vx * nx + gr.vy * ny;
    gr.x = o.x + nx * r; gr.y = o.y + ny * r;
    if (vn < 0) {
      gr.vx = (gr.vx - 2 * vn * nx) * 0.5;
      gr.vy = (gr.vy - 2 * vn * ny) * 0.5;
      playSound('grenade_bounce', 0.35);
    }
  }
}

function updateGrenades(dt) {
  for (let i = 0; i < players.length; i++) { // M11: every player's cooldown
    const p = players[i];
    if (p && p.grenadeCd > 0) p.grenadeCd = Math.max(0, p.grenadeCd - dt);
  }
  for (let i = grenades.length - 1; i >= 0; i--) {
    const gr = grenades[i];
    if (gr.born) gr.born = false; else gr.t += dt;
    if (gr.inWater) {
      gr.sinkT += dt;
    } else {
      gr.x += gr.vx * dt; gr.y += gr.vy * dt;
      if (gr.z > 0 || gr.vz > 0) {
        gr.vz -= gr.g * dt;
        gr.z += gr.vz * dt;
        gr.spin += dt * 14;
      }
      if (gr.z < GRENADE_OBST_Z) _grenadeObstacleBounce(gr);
      if (gr.z <= 0 && gr.vz <= 0) {
        gr.z = 0;
        if (_grenadeOnWater(gr.x, gr.y)) {
          // Sinks where it lands: plop, then the geyser on the fuse
          gr.inWater = true; gr.vx = gr.vy = gr.vz = 0;
          for (let k = 0; k < 6; k++) {
            const a = Math.random() * Math.PI * 2;
            spawnParticle(gr.x, gr.y, Math.cos(a) * 30, Math.sin(a) * 30, 0.35, 1.5,
              0xcfe8ff, 'debris', OPT_DEBRIS, 2, randRange(60, 120));
          }
        } else if (gr.bounces < 2 && gr.vz < -40) {
          gr.vz = -gr.vz * GRENADE_BOUNCE_VZ;
          gr.vx *= GRENADE_BOUNCE_V; gr.vy *= GRENADE_BOUNCE_V;
          gr.bounces++;
          playSound('grenade_bounce', 0.35);
        } else {
          gr.vz = 0;
          const k = Math.exp(-GRENADE_ROLL_FRICTION * dt);
          gr.vx *= k; gr.vy *= k;
        }
      }
    }
    if (gr.t >= gr.fuse - 1e-6) {
      grenades.splice(i, 1);
      grenadeExplode(gr);
    }
  }
}

// N1 ruling (a): the RPG path with a pseudo-round of dmg 200, R 140 -> splash
// 0.7 x 200 x (1 - d/R); no direct hit, no self-damage. In water: a geyser
// at R x 0.7 instead of the fireball/scorch (W5 untouched)
function grenadeExplode(gr) {
  _grenadeStats.exploded++;
  dmgBy = gr.by || 0; // M11 K6: the thrower's kills (queued with the splash)
  const dmg = CFG.GRENADE_DMG;
  if (gr.inWater) {
    const R = CFG.GRENADE_RADIUS * CFG.GRENADE_GEYSER_SCALE;
    spawnGeyser(gr.x, gr.y, R);
    splashDamage(gr.x, gr.y, dmg, R, SRC_EXPLOSIVE, gr.vx, gr.vy);
  } else {
    spawnExplosion(gr.x, gr.y, CFG.GRENADE_RADIUS, true, SRC_EXPLOSIVE, 'grenade', dmg);
    splashDamage(gr.x, gr.y, dmg, CFG.GRENADE_RADIUS, SRC_EXPLOSIVE, gr.vx, gr.vy);
  }
}

// Water geyser: white/blue column, ring of ripples, spray. No scorch decal;
// the environment still feels the blast (E2 sway)
function spawnGeyser(x, y, R) {
  _grenadeStats.geysers++;
  const k = R / 100;
  // Column: stacked foam blobs shot straight up, falling back as spray
  for (let i = 0; i < 18; i++) {
    spawnParticle(x + randRange(-6, 6) * k, y + randRange(-4, 4) * k,
      randRange(-12, 12), randRange(-8, 8), randRange(0.7, 1.1), randRange(4, 8) * k,
      i & 1 ? 0xf0f8ff : 0x8cc4ec, 'debris', OPT_SPRAY, randRange(0, 10), randRange(260, 460) * Math.sqrt(k));
  }
  // Spray: droplets thrown outward
  for (let i = 0; i < 24; i++) {
    const a = Math.random() * Math.PI * 2, sp = randRange(60, 180) * Math.sqrt(k);
    spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp, randRange(0.5, 0.9), randRange(1, 2),
      i & 1 ? 0xffffff : 0x9fd0f0, 'debris', OPT_SPRAY, randRange(4, 16), randRange(120, 260));
  }
  // Ripple ring: mist blobs on an expanding circle at the surface
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2, sp = R / 0.6; // reaches ~R as it fades
    spawnParticle(x + Math.cos(a) * 8, y + Math.sin(a) * 8, Math.cos(a) * sp, Math.sin(a) * sp,
      0.6, randRange(3, 5), 0xd8ecff, 'smoke', OPT_RIPPLE, 0, 0);
  }
  addShake(Math.min(10, 2 + R * 0.05));
  playSound('geyser', Math.min(1, R / 100));
  if (typeof envBlast === 'function') envBlast(x, y, R, true, SRC_EXPLOSIVE, CFG.GRENADE_DMG, true);
}

function grenadeStats() {
  return { live: grenades.length, thrown: _grenadeStats.thrown, exploded: _grenadeStats.exploded,
    geysers: _grenadeStats.geysers, ammo: player ? player.grenades : 0 };
}

function resetGrenades() {
  grenades.length = 0;
  _grenadeWant = false;
  _grenadeStats.thrown = _grenadeStats.exploded = _grenadeStats.geysers = 0;
}
