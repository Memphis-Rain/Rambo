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
const SP_Z_ENVL = -999996.5;     // M8 E10: per-chunk remains (stumps, logs, rubble): above the water overlay (logs float), below ground shadows
const SP_Z_GROUND = -999996;     // ground shadows / flat debris (water overlay is -999997)
const SP_Z_WBLOOD = -999996.9;   // M9 W5: blood tint over the water camo, below remains / shadows / bodies
const SP_Z_CLOUD = -999996.8;    // M9 W3: blood clouds on the water surface (above the tint)
const SP_Z_WBSHEEN = -999996.84; // M9 W5: ripple sheen on bloody water (above the tint and the camo ripples at -999996.85)
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
  texGrenade: [], texGrenadeSink: [], texGrenadePk: null, // N1
  texTongue: [], texBlob: [], // M9 F1-F3 fire
  fireTrees: [],              // F3: burning / heating / charred tree sprites seen this frame (reused)
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
  wadeSeq: 0, // W2 ripple phase per wading entity
  // hurt overlay
  hurtPrev: 0,
  hurtDrops: new Float32Array(24 * 5), // x, y, len, speed, life
  // decals
  dec: null,
  // M8 E10: env remains layer (per terrain chunk)
  envL: null,
  // M9 W3/W5: blood on the water
  wbG: null, wbVer: -1,      // W5 tint overlay, rebuilt only when waterBloodVersion changes
  cloudG: null,              // W3 blood clouds (per frame)
  texBayer: [], patStyle: new Map(), patMat: null,
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
  [7, 2, 0x4a4a3e, 0],        // Flamethrower (F1: tank, nozzle, pilot flame in _spGun)
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
  for (const rows of _spMuzzleShapes) _sp.texMuzzle.push(_spShapeTex(rows, pal));
  // N1 grenades: 3 spin frames (+ the side frame mirrored) and the pickup
  for (const rows of _spGrenadeShapes) _sp.texGrenade.push(_spShapeTex(rows, _spGrenadePal));
  _sp.texGrenade.push(_spShapeTex(_spGrenadeShapes[1].map((r) => r.split('').reverse().join('')), _spGrenadePal));
  _sp.texGrenadePk = _spShapeTex(_spGrenadePickup, _spGrenadePal);
  _spInitFireTextures();
  // Sinking (water): the upright frame cropped to its top rows
  const up = _sp.texGrenade[0];
  for (const rows of [4, 2]) {
    _sp.texGrenadeSink.push(new PIXI.Texture({ source: up.source, frame: new PIXI.Rectangle(0, 0, 5, rows) }));
  }
}

// Pixel shape (rows of palette chars, '.' = clear) -> nearest-sampled texture
function _spShapeTex(rows, pal) {
  return _spCanvasTex(rows[0].length, rows.length, (c) => {
    for (let y = 0; y < rows.length; y++) for (let x = 0; x < rows[y].length; x++) {
      const ch = rows[y][x];
      if (pal[ch]) { c.fillStyle = pal[ch]; c.fillRect(x, y, 1, 1); }
    }
  });
}

// M9 W3/W4/W5 ordered dither: 4x4 Bayer textures (white texel where the
// Bayer rank < n, n = 1..15 of 16), repeated in the Graphics' own space at
// one texel per art pixel. Fills with them are stepped coverage, never a
// smooth alpha; in worldContainer space the grid is fixed to the world, so a
// drifting cloud moves over a still pattern (no shimmer).
const _spBayer4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
function _spPatTex(n) {
  let t = _sp.texBayer[n];
  if (!t) {
    t = _sp.texBayer[n] = _spCanvasTex(4, 4, (c) => {
      c.fillStyle = '#fff';
      for (let i = 0; i < 16; i++) if (_spBayer4[i] < n) c.fillRect(i & 3, i >> 2, 1, 1);
    });
    t.source.addressMode = 'repeat';
  }
  return t;
}
// Cached fill style: n of 16 pixels in colour c (no per-frame allocation)
function _spPat(n, c) {
  const key = n * 0x1000000 + c;
  let st = _sp.patStyle.get(key);
  if (!st) {
    if (!_sp.patMat) _sp.patMat = new PIXI.Matrix(ART, 0, 0, ART, 0, 0);
    st = { texture: _spPatTex(n), color: c, alpha: 1, textureSpace: 'global', matrix: _sp.patMat };
    _sp.patStyle.set(key, st);
  }
  return st;
}

// N1 grenade art. O outline, G olive, L highlight, D shade, S steel cap/lever, s steel shade
const _spGrenadePal = { O: '#120c08', G: '#5a6a2c', L: '#8c9c4c', D: '#34401a', S: '#b4b4a8', s: '#62625a' };
// Spin frames: upright, on its side (cap right), upside down; frame 3 = side mirrored.
// [w, h, red-pixel x, y] per frame (the fuse blink sits mid-body)
const _spGrenadeShapes = [
  ['.SS..',
   '.OOO.',
   'OLGGO',
   'OGGDO',
   'OGDDO',
   '.OOO.'],
  ['.OOO..',
   'OLGGOS',
   'OGGDOS',
   'OGDDO.',
   '.OOO..'],
  ['.OOO.',
   'OLGGO',
   'OGGDO',
   'OGDDO',
   '.OOO.',
   '..SS.'],
];
const _spGrenadeFrm = [[5, 6, 2, 3], [6, 5, 2, 2], [5, 6, 2, 2], [6, 5, 3, 2]];
const _spGrenadePickup = [
  '...OOO...',
  '..OSSSOO.',
  '.OOsssOSO',
  'OLLGGGOSO',
  'OLGGGGDOO',
  'OGGDGGDDO',
  'OGGGGGGDO',
  'OGDGGDGDO',
  '.OGGGGDO.',
  '..OOOOO..',
];

// M9 F1-F3 fire art (J1 palette). Tongues: baked 4-tone pixel flames, 3
// flicker frames x 2 sizes x 3 heat palettes (hot / mid / dying), drawn
// with the bottom centre on the fire's base. W core, Y, O, R rim.
const _spTongueShapes = [
  [['..R..',
    '.RR..',
    '.ROR.',
    'ROYOR',
    'ROYYR',
    'RYWYR',
    'OYWYO',
    '.RYR.'],
   ['...R.',
    '..RR.',
    '.ROR.',
    '.RYOR',
    'ROYYR',
    'RYWYR',
    'OYWYO',
    '.RYR.'],
   ['.R...',
    '.R.R.',
    '.ROR.',
    'ROYR.',
    'RYYOR',
    'RYWYR',
    'OYWYO',
    '.RYR.']],
  [['...R...',
    '...R...',
    '..ROR..',
    '..RYR.R',
    '.ROYOR.',
    '.RYYYOR',
    'ROYWYOR',
    'RYWWWYR',
    'RYWWWYR',
    'ORYWYRO',
    '.RRYRR.'],
   ['....R..',
    '...RR..',
    '.R.ROR.',
    '..ROYR.',
    '.ROYYOR',
    '.RYYWOR',
    'ROYWWYR',
    'RYWWWYR',
    'RYWWWYR',
    'ORYWYRO',
    '.RRYRR.'],
   ['..R....',
    '..RR...',
    '..ROR..',
    '.RYOR..',
    '.ROYYR.',
    'ROYWYOR',
    'RYYWWOR',
    'RYWWWYR',
    'RYWWWYR',
    'ORYWYRO',
    '.RRYRR.']],
];
const _spTonguePal = [
  { W: '#fff8d8', Y: '#ffe040', O: '#ff8a10', R: '#d02810' },  // hot
  { W: '#ffe040', Y: '#ff8a10', O: '#d02810', R: '#7a1408' },  // mid
  { W: '#ff8a10', Y: '#d02810', O: '#7a1408', R: '#3a0c06' },  // dying
];
// J1 bands for the stream (outer / core tint of the mask blobs), by t / life
const SP_FL_BAND_T = [0.1, 0.28, 0.48, 0.68];
const SP_FL_OUT = [0xffe040, 0xff8a10, 0xd02810, 0x7a1408, 0x363434];
const SP_FL_CORE = [0xffffff, 0xffe040, 0xff8a10, 0xd02810, 0];
const SP_BLOB_MAX = 9;

