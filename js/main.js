// =====================================================================
// MAIN - Game loop, Input, Camera, Notifications, Init
// (canvas, ctx, notifEl, DPR are in state.js)
// =====================================================================

// =====================================================================
// PERFORMANCE LOGGING
// =====================================================================
const perfLog = {
  fps: 0,
  frameTimes: [],
  updateMs: 0,
  renderMs: 0,
  // Detailed layer timing
  terrainMs: 0,
  spritesMs: 0,
  hudMs: 0,
  bloodMs: 0,
  enemiesMs: 0,
  bodiesMs: 0,
  bulletsMs: 0,
  particlesMs: 0,
  minimapMs: 0,
  gpuMs: 0,
  totalCpuMs: 0,
  entities: { enemies: 0, bullets: 0, particles: 0, bodies: 0, bloodPools: 0, envObjects: 0 },
  lastLogTime: 0,
  warnings: [],
  // Heap memory analytics
  heapUsed: 0,
  heapTotal: 0,
  heapLimit: 0,
  heapAllocRate: 0,
  lastHeapUsed: 0,
  lastHeapCheck: 0,

  tick(frameTime) {
    this.frameTimes.push(frameTime);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    this.fps = Math.round(1000 / (this.frameTimes.reduce((a,b) => a+b, 0) / this.frameTimes.length));
  },

  snapshot() {
    this.entities.enemies = enemies.length;
    this.entities.bullets = bullets.length;
    this.entities.particles = particles.length;
    this.entities.bodies = bodies.length;
    this.entities.bloodPools = bloodPools.length;
    this.entities.envObjects = envObjects.length;

    // Heap memory analytics (Chrome only)
    if (performance.memory) {
      const now = performance.now();
      this.heapUsed = performance.memory.usedJSHeapSize;
      this.heapTotal = performance.memory.totalJSHeapSize;
      this.heapLimit = performance.memory.jsHeapSizeLimit;

      // Calculate allocation rate (MB/s)
      if (this.lastHeapCheck > 0) {
        const timeDelta = (now - this.lastHeapCheck) / 1000; // seconds
        const heapDelta = this.heapUsed - this.lastHeapUsed;
        this.heapAllocRate = heapDelta / timeDelta / (1024 * 1024); // MB/s
      }

      this.lastHeapUsed = this.heapUsed;
      this.lastHeapCheck = now;
    }
  },

  warn(msg) {
    const now = performance.now();
    this.warnings.push({ time: now, msg });
    if (this.warnings.length > 20) this.warnings.shift();
    console.warn(`[RAMBO PERF] ${msg}`);
  },

  // Dump full state to console
  dump() {
    console.log(`[RAMBO] FPS: ${this.fps} | CPU: ${this.totalCpuMs.toFixed(1)}ms | GPU: ${this.gpuMs.toFixed(1)}ms`);
    console.log(`[RAMBO] Update: ${this.updateMs.toFixed(1)}ms | Render: ${this.renderMs.toFixed(1)}ms`);
    console.log(`[RAMBO] Layers: Terrain=${this.terrainMs.toFixed(1)}ms Sprites=${this.spritesMs.toFixed(1)}ms HUD=${this.hudMs.toFixed(1)}ms`);
    console.log(`[RAMBO] Sprites Detail: Blood=${this.bloodMs.toFixed(2)}ms Enemies=${this.enemiesMs.toFixed(2)}ms Bodies=${this.bodiesMs.toFixed(2)}ms Bullets=${this.bulletsMs.toFixed(2)}ms`);
    console.log(`[RAMBO] Entities:`, JSON.stringify(this.entities));
    console.log(`[RAMBO] Chunks: ${chunkCache.size} cached`);

    // Heap memory analytics
    if (performance.memory) {
      const usedMB = (this.heapUsed / (1024 * 1024)).toFixed(1);
      const totalMB = (this.heapTotal / (1024 * 1024)).toFixed(1);
      const limitMB = (this.heapLimit / (1024 * 1024)).toFixed(1);
      const usage = ((this.heapUsed / this.heapLimit) * 100).toFixed(1);
      console.log(`[RAMBO] Heap: ${usedMB}MB / ${totalMB}MB (${usage}% of ${limitMB}MB limit) | Alloc rate: ${this.heapAllocRate.toFixed(2)} MB/s`);
    }

    if (this.warnings.length > 0) {
      console.log(`[RAMBO] Recent warnings:`, this.warnings.map(w => w.msg));
    }
  }
};

// Press F3 to toggle debug overlay, F4 to dump perf to console
let showDebugOverlay = false;

function renderDebugOverlay() {
  // TODO: Rebuild with PixiJS Text/Graphics
  if (!showDebugOverlay) return;
}

// =====================================================================
// CAMERA & SCREEN SHAKE
// =====================================================================
function addShake(mag) {
  shakeMag = Math.max(shakeMag, mag);
}

