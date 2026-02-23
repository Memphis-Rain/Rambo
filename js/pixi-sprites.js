// =====================================================================
// PIXI SPRITES - Entity rendering with PixiJS Graphics/Sprites
// Uses GPU instancing for bullets/particles via ParticleContainer
// =====================================================================

// Parse CSS hex color (#rgb or #rrggbb) to numeric hex
function cssColorToHex(color) {
  if (typeof color === 'number') return color;
  const hex = color.replace('#', '');
  if (hex.length === 3) {
    // Expand shorthand: #f4a → #ff44aa
    return parseInt(hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2], 16);
  }
  return parseInt(hex, 16);
}

// Sprite pools for performance optimization
const pixiSpritePool = {
  bullets: [],
  particles: [],
  shells: [],
  bloodPools: [],
  bodies: [],
  enemies: [],
  envObjects: new Map(), // Map for persistent env objects
};

// ParticleContainer for high-performance bullet/particle rendering
let bulletParticleContainer = null;
let particleContainer = null;

// Container for temporary text objects (boss names, damage numbers)
let textContainer = null;

/**
 * Initialize PixiJS sprite pools and containers
 */
function initPixiSprites() {
  // Use regular Container for bullets (ParticleContainer has API restrictions in PixiJS v8)
  bulletParticleContainer = new PIXI.Container();
  bulletParticleContainer.zIndex = 500;
  worldContainer.addChild(bulletParticleContainer);

  // Use regular Container for particles
  particleContainer = new PIXI.Container();
  particleContainer.zIndex = 600;
  worldContainer.addChild(particleContainer);

  // Container for temporary text objects (cleared each frame)
  textContainer = new PIXI.Container();
  textContainer.zIndex = 900; // Render above everything else
  worldContainer.addChild(textContainer);

  console.log('[PIXI-SPRITES] Sprite pools and containers initialized');
}

/**
 * Render all game entities using PixiJS
 */
function renderPixiSprites() {
  // Clear previous frame sprites from pools
  clearSpritePool();

  // Render blood pools (depth sorted, rendered first) - TIMED
  const tBlood0 = performance.now();
  renderBloodPools();
  const tBlood1 = performance.now();
  if (window.perfLog) perfLog.bloodMs = tBlood1 - tBlood0;

  // Collect and depth-sort entities
  const renderList = [];

  for (const b of bodies) {
    renderList.push({ type: 'body', obj: b, depth: depthKey(b.x, b.y) });
  }
  for (const pk of pickups) {
    renderList.push({ type: 'pickup', obj: pk, depth: depthKey(pk.x, pk.y) });
  }
  for (const e of enemies) {
    renderList.push({ type: 'enemy', obj: e, depth: depthKey(e.x, e.y) });
  }
  for (const obj of envObjects) {
    const sp = toScreen(obj.x, obj.y);
    // Convert to actual screen position (account for camera offset + screen centering)
    const sx = sp.x - cam.x + W / 2;
    const sy = sp.y - cam.y + H / 2;
    if (sx > -300 && sx < W + 300 && sy > -300 && sy < H + 300) {
      renderList.push({ type: 'env', obj, depth: depthKey(obj.x, obj.y) });
    }
  }
  if (player) {
    renderList.push({ type: 'player', obj: player, depth: depthKey(player.x, player.y) });
  }

  renderList.sort((a, b) => a.depth - b.depth);

  // Render depth-sorted entities - TIMED
  const tEntities0 = performance.now();
  for (const item of renderList) {
    if (item.type === 'body') renderPixiBody(item.obj);
    else if (item.type === 'pickup') renderPixiPickup(item.obj);
    else if (item.type === 'enemy') renderPixiEnemy(item.obj);
    else if (item.type === 'player') renderPixiPlayer(item.obj);
    else if (item.type === 'env') renderPixiEnvObject(item.obj);
  }
  const tEntities1 = performance.now();
  if (window.perfLog) {
    perfLog.bodiesMs = (tEntities1 - tEntities0) * (bodies.length / Math.max(renderList.length, 1));
    perfLog.enemiesMs = (tEntities1 - tEntities0) * (enemies.length / Math.max(renderList.length, 1));
  }

  // Render shells (no depth sorting needed)
  renderPixiShells();

  // Render bullets and particles - TIMED
  const tBullets0 = performance.now();
  renderPixiBullets();
  const tBullets1 = performance.now();

  const tParticles0 = performance.now();
  renderPixiParticles();
  renderPixiShockwaves();
  renderPixiFloatingTexts();
  const tParticles1 = performance.now();

  if (window.perfLog) {
    perfLog.bulletsMs = tBullets1 - tBullets0;
    perfLog.particlesMs = tParticles1 - tParticles0;
  }
}

/**
 * Clear sprite pools from previous frame
 */
function clearSpritePool() {
  // Remove all children from bullet/particle containers (now regular containers)
  bulletParticleContainer.removeChildren();
  particleContainer.removeChildren();

  // Remove all text objects (boss names, damage numbers) - they're recreated each frame
  textContainer.removeChildren();

  // Mark pooled graphics as invisible and clear instructions for reuse
  pixiSpritePool.bullets.forEach(s => { s.visible = false; if (s.clear) s.clear(); });
  pixiSpritePool.particles.forEach(s => { s.visible = false; if (s.clear) s.clear(); });
  pixiSpritePool.shells.forEach(s => { s.visible = false; if (s.clear) s.clear(); });
  pixiSpritePool.bloodPools.forEach(s => { s.visible = false; if (s.clear) s.clear(); });
  pixiSpritePool.bodies.forEach(s => { s.visible = false; if (s.clear) s.clear(); });
  pixiSpritePool.enemies.forEach(s => { s.visible = false; if (s.clear) s.clear(); });

  // Keep envObjects cache persistent (they're static)
  pixiSpritePool.envObjects.forEach(s => s.visible = false);
}

/**
 * Get a cached Graphics object from pool (reusable)
 */
