// =====================================================================
// COMBAT SYSTEM - Player, Enemies, Bullets, Bosses, Pickups
// =====================================================================

// =====================================================================
// PLAYER
// =====================================================================
function createPlayer() {
  return {
    x: 0, y: 0, vx: 0, vy: 0,
    hp: CFG.PLAYER_MAX_HP, maxHp: CFG.PLAYER_MAX_HP,
    shield: CFG.PLAYER_MAX_SHIELD, maxShield: CFG.PLAYER_MAX_SHIELD,
    angle: 0, aimAngle: 0,
    weapon: 0, fireTimer: 0,
    magAmmo: WEAPONS[0].mag,
    reloading: false, reloadTimer: 0,
    walking: false,
    dodging: false, dodgeTimer: 0, dodgeCooldown: 0, dodgeAngle: 0,
    invincible: 0, spinUp: 0, hitFlash: 0,
    damageNumbers: [],
    specialCharge: 0, specialCooldown: 0,
    // Animation state (render-only)
    walkDist: 0, recoilT: 0, recoilMag: 0,
    idleT: 0, fidgetT: 0,
    bloodyFeet: 0, footStep: 0, hurtFlash: 0,
    grenades: CFG.GRENADE_AMMO_START, grenadeCd: 0, wavesStarted: 0, // N1
    // M11: 1 = P1, 2 = P2; 'up' | 'down' | 'dead' (K5); own score / kills (team totals stay global)
    num: 1, state: 'up', score: 0, kills: 0,
  };
}

// M11 K1: a player that can be hit, picked up after and chased (K5 adds DOWN)
function playerStanding(p) { return !!p && p.state === 'up'; }

// The nearest standing player to (x, y), or null
function nearestPlayer(x, y) {
  let best = null, bd = Infinity;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!playerStanding(p)) continue;
    const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// The player an enemy goes for (K6 adds re-pick timing and hysteresis)
function enemyTarget(e) {
  const p = nearestPlayer(e.x, e.y) || player;
  e.target = p;
  return p;
}

// Hit-stop (G9): the main loop skips update() while this is above 0.
// Only boss kills and explosions with radius >= 100 trigger it; each stop
// is <= HIT_STOP_MAX and a new one needs HIT_STOP_COOLDOWN of simulated
// time after the previous one (gameTime is frozen during the stop itself).
const HIT_STOP_MAX = 0.06, HIT_STOP_COOLDOWN = 0.3;
let hitStopTimer = 0;
let _hitStopReadyAt = 0;
function addHitStop(sec) {
  if (hitStopTimer > 0) return;
  if (gameTime < _hitStopReadyAt) return;
  hitStopTimer = Math.min(HIT_STOP_MAX, sec);
  _hitStopReadyAt = gameTime + HIT_STOP_COOLDOWN;
}
// resetRound() calls this (gameTime restarts at 0, so the cooldown must too)
function resetHitStop() { hitStopTimer = 0; _hitStopReadyAt = 0; }

// Damage sources (decide death style: corpse, gibs, disintegration)
const SRC_BULLET = 0, SRC_EXPLOSIVE = 1, SRC_BFG = 2, SRC_RAIL = 3, SRC_DISINT = 4, SRC_SHOCK = 5, SRC_FIRE = 6;

// Render-only animation timers shared by player and enemies
function _tickAnimTimers(o, dt) {
  if (o.recoilT > 0) o.recoilT -= dt;
  if (o.attackT > 0) o.attackT -= dt;
  if (o.healPulse > 0) o.healPulse -= dt;
  if (o.healGlow > 0) o.healGlow -= dt;
}

// Bloody footprints (G7) after walking through a pool
function _updateFootprints(p, dt) {
  // W3: no prints on water, and wading washes the feet
  if (waterTileAt(p.x, p.y)) { p.bloodyFeet = 0; return; }
  if (isBloodAt(p.x, p.y)) p.bloodyFeet = 3;
  if (p.bloodyFeet <= 0) return;
  p.bloodyFeet -= dt;
  const step = Math.floor(p.walkDist / 15);
  if (step === p.footStep) return;
  p.footStep = step;
  if (!p.walking) return;
  const a = Math.atan2(p.vy, p.vx);
  const side = (step & 1) ? 3 : -3;
  const d = bloodDecal(DECAL_FOOT, p.x - Math.sin(a) * side, p.y + Math.cos(a) * side, 2, BLOOD_COLORS[3], a);
  if (d) d.alpha = p.bloodyFeet > 2 ? 0.9 : p.bloodyFeet > 1 ? 0.6 : 0.35; // null: landed on water (W3)
}

