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

// M11 K4/K5 co-op HUD. Everything below is built lazily the first time a P2
// exists and stays hidden in 1P, so the 1P HUD is unchanged (Q4).
const HUD_PAN_H2 = 156;                // 2P panel: + a tag / score / kills / grenade row
const HUD_PCOL = [0xffd830, 0x40d8ff]; // per-player accent: P1 yellow, P2 cyan
const HUD_STATS_MAX_H = 152;           // the stats panel's height with the combo row
const HUD_STYLE_MM_DIR_P = [
  { width: 2, color: HUD_PCOL[0], alpha: 0.9 },
  { width: 2, color: HUD_PCOL[1], alpha: 0.9 },
];
const HUD_STYLE_PANEL_DIM = { color: 0x05070c, alpha: 0.78 };
const HUD_DOWN_COLS = [0xffa020, 0xff3030];
let _hud2 = null;                       // co-op elements (null until a P2 exists)
const _hudCoop = { on: false };
const _hudV = { x: 0, y: 0 };           // worldToView out (no per-frame allocation)
// What was drawn this frame, for hudBoxes()
const _hudLayout = {
  boss: null, bossBox: { x: 0, y: 0, w: 0, h: 0 }, stats: { x: 0, y: 0, w: 0, h: 0 }, // K4 hudBoxes
  set: false, coop: false, panY: 0, slotRowY: 0, nVis: 0,
  gx: 0, gy: 0, gw: 0, hint: 0, p2x: 0, p2y: 0, mmX: 0, mmY: 0, mmSize: 0
};

// K5 ring blocks: n 4x4 blocks on radius r, clockwise from 12 o'clock
// (top-left corner offsets, interleaved x, y)
function _hudRingPts(n, r) {
  const a = new Int16Array(2 * n);
  for (let i = 0; i < n; i++) {
    const t = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    a[2 * i] = Math.round(Math.cos(t) * r) - 2;
    a[2 * i + 1] = Math.round(Math.sin(t) * r) - 2;
  }
  return a;
}
const HUD_DOWN_RING = _hudRingPts(16, 20); // 8 s timer, empties
const HUD_REV_RING = _hudRingPts(20, 28);  // 1.5 s revive progress, fills

// HUD elements cache (persistent UI elements)
const hudElements = {
  healthBar: null,       // bottom-left panel (panel + weapon row + HP bar + weapon slots)
  shieldBar: null,       // shield bar graphics
  specialBar: null,      // shockwave bar graphics
  bossHealthBar: null,   // top-center boss bar
  statsPanel: null,      // top-right stats panel (incl. combo bar)
  grenadeBar: null,      // N1: grenade icons box right of the weapon/ammo row
  grenadeKeyText: null,
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
  reticle: null,         // M10 C3: pad aim reticle (drawn on state change, moved)
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
  grenadeKey: new Float64Array(4),
  crossColor: -1, reticleState: -1
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
  hudElements.grenadeBar = new PIXI.Graphics();
  hudElements.minimapGraphics.zIndex = 2000;
  hudElements.crosshair.zIndex = 8500; // above panels and minimap, below pause
  hudElements.reticle = new PIXI.Graphics();
  hudElements.reticle.zIndex = 8500;
  hudElements.reticle.visible = false;

  // Bottom-left panel
  hudElements.weaponText = hudText(16, 0xffdd44);
  hudElements.ammoText = hudText(8, 0xbbbbbb);
  hudElements.ammoText.anchor.set(1, 0);
  hudElements.hpText = hudText(8, 0xffffff);
  hudElements.shieldText = hudText(8, 0x5599cc);
  hudElements.specialText = hudText(8, 0x887755);
  hudElements.grenadeKeyText = hudText(8, 0x5a6a80);
  hudElements.grenadeKeyText.text = '[F]';
  hudElements.grenadeKeyText.anchor.set(0, 0.5);

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
    slotText.text = `[${i < 9 ? i + 1 : i === 9 ? 0 : '-'}]`; // keys 1-9, 0, -
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
  uiContainer.addChild(hudElements.grenadeBar);
  uiContainer.addChild(hudElements.grenadeKeyText);
  uiContainer.addChild(hudElements.minimapGraphics);
  uiContainer.addChild(hudElements.crosshair);
  uiContainer.addChild(hudElements.reticle);
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
  // M11 K4: the 2P HUD shows while a P2 exists (built on first use)
  const p2 = players.length > 1 ? players[1] : null;
  if (!!p2 !== _hudCoop.on) _hudCoopSet(!!p2);

  renderHudBoss(Wi);
  renderHudPlayerPanel(p, hpRatio, Wi, Hi);
  if (p2) {
    renderHudP2Panel(p2, Wi, Hi);
    renderHudCoopMarks();
  }
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
  renderPixiVignettes(p2 ? _hudVignetteHp() : hpRatio); // K4: 2P -> the lowest standing player

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
    _hudLayout.boss = null;
    return;
  }

  const bw = HUD_BOSS_SEGS * HUD_BOSS_SEG_W + (HUD_BOSS_SEGS - 1) * 2;
  let bx = Math.floor((Wi - bw) / 2);
  const by = 38, bh = 16;
  // K4: on a narrow screen (800x600) its panel (bx - 14 .. bx + bw + 14) would
  // run into the stats box: centre it in the space left of the box instead
  const statsL = Wi - HUD_STATS_W - 12;
  const shifted = bx + bw + 14 > statsL - 8;
  if (shifted) bx = 12 + 14 + Math.max(0, Math.floor((statsL - 8 - 12 - (bw + 28)) / 2));
  const tx = shifted ? bx + (bw >> 1) : Wi >> 1;
  const hasShield = boss.maxShieldHp > 0 && boss.shieldHp > 0;
  const bp = _hudLayout.bossBox; // hudBoxes(): the panel (name text inside), outline included
  bp.x = bx - 15; bp.y = 7; bp.w = bw + 30; bp.h = (hasShield ? 66 : 58) + 2;
  _hudLayout.boss = bp;
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
  hudElements.bossNameText.x = tx;
  hudElements.bossNameText.y = 14;
  hudElements.bossNameText.visible = true;

  // HP numbers centered in bar
  const hpNow = Math.ceil(boss.hp);
  if (c.bossHp !== hpNow || c.bossMaxHp !== boss.maxHp) {
    c.bossHp = hpNow; c.bossMaxHp = boss.maxHp;
    hudElements.bossHPText.text = `${hpNow} / ${boss.maxHp}`;
  }
  hudElements.bossHPText.x = tx;
  hudElements.bossHPText.y = by + (bh >> 1);
  hudElements.bossHPText.visible = true;
}

