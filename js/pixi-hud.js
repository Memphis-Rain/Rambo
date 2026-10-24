// =====================================================================
// PIXI HUD - retro HUD (M5): pixel font, bevelled panels, segmented bars
// =====================================================================
// Full-resolution overlay in uiContainer (the retro pipeline does not
// pixelate it). Perf rules (Q2):
// - Text objects are created once in initPixiHUD(). A Text only gets a new
//   .text when the value it shows changes, because Pixi re-rasterises Text on
//   every change. Colours go through .tint, which costs nothing.
// - The panel Graphics are rebuilt only when what they show changes
//   (segment counts, colours, layout). The crosshair is drawn once and moved.

const HUD_FONT = '"Press Start 2P", monospace';

// H1: resolve once the pixel font is usable (or after a timeout, so a font
// failure never blocks boot). Resolves true when the font loaded.
function loadHudFont(timeoutMs = 3000) {
  if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return Promise.resolve(false);
  const load = document.fonts.load('16px "Press Start 2P"').then((faces) => faces.length > 0, () => false);
  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs));
  return Promise.race([load, timeout]).then((ok) => {
    if (ok) console.log('[PIXI-HUD] Pixel font ready');
    else {
      console.warn('[PIXI-HUD] Pixel font not loaded yet, using fallback font');
      // If it arrives after the timeout, re-measure and re-render the HUD text
      load.then((late) => { if (late) refreshHudFonts(); });
    }
    return ok;
  });
}

// Every Text made by hudText(), so a late font load can refresh them
const _hudTexts = [];
function refreshHudFonts() {
  if (PIXI.CanvasTextMetrics && PIXI.CanvasTextMetrics.clearMetrics) PIXI.CanvasTextMetrics.clearMetrics();
  for (const t of _hudTexts) {
    if (!t.destroyed) t.style.update();
  }
  console.log('[PIXI-HUD] Pixel font arrived late; HUD text refreshed');
}

// Per-frame fill/stroke styles, hoisted so rendering allocates nothing
const HUD_STYLE_MM_BOSS = { color: 0xff88ff, alpha: 0.8 };
const HUD_STYLE_MM_DIR = { width: 2, color: 0x44ff44, alpha: 0.9 };
const HUD_STYLE_INVINC = { color: 0xffff00, alpha: 0.15 };

// 90s arcade / DOS palette
const HUD_PAL = {
  face: 0x1a2030,
  faceAlpha: 0.9,
  light: 0x8a99b8,     // raised bevel, top-left
  dark: 0x04060a,      // raised bevel, bottom-right
  outline: 0x000000,
  well: 0x06080d,      // sunken bar well
  wellLight: 0x3c4862, // sunken bevel, bottom-right
  label: 0x8890a4
};

const HUD_SLOT_W = 56, HUD_SLOT_H = 36, HUD_SLOT_GAP = 4;
const HUD_PAN_W = 344, HUD_PAN_H = 118, HUD_PAD = 11;
const HUD_HP_SEGS = 20, HUD_SH_SEGS = 20, HUD_SEG_W = 14;
const HUD_STATS_W = 200;
const HUD_BOSS_SEGS = 40, HUD_BOSS_SEG_W = 10;
const HUD_HP_COLORS = [0x38d838, 0xf0b020, 0xe82020];
const HUD_HP_HI = [0xa8ffa0, 0xffe080, 0xff8080];
const HUD_SPECIAL_CYCLE = [0xffe040, 0xff9020, 0xff3030, 0xffffff]; // stepped, 80 ms each

// HUD elements cache (persistent UI elements)
const hudElements = {
  healthBar: null,       // bottom-left panel (panel + weapon row + HP bar + weapon slots)
  shieldBar: null,       // shield bar graphics
  specialBar: null,      // shockwave bar graphics
  bossHealthBar: null,   // top-center boss bar
  statsPanel: null,      // top-right stats panel (incl. combo bar)
  weaponText: null,
  ammoText: null,
  scoreText: null,
  waveText: null,
  killsText: null,
  comboText: null,
  timeText: null,
  weaponSlots: [],
  minimap: null,
  minimapGraphics: null,
  crosshair: null,
  debugOverlay: null,
  fpsText: null,
  bossNameText: null,
  bossHPText: null,
  hpText: null,
  shieldText: null,
  specialText: null,
  scoreLabelText: null,
  slotTexts: [],
  moreText: null,
  nextText: null,
  bossUnlockText: null,
  invincGraphics: null,
  vignetteGraphics: null,
  shieldVignetteGraphics: null
};

// Last-shown values, so text/graphics are only rebuilt on change
const _hudCache = {
  weapon: -1, ammoKey: NaN, ammoColor: -1,
  hp: NaN, maxHp: NaN, shield: NaN, special: NaN, spReady: null,
  score: NaN, wave: NaN, kills: NaN, secs: NaN, combo: NaN, comboColor: -1,
  bossName: null, bossHp: NaN, bossMaxHp: NaN,
  next: -1, more: -1,
  panelKey: new Float64Array(10),
  shieldKey: new Float64Array(4),
  specialKey: new Float64Array(5),
  statsKey: new Float64Array(6),
  bossKey: new Float64Array(6),
  crossColor: -1
};

// Store v in key[i]; returns 1 when it changed (use with | so all run)
function _hudKey(key, i, v) {
  if (key[i] !== v) { key[i] = v; return 1; }
  return 0;
}

// Crisp pixel-font Text: integer size (multiple of 8), white fill tinted to
// `color`, hard 1-font-pixel drop shadow, nearest-sampled texture, rounded position
function hudText(size, color, extraStyle) {
  const sh = Math.max(1, Math.round(size / 8));
  const style = {
    fontFamily: HUD_FONT,
    fontSize: size,
    fill: 0xffffff,
    dropShadow: { color: 0x000000, alpha: 1, blur: 0, angle: Math.PI / 4, distance: sh * Math.SQRT2 },
    ...extraStyle
  };
  const t = new PIXI.Text({
    text: '',
    style,
    resolution: Math.max(1, Math.floor(DPR)),
    textureStyle: { scaleMode: 'nearest' }
  });
  t.roundPixels = true;
  t.tint = color;
  t._hudTint = color;
  _hudTexts.push(t);
  return t;
}

function _hudTint(t, color) {
  if (t._hudTint !== color) { t._hudTint = color; t.tint = color; }
}