function updatePlayer(dt) {
  if (keys['f']) {
    if (!_grenadeKeyHeld) { _grenadeKeyHeld = true; _grenadeWant = true; }
  } else _grenadeKeyHeld = false;
  const p = player;
  if (!p) return;
  const px0 = p.x, py0 = p.y;
  _tickAnimTimers(p, dt);
  if (p.hurtFlash > 0) p.hurtFlash = Math.max(0, p.hurtFlash - dt * 2.5);

  // Regen
  p.hp = Math.min(p.hp + CFG.PLAYER_REGEN * dt, p.maxHp);

  // Shield regen (after delay)
  shieldRegenTimer += dt;
  if (shieldRegenTimer >= CFG.SHIELD_REGEN_DELAY && p.shield < p.maxShield) {
    p.shield = Math.min(p.shield + CFG.SHIELD_REGEN * dt, p.maxShield);
  }

  if (p.invincible > 0) p.invincible -= dt;
  if (p.hitFlash > 0) p.hitFlash -= dt;
  if (p.specialCooldown > 0) p.specialCooldown -= dt;

  // Dodge
  if (p.dodgeCooldown > 0) p.dodgeCooldown -= dt;
  if (p.dodging) {
    p.dodgeTimer -= dt;
    if (p.dodgeTimer <= 0) {
      p.dodging = false;
      p.invincible = 0.15;
    } else {
      p.vx = Math.cos(p.dodgeAngle) * CFG.DODGE_SPEED;
      p.vy = Math.sin(p.dodgeAngle) * CFG.DODGE_SPEED;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      coopApplyLeash(p); // M11 K3b
      if (Math.random()<0.3) spawnSmoke(p.x, p.y, 1);
      return;
    }
  }

  // Movement
  let sx=0, sy=0;
  if (keys['w'] || keys['arrowup']) sy -= 1;
  if (keys['s'] || keys['arrowdown']) sy += 1;
  if (keys['a'] || keys['arrowleft']) sx -= 1;
  if (keys['d'] || keys['arrowright']) sx += 1;

  // M10: the left stick moves in any direction, speed scaled by magnitude
  // (full from 0.9 up); keys win when both are used
  let padK = 1;
  if (sx === 0 && sy === 0 && inputDevice === 'pad' && pad.lmag > 0) {
    sx = pad.lx; sy = pad.ly; padK = Math.min(1, pad.lmag / 0.9);
  }
  const len = Math.sqrt(sx*sx+sy*sy);
  if (len > 0) {
    sx /= len; sy /= len;
    const isoScale = CFG.ISO_SCALE;
    const worldDx = sx * 0.5 / 1 + sy * 0.5 / isoScale;
    const worldDy = -sx * 0.5 / 1 + sy * 0.5 / isoScale;
    const wLen = Math.sqrt(worldDx*worldDx + worldDy*worldDy);
    let speed = CFG.PLAYER_SPEED * padK;
    if (keys['shift']) speed *= CFG.SPRINT_MULT;
    p.vx = (worldDx/wLen) * speed;
    p.vy = (worldDy/wLen) * speed;
    p.walking = true;
  } else {
    p.vx = 0; p.vy = 0;
    p.walking = false;
  }

  // Water slowdown + splash (snap to tile grid to match rendered terrain)
  const _ts = CFG.TILE_SIZE;
  const pTerrain = getTerrainTypeAt(Math.floor(p.x / _ts) * _ts, Math.floor(p.y / _ts) * _ts);
  if (pTerrain === 'water') {
    p.vx *= 0.55;
    p.vy *= 0.55;
    if (p.walking && Math.random() < 0.4) {
      const a = Math.random() * Math.PI * 2;
      spawnParticle(p.x + Math.cos(a)*6, p.y + Math.sin(a)*6,
        Math.cos(a)*30 + p.vx*0.3, -20 - Math.random()*15,
        0.3 + Math.random()*0.2, 2 + Math.random()*2,
        'rgba(120,180,220,', 'smoke', {gravity:60, friction:0.92, fadeStart:0.3});
    }
  }

  // E11: climbing over a fallen log (a hurdle, not a wall) is slow
  if (envLogs.length) { const ls = envLogSlow(p.x, p.y, 10); p.vx *= ls; p.vy *= ls; }

  p.x += p.vx * dt;
  p.y += p.vy * dt;
  coopApplyLeash(p); // M11 K3b: only at COOP_ZOOM_MIN with a partner

  // Collision with trees, rocks, boulders
  resolveEnvCollision(p, 10);

  // Walk cycle phase follows distance actually travelled (A1)
  if (p.walking) p.walkDist += dist(px0, py0, p.x, p.y);
  _updateFootprints(p, dt);

  // Idle fidget (A2)
  if (p.walking || mouseDown) { p.idleT = 0; p.fidgetT = 0; }
  else {
    p.idleT += dt;
    if (p.fidgetT > 0) p.fidgetT -= dt;
    else if (p.idleT > 3 && Math.random() < dt * 0.6) p.fidgetT = 0.7;
  }

  // Mouse aiming
  // Map through the offset the world was actually drawn at (Q5: exact with pixel snapping)
  // and the K3a zoom: (mx, my) = the cursor in zoom-1 iso screen units
  const z = cam.z;
  const ox = worldOffsetX !== null ? worldOffsetX : W/2 - cam.x * z;
  const oy = worldOffsetY !== null ? worldOffsetY : H/2 - cam.y * z;
  const mx = (mouseX - ox) / z, my = (mouseY - oy) / z;
  const worldMouse = toWorld(mx, my);
  mouseWorldX = mouseGroundX = worldMouse.x;
  mouseWorldY = mouseGroundY = worldMouse.y;
  // G13: the cursor maps to the GROUND, so aiming at a head meant aiming at
  // the ground behind the enemy. Over an enemy's drawn body, aim at that
  // (front-most) enemy's ground centre instead. Not for the demo bot, which
  // already aims at led ground points.
  if (!(typeof demoActive !== 'undefined' && demoActive)) {
    const picked = pickEnemyAtScreen(mx, my);
    if (picked) { aimPointOf(picked, _aimPt); mouseWorldX = _aimPt.x; mouseWorldY = _aimPt.y; } // W2: visible column when wading
    _aimPicked = picked;
  } else _aimPicked = null;
  p.aimAngle = Math.atan2(mouseWorldY - p.y, mouseWorldX - p.x);
  const sp = toScreen(p.x, p.y);
  let smx = mx - sp.x;
  let smy = my - sp.y;
  if (_aimPicked) { // G13: point the gun where the shot goes (the picked torso),
    // measured from the gun hand's height (8 art px up), not the feet
    const e = _aimPicked;
    smx = (e.x - e.y) - sp.x;
    const th = e.submerge > 0 ? (entityWaterlineH(e) + ENEMY_BODY_H * e.size) * 0.5 : ENEMY_PICK_H * 0.45 * e.size;
    smy = (e.x + e.y) * CFG.ISO_SCALE - th - (sp.y - PLAYER_HAND_H);
  }
  p.angle = Math.atan2(smy, smx);

  // Weapon switching (1-9, 0 for 10th, - for 11th)
  const keyMap = ['1','2','3','4','5','6','7','8','9','0','-'];
  for(let i=0;i<WEAPONS.length;i++){
    if (keys[keyMap[i]] && i < unlockedWeapons) {
      if (p.weapon !== i) {
        p.weapon = i;
        p.magAmmo = WEAPONS[i].mag;
        p.reloading = false; p.reloadTimer = 0;
        p.spinUp = 0; p.fireTimer = 0;
      }
    }
  }
  if (keys['q']) {
    keys['q'] = false;
    p.weapon = (p.weapon - 1 + unlockedWeapons) % unlockedWeapons;
    p.magAmmo = WEAPONS[p.weapon].mag; p.reloading = false; p.spinUp = 0;
  }
  if (keys['e']) {
    keys['e'] = false;
    p.weapon = (p.weapon + 1) % unlockedWeapons;
    p.magAmmo = WEAPONS[p.weapon].mag; p.reloading = false; p.spinUp = 0;
  }
  // N1: grenade on F key-down, once per press (key repeat ignored; a press
  // during a dodge roll is latched at the top of updatePlayer)
  if (_grenadeWant) { // M10: B throws at the pad reticle
    _grenadeWant = false;
    if (inputDevice === 'pad') throwGrenade(padAim.x, padAim.y); else throwGrenade(mouseGroundX, mouseGroundY);
  }

  // Reload
  const wep = WEAPONS[p.weapon];
  if (p.reloading) {
    p.reloadTimer -= dt;
    if (p.reloadTimer <= 0) { p.reloading = false; p.magAmmo = wep.mag; }
  }
  if (keys['r'] && !p.reloading && p.magAmmo < wep.mag) {
    p.reloading = true; p.reloadTimer = wep.reload;
  }

  // Dodge roll
  if (keys[' '] && !p.dodging && p.dodgeCooldown <= 0) {
    keys[' '] = false;
    p.dodging = true; p.dodgeTimer = CFG.DODGE_DURATION;
    p.dodgeCooldown = CFG.DODGE_COOLDOWN;
    p.dodgeAngle = len > 0 ? Math.atan2(p.vy, p.vx) : p.angle;
    spawnSmoke(p.x, p.y, 4);
  }

  // === RIGHT-CLICK SPECIAL: SHOCKWAVE ===
  if (mouseRightJustPressed && p.specialCharge >= CFG.SPECIAL_MAX_CHARGE && p.specialCooldown <= 0) {
    mouseRightJustPressed = false;
    p.specialCharge = 0;
    p.specialCooldown = 0.5;
    // Shockwave effect
    spawnShockwaveEffect(p.x, p.y);
    playSound('shockwave', 0.9);
    addShake(20);
    // Damage all nearby enemies (deferred to avoid array mutation issues)
    for(let j=enemies.length-1;j>=0;j--){
      const e = enemies[j];
      if(e.dead) continue;
      const d = dist(p.x, p.y, e.x, e.y);
      if(d < CFG.SPECIAL_RADIUS){
        const kb = 400 / (ENEMY_TYPES[e.type].size);
        e.stunTimer = 0.4;
        e.knockbackX = (e.x-p.x)/d * kb;
        e.knockbackY = (e.y-p.y)/d * kb;
        _pendingDamage.push({ target: e, dmg: CFG.SPECIAL_DAMAGE * (1 - d/CFG.SPECIAL_RADIUS), angle: Math.atan2(e.y-p.y, e.x-p.x), src: SRC_SHOCK });
      }
    }
  }
  mouseRightJustPressed = false;

  // Shooting
  p.fireTimer -= dt;
  if (wep.spinUp && mouseDown && !p.reloading) {
    p.spinUp = Math.min(p.spinUp + dt * 2, 1);
  } else {
    p.spinUp = Math.max(p.spinUp - dt * 3, 0);
  }

  const canShoot = wep.auto ? mouseDown : mouseJustPressed;
  if (canShoot && !p.reloading && !p.dodging && p.fireTimer <= 0) {
    if (p.magAmmo > 0) {
      const canFire = !wep.spinUp || p.spinUp > 0.5;
      if (canFire) {
        mouseJustPressed = false;
        const rate = wep.spinUp ? wep.rate * (2 - p.spinUp) : wep.rate;
        p.fireTimer = rate;
        p.magAmmo--;
        if (p.magAmmo <= 0 && wep.mag !== Infinity) {
          p.reloading = true; p.reloadTimer = wep.reload;
        }

        const aim = p.aimAngle;
        const muzzleX = p.x + Math.cos(aim)*20;
        const muzzleY = p.y + Math.sin(aim)*20;
        for(let i=0;i<wep.count;i++){
          const bAngle = (wep.count > 1)
            ? aim + (i/(wep.count-1) - 0.5) * wep.spread * 2 + randRange(-wep.spread*0.3, wep.spread*0.3)
            : aim + randRange(-wep.spread, wep.spread);
          if (wep.flame) {
            spawnFlame(muzzleX, muzzleY, bAngle, wep); // F1: flame particles, not bullets
          } else if (bullets.length < CFG.MAX_BULLETS) {
            bullets.push({
              x: muzzleX, y: muzzleY,
              vx: Math.cos(bAngle)*wep.speed, vy: Math.sin(bAngle)*wep.speed,
              dmg: wep.dmg, life: 2, owner:'player',
              color: wep.color, size: wep.count>1?2:2.5,
              trail: wep.trail, pierce: wep.pierce,
              explosive: wep.explosive, radius: wep.radius||0,
              glow: wep.glow,
              beam: wep.beam, disintegrate: wep.disintegrate,
              bfg: wep.name === 'BFG', fresh: true,
            });
          }
        }

        // Recoil pose (A3): ~2 frames, size from weapon kickback
        p.recoilT = 0.04;
        p.recoilMag = Math.min(4, 1 + Math.round(wep.kickback / 5));
        p.idleT = 0; p.fidgetT = 0;
        spawnMuzzleFlash(muzzleX, muzzleY, aim, 0.7 + wep.kickback * 0.06);
        padRumble(Math.min(1, 0.15 + wep.kickback / 25), 0, Math.min(60, 25 + wep.kickback * 2)); // M10 C4
        if (wep.shellSize > 0) spawnShellCasing(p.x, p.y, aim, wep.shellSize);

        const soundMap = {0:'pistol',1:'smg',2:'shotgun',3:'rifle',4:'minigun',5:'rocket',6:'plasma',7:'flamethrower',8:'railgun',9:'bfg',10:'disintegrator'};
        playSound(soundMap[p.weapon] || 'pistol', 0.8);

        p.x -= Math.cos(aim) * wep.kickback * 0.3;
        p.y -= Math.sin(aim) * wep.kickback * 0.3;
        addShake(wep.kickback * 0.5);
      }
    }
  }

  if (p.magAmmo <= 0 && !p.reloading) {
    p.reloading = true; p.reloadTimer = wep.reload;
  }

  for(let i=p.damageNumbers.length-1;i>=0;i--){
    p.damageNumbers[i].life -= dt;
    if (p.damageNumbers[i].life <= 0) p.damageNumbers.splice(i,1);
  }
}

