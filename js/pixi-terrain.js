// =====================================================================
// PIXI TERRAIN - WebGL-based terrain generation using PixiJS
// =====================================================================

// Terrain tile texture cache (stores PIXI.Texture instead of HTMLCanvasElement)
const pixiTerrainCache = {};

/**
 * Generate a single terrain tile as a PixiJS Texture using PIXI.Graphics
 * @param {string} type - Terrain type: grass, dirt, sand, dark, water, hill
 * @returns {PIXI.Texture} - Generated texture for the terrain tile
 */
function getPixiTerrainTile(type) {
  if (pixiTerrainCache[type]) return pixiTerrainCache[type];

  const sz = CFG.TILE_SIZE;
  const hw = sz, hh = sz * CFG.ISO_SCALE;
  const cx = sz, cy = hh;

  // Diamond point-in-diamond test: returns true if (px,py) is inside the isometric diamond
  function inDiamond(px, py) {
    return Math.abs(px - cx) / hw + Math.abs(py - cy) / hh <= 1;
  }

  // Create graphics object for drawing
  const graphics = new PIXI.Graphics();

  // Define diamond clipping path (isometric tile shape)
  graphics.moveTo(cx, cy - hh);
  graphics.lineTo(cx + hw, cy);
  graphics.lineTo(cx, cy + hh);
  graphics.lineTo(cx - hw, cy);
  graphics.closePath();

  // Fill base color and texture based on type
  if (type === 'grass') {
    graphics.fill(0x44aa66);
    // Add procedural noise texture (clipped to diamond)
    for (let i = 0; i < 40; i++) {
      const x = Math.random() * sz * 2;
      const y = Math.random() * hh * 2;
      if (!inDiamond(x, y)) continue;
      const r = 50 + Math.random() * 30 | 0;
      const g = 130 + Math.random() * 50 | 0;
      const b = 50 + Math.random() * 30 | 0;
      graphics.rect(x, y, 2 + Math.random() * 3, 1 + Math.random() * 2);
      graphics.alpha = 0.4;
      graphics.fill((r << 16) | (g << 8) | b);
      graphics.alpha = 1;
    }
  } else if (type === 'dirt') {
    graphics.fill(0x887755);
    for (let i = 0; i < 30; i++) {
      const x = Math.random() * sz * 2;
      const y = Math.random() * hh * 2;
      if (!inDiamond(x, y)) continue;
      const r = 120 + Math.random() * 40 | 0;
      const g = 90 + Math.random() * 30 | 0;
      const b = 50 + Math.random() * 20 | 0;
      graphics.rect(x, y, 2 + Math.random() * 4, 1 + Math.random() * 3);
      graphics.alpha = 0.3;
      graphics.fill((r << 16) | (g << 8) | b);
      graphics.alpha = 1;
    }
  } else if (type === 'sand') {
    graphics.fill(0xccaa88);
    for (let i = 0; i < 20; i++) {
      const x = Math.random() * sz * 2;
      const y = Math.random() * hh * 2;
      if (!inDiamond(x, y)) continue;
      const r = 200 + Math.random() * 40 | 0;
      const g = 170 + Math.random() * 30 | 0;
      const b = 100 + Math.random() * 30 | 0;
      graphics.rect(x, y, 1 + Math.random() * 3, 1 + Math.random() * 2);
      graphics.alpha = 0.3;
      graphics.fill((r << 16) | (g << 8) | b);
      graphics.alpha = 1;
    }
  } else if (type === 'dark') {
    graphics.fill(0x335544);
    for (let i = 0; i < 15; i++) {
      const x = Math.random() * sz * 2;
      const y = Math.random() * hh * 2;
      if (!inDiamond(x, y)) continue;
      const r = 30 + Math.random() * 20 | 0;
      const g = 50 + Math.random() * 20 | 0;
      const b = 40 + Math.random() * 20 | 0;
      graphics.rect(x, y, 2 + Math.random() * 3, 1 + Math.random() * 2);
      graphics.alpha = 0.3;
      graphics.fill((r << 16) | (g << 8) | b);
      graphics.alpha = 1;
    }
  } else if (type === 'water') {
    // Base water color only - animated overlay handles detail
    graphics.fill(0x1e4d6d);
  } else if (type === 'hill') {
    // Elevated grassy terrain - slightly darker/richer green than regular grass
    graphics.fill(0x55aa44);
    // Earthy texture variation (clipped to diamond)
    for (let i = 0; i < 35; i++) {
      const x = Math.random() * sz * 2;
      const y = Math.random() * hh * 2;
      if (!inDiamond(x, y)) continue;
      const r = 55 + Math.random() * 35 | 0;
      const g = 110 + Math.random() * 50 | 0;
      const b = 35 + Math.random() * 30 | 0;
      graphics.rect(x, y, 2 + Math.random() * 4, 1 + Math.random() * 2);
      graphics.alpha = 0.35;
      graphics.fill((r << 16) | (g << 8) | b);
      graphics.alpha = 1;
    }
    // Rocky patches (clipped to diamond)
    for (let i = 0; i < 5; i++) {
      const x = Math.random() * sz * 2;
      const y = Math.random() * hh * 2;
      if (!inDiamond(x, y)) continue;
      const r = 100 + Math.random() * 30 | 0;
      const g = 95 + Math.random() * 25 | 0;
      const b = 80 + Math.random() * 20 | 0;
      graphics.ellipse(x, y, 4 + Math.random() * 6, 2 + Math.random() * 3);
      graphics.alpha = 0.25;
      graphics.fill((r << 16) | (g << 8) | b);
      graphics.alpha = 1;
    }
  }

  // Draw border stroke
  graphics.moveTo(cx, cy - hh);
  graphics.lineTo(cx + hw, cy);
  graphics.lineTo(cx, cy + hh);
  graphics.lineTo(cx - hw, cy);
  graphics.closePath();
  graphics.alpha = 0.1;
  graphics.stroke({ width: 0.5, color: 0x000000 });
  graphics.alpha = 1;

  // Generate texture with explicit bounds to ensure consistent tile size
  const textureBounds = new PIXI.Rectangle(0, 0, sz * 2, hh * 2);
  const texture = app.renderer.generateTexture({ target: graphics, frame: textureBounds });
  pixiTerrainCache[type] = texture;

  // Clean up graphics object
  graphics.destroy();

  return texture;
}

