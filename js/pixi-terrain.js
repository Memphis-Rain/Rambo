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
  chunkCache.set(key, chunkSprite);

  // Add to terrain container
  terrainContainer.addChild(chunkSprite);

  // Clean up temporary container
  chunkContainer.destroy({ children: true });

  // Spawn environmental objects (unchanged from original - handled by world.js)
  if (!envChunks.has(key)) {
    envChunks.add(key);
    const rng2 = seededRand(cx * 12345 + cy * 67890);
    const chunkWorldX = cx * sz * ts;
    const chunkWorldY = cy * sz * ts;
    const forestDensity = (fbm(chunkWorldX * 0.001, chunkWorldY * 0.001, 3) + 0.5);
    const isForest = forestDensity > 0.5;
    const numTrees = isForest ? Math.floor(30 + rng2() * 20) : Math.floor(5 + rng2() * 12);
    const numRocks = Math.floor(3 + rng2() * 6);
    const numMilitary = Math.floor(rng2() * 3);
    const numFlowers = Math.floor(rng2() * 5);

    // Trees and bushes
    for (let i = 0; i < numTrees; i++) {
      const ox = (cx * sz + rng2() * sz) * ts;
      const oy = (cy * sz + rng2() * sz) * ts;
      if (Math.abs(ox) < 150 && Math.abs(oy) < 150) continue;
      if (getTerrainTypeAt(ox, oy) === 'water' ||
        getTerrainTypeAt(ox + 30, oy) === 'water' ||
        getTerrainTypeAt(ox - 30, oy) === 'water' ||
        getTerrainTypeAt(ox, oy + 30) === 'water' ||
        getTerrainTypeAt(ox, oy - 30) === 'water') continue;
      const treeType = rng2();
      if (treeType < 0.5) {
        envObjects.push({ x: ox, y: oy, type: 'tree', radius: 31 + rng2() * 29, height: 60 + rng2() * 55, collision: 8, createdAt: -1 });
      } else if (treeType < 0.75) {
        envObjects.push({ x: ox, y: oy, type: 'pine', radius: 22 + rng2() * 20, height: 66 + rng2() * 44, collision: 7, createdAt: -1 });
      } else if (treeType < 0.9) {
        envObjects.push({ x: ox, y: oy, type: 'bush', radius: 12 + rng2() * 14, createdAt: -1 });
      } else {
        envObjects.push({ x: ox, y: oy, type: 'deadtree', height: 30 + rng2() * 25, createdAt: -1 });
      }
    }

    // Rocks
    for (let i = 0; i < numRocks; i++) {
      const ox = (cx * sz + rng2() * sz) * ts;
      const oy = (cy * sz + rng2() * sz) * ts;
      if (Math.abs(ox) < 150 && Math.abs(oy) < 150) continue;
      if (getTerrainTypeAt(ox, oy) === 'water' ||
        getTerrainTypeAt(ox + 20, oy) === 'water' ||
        getTerrainTypeAt(ox - 20, oy) === 'water' ||
        getTerrainTypeAt(ox, oy + 20) === 'water' ||
        getTerrainTypeAt(ox, oy - 20) === 'water') continue;
      const isHill = getTerrainTypeAt(ox, oy) === 'hill';
      const rockSize = rng2();
      if (rockSize < 0.35) {
        envObjects.push({ x: ox, y: oy, type: 'rock', radius: 6 + rng2() * 8, collision: 6, createdAt: -1 });
      } else if (rockSize < 0.7 || isHill) {
        envObjects.push({ x: ox, y: oy, type: 'boulder', radius: 14 + rng2() * 16, collision: 14, createdAt: -1 });
      } else {
        envObjects.push({ x: ox, y: oy, type: 'rockcluster', radius: 10 + rng2() * 10, createdAt: -1 });
      }
    }

    // Flowers
    for (let i = 0; i < numFlowers; i++) {
      const ox = (cx * sz + rng2() * sz) * ts;
      const oy = (cy * sz + rng2() * sz) * ts;
      const terrain = getTerrainTypeAt(ox, oy);
      if (terrain === 'water' || terrain === 'dark') continue;
      envObjects.push({ x: ox, y: oy, type: 'flowers', radius: 4 + rng2() * 6, colorHue: rng2() * 360, createdAt: -1 });
    }

    // Military objects
    for (let i = 0; i < numMilitary; i++) {
      const ox = (cx * sz + rng2() * sz) * ts;
      const oy = (cy * sz + rng2() * sz) * ts;
      if (Math.abs(ox) < 200 && Math.abs(oy) < 200) continue;
      if (getTerrainTypeAt(ox, oy) === 'water') continue;
      const r = rng2();
      if (r < 0.35) {
        envObjects.push({ x: ox, y: oy, type: 'barrel', hp: 30, maxHp: 30, exploded: false, createdAt: -1 });
      } else if (r < 0.6) {
        envObjects.push({ x: ox, y: oy, type: 'sandbag', width: 30 + rng2() * 20, createdAt: -1 });
      } else if (r < 0.85) {
        envObjects.push({ x: ox, y: oy, type: 'crate', createdAt: -1 });
      } else {
        envObjects.push({ x: ox, y: oy, type: 'ruins', width: 20 + rng2() * 30, height: 15 + rng2() * 20, createdAt: -1 });
      }
    }

    // River objects: reeds near water
    for (let i = 0; i < 3; i++) {
      const ox = (cx * sz + rng2() * sz) * ts;
      const oy = (cy * sz + rng2() * sz) * ts;
      const terrain = getTerrainTypeAt(ox, oy);
      const nearWater = getTerrainTypeAt(ox + 40, oy) === 'water' ||
        getTerrainTypeAt(ox - 40, oy) === 'water' ||
        getTerrainTypeAt(ox, oy + 40) === 'water' ||
        getTerrainTypeAt(ox, oy - 40) === 'water';
      if (nearWater && terrain !== 'water') {
        envObjects.push({ x: ox, y: oy, type: 'reeds', height: 8 + rng2() * 10, createdAt: -1 });
      }
    }
  }
}