// =====================================================================
// ENEMIES
// =====================================================================
function spawnEnemy(type, x, y, bossData) {
  if (!bossData && enemies.length >= CFG.MAX_ENEMIES) return;
  const t = ENEMY_TYPES[type];
  const e = {
    x, y, vx:0, vy:0,
    hp: t.hp * (1 + wave*0.04),
    maxHp: t.hp * (1 + wave*0.04),
    type, speed: t.speed * randRange(0.9, 1.1),
    dmg: t.dmg, range: t.range,
    angle: 0, fireTimer: Math.random()*2,
    hitFlash: 0, size: t.size,
    stunTimer: 0, knockbackX:0, knockbackY:0,
    walking: false,
    walkDist: Math.random() * 40, recoilT: 0, attackT: 0, healPulse: 0, healGlow: 0, distToPlayer: 9999,
    shieldHp: t.hasShield ? t.shieldHp * (1 + wave*0.04) : 0,
    maxShieldHp: t.hasShield ? t.shieldHp * (1 + wave*0.04) : 0,
  };
  // Apply boss overrides
  if (bossData) {
    e.isBoss = true;
    e.bossName = bossData.name;
    e.hp = bossData.hp;
    e.maxHp = bossData.hp;
    e.size = t.size * 2.5;
    e.speed = Math.max(25, t.speed * 0.6);
    e.dmg = t.dmg * 1.5;
    if (t.hasShield) {
      e.shieldHp = bossData.hp * 0.3;
      e.maxShieldHp = bossData.hp * 0.3;
    }
  }
  enemies.push(e);
  return e;
}

function updateEnemies(dt) {
  for(let i=enemies.length-1;i>=0;i--) {
    const e = enemies[i];
    if (e.dead) { enemies.splice(i, 1); continue; } // cleanup strays
    const t = ENEMY_TYPES[e.type];
    _tickAnimTimers(e, dt);
    if (e.hitFlash > 0) e.hitFlash -= dt;

    // Wound drips (G7): below 50% HP, faster when nearly dead
    if (e.hp < e.maxHp * 0.5 && Math.random() < dt * (e.hp < e.maxHp * 0.25 ? 10 : 5)) {
      spawnBloodDrip(e.x, e.y, 14 * e.size);
    }

    if (e.stunTimer > 0) {
      e.stunTimer -= dt;
      e.x += e.knockbackX * dt;
      e.y += e.knockbackY * dt;
      e.knockbackX *= 0.9;
      e.knockbackY *= 0.9;
      resolveEnvCollision(e, 8 * e.size); // G2a: a hard push must not embed it in a tree/rock
      continue;
    }
    const ex0 = e.x, ey0 = e.y;

    const tp = enemyTarget(e); // M11 K1
    const dx = tp.x - e.x, dy = tp.y - e.y;
    const d = Math.sqrt(dx*dx+dy*dy);
    e.angle = Math.atan2(dy, dx);
    e.distToPlayer = d; // render telegraphs (bomber blink, sniper laser)

    // === F2: a burning (non-boss) enemy panics: no attacks, erratic run ===
    if (e.burnT > 0 && !e.isBoss) {
      firePanicMove(e, dt);
    // === MEDIC behavior ===
    } else if (t.healer) {
      // Try to heal nearby wounded enemies
      e.fireTimer -= dt;
      if (e.fireTimer <= 0) {
        for(const e2 of enemies) {
          if (e2 === e || e2.hp >= e2.maxHp) continue;
          const d2 = dist(e.x, e.y, e2.x, e2.y);
          if (d2 < 150) {
            e2.hp = Math.min(e2.hp + 25, e2.maxHp);
            e.fireTimer = t.fireRate;
            // Heal visual (A5): pulse on the medic, glow on the patient
            e.healPulse = 0.45;
            e2.healGlow = 0.3;
            spawnParticle(e2.x, e2.y, 0, 0, 0.4, 4, 0x40ff40, 'flash', OPT_FLASH, 20, 40);
            spawnParticle(e2.x, e2.y, 0, 0, 0.3, 3, 0xa0ffa0, 'flash', OPT_FLASH, 28, 30);
            break;
          }
        }
      }
      // Medic stays behind other enemies
      if (d > 200) {
        e.vx = (dx/d) * e.speed;
        e.vy = (dy/d) * e.speed;
        e.walking = true;
      } else {
        e.vx = -(dx/d) * e.speed * 0.7;
        e.vy = -(dy/d) * e.speed * 0.7;
        e.walking = true;
      }
    } else if (t.shoots) {
      // Ranged enemy
      if (d > t.range * 0.6) {
        e.vx = (dx/d) * e.speed;
        e.vy = (dy/d) * e.speed;
        e.walking = true;
      } else if (d < t.range * 0.4) {
        e.vx = -(dx/d) * e.speed * 0.5;
        e.vy = -(dy/d) * e.speed * 0.5;
        e.walking = true;
      } else {
        e.vx = 0; e.vy = 0;
        e.walking = false;
      }
      e.fireTimer -= dt;
      if (e.fireTimer <= 0 && d < t.range) {
        e.fireTimer = t.fireRate * randRange(0.8, 1.2);
        const spread = 0.15;
        // W2: at a wading player, aim at the visible body column
        const aim = tp.submerge > 0 ? Math.atan2(aimPointOf(tp, _aimPt).y - e.y, _aimPt.x - e.x) : e.angle;
        const a = aim + randRange(-spread, spread);
        const bs = t.bulletSpeed || 400;
        if (bullets.length < CFG.MAX_BULLETS) {
          bullets.push({
            x: e.x + Math.cos(a)*10, y: e.y + Math.sin(a)*10,
            vx: Math.cos(a)*bs, vy: Math.sin(a)*bs,
            dmg: e.dmg * (1 + wave*0.02), life:2, owner:'enemy',
            color:'#f44', size:2, trail:false,
            explosive: t.explosive, radius: t.explosive?60:0,
          });
        }
        e.recoilT = 0.06;
        spawnMuzzleFlash(e.x + Math.cos(a)*10, e.y + Math.sin(a)*10, a, t.explosive ? 1.6 : 0.8, 14 * e.size, e);
      }
    } else {
      // Melee enemy
      if (d > e.range) {
        e.vx = (dx/d) * e.speed;
        e.vy = (dy/d) * e.speed;
        e.walking = true;
      } else {
        e.vx = 0; e.vy = 0;
        e.walking = false;
        e.fireTimer -= dt;
        if (e.fireTimer <= 0) {
          e.fireTimer = 0.8;
          e.attackT = 0.25; // melee swing pose
          damagePlayer(e.dmg, tp);
        }
      }
    }

    // E11: round a log's near end, or climb straight over it
    if (envLogs.length && (e.vx || e.vy)) _enemyLogAvoid(e, 8 * e.size, d, dt);
    else e.logAvoid = null;

    // Separation
    for(let j=0;j<enemies.length;j++){
      if(i===j) continue;
      const ox=e.x-enemies[j].x, oy=e.y-enemies[j].y;
      const od=Math.sqrt(ox*ox+oy*oy);
      if(od < 25*e.size && od > 0){
        e.vx += (ox/od)*80;
        e.vy += (oy/od)*80;
      }
    }

    // Water slowdown + splash for enemies (snap to tile grid to match rendered terrain)
    const ets = CFG.TILE_SIZE;
    const eTerrain = getTerrainTypeAt(Math.floor(e.x / ets) * ets, Math.floor(e.y / ets) * ets);
    if (eTerrain === 'water') {
      e.vx *= 0.75;
      e.vy *= 0.75;
      if (e.walking && Math.random() < 0.2) {
        const a = Math.random() * Math.PI * 2;
        spawnParticle(e.x + Math.cos(a)*5, e.y + Math.sin(a)*5,
          Math.cos(a)*20, -15 - Math.random()*10,
          0.25 + Math.random()*0.15, 1.5 + Math.random()*1.5,
          'rgba(120,180,220,', 'smoke', {gravity:50, friction:0.9, fadeStart:0.3});
      }
    }

    // E11: climbing over a log is slow
    const ls = envLogs.length ? envLogSlow(e.x, e.y, 8 * e.size) : 1;
    e.x += e.vx * ls * dt;
    e.y += e.vy * ls * dt;

    // Collision with trees, rocks, boulders
    resolveEnvCollision(e, 8 * e.size);

    if (e.walking) e.walkDist = (e.walkDist || 0) + dist(ex0, ey0, e.x, e.y);
  }
}

