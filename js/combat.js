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
  };
}

function updatePlayer(dt) {
  const p = player;
  if (!p) return;

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

  const len = Math.sqrt(sx*sx+sy*sy);
  if (len > 0) {
    sx /= len; sy /= len;
    const isoScale = CFG.ISO_SCALE;
    const worldDx = sx * 0.5 / 1 + sy * 0.5 / isoScale;
    const worldDy = -sx * 0.5 / 1 + sy * 0.5 / isoScale;
    const wLen = Math.sqrt(worldDx*worldDx + worldDy*worldDy);
    let speed = CFG.PLAYER_SPEED;
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

  p.x += p.vx * dt;
  p.y += p.vy * dt;

  // Collision with trees, rocks, boulders
  resolveEnvCollision(p, 10);

  // Mouse aiming
  const worldMouse = toWorld(mouseX - W/2 + cam.x, mouseY - H/2 + cam.y);
  mouseWorldX = worldMouse.x;
  mouseWorldY = worldMouse.y;
  p.aimAngle = Math.atan2(mouseWorldY - p.y, mouseWorldX - p.x);
  const sp = toScreen(p.x, p.y);
  const smx = mouseX - W/2 + cam.x - sp.x;
  const smy = mouseY - H/2 + cam.y - sp.y;
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
        _pendingDamage.push({ target: e, dmg: CFG.SPECIAL_DAMAGE * (1 - d/CFG.SPECIAL_RADIUS), angle: Math.atan2(e.y-p.y, e.x-p.x) });
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
          if (bullets.length < CFG.MAX_BULLETS) {
            bullets.push({
              x: muzzleX, y: muzzleY,
              vx: Math.cos(bAngle)*wep.speed, vy: Math.sin(bAngle)*wep.speed,
              dmg: wep.dmg, life: 2, owner:'player',
              color: wep.color, size: wep.count>1?2:2.5,
              trail: wep.trail, pierce: wep.pierce,
              explosive: wep.explosive, radius: wep.radius||0,
              glow: wep.glow, chain: wep.chain||0, chainRange: wep.chainRange||0,
              beam: wep.beam, disintegrate: wep.disintegrate,
            });
          }
        }

        spawnMuzzleFlash(muzzleX, muzzleY, aim);
        if (wep.shellSize > 0) spawnShellCasing(p.x, p.y, aim);

        const soundMap = {0:'pistol',1:'smg',2:'shotgun',3:'rifle',4:'minigun',5:'rocket',6:'plasma',7:'tesla',8:'railgun',9:'bfg',10:'disintegrator'};
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

    if (e.stunTimer > 0) {
      e.stunTimer -= dt;
      e.x += e.knockbackX * dt;
      e.y += e.knockbackY * dt;
      e.knockbackX *= 0.9;
      e.knockbackY *= 0.9;
      continue;
    }
    if (e.hitFlash > 0) e.hitFlash -= dt;

    const dx = player.x - e.x, dy = player.y - e.y;
    const d = Math.sqrt(dx*dx+dy*dy);
    e.angle = Math.atan2(dy, dx);

    // === MEDIC behavior ===
    if (t.healer) {
      // Try to heal nearby wounded enemies
      e.fireTimer -= dt;
      if (e.fireTimer <= 0) {
        for(const e2 of enemies) {
          if (e2 === e || e2.hp >= e2.maxHp) continue;
          const d2 = dist(e.x, e.y, e2.x, e2.y);
          if (d2 < 150) {
            e2.hp = Math.min(e2.hp + 25, e2.maxHp);
            e.fireTimer = t.fireRate;
            // Heal visual
            spawnParticle(e2.x, e2.y, 0, -30, 0.4, 4, '#0f0', 'flash', {fadeStart:0});
            spawnParticle(e2.x, e2.y, 0, -20, 0.3, 3, '#8f8', 'flash', {fadeStart:0});
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
        const a = e.angle + randRange(-spread, spread);
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
        spawnMuzzleFlash(e.x + Math.cos(a)*10, e.y + Math.sin(a)*10, a);
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
          damagePlayer(e.dmg);
        }
      }
    }

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

    e.x += e.vx * dt;
    e.y += e.vy * dt;

    // Collision with trees, rocks, boulders
    resolveEnvCollision(e, 8 * e.size);
  }
}