/**
 * Initialize all terrain tile textures
 */
function initPixiTerrain() {
  ['grass', 'dirt', 'sand', 'dark', 'water', 'hill'].forEach(t => getPixiTerrainTile(t));
  console.log('[PIXI-TERRAIN] All terrain textures generated');
}

/**
 * Generate a chunk of terrain as a PixiJS Sprite with RenderTexture
 * @param {number} cx - Chunk X coordinate
 * @param {number} cy - Chunk Y coordinate
 */
function generatePixiChunk(cx, cy) {
  const key = `${cx},${cy}`;
  if (chunkCache.has(key)) return;

  const sz = CFG.CHUNK_SIZE;
  const ts = CFG.TILE_SIZE;
  const chunkWidth = sz * ts * 2 + ts * 2;
  const chunkHeight = sz * ts * CFG.ISO_SCALE * 2 + ts * 2;

  // Create a container to render the chunk into
  const chunkContainer = new PIXI.Container();

  // Render terrain tiles
  for (let ty = 0; ty < sz; ty++) {
    for (let tx = 0; tx < sz; tx++) {
      const worldTx = cx * sz + tx;
      const worldTy = cy * sz + ty;
      const type = getTerrainTypeAt(worldTx * ts, worldTy * ts);
      const texture = getPixiTerrainTile(type);
      const sp = toScreen(tx * ts, ty * ts);

      const sprite = new PIXI.Sprite(texture);
      sprite.x = sp.x + sz * ts - ts;
      sprite.y = sp.y;
      chunkContainer.addChild(sprite);
    }
  }

  // Add decorations (grass blades, rocks)
  const rng = seededRand(cx * 73856093 + cy * 19349663);
  const decorGraphics = new PIXI.Graphics();

  for (let i = 0; i < sz * 5; i++) {
    const lx = rng() * sz * ts;
    const ly = rng() * sz * ts;
    const sp = toScreen(lx, ly);
    const gx = sp.x + sz * ts - ts;
    const gy = sp.y;

    if (rng() < 0.5) {
      // Grass blades
      const r = 40 + rng() * 40 | 0;
      const g = 100 + rng() * 50 | 0;
      const b = 30 + rng() * 30 | 0;
      decorGraphics.moveTo(gx + rng() * 6 - 3, gy + 4);
      decorGraphics.quadraticCurveTo(gx + rng() * 8 - 4, gy - 4 - rng() * 6, gx + rng() * 6 - 3, gy - 6 - rng() * 4);
      decorGraphics.alpha = 0.6;
      decorGraphics.stroke({ width: 1, color: (r << 16) | (g << 8) | b });
      decorGraphics.alpha = 1;
    } else {
      // Small pebbles
      const r = 100 + rng() * 40 | 0;
      const g = 95 + rng() * 30 | 0;
      const b = 80 + rng() * 20 | 0;
      decorGraphics.ellipse(gx, gy, 2 + rng() * 3, 1 + rng() * 2);
      decorGraphics.alpha = 0.5;
      decorGraphics.fill((r << 16) | (g << 8) | b);
      decorGraphics.alpha = 1;
    }
  }

  chunkContainer.addChild(decorGraphics);

  // Render to texture
  const renderTexture = PIXI.RenderTexture.create({
    width: chunkWidth,
    height: chunkHeight
  });
  app.renderer.render({
    container: chunkContainer,
    target: renderTexture
  });

  // Create sprite from render texture - use isometric projection for correct positioning
  const chunkSprite = new PIXI.Sprite(renderTexture);
  const chunkOrigin = toScreen(cx * sz * ts, cy * sz * ts);
  chunkSprite.x = chunkOrigin.x - sz * ts;
  chunkSprite.y = chunkOrigin.y;

  // Cache the sprite
  chunkSprite._cx = cx; chunkSprite._cy = cy;
  chunkCache.set(key, chunkSprite);

  // Add to terrain container
  terrainContainer.addChild(chunkSprite);

  // Clean up temporary container
  chunkContainer.destroy({ children: true });

  // Bake this chunk's water camo once (P1)
  bakeChunkWater(cx, cy);

  // Spawn environmental objects
  if (!envChunks.has(key)) {
    envChunks.add(key);
    const rng2 = seededRand(cx * 12345 + cy * 67890);
    // E7: stable per-chunk ids (same seed -> same objects in the same order)
    let envN = 0;
    const addEnv = (o) => { o.id = key + '#' + (envN++); envObjects.push(o); };
    const chunkWorldX = cx * sz * ts;
    const chunkWorldY = cy * sz * ts;
    const forestDensity = (fbm(chunkWorldX * 0.001, chunkWorldY * 0.001, 3) + 0.5);
    const isForest = forestDensity > 0.5;
    // E1: ~30% more placed trees than before (the original counts x density;
    // the E0 rendered-tile check rejects slightly fewer, hence 1.26)
    const numTrees = Math.floor((isForest ? 30 + rng2() * 20 : 5 + rng2() * 12) * CFG.ENV_TREE_DENSITY);
    const numRocks = Math.floor(3 + rng2() * 6);
    const numMilitary = Math.floor(rng2() * 3);
    const numFlowers = Math.floor(rng2() * 5);

    // Trees and bushes
    for (let i = 0; i < numTrees; i++) {
      const ox = (cx * sz + rng2() * sz) * ts;
      const oy = (cy * sz + rng2() * sz) * ts;
      if (Math.abs(ox) < 150 && Math.abs(oy) < 150) continue;
      // E0: trunk and base must stand on a RENDERED land tile (canopies may overhang)
      if (baseOnWater(ox, oy, 12)) continue;
      const treeType = rng2();
      if (treeType < 0.5) {
        addEnv({ x: ox, y: oy, type: 'tree', radius: 31 + rng2() * 29, height: 60 + rng2() * 55, collision: 8, createdAt: -1 });
      } else if (treeType < 0.75) {
        addEnv({ x: ox, y: oy, type: 'pine', radius: 22 + rng2() * 20, height: 66 + rng2() * 44, collision: 7, createdAt: -1 });
      } else if (treeType < 0.9) {
        addEnv({ x: ox, y: oy, type: 'bush', radius: 12 + rng2() * 14, createdAt: -1 });
      } else {
        addEnv({ x: ox, y: oy, type: 'deadtree', height: 30 + rng2() * 25, createdAt: -1 });
      }
    }

    // Rocks
    for (let i = 0; i < numRocks; i++) {
      const ox = (cx * sz + rng2() * sz) * ts;
      const oy = (cy * sz + rng2() * sz) * ts;
      if (Math.abs(ox) < 150 && Math.abs(oy) < 150) continue;
      if (baseOnWater(ox, oy, 20)) continue; // E0: rocks/boulders need a dry base too
      const isHill = renderedTerrainAt(ox, oy) === 'hill';
      const rockSize = rng2();
      if (rockSize < 0.35) {
        addEnv({ x: ox, y: oy, type: 'rock', radius: 6 + rng2() * 8, collision: 6, createdAt: -1 });
      } else if (rockSize < 0.7 || isHill) {
        addEnv({ x: ox, y: oy, type: 'boulder', radius: 14 + rng2() * 16, collision: 14, createdAt: -1 });
      } else {
        addEnv({ x: ox, y: oy, type: 'rockcluster', radius: 10 + rng2() * 10, createdAt: -1 });
      }
    }

    // Flowers
    for (let i = 0; i < numFlowers; i++) {
      const ox = (cx * sz + rng2() * sz) * ts;
      const oy = (cy * sz + rng2() * sz) * ts;
      const terrain = renderedTerrainAt(ox, oy);
      if (terrain === 'water' || terrain === 'dark') continue;
      addEnv({ x: ox, y: oy, type: 'flowers', radius: 4 + rng2() * 6, colorHue: rng2() * 360, createdAt: -1 });
    }

    // Military objects
    for (let i = 0; i < numMilitary; i++) {
      const ox = (cx * sz + rng2() * sz) * ts;
      const oy = (cy * sz + rng2() * sz) * ts;
      if (Math.abs(ox) < 200 && Math.abs(oy) < 200) continue;
      if (baseOnWater(ox, oy, 10)) continue;
      const r = rng2();
      if (r < 0.35) {
        addEnv({ x: ox, y: oy, type: 'barrel', hp: 30, maxHp: 30, exploded: false, createdAt: -1 });
      } else if (r < 0.6) {
        addEnv({ x: ox, y: oy, type: 'sandbag', width: 30 + rng2() * 20, createdAt: -1 });
      } else if (r < 0.85) {
        addEnv({ x: ox, y: oy, type: 'crate', createdAt: -1 });
      } else {
        addEnv({ x: ox, y: oy, type: 'ruins', width: 20 + rng2() * 30, height: 15 + rng2() * 20, createdAt: -1 });
      }
    }

    // River objects: reeds near water
    for (let i = 0; i < 3; i++) {
      const ox = (cx * sz + rng2() * sz) * ts;
      const oy = (cy * sz + rng2() * sz) * ts;
      const terrain = renderedTerrainAt(ox, oy);
      const nearWater = renderedTerrainAt(ox + 40, oy) === 'water' ||
        renderedTerrainAt(ox - 40, oy) === 'water' ||
        renderedTerrainAt(ox, oy + 40) === 'water' ||
        renderedTerrainAt(ox, oy - 40) === 'water';
      if (nearWater && terrain !== 'water') {
        addEnv({ x: ox, y: oy, type: 'reeds', height: 8 + rng2() * 10, createdAt: -1 });
      }
    }
  }
}