// E11: logs are hurdles. An enemy whose straight path (toward the player, or
// along its velocity) would run over a log close to one of its ends
// (crossing point within CFG.ENV_LOG_END_DETOUR x the log width of the end)
// walks round that end, hugging the log; anywhere else it climbs straight
// over (slowed by envLogSlow). Decided afresh each frame: walking toward the
// end keeps the crossing point near it, so the choice is stable, and it
// stops as soon as the straight path clears the log.
// e.logAvoid = log being walked round (null when going straight), e.logSide,
// e.logDetT (detour time), e.logClimbT (climb-straight time left).
let _xT = 0; // param along the log of the last _pathLogHit()
// Does the segment (x0,y0)-(x1,y1) come within R of log r's axis? Sets _xT
// to where along the log (0..1) it crosses or comes closest.
function _pathLogHit(x0, y0, x1, y1, r, R) {
  const px = x1 - x0, py = y1 - y0, ax = r.bx - r.ax, ay = r.by - r.ay;
  const den = px * ay - py * ax;
  const qx = r.ax - x0, qy = r.ay - y0;
  if (den !== 0) {
    const s = (qx * ay - qy * ax) / den, t = (qx * py - qy * px) / den;
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) { _xT = t; return true; }
  }
  // no crossing: closest approach is at an endpoint of one of the segments
  const R2 = R * R, l2 = ax * ax + ay * ay, p2 = px * px + py * py;
  let best = Infinity, bt = 0;
  for (let k = 0; k < 2; k++) { // path endpoints vs the log
    const ex = k ? x1 : x0, ey = k ? y1 : y0;
    let t = l2 > 0 ? ((ex - r.ax) * ax + (ey - r.ay) * ay) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = r.ax + ax * t - ex, dy = r.ay + ay * t - ey, d2 = dx * dx + dy * dy;
    if (d2 < best) { best = d2; bt = t; }
  }
  for (let k = 0; k < 2; k++) { // log ends vs the path
    const ex = k ? r.bx : r.ax, ey = k ? r.by : r.ay;
    let s = p2 > 0 ? ((ex - x0) * px + (ey - y0) * py) / p2 : 0;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    const dx = x0 + px * s - ex, dy = y0 + py * s - ey, d2 = dx * dx + dy * dy;
    if (d2 < best) { best = d2; bt = k; }
  }
  _xT = bt;
  return best < R2;
}

function _enemyLogAvoid(e, er, dp, dt) {
  const near = CFG.ENV_LOG_AVOID_NEAR;
  // a detour that drags on (logs end to end, target right at an end): just
  // climb over for a while
  if (e.logClimbT > 0) { e.logClimbT -= dt; e.logAvoid = null; return; }
  if (e.logAvoid) e.logDetT = (e.logDetT || 0) + dt;
  else if (e.logDetT > 0) e.logDetT = Math.max(0, e.logDetT - dt * 0.5);
  const n = envLogsNear(e.x, e.y, er + near + CFG.ENV_LOG_R);
  const prevL = e.logAvoid;
  e.logAvoid = null;
  if (!n) return;
  const sp = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
  const ux = e.vx / sp, uy = e.vy / sp;
  // target of the straight path: the player when heading for them
  const tp = e.target || player;
  let tx = tp.x, ty = tp.y;
  if (dp <= 0 || (ux * (tx - e.x) + uy * (ty - e.y)) < 0.7 * dp) {
    tx = e.x + ux * 60; ty = e.y + uy * 60;
  } else if (dp > CFG.ENV_LOG_AVOID_LOOK) {
    tx = e.x + (tx - e.x) * CFG.ENV_LOG_AVOID_LOOK / dp; ty = e.y + (ty - e.y) * CFG.ENV_LOG_AVOID_LOOK / dp;
  }
  let best = null, bestD = Infinity, bestT = 0;
  for (let i = 0; i < n; i++) {
    const r = envLogHits[i];
    const R = er + r.logR;
    const ds2 = envSegDist2(e.x, e.y, r);
    if (ds2 < (R - 1) * (R - 1) || ds2 > (R + near) * (R + near)) continue; // already climbing / not close yet
    if (!_pathLogHit(e.x, e.y, tx, ty, r, R - 0.5)) continue;
    const len = Math.sqrt((r.bx - r.ax) * (r.bx - r.ax) + (r.by - r.ay) * (r.by - r.ay));
    const toEnd = (_xT < 0.5 ? _xT : 1 - _xT) * len;
    if (toEnd >= CFG.ENV_LOG_END_DETOUR * 2 * r.logR) continue; // mid-log: climb over
    if (ds2 < bestD) { bestD = ds2; best = r; bestT = _xT; }
  }
  if (!best) return;
  if (e.logDetT > (60 + 4 * (er + best.logR)) / Math.max(10, sp) + 0.5) { e.logDetT = 0; e.logClimbT = 1.5; return; }
  // hug the capsule toward that end and round it
  const L = best;
  const ax = L.bx - L.ax, ay = L.by - L.ay, l2 = ax * ax + ay * ay;
  let t = l2 > 0 ? ((e.x - L.ax) * ax + (e.y - L.ay) * ay) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  let nx = e.x - (L.ax + ax * t), ny = e.y - (L.ay + ay * t);
  const nd = Math.sqrt(nx * nx + ny * ny) || 1;
  nx /= nd; ny /= nd;
  // spin: toward the chosen end along our side of the log, then on round
  // its cap (fixed by the side we are on, so it cannot dither at the end)
  const sg = bestT < 0.5 ? -1 : 1;
  // side of the log we started on (kept while rounding: the cap tip is on the axis)
  const side = prevL === L && e.logSide ? e.logSide : ax * (e.y - L.ay) - ay * (e.x - L.ax) >= 0 ? 1 : -1;
  e.logSide = side; // lateral normal = side x (-ay, ax)
  const s = side * (-ay * ay * sg - ax * ax * sg) >= 0 ? 1 : -1;
  let k = (er + L.logR + 3 - nd) * 0.08;
  k = k < -0.5 ? -0.5 : k > 0.5 ? 0.5 : k;
  const vx = -ny * s + nx * k, vy = nx * s + ny * k;
  const vl = Math.sqrt(vx * vx + vy * vy);
  e.vx = vx / vl * sp; e.vy = vy / vl * sp;
  e.walking = true;
  e.logAvoid = L;
}

// Resolve collisions between an entity and nearby solid env objects.
// E5: collision follows env state (envphys.js keeps obj.collision current:
// stump circle when felled, 0 when destroyed). Fallen logs are hurdles, not
// obstacles (E11: envLogSlow, applied to the movement by the callers).
function resolveEnvCollision(entity, entityRadius) {
  for (let i = 0; i < envObjects.length; i++) {
    const obj = envObjects[i];
    // Quick reject: skip objects far away (cheap check before sqrt)
    const dx = entity.x - obj.x;
    const dy = entity.y - obj.y;
    if (dx > 60 || dx < -60 || dy > 60 || dy < -60) continue;
    if (obj._envAt !== _envEpoch) envObjState(obj); // E7: persisted state of a regenerated object
    if (!obj.collision) continue;
    const d2 = dx * dx + dy * dy;
    const minDist = entityRadius + obj.collision;
    if (d2 < minDist * minDist && d2 > 0) {
      const d = Math.sqrt(d2);
      const push = (minDist - d);
      const nx = dx / d, ny = dy / d;
      entity.x += nx * push;
      entity.y += ny * push;
      // Walking (almost) dead-centre into a round obstacle cancels out
      // exactly and pins the entity: nudge it sideways so it slides around
      const vx = entity.vx || 0, vy = entity.vy || 0;
      const vl = Math.sqrt(vx * vx + vy * vy);
      if (vl > 1 && (nx * vx + ny * vy) / vl < -0.92) {
        const side = (nx * vy - ny * vx) >= 0 ? 1 : -1; // keep the side we're already drifting to
        entity.x += -ny * side * push * 0.6;
        entity.y += nx * side * push * 0.6;
      }
    }
  }
}

const HIT_FLASH_TIME = 2 / 60; // G1: two 60 Hz frames of solid white