function getPooledGraphics(poolKey) {
  // Find an available graphics object in the pool
  const pool = pixiSpritePool[poolKey];
  for (let i = 0; i < pool.length; i++) {
    // Skip non-Graphics objects (like Text) that got mixed into the pool
    if (!pool[i].visible && pool[i].clear) {
      pool[i].visible = true;
      pool[i].clear();
      pool[i].alpha = 1;     // Reset alpha to prevent transparency bleeding
      pool[i].lineStyle(0);  // Reset stroke so it doesn't bleed across frames
      return pool[i];
    }
  }

  // If no available graphics, create a new one (with pool size limits)
  const poolLimits = {
    bloodPools: CFG.MAX_BLOOD_POOLS,
    bodies: CFG.MAX_BODIES,
    enemies: CFG.MAX_ENEMIES,
    bullets: CFG.MAX_BULLETS,
    particles: CFG.MAX_PARTICLES,
    shells: 100
  };

  // Check if pool has reached its limit
  if (pool.length >= (poolLimits[poolKey] || 1000)) {
    // Force reuse oldest graphics object if pool is full
    const graphics = pool[0];
    graphics.visible = true;
    graphics.clear();
    graphics.alpha = 1;
    graphics.lineStyle(0);
    return graphics;
  }

  const graphics = new PIXI.Graphics();
  pool.push(graphics);
  worldContainer.addChild(graphics);
  return graphics;
}

// =====================================================================
// PLAYER RENDERING
// =====================================================================
function renderPixiPlayer(p) {
  const sp = toScreen(p.x, p.y);
  const screenX = sp.x;
  const screenY = sp.y;

  const graphics = getPooledGraphics('enemies');
  graphics.zIndex = depthKey(p.x, p.y);

  // Shadow
  graphics.beginFill(0x000000, 0.3);
  graphics.drawEllipse(screenX, screenY + 6, 16, 8);
  graphics.endFill();

  // Dodge roll
  if (p.dodging) {
    graphics.alpha = 0.5;
    graphics.beginFill(0xddbb99);
    graphics.drawEllipse(screenX, screenY - 8, 12, 12);
    graphics.endFill();
    return;
  }

  const hitAlpha = (p.hitFlash > 0 && Math.floor(p.hitFlash * 20) % 2) ? 0.6 : 1;
  graphics.alpha = hitAlpha;

  // Military cargo trousers + boots (drawn before body so torso overlaps naturally)
  const legOff = p.walking ? Math.sin(gameTime * 12) * 3 : 0;
  // Trouser thighs (olive military)
  graphics.beginFill(0x4e5e38);
  graphics.drawEllipse(screenX - 5 + legOff, screenY + 2, 5.5, 8);
  graphics.drawEllipse(screenX + 5 - legOff, screenY + 2, 5.5, 8);
  graphics.endFill();
  // Inner leg shading
  graphics.beginFill(0x3a4a2a);
  graphics.drawEllipse(screenX - 3.5 + legOff, screenY + 3, 3.5, 6);
  graphics.drawEllipse(screenX + 3.5 - legOff, screenY + 3, 3.5, 6);
  graphics.endFill();
  // Cargo pocket on left thigh
  graphics.beginFill(0x384828);
  graphics.drawRect(screenX - 11 + legOff * 0.4, screenY + 1, 5, 3.5);
  graphics.endFill();
  graphics.lineStyle(0.5, 0x2a3820);
  graphics.drawRect(screenX - 11 + legOff * 0.4, screenY + 1, 5, 3.5);
  graphics.lineStyle(0);
  // Boots (dark leather)
  graphics.beginFill(0x1e1209);
  graphics.drawEllipse(screenX - 4.5 + legOff, screenY + 10, 5.5, 4);
  graphics.drawEllipse(screenX + 4.5 - legOff, screenY + 10, 5.5, 4);
  graphics.endFill();
  // Boot toe cap highlight
  graphics.beginFill(0x2e1c0d, 0.5);
  graphics.drawEllipse(screenX - 3 + legOff, screenY + 9, 3.5, 2.5);
  graphics.drawEllipse(screenX + 3 - legOff, screenY + 9, 3.5, 2.5);
  graphics.endFill();

  // Body
  graphics.beginFill(0xcc9966);
  graphics.drawEllipse(screenX, screenY - 8, 11, 13);
  graphics.endFill();
  graphics.beginFill(0xbb8855);
  graphics.drawEllipse(screenX + 1, screenY - 10, 7, 8);
  graphics.endFill();
  graphics.beginFill(0xddaa77);
  graphics.drawEllipse(screenX - 2, screenY - 12, 5, 5);
  graphics.endFill();

  // Ammo belt
  graphics.lineStyle(2, 0x665544);
  graphics.moveTo(screenX - 8, screenY - 14);
  graphics.lineTo(screenX + 6, screenY - 2);
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const bx = lerp(screenX - 8, screenX + 6, t);
    const by = lerp(screenY - 14, screenY - 2, t);
    graphics.lineStyle(1, 0x887766);
    graphics.moveTo(bx - 1, by - 1);
    graphics.lineTo(bx + 1, by + 1);
  }
  graphics.lineStyle(0);

  // Tactical belt + buckle
  graphics.beginFill(0x1e1a0e);
  graphics.drawRect(screenX - 11, screenY - 3, 22, 2.5);
  graphics.endFill();
  // Belt buckle (metal rectangle center)
  graphics.beginFill(0x8a7755);
  graphics.drawRect(screenX - 3, screenY - 3.5, 6, 3.5);
  graphics.endFill();
  graphics.lineStyle(0.5, 0xbbaa77);
  graphics.drawRect(screenX - 3, screenY - 3.5, 6, 3.5);
  graphics.lineStyle(0);

  // Arms + weapon
  const wep = WEAPONS[p.weapon];
  const weapLen = 14 + (Math.min(p.weapon, 6) * 2);
  const armRecoil = p.fireTimer > wep.rate * 0.5 ? 3 : 0;

  // Back arm
  const bax = screenX + Math.cos(p.angle + 0.5) * 8;
  const bay = screenY - 6 + Math.sin(p.angle + 0.5) * 5;
  graphics.lineStyle(4, 0xcc9966);
  graphics.moveTo(screenX, screenY - 6);
  graphics.lineTo(bax, bay);

  // Front arm (drawn before barrel so barrel renders on top)
  const fax = screenX + Math.cos(p.angle - 0.3) * 10;
  const fay = screenY - 6 + Math.sin(p.angle - 0.3) * 6;
  graphics.lineStyle(4, 0xcc9966);
  graphics.moveTo(screenX + 2, screenY - 6);
  graphics.lineTo(fax, fay);

  // Dark tactical gloves at arm endpoints
  graphics.lineStyle(0);
  graphics.beginFill(0x1a1a1a);
  graphics.drawCircle(bax, bay, 2.5);
  graphics.drawCircle(fax, fay, 2.5);
  graphics.endFill();

  // Weapon barrel (drawn after arms so it visually appears on top)
  const weapColor = wep.glow ? (wep.color === '#0ff' ? 0x445566 : wep.color === '#88f' ? 0x444488 : wep.color === '#f0f' ? 0x663366 : wep.color === '#0f0' ? 0x336633 : wep.color === '#f4f' ? 0x664466 : 0x333333) : 0x333333;
  const wxStart = screenX + Math.cos(p.angle) * 8;
  const wyStart = screenY - 6 + Math.sin(p.angle) * 5;
  const wxEnd = screenX + Math.cos(p.angle) * (weapLen - armRecoil);
  const wyEnd = screenY - 6 + Math.sin(p.angle) * (weapLen - armRecoil) * 0.6;
  graphics.lineStyle(wep.name === 'RPG' || wep.name === 'BFG' ? 4 : wep.name === 'Railgun' ? 3.5 : 3, weapColor);
  graphics.moveTo(wxStart, wyStart);
  graphics.lineTo(wxEnd, wyEnd);
  // Weapon grip highlight
  graphics.lineStyle(1, 0x555555);
  graphics.moveTo(wxStart, wyStart);
  graphics.lineTo(wxStart + Math.cos(p.angle) * 5, wyStart + Math.sin(p.angle) * 3);
  graphics.lineStyle(0);

  // Weapon glow effect (add to effects container with blur filter)
  if (wep.glow) {
    const glowGraphics = getPooledGraphics('enemies');
    glowGraphics.zIndex = depthKey(p.x, p.y) + 1;
    const glowColor = wep.color.replace('#', '0x');
    glowGraphics.lineStyle(1.5, parseInt(glowColor, 16));
    glowGraphics.moveTo(wxEnd - Math.cos(p.angle) * 4, wyEnd - Math.sin(p.angle) * 2.5);
    glowGraphics.lineTo(wxEnd, wyEnd);
    effectsContainer.addChild(glowGraphics);
  }

  // Minigun spin
  if (wep.spinUp && p.spinUp > 0) {
    const spinGraphics = getPooledGraphics('enemies');
    spinGraphics.zIndex = depthKey(p.x, p.y) + 1;
    spinGraphics.lineStyle(1, 0x555555);
    for (let i = 0; i < 3; i++) {
      const a = i * Math.PI * 2 / 3 + gameTime * p.spinUp * 30;
      spinGraphics.moveTo(wxEnd + Math.cos(a) * 2, wyEnd + Math.sin(a) * 2);
      spinGraphics.lineTo(wxEnd + Math.cos(a) * 5, wyEnd + Math.sin(a) * 5);
    }
    effectsContainer.addChild(spinGraphics);
  }

  // Head
  graphics.beginFill(0xcc9966);
  graphics.drawEllipse(screenX, screenY - 20, 7, 7);
  graphics.endFill();
  graphics.beginFill(0x332211);
  graphics.drawEllipse(screenX, screenY - 23, 7, 4);
  graphics.endFill();

  // Red scarf (wrapped cloth around neck)
  const scarfWave = Math.sin(gameTime * 2.5) * 0.8;
  // Back fold of scarf (darker, behind)
  graphics.beginFill(0x991111, 0.9);
  graphics.drawEllipse(screenX + 1, screenY - 14, 8, 3.5);
  graphics.endFill();
  // Main scarf wrap (bright red)
  graphics.beginFill(0xdd2222);
  graphics.drawEllipse(screenX, screenY - 15, 9, 4);
  graphics.endFill();
  // Upper scarf fold (lighter highlight)
  graphics.beginFill(0xee3333);
  graphics.drawEllipse(screenX - 1, screenY - 16, 7, 2.5);
  graphics.endFill();
  // Scarf tail hanging down-left with gentle wave
  graphics.lineStyle(3, 0xcc2222);
  graphics.moveTo(screenX - 7, screenY - 15);
  graphics.quadraticCurveTo(screenX - 11 + scarfWave, screenY - 11, screenX - 9 + scarfWave * 1.2, screenY - 7);
  graphics.lineStyle(2, 0xaa1111);
  graphics.moveTo(screenX - 5, screenY - 15);
  graphics.quadraticCurveTo(screenX - 9 + scarfWave * 0.8, screenY - 10, screenX - 7 + scarfWave, screenY - 6);
  graphics.lineStyle(0);

  // Red headband
  graphics.beginFill(0xcc2222);
  graphics.drawRect(screenX - 8, screenY - 22, 16, 3);
  graphics.endFill();
  graphics.alpha = 1;
  const tailWave = Math.sin(gameTime * 3) * 2;
  graphics.lineStyle(2, 0xcc2222);
  graphics.moveTo(screenX + 8, screenY - 21);
  graphics.quadraticCurveTo(screenX + 14, screenY - 18 + tailWave, screenX + 18, screenY - 15 + tailWave);
  graphics.moveTo(screenX + 8, screenY - 20);
  graphics.quadraticCurveTo(screenX + 12, screenY - 16 + tailWave, screenX + 16, screenY - 13 + tailWave * 0.8);
  graphics.lineStyle(0); // Clear stroke so it doesn't bleed to next pooled use
}