// Hard-edged box: 1 px black outline, `b` px `hi` top-left and `lo` bottom-right edges
function hudBevel(g, x, y, w, h, face, alpha, hi, lo, b) {
  g.rect(x, y, w, h).fill({ color: face, alpha });
  g.rect(x - 1, y - 1, w + 2, 1).rect(x - 1, y + h, w + 2, 1)
    .rect(x - 1, y, 1, h).rect(x + w, y, 1, h).fill(HUD_PAL.outline);
  g.rect(x, y, w, b).rect(x, y + b, b, h - b).fill(hi);
  g.rect(x + b, y + h - b, w - b, b).rect(x + w - b, y + b, b, h - 2 * b).fill(lo);
}

// Raised panel (light top-left, dark bottom-right)
function hudPanel(g, x, y, w, h) {
  hudBevel(g, x, y, w, h, HUD_PAL.face, HUD_PAL.faceAlpha, HUD_PAL.light, HUD_PAL.dark, 2);
}

// Etched horizontal divider (dark line over light line)
function hudDivider(g, x, y, w) {
  g.rect(x, y, w, 1).fill(HUD_PAL.dark);
  g.rect(x, y + 1, w, 1).fill(HUD_PAL.wellLight);
}

// Number of lit blocks: at least one while ratio > 0
function hudSegsLit(ratio, segs) {
  if (!(ratio > 0)) return 0;
  return Math.min(segs, Math.ceil(ratio * segs - 1e-6));
}

// Segmented bar of `segs` discrete blocks in a sunken well; returns its width
function hudSegBar(g, x, y, segs, segW, h, lit, on, onHi, off) {
  const gap = 2;
  const w = segs * segW + (segs - 1) * gap;
  hudBevel(g, x - 2, y - 2, w + 4, h + 4, HUD_PAL.well, 1, HUD_PAL.dark, HUD_PAL.wellLight, 1);
  if (lit < segs) {
    for (let i = lit; i < segs; i++) g.rect(x + i * (segW + gap), y, segW, h);
    g.fill(off);
  }
  if (lit > 0) {
    for (let i = 0; i < lit; i++) g.rect(x + i * (segW + gap), y, segW, h);
    g.fill(on);
    const hh = h >= 8 ? 2 : 1;
    for (let i = 0; i < lit; i++) g.rect(x + i * (segW + gap), y, segW, hh);
    g.fill(onHi);
  }
  return w;
}

/**
 * Initialize HUD elements (called once, after the pixel font has loaded)
 */
function initPixiHUD() {
  hudElements.healthBar = new PIXI.Graphics();
  hudElements.shieldBar = new PIXI.Graphics();
  hudElements.specialBar = new PIXI.Graphics();
  hudElements.bossHealthBar = new PIXI.Graphics();
  hudElements.statsPanel = new PIXI.Graphics();
  hudElements.minimapGraphics = new PIXI.Graphics();
  hudElements.crosshair = new PIXI.Graphics();
  hudElements.minimapGraphics.zIndex = 2000;
  hudElements.crosshair.zIndex = 8500; // above panels and minimap, below pause

  // Bottom-left panel
  hudElements.weaponText = hudText(16, 0xffdd44);
  hudElements.ammoText = hudText(8, 0xbbbbbb);
  hudElements.ammoText.anchor.set(1, 0);
  hudElements.hpText = hudText(8, 0xffffff);
  hudElements.shieldText = hudText(8, 0x5599cc);
  hudElements.specialText = hudText(8, 0x887755);

  // Top-right stats panel
  hudElements.scoreText = hudText(24, 0xffd700);
  hudElements.scoreText.anchor.set(0.5, 0);
  hudElements.scoreLabelText = hudText(8, HUD_PAL.label);
  hudElements.scoreLabelText.text = 'SCORE';
  hudElements.scoreLabelText.anchor.set(0.5, 0);
  hudElements.waveText = hudText(16, 0xff8c00);
  hudElements.waveText.anchor.set(0.5, 0);
  hudElements.killsText = hudText(8, 0xff6a6a);
  hudElements.killsText.anchor.set(0.5, 0);
  hudElements.timeText = hudText(8, 0xa0a4b0);
  hudElements.timeText.anchor.set(0.5, 0);
  hudElements.comboText = hudText(16, 0xffff44);
  hudElements.comboText.anchor.set(0.5, 0);

  // Boss bar
  hudElements.bossNameText = hudText(16, 0xff5555);
  hudElements.bossNameText.anchor.set(0.5, 0);
  hudElements.bossHPText = hudText(8, 0xffffff);
  hudElements.bossHPText.anchor.set(0.5, 0.5);

  // Weapon unlock hints
  hudElements.nextText = hudText(8, 0x9aa4b4);
  hudElements.nextText.anchor.set(0, 1);
  hudElements.bossUnlockText = hudText(8, 0xff4444);
  hudElements.bossUnlockText.text = 'DEFEAT THE BOSS TO UNLOCK!';
  hudElements.bossUnlockText.anchor.set(0, 1);
  hudElements.moreText = hudText(8, 0x9aa4b4);
  hudElements.moreText.anchor.set(0, 0.5);

  // FPS debug text (top-left, only shown when showDebugOverlay=true)
  hudElements.fpsText = hudText(8, 0x00ff00, { lineHeight: 12 });

  // Weapon slot key labels (up to 11); the label never changes per slot
  for (let i = 0; i < 11; i++) {
    const slotText = hudText(8, 0x445566);
    slotText.text = `[${i < 9 ? i + 1 : 0}]`;
    slotText.anchor.set(0.5, 1);
    hudElements.slotTexts.push(slotText);
  }

  // Vignette graphics
  hudElements.invincGraphics = new PIXI.Graphics();
  hudElements.vignetteGraphics = new PIXI.Graphics();
  hudElements.shieldVignetteGraphics = new PIXI.Graphics();

  // Add all to UI container
  uiContainer.addChild(hudElements.healthBar);
  uiContainer.addChild(hudElements.shieldBar);
  uiContainer.addChild(hudElements.specialBar);
  uiContainer.addChild(hudElements.bossHealthBar);
  uiContainer.addChild(hudElements.statsPanel);
  uiContainer.addChild(hudElements.minimapGraphics);
  uiContainer.addChild(hudElements.crosshair);
  uiContainer.addChild(hudElements.weaponText);
  uiContainer.addChild(hudElements.ammoText);
  uiContainer.addChild(hudElements.scoreText);
  uiContainer.addChild(hudElements.waveText);
  uiContainer.addChild(hudElements.killsText);
  uiContainer.addChild(hudElements.comboText);
  uiContainer.addChild(hudElements.timeText);
  uiContainer.addChild(hudElements.fpsText);
  uiContainer.addChild(hudElements.bossNameText);
  uiContainer.addChild(hudElements.bossHPText);
  uiContainer.addChild(hudElements.hpText);
  uiContainer.addChild(hudElements.shieldText);
  uiContainer.addChild(hudElements.specialText);
  uiContainer.addChild(hudElements.scoreLabelText);
  uiContainer.addChild(hudElements.moreText);
  uiContainer.addChild(hudElements.nextText);
  uiContainer.addChild(hudElements.bossUnlockText);
  for (const t of hudElements.slotTexts) uiContainer.addChild(t);
  uiContainer.addChild(hudElements.invincGraphics);
  uiContainer.addChild(hudElements.vignetteGraphics);
  uiContainer.addChild(hudElements.shieldVignetteGraphics);

  // Initially hide optional elements
  hudElements.bossNameText.visible = false;
  hudElements.bossHPText.visible = false;
  hudElements.moreText.visible = false;
  hudElements.nextText.visible = false;
  hudElements.bossUnlockText.visible = false;
  hudElements.comboText.visible = false;
  hudElements.invincGraphics.visible = false;
  hudElements.vignetteGraphics.visible = false;
  hudElements.shieldVignetteGraphics.visible = false;
  hudElements.fpsText.visible = false;

  console.log('[PIXI-HUD] HUD elements initialized');
}