/**
 * Render terrain chunks around the player
 */
// Terrain type of the tile that is actually DRAWN at (x, y): tiles render
// from the sample at their corner, so snap to the tile grid (E0; same rule
// as the water slowdown in combat.js)
function renderedTerrainAt(x, y) {
  const ts = CFG.TILE_SIZE;
  return getTerrainTypeAt(Math.floor(x / ts) * ts, Math.floor(y / ts) * ts);
}

// Is the point or its base footprint (radius r) on a rendered water tile?
function baseOnWater(x, y, r) {
  if (renderedTerrainAt(x, y) === 'water') return true;
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    if (renderedTerrainAt(x + Math.cos(a) * r, y + Math.sin(a) * r) === 'water') return true;
  }
  return false;
}

// K2.1: zoomed out, at most this many chunks bake per frame even on screen;
// the rest show a flat placeholder diamond until their turn
const TERRAIN_ZOOM_BAKES = 2;
const _chunkPh = new Map(); // key -> placeholder Graphics
function _chunkPlaceholder(cx, cy, key, cs) {
  if (_chunkPh.has(key)) return;
  const iso = CFG.ISO_SCALE, x0 = cx * cs, y0 = cy * cs, x1 = x0 + cs, y1 = y0 + cs;
  const g = new PIXI.Graphics();
  g.poly([x0 - y0, (x0 + y0) * iso, x1 - y0, (x1 + y0) * iso, x1 - y1, (x1 + y1) * iso, x0 - y1, (x0 + y1) * iso]).fill(0x56683a);
  g._cx = cx; g._cy = cy;
  terrainContainer.addChildAt(g, 0);
  _chunkPh.set(key, g);
}
// all of them (zoom back to 1, round reset)
function clearChunkPlaceholders() {
  for (const g of _chunkPh.values()) { terrainContainer.removeChild(g); g.destroy(); }
  _chunkPh.clear();
}
function _chunkPlaceholderDrop(key) {
  const g = _chunkPh.get(key);
  if (!g) return;
  terrainContainer.removeChild(g);
  g.destroy();
  _chunkPh.delete(key);
}