// =====================================================================
// ENEMY RENDERING
// =====================================================================
function renderPixiEnemy(e) {
  const t = ENEMY_TYPES[e.type];
  const sp = toScreen(e.x, e.y);
  const screenX = sp.x;
  const screenY = sp.y;
  const s = e.size || t.size;
  const isBoss = e.isBoss;

  const graphics = getPooledGraphics('enemies');
  graphics.zIndex = depthKey(e.x, e.y);

  const bodyColor = cssColorToHex(t.color);
  const isFlashing = e.hitFlash > 0;
  const flashColor = 0xffffff;
  const bc = isFlashing ? flashColor : bodyColor;
  const skinColor = isFlashing ? 0xeeddaa : 0xbb9966;
  const darkBody = isFlashing ? 0xdddddd : darkenColorHex(bodyColor, 0.65);
  const bootColor = isFlashing ? 0x555555 : 0x2a2a22;

  // Shadow
  graphics.alpha = 0.22;
  graphics.beginFill(0x000000);
  graphics.drawEllipse(screenX, screenY + 4 * s, 11 * s, 5 * s);
  graphics.endFill();

  // Boss glow drawn BEFORE body parts so it appears behind the figure
  if (isBoss) {
    graphics.beginFill(0xff0000, 0.2);
    graphics.drawEllipse(screenX, screenY - 4 * s, 16 * s, 20 * s);
    graphics.endFill();
  }

  // Berserker rage aura — drawn BEFORE body so details show through (fill-level alpha)
  if (t.name === 'Berserker' && !isFlashing) {
    graphics.beginFill(0xff2200, 0.18);
    graphics.drawEllipse(screenX, screenY - 6 * s, 15 * s, 19 * s);
    graphics.endFill();
  }

  // Bomber danger pulse aura — drawn BEFORE body (fill-level alpha, pulsing)
  if (t.name === 'Bomber' && !isFlashing) {
    const bomberPulse = 0.10 + Math.sin(gameTime * 9) * 0.06;
    graphics.beginFill(0xff9900, bomberPulse);
    graphics.drawEllipse(screenX, screenY - 6 * s, 13 * s, 16 * s);
    graphics.endFill();
  }

  const hitAlpha = isFlashing ? 0.7 : 1;
  graphics.alpha = hitAlpha;

  // Boots / feet
  const legOff = e.walking ? Math.sin(gameTime * 10) * 3 * s : 0;
  graphics.beginFill(bootColor);
  graphics.drawEllipse(screenX - 3 * s + legOff, screenY + 2 * s, 3 * s, 4 * s);
  graphics.drawEllipse(screenX + 3 * s - legOff, screenY + 2 * s, 3 * s, 4 * s);
  graphics.endFill();

  // Torso (main body)
  graphics.beginFill(bc);
  graphics.drawEllipse(screenX, screenY - 6 * s, 8 * s, 10 * s);
  graphics.endFill();
  // Vest/chest detail
  graphics.beginFill(darkBody);
  graphics.drawEllipse(screenX, screenY - 5 * s, 6 * s, 7 * s);
  graphics.endFill();
  // Belt
  graphics.beginFill(bootColor);
  graphics.drawRect(screenX - 7 * s, screenY + 1 * s, 14 * s, 2 * s);
  graphics.endFill();

  // Back arm (behind body, filled ellipse)
  const ba_x = screenX + Math.cos(e.angle + 0.6) * 7 * s;
  const ba_y = screenY - 5 * s + Math.sin(e.angle + 0.6) * 4 * s;
  graphics.beginFill(skinColor);
  graphics.drawEllipse(ba_x, ba_y, 3 * s, 2.5 * s);
  graphics.endFill();

  // Weapon (drawn between arms)
  if (t.shoots || t.healer) {
    const wsx = screenX + Math.cos(e.angle) * 5 * s;
    const wsy = screenY - 5 * s + Math.sin(e.angle) * 3 * s;
    const wex = screenX + Math.cos(e.angle) * 14 * s;
    const wey = screenY - 5 * s + Math.sin(e.angle) * 8 * s;
    // Gun body
    graphics.beginFill(0x444444);
    const perpX = Math.cos(e.angle + Math.PI / 2) * 1.2 * s;
    const perpY = Math.sin(e.angle + Math.PI / 2) * 1.2 * s;
    graphics.moveTo(wsx + perpX, wsy + perpY);
    graphics.lineTo(wex + perpX, wey + perpY);
    graphics.lineTo(wex - perpX, wey - perpY);
    graphics.lineTo(wsx - perpX, wsy - perpY);
    graphics.closePath();
    graphics.endFill();
    // Muzzle tip
    graphics.beginFill(0x555555);
    graphics.drawCircle(wex, wey, 1.5 * s);
    graphics.endFill();
  }

  // Front arm (filled ellipse)
  const fa_x = screenX + Math.cos(e.angle - 0.3) * 8 * s;
  const fa_y = screenY - 5 * s + Math.sin(e.angle - 0.3) * 4.5 * s;
  graphics.beginFill(skinColor);
  graphics.drawEllipse(fa_x, fa_y, 3 * s, 2.5 * s);
  graphics.endFill();

  // Neck
  graphics.beginFill(skinColor);
  graphics.drawEllipse(screenX, screenY - 14 * s, 3 * s, 3 * s);
  graphics.endFill();

  // Head
  graphics.beginFill(skinColor);
  graphics.drawEllipse(screenX, screenY - 18 * s, 5.5 * s, 5.5 * s);
  graphics.endFill();

  // Helmet / headgear
  if (t.name !== 'Runner' && t.name !== 'Berserker' && t.name !== 'Bomber') {
    const helmetColor = isFlashing ? 0xaaccaa : darkenColorHex(bodyColor, 0.75);
    graphics.beginFill(helmetColor);
    graphics.drawEllipse(screenX, screenY - 20 * s, 6 * s, 4 * s);
    graphics.endFill();
    // Helmet rim
    graphics.beginFill(darkenColorHex(helmetColor, 0.8));
    graphics.drawRect(screenX - 6.5 * s, screenY - 18 * s, 13 * s, 1.5 * s);
    graphics.endFill();
  } else if (t.name === 'Berserker') {
    // Red bandana wrap
    graphics.beginFill(0xcc2222);
    graphics.drawRect(screenX - 6 * s, screenY - 20 * s, 12 * s, 3 * s);
    graphics.endFill();
    // Highlight strip on bandana
    graphics.beginFill(0xff5555, 0.5);
    graphics.drawRect(screenX - 5 * s, screenY - 20 * s, 10 * s, 1 * s);
    graphics.endFill();
    // Bandana knot (right side bump)
    graphics.beginFill(0xaa1111);
    graphics.drawEllipse(screenX + 5 * s, screenY - 18.5 * s, 2.5 * s, 2 * s);
    graphics.endFill();
    // Bandana tail (waving)
    const bTail = Math.sin(gameTime * 5) * 1.5 * s;
    graphics.lineStyle(2 * s, 0xcc2222);
    graphics.moveTo(screenX + 6 * s, screenY - 18 * s);
    graphics.quadraticCurveTo(screenX + 10 * s, screenY - 14 * s + bTail, screenX + 13 * s, screenY - 11 * s + bTail);
    graphics.lineStyle(1 * s, 0xaa1111);
    graphics.moveTo(screenX + 6 * s, screenY - 17 * s);
    graphics.quadraticCurveTo(screenX + 9 * s, screenY - 13 * s + bTail * 0.7, screenX + 11 * s, screenY - 10 * s + bTail * 0.7);
    graphics.lineStyle(0);
  } else if (t.name === 'Bomber') {
    // Balaclava
    graphics.beginFill(0x222222);
    graphics.drawEllipse(screenX, screenY - 19 * s, 6 * s, 4.5 * s);
    graphics.endFill();
    // Eye slit
    graphics.beginFill(skinColor);
    graphics.drawRect(screenX - 4 * s, screenY - 19 * s, 8 * s, 1.5 * s);
    graphics.endFill();
  }

  // Eyes (two small dark dots)
  const eyeOff = Math.cos(e.angle) * 1.5 * s;
  graphics.beginFill(0x111111);
  graphics.drawCircle(screenX - 2 * s + eyeOff, screenY - 18 * s, 1 * s);
  graphics.drawCircle(screenX + 2 * s + eyeOff, screenY - 18 * s, 1 * s);
  graphics.endFill();

  graphics.alpha = 1;

  // Special enemy visuals
  if (t.name === 'Berserker') {
    // War paint slash marks on chest
    graphics.lineStyle(1.5 * s, 0x220000);
    graphics.moveTo(screenX - 5 * s, screenY - 11 * s);
    graphics.lineTo(screenX - 2 * s, screenY - 7 * s);
    graphics.moveTo(screenX + 2 * s, screenY - 11 * s);
    graphics.lineTo(screenX + 5 * s, screenY - 7 * s);
    // Diagonal battle scar across chest
    graphics.lineStyle(1 * s, 0xcc5533, 0.85);
    graphics.moveTo(screenX - 7 * s, screenY - 9 * s);
    graphics.lineTo(screenX + 5 * s, screenY - 5 * s);
    // Muscle definition (pec lines)
    graphics.lineStyle(1 * s, darkenColorHex(bodyColor, 0.45));
    graphics.moveTo(screenX - 7 * s, screenY - 8 * s);
    graphics.lineTo(screenX, screenY - 6 * s);
    graphics.moveTo(screenX + 7 * s, screenY - 8 * s);
    graphics.lineTo(screenX, screenY - 6 * s);
    graphics.lineStyle(0);
    // Dark clenched fists overdrawn on top of arm ellipses
    graphics.beginFill(0x774422);
    graphics.drawEllipse(ba_x, ba_y, 3 * s, 2.5 * s);
    graphics.drawEllipse(fa_x, fa_y, 3 * s, 2.5 * s);
    graphics.endFill();
    graphics.beginFill(0x553311);
    graphics.drawEllipse(ba_x, ba_y, 1.8 * s, 1.5 * s);
    graphics.drawEllipse(fa_x, fa_y, 1.8 * s, 1.5 * s);
    graphics.endFill();
    // Red glowing eyes (overdraw black)
    const eyeOff2 = Math.cos(e.angle) * 1.5 * s;
    graphics.beginFill(0xff2200);
    graphics.drawCircle(screenX - 2 * s + eyeOff2, screenY - 18 * s, 1.4 * s);
    graphics.drawCircle(screenX + 2 * s + eyeOff2, screenY - 18 * s, 1.4 * s);
    graphics.endFill();
    // Inner bright eye pupils
    graphics.beginFill(0xffaa00);
    graphics.drawCircle(screenX - 2 * s + eyeOff2, screenY - 18 * s, 0.6 * s);
    graphics.drawCircle(screenX + 2 * s + eyeOff2, screenY - 18 * s, 0.6 * s);
    graphics.endFill();
    // Angry V-shaped eyebrows
    graphics.lineStyle(1.5 * s, 0x110000);
    graphics.moveTo(screenX - 5 * s + eyeOff2, screenY - 21 * s);
    graphics.lineTo(screenX - 0.5 * s + eyeOff2, screenY - 19.5 * s);
    graphics.moveTo(screenX + 5 * s + eyeOff2, screenY - 21 * s);
    graphics.lineTo(screenX + 0.5 * s + eyeOff2, screenY - 19.5 * s);
    // War paint slash on cheek
    graphics.lineStyle(1 * s, 0x991111);
    graphics.moveTo(screenX - 5 * s + eyeOff2, screenY - 17 * s);
    graphics.lineTo(screenX - 2 * s + eyeOff2, screenY - 15 * s);
    graphics.lineStyle(0);
  }

  if (t.name === 'Bomber') {
    // Explosive vest cross-harness straps
    graphics.lineStyle(1.5 * s, 0x111111);
    graphics.moveTo(screenX - 7 * s, screenY - 13 * s);
    graphics.lineTo(screenX + 2 * s, screenY - 5 * s);
    graphics.moveTo(screenX + 7 * s, screenY - 13 * s);
    graphics.lineTo(screenX - 2 * s, screenY - 5 * s);
    graphics.moveTo(screenX - 7 * s, screenY - 9 * s);
    graphics.lineTo(screenX + 7 * s, screenY - 9 * s);
    graphics.moveTo(screenX - 7 * s, screenY - 6 * s);
    graphics.lineTo(screenX + 7 * s, screenY - 6 * s);
    graphics.lineStyle(0);
    // C4 explosive packs (olive drab blocks)
    graphics.beginFill(0x556633);
    graphics.drawRect(screenX - 5.5 * s, screenY - 12 * s, 3 * s, 2 * s);
    graphics.drawRect(screenX + 2.5 * s, screenY - 12 * s, 3 * s, 2 * s);
    graphics.drawRect(screenX - 3 * s,   screenY - 7.5 * s, 6 * s, 2.5 * s);
    graphics.endFill();
    // Detonator warning light (blinks red/orange)
    const blinkOn = Math.sin(gameTime * 10) > 0;
    graphics.beginFill(blinkOn ? 0xff2200 : 0xff8800);
    graphics.drawCircle(screenX + 4.5 * s, screenY - 7.5 * s, 1.5 * s);
    graphics.endFill();
    // Wire from detonator light
    graphics.lineStyle(0.8 * s, 0x222222);
    graphics.moveTo(screenX + 4.5 * s, screenY - 7.5 * s);
    graphics.lineTo(screenX + 6 * s,   screenY - 10.5 * s);
    graphics.lineStyle(0);
  }

  if (t.healer) {
    // Green cross on chest
    graphics.beginFill(0x00ff00);
    graphics.drawRect(screenX - 1.5 * s, screenY - 10 * s, 3 * s, 7 * s);
    graphics.drawRect(screenX - 3.5 * s, screenY - 8 * s, 7 * s, 3 * s);
    graphics.endFill();
  }

  if (t.hasShield && e.shieldHp > 0) {
    const sa = 0.22 + Math.sin(gameTime * 5) * 0.08;
    graphics.beginFill(0x5082ff, sa);
    graphics.drawEllipse(screenX, screenY - 6 * s, 13 * s, 17 * s);
    graphics.endFill();
  }

  if (t.name === 'Tank' || t.name === 'Juggernaut') {
    // Armor plates
    graphics.beginFill(0x555555);
    graphics.drawRect(screenX - 9 * s, screenY - 12 * s, 18 * s, 14 * s);
    graphics.endFill();
    graphics.beginFill(0x666666);
    graphics.drawRect(screenX - 8 * s, screenY - 11 * s, 16 * s, 12 * s);
    graphics.endFill();
    // Shoulder pads
    graphics.beginFill(0x555555);
    graphics.drawEllipse(screenX - 9 * s, screenY - 8 * s, 4 * s, 3 * s);
    graphics.drawEllipse(screenX + 9 * s, screenY - 8 * s, 4 * s, 3 * s);
    graphics.endFill();
  }

  // Health bar (always visible, above head)
  const barW = 26 * s;
  const barH = 4;
  const barY = screenY - 26 * s;
  const hpRatio = e.hp / e.maxHp;

  // Background (dark outline)
  graphics.beginFill(0x000000);
  graphics.drawRect(screenX - barW / 2 - 1, barY - 1, barW + 2, barH + 2);
  graphics.endFill();
  // Empty bar
  graphics.beginFill(0x440000);
  graphics.drawRect(screenX - barW / 2, barY, barW, barH);
  graphics.endFill();
  // Filled HP
  const hpColor = isBoss ? 0xff8800 : (hpRatio > 0.5 ? 0x44cc44 : hpRatio > 0.25 ? 0xddaa22 : 0xdd3333);
  graphics.beginFill(hpColor);
  graphics.drawRect(screenX - barW / 2, barY, barW * hpRatio, barH);
  graphics.endFill();
  // Shield bar (below HP bar)
  if (e.maxShieldHp > 0 && e.shieldHp > 0) {
    graphics.beginFill(0x000000);
    graphics.drawRect(screenX - barW / 2 - 1, barY + barH + 1, barW + 2, 3);
    graphics.endFill();
    graphics.beginFill(0x2288ff);
    graphics.drawRect(screenX - barW / 2, barY + barH + 2, barW * (e.shieldHp / e.maxShieldHp), 2);
    graphics.endFill();
  }

  // Boss name tag
  if (isBoss) {
    const bossText = new PIXI.Text({
      text: e.bossName,
      style: {
        fontFamily: 'Courier New, monospace',
        fontSize: 12 * s,
        fontWeight: 'bold',
        fill: 0xff4444
      }
    });
    bossText.anchor.set(0.5, 0.5);
    bossText.x = screenX;
    bossText.y = barY - 10;
    bossText.zIndex = depthKey(e.x, e.y) + 1;
    textContainer.addChild(bossText);
  }
}