/**
 * Render all HUD elements
 */
function renderPixiHUD() {
  const p = player;
  if (!p) return;
  const hpRatio = p.hp / p.maxHp;
  const Wi = Math.floor(W), Hi = Math.floor(H);

  renderHudBoss(Wi);
  renderHudPlayerPanel(p, hpRatio, Wi, Hi);
  renderHudStats(Wi);

  // =========================================================
  // MINIMAP (bottom-right)
  // =========================================================
  const tMinimap0 = performance.now();
  renderPixiMinimap();
  const tMinimap1 = performance.now();
  if (window.perfLog) perfLog.minimapMs = tMinimap1 - tMinimap0;

  // =========================================================
  // CROSSHAIR
  // =========================================================
  renderPixiCrosshair();

  // =========================================================
  // VIGNETTES
  // =========================================================
  renderPixiVignettes(hpRatio);

  // =========================================================
  // FPS DEBUG (only visible when F3 is on)
  // =========================================================
  hudElements.fpsText.visible = showDebugOverlay;
  if (showDebugOverlay) {
    try {
      const fps = perfLog ? perfLog.fps : Math.round(1 / dt);
      const cpuTotal = perfLog ? perfLog.totalCpuMs.toFixed(1) : (dt * 1000).toFixed(1);
      const gpuTime = perfLog ? perfLog.gpuMs.toFixed(1) : '?';
      const terrain = perfLog ? perfLog.terrainMs.toFixed(1) : '?';
      const sprites = perfLog ? perfLog.spritesMs.toFixed(1) : '?';
      const hud = perfLog ? perfLog.hudMs.toFixed(1) : '?';
      const blood = perfLog ? perfLog.bloodMs.toFixed(2) : '?';
      const enemiesTime = perfLog ? perfLog.enemiesMs.toFixed(2) : '?';
      const bodiesTime = perfLog ? perfLog.bodiesMs.toFixed(2) : '?';
      const bulletsTime = perfLog ? perfLog.bulletsMs.toFixed(2) : '?';
      const particles = perfLog ? perfLog.particlesMs.toFixed(2) : '?';
      const minimap = perfLog ? perfLog.minimapMs.toFixed(2) : '?';
      const bp = (typeof bloodPools !== 'undefined') ? bloodPools.length : 0;
      const e = (typeof enemies !== 'undefined') ? enemies.length : 0;
      const b = (typeof bullets !== 'undefined') ? bullets.length : 0;
      const uiObjs = (typeof uiContainer !== 'undefined') ? uiContainer.children.length : 0;
      const worldObjs = (typeof worldContainer !== 'undefined') ? worldContainer.children.length : 0;
      const terrainObjs = (typeof terrainContainer !== 'undefined') ? terrainContainer.children.length : 0;
      let heapLine = '';
      if (perfLog && performance.memory) {
        const usedMB = (perfLog.heapUsed / (1024 * 1024)).toFixed(1);
        const totalMB = (perfLog.heapTotal / (1024 * 1024)).toFixed(1);
        const limitMB = (perfLog.heapLimit / (1024 * 1024)).toFixed(0);
        const usage = ((perfLog.heapUsed / perfLog.heapLimit) * 100).toFixed(1);
        heapLine = `\nHeap: ${usedMB}/${totalMB}MB (${usage}% of ${limitMB}MB) | Alloc: ${perfLog.heapAllocRate.toFixed(2)}MB/s`;
      }
      hudElements.fpsText.text =
        `FPS: ${fps} | CPU: ${cpuTotal}ms | GPU: ${gpuTime}ms\n` +
        `Layers: T=${terrain} S=${sprites} H=${hud}\n` +
        `Detail: Blood=${blood} Enemy=${enemiesTime} Body=${bodiesTime} Bullet=${bulletsTime} Part=${particles} Map=${minimap}\n` +
        `Counts: BP=${bp} E=${e} B=${b} | UI=${uiObjs} World=${worldObjs} Terr=${terrainObjs}` +
        heapLine;
      hudElements.fpsText.x = 20;
      hudElements.fpsText.y = 50;
    } catch (err) {
      hudElements.fpsText.text = `FPS: ${Math.round(1/dt)} | ${err.message}`;
      hudElements.fpsText.x = 20;
      hudElements.fpsText.y = 50;
    }
  }

  // =========================================================
  // PAUSE OVERLAY
  // =========================================================
  renderPauseOverlay();
}

