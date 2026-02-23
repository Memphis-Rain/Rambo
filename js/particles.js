// =====================================================================
// PARTICLE SYSTEM
// =====================================================================
function spawnParticle(x, y, vx, vy, life, size, color, type='default', opts={}) {
  if (particles.length >= CFG.MAX_PARTICLES) particles.shift();
  particles.push({
    x, y, vx, vy, life, maxLife:life, size, color, type,
    gravity: opts.gravity || 0,
    friction: opts.friction || 0.98,
    shrink: opts.shrink !== undefined ? opts.shrink : true,
    grow: opts.grow || false,
    growRate: opts.growRate || 0,
    alpha: opts.alpha || 1,
    fadeStart: opts.fadeStart || 0.5,
    rotation: opts.rotation || 0,
    rotSpeed: opts.rotSpeed || 0,
  });
}

function spawnBloodSpray(x, y, angle, intensity=1) {
  const count = Math.floor(8 + intensity * 15);
  for(let i=0;i<count;i++) {
    const a = angle + randRange(-0.6, 0.6);
    const speed = randRange(60, 220) * intensity;
    const sz = randRange(1.5, 5);
    spawnParticle(x, y,
      Math.cos(a)*speed, Math.sin(a)*speed,
      randRange(0.4, 1.2), sz,
      `rgb(${140+randInt(0,90)},${randInt(0,25)},${randInt(0,15)})`,
      'blood', { gravity: 180, friction: 0.93, shrink:true }
    );
  }
  for(let i=0;i<Math.floor(4*intensity);i++){
    const a = angle + randRange(-1.2, 1.2);
    const speed = randRange(20, 80) * intensity;
    spawnParticle(x, y,
      Math.cos(a)*speed, Math.sin(a)*speed,
      randRange(0.2, 0.5), randRange(3, 7),
      `rgba(${130+randInt(0,60)},${randInt(0,15)},${randInt(0,10)},`,
      'smoke', { gravity: 0, friction: 0.9, grow:false, fadeStart:0.2 }
    );
  }
  const poolCount = Math.floor(1 + intensity * 2);
  for(let i=0;i<poolCount;i++){
    if (bloodPools.length < CFG.MAX_BLOOD_POOLS) {
      bloodPools.push({
        x: x + randRange(-12, 12), y: y + randRange(-10, 10),
        radius: randRange(3, 7) * intensity,
        maxRadius: randRange(10, 24) * intensity,
        color: `rgba(${100+randInt(0,50)},${randInt(0,12)},${randInt(0,8)},`,
        alpha: 0.75, growing: true, createdAt: gameTime,
      });
    }
  }
}

function spawnExplosion(x, y, radius=80) {
  const fireCount = Math.floor(30 + radius * 0.3);
  for(let i=0;i<fireCount;i++){
    const a = Math.random()*Math.PI*2;
    const speed = randRange(50, 250) * (radius/80);
    const c = randInt(0,2);
    const colors = ['#ff4','#f80','#f40'];
    spawnParticle(x, y,
      Math.cos(a)*speed, Math.sin(a)*speed,
      randRange(0.2, 0.8), randRange(3, 10),
      colors[c], 'fire', { gravity: -50, friction:0.92, shrink:true }
    );
  }
  const smokeCount = Math.floor(15 + radius * 0.2);
  for(let i=0;i<smokeCount;i++){
    const a = Math.random()*Math.PI*2;
    const speed = randRange(20, 100);
    spawnParticle(x, y,
      Math.cos(a)*speed, Math.sin(a)*speed,
      randRange(0.5, 2.0), randRange(5, 18),
      `rgba(${80+randInt(0,40)},${70+randInt(0,30)},${60+randInt(0,30)},`,
      'smoke', { gravity: -30, friction:0.94, grow:true, growRate: 15, fadeStart:0.3 }
    );
  }
  for(let i=0;i<15;i++){
    const a = Math.random()*Math.PI*2;
    const speed = randRange(100, 300);
    spawnParticle(x, y,
      Math.cos(a)*speed, Math.sin(a)*speed,
      randRange(0.5, 1.2), randRange(1, 3),
      `rgb(${80+randInt(0,60)},${60+randInt(0,40)},${30+randInt(0,30)})`,
      'debris', { gravity: 300, friction:0.96, shrink:false, rotSpeed: randRange(-10,10) }
    );
  }
  // Flash
  spawnParticle(x, y, 0, 0, 0.12, radius*0.8, '#fff', 'flash', { shrink:false, fadeStart:0 });
  spawnParticle(x, y, 0, 0, 0.18, radius*0.5, '#ff8', 'flash', { shrink:false, fadeStart:0 });

  addShake(Math.min(25, radius * 0.15));
  playSound(radius > 150 ? 'big_explosion' : 'explosion', Math.min(1, radius/100));
}

