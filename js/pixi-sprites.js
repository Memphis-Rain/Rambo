// =====================================================================
// PIXI SPRITES - retro pixel-art entity renderer (M2 / M3 / M4)
//
// Everything is drawn on an "art pixel" grid of ART screen units so it
// reads cleanly once the world is rendered at 1/3 resolution (M1).
//  - Characters: one procedural puppet (player + 12 enemy types) built
//    from rects in a typed command buffer, flushed as an outline pass
//    plus colour-batched fills. Enemy/corpse Graphics are cached per
//    entity and only rebuilt when their pose key changes.
//  - Particles, bullets, shells, gibs: pooled Sprites (no per-frame
//    allocation), every drawable carries its own zIndex = depthKey.
//  - Ground decals (G4): sealed chunk Graphics + one "recent" layer, so
//    nothing is rebuilt per frame and the draw-call count stays bounded.
//  - FX (telegraphs, rings, health bars) and a 3x5 pixel font text layer
//    are single batched Graphics per frame.
// =====================================================================

const ART = 3; // screen units per art pixel
function _spSnap(v) { return Math.round(v / ART) * ART; }

// Z layers inside worldContainer (terrain is -1000000, effectsContainer 1000000)
const SP_Z_DECAL = -999999;      // baked decal chunks
const SP_Z_DECAL_RECENT = -999998.5;
const SP_Z_GROUND = -999996;     // ground shadows / flat debris (water overlay is -999997)
const SP_Z_FX = 999000;          // telegraphs, rings, health bars
const SP_Z_TEXT = 999500;        // pixel font

// ---------------------------------------------------------------------
// Colour helpers (kept for other modules)
// ---------------------------------------------------------------------
function cssColorToHex(color) {
  if (typeof color === 'number') return color;
  if (typeof colorToHex === 'function') return colorToHex(color);
  const hex = String(color).replace('#', '');
  if (hex.length === 3) return parseInt(hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2], 16);
  return parseInt(hex, 16) || 0;
}

function darkenColorHex(hex, factor) {
  const r = Math.min(255, ((hex >> 16) & 0xff) * factor) | 0;
  const g = Math.min(255, ((hex >> 8) & 0xff) * factor) | 0;
  const b = Math.min(255, (hex & 0xff) * factor) | 0;
  return (r << 16) | (g << 8) | b;
}

// Deterministic integer hash (decal shapes, env details) - never Math.random at render
function _spHash(seed, i) {
  let h = Math.imul((seed | 0) ^ Math.imul(i + 1, 0x9E3779B1), 0x85EBCA6B);
  h ^= h >>> 13;
  h = Math.imul(h, 0xC2B2AE35);
  h ^= h >>> 16;
  return h >>> 0;
}

// ---------------------------------------------------------------------
// Renderer state
// ---------------------------------------------------------------------
const _sp = {
  inited: false,
  frame: 0,
  // view rect in world-screen coordinates
  vx0: 0, vx1: 0, vy0: 0, vy1: 0,
  // textures (created once, survive re-init)
  texWhite: null, texCircle: null, texMuzzle: [],
  // pooled sprites (cursor reset every frame)
  sprites: [], spriteN: 0, spritePrev: 0,
  // pooled per-frame Graphics
  gfx: [], gfxN: 0, gfxPrev: 0,
  named: {},                 // getPooledGraphics(poolKey) pools
  // per-entity cached Graphics
  enemyCache: { list: [], free: [] },
  bodyCache: { list: [], free: [] },
  // persistent Graphics
  playerG: null, ghostG: null, shadowG: null, fxG: null, textG: null, groundG: null,
  hurtG: null,
  // env objects
  env: new Map(), envVis: [], envFrame: 0,
  treeCtx: new Map(),
  // player gun tip (screen) for muzzle-flash alignment
  pTipX: 0, pTipY: 0, pTipValid: false,
  // hurt overlay
  hurtPrev: 0,
  hurtDrops: new Float32Array(24 * 5), // x, y, len, speed, life
  // decals
  dec: null,
};

// Type -> visual kind lookup (by enemy name, so table order can change)
const SP_K_MILITIA = 0, SP_K_RUNNER = 1, SP_K_HEAVY = 2, SP_K_OFFICER = 3, SP_K_BERSERKER = 4,
      SP_K_BOMBER = 5, SP_K_COMMANDO = 6, SP_K_MEDIC = 7, SP_K_SNIPER = 8, SP_K_SHIELDED = 9,
      SP_K_TANK = 10, SP_K_JUGG = 11, SP_K_PLAYER = 12;
const _spKindByName = { Militia: 0, Runner: 1, Heavy: 2, Officer: 3, Berserker: 4, Bomber: 5,
  Commando: 6, Medic: 7, Sniper: 8, Shielded: 9, Tank: 10, Juggernaut: 11 };
let _spTypeKind = new Int8Array(16);
const _spUni = new Uint32Array(13), _spUniS = new Uint32Array(13), _spUniL = new Uint32Array(13),
      _spPants = new Uint32Array(13), _spPantsS = new Uint32Array(13);
const _spTW = new Uint8Array([6, 4, 8, 6, 6, 6, 6, 6, 6, 6, 8, 8, 6]); // torso width per kind

const SP_SKIN = 0xc08858, SP_SKIN_S = 0x8e6038, SP_SKIN_L = 0xd8a070;
const SP_BOOT = 0x221a14, SP_OUTLINE = 0x120c08, SP_OUTLINE_BOSS = 0x6a0000, SP_OUTLINE_HEAL = 0x30ff50;
const SP_EYE = 0x100c0c;

// Player weapon visuals: [len, thick, bodyColor, tipColor]
const _spWeaponVis = [
  [3, 1, 0x303034, 0],        // Pistol
  [4, 1, 0x303034, 0],        // Uzi
  [7, 1, 0x3a3a3e, 0],        // Shotgun
  [8, 1, 0x26262a, 0],        // M16
  [8, 2, 0x3a3a40, 0],        // Minigun
  [9, 2, 0x4a5a2e, 0x9a8a50], // RPG
  [7, 2, 0x2a4050, 0x00ffff], // Plasma
  [7, 2, 0x34345a, 0x8888ff], // Tesla
  [10, 2, 0x4a2a4a, 0xff00ff],// Railgun
  [8, 3, 0x24442a, 0x00ff00], // BFG
  [8, 2, 0x4a2a4a, 0xff44ff], // Disintegrator
];

// ---------------------------------------------------------------------
// Textures (pixel canvases, nearest sampling)
// ---------------------------------------------------------------------
function _spCanvasTex(w, h, painter) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx2 = c.getContext('2d');
  painter(ctx2);
  const tex = PIXI.Texture.from(c);
  tex.source.scaleMode = 'nearest';
  return tex;
}

const _spMuzzleShapes = [
  ['....O....',
   '..OYY.O..',
   'OYYWWYYO.',
   'YWWWWWWYO',
   'OYYWWYYO.',
   '..OYY.O..',
   '....O....'],
  ['...O.....',
   '...Y..O..',
   '..YWY.Y..',
   'OYWWWWWYO',
   '..YWY.Y..',
   '...Y..O..',
   '...O.....'],
  ['......O..',
   '....OY...',
   '..YWWY...',
   'YWWWWWYYO',
   '..YWWY...',
   '....OY...',
   '......O..'],
];

function _spInitTextures() {
  if (_sp.texCircle) return;
  _sp.texWhite = PIXI.Texture.WHITE;
  _sp.texCircle = _spCanvasTex(16, 16, (c) => {
    c.fillStyle = '#fff';
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const dx = x - 7.5, dy = y - 7.5;
      if (dx * dx + dy * dy <= 64) c.fillRect(x, y, 1, 1);
    }
  });
  const pal = { W: '#ffffff', Y: '#ffe050', O: '#ff9020' };
  for (const rows of _spMuzzleShapes) {
    _sp.texMuzzle.push(_spCanvasTex(rows[0].length, rows.length, (c) => {
      for (let y = 0; y < rows.length; y++) for (let x = 0; x < rows[y].length; x++) {
        const ch = rows[y][x];
        if (pal[ch]) { c.fillStyle = pal[ch]; c.fillRect(x, y, 1, 1); }
      }
    }));
  }
}

// ---------------------------------------------------------------------
// Init / reset (called on every startGame / resetRound)
// ---------------------------------------------------------------------
function _spDestroy(o) {
  if (!o || o.destroyed) return;
  if (o.parent) o.parent.removeChild(o);
  o._owner = null;
  o.destroy();
}

function initPixiSprites() {
  _spInitTextures();

  // Tear down everything from a previous round
  if (_sp.inited) {
    for (const s of _sp.sprites) _spDestroy(s);
    for (const g of _sp.gfx) _spDestroy(g);
    for (const k in _sp.named) for (const g of _sp.named[k].list) _spDestroy(g);
    for (const g of _sp.enemyCache.list) _spDestroy(g);
    for (const g of _sp.enemyCache.free) _spDestroy(g);
    for (const g of _sp.bodyCache.list) _spDestroy(g);
    for (const g of _sp.bodyCache.free) _spDestroy(g);
    _sp.env.forEach((g) => _spDestroy(g));
    _spDestroy(_sp.playerG); _spDestroy(_sp.ghostG); _spDestroy(_sp.shadowG);
    _spDestroy(_sp.fxG); _spDestroy(_sp.textG); _spDestroy(_sp.groundG); _spDestroy(_sp.hurtG);
    if (_sp.dec) {
      for (const c of _sp.dec.chunks) _spDestroy(c.g);
      for (const g of _sp.dec.freeG) _spDestroy(g);
      _spDestroy(_sp.dec.recent);
    }
  }
  _sp.sprites = []; _sp.spriteN = 0; _sp.spritePrev = 0;
  _sp.gfx = []; _sp.gfxN = 0; _sp.gfxPrev = 0;
  _sp.named = {};
  _sp.enemyCache = { list: [], free: [] };
  _sp.bodyCache = { list: [], free: [] };
  _sp.env = new Map(); _sp.envVis = []; _sp.envFrame = 0;
  _sp.hurtPrev = 0; _sp.hurtDrops.fill(0);
  _sp.pTipValid = false;

  // Per-type palettes
  _spTypeKind = new Int8Array(ENEMY_TYPES.length);
  for (let i = 0; i < ENEMY_TYPES.length; i++) {
    const k = _spKindByName[ENEMY_TYPES[i].name];
    _spTypeKind[i] = k === undefined ? (i % 12) : k;
    const kk = _spTypeKind[i];
    const c = cssColorToHex(ENEMY_TYPES[i].color);
    _spUni[kk] = c; _spUniS[kk] = darkenColorHex(c, 0.68); _spUniL[kk] = darkenColorHex(c, 1.3);
    _spPants[kk] = darkenColorHex(c, 0.78); _spPantsS[kk] = darkenColorHex(c, 0.58);
  }
  _spUni[SP_K_PLAYER] = SP_SKIN; _spUniS[SP_K_PLAYER] = SP_SKIN_S; _spUniL[SP_K_PLAYER] = SP_SKIN_L;
  _spPants[SP_K_PLAYER] = 0x4e5e38; _spPantsS[SP_K_PLAYER] = 0x3a4628;

  const mk = (z) => { const g = new PIXI.Graphics(); g.zIndex = z; worldContainer.addChild(g); return g; };
  _sp.groundG = mk(SP_Z_GROUND);       // per-frame ground shadows
  _sp.shadowG = _sp.groundG;
  _sp.playerG = mk(0);
  _sp.ghostG = mk(0);
  _sp.fxG = mk(SP_Z_FX);
  _sp.textG = mk(SP_Z_TEXT);

  // G10 hurt overlay: full-res UI, below the HUD, never takes input
  _sp.hurtG = new PIXI.Graphics();
  _sp.hurtG.zIndex = 1;
  _sp.hurtG.eventMode = 'none';
  uiContainer.addChildAt(_sp.hurtG, 0);

  _spDecalInit();
  _sp.inited = true;
}

// ---------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------
function _spSprite(tex, x, y, z) {
  let s = _sp.sprites[_sp.spriteN];
  if (!s) {
    s = new PIXI.Sprite(tex);
    s.anchor.set(0.5, 0.5);
    worldContainer.addChild(s);
    _sp.sprites.push(s);
  } else if (s.texture !== tex) {
    s.texture = tex;
  }
  _sp.spriteN++;
  s.visible = true;
  s.anchor.set(0.5, 0.5);
  s.x = x; s.y = y; s.zIndex = z;
  s.rotation = 0; s.alpha = 1;
  return s;
}

// Axis-aligned solid rect sprite in screen units (x, y = top-left)
function _spRectSprite(x, y, w, h, color, z, alpha) {
  const s = _spSprite(_sp.texWhite, x, y, z);
  s.anchor.set(0, 0);
  s.scale.set(w, h);
  s.tint = color;
  if (alpha !== undefined) s.alpha = alpha;
  return s;
}

function _spResetGfx(g, z) {
  g.visible = true;
  g.position.set(0, 0);
  g.rotation = 0;
  g.scale.set(1, 1);
  g.pivot.set(0, 0);
  g.skew.set(0, 0);
  g.alpha = 1;
  g.zIndex = z;
}

function _spFrameGfx(z) {
  let g = _sp.gfx[_sp.gfxN];
  if (!g) {
    g = new PIXI.Graphics();
    worldContainer.addChild(g);
    _sp.gfx.push(g);
  } else {
    g.clear();
  }
  _sp.gfxN++;
  _spResetGfx(g, z);
  return g;
}