function damageEnemy(e, dmg, bulletAngle, src=SRC_BULLET) {
  if (e.dead) return; // already killed - prevent double processing
  const t = ENEMY_TYPES[e.type];
  const numZ = 22 * e.size + 16;

  // Shield absorbs damage first
  if (t.hasShield && e.shieldHp > 0) {
    e.shieldHp -= dmg;
    e.hitFlash = HIT_FLASH_TIME;
    playSound('shield_hit', 0.25);
    spawnDamageNumber(e, e.x, e.y, Math.round(dmg), DMG_SHIELD, numZ);
    if (e.shieldHp <= 0) {
      const overflow = -e.shieldHp;
      e.shieldHp = 0;
      playSound('shield_break', 0.4);
      // Shield break shards
      for(let i=0;i<15;i++){
        const a = Math.random()*Math.PI*2;
        spawnParticle(e.x, e.y, Math.cos(a)*100, Math.sin(a)*100,
          0.3, 2, i & 1 ? 0x4080ff : 0xa0c8ff, 'spark', OPT_SPARK, 12 * e.size, randRange(20, 120));
      }
      if (overflow > 0) {
        e.hp -= overflow;
        if (e.hp <= 0) killEnemy(e, bulletAngle, src, false, overflow);
      }
    }
    return;
  }

  const hpBefore = e.hp;
  const overkill = dmg >= hpBefore * 2;
  e.hp -= dmg;
  e.hitFlash = HIT_FLASH_TIME;
  e.stunTimer = 0.05;
  // G2: knockback scales with damage; heavies and bosses resist
  const heavy = t.name === 'Heavy' || t.name === 'Tank' || t.name === 'Juggernaut';
  const resist = e.isBoss ? 0.2 : heavy ? 0.4 : 1;
  const kb = clamp(50 + dmg * 2.5, 60, 900) * resist / t.size; // G2a: cap 900
  e.knockbackX = Math.cos(bulletAngle) * kb;
  e.knockbackY = Math.sin(bulletAngle) * kb;

  spawnBloodSpray(e.x, e.y, bulletAngle, 0.6 + Math.min(1.2, dmg / 60), 12 * e.size);
  waterBloodAdd(e.x, e.y, CFG.W5_HIT, 1); // W5: a hit reddens the water nearby
  spawnDamageNumber(e, e.x, e.y, Math.round(dmg), (overkill && e.hp <= 0) || dmg >= 150 ? DMG_CRIT : DMG_NORMAL, numZ);
  playSound('hit', 0.3);

  if (e.hp <= 0) killEnemy(e, bulletAngle, src, overkill, dmg);
}

// Deferred damage queue - prevents recursive bomber chain explosions from causing stack overflow
let _pendingDamage = [];

function killEnemy(e, bulletAngle, src=SRC_BULLET, overkill=false, lastDmg=0) {
  if (e.dead) return; // already dead - prevent double processing
  e.dead = true; // mark immediately to prevent re-entry
  waterBloodAdd(e.x, e.y, CFG.W5_KILL, 3); // W5: a kill reddens the water nearby

  const t = ENEMY_TYPES[e.type];
  const isBoss = e.isBoss;
  if (isBoss) addHitStop(HIT_STOP_MAX);

  // Score (E6: not for an enemy crushed by a tree the player didn't fell)
  if (!envNoCredit) {
    const comboMult = 1 + combo * 0.1;
    const basePts = isBoss ? t.score * 10 : t.score;
    const pts = Math.round(basePts * comboMult);
    score += pts;
    kills++;
    if (player) { player.score += pts; player.kills++; } // K6 credits the killer
    combo++;
    comboTimer = CFG.COMBO_TIMEOUT;
    if (combo > bestCombo) bestCombo = combo;

    // Charge special ability on kills
    if (player.specialCharge < CFG.SPECIAL_MAX_CHARGE) {
      player.specialCharge++;
    }

    // Floating text
    const color = isBoss ? '#f0f' : combo > 10 ? '#f44' : combo > 5 ? '#fa0' : '#ff0';
    const size = isBoss ? 24 : combo > 5 ? 18 : 14;
    floatingTexts.push({
      x: e.x, y: e.y, text: `+${pts}`, life: 1.2, maxLife: 1.2, color, size,
    });
  }

  // === BOMBER: explode on death (deferred to avoid recursive chain) ===
  if (t.explodeOnDeath) {
    const r = t.explodeRadius || 100;
    // Bomber deaths count as the player's doing (a chain the player set off)
    spawnExplosion(e.x, e.y, r, !envNoCredit, SRC_EXPLOSIVE);
    // Queue damage instead of applying immediately (prevents stack overflow)
    for(let j=0; j<enemies.length; j++) {
      const e2 = enemies[j];
      if (e2 === e || e2.dead) continue;
      const d2 = dist(e.x, e.y, e2.x, e2.y);
      if (d2 < r) {
        // E6: a chain set off by a fall the player didn't cause earns nothing either
        _pendingDamage.push({ target: e2, dmg: 80*(1-d2/r), angle: Math.atan2(e2.y-e.y, e2.x-e.x), src: SRC_EXPLOSIVE, noCredit: envNoCredit });
      }
    }
    for (let pi = 0; pi < players.length; pi++) {
      const pl = players[pi];
      if (!playerStanding(pl)) continue;
      const pd = dist(e.x, e.y, pl.x, pl.y);
      if (pd < r) damagePlayer(50*(1-pd/r), pl);
    }
  }

  // === Death style (G5): disintegrate, gib, or fall and leave a corpse ===
  // F2: a burn death leaves a charred corpse with little blood
  const burnt = src === SRC_FIRE;
  const gib = t.explodeOnDeath || (!burnt && (src === SRC_EXPLOSIVE || src === SRC_BFG || src === SRC_RAIL || overkill));
  const torsoZ = 12 * e.size;
  if (src === SRC_DISINT) {
    spawnDisintegration(e.x, e.y);
  } else if (gib) {
    spawnGibs(e.x, e.y, bulletAngle, e.type, src === SRC_BFG ? 1.8 : 1.25, e.size);
    spawnBloodSpray(e.x, e.y, bulletAngle, 2.2, torsoZ);
    spawnBloodSpray(e.x, e.y, bulletAngle + Math.PI, 1.4, torsoZ);
    bloodDecal(DECAL_POOL, e.x, e.y, 4, BLOOD_COLORS[3], 0, randRange(16, 26) * e.size);
    addShake(4);
  } else {
    if (burnt) {
      spawnBloodSpray(e.x, e.y, bulletAngle, 0.4, torsoZ);
      for (let k = 0; k < 6; k++) { // ash puff
        spawnParticle(e.x + randRange(-8, 8), e.y + randRange(-6, 6), randRange(-15, 15), randRange(-15, 15),
          randRange(0.8, 1.4), randRange(3, 6), k & 1 ? 0x3a3634 : 0x5a5450, 'smoke', OPT_SMOKE, randRange(8, 24), randRange(20, 50));
      }
    } else {
      spawnBloodSpray(e.x, e.y, bulletAngle, 2.0, torsoZ);
      spawnBloodSpray(e.x, e.y, Math.random()*Math.PI*2, 1.0, torsoZ);
    }

    // Corpse: knocked back along the shot, hops, falls over, then bleeds out
    if (bodies.length >= CFG.MAX_BODIES) bodies.shift();
    const shock = src === SRC_SHOCK;
    const kb = (shock ? 380 : 110 + Math.min(200, lastDmg * 1.2)) / Math.max(1, t.size);
    const kc = Math.cos(bulletAngle), ks = Math.sin(bulletAngle);
    const ac = Math.cos(e.angle), as = Math.sin(e.angle);
    bodies.push({
      x: e.x, y: e.y, z: 0,
      vx: kc * kb, vy: ks * kb, vz: shock ? 220 : randRange(80, 150),
      angle: e.angle + Math.PI,
      type: e.type, size: e.size, alpha: 1,
      color: t.color, createdAt: gameTime, isBoss: !!isBoss,
      fall: 0, fallDir: (kc - ks) >= 0 ? 1 : -1,
      flip: (ac - as) >= 0 ? 1 : -1,
      spin: (shock || lastDmg > 120) ? randRange(9, 15) * ((kc - ks) >= 0 ? 1 : -1) : 0,
      spinAngle: 0, settled: false, smear: 0,
      spurts: burnt ? 0 : 3 + randInt(0, 2), spurtT: 0.15,
      charred: burnt, // F2: black, smoking corpse
    });
  }

  // Health pickup (higher chance)
  if (Math.random() < (isBoss ? 0.8 : 0.12)) {
    pickups.push({ x: e.x, y: e.y, type: 'health', life: 15, amount: 50 + wave*2 });
  }
  // Shield pickup chance
  if (Math.random() < 0.06) {
    pickups.push({ x: e.x + randRange(-15,15), y: e.y + randRange(-10,10), type: 'shield', life: 15, amount: 40 + wave });
  }
  // N1: grenade pickup (bosses too)
  if (Math.random() < CFG.GRENADE_DROP_CHANCE) {
    pickups.push({ x: e.x + randRange(-12,12), y: e.y + randRange(-8,8), type: 'grenade', life: 15, amount: 1 });
  }

  playSound(isBoss ? 'boss_death' : 'death', isBoss ? 0.8 : 0.4);

  // Remove enemy (safe: check index is valid)
  const idx = enemies.indexOf(e);
  if (idx >= 0) enemies.splice(idx, 1);

  // === BOSS death: unlock weapon ===
  if (isBoss && bossActive) {
    bossActive = false;
    if (bossTarget >= 0 && bossTarget < WEAPONS.length) {
      unlockedWeapons = bossTarget + 1;
      showNotification(`BOSS DEFEATED! NEW WEAPON: ${WEAPONS[bossTarget].name.toUpperCase()}! [${bossTarget+1>9?0:bossTarget+1}]`, 3.5);
      playSound('unlock', 0.8);
      // Big celebratory explosion
      spawnExplosion(e.x, e.y, 180, true, SRC_EXPLOSIVE);
      bossTarget = -1;
    }
  } else {
    checkWeaponUnlocks();
  }
}