function _spInitFireTextures() {
  _sp.texTongue = [];
  for (let h = 0; h < 3; h++) {
    const bySize = [];
    for (let z = 0; z < 2; z++) {
      const fr = [];
      for (let f = 0; f < 3; f++) fr.push(_spShapeTex(_spTongueShapes[z][f], _spTonguePal[h]));
      bySize.push(fr);
    }
    _sp.texTongue.push(bySize);
  }
  // Blobs: white masks n x n art px (n = 1..SP_BLOB_MAX), 2 ragged variants
  _sp.texBlob = [];
  for (let n = 1; n <= SP_BLOB_MAX; n++) {
    const vv = [];
    for (let v = 0; v < 2; v++) {
      vv.push(_spCanvasTex(n, n, (c) => {
        c.fillStyle = '#fff';
        const r = n / 2, r2 = (r + 0.15) * (r + 0.15);
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
          const dx = x + 0.5 - r, dy = y + 0.5 - r, d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          // ragged rim: knock out some edge pixels (seeded per variant)
          if (n >= 4 && d2 > (r - 1) * (r - 1) && (_spHash(n * 7 + v, x * 13 + y) & 3) === 0) continue;
          c.fillRect(x, y, 1, 1);
        }
      }));
    }
    _sp.texBlob.push(vv);
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
    _sp.env.forEach((g) => { if (g && g._notchG) _spDestroy(g._notchG); _spDestroy(g); });
    _spDestroy(_sp.playerG); _spDestroy(_sp.ghostG); _spDestroy(_sp.shadowG);
    _spDestroy(_sp.fxG); _spDestroy(_sp.textG); _spDestroy(_sp.groundG); _spDestroy(_sp.hurtG);
    _spDestroy(_sp.wbG); _spDestroy(_sp.cloudG);
    _spDestroy(_sp.wbSheenA); _spDestroy(_sp.wbSheenB);
    if (_sp.dec) {
      for (const c of _sp.dec.chunks) _spDestroy(c.g);
      for (const g of _sp.dec.freeG) _spDestroy(g);
      _spDestroy(_sp.dec.recent);
      _spDestroy(_sp.dec.grow);
    }
    if (_sp.envL) _spEnvLayerClear(_sp.envL);
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
  _sp.wbG = mk(SP_Z_WBLOOD);           // W5 (static between band changes)
  _sp.cloudG = mk(SP_Z_CLOUD);         // W3
  _sp.wbSheenA = mk(SP_Z_WBSHEEN);     // W5 ripple sheen, the two pulse groups
  _sp.wbSheenB = mk(SP_Z_WBSHEEN);
  _sp.wbG.eventMode = 'none'; _sp.cloudG.eventMode = 'none';
  _sp.wbSheenA.eventMode = 'none'; _sp.wbSheenB.eventMode = 'none';
  _sp.wbVer = -1;

  // G10 hurt overlay: full-res UI, below the HUD, never takes input
  _sp.hurtG = new PIXI.Graphics();
  _sp.hurtG.zIndex = 1;
  _sp.hurtG.eventMode = 'none';
  uiContainer.addChildAt(_sp.hurtG, 0);

  _spDecalInit();
  _sp.envL = _spEnvLayerNew();
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
    g.context.batchMode = 'batch'; // big puppets would otherwise each cost a draw call
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
      g.context.batchMode = 'batch'; // puppets exceed Pixi's auto-batch vertex limit
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
  const hw = W / 2 / cam.z, hh = H / 2 / cam.z; // M11 K3a: the zoomed view, in world-iso units
  _sp.vx0 = cam.x - hw - mx; _sp.vx1 = cam.x + hw + mx;
  _sp.vy0 = cam.y - hh - my; _sp.vy1 = cam.y + hh + my;
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

// W2 wading: a one-shot clip for the next _pflush, in buffer art px. axis 0
// clips rows, 1 columns; lt keeps coord < c, else coord >= c. Clipped rects
// are trimmed (outline included), so the waterline costs no mask or filter.
let _pcAx = -1, _pcLt = true, _pcC = 0;
let _pcX0 = 0, _pcY0 = 0, _pcX1 = 0, _pcY1 = 0;
// art px bounds of what the last _pflush drew (outline included; empty: x1 < x0)
let _pbBX0 = 0, _pbBY0 = 0, _pbBX1 = 0, _pbBY1 = 0;

function _spClip(axis, lt, c) { _pcAx = axis; _pcLt = lt; _pcC = c; }

function _pcut(x0, y0, x1, y1) {
  if (_pcAx === 0) { if (_pcLt) { if (y1 > _pcC) y1 = _pcC; } else if (y0 < _pcC) y0 = _pcC; }
  else if (_pcAx === 1) { if (_pcLt) { if (x1 > _pcC) x1 = _pcC; } else if (x0 < _pcC) x0 = _pcC; }
  _pcX0 = x0; _pcY0 = y0; _pcX1 = x1; _pcY1 = y1;
  return x1 > x0 && y1 > y0;
}

// F2 charred corpse: every colour to one of 4 charcoal steps by luminance
function _spCharC(c) {
  const l = ((c >> 16) & 0xff) * 3 + ((c >> 8) & 0xff) * 6 + (c & 0xff);
  // charcoal greys with a little blue: the world grade lifts dark R/G (reads olive otherwise)
  return l > 1500 ? 0x48465c : l > 900 ? 0x302e42 : l > 500 ? 0x1e1c2e : 0x10101c;
}

// Flush buffer into Graphics g (local coords). mode: 0 normal, 1 white flash, 2 mono, 3 charred
function _pflush(g, olColor, mode, skipOutline, monoColor) {
  const A = ART, n = _pbN;
  let bx0 = 32767, by0 = 32767, bx1 = -32767, by1 = -32767;
  if (mode === 2 || !skipOutline) {
    let any = false;
    for (let i = 0; i < n; i++) {
      if (!_pbO[i]) continue;
      if (!_pcut(_pbX[i] - 1, _pbY[i] - 1, _pbX[i] + _pbW[i] + 1, _pbY[i] + _pbH[i] + 1)) continue;
      g.rect(_pcX0 * A, _pcY0 * A, (_pcX1 - _pcX0) * A, (_pcY1 - _pcY0) * A);
      if (_pcX0 < bx0) bx0 = _pcX0;
      if (_pcY0 < by0) by0 = _pcY0;
      if (_pcX1 > bx1) bx1 = _pcX1;
      if (_pcY1 > by1) by1 = _pcY1;
      any = true;
    }
    if (any) g.fill(mode === 2 ? monoColor : olColor);
  }
  if (mode !== 2) {
    let cur = -1;
    for (let i = 0; i < n; i++) {
      if (!_pcut(_pbX[i], _pbY[i], _pbX[i] + _pbW[i], _pbY[i] + _pbH[i])) continue;
      const c = mode === 1 ? 0xffffff : mode === 3 ? _spCharC(_pbC[i]) : _pbC[i];
      if (c !== cur) { if (cur !== -1) g.fill(cur); cur = c; }
      g.rect(_pcX0 * A, _pcY0 * A, (_pcX1 - _pcX0) * A, (_pcY1 - _pcY0) * A);
      if (_pcX0 < bx0) bx0 = _pcX0;
      if (_pcY0 < by0) by0 = _pcY0;
      if (_pcX1 > bx1) bx1 = _pcX1;
      if (_pcY1 > by1) by1 = _pcY1;
    }
    if (cur !== -1) g.fill(cur);
  }
  _pbBX0 = bx0; _pbBY0 = by0; _pbBX1 = bx1; _pbBY1 = by1;
  _pcAx = -1; // one-shot
}

// Keep what the flush draws above screen row wy (world-screen) for a
// Graphics with position / pivot / quarter-turn rotation already set.
function _spClipFor(g, wy) {
  const r = g.rotation, c = Math.round(Math.cos(r)), sn = Math.round(Math.sin(r));
  const T = (wy - g.y) / ART, px = g.pivot.x / ART, py = g.pivot.y / ART;
  if (c === 1) _spClip(0, true, Math.round(T + py));
  else if (c === -1) _spClip(0, false, Math.round(py - T));
  else if (sn === 1) _spClip(1, true, Math.round(T + px));
  else _spClip(1, false, Math.round(px - T));
}

// Store the last flush's bounds on g (spDrawnBounds)
function _spKeepBounds(g, waterY) {
  g._bx0 = _pbBX0; g._by0 = _pbBY0; g._bx1 = _pbBX1; g._by1 = _pbBY1;
  g._waterY = waterY;
}

// W4: the buffer's silhouette (outlines included) as one fill with style st
// (a dither pattern), honouring the one-shot clip
function _pflushPat(g, st) {
  const A = ART;
  let any = false;
  for (let i = 0; i < _pbN; i++) {
    const o = _pbO[i];
    if (!_pcut(_pbX[i] - o, _pbY[i] - o, _pbX[i] + _pbW[i] + o, _pbY[i] + _pbH[i] + o)) continue;
    g.rect(_pcX0 * A, _pcY0 * A, (_pcX1 - _pcX0) * A, (_pcY1 - _pcY0) * A);
    any = true;
  }
  if (any) g.fill(st);
  _pcAx = -1;
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
  flail: -1,                           // F2 panic: 0..3 arms-up flail frame, -1 off (no gun)
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

// F2 flail: hand offsets (unscaled art px from the shoulder) per frame
const _spFlailB = [-3, -5, -1, -6, -4, -3, -2, -6];
const _spFlailF = [2, -6, 4, -3, 1, -6, 3, -5];

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
  const flail = (!dead && !curl) ? P.flail : -1;
  const armed = gl > 0 && !curl && flail < 0;
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
  } else if (flail >= 0) {
    _spFlailArm(Math.round((-hw + 1) * s), shY, _spFlailB, flail, s, at, sleeveS, SP_SKIN_S, bigFists);
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

  // F1 flamethrower: twin fuel tanks on the back (behind the torso)
  const tanks = isPlayer && !curl && !dead && P.weapon === 7;
  if (tanks && !away) _spFuelTanks(Math.round(-hw * s) - 2, Math.round(-11 * s) + bob);

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
  if (tanks && away) { _spFuelTanks(-2, tY0); _spFuelTanks(0, tY0); }

  // 5. head
  const hX0 = Math.round(-2 * s) + hox, hX1 = Math.round(2 * s) + hox;
  const hY0 = Math.round(-15 * s) + hb, hY1 = Math.round(-11 * s) + hb;
  _pr(hX0, hY0, hX1 - hX0, hY1 - hY0, SP_SKIN, 1);
  _pr(hX0, hY0, px1, hY1 - hY0, SP_SKIN_S, 0);
  _spHead(k, s, hox, hb, front, away, dead);
  if (flail >= 0 && !away) { // screaming mouth
    _pr(Math.round((front ? 0 : 1) * s) + hox, Math.round(-12 * s) + hb, px1, px1, 0x3a0808, 0);
  }

  // 6. front arm + gun, or bare front arm
  if (armed && !away) {
    _spGun(Hx, Hy, Ex, Ey, GT, gc, tip, gdx, gdy, k);
    _pline(Math.round((hw - 1) * s), shY, Hx, Hy, at, sleeve, 1);
    if (k === SP_K_MEDIC) _pr(Math.round((hw - 1) * s), shY, at, px1, 0xf0f0f0, 0);
    _pr(Hx, Hy, at, at, isPlayer ? 0x1a1a1a : SP_SKIN, 0);
  } else if (armed && away) {
    // gun arm already drawn behind
  } else if (flail >= 0) {
    _spFlailArm(Math.round((hw - 1) * s), shY, _spFlailF, flail, s, at, sleeve, SP_SKIN, bigFists);
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

// F2 flail: an arm thrown up from the shoulder (sx, sy) to frame f's hand
function _spFlailArm(sx, sy, tab, f, s, at, c, skin, bigFists) {
  const hx = sx + Math.round(tab[f * 2] * s), hy = sy + Math.round(tab[f * 2 + 1] * s);
  _pline(sx, sy, hx, hy, at, c, 1);
  const fs = bigFists ? Math.max(2, Math.round(2 * s)) : at;
  _pr(hx - (fs >> 1), hy - fs + 1, fs, fs, skin, 1);
}

// F1: a 2 px wide red fuel tank, top-left (x, y) in scaled art px
function _spFuelTanks(x, y) {
  _pr(x, y, 2, 6, 0x8a2a18, 1);
  _pr(x, y + 1, 1, 4, 0xc04a2a, 0);   // lit side
  _pr(x, y, 2, 1, 0x8a8a90, 0);       // steel cap
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
  // F1 flamethrower: fuel canister under the grip, steel nozzle, pilot flame
  if (k === SP_K_PLAYER && P.weapon === 7) {
    const cx = Hx + Math.round(gdx * 2) - 1, cy = Hy + Math.round(gdy * 2) + o + 1;
    _pr(cx, cy, 3, 2, 0x8a2a18, 1);
    _pr(cx, cy, 2, 1, 0xc04a2a, 0);
    _pr(Ex - o, Ey - o, T, T, 0x9a9aa0, 0);
    const fx = Ex + Math.round(gdx * 1.5), fy = Ey + Math.round(gdy * 1.5) - 1;
    _pr(fx, fy, 1, 1, P.glowTip ? 0xffe040 : 0xff8a10, 0);
    if (P.glowTip) _pr(fx, fy - 1, 1, 1, 0xd02810, 0);
  }
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
  _spRenderWaterBlood();
  _spRenderBloodClouds();
  _spRenderEnvLayer();
  const t1 = performance.now();
  _spRenderEnv();
  _spRenderBodies();
  const t2 = performance.now();
  _spRenderPlayer();
  _spRenderEnemies();
  const t3 = performance.now();
  _spRenderPickups();
  _spRenderBullets();
  _spRenderGrenades();
  const t4 = performance.now();
  _spRenderParticles();
  _spRenderFire();       // M9 F1: stream + ground fires
  _spRenderShells();
  _spRenderGibs();
  _spRenderDebris();
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
// WADING (M9 W2): crop below the waterline, ripple ring, V wake
// =====================================================================
// Top of each kind's hat / hair at size 1 (unscaled art px, before the
// outline); the drawn dry body spans round(top x s) - 1 .. +1 rows.
const _spHatTop = new Int8Array([-16, -15, -16, -17, -15, -15, -16, -16, -17, -16, -16, -16, -16]);

// Wading crop: 0 when dry, else cut >= 1 and the puppet keeps the art rows
// above row 1 - cut (feet line = row 0; cut 1 hides only the outline under
// the boots, so the waterline steps one art px at a time from the first
// frame). Hidden rows = the logic waterline (entityWaterlineH, shared with
// G13 picking) rounded up to whole art px, and never less than the same
// fraction of the actually drawn dry body (hats / big sizes run a row or
// two over ENEMY_PICK_H x size).
function _spWadeCut(ent, k, s) {
  const sub = ent.submerge || 0;
  if (!(sub > 0) || typeof entityWaterlineH !== 'function') return 0;
  const wl = entityWaterlineH(ent), dh = entityDrawnH(ent);
  if (wl < ART * 0.5) return 1;
  const rows = 2 - Math.round(_spHatTop[k] * s);
  const a = Math.ceil(wl / ART - 1e-6);
  const b = dh > 0 ? Math.ceil(wl / dh * rows - 1 - 1e-6) : 0;
  return 1 + Math.max(1, a, b);
}

// Ring rows: 1-art-px ellipse outline (connected), cx/cy screen, rx/ry art px
function _spRingRows(g, cx, cy, rx, ry) {
  const A = ART, inv = 1 / (ry + 0.5);
  for (let j = -ry; j <= ry; j++) {
    const t = j * inv;
    const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - t * t)));
    if (j === -ry || j === ry) { g.rect(cx - w * A, cy + j * A, (2 * w + 1) * A, A); continue; }
    const tn = (j + (j < 0 ? -1 : 1)) * inv; // neighbour row toward the nearer pole
    const wn = Math.round(rx * Math.sqrt(Math.max(0, 1 - tn * tn)));
    const inner = Math.min(w, wn + 1), len = w - inner + 1;
    g.rect(cx - w * A, cy + j * A, len * A, A);
    g.rect(cx + inner * A, cy + j * A, len * A, A);
  }
}

const SP_WAKE_N = 6;
const _spWakeA = [1, 0.7, 0.45]; // stepped alpha bands (near -> far)

// Ripple ring at the waterline + V wake behind movers, into the ground layer
// (flat on the water, under every body, so the body hides the ring's back arc)
function _spWade(ent, X, waterY, cut, s, hw) {
  const g = _sp.groundG, A = ART;
  if (ent._spWph === undefined) ent._spWph = (_sp.wadeSeq++ * 7) % 3;
  // ripple: 3 frames expanding outward, stepped alpha
  const f = (((gameTime * 6) | 0) + ent._spWph) % 3;
  const rx = Math.round((hw + 2) * s) + f;
  const ry = Math.max(1, Math.round(rx * 0.42));
  _spRingRows(g, X, waterY, rx, ry);
  g.fill({ color: 0xd8f0ff, alpha: f === 0 ? 0.9 : f === 1 ? 0.65 : 0.4 });
  // wake: pixels fixed on the water (phase from walkDist), fading with distance
  const vx = ent.vx || 0, vy = ent.vy || 0, v2 = vx * vx + vy * vy;
  if (!ent.walking || v2 < 64 || ent.dodging) return;
  const inv = 1 / Math.sqrt(v2), ux = vx * inv, uy = vy * inv;
  const step = 6 * Math.max(1, s), d0 = rx * A * 0.45;
  const ph = (ent.walkDist || 0) % step, iso = CFG.ISO_SCALE, lift = (cut - 1) * A;
  for (let band = 0; band < 3; band++) {
    let any = false;
    for (let i = 0; i < SP_WAKE_N; i++) {
      if ((i < 2 ? 0 : i < 4 ? 1 : 2) !== band) continue;
      const d = d0 + i * step + ph, lat = d * 0.5;
      for (let side = -1; side <= 1; side += 2) {
        const wx = ent.x - ux * d - uy * lat * side, wy = ent.y - uy * d + ux * lat * side;
        if (typeof waterTileAt === 'function' && !waterTileAt(wx, wy)) continue;
        const px = _spSnap(wx - wy), py = _spSnap((wx + wy) * iso) - lift;
        g.rect(px, py, (i < 2 ? 2 : 1) * A, A);
        any = true;
      }
    }
    if (any) g.fill({ color: 0xe8f8ff, alpha: _spWakeA[band] });
  }
}

/**
 * Test hook (W2): what is drawn for ent (player or enemy) this frame, in
 * world-screen units (worldContainer space, as toScreen): the visible
 * puppet's top-left x / y, w, h (outline included; ground shadow, shield
 * bubble and ripples excluded), and waterY = the drawn waterline's screen y
 * while ent.submerge > 0, else null. null when ent is not drawn.
 */
function spDrawnBounds(ent) {
  if (!ent) return null;
  const g = ent === player ? _sp.playerG : ent._spG;
  if (!g || !g.visible || g.destroyed || !(g._bx1 > g._bx0)) return null;
  if (ent !== player && g._owner !== ent) return null;
  const A = ART, r = g.rotation, c = Math.round(Math.cos(r)), sn = Math.round(Math.sin(r));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 4; i++) {
    const qx = ((i & 1) ? g._bx1 : g._bx0) * A - g.pivot.x;
    const qy = ((i & 2) ? g._by1 : g._by0) * A - g.pivot.y;
    const X = g.x + c * qx - sn * qy, Y = g.y + sn * qx + c * qy;
    if (X < x0) x0 = X;
    if (X > x1) x1 = X;
    if (Y < y0) y0 = Y;
    if (Y > y1) y1 = Y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, waterY: (ent.submerge || 0) > 0 ? g._waterY : null };
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
  P.headBob = 0; P.recoil = 0; P.gunOverride = false; P.spin = -1; P.flail = -1;
  P.tail = ((gameTime * (p.walking ? 9 : 4)) | 0) & 1;
  P.glowTip = ((gameTime * 8) | 0) & 1;
  const wep = WEAPONS[P.weapon] || WEAPONS[0];
  if (wep.spinUp && p.spinUp > 0) P.spin = (gameTime * (8 + p.spinUp * 30)) | 0;

  // W2: wading crop (art px rows hidden above the feet); no shadow in water
  const cut = _spWadeCut(p, SP_K_PLAYER, 1);
  const waterY = Y - (cut - 1) * ART;
  if (cut) _spWade(p, X, waterY, cut, 1, _spTW[SP_K_PLAYER] >> 1);
  else {
    const sg = _sp.groundG;
    _spEllRows(sg, X, Y, 4, 1, 0, false);
    sg.fill({ color: 0x000000, alpha: 0.3 });
  }

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
    if (cut) _spClipFor(g, waterY);
    _pflush(g, SP_OUTLINE, 0, false, 0);
    _spKeepBounds(g, waterY);
    // after-image one frame behind
    const dl = Math.sqrt(dsx * dsx + dsy * dsy) || 1;
    gh.visible = true;
    _spResetGfx(gh, g.zIndex - 0.01);
    gh.pivot.set(0, piv);
    gh.position.set(X - _spSnap(dsx / dl * 15), Y + piv - _spSnap(dsy / dl * 15) - ART);
    gh.rotation = (f - 1) * (Math.PI / 2) * dir;
    gh.alpha = 0.35;
    if (cut) _spClipFor(gh, waterY - _spSnap(dsy / dl * 15));
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
  if (cut) P.bob = 0; // wading: the body holds still, the ripples move
  _spBuildPuppet();
  g.position.set(X, Y);
  const flash = p.hitFlash > 0 && (((p.hitFlash * 30) | 0) & 1);
  if (cut) _spClip(0, true, 1 - cut);
  _pflush(g, SP_OUTLINE, flash ? 1 : 0, false, 0);
  _spKeepBounds(g, waterY);
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
    // W2: wading crop; the body holds still in water (no bob)
    const cut = _spWadeCut(e, k, s);
    if (cut) bob = 0;
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
    // F2: a panicking (burning, non-boss) enemy flails, facing where it runs
    let flail = -1, fdir = 0;
    if (e.burnT > 0 && !e.isBoss && e.panicT > 0) {
      if (e._spFl === undefined) e._spFl = (_sp.wadeSeq++ * 5) & 3;
      flail = (((gameTime * 10) | 0) + e._spFl) & 3;
      fdir = ((e.vx || 0) - (e.vy || 0)) < 0 ? 1 : 0;
    }
    const key = (walkF + 1) + 5 * (bob + 2 * (aq + 16 * (flash + 2 * (recoil + 2 * (attack + 3 * (blink + 3 * (glow + 2 * (shield + 3 * (spin + 2 * (visor + 2 * tail)))))))))) +
      276480 * (cut + 128 * (flail + 1 + 5 * fdir));

    if (g._key !== key) {
      g._key = key;
      g.clear();
      const P = _P;
      P.kind = k; P.s = s; P.aim = aq * (Math.PI / 8); P.flip = 0;
      P.walkF = walkF; P.bob = -bob; P.headBob = 0;
      P.recoil = recoil; P.attack = attack; P.dead = false; P.curl = false;
      P.gunOverride = false; P.spin = k === SP_K_JUGG ? spin : -1;
      P.blink = blink; P.visor = visor; P.tail = tail; P.glowTip = 0;
      P.flail = flail;
      if (flail >= 0) P.flip = fdir ? -1 : 1;
      _spBuildPuppet();
      // shadow inside the cached graphics (hidden while wading)
      if (!cut) {
        _spEllRows(g, 0, 0, Math.round(4 * s), Math.max(1, Math.round(1.3 * s)), 0, false);
        g.fill({ color: 0x000000, alpha: 0.28 });
      }
      const ol = glow ? SP_OUTLINE_HEAL : e.isBoss ? SP_OUTLINE_BOSS : SP_OUTLINE;
      if (cut) _spClip(0, true, 1 - cut);
      _pflush(g, ol, flash ? 1 : 0, false, 0);
      _spKeepBounds(g, 0);
      if (shield) _spShieldBubble(g, s, shield, cut);
      g._muzX = _PO.muzX; g._muzY = _PO.muzY; g._hasMuz = _PO.hasMuz;
      g._scopeX = _PO.scopeX; g._scopeY = _PO.scopeY; g._top = _PO.top;
    }
    // A5 berserker shakes while charging the player
    let jit = 0;
    if (k === SP_K_BERSERKER && e.walking && d < 250) jit = (((gameTime * 30) | 0) & 1) ? ART : -ART;
    const X = _spSnap(sx), Y = _spSnap(sy);
    g.position.set(X + jit, Y);
    g.zIndex = depthKey(e.x, e.y);
    g._waterY = Y - (cut - 1) * ART;
    if (cut) _spWade(e, X, g._waterY, cut, s, _spTW[k] >> 1);
    if (e.burnT > 0 && !e.dead) _spBurnFx(e, X + jit, Y, s, g._top, g.zIndex);
  }
}

function _spShieldBubble(g, s, step, cut) {
  const A = ART;
  const rx = Math.round(6 * s) + 1, ry = Math.round(9 * s) + 1;
  const cy = Math.round(-7.5 * s) * A;
  const inv = 1 / (ry + 0.5);
  const lim = cut ? (1 - cut) * A : 1e9; // W2: nothing below the waterline
  // interior (stepped low alpha)
  for (let j = -ry + 1; j <= ry - 1; j++) {
    if (cy + (j + 1) * A > lim) break;
    const t = j * inv;
    const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - t * t)));
    if (w > 1) g.rect((-w + 1) * A, cy + j * A, (2 * w - 1) * A, A);
  }
  g.fill({ color: 0x5090ff, alpha: step === 1 ? 0.16 : 0.24 });
  // rim pixels
  for (let j = -ry; j <= ry; j++) {
    if (cy + (j + 1) * A > lim) break;
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
    g.rotation = m * Q;
    g.alpha = alpha;
    g.position.set(_spSnap(sx), _spSnap(sy - z));
    g.zIndex = depthKey(b.x, b.y) - 1;
    // W4: in water. Never baked anywhere: corpses are live Graphics, and the
    // logic blocks their blood decals on water.
    if (b.inWater) { _spBodyInWater(b, g, m); continue; }
    const fading = astep > 0 ? 1 : 0;
    if (g._key !== fading) {
      g._key = fading;
      g.clear();
      _spBodyPuppet(b);
      _pflush(g, b.isBoss ? SP_OUTLINE_BOSS : SP_OUTLINE, b.charred ? 3 : 0, fading === 1, 0);
      if (b.charred === true) _spCharCracks(g);
    }
    if (b.charred === true && age < SP_CHAR_SMOKE_S) _spCharSmoke(b, g, m, age);
  }
}

// F2: a few dull glowing cracks in the charcoal (static, cached with the corpse)
function _spCharCracks(g) {
  const A = ART;
  let any = false;
  for (let k = 0; k < 3 && _pbN > 0; k++) {
    const i = _spHash(_pbN * 31 + _pbX[0], k) % _pbN;
    if (_pbW[i] < 1 || _pbH[i] < 1) continue;
    const x = _pbX[i] + (_pbW[i] >> 1), y = _pbY[i] + (_pbH[i] >> 1);
    g.rect(x * A, y * A, A, A);
    any = true;
  }
  if (any) g.fill(SP_CHAR_CRACK);
}
const SP_CHAR_CRACK = 0x7a2410;

// F2: smoke pixels rising off a charred corpse in stepped hops (and a
// blinking ember early on); the corpse lies along screen x (m 2: head +x)
const SP_CHAR_SMOKE_S = 9;
function _spCharSmoke(b, g, m, age) {
  const A = ART, s = b.size || 1;
  const z = g.zIndex + 0.5;
  const dir = m === 6 ? -1 : 1;
  const n = age < 4 ? 3 : 2;
  for (let k = 0; k < n; k++) {
    const ph = age * 1.6 + k * 0.37, cyc = ph | 0, r = ph - cyc;
    const h = _spHash(cyc * 3 + k, (b.x | 0) & 1023);
    const bx = g.x + dir * Math.round((2 + (h % 10)) * s) * A;
    const by = g.y - A - ((r * 6) | 0) * A;
    const c = r < 0.4 ? 0x666666 : r < 0.75 ? 0x4a4a4a : 0x333333;
    _spRectSprite(_spSnap(bx), _spSnap(by), A, A, c, z);
  }
  if (age < 4 && (((age * 5) | 0) & 1)) {
    const h = _spHash((b.x | 0) & 1023, 7);
    _spRectSprite(_spSnap(g.x + dir * Math.round((3 + (h % 8)) * s) * A), _spSnap(g.y - A), A, A, 0xd04010, z);
  }
}