/**
 * Legacy API: a cleared, visible Graphics from a named per-frame pool.
 * Graphics not requested again next frame are hidden automatically.
 */
function getPooledGraphics(poolKey) {
  let pool = _sp.named[poolKey];
  if (!pool) pool = _sp.named[poolKey] = { list: [], n: 0, prev: 0 };
  let g = pool.list[pool.n];
  if (!g) {
    g = new PIXI.Graphics();
    worldContainer.addChild(g);
    pool.list.push(g);
  } else {
    g.clear();
  }
  pool.n++;
  _spResetGfx(g, 0);
  return g;
}

// Per-entity cached Graphics (enemies, corpses): stays bound to its owner
function _spEntGfx(cache, obj) {
  let g = obj._spG;
  if (!g || g._owner !== obj || g.destroyed) {
    g = cache.free.pop();
    if (!g) {
      g = new PIXI.Graphics();
      worldContainer.addChild(g);
    }
    g.clear();
    _spResetGfx(g, 0);
    g._owner = obj;
    g._key = -1;
    obj._spG = g;
    cache.list.push(g);
  }
  g._frame = _sp.frame;
  return g;
}

function _spReleaseStale(cache) {
  const list = cache.list;
  let w = 0;
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    if (g._frame === _sp.frame) { list[w++] = g; continue; }
    g.visible = false;
    g.clear();
    if (g._owner && g._owner._spG === g) g._owner._spG = null;
    g._owner = null;
    cache.free.push(g);
  }
  list.length = w;
}

function _spBeginFrame() {
  _sp.frame++;
  _sp.spriteN = 0;
  _sp.gfxN = 0;
  for (const k in _sp.named) { const pl = _sp.named[k]; if (pl.n > pl.prev) pl.prev = pl.n; pl.n = 0; }
  const mx = 72, my = 120;
  _sp.vx0 = cam.x - W / 2 - mx; _sp.vx1 = cam.x + W / 2 + mx;
  _sp.vy0 = cam.y - H / 2 - my; _sp.vy1 = cam.y + H / 2 + my;
  _sp.groundG.clear();
  _sp.fxG.clear();
  _sp.textG.clear();
}

function _spEndFrame() {
  const sp = _sp.sprites;
  for (let i = _sp.spriteN; i < _sp.spritePrev; i++) sp[i].visible = false;
  _sp.spritePrev = _sp.spriteN;
  const gl = _sp.gfx;
  for (let i = _sp.gfxN; i < _sp.gfxPrev; i++) { gl[i].visible = false; gl[i].clear(); }
  _sp.gfxPrev = _sp.gfxN;
  for (const k in _sp.named) {
    const p = _sp.named[k];
    for (let i = p.n; i < p.prev; i++) { p.list[i].visible = false; p.list[i].clear(); }
    p.prev = p.n;
  }
  _spReleaseStale(_sp.enemyCache);
  _spReleaseStale(_sp.bodyCache);
}

function _spInView(sx, sy) {
  return sx > _sp.vx0 && sx < _sp.vx1 && sy > _sp.vy0 && sy < _sp.vy1;
}

// ---------------------------------------------------------------------
// Pixel rect helpers for direct Graphics drawing (screen units)
// ---------------------------------------------------------------------
// Ellipse as stacked rows (non-overlapping), optional seeded wobble.
// cx, cy: screen px (art aligned); rx, ry: art px. Caller fills.
function _spEllRows(g, cx, cy, rx, ry, seed, wob) {
  const A = ART;
  const inv = 1 / (ry + 0.5);
  for (let j = -ry; j <= ry; j++) {
    const t = j * inv;
    const base = Math.round(rx * Math.sqrt(Math.max(0, 1 - t * t)));
    let l = base, r = base;
    if (wob) {
      const h = _spHash(seed, j + 50);
      l += ((h & 3) === 0) ? -1 : ((h & 3) === 3 ? 1 : 0);
      r += (((h >> 2) & 3) === 0) ? -1 : ((((h >> 2) & 3) === 3) ? 1 : 0);
    }
    if (l + r + 1 <= 0) continue;
    g.rect(cx - l * A, cy + j * A, (l + r + 1) * A, A);
  }
}

// =====================================================================
// PUPPET COMMAND BUFFER
// =====================================================================
const SP_PB_MAX = 1024;
const _pbX = new Int16Array(SP_PB_MAX), _pbY = new Int16Array(SP_PB_MAX),
      _pbW = new Int16Array(SP_PB_MAX), _pbH = new Int16Array(SP_PB_MAX);
const _pbC = new Uint32Array(SP_PB_MAX), _pbO = new Uint8Array(SP_PB_MAX);
let _pbN = 0, _pbS = 1, _pbFlip = false;

// Push a rect in scaled art px (local, facing right; flip applied here)
function _pr(x, y, w, h, c, ol) {
  if (_pbN >= SP_PB_MAX || w <= 0 || h <= 0) return;
  if (_pbFlip) x = -(x + w);
  _pbX[_pbN] = x; _pbY[_pbN] = y; _pbW[_pbN] = w; _pbH[_pbN] = h;
  _pbC[_pbN] = c; _pbO[_pbN] = ol ? 1 : 0;
  _pbN++;
}

// Push a part in unscaled art px; endpoints scaled so adjacent parts stay adjacent
function _pp(x, y, w, h, c, ox, oy, ol) {
  const s = _pbS;
  const x0 = Math.round(x * s), x1 = Math.round((x + w) * s);
  const y0 = Math.round(y * s), y1 = Math.round((y + h) * s);
  _pr(x0 + ox, y0 + oy, x1 - x0 > 0 ? x1 - x0 : 1, y1 - y0 > 0 ? y1 - y0 : 1, c, ol);
}

// Pixel line of thickness t in scaled art px (horizontal runs merged)
function _pline(x0, y0, x1, y1, t, c, ol) {
  const dx = x1 - x0, dy = y1 - y0;
  const n = Math.max(Math.abs(dx), Math.abs(dy));
  const o = (t - 1) >> 1;
  let rx = 0, ry = 0, rw = 0;
  for (let i = 0; i <= n; i++) {
    const x = n ? x0 + Math.round(dx * i / n) : x0;
    const y = n ? y0 + Math.round(dy * i / n) : y0;
    if (rw > 0 && y === ry) {
      if (x === rx + rw) { rw++; continue; }
      if (x === rx - 1) { rx--; rw++; continue; }
    }
    if (rw > 0) _pr(rx - o, ry - o, rw + t - 1, t, c, ol);
    rx = x; ry = y; rw = 1;
  }
  if (rw > 0) _pr(rx - o, ry - o, rw + t - 1, t, c, ol);
}

// Flush buffer into Graphics g (local coords). mode: 0 normal, 1 white flash, 2 mono
function _pflush(g, olColor, mode, skipOutline, monoColor) {
  const A = ART, n = _pbN;
  if (mode === 2) {
    for (let i = 0; i < n; i++) {
      if (!_pbO[i]) continue;
      g.rect((_pbX[i] - 1) * A, (_pbY[i] - 1) * A, (_pbW[i] + 2) * A, (_pbH[i] + 2) * A);
    }
    g.fill(monoColor);
    return;
  }
  if (!skipOutline) {
    let any = false;
    for (let i = 0; i < n; i++) {
      if (!_pbO[i]) continue;
      g.rect((_pbX[i] - 1) * A, (_pbY[i] - 1) * A, (_pbW[i] + 2) * A, (_pbH[i] + 2) * A);
      any = true;
    }
    if (any) g.fill(olColor);
  }
  let cur = -1;
  for (let i = 0; i < n; i++) {
    const c = mode === 1 ? 0xffffff : _pbC[i];
    if (c !== cur) { if (cur !== -1) g.fill(cur); cur = c; }
    g.rect(_pbX[i] * A, _pbY[i] * A, _pbW[i] * A, _pbH[i] * A);
  }
  if (cur !== -1) g.fill(cur);
}

// =====================================================================
// PROCEDURAL PIXEL PUPPET (A1-A5)
// Local art-px coords, feet at (0,0), y up is negative. Size-1 figure is
// ~15 art px tall with a 6 px torso.
// =====================================================================
const _P = {
  kind: 0, s: 1, aim: 0, flip: 0,      // flip: 0 auto from aim, 1 force right, -1 force left
  walkF: -1, bob: 0, headBob: 0, recoil: 0, attack: 0,
  dead: false, curl: false, weapon: 0, spin: -1,
  gunOverride: false, gunAng: 0,
  blink: 0, visor: 0, tail: 0, glowTip: 0,
};
// Outputs (art px, local, post-flip)
const _PO = { muzX: 0, muzY: 0, hasMuz: false, scopeX: 0, scopeY: 0, top: -15 };

function _spSetMuzzle(x, y) {
  _PO.muzX = _pbFlip ? -x - 0.5 : x + 0.5;
  _PO.muzY = y + 0.5;
  _PO.hasMuz = true;
}

function _spLeg(x, top, w, lift, bootH, c, bc) {
  const bottom = -lift;
  const h = bottom - bootH - top;
  if (h > 0) _pr(x, top, w, h, c, 1);
  _pr(x, bottom - bootH, w + 1, bootH, bc, 1);
}