// Helper function to darken hex colors
function darkenColorHex(hex, factor) {
  const r = ((hex >> 16) & 0xff) * factor | 0;
  const g = ((hex >> 8) & 0xff) * factor | 0;
  const b = (hex & 0xff) * factor | 0;
  return (r << 16) | (g << 8) | b;
}

// =====================================================================
// BODY, PICKUP, ENV OBJECT RENDERING
// =====================================================================
function renderPixiBody(b) {
  const age = gameTime - b.createdAt;
  if (age > CFG.BODY_FADE_END) return;

  const sp = toScreen(b.x, b.y);
  const screenX = sp.x;
  const screenY = sp.y;
  const t = ENEMY_TYPES[b.type];
  const s = b.size;

  let bodyAlpha = Math.max(0.3, b.alpha);
  if (age > CFG.BODY_FADE_START) {
    const fadeT = (age - CFG.BODY_FADE_START) / (CFG.BODY_FADE_END - CFG.BODY_FADE_START);
    bodyAlpha *= (1 - fadeT);
  }
  if (bodyAlpha < 0.02) return;

  const shrink = age > CFG.BODY_FADE_START ? 1 - (age - CFG.BODY_FADE_START) / (CFG.BODY_FADE_END - CFG.BODY_FADE_START) * 0.3 : 1;

  const graphics = getPooledGraphics('bodies');
  graphics.zIndex = depthKey(b.x, b.y);
  graphics.x = screenX;
  graphics.y = screenY;
  graphics.rotation = b.angle * 0.3;
  graphics.alpha = bodyAlpha;

  const bodyColor = cssColorToHex(t.color);
  graphics.beginFill(darkenColorHex(bodyColor, 0.5));
  graphics.drawEllipse(0, 0, 14 * s * shrink, 6 * s * shrink);
  graphics.endFill();

  graphics.beginFill(0x886644);
  graphics.drawEllipse(Math.cos(b.angle) * 10 * s * shrink, Math.sin(b.angle) * 4 * s * shrink, 4 * s * shrink, 4 * s * shrink);
  graphics.endFill();
}