// =========================================================
// PLAYER STATUS PANEL (bottom-left) + WEAPON SLOTS
// =========================================================
function renderHudPlayerPanel(p, hpRatio, Wi, Hi) {
  const c = _hudCache;
  const co = _hudCoop.on; // M11 K4: 2P panel (taller, grenades inside)
  const panX = 12;
  const slotRowY = Hi - HUD_SLOT_H - 12;
  const panY = slotRowY - 10 - (co ? HUD_PAN_H2 : HUD_PAN_H);
  const barX = panX + HUD_PAD + 2;

  const hpLit = hudSegsLit(hpRatio, HUD_HP_SEGS);
  const hpIdx = hpRatio > 0.6 ? 0 : hpRatio > 0.3 ? 1 : 2;
  // B8: show every unlocked slot that fits left of the minimap (2P: left of
  // the P2 panel); on narrow screens the visible window scrolls so the
  // selected weapon is always shown
  const slotStep = HUD_SLOT_W + HUD_SLOT_GAP;
  const slotRoom = co ? Wi - HUD_PAN_W - 32 - panX : Wi - panX - 280;
  let fit = Math.floor(slotRoom / slotStep);
  // Not all fit: reserve room for the "+N (Q/E)" hint so it can't reach the minimap
  if (unlockedWeapons > fit) fit = Math.floor((slotRoom - 96) / slotStep);
  fit = Math.max(4, fit);
  const maxVisible = Math.min(unlockedWeapons, fit);
  const slot0 = clamp(p.weapon - maxVisible + 1, 0, unlockedWeapons - maxVisible);
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
      _hudKey(k, 4, maxVisible) | _hudKey(k, 5, nextSegs) | _hudKey(k, 6, co ? 2 : 1) | _hudKey(k, 7, slot0)) {
    const g = hudElements.healthBar;
    g.clear();
    if (co) _hudCoopFrame(g, panX, panY, 0);
    else {
      hudPanel(g, panX, panY, HUD_PAN_W, HUD_PAN_H);
      hudDivider(g, panX + 6, panY + 30, HUD_PAN_W - 12);
    }
    hudSegBar(g, barX, panY + 46, HUD_HP_SEGS, HUD_SEG_W, 12, hpLit, HUD_HP_COLORS[hpIdx], HUD_HP_HI[hpIdx], 0x2a1010);

    // Weapon slots
    for (let i = slot0; i < slot0 + maxVisible; i++) {
      const sx = panX + (i - slot0) * (HUD_SLOT_W + HUD_SLOT_GAP);
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

  _hudPanelBody(p, hudElements, c, panX, panY, barX, hpIdx);

  // Right of the ammo panel; on narrow screens (would reach the 240 px
  // minimap) it sits above the panel instead. 2P: inside the panel, bottom-right
  const gw = 32 + (CFG.GRENADE_AMMO_MAX || 6) * HUD_GREN_STEP;
  let gx, gy;
  if (co) { gx = panX + HUD_PAN_W - 8 - gw; gy = panY + 122; } else {
    const gx0 = panX + HUD_PAN_W + 6;
    const gFits = gx0 + gw <= Wi - 240 - 18;
    gx = gFits ? gx0 : panX; gy = gFits ? panY : panY - HUD_GREN_H - 6;
  }
  renderHudGrenades(p, gx, gy);
  if (co) _hudPanelCoop(p, panX, panY, 0);

  // --- Slot key labels ---
  for (let i = 0; i < hudElements.slotTexts.length; i++) {
    const t = hudElements.slotTexts[i];
    if (i < slot0 || i >= slot0 + maxVisible) { t.visible = false; continue; }
    _hudTint(t, i === p.weapon ? 0xffdd44 : 0x5a6a80);
    t.x = panX + (i - slot0) * (HUD_SLOT_W + HUD_SLOT_GAP) + HUD_SLOT_W / 2;
    t.y = slotRowY + HUD_SLOT_H - 3;
    t.visible = true;
  }

  // +N more hint (unlocked slots that don't fit this screen)
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

  // hudBoxes(): what was laid out this frame (numbers only, no allocation)
  const L = _hudLayout;
  L.set = true; L.coop = co; L.panY = panY; L.slotRowY = slotRowY; L.nVis = maxVisible;
  L.gx = gx; L.gy = gy; L.gw = gw; L.hint = hasNext ? 1 : bossActive ? 2 : 0;
}

// Weapon name, ammo, HP label, shield and shockwave bars of a player panel
// (P1: el = hudElements, c = _hudCache; P2: its own set, M11 K4)
function _hudPanelBody(p, el, c, panX, panY, barX, hpIdx) {
  const wep = WEAPONS[p.weapon];
  // --- Weapon name + ammo ---
  if (c.weapon !== p.weapon) {
    c.weapon = p.weapon;
    el.weaponText.text = wep.name.toUpperCase();
  }
  el.weaponText.x = panX + HUD_PAD;
  el.weaponText.y = panY + 10;

  const ammoKey = p.reloading ? -1 - Math.round(p.reloadTimer * 10) : wep.mag === Infinity ? 1e9 : p.magAmmo * 10000 + wep.mag;
  if (c.ammoKey !== ammoKey) {
    c.ammoKey = ammoKey;
    el.ammoText.text = p.reloading
      ? `RELOADING ${p.reloadTimer.toFixed(1)}s`
      : wep.mag === Infinity ? 'INF' : `${p.magAmmo} / ${wep.mag}`;
  }
  _hudTint(el.ammoText, p.reloading ? 0xff8800
    : p.magAmmo <= Math.ceil(wep.mag * 0.25) ? 0xff4444 : 0xbbbbbb);
  el.ammoText.x = panX + HUD_PAN_W - HUD_PAD;
  el.ammoText.y = panY + 14;

  // --- HP label (blinks white/red when low) ---
  const hpNow = Math.ceil(p.hp);
  if (c.hp !== hpNow || c.maxHp !== p.maxHp) {
    c.hp = hpNow; c.maxHp = p.maxHp;
    el.hpText.text = `HP ${hpNow}/${p.maxHp}`;
  }
  const lowBlink = hpIdx === 2 && (Math.floor(gameTime / 0.25) & 1) === 1;
  _hudTint(el.hpText, lowBlink ? 0xffffff : HUD_HP_COLORS[hpIdx]);
  el.hpText.x = barX;
  el.hpText.y = panY + 35;
  el.hpText.visible = true;

  // --- Shield bar ---
  const shieldRatio = p.shield / p.maxShield;
  const shLit = hudSegsLit(shieldRatio, HUD_SH_SEGS);
  const sbY = panY + 76;
  const sk = c.shieldKey;
  if (_hudKey(sk, 0, sbY) | _hudKey(sk, 1, shLit) | _hudKey(sk, 2, 1)) {
    el.shieldBar.clear();
    hudSegBar(el.shieldBar, barX, sbY, HUD_SH_SEGS, HUD_SEG_W, 6, shLit, 0x3878f0, 0x98c0ff, 0x121a30);
  }
  const shNow = Math.ceil(p.shield);
  if (c.shield !== shNow) {
    c.shield = shNow;
    el.shieldText.text = `SHIELD ${shNow}`;
  }
  _hudTint(el.shieldText, shieldRatio > 0 ? 0x66aaee : 0x445566);
  el.shieldText.x = barX;
  el.shieldText.y = sbY - 13;
  el.shieldText.visible = true;

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
    el.specialBar.clear();
    hudSegBar(el.specialBar, barX, spY, spSegs, spSegW, 6, spLit, spColor,
      spReady ? 0xffffff : 0xffc860, 0x1e1808);
  }
  if (c.special !== p.specialCharge || c.spReady !== spReady) {
    c.special = p.specialCharge; c.spReady = spReady;
    el.specialText.text = spReady ? 'SHOCKWAVE READY!' : `SHOCKWAVE ${p.specialCharge}/${spMax}`;
  }
  _hudTint(el.specialText, spReady ? spColor : 0x998866);
  el.specialText.x = barX;
  el.specialText.y = spY - 13;
  el.specialText.visible = true;
}