function _spBuildPuppet() {
  const P = _P, k = P.kind, s = P.s;
  _pbN = 0; _pbS = s;
  _PO.hasMuz = false;
  const ca = Math.cos(P.aim), sa = Math.sin(P.aim);
  _pbFlip = P.flip !== 0 ? P.flip < 0 : ca < 0;
  const dead = P.dead, curl = P.curl;
  const away = !dead && !curl && sa < -0.45;
  const front = dead || sa > 0.15;
  let gdx = Math.abs(ca), gdy = sa;
  if (P.gunOverride) { gdx = Math.cos(P.gunAng); gdy = Math.sin(P.gunAng); }
  const as = s > 1.6 ? Math.round(s) : 1;
  const tw = _spTW[k], hw = tw >> 1;
  const bob = P.bob * as;
  // A3: head leans back while recoiling; curled head tucks forward
  const hox = curl ? Math.max(1, Math.round(s)) : (P.recoil > 0 ? -as : 0);
  const hb = bob + P.headBob * as + (curl ? Math.round(2 * s) : 0);
  const isPlayer = k === SP_K_PLAYER;

  const uni = _spUni[k], uniS = _spUniS[k], uniL = _spUniL[k];
  const pants = _spPants[k], pantsS = _spPantsS[k];
  const bare = k === SP_K_BERSERKER;                       // shirtless torso
  // Rambo: black tank top, bare arms
  const torsoC = isPlayer ? 0x2c2c28 : bare ? SP_SKIN : uni;
  const torsoS = isPlayer ? 0x1c1c18 : bare ? SP_SKIN_S : uniS;
  const torsoL = isPlayer ? 0x48483e : bare ? SP_SKIN_L : uniL;
  const sleeve = (bare || isPlayer) ? SP_SKIN : uni, sleeveS = (bare || isPlayer) ? SP_SKIN_S : uniS;
  const pantsC = k === SP_K_BERSERKER ? 0x3a3028 : pants;
  const pantsSC = k === SP_K_BERSERKER ? 0x2a221c : pantsS;
  const bigFists = k === SP_K_HEAVY || k === SP_K_BERSERKER || k === SP_K_TANK;

  // ---- weapon selection ----
  let gl = 0, gt = 1, gc = 0x26262a, tip = 0;
  if (!dead) {
    if (isPlayer) {
      const v = _spWeaponVis[P.weapon] || _spWeaponVis[0];
      gl = v[0]; gt = v[1]; gc = v[2]; tip = v[3];
      if (tip && P.glowTip) tip = 0xffffff;
    } else if (k === SP_K_MILITIA) { gl = 6; gc = 0x4a3420; }
    else if (k === SP_K_OFFICER || k === SP_K_MEDIC) { gl = 3; gc = 0x303034; }
    else if (k === SP_K_COMMANDO) { gl = 4; gc = 0x26262a; }
    else if (k === SP_K_SNIPER) { gl = 11; gc = 0x2a2a20; }
    else if (k === SP_K_SHIELDED) { gl = 6; gc = 0x26262a; }
    else if (k === SP_K_JUGG) { gl = 8; gt = 2; gc = 0x3a3a40; }
  }
  const armed = gl > 0 && !curl;
  const at = Math.max(1, Math.round(1.5 * s));     // arm thickness

  // ---- gun geometry (scaled art px) ----
  let Hx = 0, Hy = 0, Ex = 0, Ey = 0, GT = 1;
  if (armed) {
    Hx = Math.round(hw * s) - P.recoil;
    Hy = Math.round(-8 * s) + bob + Math.round(gdy * 1.5);
    const L = Math.max(2, Math.round(gl * s));
    GT = Math.max(1, Math.round(gt * s));
    Ex = Hx + Math.round(gdx * L);
    Ey = Hy + Math.round(gdy * L);
  }
  const shY = Math.round(-10 * s) + bob;

  // ---- walk cycle ----
  const wf = P.walkF;
  const swing = (dead || curl || wf < 0) ? 0 : (wf === 0 ? as : wf === 2 ? -as : 0);
  const liftF = wf === 1 ? as : 0, liftB = wf === 3 ? as : 0;

  // 1. gun + gun arm behind body when aiming away
  if (armed && away) {
    _spGun(Hx, Hy, Ex, Ey, GT, gc, tip, gdx, gdy, k);
    _pline(Math.round((hw - 1) * s), shY, Hx, Hy, at, sleeveS, 1);
  }

  // 2. back arm
  if (armed) {
    _pline(Math.round((-hw + 1) * s), shY, Hx + Math.round(gdx * 2 * s), Hy + Math.round(gdy * 2 * s), at, sleeveS, 1);
  } else if (!curl) {
    const amp = (k === SP_K_RUNNER || k === SP_K_BERSERKER) ? 2 : 1;
    const asw = dead ? 0 : (swing / as) * amp * as;
    const ax = Math.round((-hw - 1) * s) + asw;
    const ay = Math.round(-11 * s) + bob;
    const ah = Math.round(4 * s);
    _pr(ax, ay, at, ah, sleeveS, 1);
    const fs = bigFists ? Math.max(2, Math.round(2 * s)) : at;
    _pr(ax - (fs - at), ay + ah, fs, fs > at ? fs : Math.max(1, Math.round(s)), SP_SKIN_S, 1);
  }

  // Rambo headband tails behind the head
  if (isPlayer && !curl) {
    const hy = Math.round(-14 * s) + hb, hx = Math.round(-2 * s) - 2 + hox;
    const f = P.tail;
    _pr(hx, hy, 1, 1, 0xb01818, 1);
    _pr(hx - 1, hy + (f ? 0 : 1), 1, 1, 0xd02020, 1);
    _pr(hx - 2, hy + (f ? 1 : 0), 1, 1, 0xb01818, 1);
  }

  // 3. legs
  const legW = Math.max(1, Math.round(2 * s));
  const bootH = Math.max(1, Math.round(s));
  const gap = tw >= 8 ? 1 : 0;
  if (curl) {
    const top = Math.round(-6 * s);
    const lw = Math.max(2, Math.round(3 * s));
    _pr(Math.round(-1 * s), top, lw, Math.round(3 * s), pantsSC, 1);
    _pr(Math.round(1 * s), top + Math.round(1 * s), lw, Math.round(2 * s), pantsC, 1);
    _pr(Math.round(3 * s), top + Math.round(1 * s), Math.max(1, Math.round(s)), Math.round(2 * s), SP_BOOT, 1);
  } else {
    const legTop = Math.round(-5 * s) + bob;
    _spLeg(Math.round((-2 - gap) * s) - swing, legTop, legW, liftB, bootH, pantsSC, SP_BOOT);
    _spLeg(Math.round(gap * s) + swing, legTop, legW, liftF, bootH, pantsC, SP_BOOT);
  }

  // 4. torso
  const tY0 = Math.round(-11 * s) + bob + (curl ? Math.round(2 * s) : 0);
  const tY1 = Math.round(-6 * s) + bob;
  const bY1 = Math.round(-5 * s) + bob;
  const tX0 = Math.round(-hw * s), tX1 = Math.round(hw * s);
  const px1 = Math.max(1, Math.round(s));
  let vestFlash = false;
  if (k === SP_K_BOMBER && P.blink === 2) vestFlash = true;
  _pr(tX0, tY0, tX1 - tX0, tY1 - tY0, vestFlash ? 0xff3020 : torsoC, 1);
  _pr(tX0, tY0, px1, tY1 - tY0, vestFlash ? 0xc01810 : torsoS, 0);          // back shade
  _pr(0, tY0, tX1 - px1, px1, vestFlash ? 0xff8060 : torsoL, 0);            // top highlight
  if (!curl) _pr(tX0, tY1, tX1 - tX0, bY1 - tY1, isPlayer ? 0x2a2010 : SP_BOOT, 1); // belt
  if (bare) _pr(Math.round(-2 * s) + hox, tY0, Math.round(4 * s), px1, SP_SKIN_S, 0); // chin shadow
  _spTorsoDetails(k, s, bob, hw, tY0, tY1, front, away);

  // 5. head
  const hX0 = Math.round(-2 * s) + hox, hX1 = Math.round(2 * s) + hox;
  const hY0 = Math.round(-15 * s) + hb, hY1 = Math.round(-11 * s) + hb;
  _pr(hX0, hY0, hX1 - hX0, hY1 - hY0, SP_SKIN, 1);
  _pr(hX0, hY0, px1, hY1 - hY0, SP_SKIN_S, 0);
  _spHead(k, s, hox, hb, front, away, dead);

  // 6. front arm + gun, or bare front arm
  if (armed && !away) {
    _spGun(Hx, Hy, Ex, Ey, GT, gc, tip, gdx, gdy, k);
    _pline(Math.round((hw - 1) * s), shY, Hx, Hy, at, sleeve, 1);
    if (k === SP_K_MEDIC) _pr(Math.round((hw - 1) * s), shY, at, px1, 0xf0f0f0, 0);
    _pr(Hx, Hy, at, at, isPlayer ? 0x1a1a1a : SP_SKIN, 0);
  } else if (armed && away) {
    // gun arm already drawn behind
  } else if (curl) {
    _pr(Math.round((hw - 2) * s), Math.round(-8 * s), Math.round(3 * s), at, sleeve, 1);
  } else {
    const amp = (k === SP_K_RUNNER || k === SP_K_BERSERKER) ? 2 : 1;
    const asw = dead ? 0 : -(swing / as) * amp * as;
    const ay = Math.round(-11 * s) + bob;
    const fs = bigFists ? Math.max(2, Math.round(2 * s)) : at;
    if (P.attack === 2) {
      // punch: arm straight out
      const ax = Math.round((hw - 1) * s);
      const len = Math.round(4 * s);
      _pr(ax, Math.round(-10 * s) + bob, len, at, sleeve, 1);
      _pr(ax + len, Math.round(-10 * s) + bob - (fs > at ? 1 : 0), fs, fs, SP_SKIN, 1);
    } else {
      const ax = Math.round((hw - 1) * s) + asw - (P.attack === 1 ? 2 * as : 0);
      const ah = Math.round(4 * s);
      _pr(ax, ay, at, ah, sleeve, 1);
      _pr(ax, ay + ah, fs, fs > at ? fs : px1, SP_SKIN, 1);
    }
  }

  // Tank shoulder cannon
  if (k === SP_K_TANK && !dead) {
    const cx0 = Math.round((-hw + 1) * s), cy0 = Math.round(-12 * s) + bob;
    const L = Math.round(4 * s), T = Math.max(2, Math.round(1.2 * s));
    const cx1 = cx0 + Math.round(gdx * L), cy1 = cy0 + Math.round(gdy * L * 0.7);
    _pline(cx0, cy0, cx1, cy1, T, 0x505050, 1);
    _pr(cx1 - (T >> 1), cy1 - ((T - 1) >> 1), T, 1, 0x1a1a1a, 0);
    _spSetMuzzle(cx1, cy1);
  }
  _PO.top = hY0 - Math.round(2 * s);
}

function _spGun(Hx, Hy, Ex, Ey, T, gc, tip, gdx, gdy, k) {
  _pline(Hx, Hy, Ex, Ey, T, gc, 1);
  const o = (T - 1) >> 1;
  // highlight pixel along the top of thick guns
  if (T >= 2) _pr(Hx + Math.round(gdx * 2), Hy - o + Math.round(gdy * 2), 1, 1, darkenColorHex(gc, 1.6), 0);
  if (tip) _pr(Ex - o, Ey - o, T, T, tip, 0);
  const P = _P;
  // magazine pixel (SMGs)
  if ((k === SP_K_PLAYER && P.weapon === 1) || k === SP_K_COMMANDO) _pr(Hx + Math.round(gdx * 2), Hy + 1, 1, 2, gc, 1);
  // shotgun pump (wood)
  if (k === SP_K_PLAYER && P.weapon === 2) _pr(Hx + Math.round(gdx * 3), Hy + Math.round(gdy * 3), 2, 1, 0x6a4020, 0);
  // militia rifle: metal barrel end
  if (k === SP_K_MILITIA) _pr(Ex - Math.round(gdx * 1), Ey - Math.round(gdy * 1), 2, 1, 0x303034, 0);
  // sniper scope
  if (k === SP_K_SNIPER) {
    const sx = Hx + Math.round(gdx * 3), sy = Hy + Math.round(gdy * 3) - 1;
    _pr(sx, sy, 2, 1, 0x101010, 1);
    _PO.scopeX = _pbFlip ? -sx - 1.5 : sx + 1.5;
    _PO.scopeY = sy + 0.5;
  }
  // spinning minigun barrels
  if (P.spin >= 0) {
    const px = -gdy, py = gdx;
    const bx = Ex - Math.round(gdx), by = Ey - Math.round(gdy);
    const f = P.spin & 1 ? 1 : -1;
    _pr(bx + Math.round(px * (T * 0.5 + 0.5) * f), by + Math.round(py * (T * 0.5 + 0.5) * f), 1, 1, 0x9a9aa0, 0);
    _pr(bx - Math.round(px * (T * 0.5 + 0.5) * f) - Math.round(gdx), by - Math.round(py * (T * 0.5 + 0.5) * f), 1, 1, 0x60606a, 0);
  }
  _spSetMuzzle(Ex + Math.round(gdx), Ey + Math.round(gdy));
}

function _spTorsoDetails(k, s, bob, hw, tY0, tY1, front, away) {
  const px = Math.max(1, Math.round(s));
  if (k === SP_K_PLAYER) {
    // bandolier: diagonal ammo belt with brass rounds
    const x0 = Math.round(-hw * s), x1 = Math.round((hw - 1) * s);
    const n = Math.max(1, x1 - x0);
    for (let i = 0; i <= n; i++) {
      const x = x0 + i, y = tY0 + Math.round((tY1 - 1 - tY0) * i / n);
      _pr(x, y, 1, px, (i & 1) ? 0x4a3018 : 0xd8b040, 0);
    }
    _pr(Math.round(-0.5 * s), tY1, px, Math.max(1, Math.round(s)), 0xc8a040, 0); // buckle
  } else if (k === SP_K_BERSERKER) {
    // red war paint stripes
    _pr(Math.round(-2 * s), tY0 + px, px, 2 * px, 0xc01818, 0);
    _pr(Math.round(0 * s), tY0 + px, px, 2 * px, 0xc01818, 0);
    _pr(Math.round(-1 * s), tY0 + 3 * px, 2 * px, px, 0x8a1010, 0);
  } else if (k === SP_K_BOMBER) {
    const blink = _P.blink;
    // C4 vest: three vertical sticks, tape strap, detonator light
    const blk = blink === 2 ? 0xffd0c0 : 0x5a6a30;
    _pr(Math.round(-2 * s), tY0 + px, px, 3 * px, blk, 0);
    _pr(Math.round(-1 * s) + px, tY0 + px, px, 3 * px, blk, 0);
    _pr(Math.round(1 * s), tY0 + px, px, 3 * px, blk, 0);
    _pr(Math.round(-3 * s), tY0 + 2 * px, 6 * px, px, 0x101010, 0);               // strap
    _pr(Math.round(2 * s), tY0 + px, px, px, blink ? 0xff2020 : 0x501010, 0);   // detonator light
  } else if (k === SP_K_OFFICER) {
    _pr(0, tY0 + px, px, px, 0xe0c040, 0);
    _pr(0, tY0 + 3 * px, px, px, 0xe0c040, 0);
    _pr(Math.round(-hw * s), tY0, px, px, 0xe0c040, 0);
    _pr(Math.round((hw - 1) * s), tY0, px, px, 0xe0c040, 0);
  } else if (k === SP_K_MEDIC) {
    if (!away) {
      const x = Math.round(-1 * s), y = tY0 + px;
      _pr(x, y, 3 * px, 3 * px, 0xf0f0f0, 0);
      _pr(x + px, y, px, 3 * px, 0x20d040, 0);
      _pr(x, y + px, 3 * px, px, 0x20d040, 0);
    }
  } else if (k === SP_K_SNIPER) {
    _pr(Math.round(-2 * s), tY0 + px, px, px, 0x5a6a3a, 0);
    _pr(Math.round(1 * s), tY0 + 2 * px, px, px, 0x3a4226, 0);
    _pr(Math.round(-3 * s) - 1, tY0 + px, 1, 1, 0x5a6a3a, 1);    // ghillie tufts
    _pr(Math.round(3 * s), tY0 + 3 * px, 1, 1, 0x3a4226, 1);
  } else if (k === SP_K_HEAVY) {
    _pr(Math.round(-3 * s), tY0 + 2 * px, 6 * px, px, _spUniL[k], 0);
  } else if (k === SP_K_TANK || k === SP_K_JUGG) {
    const plate = k === SP_K_TANK ? 0x8a8a8a : 0x6a6a70;
    _pr(Math.round(-3 * s), tY0 + px, 6 * px, px, plate, 0);
    _pr(Math.round(-3 * s), tY0 + 3 * px, 6 * px, px, plate, 0);
    // shoulder pads
    const pc = k === SP_K_TANK ? 0x7a7a7a : 0x5a5a62;
    _pr(Math.round((-hw - 1) * s), tY0 - px, Math.round(3 * s), Math.round(2 * s), pc, 1);
    _pr(Math.round((hw - 2) * s), tY0 - px, Math.round(3 * s), Math.round(2 * s), pc, 1);
    _pr(Math.round((hw - 2) * s), tY0 - px, Math.round(3 * s), px, darkenColorHex(pc, 1.35), 0);
  }
}

let _phox = 0, _phb = 0;
function _ph(x, y, w, h, c, ol) { _pp(x, y, w, h, c, _phox, _phb, ol); }

