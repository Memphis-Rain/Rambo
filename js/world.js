// =====================================================================
// TERRAIN & WORLD GENERATION
// =====================================================================

const terrainCache = {};

function getTerrainTile(type) {
  if (terrainCache[type]) return terrainCache[type];
  const sz = CFG.TILE_SIZE;
  const { canvas, ctx } = createOffscreen(sz*2+2, sz+2);
  const hw = sz, hh = sz * CFG.ISO_SCALE;
  const cx = sz, cy = hh;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx, cy-hh); ctx.lineTo(cx+hw, cy);
  ctx.lineTo(cx, cy+hh); ctx.lineTo(cx-hw, cy); ctx.closePath();
  ctx.clip();

  if (type === 'grass') {
    ctx.fillStyle = '#4a6';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for(let i=0;i<40;i++){
      const x = Math.random()*canvas.width, y = Math.random()*canvas.height;
      ctx.fillStyle = `rgba(${50+Math.random()*30|0},${130+Math.random()*50|0},${50+Math.random()*30|0},0.4)`;
      ctx.fillRect(x, y, 2+Math.random()*3, 1+Math.random()*2);
    }
  } else if (type === 'dirt') {
    ctx.fillStyle = '#875';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for(let i=0;i<30;i++){
      const x = Math.random()*canvas.width, y = Math.random()*canvas.height;
      ctx.fillStyle = `rgba(${120+Math.random()*40|0},${90+Math.random()*30|0},${50+Math.random()*20|0},0.3)`;
      ctx.fillRect(x, y, 2+Math.random()*4, 1+Math.random()*3);
    }
  } else if (type === 'sand') {
    ctx.fillStyle = '#ca8';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for(let i=0;i<20;i++){
      const x = Math.random()*canvas.width, y = Math.random()*canvas.height;
      ctx.fillStyle = `rgba(${200+Math.random()*40|0},${170+Math.random()*30|0},${100+Math.random()*30|0},0.3)`;
      ctx.fillRect(x, y, 1+Math.random()*3, 1+Math.random()*2);
    }
  } else if (type === 'dark') {
    ctx.fillStyle = '#354';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for(let i=0;i<15;i++){
      const x = Math.random()*canvas.width, y = Math.random()*canvas.height;
      ctx.fillStyle = `rgba(${30+Math.random()*20|0},${50+Math.random()*20|0},${40+Math.random()*20|0},0.3)`;
      ctx.fillRect(x, y, 2+Math.random()*3, 1+Math.random()*2);
    }
  } else if (type === 'water') {
    // Deep blue water
    ctx.fillStyle = '#257';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Ripple highlights
    for(let i=0;i<25;i++){
      const x = Math.random()*canvas.width, y = Math.random()*canvas.height;
      ctx.fillStyle = `rgba(${60+Math.random()*40|0},${120+Math.random()*60|0},${180+Math.random()*60|0},0.35)`;
      const w = 4+Math.random()*10;
      ctx.fillRect(x, y, w, 1+Math.random()*1.5);
    }
    // Darker depth spots
    for(let i=0;i<8;i++){
      const x = Math.random()*canvas.width, y = Math.random()*canvas.height;
      ctx.fillStyle = `rgba(${15+Math.random()*20|0},${40+Math.random()*20|0},${80+Math.random()*20|0},0.25)`;
      ctx.beginPath();
      ctx.ellipse(x, y, 6+Math.random()*10, 3+Math.random()*5, Math.random()*1, 0, Math.PI*2);
      ctx.fill();
    }
  } else if (type === 'hill') {
    // Elevated green with gradient
    const grd = ctx.createLinearGradient(0, 0, canvas.width*0.3, canvas.height);
    grd.addColorStop(0, '#6b5');
    grd.addColorStop(0.5, '#5a4');
    grd.addColorStop(1, '#493');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Contour texture
    for(let i=0;i<30;i++){
      const x = Math.random()*canvas.width, y = Math.random()*canvas.height;
      ctx.fillStyle = `rgba(${60+Math.random()*40|0},${120+Math.random()*50|0},${40+Math.random()*30|0},0.3)`;
      ctx.fillRect(x, y, 3+Math.random()*5, 1+Math.random()*2);
    }
    // Rocky patches
    for(let i=0;i<5;i++){
      const x = Math.random()*canvas.width, y = Math.random()*canvas.height;
      ctx.fillStyle = `rgba(${100+Math.random()*30|0},${95+Math.random()*25|0},${80+Math.random()*20|0},0.25)`;
      ctx.beginPath();
      ctx.ellipse(x, y, 4+Math.random()*6, 2+Math.random()*3, Math.random()*2, 0, Math.PI*2);
      ctx.fill();
    }
  }

  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.1)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy-hh); ctx.lineTo(cx+hw, cy);
  ctx.lineTo(cx, cy+hh); ctx.lineTo(cx-hw, cy); ctx.closePath();
  ctx.stroke();

  terrainCache[type] = canvas;
  return canvas;
}