function spawnMuzzleFlash(x, y, angle) {
  for(let i=0;i<5;i++){
    const a = angle + randRange(-0.3, 0.3);
    const speed = randRange(100, 200);
    spawnParticle(x, y,
      Math.cos(a)*speed, Math.sin(a)*speed,
      randRange(0.03, 0.08), randRange(2, 5),
      '#ff0', 'flash', { shrink:true, fadeStart:0 }
    );
  }
  spawnParticle(x, y, 0, 0, 0.05, 12, '#fff', 'flash', { shrink:false, fadeStart:0 });
}

function spawnSmoke(x, y, amount=5) {
  for(let i=0;i<amount;i++){
    spawnParticle(
      x + randRange(-5,5), y + randRange(-5,5),
      randRange(-15,15), randRange(-30,-10),
      randRange(0.4, 1.0), randRange(3, 8),
      `rgba(${150+randInt(0,50)},${140+randInt(0,40)},${130+randInt(0,40)},`,
      'smoke', { gravity:-20, friction:0.96, grow:true, growRate:10, fadeStart:0.3 }
    );
  }
}

function spawnShellCasing(x, y, angle) {
  const a = angle + Math.PI/2 + randRange(-0.3, 0.3);
  const speed = randRange(60, 120);
  shells.push({
    x, y, vx: Math.cos(a)*speed, vy: Math.sin(a)*speed,
    life: 1.5, rotation: Math.random()*Math.PI*2,
    rotSpeed: randRange(-15, 15), size: randRange(1.5, 2.5),
    gravity: 250, grounded: false,
  });
}

function spawnLightning(x1, y1, x2, y2) {
  const dx = x2-x1, dy = y2-y1;
  const d = Math.sqrt(dx*dx+dy*dy);
  const steps = Math.max(3, Math.floor(d/12));
  for(let i=0;i<=steps;i++){
    const t = i/steps;
    const px = x1 + dx*t + (i>0&&i<steps ? randRange(-10,10) : 0);
    const py = y1 + dy*t + (i>0&&i<steps ? randRange(-10,10) : 0);
    spawnParticle(px, py, randRange(-15,15), randRange(-15,15),
      0.2, randRange(1.5,3), '#88f', 'flash', {fadeStart:0, shrink:true});
  }
}

function spawnDisintegration(x, y) {
  for(let j=0;j<25;j++){
    spawnParticle(x+randRange(-12,12), y+randRange(-12,12),
      randRange(-80,80), randRange(-100,-20),
      randRange(0.3, 0.8), randRange(1,4),
      randInt(0,1)?'#f4f':'#a0f', 'fire', {gravity:-40, friction:0.92, shrink:true});
  }
}

function spawnShockwaveEffect(x, y) {
  shockwaveEffects.push({
    x, y, radius: 10, maxRadius: CFG.SPECIAL_RADIUS, life: 0.5, maxLife: 0.5
  });
  // Particles
  for(let i=0;i<50;i++){
    const a = Math.random()*Math.PI*2;
    const speed = randRange(150, 400);
    spawnParticle(x, y,
      Math.cos(a)*speed, Math.sin(a)*speed,
      randRange(0.3, 0.7), randRange(3, 8),
      randInt(0,1)?'#ff0':'#f80', 'fire', {gravity:0, friction:0.9, shrink:true}
    );
  }
  // Ground dust ring
  for(let i=0;i<30;i++){
    const a = Math.random()*Math.PI*2;
    const speed = randRange(80, 200);
    spawnParticle(x, y,
      Math.cos(a)*speed, Math.sin(a)*speed,
      randRange(0.5, 1.2), randRange(5, 12),
      `rgba(${120+randInt(0,40)},${100+randInt(0,30)},${70+randInt(0,30)},`,
      'smoke', {gravity:0, friction:0.92, grow:true, growRate:8, fadeStart:0.3}
    );
  }
}

function updateParticles(dt) {
  for(let i=particles.length-1; i>=0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.vx *= p.friction;
    p.vy *= p.friction;
    p.vy += p.gravity * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.grow) p.size += p.growRate * dt;
    else if (p.shrink) p.size *= (1 - dt*2);
    p.rotation += p.rotSpeed * dt;
  }

  // Update shells
  for(let i=shells.length-1; i>=0; i--) {
    const s = shells[i];
    s.life -= dt;
    if (s.life <= 0) { shells.splice(i, 1); continue; }
    if (!s.grounded) {
      s.vy += s.gravity * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.rotation += s.rotSpeed * dt;
      s.vx *= 0.97;
      if (s.vy > 100) { s.grounded = true; s.vx=0; s.vy=0; }
    }
  }

  // Update blood pools
  for (const bp of bloodPools) {
    if (bp.growing && bp.radius < bp.maxRadius) {
      bp.radius += dt * 8;
      if (bp.radius >= bp.maxRadius) bp.growing = false;
    }
    if (bp.alpha > 0.25) bp.alpha -= dt * 0.02;
  }

  // Update shockwave effects
  for(let i=shockwaveEffects.length-1;i>=0;i--){
    const sw = shockwaveEffects[i];
    sw.life -= dt;
    if(sw.life<=0){ shockwaveEffects.splice(i,1); continue; }
    const t = 1 - sw.life/sw.maxLife;
    sw.radius = sw.maxRadius * t;
  }
}