// M11 K3a: does chunk (cx, cy)'s screen box come within `m` (zoom-1 iso
// units) of the zoomed view? (a chunk is a diamond 2cs wide, 2cs x iso tall)
function _chunkNearView(cx, cy, cs, m) {
  const iso = CFG.ISO_SCALE, hw = W / 2 / cam.z + m, hh = H / 2 / cam.z + m;
  const sx = (cx - cy) * cs, sy = (cx + cy + 1) * cs * iso;
  return Math.abs(sx - cam.x) < cs + hw && Math.abs(sy - cam.y) < cs * iso + hh;
}

function renderPixiTerrain() {
  const ts = CFG.TILE_SIZE;
  const cs = CFG.CHUNK_SIZE * ts;
  const centerWorld = toWorld(cam.x, cam.y);
  const zoomed = cam.z < 1;
  // Zoomed out (K3a): rings out to the view's world extent; only chunks near
  // the view bake (those on screen at once, the rest within the budget)
  const ext = zoomed ? (W / 2 / cam.z + H / 2 / cam.z / CFG.ISO_SCALE) * 0.5 : 0;
  const chunkRange = zoomed ? Math.ceil(ext / cs) + 1 : 2;
  const pcx = Math.floor(centerWorld.x / cs);
  const pcy = Math.floor(centerWorld.y / cs);

  // P3: bake nearest-first, ring by ring. The 3x3 around the camera covers
  // the screen and always bakes; the outer ring is pre-baked off-screen
  // within a per-frame budget, so walking never bakes a whole row at once
  const t0 = performance.now();
  let baked = 0;
  if (_chunkPh.size) { // placeholders: none at zoom 1; drop those far off the zoomed view
    if (!zoomed) clearChunkPlaceholders();
    else for (const [k, g] of _chunkPh) if (!_chunkNearView(g._cx, g._cy, cs, cs * 1.5)) _chunkPlaceholderDrop(k);
  }
  bake:
  for (let ring = 0; ring <= chunkRange; ring++) {
    for (let cy = pcy - ring; cy <= pcy + ring; cy++) {
      for (let cx = pcx - ring; cx <= pcx + ring; cx++) {
        if (Math.max(Math.abs(cx - pcx), Math.abs(cy - pcy)) !== ring) continue;
        if (zoomed) {
          if (!_chunkNearView(cx, cy, cs, cs * 0.5)) continue;
          const onScreen = _chunkNearView(cx, cy, cs, 0);
          if (ring > 1 && !onScreen && performance.now() - t0 > TERRAIN_BAKE_BUDGET_MS) continue;
          const key = `${cx},${cy}`;
          if (chunkCache.has(key)) continue;
          if (baked >= TERRAIN_ZOOM_BAKES) { if (onScreen) _chunkPlaceholder(cx, cy, key, cs); continue; }
          baked++;
          generatePixiChunk(cx, cy);
          _chunkPlaceholderDrop(key);
          continue;
        } else if (ring > 1 && performance.now() - t0 > TERRAIN_BAKE_BUDGET_MS) break bake;
        generatePixiChunk(cx, cy);
      }
    }
  }

  // Render animated water overlay
  renderPixiWaterOverlay();

  // Cleanup distant chunks (only when exceeding limit)
  if (chunkCache.size > 40) {
    const dropped = _droppedChunkKeys;
    dropped.clear();
    for (const [key, sprite] of chunkCache) {
      const cx2 = sprite._cx, cy2 = sprite._cy; // K2.1: stored at bake (no per-frame key parsing)
      const far = zoomed ? !_chunkNearView(cx2, cy2, cs, cs * 1.5)
        : Math.abs(cx2 - pcx) > chunkRange + 2 || Math.abs(cy2 - pcy) > chunkRange + 2;
      if (far) {
        terrainContainer.removeChild(sprite);
        sprite.destroy(true); // Destroy sprite and texture
        chunkCache.delete(key);
        destroyChunkWater(key);
        envChunks.delete(key);
        dropped.add(key);
      }
    }
    // Drop exactly the env objects of the unloaded chunks (id = chunk key +
    // '#' + n), so they regenerate with their chunk. A separate distance cut
    // used to remove objects of chunks that stayed cached: those never came back.
    if (dropped.size) {
      for (let i = envObjects.length - 1; i >= 0; i--) {
        const id = envObjects[i].id;
        if (id && dropped.has(id.slice(0, id.indexOf('#')))) envObjects.splice(i, 1);
      }
    }
  }
}