function initTerrain() {
  ['grass','dirt','sand','dark','water','hill'].forEach(t => getTerrainTile(t));
}

function getTerrainTypeAt(wx, wy) {
  // Rivers - wider, more connected bands
  const riverN = noise2D(wx * 0.0008 + 50, wy * 0.0008 + 50);
  if(Math.abs(riverN) < 0.06) return 'water';

  // Sand beach near water (check if river is close)
  if(Math.abs(riverN) < 0.1) return 'sand';

  // Hills - elevated zones
  const hillN = fbm(wx * 0.002 + 200, wy * 0.002 + 200, 2);
  if(hillN > 0.32) return 'hill';

  // Forest density - same noise used for tree spawning
  const forestN = fbm(wx * 0.001, wy * 0.001, 3) + 0.5;
  if(forestN > 0.65) return 'dark';  // dense forest floor
  if(forestN > 0.45) return 'dirt';  // lighter forest floor

  // Open areas - green grass
  return 'grass';
}

function generateChunk(cx, cy) {
  const key = `${cx},${cy}`;
  if(chunkCache.has(key)) return;

  const sz = CFG.CHUNK_SIZE;
  const ts = CFG.TILE_SIZE;
  const { canvas, ctx } = createOffscreen(sz * ts * 2 + ts*2, sz * ts * CFG.ISO_SCALE * 2 + ts*2);

  for(let ty=0;ty<sz;ty++){
    for(let tx=0;tx<sz;tx++){
      const worldTx = cx * sz + tx;
      const worldTy = cy * sz + ty;
      const type = getTerrainTypeAt(worldTx * ts, worldTy * ts);
      const tile = getTerrainTile(type);
      const sp = toScreen(tx * ts, ty * ts);
      ctx.drawImage(tile, sp.x + sz*ts - ts, sp.y);
    }
  }

  // Decorations
  const rng = seededRand(cx * 73856093 + cy * 19349663);
  for(let i=0;i<sz*5;i++){
    const lx = rng() * sz * ts;
    const ly = rng() * sz * ts;
    const sp = toScreen(lx, ly);
    const gx = sp.x + sz*ts - ts;
    const gy = sp.y;
    if(rng() < 0.5){
      ctx.strokeStyle = `rgba(${40+rng()*40|0},${100+rng()*50|0},${30+rng()*30|0},0.6)`;
      ctx.lineWidth = 1;
      for(let j=0;j<3;j++){
        ctx.beginPath();
        ctx.moveTo(gx+rng()*6-3, gy+4);
        ctx.quadraticCurveTo(gx+rng()*8-4, gy-4-rng()*6, gx+rng()*6-3, gy-6-rng()*4);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = `rgba(${100+rng()*40|0},${95+rng()*30|0},${80+rng()*20|0},0.5)`;
      ctx.beginPath();
      ctx.ellipse(gx, gy, 2+rng()*3, 1+rng()*2, rng()*Math.PI, 0, Math.PI*2);
      ctx.fill();
    }
  }

  chunkCache.set(key, canvas);

  // Spawn environmental objects
  if(!envChunks.has(key)){
    envChunks.add(key);
    const rng2 = seededRand(cx * 12345 + cy * 67890);
    const chunkWorldX = cx * sz * ts;
    const chunkWorldY = cy * sz * ts;
    const forestDensity = (fbm(chunkWorldX * 0.001, chunkWorldY * 0.001, 3) + 0.5);
    const isForest = forestDensity > 0.5;
    // Dense forest coverage (balanced for performance)
    const numTrees = isForest ? Math.floor(30 + rng2() * 20) : Math.floor(5 + rng2() * 12);
    const numRocks = Math.floor(3 + rng2() * 6);
    const numMilitary = Math.floor(rng2() * 3);
    const numFlowers = Math.floor(rng2() * 5);

    // Trees and bushes (BIGGER)
    for(let i=0;i<numTrees;i++){
      const ox = (cx * sz + rng2() * sz) * ts;
      const oy = (cy * sz + rng2() * sz) * ts;
      if(Math.abs(ox) < 150 && Math.abs(oy) < 150) continue;
      // Don't spawn in or near water (check center + 8 points around)
      const checkRadius = 40; // Larger radius for bigger trees
      if(getTerrainTypeAt(ox, oy) === 'water' ||
         getTerrainTypeAt(ox+checkRadius, oy) === 'water' ||
         getTerrainTypeAt(ox-checkRadius, oy) === 'water' ||
         getTerrainTypeAt(ox, oy+checkRadius) === 'water' ||
         getTerrainTypeAt(ox, oy-checkRadius) === 'water' ||
         getTerrainTypeAt(ox+checkRadius*0.7, oy+checkRadius*0.7) === 'water' ||
         getTerrainTypeAt(ox-checkRadius*0.7, oy+checkRadius*0.7) === 'water' ||
         getTerrainTypeAt(ox+checkRadius*0.7, oy-checkRadius*0.7) === 'water' ||
         getTerrainTypeAt(ox-checkRadius*0.7, oy-checkRadius*0.7) === 'water') continue;
      const treeType = rng2();
      if(treeType < 0.5){
        // Big regular tree (+10% size)
        envObjects.push({ x:ox, y:oy, type:'tree', radius: 31+rng2()*29, height: 60+rng2()*55, collision: 8, createdAt:-1 });
      } else if(treeType < 0.75){
        // Big pine tree (+10% size)
        envObjects.push({ x:ox, y:oy, type:'pine', radius: 22+rng2()*20, height: 66+rng2()*44, collision: 7, createdAt:-1 });
      } else if(treeType < 0.9){
        // Bush (no collision - can walk through)
        envObjects.push({ x:ox, y:oy, type:'bush', radius: 12+rng2()*14, createdAt:-1 });
      } else {
        // Dead tree (atmospheric)
        envObjects.push({ x:ox, y:oy, type:'deadtree', height: 30+rng2()*25, createdAt:-1 });
      }
    }

    // Rocks (more variety)
    for(let i=0;i<numRocks;i++){
      const ox = (cx * sz + rng2() * sz) * ts;
      const oy = (cy * sz + rng2() * sz) * ts;
      if(Math.abs(ox) < 150 && Math.abs(oy) < 150) continue;
      const rockCheckRadius = 25;
      if(getTerrainTypeAt(ox, oy) === 'water' ||
         getTerrainTypeAt(ox+rockCheckRadius, oy) === 'water' ||
         getTerrainTypeAt(ox-rockCheckRadius, oy) === 'water' ||
         getTerrainTypeAt(ox, oy+rockCheckRadius) === 'water' ||
         getTerrainTypeAt(ox, oy-rockCheckRadius) === 'water') continue;
      const isHill = getTerrainTypeAt(ox, oy) === 'hill';
      const rockSize = rng2();
      if(rockSize < 0.35){
        envObjects.push({ x:ox, y:oy, type:'rock', radius: 6+rng2()*8, collision: 6, createdAt:-1 });
      } else if(rockSize < 0.7 || isHill){
        envObjects.push({ x:ox, y:oy, type:'boulder', radius: 14+rng2()*16, collision: 14, createdAt:-1 });
      } else {
        // Rock cluster
        envObjects.push({ x:ox, y:oy, type:'rockcluster', radius: 10+rng2()*10, createdAt:-1 });
      }
    }

    // Flowers (decorative)
    for(let i=0;i<numFlowers;i++){
      const ox = (cx * sz + rng2() * sz) * ts;
      const oy = (cy * sz + rng2() * sz) * ts;
      const terrain = getTerrainTypeAt(ox, oy);
      if(terrain === 'water' || terrain === 'dark') continue;
      envObjects.push({ x:ox, y:oy, type:'flowers', radius: 4+rng2()*6, colorHue: rng2()*360, createdAt:-1 });
    }

    // Military objects (barrels, sandbags, crates)
    for(let i=0;i<numMilitary;i++){
      const ox = (cx * sz + rng2() * sz) * ts;
      const oy = (cy * sz + rng2() * sz) * ts;
      if(Math.abs(ox) < 200 && Math.abs(oy) < 200) continue;
      if(getTerrainTypeAt(ox, oy) === 'water') continue;
      const r = rng2();
      if(r < 0.35){
        envObjects.push({ x:ox, y:oy, type:'barrel', hp: 30, maxHp: 30, exploded: false, createdAt:-1 });
      } else if(r < 0.6){
        envObjects.push({ x:ox, y:oy, type:'sandbag', width: 30+rng2()*20, createdAt:-1 });
      } else if(r < 0.85){
        envObjects.push({ x:ox, y:oy, type:'crate', createdAt:-1 });
      } else {
        // Ruins (new atmospheric object)
        envObjects.push({ x:ox, y:oy, type:'ruins', width: 20+rng2()*30, height: 15+rng2()*20, createdAt:-1 });
      }
    }

    // River objects: reeds near water
    for(let i=0;i<3;i++){
      const ox = (cx * sz + rng2() * sz) * ts;
      const oy = (cy * sz + rng2() * sz) * ts;
      const terrain = getTerrainTypeAt(ox, oy);
      // Check if near water
      const nearWater = getTerrainTypeAt(ox+40, oy) === 'water' ||
                        getTerrainTypeAt(ox-40, oy) === 'water' ||
                        getTerrainTypeAt(ox, oy+40) === 'water' ||
                        getTerrainTypeAt(ox, oy-40) === 'water';
      if(nearWater && terrain !== 'water'){
        envObjects.push({ x:ox, y:oy, type:'reeds', height: 8+rng2()*10, createdAt:-1 });
      }
    }
  }
}

// =====================================================================
// ENVIRONMENT OBJECT RENDERING
// =====================================================================
function renderEnvObject(obj) {
  const sp = toScreen(obj.x, obj.y);

  if(obj.type === 'tree'){
    // BIGGER tree with more detail
    const r = obj.radius;
    const h = obj.height;
    const trunkH = h - r*0.4; // trunk reaches up into the canopy
    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath();
    ctx.ellipse(sp.x+3, sp.y+5, r*0.9, r*0.35, 0, 0, Math.PI*2);
    ctx.fill();
    // Trunk (extends from ground up to canopy)
    ctx.fillStyle = '#543';
    ctx.fillRect(sp.x-4, sp.y-trunkH, 8, trunkH+6);
    ctx.fillStyle = '#654';
    ctx.fillRect(sp.x-3, sp.y-trunkH+2, 3, trunkH);
    // Canopy (simplified - 3 layers, no per-leaf highlights)
    ctx.fillStyle = '#1a4';
    ctx.beginPath();
    ctx.ellipse(sp.x+1, sp.y-h+3, r*1.05, r*0.75, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = '#2b5';
    ctx.beginPath();
    ctx.ellipse(sp.x-1, sp.y-h, r*0.85, r*0.65, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = '#4c7';
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y-h-2, r*0.55, r*0.4, 0, 0, Math.PI*2);
    ctx.fill();
  } else if(obj.type === 'pine'){
    const r = obj.radius;
    const h = obj.height;
    const ptrunkH = h * 0.45; // trunk extends well into the lower foliage
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath();
    ctx.ellipse(sp.x+2, sp.y+4, r*0.6, r*0.25, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = '#432';
    ctx.fillRect(sp.x-3, sp.y-ptrunkH, 6, ptrunkH+6);
    for(let i=0;i<4;i++){
      const layerR = r * (1 - i*0.2);
      const layerY = sp.y - h*0.35 - i*h*0.18;
      ctx.fillStyle = ['#194','#1a4','#2a5','#3b6'][i];
      ctx.beginPath();
      ctx.moveTo(sp.x, layerY - layerR*0.9);
      ctx.lineTo(sp.x - layerR, layerY + layerR*0.4);
      ctx.lineTo(sp.x + layerR, layerY + layerR*0.4);
      ctx.closePath();
      ctx.fill();
    }
  } else if(obj.type === 'deadtree'){
    const h = obj.height;
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.beginPath();
    ctx.ellipse(sp.x+2, sp.y+3, 6, 3, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = '#543';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(sp.x, sp.y+2);
    ctx.lineTo(sp.x-1, sp.y-h);
    ctx.stroke();
    // Branches
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#432';
    ctx.beginPath();
    ctx.moveTo(sp.x-1, sp.y-h*0.5);
    ctx.lineTo(sp.x-h*0.3, sp.y-h*0.7);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sp.x, sp.y-h*0.7);
    ctx.lineTo(sp.x+h*0.25, sp.y-h*0.85);
    ctx.stroke();
  } else if(obj.type === 'bush'){
    const r = obj.radius;
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.beginPath();
    ctx.ellipse(sp.x+1, sp.y+3, r*0.9, r*0.35, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = '#2a4';
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y-r*0.3, r, r*0.6, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = '#3b5';
    ctx.beginPath();
    ctx.ellipse(sp.x-r*0.2, sp.y-r*0.45, r*0.7, r*0.4, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = '#4c6';
    ctx.beginPath();
    ctx.ellipse(sp.x+r*0.15, sp.y-r*0.35, r*0.4, r*0.3, 0, 0, Math.PI*2);
    ctx.fill();
  } else if(obj.type === 'rock'){
    const r = obj.radius;
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.beginPath();
    ctx.ellipse(sp.x+1, sp.y+2, r*0.9, r*0.35, 0.2, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = '#887';
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y-r*0.2, r, r*0.55, 0.2, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = '#998';
    ctx.beginPath();
    ctx.ellipse(sp.x-r*0.15, sp.y-r*0.35, r*0.6, r*0.3, 0, 0, Math.PI*2);
    ctx.fill();
  } else if(obj.type === 'boulder'){
    const r = obj.radius;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(sp.x+3, sp.y+4, r*1.1, r*0.4, 0.1, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = '#776';
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y-r*0.3, r, r*0.7, 0.1, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = '#998';
    ctx.beginPath();
    ctx.ellipse(sp.x-r*0.2, sp.y-r*0.5, r*0.6, r*0.4, -0.2, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = '#554';
    ctx.beginPath();
    ctx.ellipse(sp.x+r*0.2, sp.y-r*0.15, r*0.4, r*0.15, 0.3, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = '#aa9';
    ctx.beginPath();
    ctx.ellipse(sp.x-r*0.1, sp.y-r*0.6, r*0.3, r*0.2, 0, 0, Math.PI*2);
    ctx.fill();
  } else if(obj.type === 'rockcluster'){
    const r = obj.radius;
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath();
    ctx.ellipse(sp.x+2, sp.y+3, r*1.2, r*0.45, 0, 0, Math.PI*2);
    ctx.fill();
    // Multiple rocks (deterministic colors/angles based on position - no Math.random!)
    const offsets = [{x:-r*0.5,y:-r*0.1,s:0.6,c:120,a:0.1},{x:r*0.3,y:-r*0.2,s:0.5,c:130,a:0.25},{x:0,y:-r*0.35,s:0.7,c:115,a:0.4},{x:-r*0.2,y:r*0.05,s:0.4,c:125,a:0.15}];
    for(const o of offsets){
      ctx.fillStyle = `rgb(${o.c},${o.c-5},${o.c-20})`;
      ctx.beginPath();
      ctx.ellipse(sp.x+o.x, sp.y+o.y, r*o.s, r*o.s*0.55, o.a, 0, Math.PI*2);
      ctx.fill();
    }
  } else if(obj.type === 'flowers'){
    const r = obj.radius;
    const hue = obj.colorHue;
    for(let i=0;i<5;i++){
      const fx = sp.x + Math.cos(i*1.3)*r;
      const fy = sp.y + Math.sin(i*1.3)*r*0.5 - 2;
      ctx.fillStyle = `hsl(${hue+i*15},70%,60%)`;
      ctx.beginPath();
      ctx.arc(fx, fy, 2, 0, Math.PI*2);
      ctx.fill();
      // Stem
      ctx.strokeStyle = '#3a4';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(fx, fy+2);
      ctx.lineTo(fx, fy+5);
      ctx.stroke();
    }
  } else if(obj.type === 'reeds'){
    const h = obj.height;
    const wave = Math.sin(gameTime*2 + obj.x*0.1) * 3;
    ctx.strokeStyle = '#6a5';
    ctx.lineWidth = 1.5;
    for(let i=0;i<5;i++){
      ctx.beginPath();
      ctx.moveTo(sp.x+i*3-6, sp.y+2);
      ctx.quadraticCurveTo(sp.x+i*3-6+wave*(0.5+i*0.1), sp.y-h*0.5, sp.x+i*3-6+wave*(1+i*0.15), sp.y-h);
      ctx.stroke();
    }
  } else if(obj.type === 'ruins'){
    const w = obj.width, h = obj.height;
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(sp.x-w/2+2, sp.y+1, w, 5);
    // Broken wall
    ctx.fillStyle = '#776';
    ctx.fillRect(sp.x-w/2, sp.y-h, 4, h);
    ctx.fillRect(sp.x+w/2-4, sp.y-h*0.6, 4, h*0.6);
    // Top connecting piece (broken)
    ctx.fillRect(sp.x-w/2, sp.y-h, w*0.4, 3);
    // Rubble (deterministic - no Math.random to avoid flickering)
    ctx.fillStyle = '#887';
    const rubble = [{dx:-0.15,dy:0.1,rw:5,rh:3},{dx:0.2,dy:-0.05,rw:4,rh:2.5},{dx:0.05,dy:0.15,rw:6,rh:3},{dx:-0.3,dy:0,rw:3.5,rh:2}];
    for(const rb of rubble){
      ctx.beginPath();
      ctx.ellipse(sp.x+w*rb.dx, sp.y+rb.dy*h, rb.rw, rb.rh, 0, 0, Math.PI*2);
      ctx.fill();
    }
  } else if(obj.type === 'barrel'){
    if(obj.exploded) return;
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath();
    ctx.ellipse(sp.x+2, sp.y+3, 10, 5, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = '#833';
    ctx.fillRect(sp.x-8, sp.y-16, 16, 18);
    ctx.fillStyle = '#555';
    ctx.fillRect(sp.x-9, sp.y-15, 18, 2);
    ctx.fillRect(sp.x-9, sp.y-5, 18, 2);
    ctx.fillStyle = '#944';
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y-16, 8, 4, 0, 0, Math.PI*2);
    ctx.fill();
    // Danger symbol
    ctx.fillStyle = '#ff0';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('\u26A0', sp.x, sp.y-7);
    // HP indicator if damaged
    if(obj.hp < obj.maxHp){
      ctx.fillStyle = '#f00';
      ctx.fillRect(sp.x-8, sp.y-19, 16*(obj.hp/obj.maxHp), 2);
    }
  } else if(obj.type === 'sandbag'){
    const w = obj.width || 30;
    ctx.fillStyle = '#a96';
    for(let i=0;i<Math.ceil(w/10);i++){
      ctx.beginPath();
      ctx.ellipse(sp.x - w/2 + i*10 + 5, sp.y, 6, 4, 0, 0, Math.PI*2);
      ctx.fill();
    }
    ctx.fillStyle = '#b97';
    for(let i=0;i<Math.ceil(w/10)-1;i++){
      ctx.beginPath();
      ctx.ellipse(sp.x - w/2 + i*10 + 10, sp.y-6, 6, 4, 0, 0, Math.PI*2);
      ctx.fill();
    }
  } else if(obj.type === 'crate'){
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(sp.x-8, sp.y+1, 18, 6);
    ctx.fillStyle = '#875';
    ctx.fillRect(sp.x-10, sp.y-14, 20, 16);
    ctx.strokeStyle = '#654';
    ctx.lineWidth = 1;
    ctx.strokeRect(sp.x-10, sp.y-14, 20, 16);
    ctx.beginPath();
    ctx.moveTo(sp.x, sp.y-14); ctx.lineTo(sp.x, sp.y+2);
    ctx.moveTo(sp.x-10, sp.y-6); ctx.lineTo(sp.x+10, sp.y-6);
    ctx.stroke();
    ctx.fillStyle = '#986';
    ctx.beginPath();
    ctx.moveTo(sp.x-10, sp.y-14);
    ctx.lineTo(sp.x, sp.y-18);
    ctx.lineTo(sp.x+10, sp.y-14);
    ctx.lineTo(sp.x, sp.y-10);
    ctx.fill();
  }
}