// Resolve collisions between an entity and nearby solid env objects
function resolveEnvCollision(entity, entityRadius) {
  for (let i = 0; i < envObjects.length; i++) {
    const obj = envObjects[i];
    if (!obj.collision) continue;
    // Quick reject: skip objects far away (cheap check before sqrt)
    const dx = entity.x - obj.x;
    const dy = entity.y - obj.y;
    if (dx > 60 || dx < -60 || dy > 60 || dy < -60) continue;
    const d2 = dx * dx + dy * dy;
    const minDist = entityRadius + obj.collision;
    if (d2 < minDist * minDist && d2 > 0) {
      const d = Math.sqrt(d2);
      const push = (minDist - d);
      entity.x += (dx / d) * push;
      entity.y += (dy / d) * push;
    }
  }
}

function damageEnemy(e, dmg, bulletAngle) {
  if (e.dead) return; // already killed - prevent double processing
  const t = ENEMY_TYPES[e.type];

  // Shield absorbs damage first
  if (t.hasShield && e.shieldHp > 0) {
    e.shieldHp -= dmg;
    e.hitFlash = 0.08;
    playSound('shield_hit', 0.25);
    if (e.shieldHp <= 0) {
      const overflow = -e.shieldHp;
      e.shieldHp = 0;
      playSound('shield_break', 0.4);
      // Shield break particles
      for(let i=0;i<15;i++){
        const a = Math.random()*Math.PI*2;
        spawnParticle(e.x, e.y, Math.cos(a)*100, Math.sin(a)*100,
          0.3, 3, '#48f', 'fire', {gravity:0, friction:0.9, shrink:true});
      }
      if (overflow > 0) {
        e.hp -= overflow;
        if (e.hp <= 0) killEnemy(e, bulletAngle);
      }
    }
    return;
  }

  e.hp -= dmg;
  e.hitFlash = 0.1;
  e.stunTimer = 0.05;
  const kb = 150 / (t.size);
  e.knockbackX = Math.cos(bulletAngle) * kb;
  e.knockbackY = Math.sin(bulletAngle) * kb;

  spawnBloodSpray(e.x, e.y, bulletAngle, 0.8);
  playSound('hit', 0.3);

  if (e.hp <= 0) killEnemy(e, bulletAngle);
}

// Deferred damage queue - prevents recursive bomber chain explosions from causing stack overflow
let _pendingDamage = [];