function _spHead(k, s, hox, hb, front, away, dead) {
  const P = _P;
  const px = Math.max(1, Math.round(s));
  const ey = Math.round(-13 * s) + hb;
  const e1 = Math.round(-1 * s) + hox, e2 = Math.round(1 * s) + hox;
  _phox = hox; _phb = hb;
  const hp = _ph;
  let eyeC = SP_EYE, showEyes = !away;

  switch (k) {
    case SP_K_PLAYER:
      hp(-2, -16, 4, 2, 0x16100c, 1);           // big black hair
      hp(-1, -16, 2, 1, 0x2e2420, 0);
      if (away) hp(-2, -14, 4, 3, 0x16100c, 0);
      else hp(-2, -13, 1, 2, 0x16100c, 0);
      hp(-3, -14, 1, 4, 0x16100c, 1);           // mullet
      hp(-2, -14, 4, 1, 0xd02020, 0);           // headband
      break;
    case SP_K_MILITIA:
      hp(-3, -16, 6, 2, _spUniS[k], 1);
      hp(-2, -16, 3, 1, _spUni[k], 0);
      break;
    case SP_K_RUNNER:
      hp(-2, -15, 4, 1, 0x2a1a10, 0);
      hp(-2, -14, 4, 1, 0xe0d040, 0);
      hp(-3, -14, 1, 1, 0xe0d040, 1);
      break;
    case SP_K_HEAVY:
      hp(-3, -16, 6, 2, 0x3a3a40, 1);
      hp(-3, -14, 1, 1, 0x3a3a40, 1);
      hp(2, -14, 1, 1, 0x3a3a40, 1);
      break;
    case SP_K_OFFICER:
      hp(-2, -17, 4, 2, _spUniS[k], 1);
      hp(-3, -15, 6, 1, 0x1a1a1a, 1);
      hp(2, -15, 2, 1, 0x101010, 1);            // brim forward
      hp(0, -16, 1, 1, 0xe0c040, 0);            // badge
      break;
    case SP_K_BERSERKER:
      hp(-2, -15, 4, 1, 0xd02020, 0);
      hp(-3, -15, 1, 1, 0xd02020, 1);
      hp(-4, -14 + (P.tail ? 1 : 0), 1, 1, 0xa01818, 1);
      eyeC = 0xff2020;
      break;
    case SP_K_BOMBER:
      hp(-2, -15, 4, 4, 0x1a1a1a, 0);
      if (!away) hp(-1, -13, 3, 1, SP_SKIN, 0);
      break;
    case SP_K_COMMANDO:
      hp(-2, -16, 5, 1, 0x7a1818, 1);
      hp(-3, -15, 2, 1, 0x7a1818, 1);
      hp(-2, -15, 4, 1, 0x5a1010, 0);
      hp(0, -12, 2, 1, 0x2a3a2a, 0);            // face paint
      break;
    case SP_K_MEDIC:
      hp(-2, -16, 4, 2, 0xf0f0f0, 1);
      hp(0, -16, 1, 1, 0x20d040, 0);
      break;
    case SP_K_SNIPER:
      hp(-3, -16, 6, 5, 0x4a5236, 1);
      if (!away) hp(-1, -14, 3, 2, SP_SKIN_S, 0);
      hp(-3, -17, 1, 1, 0x5a6a3a, 1);
      hp(2, -17, 1, 1, 0x3a4226, 1);
      hp(-4, -13, 1, 1, 0x3a4226, 1);
      break;
    case SP_K_SHIELDED:
      hp(-3, -16, 6, 2, 0x3a4a6a, 1);
      hp(-3, -14, 1, 2, 0x3a4a6a, 1);
      if (!away) { hp(-1, -13, 3, 1, 0x70d8ff, 0); showEyes = false; }
      break;
    case SP_K_TANK:
      hp(-3, -16, 6, 4, 0x4a4a4a, 1);
      if (!away) { hp(-1, -13, 3, 1, 0x101010, 0); showEyes = false; }
      break;
    case SP_K_JUGG:
      hp(-3, -16, 6, 4, 0x3a3a40, 1);
      hp(-2, -16, 4, 1, 0x50505a, 0);
      if (!away) { hp(-2, -13, 4, 1, P.visor ? 0xffa040 : 0xff5020, 0); showEyes = false; }
      break;
  }

  if (dead) {
    // closed eyes + bullet hole
    _pr(e1, ey, e2 - e1 + px, px, SP_EYE, 0);
    _pr(Math.round(0 * s) + hox, ey - px, px, px, 0xa01010, 0);
    return;
  }
  if (showEyes) {
    if (front) {
      _pr(e1, ey, px, px, eyeC, 0);
      _pr(e2, ey, px, px, eyeC, 0);
    } else {
      _pr(e2, ey, px, px, eyeC, 0);
    }
  }
}

// =====================================================================
// MAIN RENDER
// =====================================================================
function renderPixiSprites() {
  if (!_sp.inited) return;
  const t0 = performance.now();
  _spBeginFrame();
  _spRenderDecals();
  const t1 = performance.now();
  _spRenderEnv();
  _spRenderBodies();
  const t2 = performance.now();
  _spRenderPlayer();
  _spRenderEnemies();
  const t3 = performance.now();
  _spRenderPickups();
  _spRenderBullets();
  const t4 = performance.now();
  _spRenderParticles();
  _spRenderShells();
  _spRenderGibs();
  _spRenderFx();
  _spRenderTexts();
  _spRenderHurt();
  _spEndFrame();
  const t5 = performance.now();
  if (typeof perfLog !== 'undefined') {
    perfLog.bloodMs = t1 - t0;
    perfLog.bodiesMs = t2 - t1;
    perfLog.enemiesMs = t3 - t2;
    perfLog.bulletsMs = t4 - t3;
    perfLog.particlesMs = t5 - t4;
  }
}

// =====================================================================
// PLAYER
// =====================================================================
function _spRenderPlayer() {
  const g = _sp.playerG, gh = _sp.ghostG;
  g.clear(); gh.clear();
  gh.visible = false;
  _sp.pTipValid = false;
  const p = player;
  if (!p) { g.visible = false; return; }
  _spResetGfx(g, depthKey(p.x, p.y));
  const sx = p.x - p.y, sy = (p.x + p.y) * CFG.ISO_SCALE;
  const X = _spSnap(sx), Y = _spSnap(sy);

  const P = _P;
  P.kind = SP_K_PLAYER; P.s = 1; P.aim = p.angle; P.flip = 0;
  P.dead = false; P.curl = false; P.attack = 0; P.blink = 0; P.visor = 0;
  P.weapon = p.weapon | 0;
  P.headBob = 0; P.recoil = 0; P.gunOverride = false; P.spin = -1;
  P.tail = ((gameTime * (p.walking ? 9 : 4)) | 0) & 1;
  P.glowTip = ((gameTime * 8) | 0) & 1;
  const wep = WEAPONS[P.weapon] || WEAPONS[0];
  if (wep.spinUp && p.spinUp > 0) P.spin = (gameTime * (8 + p.spinUp * 30)) | 0;

  // ground shadow
  const sg = _sp.groundG;
  _spEllRows(sg, X, Y, 4, 1, 0, false);
  sg.fill({ color: 0x000000, alpha: 0.3 });

  if (p.dodging) {
    // A4: tumble through 4 quarter-turn frames with a small hop
    const dur = CFG.DODGE_DURATION || 0.25;
    const prog = Math.min(0.999, Math.max(0, 1 - p.dodgeTimer / dur));
    const f = Math.min(3, (prog * 4) | 0);
    const dc = Math.cos(p.dodgeAngle), ds = Math.sin(p.dodgeAngle);
    const dsx = dc - ds, dsy = (dc + ds) * CFG.ISO_SCALE;
    const dir = dsx >= 0 ? 1 : -1;
    P.curl = true; P.walkF = -1; P.bob = 0;
    P.flip = dir;
    P.aim = dir > 0 ? 0 : Math.PI;
    _spBuildPuppet();
    const hop = (f === 1 || f === 2) ? 3 : 1;
    const piv = -7 * ART;
    g.pivot.set(0, piv);
    g.position.set(X, Y + piv - hop * ART);
    g.rotation = f * (Math.PI / 2) * dir;
    _pflush(g, SP_OUTLINE, 0, false, 0);
    // after-image one frame behind
    const dl = Math.sqrt(dsx * dsx + dsy * dsy) || 1;
    gh.visible = true;
    _spResetGfx(gh, g.zIndex - 0.01);
    gh.pivot.set(0, piv);
    gh.position.set(X - _spSnap(dsx / dl * 15), Y + piv - _spSnap(dsy / dl * 15) - ART);
    gh.rotation = (f - 1) * (Math.PI / 2) * dir;
    gh.alpha = 0.35;
    _pflush(gh, 0, 2, true, 0x9ad0ff);
    return;
  }

  // A1 walk / A2 idle
  if (p.walking) {
    P.walkF = ((p.walkDist || 0) / 14) & 3;
    P.bob = (P.walkF & 1) ? -1 : 0;
  } else {
    P.walkF = -1;
    P.bob = (((gameTime * 1.5) | 0) & 1) ? -1 : 0;
  }
  // A3 recoil
  if (p.recoilT > 0) { P.recoil = p.recoilMag || 1; }
  // A2 fidget: raise the weapon and nod
  if (p.fidgetT > 0) {
    const fp = 1 - p.fidgetT / 0.7;
    P.gunOverride = true;
    if (fp < 0.2 || fp > 0.8) P.gunAng = -0.6;
    else { P.gunAng = -1.15; P.headBob = (((fp * 10) | 0) & 1); }
  } else if (p.reloading) {
    P.gunOverride = true; P.gunAng = 1.0;
  }
  _spBuildPuppet();
  g.position.set(X, Y);
  const flash = p.hitFlash > 0 && (((p.hitFlash * 30) | 0) & 1);
  _pflush(g, SP_OUTLINE, flash ? 1 : 0, false, 0);
  if (_PO.hasMuz) {
    _sp.pTipX = g.x + _PO.muzX * ART;
    _sp.pTipY = g.y + _PO.muzY * ART;
    _sp.pTipValid = true;
  }
}

// =====================================================================
// ENEMIES
// =====================================================================
function _spRenderEnemies() {
  const iso = CFG.ISO_SCALE;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    const sx = e.x - e.y, sy = (e.x + e.y) * iso;
    const g = _spEntGfx(_sp.enemyCache, e);
    if (!_spInView(sx, sy)) { g.visible = false; continue; }
    g.visible = true;
    const t = ENEMY_TYPES[e.type];
    const k = _spTypeKind[e.type];
    const s = e.size || t.size || 1;

    // screen-space aim, quantized to 16 directions
    const c = Math.cos(e.angle || 0), sn = Math.sin(e.angle || 0);
    const sa = Math.atan2((c + sn) * iso, c - sn);
    const aq = ((Math.round(sa / (Math.PI / 8)) % 16) + 16) % 16;

    let walkF = -1, bob;
    if (e.walking) {
      const stride = ((k === SP_K_RUNNER || k === SP_K_BERSERKER) ? 10 : 14) * s;
      walkF = ((e.walkDist || 0) / stride) & 3;
      bob = (walkF & 1) ? 1 : 0;
    } else {
      bob = (((gameTime * 1.4 + (e.walkDist || 0) * 0.05) | 0) & 1);
    }
    const flash = e.hitFlash > 0 ? 1 : 0;
    const recoil = e.recoilT > 0 ? 1 : 0;
    const attack = e.attackT > 0 ? (e.attackT > 0.15 ? 1 : 2) : 0;
    let blink = 0;
    const d = e.distToPlayer === undefined ? 9999 : e.distToPlayer;
    if (k === SP_K_BOMBER) {
      const per = 0.08 + 0.52 * Math.min(1, Math.max(0, (d - 60) / 340));
      const on = (gameTime % per) < per * 0.5;
      blink = on ? (d < 100 ? 2 : 1) : 0;
    }
    const glow = e.healGlow > 0 ? 1 : 0;
    const shield = (t.hasShield && e.shieldHp > 0) ? 1 + (((gameTime * 6) | 0) & 1) : 0;
    const spin = k === SP_K_JUGG ? (((gameTime * (e.fireTimer < 0.6 ? 20 : 4)) | 0) & 1) : 0;
    const visor = k === SP_K_JUGG ? (((gameTime * 4) | 0) & 1) : 0;
    const tail = (k === SP_K_BERSERKER) ? (((gameTime * 8) | 0) & 1) : 0;
    const key = (walkF + 1) + 5 * (bob + 2 * (aq + 16 * (flash + 2 * (recoil + 2 * (attack + 3 * (blink + 3 * (glow + 2 * (shield + 3 * (spin + 2 * (visor + 2 * tail))))))))));

    if (g._key !== key) {
      g._key = key;
      g.clear();
      const P = _P;
      P.kind = k; P.s = s; P.aim = aq * (Math.PI / 8); P.flip = 0;
      P.walkF = walkF; P.bob = -bob; P.headBob = 0;
      P.recoil = recoil; P.attack = attack; P.dead = false; P.curl = false;
      P.gunOverride = false; P.spin = k === SP_K_JUGG ? spin : -1;
      P.blink = blink; P.visor = visor; P.tail = tail; P.glowTip = 0;
      _spBuildPuppet();
      // shadow inside the cached graphics
      _spEllRows(g, 0, 0, Math.round(4 * s), Math.max(1, Math.round(1.3 * s)), 0, false);
      g.fill({ color: 0x000000, alpha: 0.28 });
      const ol = glow ? SP_OUTLINE_HEAL : e.isBoss ? SP_OUTLINE_BOSS : SP_OUTLINE;
      _pflush(g, ol, flash ? 1 : 0, false, 0);
      if (shield) _spShieldBubble(g, s, shield);
      g._muzX = _PO.muzX; g._muzY = _PO.muzY; g._hasMuz = _PO.hasMuz;
      g._scopeX = _PO.scopeX; g._scopeY = _PO.scopeY; g._top = _PO.top;
    }
    // A5 berserker shakes while charging the player
    let jit = 0;
    if (k === SP_K_BERSERKER && e.walking && d < 250) jit = (((gameTime * 30) | 0) & 1) ? ART : -ART;
    g.position.set(_spSnap(sx) + jit, _spSnap(sy));
    g.zIndex = depthKey(e.x, e.y);
  }
}