// =========================================================
// BOSS HEALTH BAR (top center)
// =========================================================
function renderHudBoss(Wi) {
  const c = _hudCache;
  const g = hudElements.bossHealthBar;
  let boss = null;
  for (let i = 0; i < enemies.length; i++) {
    if (enemies[i].isBoss) { boss = enemies[i]; break; }
  }
  if (!boss) {
    if (c.bossKey[0] !== 0) { g.clear(); c.bossKey.fill(0); }
    hudElements.bossNameText.visible = false;
    hudElements.bossHPText.visible = false;
    return;
  }

  const bw = HUD_BOSS_SEGS * HUD_BOSS_SEG_W + (HUD_BOSS_SEGS - 1) * 2;
  const bx = Math.floor((Wi - bw) / 2), by = 38, bh = 16;
  const hasShield = boss.maxShieldHp > 0 && boss.shieldHp > 0;
  const lit = hudSegsLit(boss.hp / boss.maxHp, HUD_BOSS_SEGS);
  const shieldW = hasShield ? Math.round(bw * (boss.shieldHp / boss.maxShieldHp)) : -1;

  const k = c.bossKey;
  if (_hudKey(k, 0, 1) | _hudKey(k, 1, Wi) | _hudKey(k, 2, lit) | _hudKey(k, 3, shieldW)) {
    g.clear();
    hudPanel(g, bx - 14, 8, bw + 28, hasShield ? 66 : 58);
    hudSegBar(g, bx, by, HUD_BOSS_SEGS, HUD_BOSS_SEG_W, bh, lit, 0xd82020, 0xff8080, 0x3a0808);
    if (hasShield) {
      const sy = by + bh + 4;
      g.rect(bx, sy, bw, 4).fill(0x102850);
      if (shieldW > 0) g.rect(bx, sy, shieldW, 4).fill(0x2a88ff);
    }
  }

  // Boss name - centered above bar
  const name = boss.bossName || 'BOSS';
  if (c.bossName !== name) {
    c.bossName = name;
    hudElements.bossNameText.text = name.toUpperCase();
  }
  hudElements.bossNameText.x = Wi >> 1;
  hudElements.bossNameText.y = 14;
  hudElements.bossNameText.visible = true;

  // HP numbers centered in bar
  const hpNow = Math.ceil(boss.hp);
  if (c.bossHp !== hpNow || c.bossMaxHp !== boss.maxHp) {
    c.bossHp = hpNow; c.bossMaxHp = boss.maxHp;
    hudElements.bossHPText.text = `${hpNow} / ${boss.maxHp}`;
  }
  hudElements.bossHPText.x = Wi >> 1;
  hudElements.bossHPText.y = by + (bh >> 1);
  hudElements.bossHPText.visible = true;
}