const TERRAIN_BAKE_BUDGET_MS = 4;
const _droppedChunkKeys = new Set(); // reused by the chunk cleanup (no per-frame alloc) // P3: per-frame budget for pre-baking off-screen chunks

/**
 * Animated water overlay - digital blue camo blocks drifting over water tiles.
 * P1: the camo is baked ONCE per terrain chunk into low-res textures (camo
 * blocks + two ripple groups); per frame only a stepped drift offset and the
 * ripple alphas change (<= 10 Hz), instead of rebuilding ~3300 rects.
 * W1: per-block alpha as designed, scaled by CFG.WATER_CAMO_ALPHA_SCALE.
 */
const waterCache = new Map();          // chunk key -> { camo, ripA, ripB } sprites, or null (no water)
const WATER_BAKE_RES = 1 / 3;          // the world is shown at 1/3 resolution anyway (R1)
const WATER_DRIFT = 3;                 // max drift in screen units (1 low-res pixel)
const WATER_STEP_HZ = 8;               // animation update rate (stepped, <= 10 Hz)
const WATER_RIP_Z = -999996.85;        // W5: ripple highlights above the blood tint (-999996.9), below clouds (-999996.8)
const WATER_CAMO_COLORS = [
  0x163d5c, 0x1a4a6e, 0x0f3348, 0x1e5577,
  0x12405a, 0x255d80, 0x0d2c40, 0x1b5270,
  0x183e5e, 0x2a6888, 0x0e3550, 0x1f5878
];