function renderPixiPickup(pk) {
  const sp = toScreen(pk.x, pk.y);
  const screenX = sp.x;
  const screenY = sp.y;
  const bob = Math.sin(gameTime * 4) * 3;

  const graphics = getPooledGraphics('enemies');
  graphics.zIndex = depthKey(pk.x, pk.y);

  if (pk.type === 'health') {
    graphics.beginFill(0x00ff00);
    graphics.drawRect(screenX - 3, screenY - 8 + bob, 6, 12);
    graphics.drawRect(screenX - 6, screenY - 5 + bob, 12, 6);
    graphics.endFill();
    graphics.beginFill(0x88ff88);
    graphics.drawRect(screenX - 2, screenY - 7 + bob, 4, 4);
    graphics.endFill();
  } else if (pk.type === 'shield') {
    graphics.beginFill(0x4488ff);
    graphics.moveTo(screenX, screenY - 10 + bob);
    graphics.lineTo(screenX + 6, screenY - 3 + bob);
    graphics.lineTo(screenX, screenY + 2 + bob);
    graphics.lineTo(screenX - 6, screenY - 3 + bob);
    graphics.closePath();
    graphics.endFill();
    graphics.beginFill(0x88aaff);
    graphics.moveTo(screenX, screenY - 8 + bob);
    graphics.lineTo(screenX + 3, screenY - 4 + bob);
    graphics.lineTo(screenX, screenY - 1 + bob);
    graphics.lineTo(screenX - 3, screenY - 4 + bob);
    graphics.closePath();
    graphics.endFill();
  }
}