// =========================================================
// PLAYER STATUS PANEL (bottom-left) + WEAPON SLOTS
// =========================================================
function renderHudPlayerPanel(p, hpRatio, Wi, Hi) {
  const c = _hudCache;
  const wep = WEAPONS[p.weapon];
  const panX = 12;
  const slotRowY = Hi - HUD_SLOT_H - 12;
  const panY = slotRowY - 10 - HUD_PAN_H;
  const barX = panX + HUD_PAD + 2;

  const hpLit = hudSegsLit(hpRatio, HUD_HP_SEGS);
  const hpIdx = hpRatio > 0.6 ? 0 : hpRatio > 0.3 ? 1 : 2;
  const maxVisible = Math.min(unlockedWeapons, 8);
  const hasNext = unlockedWeapons < WEAPONS.length && !bossActive;
  let nextSegs = -1;
  if (hasNext) {
    const next = WEAPONS[unlockedWeapons];
    const prevUnlock = unlockedWeapons > 1 ? WEAPONS[unlockedWeapons - 1].unlock : 0;
    nextSegs = Math.floor(clamp((score - prevUnlock) / (next.unlock - prevUnlock), 0, 1) * 10);
  }

  // --- Panel, HP bar, slots, unlock progress (rebuilt on change only) ---
  const k = c.panelKey;
  if (_hudKey(k, 0, Hi) | _hudKey(k, 1, hpLit) | _hudKey(k, 2, hpIdx) | _hudKey(k, 3, p.weapon) |
      _hudKey(k, 4, maxVisible) | _hudKey(k, 5, nextSegs) | _hudKey(k, 6, 1)) {
    const g = hudElements.healthBar;
    g.clear();
    hudPanel(g, panX, panY, HUD_PAN_W, HUD_PAN_H);
    hudDivider(g, panX + 6, panY + 30, HUD_PAN_W - 12);
    hudSegBar(g, barX, panY + 46, HUD_HP_SEGS, HUD_SEG_W, 12, hpLit, HUD_HP_COLORS[hpIdx], HUD_HP_HI[hpIdx], 0x2a1010);

    // Weapon slots
    for (let i = 0; i < maxVisible; i++) {
      const sx = panX + i * (HUD_SLOT_W + HUD_SLOT_GAP);
      if (i === p.weapon) {
        // Pressed-in gold slot
        hudBevel(g, sx, slotRowY, HUD_SLOT_W, HUD_SLOT_H, 0x3a2a08, 0.95, 0x806010, 0xffe060, 2);
      } else {
        hudBevel(g, sx, slotRowY, HUD_SLOT_W, HUD_SLOT_H, 0x121722, 0.85, 0x56637e, HUD_PAL.dark, 2);
      }
      drawWeaponSlotIcon(g, sx + HUD_SLOT_W / 2, slotRowY + 14, i, i === p.weapon);
    }

    // Next-unlock progress (10 blocks, right of the hint)
    if (nextSegs >= 0) {
      hudSegBar(g, panX + HUD_PAN_W - 80, panY - 12, 10, 6, 4, nextSegs, 0x44cc44, 0xa0ffa0, 0x0e1a0e);
    }
  }

  // --- Weapon name + ammo ---
  if (c.weapon !== p.weapon) {
    c.weapon = p.weapon;
    hudElements.weaponText.text = wep.name.toUpperCase();
  }
  hudElements.weaponText.x = panX + HUD_PAD;
  hudElements.weaponText.y = panY + 10;

  const ammoKey = p.reloading ? -1 - Math.round(p.reloadTimer * 10) : wep.mag === Infinity ? 1e9 : p.magAmmo * 10000 + wep.mag;
  if (c.ammoKey !== ammoKey) {
    c.ammoKey = ammoKey;
    hudElements.ammoText.text = p.reloading
      ? `RELOADING ${p.reloadTimer.toFixed(1)}s`
      : wep.mag === Infinity ? 'INF' : `${p.magAmmo} / ${wep.mag}`;
  }
  _hudTint(hudElements.ammoText, p.reloading ? 0xff8800
    : p.magAmmo <= Math.ceil(wep.mag * 0.25) ? 0xff4444 : 0xbbbbbb);
  hudElements.ammoText.x = panX + HUD_PAN_W - HUD_PAD;
  hudElements.ammoText.y = panY + 14;

  // --- HP label (blinks white/red when low) ---
  const hpNow = Math.ceil(p.hp);
  if (c.hp !== hpNow || c.maxHp !== p.maxHp) {
    c.hp = hpNow; c.maxHp = p.maxHp;
    hudElements.hpText.text = `HP ${hpNow}/${p.maxHp}`;
  }
  const lowBlink = hpIdx === 2 && (Math.floor(gameTime / 0.25) & 1) === 1;
  _hudTint(hudElements.hpText, lowBlink ? 0xffffff : HUD_HP_COLORS[hpIdx]);
  hudElements.hpText.x = barX;
  hudElements.hpText.y = panY + 35;
  hudElements.hpText.visible = true;

  // --- Shield bar ---
  const shieldRatio = p.shield / p.maxShield;
  const shLit = hudSegsLit(shieldRatio, HUD_SH_SEGS);
  const sbY = panY + 76;
  const sk = c.shieldKey;
  if (_hudKey(sk, 0, sbY) | _hudKey(sk, 1, shLit) | _hudKey(sk, 2, 1)) {
    hudElements.shieldBar.clear();
    hudSegBar(hudElements.shieldBar, barX, sbY, HUD_SH_SEGS, HUD_SEG_W, 6, shLit, 0x3878f0, 0x98c0ff, 0x121a30);
  }
  const shNow = Math.ceil(p.shield);
  if (c.shield !== shNow) {
    c.shield = shNow;
    hudElements.shieldText.text = `SHIELD ${shNow}`;
  }
  _hudTint(hudElements.shieldText, shieldRatio > 0 ? 0x66aaee : 0x445566);
  hudElements.shieldText.x = barX;
  hudElements.shieldText.y = sbY - 13;
  hudElements.shieldText.visible = true;

  // --- Shockwave bar (stepped colour cycle when ready) ---
  const spMax = CFG.SPECIAL_MAX_CHARGE;
  const spReady = p.specialCharge >= spMax;
  const spSegs = Math.min(spMax, 20);
  const spSegW = Math.floor((HUD_HP_SEGS * HUD_SEG_W + (HUD_HP_SEGS - 1) * 2 - (spSegs - 1) * 2) / spSegs);
  const spLit = hudSegsLit(p.specialCharge / spMax, spSegs);
  const spColor = spReady ? HUD_SPECIAL_CYCLE[Math.floor(gameTime / 0.08) & 3] : 0xd08820;
  const spY = panY + 104;
  const pk = c.specialKey;
  if (_hudKey(pk, 0, spY) | _hudKey(pk, 1, spLit) | _hudKey(pk, 2, spColor) | _hudKey(pk, 3, spSegs)) {
    hudElements.specialBar.clear();
    hudSegBar(hudElements.specialBar, barX, spY, spSegs, spSegW, 6, spLit, spColor,
      spReady ? 0xffffff : 0xffc860, 0x1e1808);
  }
  if (c.special !== p.specialCharge || c.spReady !== spReady) {
    c.special = p.specialCharge; c.spReady = spReady;
    hudElements.specialText.text = spReady ? 'SHOCKWAVE READY!' : `SHOCKWAVE ${p.specialCharge}/${spMax}`;
  }
  _hudTint(hudElements.specialText, spReady ? spColor : 0x998866);
  hudElements.specialText.x = barX;
  hudElements.specialText.y = spY - 13;
  hudElements.specialText.visible = true;

  // --- Slot key labels ---
  for (let i = 0; i < maxVisible; i++) {
    const t = hudElements.slotTexts[i];
    _hudTint(t, i === p.weapon ? 0xffdd44 : 0x5a6a80);
    t.x = panX + i * (HUD_SLOT_W + HUD_SLOT_GAP) + HUD_SLOT_W / 2;
    t.y = slotRowY + HUD_SLOT_H - 3;
    t.visible = true;
  }
  for (let i = maxVisible; i < hudElements.slotTexts.length; i++) {
    hudElements.slotTexts[i].visible = false;
  }

  // +N more hint
  if (unlockedWeapons > maxVisible) {
    const more = unlockedWeapons - maxVisible;
    if (c.more !== more) {
      c.more = more;
      hudElements.moreText.text = `+${more} (Q/E)`;
    }
    hudElements.moreText.x = panX + maxVisible * (HUD_SLOT_W + HUD_SLOT_GAP) + 4;
    hudElements.moreText.y = slotRowY + HUD_SLOT_H / 2;
    hudElements.moreText.visible = true;
  } else {
    hudElements.moreText.visible = false;
  }

  // Next unlock / boss active hint (above panel)
  if (hasNext) {
    if (c.next !== unlockedWeapons) {
      c.next = unlockedWeapons;
      const next = WEAPONS[unlockedWeapons];
      hudElements.nextText.text = `NEXT: ${next.name.toUpperCase()} @ ${next.unlock} PTS`;
    }
    hudElements.nextText.x = panX + HUD_PAD;
    hudElements.nextText.y = panY - 6;
    hudElements.nextText.visible = true;
    hudElements.bossUnlockText.visible = false;
  } else if (bossActive) {
    hudElements.bossUnlockText.x = panX + HUD_PAD;
    hudElements.bossUnlockText.y = panY - 6;
    hudElements.bossUnlockText.visible = (Math.floor(gameTime / 0.4) & 1) === 0; // stepped blink
    hudElements.nextText.visible = false;
  } else {
    hudElements.nextText.visible = false;
    hudElements.bossUnlockText.visible = false;
  }
}