// Deterministic per-tile hash for camo patterns
function waterTileHash(tx, ty, i) {
  let h = (tx * 374761393 + ty * 668265263 + i * 2654435761) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return (h ^ (h >>> 16)) & 0x7fffffff;
}

// All 4 corners of a rect (relative to the tile centre) inside the tile diamond
function waterRectInDiamond(rx, ry, rw, rh, dhw, dhh) {
  const hw = rw * 0.5, hh = rh * 0.5;
  return (Math.abs(rx - hw) / dhw + Math.abs(ry - hh) / dhh <= 1) &&
         (Math.abs(rx + hw) / dhw + Math.abs(ry - hh) / dhh <= 1) &&
         (Math.abs(rx - hw) / dhw + Math.abs(ry + hh) / dhh <= 1) &&
         (Math.abs(rx + hw) / dhw + Math.abs(ry + hh) / dhh <= 1);
}

function _bakeWaterLayer(g, w, h) {
  const rt = PIXI.RenderTexture.create({ width: w, height: h, resolution: WATER_BAKE_RES, scaleMode: 'nearest', antialias: false });
  app.renderer.render({ container: g, target: rt, clear: true });
  const sp = new PIXI.Sprite(rt);
  sp.zIndex = -999997; // above blood/craters, below entities
  worldContainer.addChild(sp);
  return sp;
}