// =========================================================
// GRENADES (N1): raised box right of the weapon/ammo row, one pixel-art
// grenade per round carried, dim silhouettes for empty slots
// =========================================================
// 5x7 art (3 px each): O outline, G olive, L highlight, D shade, S steel lever
const HUD_GREN_ART = [
  '.SSO.',
  '.OOOS',
  'OLGGO',
  'OLGDO',
  'OGGDO',
  'OGDDO',
  '.OOO.',
];
const HUD_GREN_PAL = { O: 0x000000, G: 0x6a7c34, L: 0xa4b45c, D: 0x3c4a1e, S: 0xc8c8bc };
const HUD_GREN_PX = 3, HUD_GREN_STEP = 18, HUD_GREN_H = 30;

function hudGrenadeIcon(g, x, y, full) {
  const A = HUD_GREN_PX;
  for (const ch in HUD_GREN_PAL) {
    let any = false;
    for (let r = 0; r < HUD_GREN_ART.length; r++) {
      const row = HUD_GREN_ART[r];
      for (let c = 0; c < row.length; c++) {
        if (row[c] !== ch) continue;
        // empty slot: only the outline, dark, as a silhouette
        if (!full && ch !== 'O') continue;
        g.rect(x + c * A, y + r * A, A, A);
        any = true;
      }
    }
    if (any) g.fill(full ? HUD_GREN_PAL[ch] : 0x56637e);
  }
}