// =========================================================
// TOP-RIGHT STATS PANEL
// =========================================================
function renderHudStats(Wi) {
  const c = _hudCache;
  const hasCombo = combo > 1;
  const rPW = HUD_STATS_W, rPH = hasCombo ? 152 : 118;
  const rPX = Wi - rPW - 12, rPY = 12;
  const cx = rPX + (rPW >> 1);
  const comboColor = combo > 10 ? 0xff2222 : combo > 5 ? 0xffaa00 : 0xffff44;
  const comboSegs = hasCombo ? Math.ceil(clamp(comboTimer / CFG.COMBO_TIMEOUT, 0, 1) * 16) : -1;

  const k = c.statsKey;
  if (_hudKey(k, 0, Wi) | _hudKey(k, 1, comboSegs) | _hudKey(k, 2, hasCombo ? comboColor : -1) | _hudKey(k, 3, 1)) {
    const g = hudElements.statsPanel;
    g.clear();
    hudPanel(g, rPX, rPY, rPW, rPH);
    hudDivider(g, rPX + 6, rPY + 56, rPW - 12);
    if (hasCombo) {
      hudDivider(g, rPX + 6, rPY + 114, rPW - 12);
      // 16 blocks x 9 px + 15 gaps x 2 px = 174 px
      hudSegBar(g, rPX + 13, rPY + 140, 16, 9, 4, comboSegs, comboColor, 0xffffff, 0x1a1408);
    }
  }

  // Score (large, centered; smaller once it no longer fits)
  if (c.score !== score) {
    c.score = score;
    const s = score.toLocaleString();
    const size = s.length <= 7 ? 24 : 16;
    if (hudElements.scoreText.style.fontSize !== size) {
      hudElements.scoreText.style.fontSize = size;
      hudElements.scoreText.style.dropShadow = { color: 0x000000, alpha: 1, blur: 0, angle: Math.PI / 4, distance: (size / 8) * Math.SQRT2 };
    }
    hudElements.scoreText.text = s;
  }
  hudElements.scoreText.x = cx;
  hudElements.scoreText.y = rPY + (hudElements.scoreText.style.fontSize === 24 ? 12 : 16);

  hudElements.scoreLabelText.x = cx;
  hudElements.scoreLabelText.y = rPY + 42;
  hudElements.scoreLabelText.visible = true;

  if (c.wave !== wave) {
    c.wave = wave;
    hudElements.waveText.text = `WAVE ${wave}`;
  }
  hudElements.waveText.x = cx;
  hudElements.waveText.y = rPY + 66;

  if (c.kills !== kills) {
    c.kills = kills;
    hudElements.killsText.text = `KILLS ${kills}`;
  }
  hudElements.killsText.x = cx;
  hudElements.killsText.y = rPY + 88;

  const secsTotal = Math.floor(gameTime);
  if (c.secs !== secsTotal) {
    c.secs = secsTotal;
    const secs = secsTotal % 60;
    hudElements.timeText.text = `TIME ${Math.floor(secsTotal / 60)}:${secs < 10 ? '0' : ''}${secs}`;
  }
  hudElements.timeText.x = cx;
  hudElements.timeText.y = rPY + 102;

  if (hasCombo) {
    if (c.combo !== combo) {
      c.combo = combo;
      hudElements.comboText.text = `COMBO x${combo}`;
    }
    _hudTint(hudElements.comboText, comboColor);
    hudElements.comboText.x = cx;
    hudElements.comboText.y = rPY + 120;
    hudElements.comboText.visible = true;
  } else {
    hudElements.comboText.visible = false;
  }
}

/**
 * Draw a weapon silhouette icon inside a slot using filled shapes.
 * cx/cy = center of the icon area within the slot.
 */
function drawWeaponSlotIcon(g, cx, cy, weapIdx, selected) {
  const col   = selected ? 0xffdd44 : 0x4a6677;
  const alpha = selected ? 1.0 : 0.72;

  // Shorthand for a filled rect with the weapon color
  const fr = (x, y, w, h) => {
    g.rect(x, y, w, h).fill({ color: col, alpha });
  };

  switch (weapIdx) {
    case 0: { // Pistol – compact L-shape
      fr(cx - 2, cy - 4, 10, 5);      // slide/barrel
      fr(cx - 8, cy - 4, 6,  7);      // frame
      fr(cx - 6, cy + 3, 4,  8);      // grip
      break;
    }
    case 1: { // Uzi – boxy SMG
      fr(cx - 8, cy - 5, 14, 10);     // body
      fr(cx + 6, cy - 3,  6,  6);     // short barrel
      fr(cx - 3, cy + 5,  5,  7);     // grip
      break;
    }
    case 2: { // Shotgun – double barrel
      fr(cx - 14, cy - 5, 24, 3);     // top barrel
      fr(cx - 14, cy + 2, 24, 3);     // bottom barrel
      fr(cx - 14, cy - 5,  2, 10);    // muzzle cap
      fr(cx + 10, cy - 2,  4,  4);    // stock stub
      break;
    }
    case 3: { // M16 – long assault rifle
      fr(cx - 16, cy - 2, 28, 4);     // barrel + body
      fr(cx -  2, cy + 2,  8, 5);     // magazine
      fr(cx - 16, cy + 2,  7, 4);     // stock
      break;
    }
    case 4: { // Minigun – triple barrel cluster
      fr(cx - 6, cy - 7, 16, 3);      // barrel row 1
      fr(cx - 6, cy - 2, 16, 3);      // barrel row 2
      fr(cx - 6, cy + 3, 16, 3);      // barrel row 3
      fr(cx - 9, cy - 8,  5, 16);     // hub
      fr(cx - 4, cy + 6,  5,  5);     // grip
      break;
    }
    case 5: { // RPG – tube + rocket
      fr(cx - 14, cy - 3, 22, 6);     // launch tube
      g.poly([cx + 8, cy - 4,  cx + 14, cy,  cx + 8, cy + 4]).fill({ color: col, alpha }); // rocket cone
      fr(cx - 6, cy + 3, 4, 5);       // grip
      break;
    }
    case 6: { // Plasma – futuristic body + energy cell
      fr(cx - 8, cy - 5, 12, 10);     // body
      fr(cx + 4, cy - 2,  9,  4);     // barrel
      g.rect(cx - 4, cy - 3, 6, 6).fill({ color: selected ? 0x00ffff : 0x005566, alpha: 0.9 }); // energy cell
      break;
    }
    case 7: { // Tesla – body + lightning bolt
      fr(cx - 10, cy - 3, 20, 6);     // main body
      g.moveTo(cx - 3, cy - 7).lineTo(cx + 1, cy - 1).lineTo(cx - 2, cy + 1).lineTo(cx + 5, cy + 7)
        .stroke({ width: 2, color: selected ? 0xaaaaff : 0x334488 });
      break;
    }
    case 8: { // Railgun – very long barrel with rail marks
      fr(cx - 16, cy - 2, 30, 4);     // long barrel
      for (let i = 0; i < 4; i++) g.rect(cx - 12 + i * 6, cy - 4, 1, 8);
      g.fill({ color: selected ? 0xff44ff : 0x441144, alpha: 0.9 });
      break;
    }
    case 9: { // BFG – body + giant energy ball
      fr(cx - 12, cy - 3, 12, 6);     // body
      g.circle(cx + 5, cy, 8).fill({ color: selected ? 0x22ff44 : 0x113322, alpha: 0.85 })
        .stroke({ width: 1, color: selected ? 0x44ff44 : 0x224433 });
      fr(cx - 6, cy + 3, 4, 5);       // grip
      break;
    }
    case 10: { // Disintegrator – twin energy barrels
      fr(cx - 14, cy - 7, 22, 4);     // top barrel
      fr(cx - 14, cy + 3, 22, 4);     // bottom barrel
      g.rect(cx + 5, cy - 8, 6, 6).rect(cx + 5, cy + 2, 6, 6)
        .fill({ color: selected ? 0xff44ff : 0x441144, alpha: 0.9 });
      break;
    }
    default: { // Generic gun fallback
      fr(cx - 10, cy - 3, 18, 6);
      fr(cx - 6,  cy + 3,  4, 5);
    }
  }
}