// Bake the water camo of one terrain chunk (called when the chunk is baked)
function bakeChunkWater(cx, cy) {
  const key = `${cx},${cy}`;
  destroyChunkWater(key);
  // W5: every (re)bake is counted, so tests can prove the camo is not rebaked
  // per frame (waterFxStats().camoRebakes); the blood tint is an overlay layer
  if (typeof waterCamoBakes !== 'undefined') waterCamoBakes++;
  const sz = CFG.CHUNK_SIZE, ts = CFG.TILE_SIZE, iso = CFG.ISO_SCALE;
  const w = sz * ts * 2 + ts * 2, h = sz * ts * iso * 2 + ts * 2;
  // Same local frame as the terrain chunk sprite
  const origin = toScreen(cx * sz * ts, cy * sz * ts);
  const ox0 = origin.x - sz * ts, oy0 = origin.y;
  const aScale = CFG.WATER_CAMO_ALPHA_SCALE;
  const dhw = ts, dhh = ts * iso;
  const camo = new PIXI.Graphics(), ripA = new PIXI.Graphics(), ripB = new PIXI.Graphics();
  let any = false;
  for (let ty = cy * sz; ty < cy * sz + sz; ty++) {
    for (let tx = cx * sz; tx < cx * sz + sz; tx++) {
      if (getTerrainTypeAt(tx * ts, ty * ts) !== 'water') continue;
      any = true;
      const c = toScreen(tx * ts + ts * 0.5, ty * ts + ts * 0.5);
      const lx = c.x - ox0, ly = c.y - oy0;
      // Large camo blocks + small detail blocks; the reject test keeps the
      // drift margin so a drifted block never crosses onto land
      for (let i = 0; i < 10; i++) {
        const hh = waterTileHash(tx, ty, i);
        const big = i < 5;
        const bw = big ? 8 + ((hh >> 16) & 0xf) : 4 + ((hh >> 16) & 0x7);
        const bh = big ? 4 + ((hh >> 20) & 0x7) : 2 + ((hh >> 20) & 0x3);
        const spread = big ? 0.9 : 0.8;
        const rx = ((hh & 0xff) / 255 - 0.5) * dhw * spread;
        const ry = (((hh >> 8) & 0xff) / 255 - 0.5) * dhh * spread;
        if (!waterRectInDiamond(rx, ry, bw + WATER_DRIFT * 2, bh + WATER_DRIFT, dhw, dhh)) continue;
        const color = WATER_CAMO_COLORS[(big ? hh : hh >> 3) % WATER_CAMO_COLORS.length];
        const alpha = big ? 0.25 + ((hh >> 28) & 3) * 0.06 : 0.15 + ((hh >> 28) & 3) * 0.04;
        camo.rect(lx + rx - bw * 0.5, ly + ry - bh * 0.5, bw, bh).fill({ color, alpha: Math.min(1, alpha * aScale) });
      }
      // Ripple highlight, in one of two groups that pulse in counter-phase
      const rh = waterTileHash(tx, ty, 99);
      const rx = (((rh >> 8) & 0xff) / 255 - 0.5) * dhw * 0.4;
      const ry = (((rh >> 16) & 0xff) / 255 - 0.5) * dhh * 0.4;
      const rw = 8 + ((rh >> 24) & 0xf);
      if (waterRectInDiamond(rx, ry, rw, 2, dhw, dhh)) {
        ((rh & 1) ? ripA : ripB).rect(lx + rx - rw * 0.5, ly + ry - 1, rw, 2).fill({ color: 0x4488aa, alpha: Math.min(1, 0.14 * aScale) });
      }
    }
  }
  if (any) {
    const entry = { camo: _bakeWaterLayer(camo, w, h), ripA: _bakeWaterLayer(ripA, w, h), ripB: _bakeWaterLayer(ripB, w, h), x: ox0, y: oy0 };
    entry.camo.position.set(ox0, oy0); // drifted per frame by renderPixiWaterOverlay
    entry.ripA.position.set(ox0, oy0);
    entry.ripB.position.set(ox0, oy0);
    entry.ripA.zIndex = entry.ripB.zIndex = WATER_RIP_Z; // the water still glints through the blood
    waterCache.set(key, entry);
  } else {
    waterCache.set(key, null);
  }
  camo.destroy(); ripA.destroy(); ripB.destroy();
}