function killEnemy(e, bulletAngle) {
  if (e.dead) return; // already dead - prevent double processing
  e.dead = true; // mark immediately to prevent re-entry

  const t = ENEMY_TYPES[e.type];
  const isBoss = e.isBoss;

  // Score
  const comboMult = 1 + combo * 0.1;
  const basePts = isBoss ? t.score * 10 : t.score;
  const pts = Math.round(basePts * comboMult);
  score += pts;
  kills++;
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

  // === BOMBER: explode on death (deferred to avoid recursive chain) ===
  if (t.explodeOnDeath) {
    const r = t.explodeRadius || 100;
    spawnExplosion(e.x, e.y, r);
    // Queue damage instead of applying immediately (prevents stack overflow)
    for(let j=0; j<enemies.length; j++) {
      const e2 = enemies[j];
      if (e2 === e || e2.dead) continue;
      const d2 = dist(e.x, e.y, e2.x, e2.y);
      if (d2 < r) {
        _pendingDamage.push({ target: e2, dmg: 80*(1-d2/r), angle: Math.atan2(e2.y-e.y, e2.x-e.x) });
      }
    }
    const pd = dist(e.x, e.y, player.x, player.y);
    if (pd < r) damagePlayer(50*(1-pd/r));
  } else {
    // Normal blood death
    spawnBloodSpray(e.x, e.y, Math.random()*Math.PI*2, 2.0);
    spawnBloodSpray(e.x, e.y, Math.random()*Math.PI*2, 1.2);
    for(let i=0;i<5;i++){
      if (bloodPools.length < CFG.MAX_BLOOD_POOLS) {
        bloodPools.push({
          x: e.x + randRange(-18,18), y: e.y + randRange(-12,12),
          radius: 3, maxRadius: randRange(14, 30),
          color: `rgba(${90+randInt(0,40)},${randInt(0,8)},${randInt(0,8)},`,
          alpha: 0.7, growing: true, createdAt: gameTime,
        });
      }
    }
  }

  // Dead body
  if (bodies.length >= CFG.MAX_BODIES) bodies.shift();
  bodies.push({
    x: e.x, y: e.y, angle: e.angle + Math.PI,
    type: e.type, size: t.size * (isBoss ? 2 : 1), alpha: 1,
    color: t.color, createdAt: gameTime,
  });

  // Health pickup (higher chance)
  if (Math.random() < (isBoss ? 0.8 : 0.12)) {
    pickups.push({ x: e.x, y: e.y, type: 'health', life: 15, amount: 50 + wave*2 });
  }
  // Shield pickup chance
  if (Math.random() < 0.06) {
    pickups.push({ x: e.x + randRange(-15,15), y: e.y + randRange(-10,10), type: 'shield', life: 15, amount: 40 + wave });
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
      spawnExplosion(e.x, e.y, 180);
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
        damageEnemy(pd.target, pd.dmg, pd.angle);
      }
    }
  }
  _pendingDamage.length = 0; // safety clear
}