function _spShieldBubble(g, s, step) {
  const A = ART;
  const rx = Math.round(6 * s) + 1, ry = Math.round(9 * s) + 1;
  const cy = Math.round(-7.5 * s) * A;
  const inv = 1 / (ry + 0.5);
  // interior (stepped low alpha)
  for (let j = -ry + 1; j <= ry - 1; j++) {
    const t = j * inv;
    const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - t * t)));
    if (w > 1) g.rect((-w + 1) * A, cy + j * A, (2 * w - 1) * A, A);
  }
  g.fill({ color: 0x5090ff, alpha: step === 1 ? 0.16 : 0.24 });
  // rim pixels
  for (let j = -ry; j <= ry; j++) {
    const t = j * inv;
    const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - t * t)));
    if (j === -ry || j === ry || w <= 1) g.rect(-w * A, cy + j * A, (2 * w + 1) * A, A);
    else { g.rect(-w * A, cy + j * A, A, A); g.rect(w * A, cy + j * A, A, A); }
  }
  g.fill({ color: 0x80c0ff, alpha: step === 1 ? 0.55 : 0.8 });
}

// =====================================================================
// CORPSES (G5): same puppet, dead pose, falls over around the feet
// =====================================================================
function _spRenderBodies() {
  const iso = CFG.ISO_SCALE;
  const span = Math.max(0.001, CFG.BODY_FADE_END - CFG.BODY_FADE_START);
  const Q = Math.PI / 4;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const age = gameTime - (b.createdAt || 0);
    if (age > CFG.BODY_FADE_END) continue;
    const sx = b.x - b.y, sy = (b.x + b.y) * iso;
    if (!_spInView(sx, sy)) continue;
    const g = _spEntGfx(_sp.bodyCache, b);
    g.visible = true;

    const fall = b.fall === undefined ? 1 : b.fall;
    const fallDir = b.fallDir || 1;
    const z = b.z || 0;
    const rot = fallDir * Math.PI / 2 * fall + (b.spinAngle || 0);
    let m = ((Math.round(rot / Q) % 8) + 8) % 8;
    const resting = b.fall === undefined || b.settled || (z <= 0 && fall >= 1);
    if (resting && m !== 2 && m !== 6) {
      // always come to rest lying down
      m = (m === 1 || m === 3) ? 2 : (m === 5 || m === 7) ? 6 : (fallDir > 0 ? 2 : 6);
    }
    let alpha = 1, astep = 0;
    if (age > CFG.BODY_FADE_START) {
      astep = 1 + Math.min(3, ((age - CFG.BODY_FADE_START) / span * 4) | 0);
      alpha = 1 - astep * 0.2;
    }
    const fading = astep > 0 ? 1 : 0;
    if (g._key !== fading) {
      g._key = fading;
      g.clear();
      const k = b.type !== undefined ? _spTypeKind[b.type] : 0;
      const P = _P;
      P.kind = k; P.s = b.size || 1; P.aim = 0.6;
      P.flip = (b.flip || 1) < 0 ? -1 : 1;
      P.walkF = -1; P.bob = 0; P.headBob = 0; P.recoil = 0; P.attack = 0;
      P.dead = true; P.curl = false; P.gunOverride = false; P.spin = -1;
      P.blink = 0; P.visor = 0; P.tail = 0; P.glowTip = 0;
      _spBuildPuppet();
      _pflush(g, b.isBoss ? SP_OUTLINE_BOSS : SP_OUTLINE, 0, fading === 1, 0);
    }
    g.rotation = m * Q;
    g.alpha = alpha;
    g.position.set(_spSnap(sx), _spSnap(sy - z));
    g.zIndex = depthKey(b.x, b.y) - 1;
  }
}

// =====================================================================
// PICKUPS (A6)
// =====================================================================
function _spRenderPickups() {
  const A = ART, iso = CFG.ISO_SCALE;
  for (let i = 0; i < pickups.length; i++) {
    const pk = pickups[i];
    const sx = pk.x - pk.y, sy = (pk.x + pk.y) * iso;
    if (!_spInView(sx, sy)) continue;
    if (pk.life < 4 && (((gameTime * 8) | 0) & 1)) continue; // blink before expiring
    const X = _spSnap(sx), Y = _spSnap(sy);
    const ph = (((gameTime * 5 + pk.x * 0.01) | 0) & 3);
    const bob = (ph === 1 || ph === 2) ? -A : 0;
    const sg = _sp.groundG;
    sg.rect(X - 2 * A, Y, 5 * A, A);
    sg.fill({ color: 0, alpha: 0.3 });
    const g = _spFrameGfx(depthKey(pk.x, pk.y));
    g.position.set(X, Y - 4 * A + bob);
    if (pk.type === 'health') {
      g.rect(-2 * A, -4 * A, 5 * A, 9 * A); g.rect(-4 * A, -2 * A, 9 * A, 5 * A);
      g.fill(SP_OUTLINE);
      g.rect(-1 * A, -3 * A, 3 * A, 7 * A); g.rect(-3 * A, -1 * A, 7 * A, 3 * A);
      g.fill(0x20c030);
      g.rect(-1 * A, -3 * A, A, 3 * A); g.rect(-3 * A, -1 * A, 2 * A, A);
      g.fill(0xa0ffa0);
      g.rect(1 * A, 1 * A, A, 3 * A); g.rect(2 * A, 1 * A, 2 * A, A);
      g.fill(0x108020);
    } else {
      // shield gem: diamond rows
      for (let j = -3; j <= 3; j++) {
        const w = 3 - Math.abs(j);
        g.rect((-w - 1) * A, j * A - A, (2 * w + 3) * A, A);
      }
      g.fill(SP_OUTLINE);
      for (let j = -2; j <= 2; j++) {
        const w = 2 - Math.abs(j);
        g.rect(-w * A, j * A - A, (2 * w + 1) * A, A);
      }
      g.fill(0x3878ff);
      g.rect(-1 * A, -2 * A, A, A); g.rect(0, -3 * A, A, A);
      g.fill(0xb0d0ff);
    }
  }
}

// =====================================================================
// BULLETS: pooled tracer sprites
// =====================================================================
function _spRenderBullets() {
  const iso = CFG.ISO_SCALE, A = ART;
  const Q = Math.PI / 16;
  const flick = ((_sp.frame >> 1) & 1);
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    const sx = b.x - b.y, sy = (b.x + b.y) * iso - 18;
    if (!_spInView(sx, sy)) continue;
    const svx = b.vx - b.vy, svy = (b.vx + b.vy) * iso;
    const sp = Math.sqrt(svx * svx + svy * svy);
    const ang = Math.round(Math.atan2(svy, svx) / Q) * Q;
    const col = cssColorToHex(b.color);
    const z = depthKey(b.x, b.y);
    const X = _spSnap(sx), Y = _spSnap(sy);
    if (b.bfg) {
      const g1 = _spSprite(_sp.texCircle, X, Y, z - 0.01);
      g1.scale.set(10 * A / 16); g1.tint = col; g1.alpha = flick ? 0.35 : 0.5;
      const c1 = _spSprite(_sp.texCircle, X, Y, z);
      c1.scale.set(6 * A / 16); c1.tint = 0xd0ffd0;
      continue;
    }
    let len, th;
    if (b.beam) { len = Math.min(300, sp * 0.06); th = 2 * A; }
    else if (b.explosive) { len = 4 * A; th = 2 * A; }
    else { len = Math.max(2 * A, Math.min(8 * A, sp * 0.018)); th = b.glow ? 2 * A : A; }
    len = _spSnap(len);
    if (b.glow || b.beam) {
      const gs = _spSprite(_sp.texWhite, X, Y, z - 0.01);
      gs.anchor.set(1, 0.5);
      gs.scale.set(len + 2 * A, th + 2 * A);
      gs.rotation = ang; gs.tint = col; gs.alpha = flick ? 0.3 : 0.45;
    }
    const s = _spSprite(_sp.texWhite, X, Y, z);
    s.anchor.set(1, 0.5);
    s.scale.set(len, th);
    s.rotation = ang;
    s.tint = b.explosive ? 0xd0c060 : (b.glow ? darkenColorHex(col, 1.4) | 0x404040 : col);
    if (b.explosive) {
      // rocket flame
      const f = _spSprite(_sp.texWhite, X - Math.cos(ang) * len, Y - Math.sin(ang) * len, z - 0.01);
      f.anchor.set(1, 0.5);
      f.scale.set(flick ? 2 * A : 3 * A, A * 2);
      f.rotation = ang; f.tint = flick ? 0xffd040 : 0xff7020;
    }
  }
}

// =====================================================================
// PARTICLES: pooled sprites, frame-stepped colour / alpha
// =====================================================================
function _spStep3(r) { return r > 0.66 ? 1 : r > 0.33 ? 0.66 : 0.33; }

function _spRenderParticles() {
  const iso = CFG.ISO_SCALE, A = ART;
  const tw = _sp.texWhite, tc = _sp.texCircle;
  const px = player ? player.x : 0, py = player ? player.y : 0;
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const sx = p.x - p.y, sy = (p.x + p.y) * iso - (p.z || 0);
    if (!_spInView(sx, sy)) continue;
    const lr = p.maxLife > 0 ? p.life / p.maxLife : 0;
    const X = _spSnap(sx), Y = _spSnap(sy);
    const z = depthKey(p.x, p.y);
    const type = p.type;
    const col = typeof p.color === 'number' ? p.color : cssColorToHex(p.color);

    if (type === 'fire') {
      if (col !== 0xffffff) {
        // tinted "fire" (fireflies): small blinking pixel
        const s = _spSprite(tw, X, Y, z);
        s.scale.set(A, A); s.tint = col;
        s.alpha = (((gameTime * 6 + i) | 0) & 1) ? 1 : 0.5;
        continue;
      }
      // J1: frame-stepped colour bands, no smooth fade
      let c, a = 1;
      if (lr > 0.85) c = 0xffffff;
      else if (lr > 0.65) c = 0xffe040;
      else if (lr > 0.45) c = 0xff8a10;
      else if (lr > 0.25) c = 0xd02810;
      else { c = 0x3a3030; a = 0.8; }
      const d = Math.max(A, _spSnap(p.size * 2));
      const s = _spSprite(tc, X, Y, z);
      s.scale.set(d / 16); s.tint = c; s.alpha = a;
    } else if (type === 'smoke' || type === 'mist') {
      const fs = p.fadeStart || 0;
      const fr = fs > 0 && lr < fs ? lr / fs : 1;
      const a = (p.alpha || 1) * _spStep3(fr);
      const d = Math.max(A, _spSnap(p.size * 2));
      const s = _spSprite(d >= 3 * A ? tc : tw, X, Y, z);
      if (d >= 3 * A) s.scale.set(d / 16); else s.scale.set(d, d);
      s.tint = col; s.alpha = a;
    } else if (type === 'flash') {
      const d = Math.max(A, _spSnap(p.size * 2 * (lr > 0.5 ? 1 : 0.6)));
      const s = _spSprite(tc, X, Y, z + 1);
      s.scale.set(d / 16); s.tint = col;
    } else if (type === 'muzzle') {
      let mx = X, my = Y;
      // player flashes snap to the drawn gun tip
      if (_sp.pTipValid) {
        const dx = p.x - px, dy = p.y - py;
        if (dx * dx + dy * dy < 1600) { mx = _spSnap(_sp.pTipX); my = _spSnap(_sp.pTipY); }
      }
      const tex = _sp.texMuzzle[(p.shape | 0) % 3];
      const s = _spSprite(tex, mx, my, z + 2);
      s.anchor.set(0, 0.5);
      const k = A * Math.max(1, Math.round(p.size / 4.5));
      s.scale.set(k, k);
      s.rotation = Math.round((p.rotation || 0) / (Math.PI / 8)) * (Math.PI / 8);
      s.tint = 0xffffff;
    } else if (type === 'debris') {
      const big = p.size > 1.6;
      const s = _spSprite(tw, X, Y, z);
      const r = Math.round((p.rotation || 0) / (Math.PI / 2)) & 1;
      if (big) s.scale.set(r ? A : 2 * A, r ? 2 * A : A); else s.scale.set(A, A);
      s.tint = col;
      if (lr < (p.fadeStart || 0)) s.alpha = 0.5;
    } else {
      // blood, spark, trail, default: chunky pixel squares
      const d = Math.max(A, _spSnap(p.size * (type === 'blood' ? 1.3 : 1.6)));
      const s = _spSprite(tw, X, Y, z);
      s.scale.set(d, d); s.tint = col;
      if (type !== 'blood' && type !== 'spark') {
        const fs = p.fadeStart || 0;
        if (fs > 0 && lr < fs) s.alpha = _spStep3(lr / fs);
      }
    }
  }
}