function destroyChunkWater(key) {
  const e = waterCache.get(key);
  if (e) for (const sp of [e.camo, e.ripA, e.ripB]) { worldContainer.removeChild(sp); sp.destroy(true); }
  waterCache.delete(key);
}

function clearWaterBakes() {
  for (const key of [...waterCache.keys()]) destroyChunkWater(key);
}

// W1: CFG.WATER_CAMO_ALPHA_SCALE is baked in; call this after changing it
function rebakeWaterCamo() {
  for (const key of chunkCache.keys()) {
    const [cx, cy] = key.split(',').map(Number);
    bakeChunkWater(cx, cy);
  }
}

// Per frame: move/fade the baked layers in steps (no geometry rebuild)
function renderPixiWaterOverlay() {
  const tq = Math.floor(gameTime * WATER_STEP_HZ) / WATER_STEP_HZ;
  const dx = Math.round(Math.sin(tq * 0.25) * WATER_DRIFT / 3) * 3;
  const dy = Math.round(Math.cos(tq * 0.18) * WATER_DRIFT / 3) * 3;
  const pulse = Math.sin(tq * 0.5);
  const aA = Math.round(Math.max(0, pulse) * 4) / 4;
  const aB = Math.round(Math.max(0, -pulse) * 4) / 4;
  for (const e of waterCache.values()) {
    if (!e) continue;
    e.camo.x = e.x + dx; e.camo.y = e.y + dy;
    e.ripA.alpha = aA; e.ripB.alpha = aB;
    e.ripA.visible = aA > 0; e.ripB.visible = aB > 0;
  }
}