function renderPixiEnvObject(obj) {
  // Use cached Graphics object for this env object
  // Include exploded state in key so barrels get re-rendered when they explode
  const stateKey = obj.type === 'barrel' ? `${obj.exploded ? 'X' : (obj.hp || 0)}` : '';
  const key = `${obj.x},${obj.y},${obj.type}${stateKey}`;
  let graphics = pixiSpritePool.envObjects.get(key);

  if (graphics) {
    graphics.visible = true;
    return;
  }

  // Remove old cached version if barrel state changed
  if (obj.type === 'barrel') {
    for (const [k, g] of pixiSpritePool.envObjects) {
      if (k.startsWith(`${obj.x},${obj.y},barrel`)) {
        g.visible = false;
        pixiSpritePool.envObjects.delete(k);
        break;
      }
    }
  }

  const sp = toScreen(obj.x, obj.y);
  const screenX = sp.x;
  const screenY = sp.y;

  // Use 3D meshes for tree types
  if (obj.type === 'tree' || obj.type === 'pine' || obj.type === 'bush' || obj.type === 'deadtree') {
    const graphics = createTreeGraphics(obj.type, obj.radius, obj.height);
    if (graphics) {
      graphics.x = screenX;
      graphics.y = screenY;
      graphics.zIndex = depthKey(obj.x, obj.y);
      worldContainer.addChild(graphics);
      pixiSpritePool.envObjects.set(key, graphics);
    }
    return;
  }

  graphics = new PIXI.Graphics();
  graphics.zIndex = depthKey(obj.x, obj.y);

  // Render based on type (simplified - main shapes only)
  if (obj.type === 'rock' || obj.type === 'boulder') {
    const r = obj.radius;
    graphics.beginFill(0x000000, obj.type === 'boulder' ? 0.25 : 0.18);
    graphics.drawEllipse(screenX + 1, screenY + 2, r * 0.9, r * 0.35);
    graphics.endFill();
    graphics.beginFill(obj.type === 'boulder' ? 0x777766 : 0x888877);
    graphics.drawEllipse(screenX, screenY - r * 0.2, r, r * 0.55);
    graphics.endFill();
    graphics.beginFill(0x999988);
    graphics.drawEllipse(screenX - r * 0.15, screenY - r * 0.35, r * 0.6, r * 0.3);
    graphics.endFill();
  } else if (obj.type === 'barrel' && !obj.exploded) {
    // Shadow
    graphics.alpha = 0.2;
    graphics.beginFill(0x000000);
    graphics.drawEllipse(screenX + 2, screenY + 3, 10, 5);
    graphics.endFill();
    graphics.alpha = 1;
    // Barrel body
    graphics.beginFill(0x883333);
    graphics.drawRect(screenX - 8, screenY - 16, 16, 18);
    graphics.endFill();
    // Metal bands
    graphics.beginFill(0x555555);
    graphics.drawRect(screenX - 9, screenY - 15, 18, 2);
    graphics.drawRect(screenX - 9, screenY - 5, 18, 2);
    graphics.endFill();
    // Top
    graphics.beginFill(0x994444);
    graphics.drawEllipse(screenX, screenY - 16, 8, 4);
    graphics.endFill();
    // Damage visual - darken barrel as it takes damage
    if (obj.hp < obj.maxHp) {
      const dmgRatio = 1 - obj.hp / obj.maxHp;
      // Scorch marks
      graphics.alpha = dmgRatio * 0.6;
      graphics.beginFill(0x222222);
      graphics.drawRect(screenX - 6, screenY - 14, 12, 14);
      graphics.endFill();
      graphics.alpha = 1;
      // HP bar
      graphics.beginFill(0x331111);
      graphics.drawRect(screenX - 10, screenY - 22, 20, 3);
      graphics.endFill();
      graphics.beginFill(0xff2222);
      graphics.drawRect(screenX - 10, screenY - 22, 20 * (obj.hp / obj.maxHp), 3);
      graphics.endFill();
    }
  } else if (obj.type === 'barrel' && obj.exploded) {
    // Explosion crater (ground decal - render below entities like blood pools)
    graphics.zIndex = -999998;
    graphics.alpha = 0.4;
    graphics.beginFill(0x111111);
    graphics.drawEllipse(screenX, screenY + 2, 18, 9);
    graphics.endFill();
    graphics.alpha = 0.3;
    graphics.beginFill(0x332211);
    graphics.drawEllipse(screenX, screenY + 2, 14, 7);
    graphics.endFill();
    // Debris
    graphics.alpha = 0.5;
    graphics.beginFill(0x553322);
    graphics.drawRect(screenX - 8, screenY - 2, 4, 3);
    graphics.drawRect(screenX + 5, screenY + 1, 3, 2);
    graphics.drawRect(screenX - 3, screenY - 4, 3, 2);
    graphics.endFill();
    graphics.alpha = 1;
  }
  // Add more env object types as needed...

  worldContainer.addChild(graphics);
  pixiSpritePool.envObjects.set(key, graphics);
}