// =====================================================================
// SHELLS (J6) and GIBS (G5)
// =====================================================================
function _spRenderShells() {
  const iso = CFG.ISO_SCALE, A = ART;
  const Q = Math.PI / 4;
  for (let i = 0; i < shells.length; i++) {
    const sh = shells[i];
    const sx = sh.x - sh.y, gy = (sh.x + sh.y) * iso;
    if (!_spInView(sx, gy)) continue;
    const z = sh.z || 0;
    const X = _spSnap(sx), Y = _spSnap(gy - z);
    if (z > 1) {
      const sg = _sp.groundG;
      sg.rect(X - A, _spSnap(gy), 2 * A, A);
    }
    const s = _spSprite(_sp.texWhite, X, Y, depthKey(sh.x, sh.y));
    const red = (sh.size || 0) >= 0.75;
    s.scale.set(red ? 3 * A : 2 * A, A);
    s.rotation = Math.round((sh.rotation || 0) / Q) * Q;
    s.tint = red ? 0xc03020 : (((sh.rotation * 2) | 0) & 1 ? 0xe8c060 : 0xc89830);
  }
  _sp.groundG.fill({ color: 0, alpha: 0.35 });
}

function _spRenderGibs() {
  const iso = CFG.ISO_SCALE, A = ART;
  const sg = _sp.groundG;
  for (let i = 0; i < gibs.length; i++) {
    const gb = gibs[i];
    const sx = gb.x - gb.y, gy = (gb.x + gb.y) * iso;
    if (!_spInView(sx, gy)) continue;
    const z = gb.z || 0;
    const X = _spSnap(sx), Y = _spSnap(gy - z);
    if (z > 2) sg.rect(X - A, _spSnap(gy), 3 * A, A);
    const part = gb.part | 0;
    const sc = Math.max(1, (gb.size || 2) / 2);
    let w = 2, h = 2;
    if (part === 1 || part === 2) { w = 3; h = 1; }       // arm / leg
    else if (part === 3) { w = 3; h = 2; }                // torso
    else if (part === 4) { w = 2; h = 1; }                // meat
    w = Math.max(1, Math.round(w * sc)); h = Math.max(1, Math.round(h * sc));
    const r = Math.round((gb.rot || 0) / (Math.PI / 2)) & 3;
    if (r & 1) { const t = w; w = h; h = t; }
    const zz = depthKey(gb.x, gb.y);
    const x0 = X - ((w * A) >> 1) - ((w * A >> 1) % A), y0 = Y - h * A;
    _spRectSprite(x0 - A, y0 - A, (w + 2) * A, (h + 2) * A, 0x2a0808, zz);
    _spRectSprite(x0, y0, w * A, h * A, gb.color === undefined ? 0x8a1010 : gb.color, zz + 0.001);
    // red meat pixel at the torn end
    const mx = (r === 0 || r === 3) ? x0 + (w - 1) * A : x0;
    const my = (r < 2) ? y0 + (h - 1) * A : y0;
    _spRectSprite(mx, my, A, A, 0xc01818, zz + 0.002);
  }
  sg.fill({ color: 0, alpha: 0.35 });
}

// =====================================================================
// FX LAYER: health bars, telegraphs, rings (one batched Graphics)
// =====================================================================
function _spRing(g, cx, cy, rxPx, n, dot) {
  const A = ART, iso = CFG.ISO_SCALE;
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2;
    g.rect(_spSnap(cx + Math.cos(a) * rxPx) - ((dot * A) >> 1), _spSnap(cy + Math.sin(a) * rxPx * iso) - ((dot * A) >> 1), dot * A, dot * A);
  }
}

function _spRenderFx() {
  const g = _sp.fxG, A = ART, iso = CFG.ISO_SCALE;
  const pX = player ? _spSnap(player.x - player.y) : 0;
  const pY = player ? _spSnap((player.x + player.y) * iso) - 9 * A : 0;

  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    const eg = e._spG;
    if (!eg || eg._owner !== e || !eg.visible) continue;
    const t = ENEMY_TYPES[e.type];
    const k = _spTypeKind[e.type];
    const s = e.size || 1;
    const ex = eg.x, ey = eg.y;

    // Health bar (when damaged, or always for bosses)
    const hpR = e.maxHp > 0 ? Math.max(0, Math.min(1, e.hp / e.maxHp)) : 1;
    const shR = e.maxShieldHp > 0 ? Math.max(0, e.shieldHp / e.maxShieldHp) : 0;
    if (e.isBoss || hpR < 1 || (shR > 0 && shR < 1)) {
      const bw = Math.max(8, Math.min(e.isBoss ? 60 : 30, Math.round(10 * s)));
      const bh = e.isBoss ? 2 : 1;
      const bx = _spSnap(ex) - ((bw >> 1) * A);
      const by = ey + ((eg._top | 0) - 3 - bh) * A;
      const hasSh = e.maxShieldHp > 0 && shR > 0;
      g.rect(bx - A, by - A, (bw + 2) * A, (bh + 2 + (hasSh ? 2 : 0)) * A);
      g.fill(0x000000);
      g.rect(bx, by, bw * A, bh * A);
      g.fill(0x401010);
      const fw = Math.round(bw * hpR);
      if (fw > 0) {
        g.rect(bx, by, fw * A, bh * A);
        g.fill(e.isBoss ? 0xff8800 : hpR > 0.5 ? 0x40c040 : hpR > 0.25 ? 0xe0b020 : 0xd03030);
      }
      if (hasSh) {
        const sw = Math.max(1, Math.round(bw * Math.min(1, shR)));
        g.rect(bx, by + (bh + 1) * A, sw * A, A);
        g.fill(0x3090ff);
      }
    }

    // A5 sniper: dotted laser sight + scope glint before firing
    if (k === SP_K_SNIPER && player && eg._hasMuz && e.distToPlayer < (t.range || 550) && e.fireTimer < 1.5) {
      const x0 = ex + eg._muzX * A, y0 = ey + eg._muzY * A;
      const dx = pX - x0, dy = pY - y0;
      const len = Math.sqrt(dx * dx + dy * dy);
      const n = Math.min(240, (len / (2 * A)) | 0);
      for (let j = 1; j < n; j++) {
        g.rect(_spSnap(x0 + dx * j / n), _spSnap(y0 + dy * j / n), A, A);
      }
      const hot = e.fireTimer < 0.35;
      g.fill({ color: hot ? 0xff6050 : 0xff2020, alpha: ((_sp.frame / 3) | 0) & 1 ? 0.85 : (hot ? 1 : 0.5) });
      if (hot) {
        const gx = _spSnap(ex + eg._scopeX * A), gy = _spSnap(ey + eg._scopeY * A);
        const big = ((_sp.frame >> 2) & 1) ? 2 : 1;
        g.rect(gx - big * A, gy, (2 * big + 1) * A, A);
        g.rect(gx, gy - big * A, A, (2 * big + 1) * A);
        g.fill(0xffff80);
        g.rect(gx, gy, A, A);
        g.fill(0xffffff);
      }
    }

    // A5 medic heal pulse: expanding stepped green ring
    if (e.healPulse > 0) {
      const tt = 1 - e.healPulse / 0.45;
      const st = Math.min(3, (tt * 4) | 0);
      const r = (1 + st) * 16 * s * 1.25;
      _spRing(g, _spSnap(ex), _spSnap(ey), r, 14 + st * 6, 1);
      g.fill({ color: 0x40ff60, alpha: st === 0 ? 1 : st === 1 ? 0.8 : st === 2 ? 0.55 : 0.3 });
    }
  }

  // Shockwave rings (stepped)
  for (let i = 0; i < shockwaveEffects.length; i++) {
    const sw = shockwaveEffects[i];
    const cx = sw.x - sw.y, cy = (sw.x + sw.y) * iso;
    const lr = sw.maxLife > 0 ? sw.life / sw.maxLife : 0;
    const a = lr > 0.66 ? 0.9 : lr > 0.33 ? 0.6 : 0.3;
    const r = _spSnap(sw.radius * 1.25);
    const n = Math.max(16, Math.min(110, (r / 5) | 0));
    _spRing(g, cx, cy, r, n, 2);
    g.fill({ color: 0xffc832, alpha: a });
    _spRing(g, cx, cy, r * 0.85, n, 1);
    g.fill({ color: 0xffffc8, alpha: a * 0.6 });
  }
}

// =====================================================================
// PIXEL FONT (3x5) - damage numbers, score popups, boss names
// =====================================================================
const _spGlyph = new Uint16Array(128);
(function _spInitFont() {
  const def = {
    '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111',
    '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001010010010',
    '8': '111101111101111', '9': '111101111001111',
    'A': '010101111101101', 'B': '110101110101110', 'C': '011100100100011', 'D': '110101101101110',
    'E': '111100110100111', 'F': '111100110100100', 'G': '011100101101011', 'H': '101101111101101',
    'I': '111010010010111', 'J': '001001001101010', 'K': '101101110101101', 'L': '100100100100111',
    'M': '101111111101101', 'N': '110101101101101', 'O': '010101101101010', 'P': '110101110100100',
    'Q': '010101101110011', 'R': '110101110101101', 'S': '011100010001110', 'T': '111010010010010',
    'U': '101101101101111', 'V': '101101101101010', 'W': '101101111111101', 'X': '101101010101101',
    'Y': '101101010010010', 'Z': '111001010100111',
    '+': '000010111010000', '-': '000000111000000', '!': '010010010000010', '.': '000000000000010',
    ':': '000010000010000', '?': '110001010000010', "'": '010010000000000', ' ': '000000000000000',
  };
  for (const ch in def) {
    let v = 0;
    const b = def[ch];
    for (let i = 0; i < 15; i++) if (b[i] === '1') v |= 1 << (14 - i);
    _spGlyph[ch.charCodeAt(0)] = v;
  }
})();
const _spTBuf = new Uint8Array(48);
let _spTLen = 0;

function _spTextFromString(str) {
  const n = Math.min(str.length, _spTBuf.length);
  for (let i = 0; i < n; i++) {
    let c = str.charCodeAt(i);
    if (c >= 97 && c <= 122) c -= 32;
    _spTBuf[i] = c < 128 ? c : 63;
  }
  _spTLen = n;
}

function _spTextFromInt(v, plus) {
  v = Math.max(0, Math.round(v));
  let n = 0;
  do { _spTBuf[n++] = 48 + (v % 10); v = (v / 10) | 0; } while (v > 0 && n < 12);
  if (plus) _spTBuf[n++] = 43;
  // reverse
  for (let i = 0, j = n - 1; i < j; i++, j--) { const t = _spTBuf[i]; _spTBuf[i] = _spTBuf[j]; _spTBuf[j] = t; }
  _spTLen = n;
}

// Rects for the current text buffer, centred at cx, top at y. ps = screen px per font px
function _spTextRects(g, cx, y, ps, ox, oy) {
  const adv = 4 * ps;
  const x0 = Math.round((cx - (_spTLen * adv - ps) / 2) / ART) * ART + ox;
  for (let i = 0; i < _spTLen; i++) {
    const gl = _spGlyph[_spTBuf[i]];
    if (!gl) continue;
    const gx = x0 + i * adv;
    for (let row = 0; row < 5; row++) {
      const bits = (gl >> (12 - row * 3)) & 7;
      if (!bits) continue;
      // merge runs in the row
      let col = 0;
      while (col < 3) {
        if (!(bits & (4 >> col))) { col++; continue; }
        let end = col;
        while (end + 1 < 3 && (bits & (4 >> (end + 1)))) end++;
        g.rect(gx + col * ps, y + oy + row * ps, (end - col + 1) * ps, ps);
        col = end + 1;
      }
    }
  }
}

function _spDrawText(g, cx, y, scale, color, alpha) {
  const ps = ART * scale;
  _spTextRects(g, cx, y, ps, ART, ART);
  g.fill({ color: 0x100808, alpha: alpha });
  _spTextRects(g, cx, y, ps, 0, 0);
  g.fill({ color: color, alpha: alpha });
}

function _spRenderTexts() {
  const g = _sp.textG, iso = CFG.ISO_SCALE, A = ART;

  // G8 damage numbers: pop with overshoot, fall, blink out
  for (let i = 0; i < dmgNumbers.length; i++) {
    const n = dmgNumbers[i];
    const sx = n.x - n.y, sy = (n.x + n.y) * iso - (n.z || 0);
    if (!_spInView(sx, sy)) continue;
    if (n.life < 0.18 && (((n.life * 30) | 0) & 1)) continue;
    const crit = n.kind === DMG_CRIT, shield = n.kind === DMG_SHIELD;
    let scale = crit ? 2 : 1;
    if (n.age < 0.08) scale += 1;
    _spTextFromInt(n.value, false);
    _spDrawText(g, sx, _spSnap(sy) - 5 * scale * A, scale, crit ? 0xff3030 : shield ? 0x60a8ff : 0xfff0a0, 1);
  }

  // Kill score popups
  for (let i = 0; i < floatingTexts.length; i++) {
    const ft = floatingTexts[i];
    const sx = ft.x - ft.y, sy = (ft.x + ft.y) * iso - 20;
    if (!_spInView(sx, sy)) continue;
    if (ft.life < 0.25 && (((ft.life * 24) | 0) & 1)) continue;
    const scale = (ft.size || 14) >= 18 ? 2 : 1;
    _spTextFromString(String(ft.text));
    _spDrawText(g, sx, _spSnap(sy) - 6 * A, scale, cssColorToHex(ft.color || '#ff0'), 1);
  }

  // Boss names
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e.isBoss || !e.bossName) continue;
    const eg = e._spG;
    if (!eg || eg._owner !== e || !eg.visible) continue;
    _spTextFromString(e.bossName);
    _spDrawText(g, eg.x, eg.y + ((eg._top | 0) - 18) * A, 2, 0xff4040, 1);
  }
}