function updateCamera(dt) {
  const sp = toScreen(player.x, player.y);
  cam.tx = sp.x;
  cam.ty = sp.y;
  cam.x += (cam.tx - cam.x) * CFG.CAMERA_SMOOTH * 60 * dt;
  cam.y += (cam.ty - cam.y) * CFG.CAMERA_SMOOTH * 60 * dt;

  if(shakeMag > 0.1) {
    shakeX = (Math.random()-0.5) * shakeMag * 2;
    shakeY = (Math.random()-0.5) * shakeMag * 2;
    shakeMag *= 0.85;
  } else {
    shakeX = 0; shakeY = 0; shakeMag = 0;
  }
}

// =====================================================================
// NOTIFICATIONS
// =====================================================================
function showNotification(text, duration=2) {
  notifText = text;
  notifTimer = duration;
  notifEl.textContent = text;
  notifEl.style.opacity = 1;
}

function updateNotification(dt) {
  if(notifTimer > 0) {
    notifTimer -= dt;
    if(notifTimer <= 0.5) notifEl.style.opacity = notifTimer / 0.5;
    if(notifTimer <= 0) notifEl.style.opacity = 0;
  }
}

// =====================================================================
// INPUT HANDLING
// =====================================================================
function initInput() {
  window.addEventListener('keydown', e => {
    keys[e.key.toLowerCase()] = true;
    if(['arrowup','arrowdown','arrowleft','arrowright',' '].includes(e.key.toLowerCase())) e.preventDefault();
    // F3: toggle debug overlay, F4: dump perf to console
    if(e.key === 'F3') { e.preventDefault(); showDebugOverlay = !showDebugOverlay; }
    if(e.key === 'F4') { e.preventDefault(); perfLog.dump(); }
    if(e.key === 'p' || e.key === 'P') { if(gameStarted) { paused = !paused; if(!paused) gameLoop(performance.now()); else renderPauseOverlay(); } }
  });
  window.addEventListener('keyup', e => {
    keys[e.key.toLowerCase()] = false;
  });
  canvas.addEventListener('mousedown', e => {
    if(e.button === 0) { mouseDown = true; mouseJustPressed = true; }
    if(e.button === 2) { mouseRightDown = true; mouseRightJustPressed = true; }
  });
  canvas.addEventListener('mouseup', e => {
    if(e.button === 0) { mouseDown = false; mouseJustPressed = false; }
    if(e.button === 2) { mouseRightDown = false; }
  });
  canvas.addEventListener('mousemove', e => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('blur', () => {
    Object.keys(keys).forEach(k => keys[k] = false);
    mouseDown = false;
    mouseRightDown = false;
  });
}

// =====================================================================
// RESIZE - handled by PixiJS in state.js
// =====================================================================

// =====================================================================
// UPDATE
// =====================================================================
function update(dt) {
  gameTime += dt;
  updatePlayer(dt);
  processPendingDamage();
  updateEnemies(dt);
  updateBullets(dt);
  processPendingDamage();
  updateWaves(dt);
  updatePickups(dt);
  updateParticles(dt);
  updateCamera(dt);
  updateNotification(dt);

  // Floating texts
  for(let i=floatingTexts.length-1;i>=0;i--){
    floatingTexts[i].life -= dt;
    floatingTexts[i].y -= 40 * dt;
    if(floatingTexts[i].life<=0) floatingTexts.splice(i,1);
  }

  // Walking dust
  if(player && player.walking && Math.random()<0.3){
    spawnParticle(player.x+randRange(-5,5), player.y+randRange(-3,3),
      randRange(-10,10), randRange(-5,5), 0.3, randRange(2,4),
      'rgba(150,130,100,', 'smoke', {gravity:-10,friction:0.95,grow:true,growRate:5,fadeStart:0.3});
  }

  // Ambient smoke from old bodies
  if(bodies.length > 0 && Math.random() < 0.02) {
    const b = bodies[randInt(0, bodies.length-1)];
    if(b && gameTime - b.createdAt < 30) spawnSmoke(b.x, b.y, 1);
  }

  // Cleanup old bodies (after blur/fade)
  for(let i=bodies.length-1;i>=0;i--){
    if(gameTime - bodies[i].createdAt > CFG.BODY_FADE_END) bodies.splice(i,1);
  }

  // Ambient effects - fireflies in dark areas, water sparkles
  if(Math.random() < 0.05 && player){
    const ox = player.x + randRange(-400, 400);
    const oy = player.y + randRange(-400, 400);
    const terrain = getTerrainTypeAt(ox, oy);
    if(terrain === 'dark'){
      // Firefly
      spawnParticle(ox, oy, randRange(-8,8), randRange(-12,-4),
        randRange(1.5, 3), randRange(1, 2.5),
        '#ff0', 'fire', {gravity:0, friction:0.99, shrink:false, fadeStart:0.5});
    } else if(terrain === 'water'){
      // Water sparkle
      spawnParticle(ox, oy, 0, 0,
        randRange(0.2, 0.5), randRange(1, 2),
        '#8cf', 'flash', {gravity:0, friction:1, shrink:false, fadeStart:0});
    }
  }

  // Kill streak announcements
  if(combo === 5) showNotification('KILLING SPREE!', 1.5);
  else if(combo === 10) showNotification('RAMPAGE!', 1.5);
  else if(combo === 20) showNotification('UNSTOPPABLE!', 2);
  else if(combo === 30) showNotification('GODLIKE!', 2);
  else if(combo === 50) showNotification('LEGENDARY!', 2.5);

  mouseJustPressed = false;
}

// =====================================================================
// GAME LOOP
// =====================================================================
function gameLoop(timestamp) {
  if(!gameStarted) return;
  if(paused) return;

  // Use high-resolution timer for uncapped FPS mode
  if(!timestamp) timestamp = performance.now();

  const frameMs = timestamp - lastTime;
  dt = Math.min(frameMs / 1000, 0.05);
  lastTime = timestamp;

  perfLog.tick(frameMs);

  const t0 = performance.now();
  update(dt);
  const t1 = performance.now();

  // Apply camera transform to worldContainer
  worldContainer.x = W / 2 - cam.x + shakeX;
  worldContainer.y = H / 2 - cam.y + shakeY;

  // Render with PixiJS - detailed timing per layer
  const tTerrain0 = performance.now();
  renderPixiTerrain();  // Render terrain chunks
  const tTerrain1 = performance.now();

  const tSprites0 = performance.now();
  renderPixiSprites();  // Render all game entities (depth sorted)
  const tSprites1 = performance.now();

  const tHUD0 = performance.now();
  renderPixiHUD();      // Render UI overlay
  renderDebugOverlay();
  const tHUD1 = performance.now();

  const t2 = performance.now();

  perfLog.updateMs = t1 - t0;
  perfLog.renderMs = t2 - t1;
  perfLog.terrainMs = tTerrain1 - tTerrain0;
  perfLog.spritesMs = tSprites1 - tSprites0;
  perfLog.hudMs = tHUD1 - tHUD0;
  perfLog.totalCpuMs = t2 - t0; // Total JavaScript execution time
  perfLog.gpuMs = frameMs - perfLog.totalCpuMs; // Estimate GPU time
  perfLog.snapshot();

  // Warn on slow frames
  if(perfLog.updateMs > 16) perfLog.warn(`Slow update: ${perfLog.updateMs.toFixed(1)}ms`);
  if(perfLog.renderMs > 16) perfLog.warn(`Slow render: ${perfLog.renderMs.toFixed(1)}ms`);

  // Auto-dump to console every 10s (if overlay is on)
  if(showDebugOverlay && timestamp - perfLog.lastLogTime > 10000) {
    perfLog.lastLogTime = timestamp;
    perfLog.dump();
  }

  // Use uncapped loop or vsync'd requestAnimationFrame
  if(CFG.UNCAPPED_FPS) {
    setTimeout(() => gameLoop(performance.now()), 0);
  } else {
    requestAnimationFrame(gameLoop);
  }
}

async function startGame() {
  document.getElementById('start-screen').style.display = 'none';
  if(!audioCtx) initAudio();

  // Initialize PixiJS renderers
  // await initTerrain(); // Wait for terrain textures to generate (legacy)
  initPixiTerrain();   // Initialize PixiJS terrain textures
  // initTreeShader();    // Initialize 3D tree mesh shader (removed for v8 compatibility)
  initPixiSprites();   // Initialize sprite pools and particle containers
  initPixiHUD();       // Initialize HUD elements

  // Reset game state
  gameTime = 0;
  score = 0;
  kills = 0;
  combo = 0;
  comboTimer = 0;
  bestCombo = 0;
  wave = 0;
  waveTimer = 1;
  waveActive = false;
  enemiesThisWave = 0;
  enemiesSpawned = 0;
  unlockedWeapons = 1;
  bossActive = false;
  bossTarget = -1;
  shieldRegenTimer = 0;
  enemies.length = 0;
  bullets.length = 0;
  particles.length = 0;
  bloodPools.length = 0;
  bodies.length = 0;
  shells.length = 0;
  pickups.length = 0;
  chunkCache.clear();
  envObjects.length = 0;
  envChunks.clear();
  floatingTexts.length = 0;
  shockwaveEffects.length = 0;

  player = createPlayer();
  cam.x = 0; cam.y = 0;

  gameStarted = true;
  lastTime = performance.now();

  // Start game loop (uncapped or vsync'd based on config)
  if(CFG.UNCAPPED_FPS) {
    console.log('[RAMBO] Starting UNCAPPED FPS mode (vsync disabled)');
    setTimeout(() => gameLoop(performance.now()), 0);
  } else {
    console.log('[RAMBO] Starting vsync mode (60 FPS cap)');
    requestAnimationFrame(gameLoop);
  }
}

// Initialize (async for PixiJS)
(async function init() {
  await initPixiApp();
  initInput();
  console.log('Game ready. Click START MISSION to begin.');
})();