// Dead-pose puppet of corpse b into the command buffer
function _spBodyPuppet(b) {
  const P = _P;
  P.kind = b.type !== undefined ? _spTypeKind[b.type] : 0; P.s = b.size || 1; P.aim = 0.6;
  P.flip = (b.flip || 1) < 0 ? -1 : 1;
  P.walkF = -1; P.bob = 0; P.headBob = 0; P.recoil = 0; P.attack = 0;
  P.dead = true; P.curl = false; P.gunOverride = false; P.spin = -1;
  P.blink = 0; P.visor = 0; P.tail = 0; P.glowTip = 0; P.flail = -1;
  _spBuildPuppet();
}

// W4 corpse in water: lying (rotation m = 2 or 6, quarter turns), local x is
// screen-vertical. The waterline rises from the bottom in whole art rows:
// floating it hides SP_FLOAT_HIDE of the body, sinking rises to all of it.
// Below the waterline the body shows as a dithered murky silhouette, which
// the dissolve thins out in 4 steps. Rebuilt only when the row / step changes.
const SP_FLOAT_HIDE = 0.4;
const SP_SUB_COL = 0x2e141c;            // the drowned body seen through the water
const SP_SUB_DENS = [8, 6, 4, 2, 1];    // 16ths: sinking, then dissolve steps 0..3
function _spBodyInWater(b, g, m) {
  if (b._spWX0 === undefined) {
    _spBodyPuppet(b);
    let x0 = 32767, x1 = -32767, y0 = 32767, y1 = -32767;
    for (let i = 0; i < _pbN; i++) {
      const o = _pbO[i];
      if (_pbX[i] - o < x0) x0 = _pbX[i] - o;
      if (_pbX[i] + _pbW[i] + o > x1) x1 = _pbX[i] + _pbW[i] + o;
      if (_pbY[i] - o < y0) y0 = _pbY[i] - o;
      if (_pbY[i] + _pbH[i] + o > y1) y1 = _pbY[i] + _pbH[i] + o;
    }
    b._spWX0 = x0; b._spWX1 = x1; b._spWY0 = y0; b._spWY1 = y1;
    g._key = -1;
  }
  const lo = b._spWX0, hi = b._spWX1, rows = hi - lo;
  const ph = b.sinkPhase;
  const f = ph === 'float' ? SP_FLOAT_HIDE : ph === 'sink' ? SP_FLOAT_HIDE + (1 - SP_FLOAT_HIDE) * (b.sinkFrac || 0) : 1;
  const hidden = Math.min(rows, Math.round(f * rows));
  const dstep = ph === 'dissolve' ? 1 + Math.min(4, ((b.dissolve || 0) * 4) | 0) : 0;
  if (dstep > 4) { g.visible = false; return; }
  const down = m !== 6; // m 2: screen y grows with local x (bottom = hi); m 6: bottom = lo
  const cut = down ? hi - hidden : lo + hidden;
  const key = 1000 + hidden * 8 + dstep;
  if (g._key !== key) {
    g._key = key;
    g.clear();
    _spBodyPuppet(b);
    if (hidden > 0) { _spClip(1, !down, cut); _pflushPat(g, _spPat(SP_SUB_DENS[dstep], SP_SUB_COL)); }
    if (hidden < rows) { _spClip(1, down, cut); _pflush(g, b.isBoss ? SP_OUTLINE_BOSS : SP_OUTLINE, b.charred ? 3 : 0, false, 0); }
  }
  // ripple ring where the body cuts the surface (ground layer, under it)
  if (hidden < rows && dstep === 0) {
    const A = ART, wy = g.y + (down ? cut : -cut) * A;
    const mid = (b._spWY0 + b._spWY1) * 0.5 * A;
    const X = _spSnap(down ? g.x - mid : g.x + mid);
    const fr = ((gameTime * 5) | 0) % 3;
    const rx = Math.round((b._spWY1 - b._spWY0) * 0.5) + 1 + fr;
    const gg = _sp.groundG;
    _spRingRows(gg, X, wy, rx, Math.max(1, Math.round(rx * 0.3)));
    gg.fill({ color: 0xd8f0ff, alpha: fr === 0 ? 0.75 : fr === 1 ? 0.5 : 0.3 });
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
    if (pk.type === 'grenade') {
      // N1: baked 9x10 pineapple grenade, same bob / blink / shadow as the others
      const s = _spSprite(_sp.texGrenadePk, X - 4 * A, Y - 9 * A + bob, depthKey(pk.x, pk.y));
      s.anchor.set(0, 0);
      s.scale.set(A, A);
      s.tint = 0xffffff;
      continue;
    }
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
// GRENADES (N1): pooled 3-frame spinning sprite, stepped ground shadow,
// red fuse pixel blinking at 8 Hz in the last 0.6 s, sink + bubbles in water
// =====================================================================
const SP_GREN_BLINK = 0.6;
function _spRenderGrenades() {
  if (typeof grenades === 'undefined' || grenades.length === 0) return;
  const iso = CFG.ISO_SCALE, A = ART, sg = _sp.groundG;
  let shadows = 0;
  for (let i = 0; i < grenades.length; i++) {
    const gr = grenades[i];
    const sx = gr.x - gr.y, gy = (gr.x + gr.y) * iso;
    if (!_spInView(sx, gy)) continue;
    const X = _spSnap(sx), GY = _spSnap(gy);
    const zz = depthKey(gr.x, gr.y);
    if (gr.inWater) { _spGrenadeSink(gr, X, GY, zz); continue; }
    const z = gr.z > 0 ? gr.z : 0;
    // Shadow: 3/5/3 pixel ellipse on the ground point, a 3x2 blob once high up
    if (z < 40) {
      sg.rect(X - A, GY - A, 3 * A, A);
      sg.rect(X - 2 * A, GY, 5 * A, A);
      sg.rect(X - A, GY + A, 3 * A, A);
    } else {
      sg.rect(X - A, GY - A, 3 * A, 2 * A);
    }
    shadows++;
    // Body: frame = quarter turn of the spin (frame 3 is frame 1 mirrored)
    const f = ((gr.spin / (Math.PI / 2)) | 0) & 3;
    const fm = _spGrenadeFrm[f];
    const x0 = X - (fm[0] >> 1) * A, y0 = _spSnap(gy - z) - fm[1] * A;
    const s = _spSprite(_sp.texGrenade[f], x0, y0, zz);
    s.anchor.set(0, 0);
    s.scale.set(A, A);
    s.tint = 0xffffff;
    if (gr.t > gr.fuse - SP_GREN_BLINK && (((gr.t * 16) | 0) & 1) === 0) {
      _spRectSprite(x0 + fm[2] * A, y0 + fm[3] * A, A, A, 0xff2010, zz + 0.001);
    }
  }
  if (shadows) sg.fill({ color: 0, alpha: 0.5 }); // small: needs more weight than 0.35 to read on grass
}

// Landed in water: drops out of sight over 0.3 s (cropped top rows), a foam
// pixel either side at the waterline, then a stepped bubble trail until the fuse
function _spGrenadeSink(gr, X, GY, zz) {
  const A = ART, st = gr.sinkT;
  if (st < 0.2) {
    const tex = _sp.texGrenadeSink[st < 0.1 ? 0 : 1];
    const h = st < 0.1 ? 4 : 2;
    const s = _spSprite(tex, X - 2 * A, GY - h * A, zz);
    s.anchor.set(0, 0);
    s.scale.set(A, A);
    s.tint = 0xffffff;
  }
  if (st < 0.3) {
    const o = st < 0.15 ? 3 : 4;
    _spRectSprite(X - o * A, GY - A, A, A, 0xe8f4ff, zz + 0.001);
    _spRectSprite(X + (o + 1) * A, GY - A, A, A, 0xe8f4ff, zz + 0.001);
    return;
  }
  // Two bubbles rising 4 px in stepped hops, offset half a cycle
  for (let k = 0; k < 2; k++) {
    const ph = st * 3 + k * 0.5, cyc = ph | 0, r = ph - cyc;
    const bx = X + (((_spHash(cyc, k) & 3) - 1) * A);
    const by = GY - ((r * 4) | 0) * A;
    _spRectSprite(bx, by, A, A, r < 0.75 ? 0xd8f0ff : 0x9cc8e8, zz + 0.001);
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
      // flashes snap to the drawn gun tip of whoever fired
      const og = p.owner && p.owner._spG;
      if (og && og._hasMuz && og.visible) {
        mx = _spSnap(og.x + og._muzX * A); my = _spSnap(og.y + og._muzY * A);
      } else if (!p.owner && _sp.pTipValid) {
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
    } else if (type === 'leaf') {
      // M8 E2: 1-art-px leaf, stepped flutter, blinks out at the end (no fade)
      if (lr < 0.15 && ((((gameTime * 14) | 0) + i) & 1)) continue;
      const wob = Math.round(Math.sin(p.life * 7 + i * 1.7) * 1.2) * A;
      const s = _spSprite(tw, X + wob, Y, z);
      s.scale.set(A, A); s.tint = col;
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
// FIRE (M9 F1-F3): flame stream, ground fires, burning enemies / trees.
// Pooled sprites only (baked tongue textures + white blob masks tinted in
// J1 bands), frame-stepped colour / size / position, no filters or masks.
// =====================================================================
const SP_FL_GAP = 0.05;       // s between flames (flamethrower rate): each flame fills the gap back to its predecessor
const SP_SMOKE_A = [1, 0.85, 0.7, 0.55, 0.4];

// Tongue: bottom centre at (x, y) screen, heat 0 hot / 1 mid / 2 dying, size 0 (5x8) / 1 (7x11)
function _spTongue(x, y, heat, size, frame, flip, z) {
  const A = ART;
  const tex = _sp.texTongue[heat][size][frame];
  const w = size ? 7 : 5, h = size ? 11 : 8;
  const s = _spSprite(tex, flip ? x + (w - (w >> 1)) * A : x - (w >> 1) * A, y - h * A, z);
  s.anchor.set(0, 0);
  s.scale.set(flip ? -A : A, A);
  s.tint = 0xffffff;
  return s;
}

// Blob mask of n x n art px centred on (cx, cy) screen, tinted
function _spBlob(cx, cy, n, v, color, alpha, z) {
  const A = ART;
  if (n < 1) n = 1; else if (n > SP_BLOB_MAX) n = SP_BLOB_MAX;
  const s = _spSprite(_sp.texBlob[n - 1][v & 1], _spSnap(cx) - (n >> 1) * A, _spSnap(cy) - (n >> 1) * A, z);
  s.anchor.set(0, 0);
  s.scale.set(A, A);
  s.tint = color;
  s.alpha = alpha;
  return s;
}

function _spFlSize(r) { return r < 0.05 ? 2 : Math.min(SP_BLOB_MAX, 3 + Math.round(r * 8)); }

function _spFlBand(r) {
  return r < SP_FL_BAND_T[0] ? 0 : r < SP_FL_BAND_T[1] ? 1 : r < SP_FL_BAND_T[2] ? 2 : r < SP_FL_BAND_T[3] ? 3 : 4;
}

// F1 stream: each flame is drawn as a short run of blobs back along its
// path to where the previous flame was (no dotted stream at 20 flames/s);
// blobs grow as they slow, lick sideways / up in stepped jumps, rise as
// they cool, and step through the J1 bands white-yellow -> orange -> red ->
// smoke by t / life.
function _spRenderFlames() {
  if (typeof flames === 'undefined' || flames.length === 0) return;
  const iso = CFG.ISO_SCALE, A = ART;
  const step = (gameTime * 15) | 0;
  for (let i = 0; i < flames.length; i++) {
    const f = flames[i];
    const L = f.life > 0 ? f.life : 0.45, t = f.t;
    const v0 = f.v0 > 0 ? f.v0 : 2 * CFG.FLAME_RANGE / L;
    const t0 = t > SP_FL_GAP ? t - SP_FL_GAP : 0;
    const span = v0 * ((t - t0) - (t * t - t0 * t0) / (2 * L));
    // blobs ~0.75 of their size apart on screen (a continuous jet at the nozzle)
    const n = Math.min(10, Math.max(1, Math.round(span * 1.41 / (Math.max(2, _spFlSize(t / L) * 0.6) * A))));
    const hx = f.x - f.y, hy = (f.x + f.y) * iso;
    if (!_spInView(hx, hy)) continue;
    const dx = f.dirX, dy = f.dirY;
    const nk = t > SP_FL_GAP ? n : n + 1; // the first flame runs back to the nozzle
    for (let k = 0; k < nk; k++) {
      const back = span * k / n;
      const tk = t - (t - t0) * k / n;
      const r = tk / L;
      const h = _spHash(f.seed + k * 7919, step + k);
      // lick: stepped sideways jitter that widens down the stream
      const j = ((h % 3) - 1) * (1.5 + r * 8);
      const wx = f.x - dx * back - dy * j, wy = f.y - dy * back + dx * j;
      const zz = (f.z || 12) + r * r * 26 + (r > 0.3 && ((h >> 3) & 1) ? A : 0);
      const sx = wx - wy, sy = (wx + wy) * iso - zz;
      const b = _spFlBand(r);
      const z = depthKey(wx, wy);
      const v = (h >> 4) & 1;
      if (b === 4) {
        _spBlob(sx, sy, Math.min(SP_BLOB_MAX, 6 + Math.round((r - 0.68) * 10)), v, SP_FL_OUT[4], r < 0.84 ? 0.9 : 0.6, z);
        continue;
      }
      const bs = _spFlSize(r);
      _spBlob(sx, sy, bs, v, SP_FL_OUT[b], 1, z);
      const cs = bs - (b < 2 ? 2 : 3);
      if (cs >= 1) _spBlob(sx, sy, cs, v ^ 1, SP_FL_CORE[b], 1, z + 0.001);
      // ragged licking edge: a darker side tongue flicking out of the cone
      if (r > 0.25 && ((h >> 6) & 1)) {
        const lj = ((h >> 7) & 1 ? 1 : -1) * (3 + r * 12);
        const lx = wx - dy * lj, ly = wy + dx * lj;
        _spBlob(lx - ly, (lx + ly) * iso - zz - A, bs - 2, v ^ 1, SP_FL_OUT[b + 1], b + 1 === 4 ? 0.9 : 1, z - 0.001);
      }
    }
  }
}

// F1 ground fires: 1-3 flickering tongues (3 frames), dying down in steps
function _spRenderGroundFires() {
  if (typeof groundFires === 'undefined' || groundFires.length === 0) return;
  const iso = CFG.ISO_SCALE, A = ART;
  const fr = (gameTime * 12) | 0;
  for (let i = 0; i < groundFires.length; i++) {
    const gf = groundFires[i];
    const sx = gf.x - gf.y, sy = (gf.x + gf.y) * iso;
    if (!_spInView(sx, sy)) continue;
    const p = gf.life > 0 ? gf.t / gf.life : 1;
    const stage = p < 0.5 ? 0 : p < 0.8 ? 1 : 2;
    const X = _spSnap(sx), Y = _spSnap(sy), z = depthKey(gf.x, gf.y);
    const nT = 3 - stage;
    for (let k = 0; k < nT; k++) {
      const h = _spHash(gf.seed, k);
      const ox = ((h & 7) - 3) * A, oy = (((h >> 3) % 3) - 1) * A;
      _spTongue(X + ox, Y + oy, stage, stage === 0 && k === 0 ? 1 : 0, (fr + k + (gf.seed & 3)) % 3, (h >> 5) & 1, z + oy * 0.001);
    }
  }
}

// F2 burning enemy: flame tongues licking around the body (jumping every
// 0.1 s; more of them early in the burn), ember sparks, and a smoke trail
// of stepped puffs rising off the head and lagging behind the run.
// (X, Y) = drawn feet, top = puppet top (art px, local), z = body zIndex.
function _spBurnFx(e, X, Y, s, top, z) {
  const A = ART, iso = CFG.ISO_SCALE, bt = e.burnT;
  if (e._spBs === undefined) e._spBs = (_sp.wadeSeq++ * 2654435761) >>> 0;
  const seed = e._spBs;
  const big = s >= 1.6;
  const n = (bt > 3 ? 4 : bt > 1.5 ? 3 : 2) + (big ? 1 : 0);
  const heat = bt > 2 ? 0 : 1;
  const hw = (_spTW[_spTypeKind[e.type] | 0] >> 1) + 1;
  const step = (gameTime * 10) | 0;
  const body = Math.max(6, -(top | 0) - 3);
  for (let k = 0; k < n; k++) {
    const h = _spHash(seed + k * 977, step + k * 3);
    const ox = Math.round((((h & 15) / 15) * 2 - 1) * hw * s) * A;
    const oy = -Math.round((3 + ((h >> 4) % 100) / 100 * (body - 4))) * A;
    const size = (big || (k === 0 && bt > 3)) ? 1 : 0;
    _spTongue(X + ox, Y + oy, heat, size, (h >> 8) % 3, (h >> 10) & 1, (k & 1) ? z - 0.3 : z + 0.3);
  }
  const headY = Y + (top | 0) * A;
  // embers
  for (let k = 0; k < 2; k++) {
    const ph = gameTime * 3 + k * 0.5 + (seed & 7) * 0.13, cyc = ph | 0, r = ph - cyc;
    const hh = _spHash(seed + cyc, k);
    const ex = X + ((hh % (2 * hw + 1)) - hw) * A;
    _spRectSprite(ex, _spSnap(headY - r * 10 * A), A, A, r < 0.5 ? 0xffe040 : 0xff8a10, z + 0.35);
  }
  // smoke trail
  const vx = e.vx || 0, vy = e.vy || 0;
  for (let k = 0; k < 3; k++) {
    const ph = gameTime * 2.5 + k / 3, q = ((ph - (ph | 0)) * 4) | 0;
    const back = (q + 1) * 0.07;
    const wx = e.x - vx * back, wy = e.y - vy * back;
    const sx = wx - wy, sy = (wx + wy) * iso + (top | 0) * A - (2 + q * 3) * A;
    _spBlob(sx, sy, Math.round((2 + q) * (big ? 1.5 : 1)), k, q < 2 ? 0x2c2c2c : 0x4a4a4a, SP_SMOKE_A[q], z + 0.4);
  }
}

// F3: a burning tree's stage: 0 catching, 1 full blaze, 2 dying down
function _spTreeFireStage(rec) {
  const ff = rec.fire / (CFG.TREE_BURN_S || 6);
  return ff > 0.85 ? 0 : ff > 0.3 ? 1 : 2;
}

// F3 burning / heating tree overlay (canopy flames, embers, smoke; a smoke
// wisp while the stream heats it). g = the tree sprite, (X, Y) its base.
function _spTreeFireFx(g, obj, rec) {
  const A = ART;
  const X = g.x, Y = g.y, top = g._top || 60;
  if (!_spInView(X, Y - top * 0.5)) return;
  const z = g.zIndex;
  const seed = ((obj.x * 73856093) ^ (obj.y * 19349663)) >>> 0;
  if (!(rec.fire > 0)) {
    // heating (no fire yet): a grey wisp off the trunk, a smoulder near the end
    if (!(rec.heat > 0.2) || rec.charred) return;
    const n = rec.heat > 0.6 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const ph = gameTime * 2 + k * 0.5, cyc = ph | 0, r = ph - cyc;
      const ox = ((_spHash(seed + cyc, k) % 3) - 1) * A;
      _spRectSprite(_spSnap(X + ox), _spSnap(Y - top * 0.3 - r * 8 * A), A, A, r < 0.5 ? 0x8a8480 : 0x5a5654, z + 0.03);
    }
    if (rec.heat > 0.7) _spTongue(_spSnap(X), _spSnap(Y - top * 0.3), 1, 0, ((gameTime * 12) | 0) % 3, 0, z + 0.02);
    return;
  }
  const stage = _spTreeFireStage(rec);
  const w = g.texture.width;
  const pine = obj.type === 'pine';
  const rx = w * (pine ? 0.24 : 0.32), cy = Y - top * 0.62, ry = top * (pine ? 0.3 : 0.25);
  const step = (gameTime * 8) | 0;
  const nBig = stage === 1 ? 5 : stage === 0 ? 1 : 0;
  const nT = nBig + 3;
  for (let k = 0; k < nT; k++) {
    const h = _spHash(seed + k * 131, step + k * 5);
    const v = ((h >> 8) & 255) / 127.5 - 1;
    const u = ((h & 255) / 127.5 - 1) * Math.sqrt(1 - v * v * 0.8) * (pine ? 1 - 0.5 * (-v * 0.5 + 0.5) : 1);
    const tx = _spSnap(X + u * rx), ty = _spSnap(cy + v * ry + (k < nBig ? 11 * A * 0.5 : 0));
    const heat = stage === 2 ? 1 + (k & 1) : k < nBig ? 0 : 1;
    _spTongue(tx, ty, heat, k < nBig ? 1 : 0, (h >> 16) % 3, (h >> 18) & 1, z + 0.02 + k * 0.0001);
  }
  if (stage !== 2) _spTongue(_spSnap(X), _spSnap(Y - top * 0.88), 0, stage, (step + 1) % 3, step & 1, z + 0.021);
  // embers rising above the canopy (stepped, blink out at the top)
  const nE = stage === 1 ? 5 : 3;
  const ra = Math.max(2, Math.round(rx / A));
  for (let k = 0; k < nE; k++) {
    const ph = gameTime * 1.1 + k * 0.21 + (seed & 15) * 0.05, cyc = ph | 0, r = ph - cyc;
    if (r > 0.85 && (((gameTime * 14) | 0) & 1)) continue;
    const hh = _spHash(seed + cyc, k + 40);
    const ex = X + ((hh % (2 * ra + 1)) - ra) * A + ((r * 4) | 0) * A * (hh & 1 ? 1 : -1);
    const ey = Y - top * 0.75 - ((r * 14) | 0) * 2 * A;
    _spRectSprite(_spSnap(ex), _spSnap(ey), A, A, r < 0.3 ? 0xfff0a0 : r < 0.6 ? 0xffb030 : 0xd04010, z + 0.03);
  }
  // smoke column: stepped puffs growing and greying as they rise
  for (let k = 0; k < 3; k++) {
    const ph = gameTime * 0.8 + k / 3, q = ((ph - (ph | 0)) * 5) | 0;
    const sx = X + (q * 4 - 4) * A * 0.5 + ((_spHash(seed, k) & 3) - 1) * A;
    const sy = Y - top - (2 + q * 5) * A;
    _spBlob(sx, sy, (stage === 2 ? 3 : 5) + q, k, q < 2 ? 0x282828 : q < 4 ? 0x3c3c3c : 0x545454, SP_SMOKE_A[q], z + 0.04);
  }
}

// F3 charred bare tree: a dead-tree silhouette in charcoal (no canopy),
// trunk as wide as the living tree's, baked once per shape bucket
function _spCharTpl(obj) {
  const type = obj.type;
  const key = 'char_' + (typeof bucketKey === 'function' ? bucketKey(type, obj.radius, obj.height) : type + obj.radius + '_' + obj.height);
  let tpl = _sp.treeCtx.get(key);
  if (tpl !== undefined) return tpl;
  const A = ART;
  let rB, H, hf;
  if (type === 'deadtree') { H = Math.round((obj.height || 0) / 15) * 15 || 40; rB = 2.5; hf = 1; }
  else {
    const R = Math.round((obj.radius || 0) / 15) * 15 || (type === 'pine' ? 30 : 40);
    H = Math.round((obj.height || 0) / 15) * 15 || 80;
    rB = type === 'pine' ? Math.max(3, R * 0.12) : Math.max(4, R * 0.15);
    hf = type === 'pine' ? 0.8 : 0.7;
  }
  const k = Math.max(1, Math.round(rB * 1.35 / A));
  const hT = Math.max(6, Math.round(H * hf / A));
  const seed = _spHash(H * 31 + k, type.length);
  const tg = new PIXI.Graphics();
  // shadow
  _spEllRows(tg, A, 0, k + 3, 1, 0, false);
  tg.fill({ color: 0, alpha: 0.3 });
  // branches: [row, side, len, rise] x n (art px)
  const br = [];
  const nb = type === 'pine' ? 6 : type === 'deadtree' ? 2 : 4;
  for (let i = 0; i < nb; i++) {
    const h = _spHash(seed, i);
    const fy = type === 'pine' ? 0.3 + i * 0.11 : 0.45 + i * (0.42 / nb);
    const side = (i & 1) ? 1 : -1;
    const len = type === 'pine' ? 2 + (h & 1) : 3 + (h % 3) + (type === 'tree' && i === 1 ? 2 : 0);
    const rise = type === 'pine' ? (h & 2 ? 0 : -1) : Math.round(len * 0.8);
    br.push(-Math.round(hT * fy), side, len, rise);
  }
  const half = (y) => Math.max(1, Math.round(k * (1 - 0.7 * (-y / hT))));
  const drawShape = (grow) => {
    for (let y = 0; y > -hT; y--) {
      const w = y < -hT + 2 ? 1 : half(y);
      const top = y === -hT + 1 ? grow : 0, bot = y === 0 ? grow : 0;
      tg.rect((-w - grow) * A, (y - 1 - top) * A, (2 * w + 2 * grow) * A, (1 + top + bot) * A);
    }
    for (let i = 0; i < br.length; i += 4) {
      const y = br[i], side = br[i + 1], len = br[i + 2], rise = br[i + 3];
      const x0 = side > 0 ? half(y) - 1 : -half(y);
      const x1 = x0 + side * len, y1 = y - rise;
      _spGLine(tg, x0, y - 1, x1, y1 - 1, 1, grow);
      if (rise > 1) _spGLine(tg, x1, y1 - 1, x1 + side, y1 - 3, 1, grow); // twig
    }
  };
  // charcoal greys with a little blue (the world grade lifts dark R/G: they would read olive)
  drawShape(1);
  tg.fill(0x08081a);
  drawShape(0);
  tg.fill(0x242238);
  // lit left edge, ash speckles, a dull ember crack
  for (let y = -1; y > -hT + 2; y--) tg.rect(-half(y) * A, (y - 1) * A, A, A);
  tg.fill(0x3c3a50);
  for (let i = 0; i < 4; i++) {
    const h = _spHash(seed, i + 20);
    const y = -1 - (h % Math.max(1, hT - 3)), w = half(y);
    tg.rect(((h >> 8) % (2 * w) - w) * A, (y - 1) * A, A, A);
  }
  tg.fill(0x58566a);
  const cyk = -Math.round(hT * 0.3);
  tg.rect(((seed >> 4) & 1 ? 0 : -1) * A, (cyk - 1) * A, A, 2 * A);
  tg.fill(0x6a1c0c);
  const b = tg.getLocalBounds();
  const tex = renderer.generateTexture({ target: tg, resolution: 1, antialias: false });
  tex.source.scaleMode = 'nearest';
  tpl = { tex, ax: -b.x / b.width, ay: -b.y / b.height, top: Math.max(1, -b.y) };
  tg.destroy();
  _sp.treeCtx.set(key, tpl);
  return tpl;
}

// Swap a tree sprite to / from its charred bare-tree texture (E7: the burnt
// state persists in the record, so a rebuilt sprite swaps on first sight)
function _spCharSwap(g, obj, on) {
  if (on) {
    if (g._tex0 === undefined) { g._tex0 = g.texture; g._ax0 = g.anchor.x; g._ay0 = g.anchor.y; g._top0 = g._top; g._tree0 = g._tree; }
    const tpl = _spCharTpl(obj);
    g.texture = tpl.tex; g.anchor.set(tpl.ax, tpl.ay); g._top = tpl.top;
    g._tree = false; g._char = true;
    g.alpha = 1; g._fade = 0; g.skew.x = 0;
  } else if (g._tex0 !== undefined) {
    g.texture = g._tex0; g.anchor.set(g._ax0, g._ay0); g._top = g._top0; g._tree = g._tree0;
    g._char = false;
  }
  g._tl = -1;
}

function _spRenderFire() {
  _spRenderFlames();
  _spRenderGroundFires();
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
    const wet = gb.inWater === true;
    const z = wet ? 0 : gb.z || 0;
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
    if (wet) { _spGibSink(gb, x0, y0, w, h, r, Y, zz); continue; }
    _spRectSprite(x0 - A, y0 - A, (w + 2) * A, (h + 2) * A, 0x2a0808, zz);
    _spRectSprite(x0, y0, w * A, h * A, gb.color === undefined ? 0x8a1010 : gb.color, zz + 0.001);
    // red meat pixel at the torn end
    const mx = (r === 0 || r === 3) ? x0 + (w - 1) * A : x0;
    const my = (r < 2) ? y0 + (h - 1) * A : y0;
    _spRectSprite(mx, my, A, A, 0xc01818, zz + 0.002);
  }
  sg.fill({ color: 0, alpha: 0.35 });
}

// W4: a gib in water goes down through the waterline (its ground row Y) one
// art row at a time over CFG.GIB_SINK_S; the rows below Y are cropped. No
// shadow; a foam pixel either side while it is still above the surface.
function _spGibSink(gb, x0, y0, w, h, r, Y, zz) {
  const A = ART, R = h + 2;
  const k = Math.min(R, ((gb.sinkT || 0) / CFG.GIB_SINK_S * (R + 1)) | 0) * A;
  const top = y0 - A + k;
  if (top >= Y) return;
  _spRectSprite(x0 - A, top, (w + 2) * A, Y - top, 0x2a0808, zz);
  const ft = y0 + k;
  if (ft < Y) {
    _spRectSprite(x0, ft, w * A, Math.min(h * A, Y - ft), gb.color === undefined ? 0x8a1010 : gb.color, zz + 0.001);
    const mx = (r === 0 || r === 3) ? x0 + (w - 1) * A : x0;
    const my = ((r < 2) ? y0 + (h - 1) * A : y0) + k;
    if (my < Y) _spRectSprite(mx, my, A, A, 0xc01818, zz + 0.002);
  }
  _spRectSprite(x0 - 2 * A, Y - A, A, A, 0xe8f4ff, zz + 0.003);
  _spRectSprite(x0 + (w + 1) * A, Y - A, A, A, 0xe8f4ff, zz + 0.003);
}

// =====================================================================
// BLOOD ON THE WATER (M9 W3 clouds, W5 tint)
// =====================================================================
// W5: one Graphics of tile diamonds, a dither pattern per band (coverage
// 4 / 9 / 11 / 12 of 16, i.e. up to 75%, saturated reds: the frame grade
// lifts pure red to ~(161,38,0), so only coverage pushes R past G/B: band 2
// reads R >= 1.4 x G and B, band 3+ >= 1.8 x with dither + CRT on; spec
// b0cdc51). Tile
// (i, j) = world [i ts, (i+1) ts) x [j ts, (j+1) ts): the same diamond the
// terrain chunk draws for it. Rebuilt only when waterBloodVersion changes
// (<= 4 Hz, and resetWater bumps it), never per frame, and the baked water
// camo is untouched (the tint sits on top of it); the camo's ripple
// highlights are drawn above the tint (pixi-terrain.js WATER_RIP_Z).
// Feathered borders: each tile is cut into 5 x 5 cells along its world axes
// (inner 50% + two 12.5% strips per side). A strip cell blends bilinearly
// toward the side / diagonal neighbours (t = 1/5 in the inner strip, 2/5 in
// the outer one, so the two tiles' strips make a symmetric 5-step ramp
// across the border): its coverage rounds to a whole Bayer step (stepped, no
// smooth alpha) and its colour is the coverage-weighted mix of the bands'
// colours, quantised to steps of 8 per channel (a band 3 -> 4 border is
// mostly a colour change). Clean water neighbours get their half of the
// ramp; land neighbours count as the tile itself (the shoreline keeps its
// edge). Geometry is grouped by (coverage, colour) and filled once per style.
// Water life: the camo's ripple highlights sit above the tint, and on band
// 2+ tiles (where the red would swallow them) the same ripple rect gets a
// pale sheen, one art pixel tall, pulsing in the camo ripples' two stepped
// counter-phase groups (alpha only per frame, geometry with the tint).
const SP_WB_SHEEN = 0xe8a0a0;
const SP_WB_DENS = [0, 4, 9, 11, 12];
const SP_WB_COL = [0, 0x960000, 0xb80000, 0xa80000, 0x900000];
const SP_WB_CUT = [0, 0.125, 0.25, 0.75, 0.875, 1];
const SP_WB_T = [2 / 5, 1 / 5, 0, 1 / 5, 2 / 5];
const SP_WB_SIDE = [-1, -1, 0, 1, 1];
const _spWbNb = new Int8Array(9);        // 3 x 3 neighbour bands, [(b + 1) * 3 + (a + 1)]
const _spWbW = new Float32Array(5);      // per-band weight of one cell
const _spWbCell = new Float64Array(25);  // style key per cell (0 = none)
const _spWbPolys = new Map();            // style key -> point lists of its cells
const _spWbSeen = new Set();
function _spWbBand(i, j) {               // band of a bloody tile, 0 clean water, -1 land
  const t = waterBloodTiles.get(_wbKey(i, j));
  if (t && t.band > 0) return t.band;
  return _wbIsWet(i, j) ? 0 : -1;
}
function _spWbTile(i, j, ts, iso) {
  const nb = _spWbNb, w = _spWbW, cell = _spWbCell;
  const b0 = Math.max(0, _spWbBand(i, j));
  let flat = true;
  for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
    let k = (a || b) ? _spWbBand(i + a, j + b) : b0;
    if (k < 0) k = b0;
    nb[(b + 1) * 3 + a + 1] = k;
    if (k !== b0) flat = false;
  }
  if (flat) {
    if (b0 > 0) _spWbPoly(SP_WB_DENS[b0] * 0x1000000 + SP_WB_COL[b0], i, j, 0, 0, 1, 1, ts, iso);
    return;
  }
  for (let cv = 0; cv < 5; cv++) {
    const sv = SP_WB_SIDE[cv], tv = SP_WB_T[cv];
    for (let cu = 0; cu < 5; cu++) {
      const su = SP_WB_SIDE[cu], tu = SP_WB_T[cu];
      w.fill(0);
      w[b0] += (1 - tu) * (1 - tv);
      w[nb[4 + su]] += tu * (1 - tv);
      w[nb[(sv + 1) * 3 + 1]] += (1 - tu) * tv;
      w[nb[(sv + 1) * 3 + su + 1]] += tu * tv;
      let d = 0, r = 0, gg = 0, bb = 0, used = 0, one = 0;
      for (let k = 1; k <= 4; k++) {
        if (!w[k]) continue;
        const wd = w[k] * SP_WB_DENS[k], c = SP_WB_COL[k];
        d += wd; r += wd * (c >> 16); gg += wd * ((c >> 8) & 255); bb += wd * (c & 255);
        used++; one = k;
      }
      const n = Math.min(15, Math.round(d));
      let col = 0;
      if (n > 0) {
        if (used === 1) col = SP_WB_COL[one];
        else {
          const q = (v) => Math.min(255, Math.round(v / d / 8) * 8);
          col = (q(r) << 16) | (q(gg) << 8) | q(bb);
        }
      }
      cell[cv * 5 + cu] = n > 0 ? n * 0x1000000 + col : 0;
    }
  }
  // runs of one style along each row -> one quad per run
  for (let cv = 0; cv < 5; cv++) {
    let cu = 0;
    while (cu < 5) {
      const s = cell[cv * 5 + cu];
      let e = cu + 1;
      while (e < 5 && cell[cv * 5 + e] === s) e++;
      if (s) _spWbPoly(s, i, j, SP_WB_CUT[cu], SP_WB_CUT[cv], SP_WB_CUT[e], SP_WB_CUT[cv + 1], ts, iso);
      cu = e;
    }
  }
}
// world quad [i + u0, i + u1] x [j + v0, j + v1] (tiles) -> screen parallelogram
function _spWbPoly(style, i, j, u0, v0, u1, v1, ts, iso) {
  const x0 = (i + u0) * ts, x1 = (i + u1) * ts, y0 = (j + v0) * ts, y1 = (j + v1) * ts;
  let L = _spWbPolys.get(style);
  if (!L) { L = []; _spWbPolys.set(style, L); }
  L.push([x0 - y0, (x0 + y0) * iso, x1 - y0, (x1 + y0) * iso, x1 - y1, (x1 + y1) * iso, x0 - y1, (x0 + y1) * iso]);
}
function _spWbSheen(t, ts, iso) {
  if (t.band < 2 || typeof waterTileHash !== 'function') return;
  // same rect as bakeChunkWater's ripple highlight for this tile
  const dhw = ts, dhh = ts * iso;
  const rh = waterTileHash(t.i, t.j, 99);
  const rx = (((rh >> 8) & 0xff) / 255 - 0.5) * dhw * 0.4;
  const ry = (((rh >> 16) & 0xff) / 255 - 0.5) * dhh * 0.4;
  const rw = 8 + ((rh >> 24) & 0xf);
  if (!waterRectInDiamond(rx, ry, rw, 2, dhw, dhh)) return;
  const cx = (t.i - t.j) * ts, cy = (t.i + t.j + 1) * dhh;
  (rh & 1 ? _sp.wbSheenA : _sp.wbSheenB).rect(_spSnap(cx + rx - rw * 0.5), _spSnap(cy + ry - 1), Math.max(ART, _spSnap(rw)), ART);
}
function _spRenderWaterBlood() {
  const g = _sp.wbG;
  if (!g || typeof waterBloodTiles === 'undefined') return;
  // per frame: the sheen pulses like the camo ripples (renderPixiWaterOverlay)
  const tq = Math.floor(gameTime * WATER_STEP_HZ) / WATER_STEP_HZ, pulse = Math.sin(tq * 0.5);
  const sA = _sp.wbSheenA, sB = _sp.wbSheenB;
  // stepped, and capped below opaque (a glint, not a stripe)
  sA.alpha = Math.round(Math.max(0, pulse) * 4) / 4 * 0.6; sA.visible = sA.alpha > 0;
  sB.alpha = Math.round(Math.max(0, -pulse) * 4) / 4 * 0.6; sB.visible = sB.alpha > 0;
  if (waterBloodVersion === _sp.wbVer) return;
  const t0 = performance.now();
  _sp.wbVer = waterBloodVersion;
  g.clear(); sA.clear(); sB.clear();
  _spWbPolys.clear();
  // bloody tiles + the clean water tiles around them (their half of the ramp)
  const ts = CFG.TILE_SIZE, iso = CFG.ISO_SCALE, seen = _spWbSeen;
  seen.clear();
  for (const t of waterBloodTiles.values()) {
    if (t.band <= 0) continue;
    _spWbTile(t.i, t.j, ts, iso);
    _spWbSheen(t, ts, iso);
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      if (!a && !b) continue;
      const i = t.i + a, j = t.j + b, k = _wbKey(i, j);
      if (seen.has(k)) continue;
      seen.add(k);
      if (_spWbBand(i, j) === 0) _spWbTile(i, j, ts, iso); // a bloody tile draws itself; land never
    }
  }
  for (const [style, L] of _spWbPolys) {
    for (let q = 0; q < L.length; q++) g.poly(L[q], true);
    g.fill(_spPat(Math.floor(style / 0x1000000), style % 0x1000000));
  }
  sA.fill(SP_WB_SHEEN); sB.fill(SP_WB_SHEEN);
  _sp.wbStyles = _spWbPolys.size;
  _sp.wbBuildMs = performance.now() - t0;
}

// W3: each cloud = a seeded 3-lobe dithered rim + a denser core, both
// fading in 4 coverage steps over its life (and darkening). Per frame into
// one Graphics, grouped by step so it is <= 8 fills.
const SP_CLOUD_RIM = [6, 4, 2, 1], SP_CLOUD_CORE = [12, 8, 5, 2];
const SP_CLOUD_COL = [0x9a1212, 0x881010, 0x760e0e, 0x640c0c];
function _spRenderBloodClouds() {
  const g = _sp.cloudG;
  if (!g) return;
  g.clear();
  if (typeof bloodClouds === 'undefined' || !bloodClouds.length) return;
  const iso = CFG.ISO_SCALE, A = ART, K = Math.SQRT2;
  for (let step = 0; step < 4; step++) {
    for (let core = 0; core < 2; core++) {
      let any = false;
      for (let i = 0; i < bloodClouds.length; i++) {
        const c = bloodClouds[i];
        if (Math.min(3, (c.t / c.life * 4) | 0) !== step) continue;
        const sx = c.x - c.y, sy = (c.x + c.y) * iso;
        if (!_spInView(sx, sy)) continue;
        const X = _spSnap(sx), Y = _spSnap(sy);
        const rx = Math.max(A, _spSnap(c.r * K)), ry = Math.max(A, _spSnap(c.r * K * iso));
        if (core) {
          g.ellipse(X, Y, Math.max(A, _spSnap(rx * 0.55)), Math.max(A, _spSnap(ry * 0.55)));
        } else {
          const h = c.seed | 0;
          g.ellipse(X, Y, _spSnap(rx * 0.85), Math.max(A, _spSnap(ry * 0.85)));
          for (let l = 0; l < 2; l++) {
            const hl = h >>> (l * 8);
            const ox = (((hl & 15) - 7.5) / 7.5) * rx * 0.4, oy = ((((hl >> 4) & 15) - 7.5) / 7.5) * ry * 0.4;
            g.ellipse(_spSnap(X + ox), _spSnap(Y + oy), Math.max(A, _spSnap(rx * 0.6)), Math.max(A, _spSnap(ry * 0.6)));
          }
        }
        any = true;
      }
      if (any) g.fill(_spPat(core ? SP_CLOUD_CORE[step] : SP_CLOUD_RIM[step], SP_CLOUD_COL[step]));
    }
  }
}

// M8 E4: flying env debris (envphys.js envDebris), pooled sprites like gibs.
// Outline + fill chunk, rotation stepped to 45 deg, ground shadow while airborne.
const _spDebOl = [0x24180c, 0x4a3e24, 0x1e1e1a, 0x1a120a, 0];
function _spRenderDebris() {
  if (typeof envDebris === 'undefined' || envDebris.length === 0) return;
  const iso = CFG.ISO_SCALE, A = ART, Q = Math.PI / 4;
  const sg = _sp.groundG, tw = _sp.texWhite;
  for (let i = 0; i < envDebris.length; i++) {
    const d = envDebris[i];
    const sx = d.x - d.y, gy = (d.x + d.y) * iso;
    if (!_spInView(sx, gy)) continue;
    const z = d.z > 0 ? d.z : 0;
    const X = _spSnap(sx), Y = _spSnap(gy - z) - A;
    const zz = depthKey(d.x, d.y);
    const kind = d.kind | 0;
    if (kind === 4) { // DEBRIS_LEAF: a single green pixel
      const s = _spSprite(tw, X, Y, zz);
      s.scale.set(A, A); s.tint = d.color;
      continue;
    }
    if (z > 2) sg.rect(X - A, _spSnap(gy), 2 * A, A);
    const size = d.size || 2;
    let w, h;
    if (kind === 0 || kind === 3) { w = size >= 2.5 ? 3 : 2; h = 1; }     // wood / bark splinter
    else if (kind === 2) { w = size >= 2.8 ? 2 : 1; h = size >= 3.5 ? 2 : 1; } // stone
    else { w = size >= 2.4 ? 2 : 1; h = 1; }                               // sand clump
    const rot = Math.round((d.rot || 0) / Q) * Q;
    const o = _spSprite(tw, X, Y, zz);
    o.scale.set((w + 2) * A, (h + 2) * A); o.rotation = rot; o.tint = _spDebOl[kind] || 0x1a120a;
    const f = _spSprite(tw, X, Y, zz + 0.001);
    f.scale.set(w * A, h * A); f.rotation = rot; f.tint = d.color;
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

// Cache key of a Graphics env object: rebuilt only when this changes
function _spEnvState(obj) {
  if (obj.type !== 'barrel') { const e = obj._env; return e && e.cracked ? 1 : 0; } // M8 E4
  if (obj.exploded) return -1;
  return Math.ceil((obj.hp || 0) / Math.max(1, obj.maxHp || 30) * 6);
}

function _spBuildEnv(obj) {
  const type = obj.type;
  if (type === 'tree' || type === 'pine' || type === 'bush' || type === 'deadtree') {
    const key = typeof bucketKey === 'function' ? bucketKey(type, obj.radius, obj.height) : type + obj.radius + '_' + obj.height;
    let tpl = _sp.treeCtx.get(key);
    if (tpl === undefined) {
      // Bake each tree shape (~15-20 buckets) to a texture once. Trees
      // interleave with entities in depth order, so as Graphics each one
      // split the batch (and batching their big meshes cost ~4 ms/frame);
      // as Sprites they batch with everything else for free.
      const tg = createTreeGraphics(type, obj.radius, obj.height);
      tpl = null;
      if (tg) {
        const b = tg.getLocalBounds();
        const tex = renderer.generateTexture({ target: tg, resolution: 1, antialias: false });
        tex.source.scaleMode = 'nearest';
        tpl = { tex, ax: -b.x / b.width, ay: -b.y / b.height, top: Math.max(1, -b.y) };
        tg.destroy();
      }
      _sp.treeCtx.set(key, tpl);
    }
    if (!tpl) return null;
    const g = new PIXI.Sprite(tpl.tex);
    g.anchor.set(tpl.ax, tpl.ay);
    g._tree = type === 'tree' || type === 'pine';
    g._spr = true;        // M8: sway / scorch / topple via sprite transform + tint
    g._top = tpl.top;     // px from the base (anchor) to the top of the texture
    g._xf = false; g._tl = 0; g._z0 = 0;
    return g;
  }
  const g = new PIXI.Graphics();
  g.context.batchMode = 'batch';
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

// M8 E4: dark pixel cracks across a cracked boulder (ellipse centre cx, cy)
function _spRockCracks(g, cx, cy, rx, ry, seed) {
  const A = ART;
  const ex = (rx + 0.5) * (rx + 0.5), ey = (ry + 0.5) * (ry + 0.5);
  for (let k = 0; k < 2; k++) {
    const h = _spHash(seed, k + 30);
    let x = ((h & 7) % Math.max(1, rx)) - (rx >> 1) + (k ? (rx >> 1) : 0);
    let y = -ry + 1 + ((h >> 3) & 1);
    const len = ry * 2 + 1;
    for (let i = 0; i < len; i++) {
      if (x * x / ex + y * y / ey < 0.8) g.rect(cx + x * A, cy + y * A, A, A);
      const hh = _spHash(h, i);
      // mostly down, sometimes sideways: reads as a jagged fracture
      if ((hh & 3) === 0) x += (hh & 4) ? 1 : -1;
      else { y++; if ((hh & 24) === 0) x += (hh & 32) ? 1 : -1; }
      // short branch from the middle of the first crack
      if (k === 0 && i === (len >> 1)) {
        const dir = (hh & 64) ? 1 : -1;
        for (let j = 1; j <= 2; j++) {
          const bx = x + dir * j, by = y - (j >> 1);
          if (bx * bx / ex + by * by / ey < 0.8) g.rect(cx + bx * A, cy + by * A, A, A);
        }
      }
    }
  }
  g.fill(0x1a1a16);
}

function _spDrawEnv(g, obj) {
  const A = ART, type = obj.type;
  const seed = ((obj.x * 73856093) ^ (obj.y * 19349663)) | 0;
  g.clear();
  if (type === 'rock' || type === 'boulder') {
    const rx = Math.max(2, Math.round((obj.radius || 8) * 1.1 / A));
    const ry = Math.max(1, Math.round(rx * 0.6));
    _spRock(g, 0, -ry * A, rx, ry, seed, type === 'boulder');
    if (obj._env && obj._env.cracked) _spRockCracks(g, 0, -ry * A, rx, ry, seed);
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
    if (obj._env && obj._env.cracked) {
      // M8 E4: zigzag cracks down some wall columns + chipped tops
      for (let i = 0; i < w; i += 2) {
        const hs = _spHash(seed, i + 40);
        if ((hs & 3) === 0) continue;
        const hh = Math.max(1, h - (_spHash(seed, i) % Math.max(1, (h >> 1) + 1)));
        let cx = (hs >> 2) & 1;
        for (let y = -hh + 1; y < 0; y++) {
          g.rect((x0 + i + cx) * A, y * A, A, A);
          if ((_spHash(hs, y + 9) & 3) === 0) cx ^= 1;
        }
        if ((hs >> 4) & 1) g.rect((x0 + i + ((hs >> 5) & 1)) * A, -hh * A, A, A);
      }
      g.fill(0x1c1c18);
    }
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
  const eos = typeof envObjState === 'function' ? envObjState : null;
  for (let i = 0; i < envObjects.length; i++) {
    const obj = envObjects[i];
    obj._spSeen = f;
    const sx = obj.x - obj.y, sy = (obj.x + obj.y) * iso;
    if (sx < x0 || sx > x1 || sy < y0 || sy > y1) continue;
    // M8: state record (null = never affected); also picks up persisted state
    const rec = eos !== null ? eos(obj) : null;
    // Destroyed objects vanish (debris / remains replace them; the exploded-
    // barrel wreck stays, it is the remains). Baked trees are replaced by
    // their stump + log in the env remains layer (E10) - but the fallen
    // sprite stays until the layer has drawn the log (no gap while a dirty
    // chunk waits for its rebuild). Checked BEFORE building, so an object
    // first seen already destroyed / felled (off-screen at the time, or
    // after its chunk regenerated) never shows a ghost standing sprite.
    // A splintered log (E11 logGone) leaves only its stump (layer).
    if (rec !== null && ((rec.state === 'destroyed' && obj.type !== 'barrel') ||
        (rec.baked && rec._drawnInLayer === true) ||
        (rec.logGone === true && rec._drawnInLayer === true))) continue; // keep the sprite until the stump is baked
    let g = _sp.env.get(obj);
    const st = _spEnvState(obj);
    if (g === undefined) {
      g = _spBuildEnv(obj);
      _sp.env.set(obj, g);
      if (g) {
        g.visible = false; // shown below only if it passes every check
        g._st = st;
        g.position.set(_spSnap(sx), _spSnap(sy));
        const flat = obj.type === 'flowers' || (obj.type === 'barrel' && obj.exploded);
        g.zIndex = flat ? SP_Z_GROUND + 1 : depthKey(obj.x, obj.y);
        g._z0 = g.zIndex;
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
    if (g._spr) {
      // F3: a burnt-out tree stands as a charred bare tree (baked texture)
      if ((rec !== null && rec.charred === true) !== (g._char === true)) _spCharSwap(g, obj, rec !== null && rec.charred === true);
      _spTreeXf(g, obj, rec);
      if (g._tree) _spCanopyFade(g, obj, rec, sx, sy, f);
      if (rec !== null && rec.notch === true) _spTrunkNotch(g, obj, rec, vis);
      if (rec !== null && (rec.fire > 0 || rec.heat > 0) && (rec.state === 'standing' || rec.state === 'scorched')) _spTreeFireFx(g, obj, rec);
    }
  }
  // periodic sweep of graphics whose env object was unloaded
  if ((f % 120) === 0) {
    _sp.env.forEach(_spEnvSweepFn);
  }
}

// M8 E2: scorch tint per level (darker, slightly warm) - tints keep batching
// F3: 4..9 = burning (stage x 2 flicker tints: firelit, then darkening), 10 = charred (own colours)
const _spScorchTint = [0xffffff, 0xc4b6a4, 0x938476, 0x695e56,
  0xffd8b0, 0xffc8a0, 0xe8a878, 0xd89868, 0x907060, 0x806050, 0xffffff];
const SP_SWAY_Q = 0.04;      // record sway quantum (rad): ~1 art px at the top of a tree
const SP_FALL_STEPS = 6;     // topple drawn in 6 steps of 15 deg

// Tree-like sprite transform: ambient stepped sway + record sway, scorch
// tint, and the topple (rotation about the base, foreshortened in iso).
// Transform-only: never rebuilds geometry.
function _spTreeXf(g, obj, rec) {
  let lv = rec !== null ? Math.min(3, rec.scorch | 0) : 0;
  if (rec !== null && rec.fire > 0) lv = 4 + _spTreeFireStage(rec) * 2 + (((gameTime * 10) | 0) & 1);
  else if (g._char === true) lv = 10;
  if (g._tl !== lv) { g._tl = lv; g.tint = _spScorchTint[lv]; }
  if (rec !== null && (rec.state === 'falling' || rec.state === 'fallen')) {
    const iso = CFG.ISO_SCALE;
    const th = Math.round(rec.fall * SP_FALL_STEPS) / SP_FALL_STEPS * (Math.PI / 2);
    const c = Math.cos(th), sn = Math.sin(th);
    const fx = rec.fallDirX, fy = rec.fallDirY;
    // screen projection of the fall direction (per world unit)
    // (screen-vertical part foreshortened like the baked log, see SP_LOG_VK)
    const Px = fx - fy, Py = (fx + fy) * iso * SP_LOG_VK;
    const Pl = Math.sqrt(Px * Px + Py * Py) || 1;
    // Y axis (image of local +y, base -> down): the top swings from straight
    // up to the projected fall direction, scaled so the canopy lands where
    // the baked crown will lie (log end + crown push + crown radius; E10)
    const cr = obj.type === 'deadtree' || g._char === true ? 0 : (obj.radius || 0) * (CFG.ENV_CROWN_R || 0.75);
    const reach = (rec.logLen > 0 ? rec.logLen : 40) + cr * (1 + (CFG.ENV_CROWN_PUSH || 0.35));
    const kL = reach / g._top;
    let Yx = -sn * Px * kL, Yy = c - sn * Py * kL;
    // never let the trunk axis collapse (pointing at the camera): keep at
    // least 0.3 of its length, along the final direction once past halfway
    let Yl = Math.sqrt(Yx * Yx + Yy * Yy);
    if (Yl < 0.3) {
      if (Yl < 1e-3) { if (sn > 0.5) { Yx = -Px / Pl; Yy = -Py / Pl; } else { Yx = 0; Yy = 1; } Yl = 1; }
      Yx *= 0.3 / Yl; Yy *= 0.3 / Yl; Yl = 0.3;
    }
    // X axis (canopy width): kept PERPENDICULAR on screen to the trunk axis
    // (same handedness as at rest, so the sprite never mirrors or turns into
    // a sliver), its width easing from 1 to the lying crown's projected
    // width across the trunk (min 0.5)
    const qx = (-fy - fx) * 0.7071, qy = (fx - fy) * iso * 0.7071;
    const wEnd = Math.min(1, Math.max(0.5, Math.abs(qx * Py - qy * Px) / Pl));
    const w = 1 - sn + sn * wEnd;
    const Xx = Yy / Yl * w, Xy = -Yx / Yl * w;
    g.rotation = 0;
    g.skew.set(Math.atan2(Yx, Yy), Math.atan2(Xy, Xx));
    g.scale.set(Math.sqrt(Xx * Xx + Xy * Xy), Math.sqrt(Yx * Yx + Yy * Yy));
    // depth: the lying crown sorts by its middle (in front of the base when
    // it falls toward the camera)
    const zm = depthKey(obj.x + fx * rec.logLen * 0.5 * sn, obj.y + fy * rec.logLen * 0.5 * sn);
    g.zIndex = zm > g._z0 ? zm : g._z0;
    g._xf = true;
    return;
  }
  if (g._xf) { g._xf = false; g.scale.set(1, 1); g.skew.y = 0; g.zIndex = g._z0; }
  let skx = 0;
  if (g._tree) {
    // A6 optional: stepped ambient tree sway
    skx = Math.round(Math.sin(gameTime * 0.9 + obj.x * 0.013 + obj.y * 0.007) * 1.4) * 0.025;
  }
  // record sway (+ = top leans to screen +x; skew.x > 0 leans it to -x)
  if (rec !== null && rec.sway !== 0) skx -= Math.round(rec.sway / SP_SWAY_Q) * SP_SWAY_Q;
  g.skew.x = skx;
}

// E11: canopy fade. A standing tree that covers the player (the player's
// body, ~15 art px tall, overlaps the sprite's screen bounds above the trunk
// base, and the tree sorts in front of the player) fades to 40% in stepped
// alpha (1 -> 0.7 -> 0.4, one step per SP_FADE_STEP_F frames) and steps
// back once the player leaves. Alpha only: no geometry or texture work.
const _spFadeA = [1, 0.7, 0.4];
const SP_FADE_STEP_F = 4;   // 2 steps x 4 frames ~ 0.13 s
const SP_FADE_BODY = 15;    // player body height (art px)
let _spFadeF = -1, _spFadePX = 0, _spFadePY = 0, _spFadePZ = 0, _spFadeOn = false;
function _spCanopyFade(g, obj, rec, sx, sy, f) {
  if (_spFadeF !== f) {
    _spFadeF = f;
    _spFadeOn = typeof player !== 'undefined' && player !== null && !player.dead;
    if (_spFadeOn) {
      _spFadePX = player.x - player.y; _spFadePY = (player.x + player.y) * CFG.ISO_SCALE;
      _spFadePZ = depthKey(player.x, player.y);
    }
  }
  let want = 0;
  const standing = rec === null || rec.state === 'standing' || rec.state === 'scorched';
  // cheap reject first: only trees near the player and in front of it
  if (standing && _spFadeOn && sy >= _spFadePY && sy - _spFadePY < 400 &&
      sx - _spFadePX < 240 && _spFadePX - sx < 240 && g._z0 > _spFadePZ) {
    const tex = g.texture;
    const w = tex.width, h = tex.height;
    const l = sx - g.anchor.x * w, r = l + w, top = sy - g.anchor.y * h;
    const bodyTop = _spFadePY - SP_FADE_BODY * ART;
    if (_spFadePX > l && _spFadePX < r && _spFadePY > top && bodyTop < sy) want = 2;
  }
  const lv = g._fade | 0;
  if (lv === want) return;
  if (f - (g._fadeF | 0) < SP_FADE_STEP_F) return;
  const nl = lv + (want > lv ? 1 : -1);
  g._fade = nl; g._fadeF = f;
  g.alpha = _spFadeA[nl];
}

// E13: trunk notch. A standing tree / pine / dead tree worn to <= 50% trunk
// HP (rec.notch) shows a stepped pixel wedge on the trunk side facing the
// shooters (rec.notchDir, world). One small Graphics per notched tree (few
// at once), created on the first notched frame and redrawn only when its
// pixel layout key changes; it copies the tree sprite's position, skew
// (ambient + record sway about the base), tint (scorch), alpha (canopy
// fade) and sorts just above it. Hidden once the topple shows (falling with
// fall step > 0, fallen: the rotated sprite and the baked log take over) and
// with the sprite (envVis).
const SP_NOTCH_DARK = 0x1a1008;
const SP_NOTCH_FH = 0.3;     // notch height as a fraction of the trunk height
function _spTrunkNotch(g, obj, rec, vis) {
  // a felled tree keeps it only while its topple has not visibly started
  // (fall step 0: it waits for the shock front / stagger and looks standing)
  if (rec.state !== 'standing' && rec.state !== 'scorched' &&
      (rec.state !== 'falling' || Math.round(rec.fall * SP_FALL_STEPS) !== 0)) return;
  const A = ART;
  const type = obj.type;
  // trunk as built by procedural-tree3d.js (bucketed dims; radius at the
  // base rB, height tH, top radius = rB x (1 - taper))
  // cb = height of the canopy's lower edge above the base at the trunk
  // (screen units): the notch stays on the bare trunk below it
  let rB, tH, taper, cb;
  if (type === 'deadtree') {
    rB = 2.5; tH = Math.round((obj.height || 0) / 15) * 15 || 40; taper = 0.4; cb = tH;
  } else {
    const R = Math.round((obj.radius || 0) / 15) * 15 || (type === 'pine' ? 30 : 40);
    const H = Math.round((obj.height || 0) / 15) * 15 || 80;
    if (type === 'pine') { rB = Math.max(3, R * 0.12); tH = H * 0.35; cb = tH - R * 0.58; } else { rB = Math.max(4, R * 0.15); tH = H * 0.5; cb = tH - R * 0.65; }
    taper = 0.3;
  }
  const r = rB * (1 - taper * SP_NOTCH_FH);
  // trunk half width in art px: columns -k .. k-1 around the base
  const k = Math.max(1, Math.round(r * 1.35 / A));
  const nx = rec.notchDirX, ny = rec.notchDirY;
  const t = (nx - ny) * 0.7071;   // screen-lateral part (-1 left .. +1 right)
  const fr = (nx + ny) * 0.7071;  // toward the camera (> 0) / away (< 0)
  const s = t >= 0 ? 1 : -1;
  const deep = rec.trunkMax > 0 && rec.trunkHp <= rec.trunkMax * 0.25 ? 1 : 0;
  // mode 0: gash on the visible face; 1: bite into the silhouette edge
  // on side s; 2: facing away (hidden side): small bites on both edges
  const mode = fr > 0 && Math.abs(t) < 0.6 && k >= 2 ? 0 : (fr < -0.5 && Math.abs(t) < 0.35 ? 2 : 1);
  // row (art px, base = 0, up < 0): the wedge sits on the trunk surface,
  // its top row below the canopy edge, its bottom row above the ground
  let cy = Math.round((-SP_NOTCH_FH * tH + r * Math.max(0, fr) * 1.41 * CFG.ISO_SCALE) / A);
  const cyMin = Math.ceil(-cb / A) + 1 + deep;
  if (cy < cyMin) cy = cyMin;
  if (cy > -1) cy = -1;
  const lit = fr > -0.3 ? 1 : 0;   // the cut-wood floor shows unless it faces away
  let c0, w;
  if (mode === 0) {
    w = k >= 3 ? 3 + deep : 2;
    c0 = Math.round(t * k) - (w >> 1);
    if (c0 < -k) c0 = -k;
    if (c0 + w > k) c0 = k - w;
  } else {
    w = mode === 2 ? 1 : Math.min(2 + deep, k);  // bite depth
    c0 = s > 0 ? k - 1 : -k;                     // edge column
  }
  const key = mode + 3 * (s + 1) + 9 * deep + 18 * lit + 36 * (c0 + 32) + 2304 * (w + 8 * (cy + 256));
  let n = g._notchG;
  if (n === undefined || n === null) {
    n = new PIXI.Graphics();
    n.context.batchMode = 'batch';
    n._key = -1;
    g._notchG = n;
    worldContainer.addChild(n);
  }
  if (n._key !== key) {
    n._key = key;
    n.clear();
    const cut = typeof ENV_CUT_WOOD === 'number' ? ENV_CUT_WOOD : 0xc8a070;
    const cutC = type === 'deadtree' ? darkenColorHex(cut, 0.8) : cut;
    if (mode === 0) {
      // head-on felling notch: sloped upper face in shadow, lit flat lower
      // face (cut wood) - a dark lens with a light floor
      const rt = cy - 1 - deep;
      if (w > 2) n.rect((c0 + 1) * A, rt * A, (w - 2) * A, A);
      n.rect(c0 * A, (rt + 1) * A, w * A, (cy - rt) * A);
      n.fill(SP_NOTCH_DARK);
      n.rect(c0 * A, (cy + 1) * A, w * A, A);
      n.fill(cutC);
      n.rect((c0 + (s > 0 ? w - 1 : 0)) * A, (cy + 1) * A, A, A);
      n.fill(darkenColorHex(cutC, 0.72));
    } else if (mode === 1) {
      // sideways V cut into the silhouette edge, opening toward side s
      const x0 = s > 0 ? c0 - w + 1 : c0;            // leftmost column of the deepest row
      const xe = s > 0 ? c0 - (w - 2) : c0;          // rows one px shallower
      const ws = Math.max(1, w - 1);
      n.rect((s > 0 ? c0 - ws + 1 : c0) * A, (cy - 1 - deep) * A, ws * A, A);
      n.rect(x0 * A, (cy - deep) * A, w * A, (1 + deep) * A);
      n.fill(SP_NOTCH_DARK);
      if (lit) { n.rect((s > 0 ? Math.min(xe, c0) : c0) * A, (cy + 1) * A, ws * A, A); n.fill(cutC); }
    } else {
      // notch on the hidden back: only the thinned silhouette shows
      // (a 2 px trunk keeps one lit column: bite the side s edge only)
      if (k > 1 || s < 0) n.rect(-k * A, (cy - 1) * A, A, (2 + deep) * A);
      if (k > 1 || s > 0) n.rect((k - 1) * A, (cy - 1) * A, A, (2 + deep) * A);
      n.fill(SP_NOTCH_DARK);
    }
  }
  n.position.copyFrom(g.position);
  if (n.skew.x !== g.skew.x) n.skew.x = g.skew.x;
  if (n.tint !== g.tint) n.tint = g.tint;
  if (n.alpha !== g.alpha) n.alpha = g.alpha;
  n.zIndex = g.zIndex + 0.01;
  n.visible = true;
  vis.push(n);
}

function _spEnvSweepFn(g, obj, map) {
  if (obj._spSeen === _sp.frame) return;
  if (g) { if (g._notchG) _spDestroy(g._notchG); _spDestroy(g); }
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
  const grow = new PIXI.Graphics();
  grow.zIndex = SP_Z_DECAL_RECENT;
  worldContainer.addChild(grow);
  _sp.dec = {
    gen: (_sp.dec ? _sp.dec.gen : 0) + 1,
    head: 0, len: 0, front: null, frontSeed: 0,
    version: -1, sealedEnd: 0,
    chunks: [], freeG: [], recent: recent, grow: grow,
    rebuilds: 0,
  };
}

// Test hook (P4/G4): decal layers and their draw count right now
function decalStats() {
  const D = _sp.dec;
  if (!D) return { chunks: 0, dynamic: 0, draws: 0 };
  let chunks = 0;
  for (const c of D.chunks) if (c.g.visible !== false) chunks++;
  // recent + grow layers; an empty Graphics issues no draw
  const dynamic = (D.recent.context.instructions.length ? 1 : 0) + (D.grow.context.instructions.length ? 1 : 0);
  return { chunks, dynamic, draws: chunks + dynamic };
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

// P4: chunks and the recent layer draw SETTLED decals only; still-growing
// pools are drawn by the dynamic grow layer, so they never block merging
function _spDecDrawRange(g, from, to) {
  const D = _sp.dec;
  for (let v = from; v < to; v++) {
    const d = bloodPools[v - D.head];
    if (d && !d.growing) _spDrawDecal(g, d);
  }
}

// Number of still-growing decals in a chunk (-1: none). When it changes, a
// pool settled and must now be baked into the chunk.
function _spDecGrowSig(from, to) {
  const D = _sp.dec;
  let sig = -1;
  for (let v = from; v < to; v++) {
    const d = bloodPools[v - D.head];
    if (d && d.growing) sig = (sig < 0 ? 0 : sig) + 1;
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
  D.grow.clear();
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

  // chunks whose growing pools settled: bake them in (<= 2 rebuilds per frame;
  // the rest are picked up on later frames since their signature still differs)
  let settleBudget = 2;
  for (let i = 0; i < D.chunks.length && settleBudget > 0; i++) {
    const c = D.chunks[i];
    if (c.sig < 0) continue;
    if (_spDecGrowSig(c.start, c.end) !== c.sig) { _spDecBuildChunk(c); settleBudget--; }
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
      // Big chunks start on a 256-decal boundary so addDecal's 256-aligned
      // recycling drops whole chunks instead of cutting (and rebuilding) one
      if (!c.big && (run > 0 || c.start % (SP_DEC_SMALL * SP_DEC_MERGE) === 0)) {
        if (run === 0) runStart = i;
        run++;
        if (run === SP_DEC_MERGE) { found = runStart; break; }
      } else run = 0;
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
  // dynamic grow layer: every still-growing pool at its current size
  D.grow.clear();
  for (let i = 0; i < _growingDecals.length; i++) {
    const d = _growingDecals[i];
    if (d.growing) _spDrawDecal(D.grow, d);
  }
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
  } else if (kind === 7) { // DECAL_WOOD: splinter (bark uses the same kind, darker colour)
    const L = (d.radius || 2) >= 2.6 ? 3 : 2;
    const dir = Math.round((d.angle || 0) / (Math.PI / 4)) & 3; // 0 -, 1 \, 2 |, 3 /
    const dx = dir === 2 ? 0 : 1, dy = dir === 0 ? 0 : (dir === 3 ? -1 : 1);
    for (let k = 0; k < L; k++) g.rect(cx + (k * dx - 1) * A, cy + (k * dy - 1) * A, 3 * A, 3 * A);
    g.fill(darkenColorHex(col, 0.4));
    for (let k = 0; k < L; k++) g.rect(cx + k * dx * A, cy + k * dy * A, A, A);
    g.fill(col);
    g.rect(cx, cy, A, A);
    g.fill(darkenColorHex(col, 1.3));
  } else if (kind === 8) { // DECAL_RUBBLE: stone chunk with outline + highlight
    const rr = d.radius || 2;
    const w = rr >= 2.8 ? 2 : 1, h = rr >= 3.5 ? 2 : 1;
    g.rect(cx - A, cy - A, (w + 2) * A, (h + 2) * A);
    g.fill(0x1e1e1a);
    g.rect(cx, cy, w * A, h * A);
    g.fill(col);
    if (w > 1) { g.rect(cx, cy, A, A); g.fill(darkenColorHex(col, 1.3)); }
  } else if (kind === 9) { // DECAL_SAND: small tan blob
    const h = _spHash(seed, 2);
    const w = (d.radius || 2) >= 2.4 ? 3 : 2;
    g.rect(cx - A, cy, w * A, A);
    g.rect(cx + ((h & 1) - 1 + (w > 2 ? 1 : 0)) * A, cy - A, A, A);
    g.fill(col);
    g.rect(cx - A + ((h >> 1) & 1) * A, cy, A, A);
    g.fill(darkenColorHex(col, 0.82));
  } else if (kind === 10) { // DECAL_LEAF: 1-2 green pixels
    g.rect(cx, cy, A, A);
    const h = _spHash(seed, 3);
    if (h & 1) g.rect(cx + ((h & 2) ? A : -A), cy + ((h & 4) ? A : 0), A, A);
    g.fill(col);
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

// =====================================================================
// ENV REMAINS LAYER (M8 E10 / E12): stumps, fallen logs and rubble
// footprints are world state (envphys.js envRemains), NOT gore decals.
// They are bucketed by terrain chunk (same key as chunkCache); each chunk
// with remains is baked into its own RenderTexture (art-pixel resolution)
// once per settle-batch and drawn as ONE Sprite, so the per-frame cost is
// constant in the number of felled trees. Shown only while its terrain
// chunk is loaded and in view.
// =====================================================================
const _spRemScorch = [1, 0.8, 0.62, 0.45];

// Pixel line in absolute art-px coords, thickness t; grow > 0 widens every
// run by that many art px on each side (outline pass). Same run merging as
// _pline. Emits rects only (caller fills).
function _spGLine(g, x0, y0, x1, y1, t, grow) {
  const A = ART;
  const dx = x1 - x0, dy = y1 - y0;
  const n = Math.max(Math.abs(dx), Math.abs(dy));
  const o = ((t - 1) >> 1) + grow, tt = t + 2 * grow;
  let rx = 0, ry = 0, rw = 0;
  for (let i = 0; i <= n; i++) {
    const x = n ? x0 + Math.round(dx * i / n) : x0;
    const y = n ? y0 + Math.round(dy * i / n) : y0;
    if (rw > 0 && y === ry) {
      if (x === rx + rw) { rw++; continue; }
      if (x === rx - 1) { rx--; rw++; continue; }
    }
    if (rw > 0) g.rect((rx - o) * A, (ry - o) * A, (rw + tt - 1) * A, tt * A);
    rx = x; ry = y; rw = 1;
  }
  if (rw > 0) g.rect((rx - o) * A, (ry - o) * A, (rw + tt - 1) * A, tt * A);
}

// E10/C: a log lying toward / away from the camera projects to a vertical
// screen segment that reads as a standing post. Its screen-vertical extent
// (relative to the stump) is drawn foreshortened by this factor - the log,
// its crown and the end of the topple animation alike - so it reads as
// lying flat. (The collision capsule keeps the true world length.)
const SP_LOG_VK = 0.7;

// Fallen log lying on the ground from the stump side (ax, ay) to (bx, by)
function _spDrawLog(g, r) {
  const A = ART, iso = CFG.ISO_SCALE;
  const variant = r.variant | 0;
  const sc = _spRemScorch[Math.min(3, r.scorch | 0)];
  const bark = darkenColorHex(r.barkColor || 0x5a3a1e, sc);
  const cut = darkenColorHex(r.cutColor || 0xc8a070, sc);
  // screen-vertical offsets from the stump are foreshortened (SP_LOG_VK)
  const sb = (r.x + r.y) * iso;
  const X1 = Math.round((r.bx - r.by) / A), G1 = Math.round((sb + ((r.bx + r.by) * iso - sb) * SP_LOG_VK) / A);
  // the base end starts a clear art px past the stump so the two read apart
  const sdx = (r.bx - r.by) - (r.ax - r.ay), sdy = ((r.bx + r.by) - (r.ax + r.ay)) * iso * SP_LOG_VK;
  const sdl = Math.max(1e-6, Math.abs(sdx) > Math.abs(sdy) ? Math.abs(sdx) : Math.abs(sdy));
  const X0 = Math.round((r.ax - r.ay) / A + sdx / sdl * 2);
  const G0 = Math.round((sb + ((r.ax + r.ay) * iso - sb) * SP_LOG_VK) / A + sdy / sdl * 2);
  // a log lying toward / away from the camera (steep on screen) is drawn one
  // art px wider and NOT lifted (a lifted vertical log reads as a post
  // standing on its stump); flat logs sit half a diameter above the ground
  const steep = Math.abs(G1 - G0) > Math.abs(X1 - X0);
  const t = Math.max(2, Math.round((r.logR || 7) * 2 / A) - (variant === 1 ? 1 : 0)) + (steep ? 2 : 0);
  const lift = steep ? 0 : t >> 1;
  const Y0 = G0 - lift, Y1 = G1 - lift;
  const o = (t - 1) >> 1;
  const seed = ((r.x * 73856093) ^ (r.y * 19349663)) | 0;
  const len = Math.max(Math.abs(X1 - X0), Math.abs(Y1 - Y0));
  // branch stubs (broad-leaf trees; dead trees get one bare snag)
  const nStubs = variant === 0 ? 2 + (_spHash(seed, 1) & 1) : variant === 2 ? 1 : 0;
  // perpendicular screen side of the stubs: up for flat logs, sideways for steep ones
  const pxs = steep ? 1 : 0, pys = steep ? 0 : 1;

  // ground shadow: a 1-px strip below (flat) or along both sides (steep:
  // the log lies on the ground) of the log
  if (steep) {
    _spGLine(g, X0 + t - o + 1, G0 + 1, X1 + t - o + 1, G1 + 1, 1, 0);
    _spGLine(g, X0 - o - 2, G0 + 1, X1 - o - 2, G1 + 1, 1, 0);
  } else _spGLine(g, X0 + 1, G0 + 2, X1 + 1, G1 + 2, 1, 0);
  g.fill({ color: 0, alpha: 0.3 });
  // outline (log + stubs + end caps)
  _spGLine(g, X0, Y0, X1, Y1, t, 1);
  for (let k = 0; k < nStubs; k++) {
    const h = _spHash(seed, k + 3);
    const f = 0.35 + (h & 255) / 255 * 0.5;
    const sx = Math.round(X0 + (X1 - X0) * f), sy = Math.round(Y0 + (Y1 - Y0) * f);
    const side = (h & 256) ? 1 : -1, l = o + 2 + ((h >> 9) & 1);
    _spGLine(g, sx, sy, sx + side * pxs * l + (steep ? 0 : (h & 512 ? 1 : -1)), sy - pys * l, 1, 1);
  }
  g.fill(0x1a120a);
  // bark body + stubs
  _spGLine(g, X0, Y0, X1, Y1, t, 0);
  for (let k = 0; k < nStubs; k++) {
    const h = _spHash(seed, k + 3);
    const f = 0.35 + (h & 255) / 255 * 0.5;
    const sx = Math.round(X0 + (X1 - X0) * f), sy = Math.round(Y0 + (Y1 - Y0) * f);
    const side = (h & 256) ? 1 : -1, l = o + 2 + ((h >> 9) & 1);
    _spGLine(g, sx, sy, sx + side * pxs * l + (steep ? 0 : (h & 512 ? 1 : -1)), sy - pys * l, 1, 0);
  }
  g.fill(bark);
  // shaded underside (flat) / both flanks (steep: a cylinder lying along
  // the view has its lit top surface in the middle, not a post's lit side)
  if (t > 2) {
    if (steep) {
      _spGLine(g, X0 + t - 1 - o, Y0, X1 + t - 1 - o, Y1, 1, 0);
      _spGLine(g, X0 - o, Y0, X1 - o, Y1, 1, 0);
    } else _spGLine(g, X0, Y0 + t - 1 - o, X1, Y1 + t - 1 - o, 1, 0);
    g.fill(darkenColorHex(bark, 0.68));
  }
  // highlight along the top edge (flat) / the middle of the top (steep)
  if (steep) _spGLine(g, X0 - o + ((t - 1) >> 1), Y0, X1 - o + ((t - 1) >> 1), Y1, 1, 0);
  else _spGLine(g, X0, Y0 - o, X1, Y1 - o, 1, 0);
  g.fill(darkenColorHex(bark, 1.3));
  // bark grain: a few dark pixels along the trunk (+ char spots when
  // scorched); on steep logs short bands ACROSS the trunk (a cylinder seen
  // lying lengthwise, not a post)
  const nGrain = Math.max(2, len >> 2);
  for (let k = 0; k < nGrain; k++) {
    const h = _spHash(seed, k + 20);
    const f = 0.12 + (h & 255) / 255 * 0.76;
    const off = ((h >> 8) % Math.max(1, t - 1)) - o + (t > 2 ? 0 : 0);
    const gx = Math.round(X0 + (X1 - X0) * f) + (steep ? off : 0);
    const gy = Math.round(Y0 + (Y1 - Y0) * f) + (steep ? 0 : off);
    if (steep) g.rect((Math.round(X0 + (X1 - X0) * f) - o + ((h >> 8) % Math.max(1, t - 2))) * A, gy * A, 2 * A, A);
    else g.rect(gx * A, gy * A, ((h >> 12) & 1) ? 2 * A : A, A);
  }
  g.fill((r.scorch | 0) >= 2 ? 0x141010 : darkenColorHex(bark, 0.62));
  // snapped base end: splintered (dark notches + a light splinter), so it
  // reads apart from the stump's cut top
  const ux = X1 - X0, uy = Y1 - Y0, ul = Math.max(1, Math.sqrt(ux * ux + uy * uy));
  const ex = Math.round(ux / ul), ey = Math.round(uy / ul);
  for (let k = -o; k < t - o; k++) {
    if ((_spHash(seed, k + 50) & 1) === 0) continue;
    g.rect((X0 + (steep ? k : 0)) * A, (Y0 + (steep ? 0 : k)) * A, A, A);
  }
  g.fill(0x1a120a);
  g.rect((X0 - ex + (steep ? 0 : 0)) * A, (Y0 - ey) * A, A, A);
  g.fill(cut);
  // cut-wood end cap with a ring at the far end (a felled tree that kept
  // its crown has none: the trunk runs on into the fallen canopy)
  if (!(r.crownR > 0)) {
    const cw = Math.max(1, t - 2), ch = Math.max(1, t - 1);
    const w = steep ? ch : cw, h = steep ? cw : ch;
    const lx = X1 + ex - (w >> 1), ly = Y1 + ey - (h >> 1);
    g.rect((lx - 1) * A, (ly - 1) * A, (w + 2) * A, (h + 2) * A);
    g.fill(0x1a120a);
    g.rect(lx * A, ly * A, w * A, h * A);
    g.fill(cut);
    if (w > 1 || h > 1) {
      g.rect((lx + (w >> 1)) * A, (ly + (h >> 1)) * A, A, A); // heart / ring
      g.fill(darkenColorHex(cut, 0.66));
    }
  }
}

// Snapped stump at the tree base (x, y): bark sides, cut-wood top, ring
function _spDrawStump(g, r) {
  const A = ART, iso = CFG.ISO_SCALE;
  const variant = r.variant | 0;
  const sc = _spRemScorch[Math.min(3, r.scorch | 0)];
  const bark = darkenColorHex(r.barkColor || 0x5a3a1e, sc);
  const cut = darkenColorHex(r.cutColor || 0xc8a070, (r.scorch | 0) >= 2 ? sc * 0.8 : sc);
  const X = Math.round((r.x - r.y) / A), Y = Math.round((r.x + r.y) * iso / A);
  const w = variant === 0 ? Math.max(4, Math.round((r.stumpR || 5) * 2 / A) + 2) : 4;
  const h = variant === 1 ? 3 : 4;           // side height (art px)
  const L = X - (w >> 1), T = Y - h - 1;     // left column, top-face row
  const seed = ((r.x * 73856093) ^ (r.y * 19349663)) | 0;
  // shadow
  g.rect((L + 1) * A, (Y + 1) * A, w * A, A);
  g.fill({ color: 0, alpha: 0.3 });
  // outline: body + rounded top
  g.rect((L - 1) * A, T * A, (w + 2) * A, (Y - T + 1) * A);
  g.rect(L * A, (T - 1) * A, w * A, A);
  g.fill(0x1a120a);
  // bark sides (darker right column)
  g.rect(L * A, (T + 1) * A, w * A, (Y - T) * A);
  g.fill(bark);
  g.rect((L + w - 1) * A, (T + 1) * A, A, (Y - T) * A);
  g.fill(darkenColorHex(bark, 0.68));
  // cut top (2 rows: reads as an ellipse in iso) + ring pixel + heart
  g.rect(L * A, T * A, w * A, A);
  g.rect((L + 1) * A, (T - 1) * A, Math.max(1, w - 2) * A, A);
  g.fill(cut);
  g.rect(L * A, T * A, A, A);
  g.fill(darkenColorHex(cut, 0.75));
  g.rect((L + (w >> 1)) * A, (T - (w > 3 ? 1 : 0)) * A, A, A);
  g.fill(darkenColorHex(cut, 0.6));
  // a jagged bark splinter sticking up where the trunk snapped
  const hs = _spHash(seed, 7);
  const spx = (hs & 1) ? L + w - 1 : L;
  g.rect(spx * A, (T - 1) * A, A, A);
  if (variant !== 1 && (hs & 2)) g.rect(spx * A, (T - 2) * A, A, A);
  g.fill(bark);
}

// Rubble footprint of a shattered boulder / ruin
function _spDrawRubble(g, r) {
  const A = ART, iso = CFG.ISO_SCALE;
  const cx = _spSnap(r.x - r.y), cy = _spSnap((r.x + r.y) * iso);
  const seed = ((r.x * 73856093) ^ (r.y * 19349663)) | 0;
  const ruins = r.type === 'ruins';
  const rad = r.radius || (ruins ? 16 : 10);
  const rx = Math.max(2, Math.round(rad * 1.1 / A)), ry = Math.max(1, Math.round(rx * 0.5));
  const base = darkenColorHex(r.remainColor || 0x62625a, _spRemScorch[Math.min(3, r.scorch | 0)]);
  // dusty footprint
  _spEllRows(g, cx, cy, rx + 1, ry + 1, seed, true);
  g.fill({ color: 0, alpha: 0.2 });
  const n = 4 + rx + (ruins ? 2 : 0);
  // stones: outline pass, two tone fills, highlights (same hashes each pass)
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < n; i++) {
      const h = _spHash(seed, i + 60);
      const x = ((h & 255) / 255 * 2 - 1) * rx, y = (((h >> 8) & 255) / 255 * 2 - 1) * ry;
      const px = cx + Math.round(x) * A, py = cy + Math.round(y) * A;
      const w = 1 + ((h >> 16) & 1) + (ruins && ((h >> 19) & 1) ? 1 : 0), hh = 1 + (((h >> 17) & 3) === 0 ? 1 : 0);
      const tone = (h >> 18) & 1;
      if (pass === 0) g.rect(px - A, py - A, (w + 2) * A, (hh + 2) * A);
      else if (pass === 1 && !tone) g.rect(px, py, w * A, hh * A);
      else if (pass === 2 && tone) g.rect(px, py, w * A, hh * A);
      else if (pass === 3 && w > 1) g.rect(px, py, A, A);
    }
    if (pass === 0) g.fill(0x1c1c18);
    else if (pass === 1) g.fill(base);
    else if (pass === 2) g.fill(darkenColorHex(base, 0.78));
    else g.fill(darkenColorHex(base, 1.3));
  }
  if (ruins) {
    // two low broken wall stubs
    for (let i = 0; i < 2; i++) {
      const h = _spHash(seed, i + 90);
      const px = cx + ((h % (rx + 1)) - (rx >> 1)) * A, py = cy - ((h >> 6) & 1) * A;
      const hh = 1 + ((h >> 4) & 1);
      g.rect(px - A, py - (hh + 1) * A, 4 * A, (hh + 2) * A);
      g.fill(0x22221e);
      g.rect(px, py - hh * A, 2 * A, hh * A);
      g.fill(base);
      g.rect(px, py - hh * A, 2 * A, A);
      g.fill(darkenColorHex(base, 1.3));
    }
  }
}

// Fallen crown (E10 polish): a felled tree keeps its canopy, lying
// flattened on the ground just past the far end of its log (logic fields
// crownX, crownY, crownR, crownColor, crownVariant). Broadleaf: an
// iso-ellipse footprint (screen width ~2R, height ~1.2 R x ISO) of lumpy
// leaf masses; pine: a narrower spiky cone lying along the fall direction,
// with whorl lines. Outlined, 3 flat tones + light leaf clumps, a few loose
// leaves. Blobs are merged into one span per row and pass (~4 rects/row).
const SP_CR_ROWS = 64;
const _spCrL = new Int16Array(SP_CR_ROWS), _spCrR = new Int16Array(SP_CR_ROWS);
function _spCrownBlob(n, o, bx, by, brx, bry) {
  const inv = 1 / (bry + 0.5);
  for (let j = -bry; j <= bry; j++) {
    const k = by + j + o;
    if (k < 0 || k >= n) continue;
    const t = j * inv;
    const w = Math.round(brx * Math.sqrt(Math.max(0, 1 - t * t)));
    if (bx - w < _spCrL[k]) _spCrL[k] = bx - w;
    if (bx + w > _spCrR[k]) _spCrR[k] = bx + w;
  }
}
function _spCrownHas(n, k) { return k >= 0 && k < n && _spCrL[k] <= _spCrR[k]; }

function _spDrawCrown(g, r) {
  const A = ART, iso = CFG.ISO_SCALE;
  const pine = (r.crownVariant | 0) === 1;
  const col = r.crownColor || 0x2f5a22;
  const R = Math.min(r.crownR, 80);
  const sb = (r.x + r.y) * iso; // stump base: vertical offsets foreshortened like the log
  const cx = Math.round((r.crownX - r.crownY) / A), cy = Math.round((sb + ((r.crownX + r.crownY) * iso - sb) * SP_LOG_VK) / A);
  const seed = ((r.crownX * 73856093) ^ (r.crownY * 19349663)) | 0;
  // screen projection (art px per world unit) of the fall direction
  let fx = r.fallDirX, fy = r.fallDirY;
  if (!(fx * fx + fy * fy > 1e-6)) { fx = 1; fy = 0; }
  const dsx = (fx - fy) / A, dsy = (fx + fy) * iso * SP_LOG_VK / A;
  const rx = Math.max(3, Math.round(R / A)), ry = Math.max(2, Math.round(R * iso * 0.6 / A));
  // silhouette: per-row spans [L, R] (art px relative to cx), rows -H..H
  const H = Math.min((SP_CR_ROWS >> 1) - 2, pine ? Math.ceil(Math.abs(dsy) * R * 0.75 + ry) + 2 : ry + 2);
  const n = 2 * H + 1, o = H;
  _spCrL.fill(32767, 0, n); _spCrR.fill(-32768, 0, n);
  const NT = 4; // pine tiers
  if (pine) {
    // a cone lying along the fall direction: tiers shrink toward the tip
    for (let k = 0; k < NT; k++) {
      const t = (-0.5 + k * 0.4) * R;
      const w = Math.max(1, Math.round(R * (0.62 - 0.12 * k) / A));
      _spCrownBlob(n, o, Math.round(dsx * t), Math.round(dsy * t), w, Math.max(1, Math.round(w * iso * 1.2)));
    }
    // needle spikes: rows alternately pushed out / pulled in
    for (let k = 0; k < n; k++) {
      if (_spCrL[k] > _spCrR[k]) continue;
      const h = _spHash(seed, k + 5);
      if (k & 1) { _spCrL[k] -= 1 + (h & 1); _spCrR[k] += 1 + ((h >> 1) & 1); }
      else { _spCrL[k] += 1; _spCrR[k] -= 1; }
      if (_spCrL[k] > _spCrR[k]) { _spCrL[k] = 32767; _spCrR[k] = -32768; }
    }
  } else {
    // a lumpy canopy: a core ellipse plus a ring of leaf masses
    _spCrownBlob(n, o, 0, 0, Math.round(rx * 0.6), Math.round(ry * 0.7));
    const nb = 7;
    for (let i = 0; i < nb; i++) {
      const h = _spHash(seed, i + 9);
      const a = (i + ((h & 255) / 255 - 0.5) * 0.6) * (Math.PI * 2 / nb);
      const bx = Math.round(Math.cos(a) * rx * 0.6), by = Math.round(Math.sin(a) * ry * 0.56);
      const s = 0.3 + ((h >> 8) & 255) / 255 * 0.2;
      _spCrownBlob(n, o, bx, by, Math.max(1, Math.round(rx * s)), Math.max(1, Math.round(ry * (s + 0.16))));
    }
  }
  const top = cy - o;
  const light = darkenColorHex(col, 1.32), dark = darkenColorHex(col, 0.5);
  // ground shadow (offset down-right)
  for (let k = 0; k < n; k++) {
    if (_spCrownHas(n, k)) g.rect((cx + _spCrL[k] + 1) * A, (top + k + 2) * A, (_spCrR[k] - _spCrL[k] + 1) * A, A);
  }
  g.fill({ color: 0, alpha: 0.28 });
  // outline: the silhouette grown by one art px in every direction
  for (let k = -1; k <= n; k++) {
    let l = 32767, rr = -32768;
    for (let d = -1; d <= 1; d++) {
      if (_spCrownHas(n, k + d)) { l = Math.min(l, _spCrL[k + d]); rr = Math.max(rr, _spCrR[k + d]); }
    }
    if (l > rr) continue;
    g.rect((cx + l - 1) * A, (top + k) * A, (rr - l + 3) * A, A);
  }
  g.fill(darkenColorHex(col, 0.38));
  // shaded underside: the whole silhouette in the dark tone
  for (let k = 0; k < n; k++) {
    if (_spCrownHas(n, k)) g.rect((cx + _spCrL[k]) * A, (top + k) * A, (_spCrR[k] - _spCrL[k] + 1) * A, A);
  }
  g.fill(darkenColorHex(col, 0.7));
  // lit body: silhouette minus a bottom rim and a 1-px right rim
  const s = pine ? 1 : 2;
  for (let k = 0; k < n; k++) {
    if (!_spCrownHas(n, k) || !_spCrownHas(n, k + s)) continue;
    const l = Math.max(_spCrL[k], _spCrL[k + s]), rr = Math.min(_spCrR[k], _spCrR[k + s]) - 1;
    if (rr >= l) g.rect((cx + l) * A, (top + k) * A, (rr - l + 1) * A, A);
  }
  g.fill(col);
  // dark pass: leaf-clump undersides / pine whorls (char when scorched)
  const nc = Math.max(3, Math.round(rx * ry / (pine ? 6 : 5)));
  if (pine) {
    // whorl lines across the cone between tiers (perpendicular on screen)
    const dl = Math.max(1e-6, Math.sqrt(dsx * dsx + dsy * dsy));
    const px = -dsy / dl, py = dsx / dl;
    for (let k = 0; k < NT - 1; k++) {
      const t = (-0.3 + k * 0.4) * R;
      const w = R * (0.5 - 0.12 * k) / A;
      const mx = cx + dsx * t, my = cy + dsy * t;
      _spGLine(g, Math.round(mx - px * w * 0.7), Math.round(my - py * w * 0.35),
        Math.round(mx + px * w * 0.7), Math.round(my + py * w * 0.35), 1, 0);
    }
  } else {
    for (let i = 0; i < nc; i++) {
      const h = _spHash(seed, i + 30);
      const k = 1 + (h % Math.max(1, n - 3));
      if (!_spCrownHas(n, k + 2) || !_spCrownHas(n, k + 2 + s)) continue;
      const l = Math.max(_spCrL[k + 2], _spCrL[k + 2 + s]) + 1, rr = Math.min(_spCrR[k + 2], _spCrR[k + 2 + s]) - 2;
      if (rr <= l) continue;
      g.rect((cx + l + ((h >>> 8) % (rr - l + 1))) * A, (top + k + 2) * A, 2 * A, A);
    }
  }
  g.fill((r.scorch | 0) >= 2 ? 0x161410 : dark);
  // light pass: rounded leaf clumps (broadleaf) / needle tufts (pine) on the
  // lit body, plus a few loose leaves on the ground around the crown
  for (let i = 0; i < nc; i++) {
    const h = _spHash(seed, i + 30);
    const k = 1 + (h % Math.max(1, n - 3));
    if (pine) {
      if (!_spCrownHas(n, k) || !_spCrownHas(n, k + s)) continue;
      const l = Math.max(_spCrL[k], _spCrL[k + s]), rr = Math.min(_spCrR[k], _spCrR[k + s]) - 2;
      if (rr <= l) continue;
      g.rect((cx + l + ((h >>> 8) % (rr - l + 1))) * A, (top + k) * A, 2 * A, A);
      continue;
    }
    if (!_spCrownHas(n, k + 2) || !_spCrownHas(n, k + 2 + s)) continue;
    const l = Math.max(_spCrL[k + 2], _spCrL[k + 2 + s]) + 1, rr = Math.min(_spCrR[k + 2], _spCrR[k + 2 + s]) - 2;
    if (rr <= l) continue;
    const x = l + ((h >>> 8) % (rr - l + 1));
    if (_spCrownHas(n, k) && x >= _spCrL[k] && x + 1 <= _spCrR[k]) g.rect((cx + x) * A, (top + k) * A, 2 * A, A);
    if (x - 1 >= _spCrL[k + 1] && x + 1 <= _spCrR[k + 1]) g.rect((cx + x - 1) * A, (top + k + 1) * A, 3 * A, A);
  }
  const nl = 3 + (seed & 1);
  for (let i = 0; i < nl; i++) {
    const h = _spHash(seed, i + 90);
    const a = (h & 1023) / 1024 * Math.PI * 2;
    const k = Math.round(Math.sin(a) * (ry + 2 + ((h >> 10) & 1)));
    const x = Math.round(Math.cos(a) * (rx + 2 + ((h >> 11) & 1)) + (pine ? dsx * R * 0.1 : 0));
    g.rect((cx + x) * A, (cy + k + 1) * A, A, A);
  }
  g.fill(light);
}

function _spRemainDepth(r) { return r.x + r.y; }
function _spRemainCmp(a, b) { return _spRemainDepth(a) - _spRemainDepth(b); }

// Layer bookkeeping. envRemains only grows during a round (reset empties
// it), so new entries are bucketed incrementally into persistent per-chunk
// buckets (numeric key, no per-item allocs); only the touched chunk goes
// dirty. A dirty chunk is rebuilt once its bakes have paused for
// SP_ENVL_QUIET_N frames (or after SP_ENVL_MAX_LAG frames while bakes keep
// trickling in), and never twice within SP_ENVL_REBUILD_N frames: a BFG's
// burst of bakes costs a few rebuilds, not one per bake. Until
// the layer has drawn a felled tree (r._drawnInLayer) its fallen sprite
// stays visible, so a late rebuild never shows a gap. A chunk's baked
// texture + sprite are destroyed when its terrain chunk unloads and
// re-baked from its bucket when it returns.
//
// E12 bake: one shared build Graphics (never in the scene) is filled with
// the chunk's remains, measured, and rendered once into the chunk's
// RenderTexture, sized to the remains' screen bounds (+ padding) and
// aligned to the art-pixel grid. The texture is at 1/ART resolution
// (one texel per art pixel, nearest sampling): every remain rect lies on
// the ART grid, so at x3 it is pixel-identical to drawing the Graphics
// live, and at x1/x2/x4 it reads like any other art-pixel sprite.
const SP_ENVL_REBUILD_N = 6;     // frames between rebuilds of one chunk (~0.1 s)
const SP_ENVL_QUIET_N = 6;       // rebuild once no remain was added for this many frames
const SP_ENVL_MAX_LAG = 30;      // ...or once dirty this long (~0.5 s) while bakes continue
const SP_ENVL_BUILDS_MAX = 2;    // chunk rebuilds per frame at most
const SP_ENVL_SWEEP_N = 30;      // unload check at least every N frames
const SP_ENVL_RES = 1 / ART;     // bake resolution: one texel per art pixel
const SP_ENVL_PAD = 2 * ART;     // padding around the measured remains bounds
const SP_ENVL_RT_STEP = 32 * ART; // RT size granularity (re-bakes reuse the RT while it fits)
function _spEnvKey(cx, cy) { return cx * 100003 + cy; }
function _spRemainSig(r) {
  let s = (r.x * 7 | 0) + (r.y * 13 | 0) + (r.remain === 'log' ? 1 : 2) + (r.scorch | 0) * 101 + (r.variant | 0) * 7919 +
    (r.logGone === true ? 104729 : 0);
  if (r.crownR > 0) s += (r.crownR * 17 | 0) + (r.crownColor | 0) + (r.crownX * 3 | 0) + (r.crownY * 5 | 0) + (r.crownVariant | 0);
  return s | 0;
}

function _spEnvLayerNew() {
  return { version: -1, map: new Map(), list: [], count: 0, first: null, last: null,
    frame: 0, ccSize: -1, rebuilds: 0 };
}

// Shared bake source: one Graphics under an identity root, never in the
// scene (created once, survives re-init like the textures).
let _spEnvBakeRoot = null, _spEnvBakeG = null;

function _spEnvLayerDrawItems(g, items) {
  if (items.length > 1) items.sort(_spRemainCmp);
  for (let i = 0; i < items.length; i++) {
    const r = items[i];
    if (r.remain === 'log' && r.logGone === true) {
      _spDrawStump(g, r); // E11: the log was splintered; the stump stays
    } else if (r.remain === 'log') {
      _spDrawLog(g, r);
      // the crown overlaps the log's far end (the trunk runs into it)
      if (r.crownR > 0) _spDrawCrown(g, r);
      _spDrawStump(g, r);
    } else {
      _spDrawRubble(g, r);
    }
  }
}

function _spEnvLayerFreeTex(c) {
  if (c.sp) _spDestroy(c.sp);
  if (c.rt && !c.rt.destroyed) c.rt.destroy(true);
  c.sp = null; c.rt = null;
}

// Bake one chunk: build its remains into the shared Graphics, render that
// once into the chunk's RenderTexture, show it through the chunk's Sprite.
function _spEnvLayerBuild(L, c) {
  if (_spEnvBakeG === null || _spEnvBakeG.destroyed) {
    _spEnvBakeRoot = new PIXI.Container();
    _spEnvBakeG = new PIXI.Graphics();
    _spEnvBakeRoot.addChild(_spEnvBakeG);
  }
  const g = _spEnvBakeG;
  g.clear();
  const items = c.items;
  _spEnvLayerDrawItems(g, items);
  // measured screen bounds of everything drawn, snapped out to the art grid
  const b = g.getLocalBounds();
  const A = ART;
  const x0 = Math.floor((b.minX - SP_ENVL_PAD) / A) * A, y0 = Math.floor((b.minY - SP_ENVL_PAD) / A) * A;
  const x1 = Math.ceil((b.maxX + SP_ENVL_PAD) / A) * A, y1 = Math.ceil((b.maxY + SP_ENVL_PAD) / A) * A;
  const w = Math.max(A, x1 - x0), h = Math.max(A, y1 - y0);
  // reuse the chunk's RT while it fits (and is not far too big), else re-allocate
  let rt = c.rt;
  if (rt === null || rt.destroyed || rt.width < w || rt.height < h ||
      rt.width > w + 4 * SP_ENVL_RT_STEP || rt.height > h + 4 * SP_ENVL_RT_STEP) {
    const old = rt;
    rt = PIXI.RenderTexture.create({
      width: Math.ceil(w / SP_ENVL_RT_STEP) * SP_ENVL_RT_STEP,
      height: Math.ceil(h / SP_ENVL_RT_STEP) * SP_ENVL_RT_STEP,
      resolution: SP_ENVL_RES, scaleMode: 'nearest', antialias: false,
    });
    if (c.sp) c.sp.texture = rt;
    if (old !== null && !old.destroyed) old.destroy(true);
    c.rt = rt;
  }
  g.position.set(-x0, -y0);
  renderer.render({ container: _spEnvBakeRoot, target: rt, clear: true, clearColor: [0, 0, 0, 0] });
  g.clear(); // drop the source geometry: the RT holds the pixels
  let sp = c.sp;
  if (sp === null) {
    sp = new PIXI.Sprite(rt);
    sp.zIndex = SP_Z_ENVL; sp.visible = false;
    sp.eventMode = 'none';
    worldContainer.addChild(sp);
    c.sp = sp;
  }
  sp.position.set(x0, y0);
  // the baked texture now shows every remain of the chunk: hand off from
  // the fallen tree sprites (no gap, no double draw)
  for (let i = 0; i < items.length; i++) items[i]._drawnInLayer = true;
  // screen bounds (view culling) = the sprite's extent
  c.x0 = x0; c.x1 = x0 + rt.width; c.y0 = y0; c.y1 = y0 + rt.height;
  c.dirty = false;
  c.built = L.frame;
  L.rebuilds++;
}

// Terrain chunk gone: free the texture + sprite, keep the bucket for its return
function _spEnvLayerUnload(c) {
  _spEnvLayerFreeTex(c);
  c.dirty = true;
  c.built = c.since = c.touched = -1e9; // rebuild as soon as it is back
  for (let i = 0; i < c.items.length; i++) c.items[i]._drawnInLayer = false;
}

function _spEnvLayerClear(L) {
  for (let i = 0; i < L.list.length; i++) {
    const c = L.list[i];
    _spEnvLayerFreeTex(c);
    for (let j = 0; j < c.items.length; j++) c.items[j]._drawnInLayer = false;
  }
  L.map.clear();
  L.list.length = 0;
  L.count = 0; L.first = null; L.last = null;
}

function _spEnvLayerAdd(L, r, cs) {
  r._drawnInLayer = false;
  if (r.remain !== 'log' && r.remain !== 'rubble') return;
  const cx = Math.floor(r.x / cs), cy = Math.floor(r.y / cs);
  const nk = _spEnvKey(cx, cy);
  let c = L.map.get(nk);
  if (c === undefined) {
    c = { nk, skey: cx + ',' + cy, sp: null, rt: null, items: [], sig: 0, dirty: false, built: -1e9,
      since: 0, touched: 0, x0: 0, x1: 0, y0: 0, y1: 0 };
    L.map.set(nk, c);
    L.list.push(c);
  }
  c.items.push(r);
  c.sig = (c.sig + _spRemainSig(r)) | 0;
  _spEnvLayerTouch(L, c);
}

function _spEnvLayerTouch(L, c) {
  if (!c.dirty) { c.dirty = true; c.since = L.frame; }
  c.touched = L.frame;
}

// Bring the buckets up to date with envRemains (incremental)
function _spEnvLayerIngest(L) {
  const n = envRemains.length;
  // shrunk or replaced contents (new round): start over
  if (n < L.count || (L.count > 0 && (envRemains[0] !== L.first || envRemains[L.count - 1] !== L.last))) {
    _spEnvLayerClear(L);
  }
  if (n > L.count) {
    const cs = CFG.CHUNK_SIZE * CFG.TILE_SIZE;
    for (let i = L.count; i < n; i++) _spEnvLayerAdd(L, envRemains[i], cs);
    L.count = n; L.first = envRemains[0]; L.last = envRemains[n - 1];
    // no early return: an existing remain may have changed in the SAME frame
    // (e.g. a log splintered while another tree baked), so re-sign as well
  }
  // An existing remain changed (e.g. logGone): re-sign the buckets (numeric
  // pass, no allocs) and dirty what differs.
  for (let i = 0; i < L.list.length; i++) {
    const c = L.list[i];
    let sig = 0;
    for (let j = 0; j < c.items.length; j++) sig = (sig + _spRemainSig(c.items[j])) | 0;
    if (sig !== c.sig) { c.sig = sig; _spEnvLayerTouch(L, c); }
  }
}

function _spRenderEnvLayer() {
  const L = _sp.envL;
  if (!L || typeof envRemains === 'undefined') return;
  L.frame++;
  if (envRemainsVersion !== L.version) {
    L.version = envRemainsVersion;
    _spEnvLayerIngest(L);
  }
  const hasCC = typeof chunkCache !== 'undefined';
  // terrain chunks come and go: release the remains of unloaded ones
  if (hasCC && (chunkCache.size !== L.ccSize || L.frame % SP_ENVL_SWEEP_N === 0)) {
    L.ccSize = chunkCache.size;
    for (let i = 0; i < L.list.length; i++) {
      const c = L.list[i];
      if (c.sp && !chunkCache.has(c.skey)) _spEnvLayerUnload(c);
    }
  }
  let budget = SP_ENVL_BUILDS_MAX;
  for (let i = 0; i < L.list.length; i++) {
    const c = L.list[i];
    if (hasCC && !chunkCache.has(c.skey)) continue; // unloaded: no texture
    if (c.dirty && budget > 0 && L.frame - c.built >= SP_ENVL_REBUILD_N &&
        (L.frame - c.touched >= SP_ENVL_QUIET_N || L.frame - c.since >= SP_ENVL_MAX_LAG)) {
      _spEnvLayerBuild(L, c);
      budget--;
    }
    if (c.sp) c.sp.visible = c.x1 > _sp.vx0 && c.x0 < _sp.vx1 && c.y1 > _sp.vy0 && c.y0 < _sp.vy1;
  }
}

// Test hook (E10/E12): env remains layer. chunks = live per-chunk baked
// sprites, buckets = chunks holding remains (loaded or not), draws =
// visible now, rtBytes = GPU memory of the baked textures (estimate).
function envLayerStats() {
  const L = _sp.envL;
  if (!L) return { chunks: 0, buckets: 0, draws: 0, rebuilds: 0, dirty: 0, rtBytes: 0 };
  let vis = 0, live = 0, dirty = 0, bytes = 0;
  for (let i = 0; i < L.list.length; i++) {
    const c = L.list[i];
    if (c.sp) { live++; if (c.sp.visible) vis++; }
    if (c.rt) bytes += c.rt.source.pixelWidth * c.rt.source.pixelHeight * 4;
    if (c.dirty) dirty++;
  }
  return { chunks: live, buckets: L.list.length, draws: vis, rebuilds: L.rebuilds, dirty, rtBytes: bytes };
}