// Minimap terrain types per 4 px tile (0 none, 1 water, 2 sand, 3 dark)
const _mmTypes = new Uint8Array(60 * 60);
const _MM_TYPE_STYLE = [null, { color: 0x1a4070, alpha: 0.72 }, { color: 0x5a4a2a, alpha: 0.25 }, { color: 0x0a1a10, alpha: 0.30 }];

/**
 * Render minimap - static terrain layer every 15 frames, dots every frame
 */
function renderPixiMinimap() {
  if (!player) return;

  const mmSize = 240;
  const mmX = Math.floor(W) - mmSize - 12;
  const mmY = Math.floor(H) - mmSize - 12;
  const mmScale = 0.04;
  const mmCx = mmX + mmSize / 2;
  const mmCy = mmY + mmSize / 2;

  if (!renderPixiMinimap._terrainGraphics) {
    renderPixiMinimap._terrainGraphics = new PIXI.Graphics();
    renderPixiMinimap._terrainGraphics.zIndex = 1998;
    uiContainer.addChild(renderPixiMinimap._terrainGraphics);
    renderPixiMinimap._frameCount = 0;
  }

  renderPixiMinimap._frameCount++;

  // Redraw terrain every 15 frames
  if (renderPixiMinimap._frameCount % 15 === 1) {
    const tg = renderPixiMinimap._terrainGraphics;
    tg.clear();

    // Sunken bevelled frame with a 60 % opaque background
    hudBevel(tg, mmX - 3, mmY - 3, mmSize + 6, mmSize + 6, HUD_PAL.face, HUD_PAL.faceAlpha, HUD_PAL.light, HUD_PAL.dark, 2);
    tg.rect(mmX, mmY, mmSize, mmSize).fill({ color: 0x030810, alpha: 0.60 });

    // Terrain tiles (4 px), merged into horizontal runs, one fill per terrain type
    const mmStep = 4, n = mmSize / mmStep;
    for (let type = 1; type <= 3; type++) {
      let any = false;
      for (let row = 0; row < n; row++) {
        // Classify the row once (for type 1) and reuse it for the other types
        if (type === 1) {
          const py = row * mmStep;
          for (let col = 0; col < n; col++) {
            const px = col * mmStep;
            const sx = (px - mmSize / 2) / mmScale;
            const sy = (py - mmSize / 2) / (mmScale * CFG.ISO_SCALE);
            const t = getTerrainTypeAt(player.x + (sx + sy) * 0.5, player.y + (sy - sx) * 0.5);
            _mmTypes[row * n + col] = t === 'water' ? 1 : t === 'sand' ? 2 : t === 'dark' ? 3 : 0;
          }
        }
        let runStart = -1;
        for (let col = 0; col <= n; col++) {
          const hit = col < n && _mmTypes[row * n + col] === type;
          if (hit && runStart < 0) runStart = col;
          else if (!hit && runStart >= 0) {
            tg.rect(mmX + runStart * mmStep, mmY + row * mmStep, (col - runStart) * mmStep, mmStep);
            runStart = -1;
            any = true;
          }
        }
      }
      if (any) tg.fill(_MM_TYPE_STYLE[type]);
    }
  }

  // Dynamic layer - clear and redraw every frame
  const g = hudElements.minimapGraphics;
  g.clear();

  // Enemy dots (square pixels, one fill for all)
  let anyBoss = false, bossX = 0, bossY = 0, anyEnemy = false;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    const dx = e.x - player.x, dy = e.y - player.y;
    const ex = Math.round(mmCx + (dx - dy) * mmScale);
    const ey = Math.round(mmCy + (dx + dy) * mmScale * CFG.ISO_SCALE);
    if (ex > mmX + 2 && ex < mmX + mmSize - 2 && ey > mmY + 2 && ey < mmY + mmSize - 2) {
      if (e.isBoss) { anyBoss = true; bossX = ex; bossY = ey; }
      else { g.rect(ex - 2, ey - 2, 4, 4); anyEnemy = true; }
    }
  }
  if (anyEnemy) g.fill(0xff4444);
  if (anyBoss) {
    // Boss: larger magenta block with a hollow frame
    g.rect(bossX - 4, bossY - 4, 8, 8).fill(0xff44ff);
    g.rect(bossX - 8, bossY - 8, 16, 1).rect(bossX - 8, bossY + 7, 16, 1)
      .rect(bossX - 8, bossY - 7, 1, 14).rect(bossX + 7, bossY - 7, 1, 14).fill(HUD_STYLE_MM_BOSS);
  }

  // Player dot - green with direction indicator
  g.rect(mmCx - 3, mmCy - 3, 6, 6).fill(0x44ff44);
  const ang = player.angle;
  g.moveTo(mmCx, mmCy)
    .lineTo(mmCx + Math.cos(ang) * 9, mmCy + Math.sin(ang) * 9 * CFG.ISO_SCALE)
    .stroke(HUD_STYLE_MM_DIR);
}

