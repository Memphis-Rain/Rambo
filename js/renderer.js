// =====================================================================
// RENDERER - All rendering, HUD, post-processing
// =====================================================================

function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#2a3a2a';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.translate(W/2 - cam.x + shakeX, H/2 - cam.y + shakeY);

  // Draw terrain chunks
  const ts = CFG.TILE_SIZE;
  const cs = CFG.CHUNK_SIZE * ts;
  const centerWorld = toWorld(cam.x, cam.y);
  const chunkRange = 2;
  const pcx = Math.floor(centerWorld.x / cs);
  const pcy = Math.floor(centerWorld.y / cs);

  for(let cy = pcy - chunkRange; cy <= pcy + chunkRange; cy++){
    for(let cx = pcx - chunkRange; cx <= pcx + chunkRange; cx++){
      generateChunk(cx, cy);
      const key = `${cx},${cy}`;
      const chunk = chunkCache.get(key);
      if(chunk){
        const sp = toScreen(cx * cs, cy * cs);
        ctx.drawImage(chunk, sp.x - CFG.CHUNK_SIZE*ts + ts, sp.y);
      }
    }
  }

  // Cleanup distant chunks (only when exceeding limit, not every frame)
  if(chunkCache.size > 40) {
    for(const [key] of chunkCache) {
      const [cx2,cy2] = key.split(',').map(Number);
      if(Math.abs(cx2-pcx) > chunkRange+2 || Math.abs(cy2-pcy) > chunkRange+2) {
        chunkCache.delete(key);
        envChunks.delete(key);
      }
    }
    for(let i=envObjects.length-1;i>=0;i--){
      const d = dist(envObjects[i].x, envObjects[i].y, player.x, player.y);
      if(d > 2500) envObjects.splice(i,1);
    }
    while(bloodPools.length > CFG.MAX_BLOOD_POOLS * 0.8) bloodPools.shift();
  }

  // Draw blood pools (alpha fade only - no blur for performance)
  for(let i=bloodPools.length-1;i>=0;i--){
    const bp = bloodPools[i];
    const age = gameTime - bp.createdAt;
    if(age > CFG.BODY_FADE_END){ bloodPools.splice(i,1); continue; }
    const sp = toScreen(bp.x, bp.y);
    let alpha = Math.max(0.1, bp.alpha);
    if(age > CFG.BODY_FADE_START){
      const fadeT = (age - CFG.BODY_FADE_START) / (CFG.BODY_FADE_END - CFG.BODY_FADE_START);
      alpha *= (1 - fadeT);
    }
    if(alpha < 0.02) continue; // skip nearly invisible
    ctx.fillStyle = bp.color + Math.max(0.02, alpha) + ')';
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y, bp.radius * 1.2, bp.radius * CFG.ISO_SCALE * 1.2, 0, 0, Math.PI*2);
    ctx.fill();
  }

  // Collect depth-sorted entities
  const renderList = [];

  for(const b of bodies){
    renderList.push({ type:'body', obj:b, depth: depthKey(b.x, b.y) });
  }
  for(const pk of pickups){
    renderList.push({ type:'pickup', obj:pk, depth: depthKey(pk.x, pk.y) });
  }
  for(const e of enemies){
    renderList.push({ type:'enemy', obj:e, depth: depthKey(e.x, e.y) });
  }
  for(const obj of envObjects){
    const sp = toScreen(obj.x, obj.y);
    const sx = sp.x - cam.x + W/2, sy = sp.y - cam.y + H/2;
    if(sx > -150 && sx < W+150 && sy > -150 && sy < H+150){
      renderList.push({ type:'env', obj, depth: depthKey(obj.x, obj.y) });
    }
  }
  if(player){
    renderList.push({ type:'player', obj:player, depth: depthKey(player.x, player.y) });
  }

  renderList.sort((a,b) => a.depth - b.depth);

  for(const item of renderList){
    if(item.type === 'body') renderBody(item.obj);
    else if(item.type === 'pickup') renderPickup(item.obj);
    else if(item.type === 'enemy') renderEnemy(item.obj);
    else if(item.type === 'player') renderPlayer(item.obj);
    else if(item.type === 'env') renderEnvObject(item.obj);
  }

  // Shells
  for(const s of shells){
    const sp = toScreen(s.x, s.y);
    ctx.save();
    ctx.translate(sp.x, sp.y);
    ctx.rotate(s.rotation);
    ctx.fillStyle = '#da4';
    ctx.fillRect(-s.size, -s.size*0.4, s.size*2, s.size*0.8);
    ctx.fillStyle = '#fc6';
    ctx.fillRect(-s.size, -s.size*0.4, s.size*0.6, s.size*0.8);
    ctx.restore();
  }

  // Bullets with glow
  for(const b of bullets){
    const sp = toScreen(b.x, b.y);
    if(b.glow){
      ctx.shadowBlur = b.beam ? 20 : 12;
      ctx.shadowColor = b.color;
    }
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, b.beam ? b.size*1.5 : b.size, 0, Math.PI*2);
    ctx.fill();
    // Bullet trail line
    const tailX = b.x - b.vx * 0.02;
    const tailY = b.y - b.vy * 0.02;
    const tsp = toScreen(tailX, tailY);
    ctx.strokeStyle = b.color;
    ctx.lineWidth = b.beam ? b.size*1.2 : b.size * 0.7;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(tsp.x, tsp.y);
    ctx.lineTo(sp.x, sp.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    if(b.glow) ctx.shadowBlur = 0;
  }

  // Shockwave ring effects
  for(const sw of shockwaveEffects){
    const sp = toScreen(sw.x, sw.y);
    const lifeRatio = sw.life / sw.maxLife;
    const isoR = sw.radius;
    ctx.strokeStyle = `rgba(255,200,50,${lifeRatio * 0.7})`;
    ctx.lineWidth = 4 * lifeRatio;
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y, isoR, isoR * CFG.ISO_SCALE, 0, 0, Math.PI*2);
    ctx.stroke();
    // Inner glow ring
    ctx.strokeStyle = `rgba(255,255,200,${lifeRatio * 0.4})`;
    ctx.lineWidth = 8 * lifeRatio;
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y, isoR*0.9, isoR*0.9 * CFG.ISO_SCALE, 0, 0, Math.PI*2);
    ctx.stroke();
  }

  // Particles
  for(const p of particles){
    const sp = toScreen(p.x, p.y);
    const lifeRatio = p.life / p.maxLife;
    let alpha = 1;
    if(lifeRatio < p.fadeStart) alpha = lifeRatio / p.fadeStart;

    if(p.type === 'smoke'){
      ctx.fillStyle = p.color + (alpha * 0.5) + ')';
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, p.size, 0, Math.PI*2);
      ctx.fill();
    } else if(p.type === 'flash'){
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, p.size * lifeRatio, 0, Math.PI*2);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else if(p.type === 'fire'){
      ctx.fillStyle = p.color;
      ctx.globalAlpha = alpha * 0.8;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, p.size, 0, Math.PI*2);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = p.color;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, Math.max(0.5, p.size), 0, Math.PI*2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // Floating score texts
  for(const ft of floatingTexts){
    const sp = toScreen(ft.x, ft.y);
    const alpha = Math.min(1, ft.life / (ft.maxLife * 0.3));
    ctx.globalAlpha = alpha;
    ctx.font = `bold ${ft.size}px "Courier New", monospace`;
    ctx.fillStyle = ft.color;
    ctx.textAlign = 'center';
    ctx.fillText(ft.text, sp.x, sp.y - 20);
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  // === POST-PROCESSING: Glow/bloom pass ===
  renderBloom();

  // HUD
  renderHUD();
}