// Process deferred bomber chain damage (called once per frame from update)
function processPendingDamage() {
  // Process in batches - bomber chains can queue more damage, but limited to 3 rounds
  let rounds = 0;
  while (_pendingDamage.length > 0 && rounds < 3) {
    rounds++;
    const batch = _pendingDamage.splice(0, _pendingDamage.length);
    for (const pd of batch) {
      if (!pd.target.dead) {
        const nc = envNoCredit;
        if (pd.noCredit) envNoCredit = true; // E6: no score for an uncredited chain
        damageEnemy(pd.target, pd.dmg, pd.angle, pd.src || SRC_BULLET);
        envNoCredit = nc;
      }
    }
  }
  // G11: anything still queued (long bomber chains) carries over to the next
  // frame, so chains keep cascading as a ripple instead of being dropped
}

// M11 K1: `p` = the player hit (default P1)
function damagePlayer(dmg, p = player) {
  if (p.invincible > 0 || p.dodging) return;
  if (typeof demoActive !== 'undefined' && demoActive) dmg *= CFG.DEMO_DAMAGE_MULT; // D4

  shieldRegenTimer = 0; // reset shield regen delay

  // Shield absorbs damage first
  if (p.shield > 0) {
    p.shield -= dmg;
    playSound('shield_hit', 0.3);
    if (p.shield < 0) {
      const overflow = -p.shield;
      p.shield = 0;
      playSound('shield_break', 0.5);
      p.hp -= overflow;
    }
  } else {
    p.hp -= dmg;
  }

  p.hitFlash = 0.15;
  // G10: screen-edge red flash, intensity from damage taken
  p.hurtFlash = Math.min(1, p.hurtFlash + 0.25 + dmg / 60);
  if (p.shield <= 0) spawnBloodSpray(p.x, p.y, Math.random() * Math.PI * 2, 0.5, 14);
  addShake(3);
  padRumble(0.3, 0.7, 90); // M10 C4: a short strong pulse

  if (p.hp <= 0) {
    if (typeof demoActive !== 'undefined' && demoActive) demoOnPlayerDeath(); // D6: demo ends on death
    // Near-death recovery (Rambo style)
    p.hp = p.maxHp * 0.3;
    p.shield = p.maxShield * 0.2;
    p.invincible = 2;
    spawnExplosion(p.x, p.y, 60, false, SRC_EXPLOSIVE);
    showNotification('SECOND WIND!', 1.5);
  }
}

// =====================================================================
// BULLETS
// =====================================================================
function updateBullets(dt) {
  for(let i=bullets.length-1;i>=0;i--){
    const b = bullets[i];
    b.life -= dt;
    if(b.life<=0){ bullets.splice(i,1); continue; }

    const px = b.x, py = b.y; // previous position for the swept hit test (G12)
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // Trail particles
    if(b.trail && Math.random()<0.5){
      const trailColor = b.glow ? b.color : '#ff8';
      spawnParticle(b.x, b.y, randRange(-10,10), randRange(-10,10),
        0.15, b.beam?3:1.5, trailColor, 'trail', OPT_TRAIL, 18, 0);
    }

    // Beam weapons leave a stronger trail
    if(b.beam && Math.random()<0.8){
      spawnParticle(b.x, b.y, randRange(-5,5), randRange(-5,5),
        0.1, 2, b.color, 'trail', OPT_TRAIL, 18, 0);
    }

    // G12/G12b: swept segment-vs-circle tests from the previous to the
    // current position, so fast rounds (Railgun: ~67 units/frame) can't tunnel
    const sdx = b.x - px, sdy = b.y - py, len2 = sdx * sdx + sdy * sdy;
    const minX = Math.min(px, b.x), maxX = Math.max(px, b.x);
    const minY = Math.min(py, b.y), maxY = Math.max(py, b.y);
    const step60 = Math.sqrt(b.vx * b.vx + b.vy * b.vy) / 60; // path per 60 Hz frame
    const fresh = b.fresh; b.fresh = false;
    let nearT = 2, nearE = null, nearB = null, nearO = null, nearW = false;
    const byPlayer = b.owner === 'player';

    // Explosive barrels (G12b) and env blockers (E3/E4: tree trunks, stumps,
    // crates, sandbags). Fallen logs are low cover: bullets fly over them.
    for(const obj of envObjects){
      // 20 >= the largest barrel/trunk/crate/sandbag hit radius
      if(obj.x + 20 < minX || obj.x - 20 > maxX || obj.y + 20 < minY || obj.y - 20 > maxY) continue;
      if(obj.type === 'barrel'){
        if(obj.exploded) continue;
        if(obj.x + 14 < minX || obj.x - 14 > maxX || obj.y + 14 < minY || obj.y - 14 > maxY) continue;
        if(b.pierce){
          if(entersCircle(px, py, sdx, sdy, len2, obj.x, obj.y, 14, fresh))
            hitBarrel(obj, b.dmg * pierceHits(px, py, sdx, sdy, len2, obj.x, obj.y, 14, step60), byPlayer);
        } else {
          const t = segCircleT(px, py, sdx, sdy, len2, obj.x, obj.y, 14);
          if(t >= 0 && t < nearT){ nearT = t; nearB = obj; nearO = null; nearW = false; }
        }
        continue;
      }
      const hr = envBulletRadius(obj);
      if(!hr) continue;
      // A round fired from inside a trunk/crate (shooter hugging it) ignores it
      const fx = px - obj.x, fy = py - obj.y;
      if(fx * fx + fy * fy <= hr * hr) continue;
      if(b.pierce){
        // Pierce rounds pass through but still chip/damage once per pass
        const t = segCircleT(px, py, sdx, sdy, len2, obj.x, obj.y, hr);
        if(t >= 0) envBulletHit(obj, px + sdx * t, py + sdy * t, b.vx, b.vy,
          b.dmg * pierceHits(px, py, sdx, sdy, len2, obj.x, obj.y, hr, step60), byPlayer, true);
      } else {
        const t = segCircleT(px, py, sdx, sdy, len2, obj.x, obj.y, hr);
        if(t >= 0 && t < nearT){ nearT = t; nearO = obj; nearB = null; nearW = false; }
      }
    }

    if(b.owner === 'player') {
      for(let j=enemies.length-1;j>=0;j--){
        const e = enemies[j];
        if(e.dead) continue;
        const r = 15 * e.size;
        // G13: body column from the feet up along iso screen-up (head height)
        const k = bodyColumnK(ENEMY_BODY_H * e.size);
        if(e.x + r < minX || e.x - k - r > maxX || e.y + r < minY || e.y - k - r > maxY) continue;
        // W2: wading, only the column above the waterline is hittable
        // (contact explosives still go off on the whole body region, G13c)
        const kw = e.submerge > 0 && !b.explosive ? bodyColumnK(entityWaterlineH(e)) : 0;
        const rv = e.submerge > 0 ? wadeRadius(e, r) : r;
        const t = segCapsuleT(px, py, sdx, sdy, len2, e.x - kw, e.y - kw, e.x - k, e.y - k, rv);
        if(b.pierce){
          // G12a: one hit per pass, worth as many hits as the old per-60Hz-frame
          // overlap gave (chord / step, through a circle at the column point
          // the path passes closest to), so balance holds at any frame rate
          if(t >= 0 && (_capStartOutside || fresh)) {
            capsuleLinePoint(px, py, sdx, sdy, e.x - kw, e.y - kw, e.x - k, e.y - k);
            bulletHitEnemy(b, e, pierceHits(px, py, sdx, sdy, len2, _capCx, _capCy, rv, step60));
          } else if(t < 0 && kw > 0) {
            const tw = segCapsuleT(px, py, sdx, sdy, len2, e.x, e.y, e.x - kw, e.y - kw, r);
            if(tw >= 0 && (_capStartOutside || fresh) && !wadeVisibleAhead(px, py, sdx, sdy, tw, e.x - kw, e.y - kw, e.x - k, e.y - k, rv, 1.5 * k + 2 * r))
              spawnWaterSplash(px + sdx * tw, py + sdy * tw);
          }
        } else if(t >= 0) {
          if(t < nearT){ nearT = t; nearE = e; nearW = false; nearB = null; nearO = null; }
        } else if(kw > 0) {
          // only the submerged part is on the path: the round goes into the water
          const tw = segCapsuleT(px, py, sdx, sdy, len2, e.x, e.y, e.x - kw, e.y - kw, r);
          if(tw >= 0 && tw < nearT && !wadeVisibleAhead(px, py, sdx, sdy, tw, e.x - kw, e.y - kw, e.x - k, e.y - k, rv, 1.5 * k + 2 * r)){
            nearT = tw; nearE = null; nearW = true; nearB = null; nearO = null;
          }
        }
      }
    } else {
      // Enemy bullet -> the nearest player on its path (unless a barrel or trunk is nearer)
      const kp = bodyColumnK(PLAYER_BODY_H);
      let hitP = null;
      for(let pi=0; pi<players.length; pi++){
        const pl = players[pi];
        if(!playerStanding(pl)) continue;
        const kw = pl.submerge > 0 && !b.explosive ? bodyColumnK(entityWaterlineH(pl)) : 0; // W2
        const rpv = kw > 0 ? wadeRadius(pl, 16) : 16;
        const t = segCapsuleT(px, py, sdx, sdy, len2, pl.x - kw, pl.y - kw, pl.x - kp, pl.y - kp, rpv);
        if(t < 0 && kw > 0){
          const tw = segCapsuleT(px, py, sdx, sdy, len2, pl.x, pl.y, pl.x - kw, pl.y - kw, 16);
          if(tw >= 0 && tw < nearT && !wadeVisibleAhead(px, py, sdx, sdy, tw, pl.x - kw, pl.y - kw, pl.x - kp, pl.y - kp, rpv, 1.5 * kp + 32)){
            nearT = tw; nearW = true; nearB = null; nearO = null; hitP = null;
          }
        }
        if(t >= 0 && t < nearT){ nearT = t; hitP = pl; }
      }
      if(hitP){
        b.x = px + sdx * nearT; b.y = py + sdy * nearT;
        damagePlayer(b.dmg, hitP);
        if(b.explosive) spawnExplosion(b.x, b.y, b.radius||60, false, SRC_EXPLOSIVE, null, b.dmg);
        bullets.splice(i,1);
        continue;
      }
    }

    // Non-piercing: the nearest enemy, barrel or env blocker on the path takes the hit
    if(nearE || nearB || nearO || nearW){
      b.x = px + sdx * nearT; b.y = py + sdy * nearT; // impact point
      if(nearE) bulletHitEnemy(b, nearE, 1);
      else if(nearW){
        // W2: below a wader's waterline: splash, no hit (explosives still go off)
        spawnWaterSplash(b.x, b.y);
        if(b.explosive) _bulletExplode(b);
      }
      else if(nearB) hitBarrel(nearB, b.dmg, byPlayer);
      else {
        envBulletHit(nearO, b.x, b.y, b.vx, b.vy, b.dmg, byPlayer);
        // Rockets / BFG / tank shells detonate on the trunk or crate
        if(b.explosive) _bulletExplode(b);
      }
      bullets.splice(i,1);
    }
  }
}

