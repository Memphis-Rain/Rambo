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
  // Q2a: totalCpuMs = ALL main-thread JS per displayed frame
  //   = buildMs (update + sprite/HUD build) + retroMs (low-res pass) + stageMs (app.render)
  buildMs: 0,
  retroMs: 0,
  stageMs: 0,
  totalCpuMs: 0,
  cpuSamples: new Float32Array(240), cpuSampleN: 0, // ring buffer for median/p99
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
  // Called after app.render: the frame's full CPU cost is known now
  finishFrame() {
    this.totalCpuMs = this.buildMs + this.retroMs + this.stageMs;
    this.cpuSamples[this.cpuSampleN++ % this.cpuSamples.length] = this.totalCpuMs;
  },

  cpuPercentile(q) {
    const n = Math.min(this.cpuSampleN, this.cpuSamples.length);
    if (!n) return 0;
    const a = Array.from(this.cpuSamples.subarray(0, n)).sort((x, y) => x - y);
    return a[Math.min(n - 1, Math.floor(q * n))];
  },

  dump() {
    console.log(`[RAMBO] FPS: ${this.fps} | CPU: ${this.totalCpuMs.toFixed(1)}ms (median ${this.cpuPercentile(0.5).toFixed(1)} / p99 ${this.cpuPercentile(0.99).toFixed(1)} over ${Math.min(this.cpuSampleN, this.cpuSamples.length)} frames) | GPU: ${this.gpuMs.toFixed(1)}ms`);
    console.log(`[RAMBO] CPU split: Build=${this.buildMs.toFixed(1)}ms (update ${this.updateMs.toFixed(1)} + render build ${this.renderMs.toFixed(1)}) | RetroPass=${this.retroMs.toFixed(1)}ms | AppRender=${this.stageMs.toFixed(1)}ms`);
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
  // J5a: global cap keeps the screen readable whatever stacks up
  shakeMag = Math.min(CFG.SHAKE_MAX, Math.max(shakeMag, mag));
}

const _camMid = { x: 0, y: 0 };
function updateCamera(dt) {
  // M11 K3: the midpoint of the standing and downed players (P1 alone in 1P)
  if (!coopMidpoint(_camMid)) { _camMid.x = player.x; _camMid.y = player.y; }
  const sp = toScreen(_camMid.x, _camMid.y);
  cam.tx = sp.x;
  cam.ty = sp.y;
  coopUpdateZoom(dt); // K3a
  const follow = coopCamFollowMult(); // M11 K3b: 1 in 1P (the original expression, bit for bit)
  if (follow === 1) {
    cam.x += (cam.tx - cam.x) * CFG.CAMERA_SMOOTH * 60 * dt;
    cam.y += (cam.ty - cam.y) * CFG.CAMERA_SMOOTH * 60 * dt;
  } else {
    const k = Math.min(1, CFG.CAMERA_SMOOTH * 60 * dt * follow);
    cam.x += (cam.tx - cam.x) * k;
    cam.y += (cam.ty - cam.y) * k;
  }

  if(shakeMag > 0.1) {
    shakeX = (Math.random()-0.5) * shakeMag * 2;
    shakeY = (Math.random()-0.5) * shakeMag * 2;
    shakeMag *= Math.pow(0.85, dt * 60); // same decay time at any fps
  } else {
    shakeX = 0; shakeY = 0; shakeMag = 0;
  }
}

// =====================================================================
// NOTIFICATIONS
// =====================================================================
// H3: pixel-font banner with a bounce-in and a stepped colour cycle (CSS in
// game.html); long messages use the smaller size so they fit the screen
function showNotification(text, duration=2) {
  notifText = text;
  notifTimer = duration;
  notifEl.textContent = text;
  // .show runs the bounce + colour cycle; removed again once faded out
  notifEl.className = text.length > 18 ? 'notification small show' : 'notification show';
  // Restart the bounce-in for every new message
  notifEl.style.animation = 'none';
  void notifEl.offsetWidth;
  notifEl.style.animation = '';
  notifEl.style.opacity = 1;
}

function updateNotification(dt) {
  if(notifTimer > 0) {
    notifTimer -= dt;
    if(notifTimer <= 0.5) notifEl.style.opacity = notifTimer / 0.5;
    if(notifTimer <= 0) { notifEl.style.opacity = 0; notifEl.classList.remove('show'); }
  }
}

// =====================================================================
// INPUT HANDLING
// =====================================================================
// A real (human) input: ends the demo (swallowed) or resets the title idle timer.
// Returns true when the event must not reach the game.
let _swallowClicksUntil = 0;
function _realInput(pointer) {
  if (typeof demoActive !== 'undefined' && demoActive) {
    stopDemo();
    // D6: the click that ends the demo must not also hit START (key exits
    // have no click to swallow, so a quick real click still starts a game)
    if (pointer) _swallowClicksUntil = performance.now() + 400;
    return true;
  }
  if (!gameStarted && typeof demoNoteInput === 'function') demoNoteInput();
  return false;
}