/**
 * Render crosshair: a pixel cross drawn once around (0,0), moved to the mouse
 */
function renderPixiCrosshair() {
  const g = hudElements.crosshair;
  const spReady = player && player.specialCharge >= CFG.SPECIAL_MAX_CHARGE;
  const color = spReady ? 0xffff00 : 0xffffff;
  if (_hudCache.crossColor !== color) {
    _hudCache.crossColor = color;
    g.clear();
    // Black outline first (each part grown by 1 px), then the colour
    for (let pass = 0; pass < 2; pass++) {
      const o = pass === 0 ? 1 : 0;
      g.rect(-16 - o, -1 - o, 10 + 2 * o, 2 + 2 * o)   // left arm
        .rect(6 - o, -1 - o, 10 + 2 * o, 2 + 2 * o)    // right arm
        .rect(-1 - o, -16 - o, 2 + 2 * o, 10 + 2 * o)  // top arm
        .rect(-1 - o, 6 - o, 2 + 2 * o, 10 + 2 * o)    // bottom arm
        .rect(-1 - o, -1 - o, 2 + 2 * o, 2 + 2 * o);   // centre dot
      g.fill(pass === 0 ? { color: 0x000000, alpha: 0.7 } : { color, alpha: 0.95 });
    }
  }
  // Exactly at the mouse (the arms are centred on the point)
  g.x = mouseX;
  g.y = mouseY;
}

/**
 * Render vignette effects (low HP, invincibility, shield break)
 */
function renderPixiVignettes(hpRatio) {
  // Invincibility flash
  hudElements.invincGraphics.clear();
  if (player && player.invincible > 0) {
    hudElements.invincGraphics.rect(0, 0, W, H).fill(HUD_STYLE_INVINC);
    hudElements.invincGraphics.visible = true;
  } else {
    hudElements.invincGraphics.visible = false;
  }

  // Low health red vignette (stepped edge rings; strength 0..1)
  if (hpRatio < 0.3) {
    drawEdgeVignette(hudElements.vignetteGraphics, 0xb40000, 1 - hpRatio / 0.3);
    hudElements.vignetteGraphics.visible = true;
  } else {
    hudElements.vignetteGraphics.visible = false;
  }

  // Shield break blue vignette
  if (player && player.shield <= 0 && shieldRegenTimer < 0.5) {
    drawEdgeVignette(hudElements.shieldVignetteGraphics, 0x3250c8, (1 - shieldRegenTimer / 0.5) * 0.6);
    hudElements.shieldVignetteGraphics.visible = true;
  } else {
    hudElements.shieldVignetteGraphics.visible = false;
  }
}

// Screen-edge vignette as 4 hard-edged rings (full-screen rect with an
// elliptical hole), so the centre of the screen stays clear. The geometry
// is built once per screen size; only the (stepped) alpha changes per frame.
function drawEdgeVignette(g, color, strength) {
  if (g._vw !== W || g._vh !== H || g._vc !== color) {
    g._vw = W; g._vh = H; g._vc = color;
    g.clear();
    const ring = { color, alpha: 0.09 }; // only on resize
    for (let i = 0; i < 4; i++) {
      const t = (i + 1) / 4;
      g.rect(0, 0, W, H).fill(ring);
      g.ellipse(W / 2, H / 2, W * (0.62 - 0.07 * t), H * (0.62 - 0.07 * t)).cut();
    }
  }
  g.alpha = Math.ceil(clamp(strength, 0, 1) * 4) / 4;
}

/**
 * Pause overlay - shown when game is paused with P key
 */
function renderPauseOverlay() {
  if (!renderPauseOverlay._bg) {
    renderPauseOverlay._bg = new PIXI.Graphics();
    renderPauseOverlay._bg.zIndex = 9000;
    uiContainer.addChild(renderPauseOverlay._bg);

    const title = hudText(48, 0xffe040);
    title.text = 'PAUSED';
    const hint = hudText(16, 0xffffff);
    hint.text = 'PRESS P TO RESUME';
    const keys = hudText(8, HUD_PAL.label);
    keys.text = 'F6 PIXEL   F7 DITHER   F8 CRT';
    for (const t of [title, hint, keys]) {
      t.anchor.set(0.5, 0);
      t.zIndex = 9001;
      uiContainer.addChild(t);
    }
    renderPauseOverlay._title = title;
    renderPauseOverlay._hint = hint;
    renderPauseOverlay._keys = keys;
    renderPauseOverlay._w = -1;
    renderPauseOverlay._h = -1;
    // The game loop does not run while paused; keep the overlay laid out on resize
    window.addEventListener('resize', () => { if (paused) renderPauseOverlay(); });
  }

  const visible = (typeof paused !== 'undefined') && paused;
  renderPauseOverlay._bg.visible = visible;
  renderPauseOverlay._title.visible = visible;
  renderPauseOverlay._hint.visible = visible;
  renderPauseOverlay._keys.visible = visible;

  const Wi = Math.floor(W), Hi = Math.floor(H);
  if (visible && (renderPauseOverlay._w !== Wi || renderPauseOverlay._h !== Hi)) {
    renderPauseOverlay._w = Wi;
    renderPauseOverlay._h = Hi;
    const pw = 432, ph = 168;
    const px = (Wi - pw) >> 1, py = (Hi - ph) >> 1;
    const g = renderPauseOverlay._bg;
    g.clear();
    g.rect(0, 0, Wi, Hi).fill({ color: 0x000000, alpha: 0.55 });
    hudPanel(g, px, py, pw, ph);
    hudDivider(g, px + 8, py + 88, pw - 16);

    renderPauseOverlay._title.x = Wi >> 1;
    renderPauseOverlay._title.y = py + 24;
    renderPauseOverlay._hint.x = Wi >> 1;
    renderPauseOverlay._hint.y = py + 106;
    renderPauseOverlay._keys.x = Wi >> 1;
    renderPauseOverlay._keys.y = py + 140;
  }
}

/**
 * Helper: Convert HSL to Hex
 */
function hslToHex(h, s, l) {
  l /= 100;
  const a = s * Math.min(l, 1 - l) / 100;
  const f = n => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color);
  };
  const r = f(0);
  const g = f(8);
  const b = f(4);
  return (r << 16) | (g << 8) | b;
}