// Detonate an explosive round at its current position (player rounds also
// deal area damage to enemies, as on a direct hit)
function _bulletExplode(b) {
  if(b.owner !== 'player'){
    spawnExplosion(b.x, b.y, b.radius||60, false, SRC_EXPLOSIVE, null, b.dmg);
    return;
  }
  const src = b.bfg ? SRC_BFG : SRC_EXPLOSIVE;
  spawnExplosion(b.x, b.y, b.radius, true, src, null, b.dmg);
  splashDamage(b.x, b.y, b.dmg, b.radius, src, b.vx, b.vy);
}

// Player explosive splash (RPG/BFG rounds, N1 grenades): 0.7 x dmg x (1 - d/R)
// to every live enemy within R, queued through _pendingDamage
function splashDamage(x, y, dmg, R, src, vx, vy) {
  for(let ei=enemies.length-1; ei>=0; ei--){
    const e2 = enemies[ei];
    if(e2.dead) continue;
    const d2 = dist(x, y, e2.x, e2.y);
    if(d2 < R){
      // Dead-centre (G13c target): knock back along the round's flight
      const ang = d2 < 1 ? Math.atan2(vy, vx) : Math.atan2(e2.y-y, e2.x-x);
      _pendingDamage.push({ target: e2, dmg: dmg * (1-d2/R) * 0.7, angle: ang, src });
    }
  }
}

// A piercing round counts a hit when its path ENTERS the circle; a round
// that spawned inside one (point-blank) counts on its first update only
function entersCircle(x0, y0, dx, dy, len2, cx, cy, r, fresh) {
  const fx = x0 - cx, fy = y0 - cy;
  if (fx * fx + fy * fy <= r * r) return !!fresh;
  return segCircleT(x0, y0, dx, dy, len2, cx, cy, r) >= 0;
}

// G12a: how many 60 Hz frames the old code would have overlapped the circle:
// max(1, round(chord / step)), chord = the path's length inside the circle
function pierceHits(x0, y0, dx, dy, len2, cx, cy, r, step60) {
  let chord = 2 * r;
  if (len2 > 0) {
    const fx = cx - x0, fy = cy - y0;
    const proj = fx * dx + fy * dy;
    const perp2 = fx * fx + fy * fy - proj * proj / len2;
    chord = 2 * Math.sqrt(Math.max(0, r * r - perp2));
  }
  return step60 > 0 ? Math.max(1, Math.round(chord / step60)) : 1;
}

function hitBarrel(obj, dmg, byPlayer = true) {
  obj.hp -= dmg;
  if(obj.hp <= 0 && !obj.exploded){
    obj.exploded = true;
    envMarkDestroyed(obj); // E7: stays exploded when its chunk regenerates
    // BIGGER barrel explosion (radius 220, damages enemies more)
    spawnExplosion(obj.x, obj.y, 220, byPlayer, SRC_EXPLOSIVE);
    for(let ei=enemies.length-1; ei>=0; ei--){
      const e2 = enemies[ei];
      if(e2.dead) continue;
      const ed = dist(obj.x, obj.y, e2.x, e2.y);
      if(ed < 220) _pendingDamage.push({ target: e2, dmg: 200*(1-ed/220), angle: Math.atan2(e2.y-obj.y, e2.x-obj.x), src: SRC_EXPLOSIVE });
    }
    for(let pi=0; pi<players.length; pi++){
      const pl = players[pi];
      if(!playerStanding(pl)) continue;
      const pd = dist(obj.x, obj.y, pl.x, pl.y);
      if(pd < 220) damagePlayer(80*(1-pd/220), pl);
    }
    score += 50;
  }
}

// G13: drawn body heights (screen units above the feet, size 1) and the
// world-space length of a body column: screen-up (0, -h) is world
// (-h / (2 ISO), -h / (2 ISO)), i.e. k along both axes.
// Column heights (the round cap adds ~0.78 r of screen height on top) and
// the drawn sprite height used for cursor picking (head top + hat).
const ENEMY_BODY_H = 36, PLAYER_BODY_H = 34, ENEMY_PICK_H = 48,
  PLAYER_HAND_H = 24; // gun hand height above the feet (screen units)
function bodyColumnK(h) { return h / (2 * CFG.ISO_SCALE); }

// G13(d): walk/idle bob frames draw the body one art px (3 screen units,
// x round(size) above 1.6, as the puppet scales it) higher; the pick's top
// edge includes it so the topmost head pixels pick on every frame
function enemyBobUp(e) { const s = e.size || 1; return 3 * (s > 1.6 ? Math.round(s) : 1); }

// G13: front-most enemy whose drawn body contains screen point (sx, sy)
// (world-screen coordinates, i.e. toScreen space), or null
let _aimPicked = null; // enemy the cursor picked this frame (G13)
const _aimPt = { x: 0, y: 0 };
let _grenadeKeyHeld = false, _grenadeWant = false; // N1: F edge latch / pending throw
function pickEnemyAtScreen(sx, sy) {
  let best = null, bestDepth = -Infinity;
  const iso = CFG.ISO_SCALE;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead) continue;
    const ex = e.x - e.y, ey = (e.x + e.y) * iso;
    const hw = 10 * e.size + 3;
    const bot = e.submerge > 0 ? ey - entityWaterlineH(e) + 2 : ey + 6; // W2: not below the waterline
    if (sx < ex - hw || sx > ex + hw || sy > bot || sy < ey - ENEMY_PICK_H * e.size - 3 - enemyBobUp(e)) continue;
    const depth = e.x + e.y; // larger depth draws on top
    if (depth > bestDepth) { bestDepth = depth; best = e; }
  }
  return best;
}

// W2: from the wet-zone entry (segment param tw), does the round's onward
// path cross the visible (above-waterline) capsule within L? Then it hits
// that in a later frame rather than going into the water now.
function wadeVisibleAhead(x0, y0, dx, dy, tw, ax, ay, bx, by, r, L) {
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-9) return false;
  const ux = dx / len * L, uy = dy / len * L;
  return segCapsuleT(x0 + dx * tw, y0 + dy * tw, ux, uy, L * L, ax, ay, bx, by, r) >= 0;
}