/**
 * Render terrain chunks around the player
 */
function renderPixiTerrain() {
  const ts = CFG.TILE_SIZE;
  const cs = CFG.CHUNK_SIZE * ts;
  const centerWorld = toWorld(cam.x, cam.y);
  const chunkRange = 2;
  const pcx = Math.floor(centerWorld.x / cs);
  const pcy = Math.floor(centerWorld.y / cs);

  // Generate visible chunks
  for (let cy = pcy - chunkRange; cy <= pcy + chunkRange; cy++) {
    for (let cx = pcx - chunkRange; cx <= pcx + chunkRange; cx++) {
      generatePixiChunk(cx, cy);
    }
  }

  // Render animated water overlay
  renderPixiWaterOverlay();

  // Cleanup distant chunks (only when exceeding limit)
  if (chunkCache.size > 40) {
    for (const [key, sprite] of chunkCache) {
      const [cx2, cy2] = key.split(',').map(Number);
      if (Math.abs(cx2 - pcx) > chunkRange + 2 || Math.abs(cy2 - pcy) > chunkRange + 2) {
        terrainContainer.removeChild(sprite);
        sprite.destroy(true); // Destroy sprite and texture
        chunkCache.delete(key);
        envChunks.delete(key);
      }
    }
    // Cleanup distant environmental objects
    for (let i = envObjects.length - 1; i >= 0; i--) {
      const d = dist(envObjects[i].x, envObjects[i].y, player.x, player.y);
      if (d > 2500) envObjects.splice(i, 1);
    }
    // Cleanup old blood pools
    while (bloodPools.length > CFG.MAX_BLOOD_POOLS * 0.8) bloodPools.shift();
  }
}

/**
 * Animated water overlay - digital blue camo effect with slow movement
 * Draws semi-transparent camo blocks on water tiles, animated with gameTime
 */