// =====================================================================
// POST-PROCESSING BLOOM (lightweight - no gradients, limited iterations)
// =====================================================================
function renderBloom() {
  // Only do bloom if not too many elements (performance guard)
  const glowBullets = bullets.filter(b => b.glow);
  if(glowBullets.length === 0) return;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.06;
  ctx.translate(W/2 - cam.x + shakeX, H/2 - cam.y + shakeY);

  // Glow from glowing bullets only (no gradients - just larger circles)
  const maxGlow = Math.min(glowBullets.length, 40); // cap for performance
  for(let i=0; i<maxGlow; i++){
    const b = glowBullets[i];
    const sp = toScreen(b.x, b.y);
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, b.beam ? 25 : 12, 0, Math.PI*2);
    ctx.fill();
  }

  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

// =====================================================================
// PLAYER RENDERING
// =====================================================================
function renderPlayer(p) {
  const sp = toScreen(p.x, p.y);

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(sp.x, sp.y + 6, 16, 8, 0, 0, Math.PI*2);
  ctx.fill();

  // === SHIELD VISUAL ===
  if(p.shield > 0){
    const shieldAlpha = 0.15 + Math.sin(gameTime*3)*0.05;
    ctx.strokeStyle = `rgba(80,160,255,${shieldAlpha + 0.1})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y - 6, 20, 24, 0, 0, Math.PI*2);
    ctx.stroke();
    // Hex pattern hint
    ctx.fillStyle = `rgba(80,160,255,${shieldAlpha * 0.5})`;
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y - 6, 18, 22, 0, 0, Math.PI*2);
    ctx.fill();
  }

  // Dodge roll
  if(p.dodging){
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#db9';
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y - 8, 12, 12, p.dodgeAngle, 0, Math.PI*2);
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }

  if(p.hitFlash > 0 && Math.floor(p.hitFlash*20)%2) ctx.globalAlpha = 0.6;

  // Legs
  const legOff = p.walking ? Math.sin(gameTime*12)*3 : 0;
  ctx.fillStyle = '#453';
  ctx.beginPath();
  ctx.ellipse(sp.x - 4 + legOff, sp.y + 2, 4, 5, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(sp.x + 4 - legOff, sp.y + 2, 4, 5, 0, 0, Math.PI*2);
  ctx.fill();

  // Body (muscular Rambo)
  ctx.fillStyle = '#c96';
  ctx.beginPath();
  ctx.ellipse(sp.x, sp.y - 8, 11, 13, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.fillStyle = '#b85';
  ctx.beginPath();
  ctx.ellipse(sp.x+1, sp.y - 10, 7, 8, 0.1, 0, Math.PI*2);
  ctx.fill();
  ctx.fillStyle = '#da7';
  ctx.beginPath();
  ctx.ellipse(sp.x - 2, sp.y - 12, 5, 5, 0, 0, Math.PI*2);
  ctx.fill();

  // Ammo belt
  ctx.strokeStyle = '#654';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sp.x - 8, sp.y - 14);
  ctx.lineTo(sp.x + 6, sp.y - 2);
  ctx.stroke();
  ctx.strokeStyle = '#876';
  ctx.lineWidth = 1;
  for(let i=0;i<4;i++){
    const t = i/3;
    const bx = lerp(sp.x-8, sp.x+6, t);
    const by = lerp(sp.y-14, sp.y-2, t);
    ctx.beginPath();
    ctx.moveTo(bx-1, by-1); ctx.lineTo(bx+1, by+1); ctx.stroke();
  }

  // Arms + weapon
  const wep = WEAPONS[p.weapon];
  const weapLen = 14 + (Math.min(p.weapon, 6) * 2);
  const armRecoil = p.fireTimer > wep.rate*0.5 ? 3 : 0;

  ctx.strokeStyle = '#c96';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  const bax = sp.x + Math.cos(p.angle + 0.5) * 8;
  const bay = sp.y - 6 + Math.sin(p.angle + 0.5) * 5;
  ctx.beginPath(); ctx.moveTo(sp.x, sp.y - 6); ctx.lineTo(bax, bay); ctx.stroke();

  // Weapon barrel
  const weapColor = wep.glow ? (wep.color === '#0ff' ? '#456' : wep.color === '#88f' ? '#448' : wep.color === '#f0f' ? '#636' : wep.color === '#0f0' ? '#363' : wep.color === '#f4f' ? '#646' : '#333') : '#333';
  ctx.strokeStyle = weapColor;
  ctx.lineWidth = wep.name === 'RPG' || wep.name === 'BFG' ? 4 : wep.name === 'Railgun' ? 3.5 : 3;
  const wxStart = sp.x + Math.cos(p.angle) * 8;
  const wyStart = sp.y - 6 + Math.sin(p.angle) * 5;
  const wxEnd = sp.x + Math.cos(p.angle) * (weapLen - armRecoil);
  const wyEnd = sp.y - 6 + Math.sin(p.angle) * (weapLen - armRecoil) * 0.6;
  ctx.beginPath();
  ctx.moveTo(wxStart, wyStart); ctx.lineTo(wxEnd, wyEnd); ctx.stroke();

  // Weapon glow effect
  if(wep.glow){
    ctx.shadowBlur = 10;
    ctx.shadowColor = wep.color;
    ctx.strokeStyle = wep.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(wxEnd - Math.cos(p.angle)*4, wyEnd - Math.sin(p.angle)*2.5);
    ctx.lineTo(wxEnd, wyEnd);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Minigun spin
  if(wep.spinUp && p.spinUp > 0){
    ctx.save();
    ctx.translate(wxEnd, wyEnd);
    ctx.rotate(gameTime * p.spinUp * 30);
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    for(let i=0;i<3;i++){
      const a = i * Math.PI * 2 / 3;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a)*2, Math.sin(a)*2);
      ctx.lineTo(Math.cos(a)*5, Math.sin(a)*5);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Front arm
  ctx.strokeStyle = '#c96';
  ctx.lineWidth = 4;
  const fax = sp.x + Math.cos(p.angle - 0.3) * 10;
  const fay = sp.y - 6 + Math.sin(p.angle - 0.3) * 6;
  ctx.beginPath(); ctx.moveTo(sp.x + 2, sp.y - 6); ctx.lineTo(fax, fay); ctx.stroke();

  // Head
  ctx.fillStyle = '#c96';
  ctx.beginPath();
  ctx.ellipse(sp.x, sp.y - 20, 7, 7, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.fillStyle = '#321';
  ctx.beginPath();
  ctx.ellipse(sp.x, sp.y - 23, 7, 4, 0, 0, Math.PI);
  ctx.fill();
  // Red headband
  ctx.fillStyle = '#c22';
  ctx.fillRect(sp.x - 8, sp.y - 22, 16, 3);
  ctx.strokeStyle = '#c22';
  ctx.lineWidth = 2;
  const tailWave = Math.sin(gameTime*3) * 2;
  ctx.beginPath();
  ctx.moveTo(sp.x + 8, sp.y - 21);
  ctx.quadraticCurveTo(sp.x + 14, sp.y - 18 + tailWave, sp.x + 18, sp.y - 15 + tailWave);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sp.x + 8, sp.y - 20);
  ctx.quadraticCurveTo(sp.x + 12, sp.y - 16 + tailWave, sp.x + 16, sp.y - 13 + tailWave*0.8);
  ctx.stroke();

  ctx.globalAlpha = 1;
}

// =====================================================================
// ENEMY RENDERING
// =====================================================================
function renderEnemy(e) {
  const t = ENEMY_TYPES[e.type];
  const sp = toScreen(e.x, e.y);
  const s = e.size || t.size;
  const isBoss = e.isBoss;

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(sp.x, sp.y + 5*s, 12*s, 6*s, 0, 0, Math.PI*2);
  ctx.fill();

  const isFlashing = e.hitFlash > 0;
  if(isFlashing) ctx.globalAlpha = 0.7;

  // Legs
  const legOff = e.walking ? Math.sin(gameTime*10)*3*s : 0;
  ctx.fillStyle = '#343';
  ctx.beginPath();
  ctx.ellipse(sp.x - 3*s + legOff, sp.y + 2*s, 3.5*s, 4.5*s, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(sp.x + 3*s - legOff, sp.y + 2*s, 3.5*s, 4.5*s, 0, 0, Math.PI*2);
  ctx.fill();

  // Body
  const bodyColor = isFlashing ? '#fff' : t.color;
  ctx.fillStyle = bodyColor;
  ctx.beginPath();
  ctx.ellipse(sp.x, sp.y - 6*s, 9*s, 11*s, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.fillStyle = isFlashing ? '#ddd' : darkenColor(t.color, 0.7);
  ctx.beginPath();
  ctx.ellipse(sp.x + 1*s, sp.y - 4*s, 6*s, 7*s, 0.1, 0, Math.PI*2);
  ctx.fill();

  // Weapon
  if(t.shoots || t.healer){
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2.5*s;
    ctx.lineCap = 'round';
    const wxEnd = sp.x + Math.cos(e.angle)*12*s;
    const wyEnd = sp.y - 4*s + Math.sin(e.angle)*8*s;
    ctx.beginPath();
    ctx.moveTo(sp.x + Math.cos(e.angle)*5*s, sp.y - 4*s + Math.sin(e.angle)*3*s);
    ctx.lineTo(wxEnd, wyEnd);
    ctx.stroke();
  }

  // Arms
  ctx.strokeStyle = isFlashing ? '#eda' : '#a84';
  ctx.lineWidth = 3*s;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(sp.x - 2*s, sp.y - 5*s);
  ctx.lineTo(sp.x + Math.cos(e.angle+0.5)*8*s, sp.y - 5*s + Math.sin(e.angle+0.5)*5*s);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sp.x + 2*s, sp.y - 5*s);
  ctx.lineTo(sp.x + Math.cos(e.angle-0.4)*9*s, sp.y - 5*s + Math.sin(e.angle-0.4)*5*s);
  ctx.stroke();

  // Head
  ctx.fillStyle = isFlashing ? '#eda' : '#a84';
  ctx.beginPath();
  ctx.ellipse(sp.x, sp.y - 17*s, 6*s, 6*s, 0, 0, Math.PI*2);
  ctx.fill();

  // Helmet (most types)
  if(t.name !== 'Runner' && t.name !== 'Berserker' && t.name !== 'Bomber'){
    ctx.fillStyle = isFlashing ? '#aca' : darkenColor(t.color, 0.8);
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y - 19*s, 7*s, 4*s, 0, 0, Math.PI*2);
    ctx.fill();
  }

  // === SPECIAL ENEMY VISUALS ===
  // Berserker: red glow aura
  if(t.name === 'Berserker'){
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#f00';
    ctx.fillStyle = 'rgba(255,50,50,0.15)';
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y - 6*s, 14*s, 16*s, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Bomber: orange glow
  if(t.name === 'Bomber'){
    ctx.fillStyle = `rgba(255,160,0,${0.1 + Math.sin(gameTime*6)*0.05})`;
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y - 6*s, 12*s, 14*s, 0, 0, Math.PI*2);
    ctx.fill();
    // Fuse/timer
    ctx.fillStyle = '#ff0';
    ctx.font = `bold ${8*s}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('\u2622', sp.x, sp.y - 8*s);
  }

  // Medic: green cross
  if(t.healer){
    ctx.fillStyle = '#0f0';
    ctx.fillRect(sp.x - 2*s, sp.y - 12*s, 4*s, 8*s);
    ctx.fillRect(sp.x - 4*s, sp.y - 10*s, 8*s, 4*s);
  }

  // Shielded: energy shield
  if(t.hasShield && e.shieldHp > 0){
    const sa = 0.3 + Math.sin(gameTime*5)*0.1;
    ctx.strokeStyle = `rgba(80,130,255,${sa})`;
    ctx.lineWidth = 2*s;
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y - 6*s, 14*s, 18*s, 0, 0, Math.PI*2);
    ctx.stroke();
    ctx.fillStyle = `rgba(80,130,255,${sa*0.3})`;
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y - 6*s, 13*s, 17*s, 0, 0, Math.PI*2);
    ctx.fill();
  }

  // Tank armor
  if(t.name === 'Tank' || t.name === 'Juggernaut'){
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 2;
    ctx.strokeRect(sp.x - 10*s, sp.y - 14*s, 20*s, 16*s);
    ctx.fillStyle = '#666';
    ctx.beginPath();
    ctx.ellipse(sp.x - 10*s, sp.y - 8*s, 5*s, 4*s, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(sp.x + 10*s, sp.y - 8*s, 5*s, 4*s, 0, 0, Math.PI*2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;

  // Health bar
  if(e.hp < e.maxHp) {
    const barW = 24 * s;
    const barH = 3;
    const barY = sp.y - 24*s;
    ctx.fillStyle = '#300';
    ctx.fillRect(sp.x - barW/2, barY, barW, barH);
    ctx.fillStyle = isBoss ? '#f80' : '#f22';
    ctx.fillRect(sp.x - barW/2, barY, barW * (e.hp/e.maxHp), barH);
    // Shield bar
    if(e.maxShieldHp > 0 && e.shieldHp > 0){
      ctx.fillStyle = '#28f';
      ctx.fillRect(sp.x - barW/2, barY - 4, barW * (e.shieldHp/e.maxShieldHp), 2);
    }
  }

  // Boss name tag
  if(isBoss){
    ctx.fillStyle = '#f44';
    ctx.font = `bold ${12*s}px "Courier New", monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(e.bossName, sp.x, sp.y - 28*s);
    // Boss glow
    ctx.shadowBlur = 15;
    ctx.shadowColor = '#f00';
    ctx.strokeStyle = 'rgba(255,0,0,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y - 4*s, 16*s, 20*s, 0, 0, Math.PI*2);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

// =====================================================================
// BODY RENDERING (with blur/fade over time)
// =====================================================================
function renderBody(b) {
  const age = gameTime - b.createdAt;
  if(age > CFG.BODY_FADE_END) return;

  const sp = toScreen(b.x, b.y);
  const t = ENEMY_TYPES[b.type];
  const s = b.size;

  // Smooth alpha fade (no ctx.filter - it kills GPU performance)
  let bodyAlpha = Math.max(0.3, b.alpha);
  if(age > CFG.BODY_FADE_START){
    const fadeT = (age - CFG.BODY_FADE_START) / (CFG.BODY_FADE_END - CFG.BODY_FADE_START);
    bodyAlpha *= (1 - fadeT);
  }
  if(bodyAlpha < 0.02) return; // skip nearly invisible

  ctx.globalAlpha = bodyAlpha;
  ctx.save();
  ctx.translate(sp.x, sp.y);
  ctx.rotate(b.angle * 0.3);

  // Simulate "dissolve" by shrinking slightly as it fades
  const shrink = age > CFG.BODY_FADE_START ? 1 - (age - CFG.BODY_FADE_START) / (CFG.BODY_FADE_END - CFG.BODY_FADE_START) * 0.3 : 1;

  ctx.fillStyle = darkenColor(t.color, 0.5);
  ctx.beginPath();
  ctx.ellipse(0, 0, 14*s*shrink, 6*s*shrink, b.angle, 0, Math.PI*2);
  ctx.fill();

  ctx.fillStyle = '#864';
  ctx.beginPath();
  ctx.ellipse(Math.cos(b.angle)*10*s*shrink, Math.sin(b.angle)*4*s*shrink, 4*s*shrink, 4*s*shrink, 0, 0, Math.PI*2);
  ctx.fill();

  ctx.restore();
  ctx.globalAlpha = 1;
}

// =====================================================================
// PICKUP RENDERING
// =====================================================================
function renderPickup(pk) {
  const sp = toScreen(pk.x, pk.y);
  const bob = Math.sin(gameTime * 4) * 3;

  if(pk.type === 'health'){
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#0f0';
    ctx.fillStyle = '#0f0';
    ctx.fillRect(sp.x - 3, sp.y - 8 + bob, 6, 12);
    ctx.fillRect(sp.x - 6, sp.y - 5 + bob, 12, 6);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#8f8';
    ctx.fillRect(sp.x - 2, sp.y - 7 + bob, 4, 4);
  } else if(pk.type === 'shield'){
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#48f';
    ctx.fillStyle = '#48f';
    // Shield icon (diamond)
    ctx.beginPath();
    ctx.moveTo(sp.x, sp.y - 10 + bob);
    ctx.lineTo(sp.x + 6, sp.y - 3 + bob);
    ctx.lineTo(sp.x, sp.y + 2 + bob);
    ctx.lineTo(sp.x - 6, sp.y - 3 + bob);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#8af';
    ctx.beginPath();
    ctx.moveTo(sp.x, sp.y - 8 + bob);
    ctx.lineTo(sp.x + 3, sp.y - 4 + bob);
    ctx.lineTo(sp.x, sp.y - 1 + bob);
    ctx.lineTo(sp.x - 3, sp.y - 4 + bob);
    ctx.closePath();
    ctx.fill();
  }
}

// =====================================================================
// HUD
// =====================================================================
function renderHUD() {
  const p = player;
  if(!p) return;
  const wep = WEAPONS[p.weapon];

  // === BOSS HEALTH BAR (top center) ===
  const boss = enemies.find(e => e.isBoss);
  if(boss){
    const bw = 400, bh = 16, bx = (W-bw)/2, by = 20;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(bx - 4, by - 18, bw + 8, bh + 24);
    ctx.fillStyle = '#300';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#f44';
    ctx.fillRect(bx, by, bw * (boss.hp/boss.maxHp), bh);
    // Boss shield
    if(boss.maxShieldHp > 0 && boss.shieldHp > 0){
      ctx.fillStyle = '#28f';
      ctx.fillRect(bx, by + bh + 2, bw * (boss.shieldHp/boss.maxShieldHp), 4);
    }
    ctx.font = 'bold 14px "Courier New", monospace';
    ctx.fillStyle = '#f88';
    ctx.textAlign = 'center';
    ctx.fillText(`BOSS: ${boss.bossName}`, W/2, by - 4);
    ctx.fillStyle = '#fff';
    ctx.font = '11px "Courier New", monospace';
    ctx.fillText(`${Math.ceil(boss.hp)} / ${boss.maxHp}`, W/2, by + 13);
  }

  // === HEALTH BAR ===
  const hbW = 250, hbH = 20, hbX = 20, hbY = H - 70;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(hbX - 2, hbY - 2, hbW + 4, hbH + 4);
  const hpRatio = p.hp / p.maxHp;
  const hpColor = hpRatio > 0.6 ? '#2d2' : hpRatio > 0.3 ? '#da2' : '#d22';
  ctx.fillStyle = '#311';
  ctx.fillRect(hbX, hbY, hbW, hbH);
  ctx.fillStyle = hpColor;
  ctx.fillRect(hbX, hbY, hbW * hpRatio, hbH);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${Math.ceil(p.hp)} / ${p.maxHp}`, hbX + hbW/2, hbY + 15);

  // === SHIELD BAR (below health) ===
  const sbY = hbY + hbH + 4;
  const sbH = 8;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(hbX - 1, sbY - 1, hbW + 2, sbH + 2);
  ctx.fillStyle = '#113';
  ctx.fillRect(hbX, sbY, hbW, sbH);
  const shieldRatio = p.shield / p.maxShield;
  ctx.fillStyle = '#48f';
  ctx.fillRect(hbX, sbY, hbW * shieldRatio, sbH);
  ctx.fillStyle = '#aaf';
  ctx.font = '9px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`SHIELD: ${Math.ceil(p.shield)}`, hbX + hbW/2, sbY + 7);

  // === SPECIAL ABILITY METER ===
  const spX = hbX, spY = sbY + sbH + 6, spW = 100, spH = 10;
  const spRatio = p.specialCharge / CFG.SPECIAL_MAX_CHARGE;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(spX - 1, spY - 1, spW + 2, spH + 2);
  ctx.fillStyle = '#220';
  ctx.fillRect(spX, spY, spW, spH);
  const spColor = spRatio >= 1 ? `hsl(${(gameTime*120)%360},100%,60%)` : '#fa0';
  ctx.fillStyle = spColor;
  ctx.fillRect(spX, spY, spW * spRatio, spH);
  ctx.fillStyle = spRatio >= 1 ? '#fff' : '#aa8';
  ctx.font = '8px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(spRatio >= 1 ? 'RIGHT-CLICK: SHOCKWAVE!' : `SHOCKWAVE: ${p.specialCharge}/${CFG.SPECIAL_MAX_CHARGE}`, spX + spW/2, spY + 8);

  // Weapon info
  ctx.textAlign = 'left';
  ctx.font = 'bold 18px "Courier New", monospace';
  ctx.fillStyle = '#ff0';
  ctx.fillText(`${wep.name.toUpperCase()}`, hbX, hbY - 14);

  // Ammo
  const ammoText = p.reloading
    ? `RELOADING... ${(p.reloadTimer).toFixed(1)}s`
    : wep.mag === Infinity ? 'INF' : `${p.magAmmo} / ${wep.mag}`;
  ctx.font = '14px "Courier New", monospace';
  ctx.fillStyle = p.reloading ? '#f80' : p.magAmmo <= wep.mag * 0.2 ? '#f44' : '#ddd';
  ctx.fillText(ammoText, hbX + 160, hbY - 14);

  // Score
  ctx.textAlign = 'right';
  ctx.font = 'bold 24px "Courier New", monospace';
  ctx.fillStyle = '#ff0';
  ctx.fillText(`${score}`, W - 20, 35);
  ctx.font = '12px "Courier New", monospace';
  ctx.fillStyle = '#aaa';
  ctx.fillText('SCORE', W - 20, 50);

  // Wave
  ctx.font = 'bold 20px "Courier New", monospace';
  ctx.fillStyle = '#fa0';
  ctx.fillText(`WAVE ${wave}`, W - 20, 75);

  // Kills
  ctx.font = '14px "Courier New", monospace';
  ctx.fillStyle = '#ddd';
  ctx.fillText(`KILLS: ${kills}`, W - 20, 100);

  // Combo
  if(combo > 1) {
    ctx.font = 'bold 18px "Courier New", monospace';
    ctx.fillStyle = combo > 10 ? '#f22' : combo > 5 ? '#fa0' : '#ff0';
    ctx.fillText(`COMBO x${combo}`, W - 20, 125);
    const cbW = 80, cbH = 3;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(W - 20 - cbW, 130, cbW, cbH);
    ctx.fillStyle = '#ff0';
    ctx.fillRect(W - 20 - cbW, 130, cbW * (comboTimer / CFG.COMBO_TIMEOUT), cbH);
  }

  // Time
  ctx.textAlign = 'left';
  ctx.font = '14px "Courier New", monospace';
  ctx.fillStyle = '#aaa';
  const mins = Math.floor(gameTime / 60);
  const secs = Math.floor(gameTime % 60);
  ctx.fillText(`TIME: ${mins}:${secs.toString().padStart(2,'0')}`, 20, 30);

  // Weapon slots (scrollable display for many weapons)
  const maxVisible = Math.min(unlockedWeapons, 8);
  const slotW = 50, slotH = 22, slotX = 20, slotY = H - 115;
  for(let i=0;i<maxVisible;i++){
    const x = slotX + i*(slotW+3);
    ctx.fillStyle = i === p.weapon ? 'rgba(255,200,0,0.3)' : 'rgba(0,0,0,0.4)';
    ctx.fillRect(x, slotY, slotW, slotH);
    ctx.strokeStyle = i === p.weapon ? '#ff0' : '#555';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, slotY, slotW, slotH);
    ctx.fillStyle = i === p.weapon ? '#ff0' : '#999';
    ctx.font = '9px "Courier New", monospace';
    ctx.textAlign = 'center';
    const keyLabel = i < 9 ? (i+1) : i === 9 ? 0 : '-';
    ctx.fillText(`${keyLabel}:${WEAPONS[i].name}`, x + slotW/2, slotY + 14);
  }
  if(unlockedWeapons > maxVisible){
    ctx.fillStyle = '#888';
    ctx.font = '9px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`+${unlockedWeapons-maxVisible} more (Q/E)`, slotX + maxVisible*(slotW+3), slotY + 14);
  }

  // Next weapon unlock hint
  if(unlockedWeapons < WEAPONS.length && !bossActive){
    const next = WEAPONS[unlockedWeapons];
    ctx.textAlign = 'left';
    ctx.font = '11px "Courier New", monospace';
    ctx.fillStyle = '#888';
    ctx.fillText(`Next: ${next.name} at ${next.unlock} pts`, slotX, slotY - 6);
    const prevUnlock = unlockedWeapons > 1 ? WEAPONS[unlockedWeapons-1].unlock : 0;
    const prog = (score - prevUnlock) / (next.unlock - prevUnlock);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(slotX + 200, slotY - 12, 80, 6);
    ctx.fillStyle = '#4a4';
    ctx.fillRect(slotX + 200, slotY - 12, 80 * clamp(prog,0,1), 6);
  } else if(bossActive){
    ctx.textAlign = 'left';
    ctx.font = 'bold 11px "Courier New", monospace';
    ctx.fillStyle = '#f44';
    ctx.fillText('DEFEAT THE BOSS TO UNLOCK!', slotX, slotY - 6);
  }

  // Minimap
  const mmSize = 120, mmX = W - mmSize - 15, mmY = H - mmSize - 15;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(mmX, mmY, mmSize, mmSize);
  const mmScale = 0.04;
  const mmCx = mmX + mmSize/2, mmCy = mmY + mmSize/2;

  // Draw cached minimap water (rebuilt every 30 frames to save CPU)
  if(!renderHUD._mmCanvas){
    renderHUD._mmCanvas = document.createElement('canvas');
    renderHUD._mmCanvas.width = mmSize;
    renderHUD._mmCanvas.height = mmSize;
    renderHUD._mmFrame = 0;
    renderHUD._mmLastPx = 0;
    renderHUD._mmLastPy = 0;
  }
  renderHUD._mmFrame++;
  const px0 = Math.round(player.x / 50);
  const py0 = Math.round(player.y / 50);
  if(renderHUD._mmFrame % 30 === 0 || renderHUD._mmLastPx !== px0 || renderHUD._mmLastPy !== py0){
    renderHUD._mmLastPx = px0;
    renderHUD._mmLastPy = py0;
    const mc = renderHUD._mmCanvas.getContext('2d');
    mc.clearRect(0, 0, mmSize, mmSize);
    mc.fillStyle = 'rgba(30,60,120,0.7)';
    const mmStep = 4;
    for(let py = 0; py < mmSize; py += mmStep){
      for(let px = 0; px < mmSize; px += mmStep){
        const sx = (px - mmSize/2) / mmScale;
        const sy = (py - mmSize/2) / (mmScale * CFG.ISO_SCALE);
        const wx = player.x + (sx + sy) * 0.5;
        const wy = player.y + (sy - sx) * 0.5;
        if(getTerrainTypeAt(wx, wy) === 'water'){
          mc.fillRect(px, py, mmStep, mmStep);
        }
      }
    }
  }
  ctx.drawImage(renderHUD._mmCanvas, mmX, mmY);

  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(mmX, mmY, mmSize, mmSize);

  for(const e of enemies){
    // Apply isometric transform so minimap matches screen orientation
    const dx = e.x - player.x, dy = e.y - player.y;
    const ex = mmCx + (dx - dy) * mmScale;
    const ey = mmCy + (dx + dy) * mmScale * CFG.ISO_SCALE;
    if(ex > mmX && ex < mmX+mmSize && ey > mmY && ey < mmY+mmSize){
      ctx.fillStyle = e.isBoss ? '#f0f' : '#f44';
      ctx.beginPath();
      ctx.arc(ex, ey, e.isBoss ? 4 : 2, 0, Math.PI*2);
      ctx.fill();
    }
  }

  ctx.fillStyle = '#0f0';
  ctx.beginPath();
  ctx.arc(mmCx, mmCy, 3, 0, Math.PI*2);
  ctx.fill();

  // Crosshair
  const chX = mouseX, chY = mouseY;
  ctx.strokeStyle = p.specialCharge >= CFG.SPECIAL_MAX_CHARGE ? '#ff0' : '#fff';
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  ctx.arc(chX, chY, 12, 0, Math.PI*2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(chX-18, chY); ctx.lineTo(chX-6, chY);
  ctx.moveTo(chX+6, chY); ctx.lineTo(chX+18, chY);
  ctx.moveTo(chX, chY-18); ctx.lineTo(chX, chY-6);
  ctx.moveTo(chX, chY+6); ctx.lineTo(chX, chY+18);
  ctx.stroke();
  ctx.fillStyle = '#f00';
  ctx.beginPath();
  ctx.arc(chX, chY, 2, 0, Math.PI*2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Invincibility indicator
  if(p.invincible > 0){
    ctx.fillStyle = 'rgba(255,255,0,0.15)';
    ctx.fillRect(0, 0, W, H);
  }

  // Low health vignette
  if(hpRatio < 0.3){
    const grd = ctx.createRadialGradient(W/2, H/2, H*0.3, W/2, H/2, H*0.7);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(1, `rgba(180,0,0,${(1-hpRatio/0.3)*0.4})`);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W, H);
  }

  // Shield hit vignette
  if(p.shield <= 0 && shieldRegenTimer < 0.5){
    const grd = ctx.createRadialGradient(W/2, H/2, H*0.35, W/2, H/2, H*0.7);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(1, `rgba(50,80,200,${(1-shieldRegenTimer/0.5)*0.2})`);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W, H);
  }
}