// G13: earliest t in [0,1] where segment (x0,y0)+t*(dx,dy) comes within r of
// the capsule axis A-B, or -1. Also sets _capCx/_capCy (closest axis point)
// and _capStartOutside (the segment starts outside the capsule).
let _capCx = 0, _capCy = 0, _capStartOutside = true;
function segCapsuleT(x0, y0, dx, dy, len2, ax, ay, bx, by, r) {
  const ex = bx - ax, ey = by - ay, el2 = ex * ex + ey * ey;
  // Starting inside the column: the column is a ground region behind the
  // feet, so a shooter standing in it must not hit everything at t = 0.
  // Inside the foot circle = touching (t = 0); inside the column only =
  // ignore the column for this segment and test the foot circle alone.
  let u0 = el2 > 0 ? ((x0 - ax) * ex + (y0 - ay) * ey) / el2 : 0;
  u0 = u0 < 0 ? 0 : u0 > 1 ? 1 : u0;
  const sx0 = x0 - (ax + ex * u0), sy0 = y0 - (ay + ey * u0);
  if (sx0 * sx0 + sy0 * sy0 <= r * r) {
    _capCx = ax; _capCy = ay;
    const fx = x0 - ax, fy = y0 - ay;
    // _capStartOutside stays false: a piercing round inside the capsule has
    // already counted its pass (G12a) - only non-pierce uses the foot fallback
    _capStartOutside = false;
    if (fx * fx + fy * fy <= r * r) return 0;
    return segCircleT(x0, y0, dx, dy, len2, ax, ay, r);
  }
  _capStartOutside = true;
  // Exact capsule entry: the earliest of the two end circles and the side
  // slab (|distance to the axis line| <= r with the foot of the projection
  // inside the axis segment).
  let best = 2;
  const ta = segCircleT(x0, y0, dx, dy, len2, ax, ay, r);
  if (ta >= 0) { best = ta; _capCx = ax; _capCy = ay; }
  const tb = segCircleT(x0, y0, dx, dy, len2, bx, by, r);
  if (tb >= 0 && tb < best) { best = tb; _capCx = bx; _capCy = by; }
  if (el2 > 0) {
    const el = Math.sqrt(el2), nx = -ey / el, ny = ex / el;
    const s0 = (x0 - ax) * nx + (y0 - ay) * ny;   // signed distance to the axis line at t = 0
    const ds = dx * nx + dy * ny;                 // its change per unit t
    if (Math.abs(ds) > 1e-9) {
      const ts = ((s0 > 0 ? r : -r) - s0) / ds;   // where |distance| first reaches r
      if (ts >= 0 && ts <= 1 && ts < best) {
        const qx = x0 + dx * ts - ax, qy = y0 + dy * ts - ay;
        const u = (qx * ex + qy * ey) / el2;
        if (u >= 0 && u <= 1) { best = ts; _capCx = ax + ex * u; _capCy = ay + ey * u; }
      }
    }
  }
  return best <= 1 ? best : -1;
}

// G12a with G13: the pierce chord is measured over the bullet's whole pass,
// so take the column point closest to its infinite LINE (not this frame's
// short segment). Result in _capCx/_capCy.
function capsuleLinePoint(x0, y0, dx, dy, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay;
  const a = dx * dx + dy * dy, b = dx * ex + dy * ey, c = ex * ex + ey * ey;
  const wx = x0 - ax, wy = y0 - ay, d = dx * wx + dy * wy, f = ex * wx + ey * wy;
  const den = a * c - b * b;
  let u = den > 1e-9 ? (a * f - b * d) / den : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  _capCx = ax + ex * u; _capCy = ay + ey * u;
}

// Smallest t in [0,1] where segment (x0,y0)+t*(dx,dy) enters the circle, or -1.
// len2 = dx*dx + dy*dy. A segment starting inside the circle hits at t = 0.
function segCircleT(x0, y0, dx, dy, len2, cx, cy, r) {
  const fx = x0 - cx, fy = y0 - cy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  if (len2 === 0) return -1;
  const bb = fx * dx + fy * dy;
  if (bb >= 0) return -1; // moving away from the centre
  const disc = bb * bb - len2 * c;
  if (disc < 0) return -1;
  const t = (-bb - Math.sqrt(disc)) / len2;
  return t <= 1 ? t : -1;
}

// Apply one player bullet hit (damage, explosion);
// mult > 1 for a piercing pass through a big target (G12a)
function bulletHitEnemy(b, e, mult = 1) {
  const bAngle = Math.atan2(b.vy, b.vx);
  const src = b.disintegrate ? SRC_DISINT : b.explosive ? (b.bfg ? SRC_BFG : SRC_EXPLOSIVE) : b.beam ? SRC_RAIL : SRC_BULLET;

  // Disintegrator kills are handled in killEnemy (SRC_DISINT)
  damageEnemy(e, b.dmg * mult, bAngle, src);

  // G13c: a contact explosive that hits the body detonates at the target's
  // feet (ground position), not at the column entry up to 135u away
  if(b.explosive){ b.x = e.x; b.y = e.y; _bulletExplode(b); }
}

// =====================================================================
// WAVE MANAGER & BOSSES
// =====================================================================
const _spawnO = { x: 0, y: 0 };
function spawnBoss(weaponIndex) {
  const name = BOSS_NAMES[weaponIndex-1] || 'Boss';
  // Pick a base enemy type that fits the power level
  const baseIdx = Math.min(Math.floor(weaponIndex * 1.2), ENEMY_TYPES.length - 1);
  const bossHp = 300 + weaponIndex * 250; // Easy/relaxing HP scaling

  const a = Math.random() * Math.PI * 2;
  const o = coopSpawnOrigin(_spawnO), sd = (CFG.VIEW_RANGE + 80) / cam.z; // M11 K3a: off the zoomed view
  const sx = o.x + Math.cos(a) * sd;
  const sy = o.y + Math.sin(a) * sd;

  spawnEnemy(baseIdx, sx, sy, { name, hp: bossHp });
  showNotification(`BOSS: ${name}!`, 3);
  playSound('boss_spawn', 1);
  addShake(10);
}

function checkWeaponUnlocks() {
  if (bossActive) return; // already fighting a boss
  for(let i=0;i<WEAPONS.length;i++){
    if(i >= unlockedWeapons && score >= WEAPONS[i].unlock) {
      // Spawn boss instead of instant unlock
      bossActive = true;
      bossTarget = i;
      spawnBoss(i);
      return;
    }
  }
}

function updateWaves(dt) {
  if(!waveActive) {
    waveTimer -= dt;
    if(waveTimer <= 0) {
      wave++;
      waveActive = true;
      // N1: +1 grenade per wave start after the round's first wave (cap 6)
      if (player && player.wavesStarted++ > 0) player.grenades = Math.min(player.grenades + 1, CFG.GRENADE_AMMO_MAX);
      const baseEnemies = 5 + wave * 2 + Math.floor(wave * 0.5);
      const cap = Math.min(baseEnemies, CFG.MAX_ENEMIES - enemies.length);
      enemiesThisWave = cap;
      enemiesSpawned = 0;
      if(wave % 5 === 0) showNotification(`WAVE ${wave} - MASSIVE ASSAULT!`, 2.5);
      else showNotification(`Wave ${wave}`, 1.2);
    }
  }

  if(waveActive && enemiesSpawned < enemiesThisWave && enemies.length < CFG.MAX_ENEMIES) {
    const spawnRate = 0.3 + wave * 0.05;
    if(Math.random() < spawnRate * dt * 10) {
      const available = ENEMY_TYPES.filter(t => t.wave <= wave);
      const weights = available.map((t) => {
        if(wave - t.wave < 3) return 3;
        return 1;
      });
      const totalW = weights.reduce((a,b)=>a+b,0);
      let r = Math.random() * totalW;
      let typeIdx = 0;
      for(let i=0;i<weights.length;i++){
        r -= weights[i];
        if(r<=0){ typeIdx = ENEMY_TYPES.indexOf(available[i]); break; }
      }

      const spawnDist = (CFG.VIEW_RANGE + 100) / cam.z; // M11 K3a: off the zoomed view
      const a = Math.random() * Math.PI * 2;
      const o = coopSpawnOrigin(_spawnO);
      const sx = o.x + Math.cos(a) * spawnDist;
      const sy = o.y + Math.sin(a) * spawnDist;
      spawnEnemy(typeIdx, sx, sy);
      enemiesSpawned++;
    }
  }

  if(waveActive && enemiesSpawned >= enemiesThisWave && enemies.length === 0) {
    waveActive = false;
    waveTimer = waveCooldown;
  }

  if(combo > 0) {
    comboTimer -= dt;
    if(comboTimer <= 0) combo = 0;
  }
}

// =====================================================================
// PICKUPS
// =====================================================================
function updatePickups(dt) {
  for(let i=pickups.length-1;i>=0;i--) {
    const pk = pickups[i];
    pk.life -= dt;
    if(pk.life <= 0){ pickups.splice(i,1); continue; }
    // M11 K1: whoever touches it first (players[] order breaks a same-frame tie)
    let pl = null;
    for(let pi=0; pi<players.length && !pl; pi++){
      const q = players[pi];
      if(playerStanding(q) && dist(pk.x, pk.y, q.x, q.y) < 25) pl = q;
    }
    if(pl){
      if(pk.type === 'health'){
        pl.hp = Math.min(pl.hp + pk.amount, pl.maxHp);
        playSound('pickup', 0.5);
      } else if(pk.type === 'shield'){
        pl.shield = Math.min(pl.shield + pk.amount, pl.maxShield);
        playSound('pickup', 0.5);
      } else if(pk.type === 'grenade'){
        pl.grenades = Math.min(pl.grenades + pk.amount, CFG.GRENADE_AMMO_MAX);
        playSound('pickup', 0.5);
      }
      pickups.splice(i,1);
    }
  }
}