// =====================================================================
// SHELLS RENDERING
// =====================================================================
function renderPixiShells() {
  for (const s of shells) {
    const sp = toScreen(s.x, s.y);
    const screenX = sp.x;
    const screenY = sp.y;

    const graphics = getPooledGraphics('shells');
    graphics.x = screenX;
    graphics.y = screenY;
    graphics.rotation = s.rotation;
    graphics.zIndex = 400;

    graphics.beginFill(0xddaa44);
    graphics.drawRect(-s.size, -s.size * 0.4, s.size * 2, s.size * 0.8);
    graphics.endFill();
    graphics.beginFill(0xffcc66);
    graphics.drawRect(-s.size, -s.size * 0.4, s.size * 0.6, s.size * 0.8);
    graphics.endFill();
  }
}

// =====================================================================
// BULLETS RENDERING (using ParticleContainer for GPU instancing)
// =====================================================================
function renderPixiBullets() {
  // Create a simple circle texture for bullets
  if (!renderPixiBullets._bulletTexture) {
    const g = new PIXI.Graphics();
    g.beginFill(0xffffff);
    g.drawCircle(0, 0, 4);
    g.endFill();
    renderPixiBullets._bulletTexture = app.renderer.generateTexture(g);
    g.destroy();
  }

  for (const b of bullets) {
    const sp = toScreen(b.x, b.y);
    const screenX = sp.x;
    const screenY = sp.y;

    // Create sprite from texture
    const sprite = new PIXI.Sprite(renderPixiBullets._bulletTexture);
    sprite.anchor.set(0.5, 0.5);
    sprite.x = screenX;
    sprite.y = screenY;
    sprite.scale.set(b.beam ? b.size * 1.5 / 4 : b.size / 4);

    // Tint based on bullet color
    const bulletColor = cssColorToHex(b.color);
    sprite.tint = bulletColor;

    // ParticleContainer uses addChild, not addParticle
    bulletParticleContainer.addChild(sprite);

    // Bullet trail (add to effects container with glow)
    if (b.glow || b.beam) {
      const tailX = b.x - b.vx * 0.02;
      const tailY = b.y - b.vy * 0.02;
      const tsp = toScreen(tailX, tailY);
      const tScreenX = tsp.x;
      const tScreenY = tsp.y;

      const trailGraphics = getPooledGraphics('enemies');
      trailGraphics.alpha = 0.6;
      trailGraphics.zIndex = 450;
      trailGraphics.lineStyle(b.beam ? b.size * 1.2 : b.size * 0.7, bulletColor);
      trailGraphics.moveTo(tScreenX, tScreenY);
      trailGraphics.lineTo(screenX, screenY);
      trailGraphics.alpha = 1;
      // Note: Already in worldContainer from getPooledGraphics, don't move to effectsContainer
    }
  }
}