function renderPixiWaterOverlay() {
  if (!renderPixiWaterOverlay._graphics) {
    renderPixiWaterOverlay._graphics = new PIXI.Graphics();
    renderPixiWaterOverlay._graphics.zIndex = -999997; // Above blood/craters, below entities
    worldContainer.addChild(renderPixiWaterOverlay._graphics);
  }

  const g = renderPixiWaterOverlay._graphics;
  g.clear();

  const ts = CFG.TILE_SIZE;
  const iso = CFG.ISO_SCALE;
  const centerWorld = toWorld(cam.x, cam.y);
  const rangeX = Math.ceil(W / (ts * 1.5)) + 3;
  const rangeY = Math.ceil(H / (ts * iso * 1.5)) + 3;
  const centerTX = Math.floor(centerWorld.x / ts);
  const centerTY = Math.floor(centerWorld.y / ts);
  const time = gameTime;

  // Camo color palette - deep blues, teals, navy
  const camoColors = [
    0x163d5c, 0x1a4a6e, 0x0f3348, 0x1e5577,
    0x12405a, 0x255d80, 0x0d2c40, 0x1b5270,
    0x183e5e, 0x2a6888, 0x0e3550, 0x1f5878
  ];

  // Hash function for deterministic per-tile patterns
  function tileHash(tx, ty, i) {
    let h = (tx * 374761393 + ty * 668265263 + i * 2654435761) | 0;
    h = ((h ^ (h >>> 13)) * 1274126177) | 0;
    return (h ^ (h >>> 16)) & 0x7fffffff;
  }

  // Check if ALL 4 corners of a rect are inside the isometric diamond
  // rx, ry are relative to tile center; dhw/dhh are diamond half-widths
  function rectInDiamond(rx, ry, rw, rh, dhw, dhh) {
    const hw = rw * 0.5, hh = rh * 0.5;
    // Test all 4 corners against diamond: |x|/dhw + |y|/dhh <= 1
    return (Math.abs(rx - hw) / dhw + Math.abs(ry - hh) / dhh <= 1) &&
           (Math.abs(rx + hw) / dhw + Math.abs(ry - hh) / dhh <= 1) &&
           (Math.abs(rx - hw) / dhw + Math.abs(ry + hh) / dhh <= 1) &&
           (Math.abs(rx + hw) / dhw + Math.abs(ry + hh) / dhh <= 1);
  }

  for (let ty = centerTY - rangeY; ty <= centerTY + rangeY; ty++) {
    for (let tx = centerTX - rangeX; tx <= centerTX + rangeX; tx++) {
      if (getTerrainTypeAt(tx * ts, ty * ts) !== 'water') continue;

      // Tile center in screen coords
      const sp = toScreen(tx * ts + ts * 0.5, ty * ts + ts * 0.5);

      // Diamond half-widths for this tile in screen space
      const dhw = ts;       // half-width of isometric diamond
      const dhh = ts * iso; // half-height

      // Large camo blocks (slow drift)
      for (let i = 0; i < 5; i++) {
        const h = tileHash(tx, ty, i);
        const w = 8 + ((h >> 16) & 0xf);
        const bh = 4 + ((h >> 20) & 0x7);

        // Slow animated drift
        const phase = ((h >> 4) & 0xf) * 0.39;
        const ox = Math.sin(time * 0.25 + phase) * 3;
        const oy = Math.cos(time * 0.18 + phase * 1.3) * 1.5;

        // Final center position relative to tile center
        const cx = ((h & 0xff) / 255 - 0.5) * dhw * 0.9 + ox;
        const cy = (((h >> 8) & 0xff) / 255 - 0.5) * dhh * 0.9 + oy;

        // Reject if ANY corner is outside the diamond
        if (!rectInDiamond(cx, cy, w, bh, dhw, dhh)) continue;

        const color = camoColors[h % camoColors.length];
        g.alpha = 0.25 + ((h >> 28) & 3) * 0.06;
        g.rect(sp.x + cx - w * 0.5, sp.y + cy - bh * 0.5, w, bh);
        g.fill(color);
      }

      // Small detail blocks (faster shimmer)
      for (let i = 5; i < 10; i++) {
        const h = tileHash(tx, ty, i);
        const w = 4 + ((h >> 16) & 0x7);
        const bh2 = 2 + ((h >> 20) & 0x3);

        const phase = ((h >> 4) & 0xf) * 0.47;
        const ox = Math.sin(time * 0.4 + phase) * 2;
        const oy = Math.cos(time * 0.3 + phase * 0.9) * 1;

        const cx = ((h & 0xff) / 255 - 0.5) * dhw * 0.8 + ox;
        const cy = (((h >> 8) & 0xff) / 255 - 0.5) * dhh * 0.8 + oy;

        if (!rectInDiamond(cx, cy, w, bh2, dhw, dhh)) continue;

        const color = camoColors[(h >> 3) % camoColors.length];
        g.alpha = 0.15 + ((h >> 28) & 3) * 0.04;
        g.rect(sp.x + cx - w * 0.5, sp.y + cy - bh2 * 0.5, w, bh2);
        g.fill(color);
      }

      // Occasional bright ripple highlight (time-varying visibility)
      const rippleH = tileHash(tx, ty, 99);
      const ripplePhase = ((rippleH & 0xff) / 255) * Math.PI * 2;
      const rippleVis = Math.sin(time * 0.5 + ripplePhase);
      if (rippleVis > 0.3) {
        const rx = ((rippleH >> 8 & 0xff) / 255 - 0.5) * dhw * 0.4;
        const ry = ((rippleH >> 16 & 0xff) / 255 - 0.5) * dhh * 0.4;
        const rw = 8 + (rippleH >> 24 & 0xf);
        if (rectInDiamond(rx, ry, rw, 2, dhw, dhh)) {
          g.alpha = (rippleVis - 0.3) * 0.2;
          g.rect(sp.x + rx - rw * 0.5, sp.y + ry - 1, rw, 2);
          g.fill(0x4488aa);
        }
      }
    }
  }

  g.alpha = 1;
}