function initInput() {
  window.addEventListener('keydown', e => {
    if (_realInput()) { e.preventDefault(); return; }
    // M10: a key switches back to keyboard + mouse (and resumes a pad-disconnect pause)
    if (typeof padNoteKey === 'function' && padNoteKey()) { e.preventDefault(); return; }
    keys[e.key.toLowerCase()] = true;
    if(['arrowup','arrowdown','arrowleft','arrowright',' '].includes(e.key.toLowerCase())) e.preventDefault();
    // F3: toggle debug overlay, F4: dump perf to console
    if(e.key === 'F3') { e.preventDefault(); showDebugOverlay = !showDebugOverlay; }
    if(e.key === 'F4') { e.preventDefault(); perfLog.dump(); }
    // F6/F7/F8: retro showcase toggles (R6)
    if(e.key === 'F6') { e.preventDefault(); cycleRetroScale(); }
    if(e.key === 'F7') { e.preventDefault(); toggleRetroDither(); }
    if(e.key === 'F8') { e.preventDefault(); toggleRetroCRT(); }
    if(e.key === 'p' || e.key === 'P') {
      if(gameStarted) {
        paused = !paused;
        lastTime = performance.now();
        renderPauseOverlay();
      }
    }
  });
  window.addEventListener('keyup', e => {
    keys[e.key.toLowerCase()] = false;
  });
  // Capture-phase listener so a click anywhere (title included) ends the demo
  window.addEventListener('mousedown', e => {
    if (_realInput(true)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.addEventListener('click', e => {
    if (performance.now() < _swallowClicksUntil) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.addEventListener('wheel', () => { _realInput(); }, { passive: true });
  canvas.addEventListener('mousedown', e => {
    if(e.button === 0) { mouseDown = true; mouseJustPressed = true; }
    if(e.button === 2) { mouseRightDown = true; mouseRightJustPressed = true; }
  });
  canvas.addEventListener('mouseup', e => {
    if (typeof demoActive !== 'undefined' && demoActive) return;
    if(e.button === 0) { mouseDown = false; mouseJustPressed = false; }
    if(e.button === 2) { mouseRightDown = false; }
  });
  window.addEventListener('mousemove', e => {
    if (typeof demoNoteMouseMove === 'function') demoNoteMouseMove(e.clientX, e.clientY);
    if (typeof padNoteMouseMove === 'function') padNoteMouseMove(e.clientX, e.clientY); // M10: back to mouse aim
    if (typeof demoActive !== 'undefined' && demoActive) return; // the bot owns the cursor
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
  for (let i = 0; i < players.length; i++) updatePlayer(dt, players[i]); // M11 K2: each with its own controls
  coopUpdateDown(dt); // M11 K5: downed timers, revives
  processPendingDamage();
  updateEnemies(dt);
  updateBullets(dt);
  dmgBy = 0;             // M11 K6: no stale shooter for later damage (env, fire)
  updateGrenades(dt);    // M9 N1
  dmgBy = 0;
  updateFire(dt);        // M9 F1-F2: flames, ground fires, burning enemies
  updateWading(dt);      // M9 W2
  updateWater(dt);       // M9 W3-W5: blood clouds, blood concentration (4 Hz)
  updateEnv(dt);         // M8: env reactions, falling trees, debris
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
  for(let pi=0; pi<players.length; pi++){
    const p = players[pi];
    if(p && p.walking && Math.random()<0.3){
      spawnParticle(p.x+randRange(-5,5), p.y+randRange(-3,3),
        randRange(-10,10), randRange(-5,5), 0.3, randRange(2,4),
        'rgba(150,130,100,', 'smoke', {gravity:-10,friction:0.95,grow:true,growRate:5,fadeStart:0.3});
    }
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
    const o = coopSpawnOrigin(_coopAmbO), r = 400 / cam.z; // M11 K3a: the whole zoomed view
    const ox = o.x + randRange(-r, r);
    const oy = o.y + randRange(-r, r);
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
  coopEndFrame(); // M11 K2: P2's edges
}

// =====================================================================
// GAME LOOP - driven by the Pixi ticker (requestAnimationFrame), once per
// display frame (R3): HIGH = update + build graphics, NORMAL = low-res
// world pass (retro.js), LOW = Pixi renders the stage.
// =====================================================================
function gameLoop() {
  if (typeof pollGamepad === 'function') pollGamepad(); // M10 C1: before input is consumed
  const timestamp = performance.now();
  const frameMs = timestamp - lastTime;
  lastTime = timestamp;

  if(!gameStarted) {
    if (typeof updateDemoIdle === 'function') updateDemoIdle(Math.min(frameMs / 1000, 0.1));
    coopTitleTick(); // M11 K2: 2P hint + player count
    return;
  }
  if(paused) return;

  dt = Math.min(frameMs / 1000, 0.05);
  perfLog.tick(frameMs);

  const t0 = performance.now();
  // Hit-stop (G9): freeze the simulation briefly but keep rendering
  if (hitStopTimer > 0) hitStopTimer -= dt;
  else {
    if (typeof demoActive !== 'undefined' && demoActive) updateDemo(dt);
    if (gameStarted) update(dt); // updateDemo may have ended the demo
  }
  const t1 = performance.now();
  if (!gameStarted) return;

  // Pixel-snapped camera offset (R2)
  updateRetroCamera();

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
  perfLog.buildMs = t2 - t0; // totalCpuMs is completed after app.render (finishFrame)
  perfLog.gpuMs = Math.max(0, frameMs - perfLog.buildMs);
  perfLog.snapshot();

  // Warn on slow frames
  if(perfLog.updateMs > 16) perfLog.warn(`Slow update: ${perfLog.updateMs.toFixed(1)}ms`);
  if(perfLog.renderMs > 16) perfLog.warn(`Slow render: ${perfLog.renderMs.toFixed(1)}ms`);

  // Auto-dump to console every 10s (if overlay is on)
  if(showDebugOverlay && timestamp - perfLog.lastLogTime > 10000) {
    perfLog.lastLogTime = timestamp;
    perfLog.dump();
  }
}

let _renderLayersReady = false;

// Reset ALL round state to a fresh game (used by startGame and the demo, D6)
function resetRound() {
  if (!_renderLayersReady) {
    initPixiTerrain();   // Initialize PixiJS terrain textures
    initPixiHUD();       // Initialize HUD elements
    _renderLayersReady = true;
  }
  initPixiSprites();     // (Re)initialize sprite pools and caches (incl. decal layers)
  resetDecalState();     // blood map + growing decals (D6: no trace between rounds)
  resetEnvState();       // M8 E7: intact world for a new round / the demo

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
  pendingBossSpawn = -1;
  shieldRegenTimer = 0;
  shakeX = 0; shakeY = 0; shakeMag = 0;
  notifTimer = 0; notifEl.style.opacity = 0;
  paused = false;
  resetHitStop();
  _pendingDamage.length = 0;
  enemies.length = 0;
  bullets.length = 0;
  particles.length = 0;
  bloodPools.length = 0;
  bodies.length = 0;
  shells.length = 0;
  pickups.length = 0;
  resetGrenades();
  resetFire();
  resetWater();
  for (const sprite of chunkCache.values()) {
    terrainContainer.removeChild(sprite);
    sprite.destroy(true);
  }
  chunkCache.clear();
  clearChunkPlaceholders(); // K2.1
  clearWaterBakes();
  envObjects.length = 0;
  envChunks.clear();
  floatingTexts.length = 0;
  shockwaveEffects.length = 0;
  gibs.length = 0;
  dmgNumbers.length = 0;
  decalVersion++;

  Object.keys(keys).forEach(k => keys[k] = false);
  mouseDown = false; mouseJustPressed = false;
  mouseRightDown = false; mouseRightJustPressed = false;

  player = createPlayer();
  resetCoop(); // M11: back to 1P, zoom 1
  cam.x = 0; cam.y = 0;
  worldOffsetX = null; worldOffsetY = null;
  lastTime = performance.now();
}

function startGame() {
  if (typeof demoActive !== 'undefined' && demoActive) stopDemo();
  document.getElementById('start-screen').style.display = 'none';
  if(!audioCtx) initAudio();
  const p2Pad = coopPendingPad(); // M11 K2: P2 joined on the title
  resetRound();
  if (p2Pad !== null) coopJoin(p2Pad);
  gameStarted = true;
  console.log('[RAMBO] Mission started');
}

// Boot failure (no WebGL, blocked GPU...): say so on the title instead of
// leaving a disabled START button with no explanation
function showBootError(err) {
  console.error('[RAMBO] Boot failed:', err);
  const startBtn = document.getElementById('start-btn');
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'WEBGL UNAVAILABLE'; }
  const hint = document.getElementById('boot-error');
  if (hint) {
    hint.textContent = 'THIS GAME NEEDS WEBGL. ENABLE HARDWARE ACCELERATION OR TRY ANOTHER BROWSER.';
    hint.style.display = 'block';
  }
}

// Initialize (async for PixiJS)
(async function init() {
  try {
    const fontReady = loadHudFont(); // H1: fetch the pixel font while PixiJS starts
    await initPixiApp();
    initRetro();
    // The HUD creates its Text on the first START/demo; the font must be ready by then
    await fontReady;
    initInput();
    lastTime = performance.now();
    app.ticker.add(gameLoop, null, PIXI.UPDATE_PRIORITY.HIGH);
    // P2/Q2a: time Pixi's own stage render (app.render runs at LOW priority)
    let stageT0 = 0;
    app.ticker.add(() => { stageT0 = performance.now(); }, null, PIXI.UPDATE_PRIORITY.LOW + 1);
    app.ticker.add(() => {
      if (!gameStarted || paused) return;
      perfLog.stageMs = performance.now() - stageT0;
      perfLog.finishFrame();
    }, null, PIXI.UPDATE_PRIORITY.LOW - 1);
    const startBtn = document.getElementById('start-btn');
    if (startBtn) startBtn.disabled = false;
    console.log('Game ready. Press START to begin.');
  } catch (err) {
    showBootError(err);
  }
})();