// =====================================================================
// G10 HURT OVERLAY (uiContainer, full resolution)
// =====================================================================
const _spHurtAlpha = [0, 0.16, 0.26, 0.36, 0.48];
function _spRenderHurt() {
  const g = _sp.hurtG;
  g.clear();
  if (!player) return;
  const hf = player.hurtFlash || 0;
  const D = _sp.hurtDrops;
  // new hit: spawn a few drops running down the screen edges
  if (hf > _sp.hurtPrev + 0.08) {
    const cnt = 2 + Math.round(hf * 4);
    for (let c = 0; c < cnt; c++) {
      for (let i = 0; i < 24; i++) {
        const o = i * 5;
        if (D[o + 4] > 0) continue;
        const side = Math.random();
        D[o] = side < 0.4 ? Math.random() * 70 : side < 0.8 ? W - Math.random() * 70 : Math.random() * W;
        D[o + 1] = side < 0.8 ? Math.random() * H * 0.5 : 0;
        D[o + 2] = 6 + ((Math.random() * 6) | 0);
        D[o + 3] = 40 + Math.random() * 90;
        D[o + 4] = 1.1 + Math.random() * 0.6;
        break;
      }
    }
  }
  _sp.hurtPrev = hf;
  const A = ART;
  const st = Math.min(4, Math.ceil(hf * 4));
  if (st > 0) {
    const a = _spHurtAlpha[st];
    const T = (4 + st * 3) * A, T2 = (2 + st) * A;
    const w = Math.ceil(W / A) * A, h = Math.ceil(H / A) * A;
    g.rect(0, 0, w, T); g.rect(0, h - T, w, T); g.rect(0, T, T, h - 2 * T); g.rect(w - T, T, T, h - 2 * T);
    g.fill({ color: 0xa00000, alpha: a });
    g.rect(T, T, w - 2 * T, T2); g.rect(T, h - T - T2, w - 2 * T, T2);
    g.rect(T, T + T2, T2, h - 2 * T - 2 * T2); g.rect(w - T - T2, T + T2, T2, h - 2 * T - 2 * T2);
    g.fill({ color: 0xa00000, alpha: a * 0.45 });
  }
  const step = typeof dt === 'number' ? dt : 0.016;
  let any = false;
  for (let i = 0; i < 24; i++) {
    const o = i * 5;
    if (D[o + 4] <= 0) continue;
    D[o + 4] -= step;
    D[o + 1] += D[o + 3] * step;
    D[o + 3] *= 0.985;
    if (D[o + 4] <= 0) continue;
    const x = Math.round(D[o] / A) * A, y = Math.round(D[o + 1] / A) * A;
    const len = D[o + 2] * A;
    g.rect(x, y - len, 2 * A, len);
    g.rect(x - A, y - 2 * A, 4 * A, 2 * A);
    any = true;
  }
  if (any) g.fill({ color: 0x8a0000, alpha: 0.85 });
}

// =====================================================================
// ENV OBJECTS: cached Graphics per object, shared tree contexts
// =====================================================================
function _spHueHex(h) {
  const k = (n) => { const kk = (n + h / 60) % 6; return 1 - Math.max(0, Math.min(kk, 4 - kk, 1)); };
  const r = (k(5) * 220) | 0, gg = (k(3) * 220) | 0, b = (k(1) * 220) | 0;
  return (r << 16) | (gg << 8) | b;
}

function _spEnvState(obj) {
  if (obj.type !== 'barrel') return 0;
  if (obj.exploded) return -1;
  return Math.ceil((obj.hp || 0) / Math.max(1, obj.maxHp || 30) * 6);
}

function _spBuildEnv(obj) {
  const type = obj.type;
  if (type === 'tree' || type === 'pine' || type === 'bush' || type === 'deadtree') {
    const key = typeof bucketKey === 'function' ? bucketKey(type, obj.radius, obj.height) : type + obj.radius + '_' + obj.height;
    let tpl = _sp.treeCtx.get(key);
    if (tpl === undefined) {
      tpl = createTreeGraphics(type, obj.radius, obj.height) || null;
      _sp.treeCtx.set(key, tpl);
    }
    if (!tpl) return null;
    const g = new PIXI.Graphics(tpl.context);
    g._tree = type === 'tree' || type === 'pine';
    return g;
  }
  const g = new PIXI.Graphics();
  _spDrawEnv(g, obj);
  return g;
}

function _spRock(g, cx, cy, rx, ry, seed, dark) {
  const A = ART;
  _spEllRows(g, cx + A, cy + ry * A, rx + 1, Math.max(1, ry >> 1), seed, false);
  g.fill({ color: 0, alpha: 0.25 });
  _spEllRows(g, cx, cy, rx + 1, ry + 1, seed, true);
  g.fill(0x24241f);
  _spEllRows(g, cx, cy, rx, ry, seed, true);
  g.fill(dark ? 0x56564c : 0x62625a);
  _spEllRows(g, cx - A, cy - A, Math.max(1, rx - 1), Math.max(1, ry - 1), seed + 1, true);
  g.fill(dark ? 0x74746a : 0x828278);
  _spEllRows(g, cx - Math.round(rx / 3) * A, cy - Math.round(ry / 2) * A, Math.max(1, rx >> 1), Math.max(0, (ry >> 1) - 1), seed + 2, false);
  g.fill(dark ? 0x8e8e82 : 0x9e9e92);
}

function _spDrawEnv(g, obj) {
  const A = ART, type = obj.type;
  const seed = ((obj.x * 73856093) ^ (obj.y * 19349663)) | 0;
  g.clear();
  if (type === 'rock' || type === 'boulder') {
    const rx = Math.max(2, Math.round((obj.radius || 8) * 1.1 / A));
    const ry = Math.max(1, Math.round(rx * 0.6));
    _spRock(g, 0, -ry * A, rx, ry, seed, type === 'boulder');
  } else if (type === 'rockcluster') {
    const r = obj.radius || 12;
    for (let i = 0; i < 3; i++) {
      const h = _spHash(seed, i);
      const rx = Math.max(1, Math.round(r * (0.35 + (h & 7) * 0.04) / A));
      const ry = Math.max(1, Math.round(rx * 0.6));
      const ox = ((((h >> 4) & 15) - 7) * r / 10) | 0, oy = ((((h >> 8) & 15) - 7) * r / 20) | 0;
      _spRock(g, _spSnap(ox), _spSnap(oy) - ry * A, rx, ry, seed + i, i & 1);
    }
  } else if (type === 'barrel') {
    if (obj.exploded) {
      for (let i = 0; i < 5; i++) {
        const h = _spHash(seed, i);
        g.rect(_spSnap(((h & 31) - 16) * 0.8), _spSnap((((h >> 5) & 15) - 8) * 0.6), A * (1 + (h >> 9 & 1)), A);
      }
      g.fill(0x2a1a12);
      g.rect(-A, 0, A, A); g.rect(2 * A, -A, A, A);
      g.fill(0x6a2a20);
      return;
    }
    _spEllRows(g, A, 0, 4, 1, 0, false);
    g.fill({ color: 0, alpha: 0.3 });
    g.rect(-3 * A, -9 * A, 7 * A, 10 * A);
    g.fill(SP_OUTLINE);
    g.rect(-2 * A, -8 * A, 5 * A, 8 * A);
    g.fill(0x8a2a20);
    g.rect(2 * A, -8 * A, A, 8 * A);
    g.fill(0x5e1a14);
    g.rect(-1 * A, -7 * A, A, 6 * A);
    g.fill(0xb44a36);
    g.rect(-2 * A, -6 * A, 5 * A, A); g.rect(-2 * A, -2 * A, 5 * A, A);
    g.fill(0x4a4a4e);
    g.rect(-1 * A, -9 * A, 3 * A, A);
    g.fill(0xa04030);
    if (obj.hp < obj.maxHp) {
      const r = Math.max(0, obj.hp / obj.maxHp);
      const n = Math.round((1 - r) * 5);
      for (let i = 0; i < n; i++) {
        const h = _spHash(seed, i + 10);
        g.rect((-2 + (h % 5)) * A, (-8 + ((h >> 4) % 8)) * A, A, A);
      }
      if (n) g.fill(0x1a1210);
      g.rect(-3 * A, -12 * A, 7 * A, 3 * A);
      g.fill(0x000000);
      const fw = Math.max(1, Math.round(5 * r));
      g.rect(-2 * A, -11 * A, fw * A, A);
      g.fill(0xff3030);
    }
  } else if (type === 'sandbag') {
    const n = Math.max(2, Math.round((obj.width || 36) / 12));
    const w0 = -((n * 4) >> 1);
    for (let row = 0; row < 2; row++) {
      const cnt = row ? n - 1 : n;
      const off = row ? 2 : 0;
      for (let i = 0; i < cnt; i++) g.rect((w0 + off + i * 4 - 1) * A, (-3 - row * 2 - 1) * A, 6 * A, 4 * A);
      g.fill(0x2a2416);
      for (let i = 0; i < cnt; i++) g.rect((w0 + off + i * 4) * A, (-3 - row * 2) * A, 4 * A, 2 * A);
      g.fill(row ? 0xb8a474 : 0xa08e60);
      for (let i = 0; i < cnt; i++) g.rect((w0 + off + i * 4 + 1) * A, (-3 - row * 2) * A, 2 * A, A);
      g.fill(0xcfbf8e);
    }
  } else if (type === 'crate') {
    g.rect(-4 * A, -8 * A, 9 * A, 9 * A);
    g.fill(SP_OUTLINE);
    g.rect(-3 * A, -5 * A, 7 * A, 5 * A);
    g.fill(0x7a5428);
    g.rect(-3 * A, -7 * A, 7 * A, 2 * A);
    g.fill(0xa07038);
    g.rect(-3 * A, -3 * A, 7 * A, A); g.rect(0, -5 * A, A, 5 * A);
    g.fill(0x5a3c1a);
  } else if (type === 'ruins') {
    const w = Math.max(4, Math.round((obj.width || 30) / A));
    const h = Math.max(3, Math.round((obj.height || 20) / A));
    const x0 = -(w >> 1);
    for (let i = 0; i < w; i += 2) {
      const hh = Math.max(1, h - (_spHash(seed, i) % Math.max(1, (h >> 1) + 1)));
      g.rect((x0 + i - 1) * A, (-hh - 1) * A, 4 * A, (hh + 2) * A);
    }
    g.fill(0x22221e);
    for (let i = 0; i < w; i += 2) {
      const hh = Math.max(1, h - (_spHash(seed, i) % Math.max(1, (h >> 1) + 1)));
      g.rect((x0 + i) * A, -hh * A, 2 * A, hh * A);
    }
    g.fill(0x7a766c);
    for (let i = 0; i < w; i += 2) {
      const hh = Math.max(1, h - (_spHash(seed, i) % Math.max(1, (h >> 1) + 1)));
      g.rect((x0 + i) * A, -hh * A, 2 * A, A);
      if (hh > 3) g.rect((x0 + i + 1) * A, (-hh + 2) * A, A, A);
    }
    g.fill(0x9a968a);
  } else if (type === 'reeds') {
    const hgt = Math.max(3, Math.round((obj.height || 12) / A));
    for (let i = 0; i < 5; i++) {
      const hh = Math.max(2, hgt - (_spHash(seed, i) % 3));
      g.rect((i - 2) * A + ((i & 1) ? A : 0) - A, -hh * A, A, hh * A);
    }
    g.fill(0x4a6a2a);
    for (let i = 0; i < 5; i += 2) {
      const hh = Math.max(2, hgt - (_spHash(seed, i) % 3));
      g.rect((i - 2) * A - A, -hh * A, A, 2 * A);
    }
    g.fill(0x6a4a2a);
  } else if (type === 'flowers') {
    const n = 3 + (_spHash(seed, 1) % 3);
    const r = obj.radius || 6;
    for (let i = 0; i < n; i++) {
      const h = _spHash(seed, i + 3);
      g.rect(_spSnap(((h & 15) - 8) * r / 6), _spSnap((((h >> 4) & 15) - 8) * r / 12), A, A);
    }
    g.fill(0x3a6a20);
    for (let i = 0; i < n; i++) {
      const h = _spHash(seed, i + 3);
      g.rect(_spSnap(((h & 15) - 8) * r / 6), _spSnap((((h >> 4) & 15) - 8) * r / 12) - A, A, A);
    }
    g.fill(_spHueHex(obj.colorHue || 0));
  }
}