// =====================================================================
// PARTICLES RENDERING (using ParticleContainer)
// =====================================================================
function renderPixiParticles() {
  // Create particle texture if not exists
  if (!renderPixiParticles._particleTexture) {
    const g = new PIXI.Graphics();
    g.beginFill(0xffffff);
    g.drawCircle(0, 0, 4);
    g.endFill();
    renderPixiParticles._particleTexture = app.renderer.generateTexture(g);
    g.destroy();
  }

  for (const p of particles) {
    const sp = toScreen(p.x, p.y);
    const screenX = sp.x;
    const screenY = sp.y;

    const lifeRatio = p.life / p.maxLife;
    let alpha = 1;
    if (lifeRatio < p.fadeStart) alpha = lifeRatio / p.fadeStart;

    const sprite = new PIXI.Sprite(renderPixiParticles._particleTexture);
    sprite.anchor.set(0.5, 0.5);
    sprite.x = screenX;
    sprite.y = screenY;
    sprite.scale.set(Math.max(0.5, p.size) / 4);
    sprite.rotation = p.rotation;
    sprite.alpha = alpha;

    // Parse color (handle #rgb, #rrggbb, rgb(), rgba() formats)
    let colorHex = 0xffffff;
    if (p.color.startsWith('#')) {
      colorHex = cssColorToHex(p.color);
    } else if (p.color.startsWith('rgb')) {
      const match = p.color.match(/\d+/g);
      if (match) {
        const r = parseInt(match[0]);
        const g = parseInt(match[1]);
        const b = parseInt(match[2]);
        colorHex = (r << 16) | (g << 8) | b;
      }
    }
    sprite.tint = colorHex;

    // Flash particles render larger
    if (p.type === 'flash') {
      sprite.scale.set(p.size * lifeRatio / 4);
    }

    // ParticleContainer uses addChild, not addParticle
    particleContainer.addChild(sprite);
  }
}

// =====================================================================
// SHOCKWAVE EFFECTS RENDERING
// =====================================================================
function renderPixiShockwaves() {
  for (const sw of shockwaveEffects) {
    const sp = toScreen(sw.x, sw.y);
    const screenX = sp.x;
    const screenY = sp.y;
    const lifeRatio = sw.life / sw.maxLife;
    const isoR = sw.radius;

    const graphics = getPooledGraphics('enemies');
    graphics.zIndex = 700;

    // Outer ring
    graphics.alpha = lifeRatio * 0.7;
    graphics.lineStyle(4 * lifeRatio, 0xffc832);
    graphics.drawEllipse(screenX, screenY, isoR, isoR * CFG.ISO_SCALE);

    // Inner glow ring
    graphics.alpha = lifeRatio * 0.4;
    graphics.lineStyle(8 * lifeRatio, 0xffffc8);
    graphics.drawEllipse(screenX, screenY, isoR * 0.9, isoR * 0.9 * CFG.ISO_SCALE);
    graphics.alpha = 1;

    effectsContainer.addChild(graphics);
  }
}

// =====================================================================
// FLOATING TEXTS RENDERING
// =====================================================================
function renderPixiFloatingTexts() {
  for (const ft of floatingTexts) {
    const sp = toScreen(ft.x, ft.y);
    const screenX = sp.x;
    const screenY = sp.y;
    const alpha = Math.min(1, ft.life / (ft.maxLife * 0.3));

    const text = new PIXI.Text({
      text: ft.text,
      style: {
        fontFamily: 'Courier New, monospace',
        fontSize: ft.size,
        fontWeight: 'bold',
        fill: parseInt(ft.color.replace('#', '0x'), 16)
      }
    });
    text.anchor.set(0.5, 0.5);
    text.x = screenX;
    text.y = screenY - 20;
    text.alpha = alpha;
    text.zIndex = 800;

    textContainer.addChild(text); // Use textContainer for temporary text
  }
}

// =====================================================================
// BLOOD POOLS RENDERING - Batched for performance
// =====================================================================
function renderBloodPools() {
  // Use a SINGLE Graphics object for ALL blood pools (massive performance win)
  if (!renderBloodPools._batchedGraphics) {
    renderBloodPools._batchedGraphics = new PIXI.Graphics();
    renderBloodPools._batchedGraphics.zIndex = -999999; // Below entities but above terrain (-1000000)
    worldContainer.addChild(renderBloodPools._batchedGraphics);
  }

  const graphics = renderBloodPools._batchedGraphics;
  graphics.clear(); // Clear previous frame

  // Draw ALL blood pools in a single Graphics object
  for (let i = bloodPools.length - 1; i >= 0; i--) {
    const bp = bloodPools[i];
    const age = gameTime - bp.createdAt;
    if (age > CFG.BODY_FADE_END) {
      bloodPools.splice(i, 1);
      continue;
    }

    const sp = toScreen(bp.x, bp.y);
    const screenX = sp.x;
    const screenY = sp.y;

    let alpha = Math.max(0.1, bp.alpha);
    if (age > CFG.BODY_FADE_START) {
      const fadeT = (age - CFG.BODY_FADE_START) / (CFG.BODY_FADE_END - CFG.BODY_FADE_START);
      alpha *= (1 - fadeT);
    }
    if (alpha < 0.02) continue;

    // Parse color
    let colorHex = 0x880000;
    if (bp.color.startsWith('rgba')) {
      const match = bp.color.match(/\d+/g);
      if (match) {
        const r = parseInt(match[0]);
        const g = parseInt(match[1]);
        const b = parseInt(match[2]);
        colorHex = (r << 16) | (g << 8) | b;
      }
    }

    // Batch: Set alpha per-ellipse, draw, then reset
    graphics.alpha = Math.max(0.02, alpha);
    graphics.beginFill(colorHex);
    graphics.drawEllipse(screenX, screenY, bp.radius * 1.2, bp.radius * CFG.ISO_SCALE * 1.2);
    graphics.endFill();
  }

  graphics.alpha = 1; // Reset alpha for next frame
}