// el / k: the panel's element set and grenade cache key (M11 K4: P2 has its own)
function renderHudGrenades(p, bx, by, el = hudElements, k = _hudCache.grenadeKey) {
  const max = CFG.GRENADE_AMMO_MAX || 6;
  const n = Math.max(0, Math.min(max, p.grenades | 0));
  const bw = 32 + max * HUD_GREN_STEP;
  if (_hudKey(k, 0, bx) | _hudKey(k, 1, by) | _hudKey(k, 2, n) | _hudKey(k, 3, max)) {
    const g = el.grenadeBar;
    g.clear();
    hudPanel(g, bx, by, bw, HUD_GREN_H);
    const iy = by + ((HUD_GREN_H - HUD_GREN_ART.length * HUD_GREN_PX) >> 1);
    for (let i = 0; i < max; i++) hudGrenadeIcon(g, bx + 30 + i * HUD_GREN_STEP, iy, i < n);
  }
  const t = el.grenadeKeyText;
  _hudTint(t, n > 0 ? 0x9aa4b4 : 0x5a6a80);
  t.x = bx + 5;
  t.y = by + HUD_GREN_H / 2;
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
    const sb = _hudLayout.stats; sb.x = rPX - 1; sb.y = rPY - 1; sb.w = rPW + 2; sb.h = rPH + 2; // hudBoxes()
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

// =========================================================
// M11 K4/K5: CO-OP HUD (2P only)
// =========================================================
// P1 panel (bottom-left, 2P height HUD_PAN_H2) and P2 panel (bottom-right,
// no weapon slots) share _hudPanelBody. Each gets a bottom row: the "1P"/"2P"
// tag in the player's colour, their own score and kills, and the grenades.
// Down/dead dims the bars and says so. Above each non-dead player: the
// "1P"/"2P" tag; a downed player gets a blinking HELP!, the 8 s ring timer
// and, while a partner revives them, the revive ring. All screen-space.

// Panel elements go under the vignettes, the reticles and the pause overlay
// (uiContainer draws in insertion order)
function _hudAddPanel(o) {
  const i = Math.min(uiContainer.getChildIndex(hudElements.invincGraphics), uiContainer.getChildIndex(hudElements.crosshair));
  uiContainer.addChildAt(o, i);
  return o;
}

function _hudInitCoop() {
  const add = _hudAddPanel;
  const el = {
    healthBar: add(new PIXI.Graphics()),
    shieldBar: add(new PIXI.Graphics()),
    specialBar: add(new PIXI.Graphics()),
    grenadeBar: add(new PIXI.Graphics()),
    grenadeKeyText: add(hudText(8, 0x5a6a80)),
    weaponText: add(hudText(16, 0xffdd44)),
    ammoText: add(hudText(8, 0xbbbbbb)),
    hpText: add(hudText(8, 0xffffff)),
    shieldText: add(hudText(8, 0x5599cc)),
    specialText: add(hudText(8, 0x887755)),
  };
  el.grenadeKeyText.text = '[B]'; // P2 throws with the pad's B
  el.grenadeKeyText.anchor.set(0, 0.5);
  el.ammoText.anchor.set(1, 0);

  const extras = (i) => {
    const tag = add(hudText(16, HUD_PCOL[i]));
    tag.text = `${i + 1}P`;
    const ov = add(new PIXI.Graphics());
    const ovText = add(hudText(16, 0xff4040));
    ovText.anchor.set(0.5, 0);
    const ovSub = add(hudText(8, HUD_PAL.label));
    ovSub.anchor.set(0.5, 0);
    return {
      tag, ov, ovText, ovSub,
      score: add(hudText(8, 0xffd700)),
      kills: add(hudText(8, 0xff6a6a)),
      c: { score: NaN, kills: NaN, ovKey: -1, ovX: NaN, ovY: NaN },
    };
  };
  // World-anchored markers sit under every panel
  const mark = (i) => {
    const ring = new PIXI.Graphics();
    const help = hudText(16, 0xff3030);
    help.text = 'HELP!';
    help.anchor.set(0.5, 1);
    const tag = hudText(8, HUD_PCOL[i]);
    tag.text = `${i + 1}P`;
    tag.anchor.set(0.5, 1);
    // K4: a screen-size ring in the player's colour at the feet, so each
    // player is found at a glance even at zoom 0.6 among the enemies
    const foot = new PIXI.Graphics();
    foot.ellipse(0, 0, 13, 6).stroke({ width: 3, color: 0x000000, alpha: 0.6 })
      .ellipse(0, 0, 13, 6).stroke({ width: 1.5, color: HUD_PCOL[i], alpha: 0.95 });
    uiContainer.addChildAt(tag, 0);
    uiContainer.addChildAt(help, 0);
    uiContainer.addChildAt(ring, 0);
    uiContainer.addChildAt(foot, 0);
    return { ring, help, tag, foot, ringKey: -1 };
  };
  _hud2 = {
    el,
    c: {
      weapon: -1, ammoKey: NaN, hp: NaN, maxHp: NaN, shield: NaN, special: NaN, spReady: null,
      panelKey: new Float64Array(4), shieldKey: new Float64Array(4),
      specialKey: new Float64Array(5), grenadeKey: new Float64Array(4),
    },
    ex: [extras(0), extras(1)],
    marks: [mark(0), mark(1)],
  };
}

// Show / hide the whole 2P HUD (only on a change of player count)
function _hudCoopSet(on) {
  _hudCoop.on = on;
  if (on && !_hud2) _hudInitCoop();
  if (!_hud2) return;
  const el = _hud2.el;
  for (const key in el) el[key].visible = on;
  for (let i = 0; i < 2; i++) {
    const x = _hud2.ex[i], m = _hud2.marks[i];
    x.tag.visible = x.score.visible = x.kills.visible = on;
    x.ov.visible = x.ovText.visible = x.ovSub.visible = false;
    x.c.ovKey = 0;
    m.ring.visible = m.help.visible = m.tag.visible = m.foot.visible = false;
  }
}

// 2P panel frame: raised panel, accent strip in the player's colour along
// the top edge, dividers under the weapon row and above the score row
function _hudCoopFrame(g, panX, panY, i) {
  hudPanel(g, panX, panY, HUD_PAN_W, HUD_PAN_H2);
  g.rect(panX, panY, HUD_PAN_W, 3).fill(HUD_PCOL[i]);
  hudDivider(g, panX + 6, panY + 30, HUD_PAN_W - 12);
  hudDivider(g, panX + 6, panY + 116, HUD_PAN_W - 12);
}

// The 2P row of panel i (tag, score, kills) and its down / dead overlay
function _hudPanelCoop(p, panX, panY, i) {
  const x = _hud2.ex[i], c = x.c;
  x.tag.x = panX + HUD_PAD;
  x.tag.y = panY + 128;
  const sc = Math.floor(p.score || 0), kl = p.kills | 0;
  if (c.score !== sc) { c.score = sc; x.score.text = `SCORE ${sc.toLocaleString()}`; }
  if (c.kills !== kl) { c.kills = kl; x.kills.text = `KILLS ${kl}`; }
  x.score.x = x.kills.x = panX + HUD_PAD + 42;
  x.score.y = panY + 124;
  x.kills.y = panY + 138;

  // DOWN n (seconds left) / REVIVING / DEAD over the dimmed bars
  const st = p.state === 'down' ? 1 : p.state === 'dead' ? 2 : 0;
  if (st === 0) {
    if (c.ovKey !== 0) { c.ovKey = 0; x.ov.visible = x.ovText.visible = x.ovSub.visible = false; }
    return;
  }
  const rev = st === 1 && p.reviveT > 0;
  const secs = st === 1 ? Math.max(0, Math.ceil(p.downT)) : 0;
  const key = st * 1000 + (rev ? 100 : 0) + secs;
  if (c.ovKey !== key) {
    c.ovKey = key;
    x.ovText.text = st === 2 ? 'DEAD' : rev ? 'REVIVING' : `DOWN ${secs}`;
    x.ovSub.text = st === 2 ? 'BACK NEXT WAVE' : 'PARTNER: STAND CLOSE';
    x.ov.visible = x.ovText.visible = x.ovSub.visible = true;
  }
  if (c.ovX !== panX || c.ovY !== panY) {
    c.ovX = panX; c.ovY = panY;
    x.ov.clear();
    x.ov.rect(panX + 4, panY + 33, HUD_PAN_W - 8, 82).fill(HUD_STYLE_PANEL_DIM);
  }
  const blink = (Math.floor(gameTime / 0.25) & 1) === 1;
  _hudTint(x.ovText, st === 2 ? 0x9a2020 : rev ? 0x44ff44 : blink ? 0xffffff : 0xff3030);
  x.ovText.x = x.ovSub.x = panX + (HUD_PAN_W >> 1);
  x.ovText.y = panY + 52;
  x.ovSub.y = panY + 80;
}

// P2 panel, bottom-right (mirrors P1's: weapon, ammo, HP, shield,
// shockwave, grenades, own score and kills; no weapon slots)
function renderHudP2Panel(p, Wi, Hi) {
  const el = _hud2.el, c = _hud2.c;
  const panX = Wi - 12 - HUD_PAN_W, panY = Hi - 12 - HUD_PAN_H2;
  const barX = panX + HUD_PAD + 2;
  const hpRatio = p.hp / p.maxHp;
  const hpLit = hudSegsLit(hpRatio, HUD_HP_SEGS);
  const hpIdx = hpRatio > 0.6 ? 0 : hpRatio > 0.3 ? 1 : 2;
  const k = c.panelKey;
  if (_hudKey(k, 0, panX) | _hudKey(k, 1, panY) | _hudKey(k, 2, hpLit) | _hudKey(k, 3, hpIdx)) {
    const g = el.healthBar;
    g.clear();
    _hudCoopFrame(g, panX, panY, 1);
    hudSegBar(g, barX, panY + 46, HUD_HP_SEGS, HUD_SEG_W, 12, hpLit, HUD_HP_COLORS[hpIdx], HUD_HP_HI[hpIdx], 0x2a1010);
  }
  _hudPanelBody(p, el, c, panX, panY, barX, hpIdx);
  const gw = 32 + (CFG.GRENADE_AMMO_MAX || 6) * HUD_GREN_STEP;
  renderHudGrenades(p, panX + HUD_PAN_W - 8 - gw, panY + 122, el, c.grenadeKey);
  _hudPanelCoop(p, panX, panY, 1);
  _hudLayout.p2x = panX; _hudLayout.p2y = panY;
}

// Ring of `pts` 4x4 blocks with a black outline: the first `lit` (clockwise
// from 12 o'clock) in `on`, the rest in `off`
function _hudRing(g, pts, lit, on, off) {
  const n = pts.length >> 1;
  for (let i = 0; i < n; i++) g.rect(pts[2 * i] - 1, pts[2 * i + 1] - 1, 6, 6);
  g.fill(HUD_RETICLE_OUTLINE);
  if (lit < n) {
    for (let i = lit; i < n; i++) g.rect(pts[2 * i], pts[2 * i + 1], 4, 4);
    g.fill(off);
  }
  if (lit > 0) {
    for (let i = 0; i < lit; i++) g.rect(pts[2 * i], pts[2 * i + 1], 4, 4);
    g.fill(on);
  }
}

const _hudB = { x: 0, y: 0, w: 0, h: 0, waterY: null };

// K2.2 test hook: each player's foot ring as drawn this frame ([] in 1P /
// before the first 2P frame): { x, y } = its centre in CSS px, visible
function footRings() {
  if (!_hud2 || !_hud2.marks) return [];
  const out = [];
  for (let i = 0; i < players.length && i < 2; i++) {
    const f = _hud2.marks[i].foot;
    out.push({ x: f.x, y: f.y, visible: !!f.visible && _hudCoop.on });
  }
  return out;
}
// Tags, HELP! and the K5 rings at each player (screen-space, never zoomed)
function renderHudCoopMarks() {
  const z = cam.z;
  const blink = (Math.floor(gameTime / 0.25) & 1) === 0;
  for (let i = 0; i < 2; i++) {
    const m = _hud2.marks[i];
    const p = i < players.length ? players[i] : null;
    if (!p || p.state === 'dead') {
      m.tag.visible = m.help.visible = m.ring.visible = m.foot.visible = false;
      continue;
    }
    const v = worldToView(p.x, p.y, _hudV);
    const x = Math.round(v.x);
    if (p.state === 'down') {
      m.foot.visible = false; // K2.2: the HELP! ring replaces the foot ring
      const cy = Math.round(v.y - 6 * z); // lying: ring around the body
      const dLit = Math.ceil(clamp(p.downT / CFG.COOP_DOWN_TIME, 0, 1) * 16);
      const col = p.downT > 3 ? 0 : 1;
      const rev = p.reviveT > 0;
      const rLit = rev ? Math.floor(clamp(p.reviveT / CFG.COOP_REVIVE_TIME, 0, 1) * 20) : 0;
      const key = dLit * 1000 + rLit * 10 + col * 2 + (rev ? 1 : 0);
      if (m.ringKey !== key) {
        m.ringKey = key;
        const g = m.ring;
        g.clear();
        _hudRing(g, HUD_DOWN_RING, dLit, HUD_DOWN_COLS[col], 0x2a0a0a);
        if (rev) _hudRing(g, HUD_REV_RING, rLit, 0x44ff44, 0x0e2a0e);
      }
      m.ring.x = x; m.ring.y = cy; m.ring.visible = true;
      const top = cy - (rev ? 32 : 24);
      m.help.x = x; m.help.y = top;
      m.help.visible = blink;
      m.tag.x = x; m.tag.y = top - 18;
    } else {
      m.ring.visible = m.help.visible = false;
      m.tag.x = x;
      m.foot.x = x; m.foot.y = Math.round(v.y); m.foot.visible = true;
      // above the drawn head (bandana included), not the hit-model body height
      const b = typeof spDrawnBounds === 'function' ? spDrawnBounds(p, _hudB) : null;
      const oy = worldOffsetY !== null ? worldOffsetY : H / 2 - cam.y * z;
      m.tag.y = b ? Math.round(b.y * z + oy) - 3 : Math.round(v.y - PLAYER_BODY_H * z) - 4;
    }
    m.tag.visible = true;
  }
}

/**
 * M11 K4: CSS-px rects { x, y, w, h } of what the HUD drew this frame,
 * outlines included: p1 = P1's panel with its weapon slots, grenade box and
 * unlock hint; p2 = the P2 panel (null in 1P); minimap = its frame; boss =
 * the boss bar panel with its name (null without a boss); stats = the
 * score / wave box.
 */
function hudBoxes() {
  const L = _hudLayout, e = hudElements;
  if (!L.set) return { p1: null, p2: null, minimap: null, boss: null, stats: null };
  const panX = 12, panH = L.coop ? HUD_PAN_H2 : HUD_PAN_H;
  let x0 = panX - 1, y0 = L.panY - 1;
  let x1 = panX + HUD_PAN_W + 1, y1 = L.slotRowY + HUD_SLOT_H + 1;
  x1 = Math.max(x1, panX + L.nVis * (HUD_SLOT_W + HUD_SLOT_GAP) - HUD_SLOT_GAP + 1);
  if (L.gx >= panX + HUD_PAN_W || L.gy < L.panY || L.gy >= L.panY + panH) { // grenades outside
    x0 = Math.min(x0, L.gx - 1); y0 = Math.min(y0, L.gy - 1);
    x1 = Math.max(x1, L.gx + L.gw + 1); y1 = Math.max(y1, L.gy + HUD_GREN_H + 1);
  }
  if (L.hint) {
    const t = L.hint === 1 ? e.nextText : e.bossUnlockText;
    y0 = Math.min(y0, L.panY - 15, Math.floor(t.y - t.height));
    x1 = Math.max(x1, Math.ceil(t.x + t.width) + 1);
  }
  if (e.moreText.visible) x1 = Math.max(x1, Math.ceil(e.moreText.x + e.moreText.width) + 1);
  return {
    p1: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    p2: L.coop ? { x: L.p2x - 1, y: L.p2y - 1, w: HUD_PAN_W + 2, h: HUD_PAN_H2 + 2 } : null,
    minimap: { x: L.mmX - 4, y: L.mmY - 4, w: L.mmSize + 8, h: L.mmSize + 8 },
    boss: L.boss ? { x: L.boss.x, y: L.boss.y, w: L.boss.w, h: L.boss.h } : null,
    stats: { x: L.stats.x, y: L.stats.y, w: L.stats.w, h: L.stats.h },
  };
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
    case 7: { // Flamethrower – fuel tank under a long barrel, flared nozzle, pilot flame
      fr(cx - 14, cy + 1, 9, 7);      // fuel tank
      fr(cx - 12, cy - 1, 5, 2);      // tank neck / valve
      fr(cx - 10, cy - 4, 20, 4);     // body + barrel
      fr(cx + 10, cy - 6, 3, 8);      // nozzle flare
      fr(cx - 3, cy, 3, 6);           // grip
      g.rect(cx + 14, cy - 4, 3, 4).rect(cx + 15, cy - 6, 2, 2)
        .fill({ color: selected ? 0xff8a20 : 0x553311, alpha: 0.9 }); // pilot flame
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

  // M11 K4: in 2P the P2 panel takes the bottom-right corner, so the minimap
  // moves up under the stats panel (sized to fit above the P2 panel) and
  // centres on the players' midpoint
  const co = _hudCoop.on;
  let mmSize = 240, mmY, ox = player.x, oy = player.y;
  if (co) {
    mmY = 12 + HUD_STATS_MAX_H + 16;
    const room = Math.floor(H) - 12 - HUD_PAN_H2 - 13 - mmY;
    mmSize = Math.max(96, Math.min(240, (room >> 2) << 2));
    let n = 0, sx = 0, sy = 0;
    for (let i = 0; i < players.length; i++) {
      const q = players[i];
      if (q && (q.state === 'up' || q.state === 'down')) { sx += q.x; sy += q.y; n++; }
    }
    if (n > 0) { ox = sx / n; oy = sy / n; }
  } else {
    mmY = Math.floor(H) - mmSize - 12;
  }
  const mmX = Math.floor(W) - mmSize - 12;
  const mmScale = 0.04;
  const mmCx = mmX + mmSize / 2;
  const mmCy = mmY + mmSize / 2;
  const L = _hudLayout;
  L.mmX = mmX; L.mmY = mmY; L.mmSize = mmSize;

  if (!renderPixiMinimap._terrainGraphics) {
    renderPixiMinimap._terrainGraphics = new PIXI.Graphics();
    renderPixiMinimap._terrainGraphics.zIndex = 1998;
    renderPixiMinimap._terrainGraphics._co = false;
    uiContainer.addChild(renderPixiMinimap._terrainGraphics);
    renderPixiMinimap._frameCount = 0;
  }

  renderPixiMinimap._frameCount++;

  // Redraw terrain every 15 frames (and at once when the 2P layout toggles)
  const tgCo = renderPixiMinimap._terrainGraphics._co !== co;
  if (renderPixiMinimap._frameCount % 15 === 1 || tgCo) {
    renderPixiMinimap._terrainGraphics._co = co;
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
            const t = getTerrainTypeAt(ox + (sx + sy) * 0.5, oy + (sy - sx) * 0.5);
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
    const dx = e.x - ox, dy = e.y - oy;
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

  if (co) { // 2P: each counted player in their own colour
    for (let i = 0; i < players.length && i < 2; i++) {
      const q = players[i];
      if (!q || q.state === 'dead') continue;
      const dx = q.x - ox, dy = q.y - oy;
      const px = Math.round(mmCx + (dx - dy) * mmScale);
      const py = Math.round(mmCy + (dx + dy) * mmScale * CFG.ISO_SCALE);
      g.rect(px - 3, py - 3, 6, 6).fill(HUD_PCOL[i]);
      const a = q.angle;
      g.moveTo(px, py)
        .lineTo(px + Math.cos(a) * 9, py + Math.sin(a) * 9 * CFG.ISO_SCALE)
        .stroke(HUD_STYLE_MM_DIR_P[i]);
    }
    return;
  }

  // Player dot - green with direction indicator
  g.rect(mmCx - 3, mmCy - 3, 6, 6).fill(0x44ff44);
  const ang = player.angle;
  g.moveTo(mmCx, mmCy)
    .lineTo(mmCx + Math.cos(ang) * 9, mmCy + Math.sin(ang) * 9 * CFG.ISO_SCALE)
    .stroke(HUD_STYLE_MM_DIR);
}

/**
 * Render crosshair: a pixel cross drawn once around (0,0), moved to the mouse.
 * While pad-aiming (M10 C3) the pad reticle replaces it: mouseX/Y is then the
 * shot's screen target, which the aim assist may have moved onto an enemy.
 */
function renderPixiCrosshair() {
  const padAiming = hudPadAiming();
  hudElements.crosshair.visible = !padAiming;
  hudElements.reticle.visible = padAiming;
  const spReady = player && player.specialCharge >= CFG.SPECIAL_MAX_CHARGE;
  if (players.length > 1 || hudElements.reticle2) _hudP2Reticle(); // M11 K2
  if (padAiming) { renderPadReticle(spReady); return; }

  const g = hudElements.crosshair;
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

// M10 C3: the pad reticle shows while the pad aims a running game (not the demo)
function hudPadAiming() {
  return typeof inputDevice !== 'undefined' && inputDevice === 'pad' &&
    typeof padAim !== 'undefined' && gameStarted && !(typeof demoActive !== 'undefined' && demoActive);
}

// Pad reticle: four pixel corner brackets + centre dot around (0,0), redrawn
// only when its state changes (0 white, 1 shockwave ready, 2 assist lock);
// the lock pulls the brackets in and adds inner ticks.
const HUD_RETICLE_COLORS = [0xffffff, 0xffff00, 0xff4030];
const HUD_RETICLE_OUTLINE = { color: 0x000000, alpha: 0.7 };
const HUD_RETICLE_FILL = [
  { color: HUD_RETICLE_COLORS[0], alpha: 0.95 },
  { color: HUD_RETICLE_COLORS[1], alpha: 0.95 },
  { color: HUD_RETICLE_COLORS[2], alpha: 0.95 },
];
// M11 K2: one per pad (g, its player p and aim; ck = its _hudCache state key)
function renderPadReticle(spReady, g = hudElements.reticle, p = player, aim = padAim, ck = 'reticleState') {
  const locked = CFG.PAD_AIM_ASSIST && p && typeof padAssistTarget === 'function' &&
    padAssistTarget(p.x, p.y, aim.dirX, aim.dirY, CFG.PAD_ASSIST_RANGE, CFG.PAD_ASSIST_DEG) !== null;
  const state = locked ? 2 : spReady ? 1 : 0;
  if (_hudCache[ck] !== state) {
    _hudCache[ck] = state;
    g.clear();
    const r = locked ? 10 : 14, L = 6; // half-size of the bracket box, arm length
    for (let pass = 0; pass < 2; pass++) {
      const o = pass === 0 ? 1 : 0, o2 = 2 * o;
      for (let sx = -1; sx <= 1; sx += 2) {
        for (let sy = -1; sy <= 1; sy += 2) {
          const cx = sx < 0 ? -r : r - 2, cy = sy < 0 ? -r : r - 2;   // 2x2 corner pixel
          const hx = sx < 0 ? cx : cx - L + 2, vy = sy < 0 ? cy : cy - L + 2;
          g.rect(hx - o, cy - o, L + o2, 2 + o2)   // horizontal arm
            .rect(cx - o, vy - o, 2 + o2, L + o2); // vertical arm
        }
      }
      g.rect(-1 - o, -1 - o, 2 + o2, 2 + o2);      // centre dot
      if (locked) {                                // inner ticks
        g.rect(-6 - o, -1 - o, 3 + o2, 2 + o2).rect(3 - o, -1 - o, 3 + o2, 2 + o2)
          .rect(-1 - o, -6 - o, 2 + o2, 3 + o2).rect(-1 - o, 3 - o, 2 + o2, 3 + o2);
      }
      g.fill(pass === 0 ? HUD_RETICLE_OUTLINE : HUD_RETICLE_FILL[state]);
    }
  }
  // At the aim point (world -> screen with this frame's camera offset)
  const z = cam.z; // M11 K3a: the reticle stays screen-size; only its position zooms
  const ox = worldOffsetX !== null ? worldOffsetX : W / 2 - cam.x * z;
  const oy = worldOffsetY !== null ? worldOffsetY : H / 2 - cam.y * z;
  g.x = Math.round((aim.x - aim.y) * z + ox);
  g.y = Math.round((aim.x + aim.y) * CFG.ISO_SCALE * z + oy);
}

// M11 K2: P2's pad reticle (created when first needed; never in 1P)
function _hudP2Reticle() {
  const p2 = players.length > 1 ? players[1] : null;
  const show = !!(p2 && p2.pad !== null && p2.state === 'up' && gameStarted &&
    !(typeof demoActive !== 'undefined' && demoActive) && typeof padAimOf === 'function');
  if (!show) { if (hudElements.reticle2) hudElements.reticle2.visible = false; return; }
  if (!hudElements.reticle2) {
    const g = new PIXI.Graphics();
    g.zIndex = 8500;
    uiContainer.addChild(g);
    hudElements.reticle2 = g;
    _hudCache.reticle2State = -1;
  }
  hudElements.reticle2.visible = true;
  renderPadReticle(p2.specialCharge >= CFG.SPECIAL_MAX_CHARGE, hudElements.reticle2, p2, padAimOf(1), 'reticle2State');
}

/**
 * Render vignette effects (low HP, invincibility, shield break)
 */
// K4 (2P): the low-HP vignette follows the lowest HP among STANDING players
// (a downed player has the HELP! ring instead); nobody standing -> none
function _hudVignetteHp() {
  let r = 1;
  for (let i = 0; i < players.length; i++) {
    const q = players[i];
    if (q && q.state === 'up') r = Math.min(r, q.hp / q.maxHp);
  }
  return r;
}

function renderPixiVignettes(hpRatio) {
  // Invincibility flash
  hudElements.invincGraphics.clear();
  if (player && player.invincible > 0 && player.state === 'up') {
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

  // Shield break blue vignette (K4: any standing player's fresh break; P1's
  // timer is the global one)
  let sb = -1;
  for (let i = 0; i < players.length; i++) {
    const q = players[i];
    if (!q || q.state !== 'up' || q.shield > 0) continue;
    const t = q === player ? shieldRegenTimer : (q.shieldRegenT || 0);
    if (t < 0.5 && (sb < 0 || t < sb)) sb = t;
  }
  if (sb >= 0) {
    drawEdgeVignette(hudElements.shieldVignetteGraphics, 0x3250c8, (1 - sb / 0.5) * 0.6);
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
 * Pause overlay - shown when game is paused with P key / Start (M10), or
 * auto-paused by a pad disconnect (C6). Called on every pause / resume, so
 * the texts are re-evaluated on each call (and only re-set on change).
 */
function renderPauseOverlay() {
  const o = renderPauseOverlay;
  if (!o._bg) {
    o._bg = new PIXI.Graphics();
    o._bg.zIndex = 9000;
    uiContainer.addChild(o._bg);

    const title = hudText(48, 0xffe040);
    title.text = 'PAUSED';
    const dcTitle = hudText(24, 0xff5040); // C6: 'CONTROLLER DISCONNECTED' won't fit at 48 px
    dcTitle.text = 'CONTROLLER DISCONNECTED';
    const hint = hudText(16, 0xffffff);
    hint.text = 'PRESS P TO RESUME';
    const keys = hudText(8, HUD_PAL.label);
    keys.text = 'F6 PIXEL   F7 DITHER   F8 CRT';
    for (const t of [title, dcTitle, hint, keys]) {
      t.anchor.set(0.5, 0);
      t.zIndex = 9001;
      uiContainer.addChild(t);
    }
    o._title = title;
    o._dcTitle = dcTitle;
    o._hint = hint;
    o._keys = keys;
    o._w = -1;
    o._h = -1;
    o._mode = -1;
    // The game loop does not run while paused; keep the overlay laid out on resize
    window.addEventListener('resize', () => { if (paused) renderPauseOverlay(); });
  }

  const visible = (typeof paused !== 'undefined') && paused;
  const ps = visible && typeof padState === 'function' ? padState() : null;
  const dc = !!(ps && ps.disconnectPaused);
  // M11 K2: in 2P the message names the player whose pad dropped
  const dcText = dc && players.length > 1 && ps.disconnectWho ? `P${ps.disconnectWho} CONTROLLER DISCONNECTED` : 'CONTROLLER DISCONNECTED';
  if (o._dcTitle.text !== dcText) { o._dcTitle.text = dcText; o._mode = -1; }
  const hintText = dc ? (players.length > 1 && ps.disconnectWho ? `P${ps.disconnectWho} PRESS START OR ANY KEY` : 'PRESS START OR ANY KEY')
    : ps && ps.connected ? 'PRESS P / START TO RESUME' : 'PRESS P TO RESUME';
  if (o._hint.text !== hintText) o._hint.text = hintText;
  o._bg.visible = visible;
  o._title.visible = visible && !dc;
  o._dcTitle.visible = visible && dc;
  o._hint.visible = visible;
  o._keys.visible = visible;

  const Wi = Math.floor(W), Hi = Math.floor(H);
  const mode = dc ? 1 : 0;
  if (visible && (o._w !== Wi || o._h !== Hi || o._mode !== mode)) {
    o._w = Wi;
    o._h = Hi;
    o._mode = mode;
    const pw = Math.min(Wi - 16, dc ? Math.max(600, o._dcTitle.width + 48) : 432), ph = 168;
    const px = (Wi - pw) >> 1, py = (Hi - ph) >> 1;
    const g = o._bg;
    g.clear();
    g.rect(0, 0, Wi, Hi).fill({ color: 0x000000, alpha: 0.55 });
    hudPanel(g, px, py, pw, ph);
    hudDivider(g, px + 8, py + 88, pw - 16);

    o._title.x = o._dcTitle.x = Wi >> 1;
    o._title.y = py + 24;
    o._dcTitle.y = py + 36;
    o._hint.x = Wi >> 1;
    o._hint.y = py + 106;
    o._keys.x = Wi >> 1;
    o._keys.y = py + 140;
  }
  // The HUD frame doesn't run while paused: keep crosshair vs pad reticle in
  // step with the device (a pad disconnect switches back to the mouse)
  if (visible && hudElements.crosshair && player) renderPixiCrosshair();
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