function _spRenderEnv() {
  const iso = CFG.ISO_SCALE;
  const vis = _sp.envVis;
  for (let i = 0; i < vis.length; i++) vis[i].visible = false;
  vis.length = 0;
  const f = _sp.frame;
  const mx = 320, my0 = 80, my1 = 360;
  const x0 = _sp.vx0 - mx, x1 = _sp.vx1 + mx, y0 = _sp.vy0 - my0, y1 = _sp.vy1 + my1;
  for (let i = 0; i < envObjects.length; i++) {
    const obj = envObjects[i];
    obj._spSeen = f;
    const sx = obj.x - obj.y, sy = (obj.x + obj.y) * iso;
    if (sx < x0 || sx > x1 || sy < y0 || sy > y1) continue;
    let g = _sp.env.get(obj);
    const st = _spEnvState(obj);
    if (g === undefined) {
      g = _spBuildEnv(obj);
      _sp.env.set(obj, g);
      if (g) {
        g._st = st;
        g.position.set(_spSnap(sx), _spSnap(sy));
        const flat = obj.type === 'flowers' || (obj.type === 'barrel' && obj.exploded);
        g.zIndex = flat ? SP_Z_GROUND + 1 : depthKey(obj.x, obj.y);
        worldContainer.addChild(g);
      }
    } else if (g && g._st !== st) {
      g._st = st;
      _spDrawEnv(g, obj);
      if (obj.type === 'barrel' && obj.exploded) g.zIndex = SP_Z_GROUND + 1;
    }
    if (!g) continue;
    g.visible = true;
    vis.push(g);
    if (g._tree) {
      // A6 optional: stepped tree sway
      const ph = Math.round(Math.sin(gameTime * 0.9 + obj.x * 0.013 + obj.y * 0.007) * 1.4);
      g.skew.x = ph * 0.025;
    }
  }
  // periodic sweep of graphics whose env object was unloaded
  if ((f % 120) === 0) {
    _sp.env.forEach(_spEnvSweepFn);
  }
}

function _spEnvSweepFn(g, obj, map) {
  if (obj._spSeen === _sp.frame) return;
  if (g) _spDestroy(g);
  map.delete(obj);
}

// =====================================================================
// DECALS (G4): sealed chunk Graphics + a small "recent" layer.
// bloodPools is a FIFO (removals only at the front, pushes at the back);
// each decal is stamped with a virtual index so front removals are
// detected without scanning, and only affected chunks are rebuilt.
// =====================================================================
const SP_DEC_SMALL = 32;   // decals per sealed small chunk
const SP_DEC_MERGE = 8;    // small chunks merged into one big chunk

function _spDecalInit() {
  const recent = new PIXI.Graphics();
  recent.zIndex = SP_Z_DECAL_RECENT;
  worldContainer.addChild(recent);
  _sp.dec = {
    gen: (_sp.dec ? _sp.dec.gen : 0) + 1,
    head: 0, len: 0, front: null, frontSeed: 0,
    version: -1, sealedEnd: 0,
    chunks: [], freeG: [], recent: recent,
    rebuilds: 0,
  };
}

function _spDecChunkG() {
  const D = _sp.dec;
  let g = D.freeG.pop();
  if (!g) {
    g = new PIXI.Graphics();
    worldContainer.addChild(g);
  }
  g.clear();
  g.visible = true;
  g.zIndex = SP_Z_DECAL;
  return g;
}

function _spDecDrawRange(g, from, to) {
  const D = _sp.dec;
  for (let v = from; v < to; v++) {
    const d = bloodPools[v - D.head];
    if (d) _spDrawDecal(g, d);
  }
}

// Sum of visual size steps of still-growing decals in a chunk (-1: none growing)
function _spDecGrowSig(from, to) {
  const D = _sp.dec;
  let sig = -1;
  for (let v = from; v < to; v++) {
    const d = bloodPools[v - D.head];
    if (d && d.growing) sig = (sig < 0 ? 0 : sig) + 1 + Math.floor(d.radius / 3);
  }
  return sig;
}

function _spDecBuildChunk(c) {
  c.g.clear();
  _spDecDrawRange(c.g, c.start, c.end);
  c.sig = _spDecGrowSig(c.start, c.end);
  _sp.dec.rebuilds++;
}

function _spDecalReset() {
  const D = _sp.dec;
  for (const c of D.chunks) { c.g.clear(); c.g.visible = false; D.freeG.push(c.g); }
  D.chunks.length = 0;
  D.gen++;
  D.head = 0; D.len = 0; D.front = null; D.frontSeed = 0; D.sealedEnd = 0;
  D.recent.clear();
  D.version = -1;
}

function _spRenderDecals() {
  const D = _sp.dec;
  const n = bloodPools.length;
  const f0 = n > 0 ? bloodPools[0] : null;
  if (n === D.len && f0 === D.front && (!f0 || f0.seed === D.frontSeed) && decalVersion === D.version) return;

  if (n === 0) {
    if (D.len !== 0 || D.chunks.length) _spDecalReset();
    D.version = decalVersion;
    return;
  }

  // front removals
  let r;
  if (f0 === D.front && f0.seed === D.frontSeed) r = 0;
  else if (f0._spGen === D.gen && f0._spSeed === f0.seed && f0._spVi >= D.head) r = f0._spVi - D.head;
  else { _spDecalReset(); r = 0; }
  const oldRemain = D.len - r;
  if (oldRemain < 0 || oldRemain > n ||
      (oldRemain > 0 && bloodPools[oldRemain - 1]._spVi !== D.head + r + oldRemain - 1)) {
    _spDecalReset(); r = 0;
  }
  const head = D.head + r;
  const rem = D.len === 0 ? 0 : D.len - r;
  // stamp new decals
  for (let i = rem; i < n; i++) {
    const d = bloodPools[i];
    d._spGen = D.gen; d._spSeed = d.seed; d._spVi = head + i;
  }
  D.head = head; D.len = n; D.front = f0; D.frontSeed = f0.seed;
  const end = head + n;

  // drop / trim chunks that lost decals at the front
  if (r > 0) {
    let w = 0;
    for (let i = 0; i < D.chunks.length; i++) {
      const c = D.chunks[i];
      if (c.end <= head) { c.g.clear(); c.g.visible = false; D.freeG.push(c.g); continue; }
      if (c.start < head) {
        c.start = head;
        _spDecBuildChunk(c);
      }
      D.chunks[w++] = c;
    }
    D.chunks.length = w;
    if (D.sealedEnd < head) D.sealedEnd = head;
  }

  // small chunks holding still-growing pools: redraw only when a size step changed
  for (let i = 0; i < D.chunks.length; i++) {
    const c = D.chunks[i];
    if (c.sig < 0) continue;
    if (_spDecGrowSig(c.start, c.end) !== c.sig) _spDecBuildChunk(c);
  }

  // seal the oldest recent decals into small chunks
  while (end - D.sealedEnd >= SP_DEC_SMALL * 2) {
    const c = { g: _spDecChunkG(), start: D.sealedEnd, end: D.sealedEnd + SP_DEC_SMALL, big: false, sig: -1 };
    _spDecBuildChunk(c);
    D.chunks.push(c);
    D.sealedEnd += SP_DEC_SMALL;
  }
  // merge runs of settled small chunks into big ones (bounded draw calls)
  for (;;) {
    let runStart = -1, run = 0, found = -1;
    for (let i = 0; i < D.chunks.length; i++) {
      const c = D.chunks[i];
      if (!c.big && c.sig < 0) { if (run === 0) runStart = i; run++; if (run === SP_DEC_MERGE) { found = runStart; break; } }
      else run = 0;
    }
    if (found < 0) break;
    const s0 = D.chunks[found].start, e0 = D.chunks[found + SP_DEC_MERGE - 1].end;
    for (let i = found; i < found + SP_DEC_MERGE; i++) { const c = D.chunks[i]; c.g.clear(); c.g.visible = false; D.freeG.push(c.g); }
    const bc = { g: _spDecChunkG(), start: s0, end: e0, big: true, sig: -1 };
    _spDecBuildChunk(bc);
    D.chunks.splice(found, SP_DEC_MERGE, bc);
  }

  // recent layer
  D.recent.clear();
  _spDecDrawRange(D.recent, D.sealedEnd, end);
  D.version = decalVersion;
}

function _spDrawDecal(g, d) {
  const A = ART, iso = CFG.ISO_SCALE;
  const cx = _spSnap(d.x - d.y), cy = _spSnap((d.x + d.y) * iso);
  const seed = d.seed | 0;
  const kind = d.kind | 0;
  const col = d.color | 0;
  const r = Math.max(1, Math.floor((d.radius || 1) / 3) * 3 || d.radius || 1);
  if (kind === 0) { // DECAL_POOL
    const rx = Math.max(1, Math.round(r * 1.25 / A));
    const ry = Math.max(1, Math.round(rx * 0.55));
    _spEllRows(g, cx, cy, rx, ry, seed, rx > 1);
    const ns = 2 + (_spHash(seed, 7) % 3);
    for (let i = 0; i < ns; i++) {
      const h = _spHash(seed, i + 11);
      const a = (h & 255) / 255 * Math.PI * 2;
      const dd = rx + 1 + ((h >> 8) & 1);
      g.rect(cx + Math.round(Math.cos(a) * dd) * A, cy + Math.round(Math.sin(a) * dd * 0.55) * A, A * (1 + ((h >> 9) & 1)), A);
    }
    g.fill(col);
    if (rx >= 3) {
      _spEllRows(g, cx + A, cy, rx - 2, Math.max(0, ry - 1), seed + 3, true);
      g.fill(darkenColorHex(col, 0.72));
      g.rect(cx - Math.round(rx / 2) * A, cy - Math.max(1, ry >> 1) * A, A, A);
      g.fill(darkenColorHex(col, 1.5));
    }
  } else if (kind === 2) { // DECAL_SCORCH
    const rx = Math.max(2, Math.round(r * 1.25 / A));
    const ry = Math.max(1, Math.round(rx * 0.55));
    _spEllRows(g, cx, cy, rx, ry, seed, true);
    g.fill({ color: col, alpha: 0.7 });
    _spEllRows(g, cx, cy, Math.max(1, rx >> 1), Math.max(0, ry >> 1), seed + 1, true);
    g.fill({ color: 0x000000, alpha: 0.4 });
    const ns = 7;
    const a0 = (d.angle || 0) + (_spHash(seed, 1) & 255) / 255;
    for (let i = 0; i < ns; i++) {
      const a = a0 + i / ns * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a) * 0.55;
      const l0 = rx * 0.9, l1 = rx * (1.3 + ((_spHash(seed, i + 2) & 7) / 14));
      for (let t = l0; t <= l1; t += 1) g.rect(cx + Math.round(c * t) * A, cy + Math.round(s * t) * A, A, A);
    }
    g.fill({ color: col, alpha: 0.5 });
  } else if (kind === 3) { // DECAL_FOOT
    const c = Math.cos(d.angle || 0), s = Math.sin(d.angle || 0);
    const fx = c - s, fy = (c + s) * iso;
    const horiz = Math.abs(fx) >= Math.abs(fy);
    const hx = -Math.round(fx / (Math.abs(fx) + Math.abs(fy) + 1e-6) * 2), hy = -Math.round(fy / (Math.abs(fx) + Math.abs(fy) + 1e-6) * 2);
    g.rect(cx, cy, horiz ? 2 * A : A, horiz ? A : 2 * A);
    g.rect(cx + hx * A, cy + hy * A, A, A);
    const a = d.alpha > 0.75 ? 0.9 : d.alpha > 0.45 ? 0.6 : 0.35;
    g.fill({ color: col, alpha: a });
  } else if (kind === 4) { // DECAL_SMEAR
    const h = _spHash(seed, 1);
    const big = (d.radius || 1) >= 2;
    g.rect(cx, cy, big && (h & 1) ? 2 * A : A, big && !(h & 1) ? 2 * A : A);
    g.fill({ color: col, alpha: 0.9 });
  } else if (kind === 5) { // DECAL_GIB: flesh chunk lying in a small blood smear
    const h = _spHash(seed, 1);
    const w = Math.max(1, Math.round((d.radius || 2) * 0.75)), hh = Math.max(1, w - 1);
    const vert = h & 1;
    const ww = vert ? hh : w, wh = vert ? w : hh;
    _spEllRows(g, cx + A, cy + A, ww + 1, 1, seed, true);
    g.rect(cx - 2 * A, cy + 2 * A, A, A);
    g.fill(col);
    g.rect(cx - A, cy - A, (ww + 2) * A, (wh + 2) * A);
    g.fill(0x4a0808);
    g.rect(cx, cy, ww * A, wh * A);
    g.fill(d.color2 || 0x8a1010);
    g.rect(cx + ((h >> 1) & 1 ? (ww - 1) * A : 0), cy + ((h >> 2) & 1 ? (wh - 1) * A : 0), A, A);
    g.fill(0xc01818);
  } else if (kind === 6) { // DECAL_ASH
    const rx = Math.max(2, Math.round(r * 1.25 / A));
    const ry = Math.max(1, Math.round(rx * 0.55));
    _spEllRows(g, cx, cy, rx, ry, seed, true);
    g.fill({ color: col, alpha: 0.9 });
    for (let i = 0; i < 6; i++) {
      const h = _spHash(seed, i + 20);
      g.rect(cx + (((h & 15) % (2 * rx + 1)) - rx) * A, cy + ((((h >> 4) & 7) % (2 * ry + 1)) - ry) * A, A, A);
    }
    g.fill(d.color2 || 0xa040c0);
    g.rect(cx - A, cy - A, A, A);
    g.fill(0x6a6a6a);
  } else { // DECAL_SPLAT and unknown kinds
    const sz = (d.radius || 1) >= 2.4 ? 2 : 1;
    g.rect(cx, cy, sz * A, sz * A);
    const h = _spHash(seed, 5);
    const ns = h & 3;
    for (let i = 0; i < ns && i < 2; i++) {
      const hh = _spHash(seed, i + 6);
      const ox = ((hh & 3) - 1.5) * 2, oy = (((hh >> 2) & 3) - 1.5);
      g.rect(cx + Math.round(ox) * A, cy + Math.round(oy) * A, A, A);
    }
    g.fill(col);
  }
}