function damagePlayer(dmg) {
  if (player.invincible > 0 || player.dodging) return;

  shieldRegenTimer = 0; // reset shield regen delay

  // Shield absorbs damage first
  if (player.shield > 0) {
    player.shield -= dmg;
    playSound('shield_hit', 0.3);
    if (player.shield < 0) {
      const overflow = -player.shield;
      player.shield = 0;
      playSound('shield_break', 0.5);
      player.hp -= overflow;
    }
  } else {
    player.hp -= dmg;
  }

  player.hitFlash = 0.15;
  addShake(3);

  if (player.hp <= 0) {
    // Near-death recovery (Rambo style)
    player.hp = player.maxHp * 0.3;
    player.shield = player.maxShield * 0.2;
    player.invincible = 2;
    spawnExplosion(player.x, player.y, 60);
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

    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // Trail particles
    if(b.trail && Math.random()<0.5){
      const trailColor = b.glow ? b.color : '#ff8';
      spawnParticle(b.x, b.y, randRange(-10,10), randRange(-10,10),
        0.15, b.beam?3:1.5, trailColor, 'trail', {shrink:true, fadeStart:0});
    }

    // Beam weapons leave a stronger trail
    if(b.beam && Math.random()<0.8){
      spawnParticle(b.x, b.y, randRange(-5,5), randRange(-5,5),
        0.1, 2, b.color, 'flash', {shrink:true, fadeStart:0});
    }

    // Barrel collisions
    for(const obj of envObjects){
      if(obj.type==='barrel' && !obj.exploded){
        const bd = dist(b.x, b.y, obj.x, obj.y);
        if(bd < 14){
          obj.hp -= b.dmg;
          if(obj.hp <= 0){
            obj.exploded = true;
            // BIGGER barrel explosion (radius 220, damages enemies more)
            spawnExplosion(obj.x, obj.y, 220);
            for(let ei=enemies.length-1; ei>=0; ei--){
              const e2 = enemies[ei];
              if(e2.dead) continue;
              const ed = dist(obj.x, obj.y, e2.x, e2.y);
              if(ed < 220) _pendingDamage.push({ target: e2, dmg: 200*(1-ed/220), angle: Math.atan2(e2.y-obj.y, e2.x-obj.x) });
            }
            const pd = dist(obj.x, obj.y, player.x, player.y);
            if(pd < 220) damagePlayer(80*(1-pd/220));
            score += 50;
          }
          if(!b.pierce && !b.explosive){ bullets.splice(i,1); break; }
        }
      }
    }
    if(!bullets[i] || bullets[i] !== b) continue;

    // Player bullet -> enemy collision
    if(b.owner === 'player') {
      for(let j=enemies.length-1;j>=0;j--){
        const e = enemies[j];
        const d = dist(b.x, b.y, e.x, e.y);
        if(d < 15 * e.size) {
          const bAngle = Math.atan2(b.vy, b.vx);

          // === CHAIN LIGHTNING (Tesla) ===
          if(b.chain > 0) {
            damageEnemy(e, b.dmg, bAngle);
            let chainFrom = {x: e.x, y: e.y};
            let chainedSet = new Set([enemies.indexOf(e)]);
            for(let c=0; c<b.chain; c++){
              let closest = null, closestDist = b.chainRange;
              for(let k=0;k<enemies.length;k++){
                if(chainedSet.has(k)) continue;
                const d2 = dist(chainFrom.x, chainFrom.y, enemies[k].x, enemies[k].y);
                if(d2 < closestDist){ closest = k; closestDist = d2; }
              }
              if(closest !== null){
                chainedSet.add(closest);
                const ct = enemies[closest];
                spawnLightning(chainFrom.x, chainFrom.y, ct.x, ct.y);
                damageEnemy(ct, b.dmg * 0.5, Math.atan2(ct.y-chainFrom.y, ct.x-chainFrom.x));
                chainFrom = {x: ct.x, y: ct.y};
              }
            }
            bullets.splice(i,1); break;
          }

          // === DISINTEGRATE ===
          if(b.disintegrate && e.hp - b.dmg <= 0) {
            spawnDisintegration(e.x, e.y);
          }

          damageEnemy(e, b.dmg, bAngle);

          if(b.explosive){
            spawnExplosion(b.x, b.y, b.radius);
            for(let ei=enemies.length-1; ei>=0; ei--){
              const e2 = enemies[ei];
              if(e2.dead) continue;
              const d2 = dist(b.x, b.y, e2.x, e2.y);
              if(d2 < b.radius){
                _pendingDamage.push({ target: e2, dmg: b.dmg * (1-d2/b.radius) * 0.7, angle: Math.atan2(e2.y-b.y, e2.x-b.x) });
              }
            }
          }
          if(!b.pierce){ bullets.splice(i,1); break; }
        }
      }
    } else {
      // Enemy bullet -> player
      const d = dist(b.x, b.y, player.x, player.y);
      if(d < 16){
        damagePlayer(b.dmg);
        if(b.explosive) spawnExplosion(b.x, b.y, b.radius||60);
        bullets.splice(i,1);
        continue;
      }
    }
  }
}

// =====================================================================
// WAVE MANAGER & BOSSES
// =====================================================================
function spawnBoss(weaponIndex) {
  const name = BOSS_NAMES[weaponIndex-1] || 'Boss';
  // Pick a base enemy type that fits the power level
  const baseIdx = Math.min(Math.floor(weaponIndex * 1.2), ENEMY_TYPES.length - 1);
  const bossHp = 300 + weaponIndex * 250; // Easy/relaxing HP scaling

  const a = Math.random() * Math.PI * 2;
  const sx = player.x + Math.cos(a) * (CFG.VIEW_RANGE + 80);
  const sy = player.y + Math.sin(a) * (CFG.VIEW_RANGE + 80);

  const e = spawnEnemy(baseIdx, sx, sy, { name, hp: bossHp });
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

      const spawnDist = CFG.VIEW_RANGE + 100;
      const a = Math.random() * Math.PI * 2;
      const sx = player.x + Math.cos(a) * spawnDist;
      const sy = player.y + Math.sin(a) * spawnDist;
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
    const d = dist(pk.x, pk.y, player.x, player.y);
    if(d < 25){
      if(pk.type === 'health'){
        player.hp = Math.min(player.hp + pk.amount, player.maxHp);
        playSound('pickup', 0.5);
      } else if(pk.type === 'shield'){
        player.shield = Math.min(player.shield + pk.amount, player.maxShield);
        playSound('pickup', 0.5);
      }
      pickups.splice(i,1);
    }
  }
}
