// =====================================================================
// PIXI HUD - UI rendering using PixiJS Text and Graphics
// =====================================================================

// HUD elements cache (persistent UI elements)
const hudElements = {
  healthBar: null,       // bottom-left panel (panel bg + HP bar + weapon slots)
  shieldBar: null,       // shield bar graphics
  specialBar: null,      // shockwave bar + combo bar graphics
  bossHealthBar: null,   // top-center boss bar
  statsPanel: null,      // top-right stats panel
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

/**
 * Initialize HUD elements (called once)
 */
function initPixiHUD() {
  // Create graphics objects
  hudElements.healthBar = new PIXI.Graphics();
  hudElements.shieldBar = new PIXI.Graphics();
  hudElements.specialBar = new PIXI.Graphics();
  hudElements.bossHealthBar = new PIXI.Graphics();
  hudElements.statsPanel = new PIXI.Graphics();
  hudElements.minimapGraphics = new PIXI.Graphics();
  hudElements.crosshair = new PIXI.Graphics();

  const mono = 'Courier New, monospace';

  // Weapon name - bold yellow
  hudElements.weaponText = new PIXI.Text({ text: '', style: { fontFamily: mono, fontSize: 15, fontWeight: 'bold', fill: 0xffdd44 } });
  // Ammo - right-aligned
  hudElements.ammoText = new PIXI.Text({ text: '', style: { fontFamily: mono, fontSize: 13, fill: 0xcccccc } });
  // HP text inside bar
  hudElements.hpText = new PIXI.Text({ text: '', style: { fontFamily: mono, fontSize: 11, fontWeight: 'bold', fill: 0xffffff } });
  // Shield label
  hudElements.shieldText = new PIXI.Text({ text: '', style: { fontFamily: mono, fontSize: 9, fill: 0x6699cc } });
  // Shockwave label
  hudElements.specialText = new PIXI.Text({ text: '', style: { fontFamily: mono, fontSize: 9, fill: 0x997755 } });

  // Right stats panel
  hudElements.scoreText = new PIXI.Text({ text: '', style: { fontFamily: mono, fontSize: 28, fontWeight: 'bold', fill: 0xffd700 } });
  hudElements.scoreLabelText = new PIXI.Text({ text: 'SCORE', style: { fontFamily: mono, fontSize: 10, fill: 0x777777 } });
  hudElements.waveText = new PIXI.Text({ text: '', style: { fontFamily: mono, fontSize: 16, fontWeight: 'bold', fill: 0xff8c00 } });
  hudElements.killsText = new PIXI.Text({ text: '', style: { fontFamily: mono, fontSize: 13, fill: 0xdd6666 } });
  hudElements.timeText = new PIXI.Text({ text: '', style: { fontFamily: mono, fontSize: 11, fill: 0x888888 } });
  hudElements.comboText = new PIXI.Text({ text: '', style: { fontFamily: mono, fontSize: 14, fontWeight: 'bold', fill: 0xffff44 } });

  // Boss bar
  hudElements.bossNameText = new PIXI.Text({ text: '', style: { fontFamily: mono, fontSize: 13, fontWeight: 'bold', fill: 0xff6666 } });
  hudElements.bossHPText = new PIXI.Text({ text: '', style: { fontFamily: mono, fontSize: 11, fontWeight: 'bold', fill: 0xffffff } });

  // Weapon unlock hints
  hudElements.nextText = new PIXI.Text({ text: '', style: { fontFamily: mono, fontSize: 10, fill: 0x888888 } });
  hudElements.bossUnlockText = new PIXI.Text({ text: 'DEFEAT THE BOSS TO UNLOCK!', style: { fontFamily: mono, fontSize: 10, fontWeight: 'bold', fill: 0xff4444 } });
  hudElements.moreText = new PIXI.Text({ text: '', style: { fontFamily: mono, fontSize: 9, fill: 0x888888 } });

  // FPS debug text (top-left, only shown when showDebugOverlay=true)
  hudElements.fpsText = new PIXI.Text({ text: '', style: { fontFamily: mono, fontSize: 12, fill: 0x00ff00 } });

  // Weapon slot texts (up to 11)
  for (let i = 0; i < 11; i++) {
    const slotText = new PIXI.Text({ text: '', style: { fontFamily: mono, fontSize: 9, fill: 0x668899 } });
    slotText.anchor.set(0.5, 0.5);
    hudElements.slotTexts.push(slotText);
    uiContainer.addChild(slotText);
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
  uiContainer.addChild(hudElements.invincGraphics);
  uiContainer.addChild(hudElements.vignetteGraphics);
  uiContainer.addChild(hudElements.shieldVignetteGraphics);

  // Initially hide optional elements
  hudElements.bossNameText.visible = false;
  hudElements.bossHPText.visible = false;
  hudElements.moreText.visible = false;
  hudElements.nextText.visible = false;
  hudElements.bossUnlockText.visible = false;
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
  const wep = WEAPONS[p.weapon];
  const hpRatio = p.hp / p.maxHp;

  // Clear frame graphics
  hudElements.healthBar.clear();
  hudElements.shieldBar.clear();
  hudElements.specialBar.clear();
  hudElements.bossHealthBar.clear();
  hudElements.statsPanel.clear();
  hudElements.minimapGraphics.clear();
  hudElements.crosshair.clear();

  // =========================================================
  // BOSS HEALTH BAR (top center)
  // =========================================================
  const boss = enemies.find(e => e.isBoss);
  if (boss) {
    const bw = 480, bh = 18;
    const bx = (W - bw) / 2, by = 24;

    // Dark panel behind bar
    hudElements.bossHealthBar.beginFill(0x080c10, 0.88);
    hudElements.bossHealthBar.drawRect(bx - 20, by - 22, bw + 40, bh + 34);
    hudElements.bossHealthBar.endFill();

    // Thin accent lines top and bottom of panel
    hudElements.bossHealthBar.lineStyle(1, 0x882222, 0.6);
    hudElements.bossHealthBar.moveTo(bx - 20, by - 22);
    hudElements.bossHealthBar.lineTo(bx + bw + 20, by - 22);
    hudElements.bossHealthBar.moveTo(bx - 20, by + bh + 12);
    hudElements.bossHealthBar.lineTo(bx + bw + 20, by + bh + 12);
    hudElements.bossHealthBar.lineStyle(0);

    // Empty bar bg
    hudElements.bossHealthBar.beginFill(0x3a0000);
    hudElements.bossHealthBar.drawRect(bx, by, bw, bh);
    hudElements.bossHealthBar.endFill();

    // HP fill
    const hpFillW = bw * (boss.hp / boss.maxHp);
    if (hpFillW > 0) {
      hudElements.bossHealthBar.beginFill(0xcc2222);
      hudElements.bossHealthBar.drawRect(bx, by, hpFillW, bh);
      hudElements.bossHealthBar.endFill();
      // Highlight strip
      hudElements.bossHealthBar.beginFill(0xff6666, 0.35);
      hudElements.bossHealthBar.drawRect(bx, by, hpFillW, bh * 0.38);
      hudElements.bossHealthBar.endFill();
    }

    // Bar border
    hudElements.bossHealthBar.lineStyle(1, 0x661111);
    hudElements.bossHealthBar.drawRect(bx, by, bw, bh);
    hudElements.bossHealthBar.lineStyle(0);

    // Shield bar (below)
    if (boss.maxShieldHp > 0 && boss.shieldHp > 0) {
      hudElements.bossHealthBar.beginFill(0x113366);
      hudElements.bossHealthBar.drawRect(bx, by + bh + 3, bw, 4);
      hudElements.bossHealthBar.endFill();
      hudElements.bossHealthBar.beginFill(0x2288ff);
      hudElements.bossHealthBar.drawRect(bx, by + bh + 3, bw * (boss.shieldHp / boss.maxShieldHp), 4);
      hudElements.bossHealthBar.endFill();
    }

    // Boss name - centered above bar
    hudElements.bossNameText.text = boss.bossName ? boss.bossName.toUpperCase() : 'BOSS';
    hudElements.bossNameText.style.fill = 0xff5555;
    hudElements.bossNameText.anchor.set(0.5, 1);
    hudElements.bossNameText.x = W / 2;
    hudElements.bossNameText.y = by - 3;
    hudElements.bossNameText.visible = true;

    // HP numbers centered in bar
    hudElements.bossHPText.text = `${Math.ceil(boss.hp)} / ${boss.maxHp}`;
    hudElements.bossHPText.anchor.set(0.5, 0.5);
    hudElements.bossHPText.x = W / 2;
    hudElements.bossHPText.y = by + bh / 2;
    hudElements.bossHPText.visible = true;
  } else {
    hudElements.bossNameText.visible = false;
    hudElements.bossHPText.visible = false;
  }

  // =========================================================
  // PLAYER STATUS PANEL (bottom-left)
  // =========================================================
  const panX = 12, panW = 258, panH = 110;
  const panY = H - panH - 50;   // 50px below = slots(32) + gap(6) + margin(12)

  // Dark semi-transparent panel background
  hudElements.healthBar.beginFill(0x080c14, 0.84);
  hudElements.healthBar.drawRect(panX, panY, panW, panH);
  hudElements.healthBar.endFill();
  // Accent border
  hudElements.healthBar.lineStyle(1, 0x1e3a5f, 0.7);
  hudElements.healthBar.drawRect(panX, panY, panW, panH);
  // Top accent line (brighter)
  hudElements.healthBar.lineStyle(1, 0x2a5a8a, 0.5);
  hudElements.healthBar.moveTo(panX + 1, panY + 1);
  hudElements.healthBar.lineTo(panX + panW - 1, panY + 1);
  hudElements.healthBar.lineStyle(0);

  // --- Weapon name (top-left) + Ammo (top-right) ---
  hudElements.weaponText.text = wep.name.toUpperCase();
  hudElements.weaponText.style.fill = 0xffdd44;
  hudElements.weaponText.anchor.set(0, 0);
  hudElements.weaponText.x = panX + 10;
  hudElements.weaponText.y = panY + 9;

  const ammoDisplay = p.reloading
    ? `RELOADING ${p.reloadTimer.toFixed(1)}s`
    : wep.mag === Infinity ? 'INF' : `${p.magAmmo} / ${wep.mag}`;
  hudElements.ammoText.text = ammoDisplay;
  hudElements.ammoText.style.fill = p.reloading ? 0xff8800
    : p.magAmmo <= Math.ceil(wep.mag * 0.25) ? 0xff4444 : 0xbbbbbb;
  hudElements.ammoText.anchor.set(1, 0);
  hudElements.ammoText.x = panX + panW - 10;
  hudElements.ammoText.y = panY + 9;

  // --- HP bar ---
  const barX = panX + 10, barW = panW - 20;
  const hpBarY = panY + 36, hpBarH = 14;
  const hpColor = hpRatio > 0.6 ? 0x22cc22 : hpRatio > 0.3 ? 0xddaa22 : 0xdd2222;

  // Background
  hudElements.healthBar.beginFill(0x220a0a);
  hudElements.healthBar.drawRect(barX, hpBarY, barW, hpBarH);
  hudElements.healthBar.endFill();
  // Fill
  if (hpRatio > 0) {
    hudElements.healthBar.beginFill(hpColor);
    hudElements.healthBar.drawRect(barX, hpBarY, barW * hpRatio, hpBarH);
    hudElements.healthBar.endFill();
    // Highlight strip (subtle)
    hudElements.healthBar.beginFill(0xffffff, 0.1);
    hudElements.healthBar.drawRect(barX, hpBarY, barW * hpRatio, Math.floor(hpBarH * 0.38));
    hudElements.healthBar.endFill();
  }
  // Thin border
  hudElements.healthBar.lineStyle(1, 0x333333);
  hudElements.healthBar.drawRect(barX, hpBarY, barW, hpBarH);
  hudElements.healthBar.lineStyle(0);

  // HP label (left, above bar)
  hudElements.hpText.text = `HP  ${Math.ceil(p.hp)} / ${p.maxHp}`;
  hudElements.hpText.style.fill = hpColor;
  hudElements.hpText.anchor.set(0, 1);
  hudElements.hpText.x = barX;
  hudElements.hpText.y = hpBarY - 1;
  hudElements.hpText.visible = true;

  // --- Shield bar ---
  const sbY = hpBarY + hpBarH + 14, sbH = 7;
  const shieldRatio = p.shield / p.maxShield;

  hudElements.shieldBar.beginFill(0x0a0a22);
  hudElements.shieldBar.drawRect(barX, sbY, barW, sbH);
  hudElements.shieldBar.endFill();
  if (shieldRatio > 0) {
    hudElements.shieldBar.beginFill(0x3377dd);
    hudElements.shieldBar.drawRect(barX, sbY, barW * shieldRatio, sbH);
    hudElements.shieldBar.endFill();
  }
  hudElements.shieldBar.lineStyle(1, 0x222244);
  hudElements.shieldBar.drawRect(barX, sbY, barW, sbH);
  hudElements.shieldBar.lineStyle(0);

  hudElements.shieldText.text = `SHIELD  ${Math.ceil(p.shield)}`;
  hudElements.shieldText.style.fill = shieldRatio > 0 ? 0x5599cc : 0x445566;
  hudElements.shieldText.anchor.set(0, 1);
  hudElements.shieldText.x = barX;
  hudElements.shieldText.y = sbY - 1;
  hudElements.shieldText.visible = true;

  // --- Shockwave bar ---
  const spY = sbY + sbH + 14, spH = 7;
  const spRatio = p.specialCharge / CFG.SPECIAL_MAX_CHARGE;
  const spReady = spRatio >= 1;

  hudElements.specialBar.beginFill(0x1a1500);
  hudElements.specialBar.drawRect(barX, spY, barW, spH);
  hudElements.specialBar.endFill();
  if (spRatio > 0) {
    const spColor = spReady ? hslToHex((gameTime * 120) % 360, 100, 58) : 0xcc8822;
    hudElements.specialBar.beginFill(spColor);
    hudElements.specialBar.drawRect(barX, spY, barW * Math.min(spRatio, 1), spH);
    hudElements.specialBar.endFill();
  }
  hudElements.specialBar.lineStyle(1, 0x333322);
  hudElements.specialBar.drawRect(barX, spY, barW, spH);
  hudElements.specialBar.lineStyle(0);

  hudElements.specialText.text = spReady ? 'SHOCKWAVE READY!' : `SHOCKWAVE  ${p.specialCharge}/${CFG.SPECIAL_MAX_CHARGE}`;
  hudElements.specialText.style.fill = spReady ? 0xffee55 : 0x887755;
  hudElements.specialText.anchor.set(0, 1);
  hudElements.specialText.x = barX;
  hudElements.specialText.y = spY - 1;
  hudElements.specialText.visible = true;

  // =========================================================
  // WEAPON SLOTS (row below player panel)
  // =========================================================
  const maxVisible = Math.min(unlockedWeapons, 8);
  const slotW = 56, slotH = 32, slotGap = 3;
  const slotRowX = panX, slotRowY = H - slotH - 12;

  for (let i = 0; i < maxVisible; i++) {
    const sx = slotRowX + i * (slotW + slotGap);
    const selected = i === p.weapon;

    // Slot background
    hudElements.healthBar.beginFill(selected ? 0x2a1a00 : 0x08090e, selected ? 0.92 : 0.78);
    hudElements.healthBar.drawRect(sx, slotRowY, slotW, slotH);
    hudElements.healthBar.endFill();

    // Slot border + selection highlight
    if (selected) {
      // Gold border with slight glow effect (double border)
      hudElements.healthBar.lineStyle(2, 0xffdd00);
      hudElements.healthBar.drawRect(sx, slotRowY, slotW, slotH);
      // Inner bright top line
      hudElements.healthBar.lineStyle(1, 0xffee88, 0.5);
      hudElements.healthBar.moveTo(sx + 2, slotRowY + 1);
      hudElements.healthBar.lineTo(sx + slotW - 2, slotRowY + 1);
    } else {
      hudElements.healthBar.lineStyle(1, 0x1e2d3a);
      hudElements.healthBar.drawRect(sx, slotRowY, slotW, slotH);
    }
    hudElements.healthBar.lineStyle(0);

    // Weapon pictogram icon (top 2/3 of slot)
    drawWeaponSlotIcon(hudElements.healthBar, sx + slotW / 2, slotRowY + 12, i, selected);

    // Key number label at bottom of slot
    const keyLabel = i < 9 ? (i + 1) : 0;
    const slotText = hudElements.slotTexts[i];
    slotText.text = `[${keyLabel}]`;
    slotText.style.fill = selected ? 0xffdd44 : 0x445566;
    slotText.style.fontSize = 8;
    slotText.anchor.set(0.5, 0.5);
    slotText.x = sx + slotW / 2;
    slotText.y = slotRowY + slotH - 5;
    slotText.visible = true;
  }
  // Hide unused slot texts
  for (let i = maxVisible; i < hudElements.slotTexts.length; i++) {
    hudElements.slotTexts[i].visible = false;
  }

  // +N more hint
  if (unlockedWeapons > maxVisible) {
    hudElements.moreText.text = `+${unlockedWeapons - maxVisible} (Q/E)`;
    hudElements.moreText.anchor.set(0, 0.5);
    hudElements.moreText.x = slotRowX + maxVisible * (slotW + slotGap);
    hudElements.moreText.y = slotRowY + slotH / 2;
    hudElements.moreText.visible = true;
  } else {
    hudElements.moreText.visible = false;
  }

  // Next unlock / boss active hint (above panel)
  if (unlockedWeapons < WEAPONS.length && !bossActive) {
    const next = WEAPONS[unlockedWeapons];
    hudElements.nextText.text = `Next: ${next.name} @ ${next.unlock} pts`;
    hudElements.nextText.anchor.set(0, 1);
    hudElements.nextText.x = panX + 10;
    hudElements.nextText.y = panY - 4;
    hudElements.nextText.visible = true;
    hudElements.bossUnlockText.visible = false;

    const prevUnlock = unlockedWeapons > 1 ? WEAPONS[unlockedWeapons - 1].unlock : 0;
    const prog = clamp((score - prevUnlock) / (next.unlock - prevUnlock), 0, 1);
    hudElements.healthBar.beginFill(0x0a0a0a, 0.6);
    hudElements.healthBar.drawRect(panX + 170, panY - 13, 82, 6);
    hudElements.healthBar.endFill();
    hudElements.healthBar.beginFill(0x44aa44);
    hudElements.healthBar.drawRect(panX + 170, panY - 13, 82 * prog, 6);
    hudElements.healthBar.endFill();
  } else if (bossActive) {
    hudElements.bossUnlockText.anchor.set(0, 1);
    hudElements.bossUnlockText.x = panX + 10;
    hudElements.bossUnlockText.y = panY - 4;
    hudElements.bossUnlockText.visible = true;
    hudElements.nextText.visible = false;
  } else {
    hudElements.nextText.visible = false;
    hudElements.bossUnlockText.visible = false;
  }

  // =========================================================
  // TOP-RIGHT STATS PANEL
  // =========================================================
  const hasCombo = combo > 1;
  const rPW = 155, rPH = hasCombo ? 124 : 104;
  const rPX = W - rPW - 10, rPY = 10;

  // Panel background
  hudElements.statsPanel.beginFill(0x080c14, 0.82);
  hudElements.statsPanel.drawRect(rPX, rPY, rPW, rPH);
  hudElements.statsPanel.endFill();
  // Border
  hudElements.statsPanel.lineStyle(1, 0x1e3a5f, 0.7);
  hudElements.statsPanel.drawRect(rPX, rPY, rPW, rPH);
  // Top accent line
  hudElements.statsPanel.lineStyle(1, 0xffaa00, 0.4);
  hudElements.statsPanel.moveTo(rPX + 1, rPY + 1);
  hudElements.statsPanel.lineTo(rPX + rPW - 1, rPY + 1);
  hudElements.statsPanel.lineStyle(0);

  // Score (large, centered)
  hudElements.scoreText.text = score.toLocaleString();
  hudElements.scoreText.style.fill = 0xffd700;
  hudElements.scoreText.style.fontSize = 26;
  hudElements.scoreText.anchor.set(0.5, 0);
  hudElements.scoreText.x = rPX + rPW / 2;
  hudElements.scoreText.y = rPY + 7;

  // "SCORE" label
  hudElements.scoreLabelText.text = 'SCORE';
  hudElements.scoreLabelText.anchor.set(0.5, 0);
  hudElements.scoreLabelText.x = rPX + rPW / 2;
  hudElements.scoreLabelText.y = rPY + 37;
  hudElements.scoreLabelText.visible = true;

  // Divider line
  hudElements.statsPanel.lineStyle(1, 0x1e2d3a);
  hudElements.statsPanel.moveTo(rPX + 8, rPY + 50);
  hudElements.statsPanel.lineTo(rPX + rPW - 8, rPY + 50);
  hudElements.statsPanel.lineStyle(0);

  // WAVE
  hudElements.waveText.text = `WAVE  ${wave}`;
  hudElements.waveText.style.fill = 0xff8c00;
  hudElements.waveText.style.fontSize = 16;
  hudElements.waveText.anchor.set(0.5, 0);
  hudElements.waveText.x = rPX + rPW / 2;
  hudElements.waveText.y = rPY + 54;

  // KILLS
  hudElements.killsText.text = `KILLS  ${kills}`;
  hudElements.killsText.style.fill = 0xdd6666;
  hudElements.killsText.style.fontSize = 13;
  hudElements.killsText.anchor.set(0.5, 0);
  hudElements.killsText.x = rPX + rPW / 2;
  hudElements.killsText.y = rPY + 74;

  // TIME
  const mins = Math.floor(gameTime / 60);
  const secs = Math.floor(gameTime % 60);
  hudElements.timeText.text = `TIME  ${mins}:${secs.toString().padStart(2, '0')}`;
  hudElements.timeText.style.fill = 0x777777;
  hudElements.timeText.style.fontSize = 11;
  hudElements.timeText.anchor.set(0.5, 0);
  hudElements.timeText.x = rPX + rPW / 2;
  hudElements.timeText.y = rPY + 89;

  // COMBO (shown below when active)
  if (hasCombo) {
    const comboColor = combo > 10 ? 0xff2222 : combo > 5 ? 0xffaa00 : 0xffff44;
    hudElements.comboText.text = `COMBO x${combo}`;
    hudElements.comboText.style.fill = comboColor;
    hudElements.comboText.style.fontSize = 14;
    hudElements.comboText.anchor.set(0.5, 0);
    hudElements.comboText.x = rPX + rPW / 2;
    hudElements.comboText.y = rPY + 105;
    hudElements.comboText.visible = true;

    // Combo timer bar
    hudElements.statsPanel.beginFill(0x0a0800);
    hudElements.statsPanel.drawRect(rPX + 8, rPY + rPH - 7, rPW - 16, 4);
    hudElements.statsPanel.endFill();
    hudElements.statsPanel.beginFill(comboColor);
    hudElements.statsPanel.drawRect(rPX + 8, rPY + rPH - 7, (rPW - 16) * (comboTimer / CFG.COMBO_TIMEOUT), 4);
    hudElements.statsPanel.endFill();
  } else {
    hudElements.comboText.visible = false;
  }

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

/**
 * Draw a weapon silhouette icon inside a slot using filled shapes.
 * cx/cy = center of the icon area within the slot.
 */
function drawWeaponSlotIcon(g, cx, cy, weapIdx, selected) {
  const col   = selected ? 0xffdd44 : 0x4a6677;
  const alpha = selected ? 1.0 : 0.72;

  // Shorthand for a filled rect with the weapon color
  const fr = (x, y, w, h, c, a) => {
    g.beginFill(c !== undefined ? c : col, a !== undefined ? a : alpha);
    g.drawRect(x, y, w, h);
    g.endFill();
  };

  g.lineStyle(0);

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
      g.beginFill(col, alpha);         // rocket cone (triangle)
      g.drawPolygon([cx + 8, cy - 4,  cx + 14, cy,  cx + 8, cy + 4]);
      g.endFill();
      fr(cx - 6, cy + 3, 4, 5);       // grip
      break;
    }
    case 6: { // Plasma – futuristic body + energy cell
      fr(cx - 8, cy - 5, 12, 10);     // body
      fr(cx + 4, cy - 2,  9,  4);     // barrel
      const gc = selected ? 0x00ffff : 0x005566;
      g.beginFill(gc, 0.9); g.drawCircle(cx - 1, cy, 3); g.endFill(); // energy cell
      break;
    }
    case 7: { // Tesla – body + lightning bolt
      fr(cx - 10, cy - 3, 20, 6);     // main body
      g.lineStyle(2, selected ? 0xaaaaff : 0x334488);
      g.moveTo(cx - 3, cy - 7); g.lineTo(cx + 1, cy - 1);
      g.moveTo(cx + 1, cy - 1); g.lineTo(cx - 2, cy + 1);
      g.moveTo(cx - 2, cy + 1); g.lineTo(cx + 5, cy + 7);
      g.lineStyle(0);
      break;
    }
    case 8: { // Railgun – very long barrel with rail marks
      fr(cx - 16, cy - 2, 30, 4);     // long barrel
      const rc = selected ? 0xff44ff : 0x441144;
      g.lineStyle(1, rc, 0.9);
      for (let i = 0; i < 4; i++) {
        g.moveTo(cx - 12 + i * 6, cy - 4);
        g.lineTo(cx - 12 + i * 6, cy + 4);
      }
      g.lineStyle(0);
      break;
    }
    case 9: { // BFG – body + giant energy ball
      fr(cx - 12, cy - 3, 12, 6);     // body
      const gc = selected ? 0x22ff44 : 0x113322;
      g.beginFill(gc, 0.85); g.drawCircle(cx + 5, cy, 8); g.endFill();
      g.lineStyle(1, selected ? 0x44ff44 : 0x224433);
      g.drawCircle(cx + 5, cy, 8);
      g.lineStyle(0);
      fr(cx - 6, cy + 3, 4, 5);       // grip
      break;
    }
    case 10: { // Disintegrator – twin energy barrels
      fr(cx - 14, cy - 7, 22, 4);     // top barrel
      fr(cx - 14, cy + 3, 22, 4);     // bottom barrel
      const gc = selected ? 0xff44ff : 0x441144;
      g.beginFill(gc, 0.9);
      g.drawCircle(cx + 8, cy - 5, 3);
      g.drawCircle(cx + 8, cy + 5, 3);
      g.endFill();
      break;
    }
    default: { // Generic gun fallback
      fr(cx - 10, cy - 3, 18, 6);
      fr(cx - 6,  cy + 3,  4, 5);
    }
  }
  g.lineStyle(0);
}

/**
 * Render minimap - 2x bigger, higher resolution water, 80% transparent background
 */
function renderPixiMinimap() {
  if (!player) return;

  const mmSize = 240;                          // 2x bigger than before
  const mmX = W - mmSize - 12;
  const mmY = H - mmSize - 12;
  const mmScale = 0.04;
  const mmCx = mmX + mmSize / 2;
  const mmCy = mmY + mmSize / 2;

  if (!renderPixiMinimap._terrainGraphics) {
    renderPixiMinimap._terrainGraphics = new PIXI.Graphics();
    renderPixiMinimap._terrainGraphics.zIndex = 1998;
    uiContainer.addChild(renderPixiMinimap._terrainGraphics);
    renderPixiMinimap._frameCount = 0;
  }

  hudElements.minimapGraphics.zIndex = 2000;
  renderPixiMinimap._frameCount++;

  // Redraw terrain every 15 frames
  if (renderPixiMinimap._frameCount % 15 === 0) {
    renderPixiMinimap._terrainGraphics.clear();

    // Background: 40% transparent (alpha 0.60)
    renderPixiMinimap._terrainGraphics.beginFill(0x030810, 0.60);
    renderPixiMinimap._terrainGraphics.drawRect(mmX, mmY, mmSize, mmSize);
    renderPixiMinimap._terrainGraphics.endFill();

    // Water tiles - higher resolution (step=4 instead of 8)
    const mmStep = 4;
    for (let py = 0; py < mmSize; py += mmStep) {
      for (let px = 0; px < mmSize; px += mmStep) {
        const sx = (px - mmSize / 2) / mmScale;
        const sy = (py - mmSize / 2) / (mmScale * CFG.ISO_SCALE);
        const wx = player.x + (sx + sy) * 0.5;
        const wy = player.y + (sy - sx) * 0.5;
        if (getTerrainTypeAt(wx, wy) === 'water') {
          renderPixiMinimap._terrainGraphics.beginFill(0x1a4070, 0.72);
          renderPixiMinimap._terrainGraphics.drawRect(mmX + px, mmY + py, mmStep, mmStep);
          renderPixiMinimap._terrainGraphics.endFill();
        }
      }
    }

    // Dark "sand" border tiles (thin edge blend)
    for (let py = 0; py < mmSize; py += 4) {
      for (let px = 0; px < mmSize; px += 4) {
        const sx = (px - mmSize / 2) / mmScale;
        const sy = (py - mmSize / 2) / (mmScale * CFG.ISO_SCALE);
        const wx = player.x + (sx + sy) * 0.5;
        const wy = player.y + (sy - sx) * 0.5;
        const t = getTerrainTypeAt(wx, wy);
        if (t === 'sand') {
          renderPixiMinimap._terrainGraphics.beginFill(0x5a4a2a, 0.25);
          renderPixiMinimap._terrainGraphics.drawRect(mmX + px, mmY + py, 4, 4);
          renderPixiMinimap._terrainGraphics.endFill();
        } else if (t === 'dark') {
          renderPixiMinimap._terrainGraphics.beginFill(0x0a1a10, 0.30);
          renderPixiMinimap._terrainGraphics.drawRect(mmX + px, mmY + py, 4, 4);
          renderPixiMinimap._terrainGraphics.endFill();
        }
      }
    }

    // Outer border
    renderPixiMinimap._terrainGraphics.lineStyle(1, 0x2a4a6a, 0.8);
    renderPixiMinimap._terrainGraphics.drawRect(mmX, mmY, mmSize, mmSize);
    // Inner subtle border
    renderPixiMinimap._terrainGraphics.lineStyle(1, 0x0a1a2a, 0.6);
    renderPixiMinimap._terrainGraphics.drawRect(mmX + 1, mmY + 1, mmSize - 2, mmSize - 2);
  }

  // Dynamic layer - clear and redraw every frame
  hudElements.minimapGraphics.clear();

  // Enemy dots
  for (const e of enemies) {
    const dx = e.x - player.x, dy = e.y - player.y;
    const ex = mmCx + (dx - dy) * mmScale;
    const ey = mmCy + (dx + dy) * mmScale * CFG.ISO_SCALE;
    if (ex > mmX + 2 && ex < mmX + mmSize - 2 && ey > mmY + 2 && ey < mmY + mmSize - 2) {
      if (e.isBoss) {
        // Boss: larger magenta dot with ring
        hudElements.minimapGraphics.beginFill(0xff44ff);
        hudElements.minimapGraphics.drawCircle(ex, ey, 5);
        hudElements.minimapGraphics.endFill();
        hudElements.minimapGraphics.lineStyle(1, 0xff88ff, 0.7);
        hudElements.minimapGraphics.drawCircle(ex, ey, 8);
        hudElements.minimapGraphics.lineStyle(0);
      } else {
        hudElements.minimapGraphics.beginFill(0xff4444);
        hudElements.minimapGraphics.drawCircle(ex, ey, 2.5);
        hudElements.minimapGraphics.endFill();
      }
    }
  }

  // Player dot - green with direction indicator
  hudElements.minimapGraphics.beginFill(0x44ff44);
  hudElements.minimapGraphics.drawCircle(mmCx, mmCy, 4);
  hudElements.minimapGraphics.endFill();

  // Player direction arrow
  const ang = player.angle;
  hudElements.minimapGraphics.lineStyle(1.5, 0x44ff44, 0.9);
  hudElements.minimapGraphics.moveTo(mmCx, mmCy);
  hudElements.minimapGraphics.lineTo(
    mmCx + Math.cos(ang) * 9,
    mmCy + Math.sin(ang) * 9 * CFG.ISO_SCALE
  );
  hudElements.minimapGraphics.lineStyle(0);
}

/**
 * Render crosshair - no red center dot
 */
function renderPixiCrosshair() {
  const chX = mouseX, chY = mouseY;
  const spReady = player && player.specialCharge >= CFG.SPECIAL_MAX_CHARGE;
  const color = spReady ? 0xffff00 : 0xffffff;

  // Outer circle
  hudElements.crosshair.lineStyle(1.5, color, 0.82);
  hudElements.crosshair.drawCircle(chX, chY, 12);

  // Cross lines with center gap
  hudElements.crosshair.moveTo(chX - 18, chY);
  hudElements.crosshair.lineTo(chX - 6, chY);
  hudElements.crosshair.moveTo(chX + 6, chY);
  hudElements.crosshair.lineTo(chX + 18, chY);
  hudElements.crosshair.moveTo(chX, chY - 18);
  hudElements.crosshair.lineTo(chX, chY - 6);
  hudElements.crosshair.moveTo(chX, chY + 6);
  hudElements.crosshair.lineTo(chX, chY + 18);
  hudElements.crosshair.lineStyle(0);

  // Tiny center dot (no red - matches crosshair color)
  hudElements.crosshair.beginFill(color, 0.65);
  hudElements.crosshair.drawCircle(chX, chY, 1.5);
  hudElements.crosshair.endFill();
}

/**
 * Render vignette effects (low HP, invincibility, shield break)
 */
function renderPixiVignettes(hpRatio) {
  // Invincibility flash
  hudElements.invincGraphics.clear();
  if (player && player.invincible > 0) {
    hudElements.invincGraphics.alpha = 0.15;
    hudElements.invincGraphics.beginFill(0xffff00);
    hudElements.invincGraphics.drawRect(0, 0, W, H);
    hudElements.invincGraphics.endFill();
    hudElements.invincGraphics.visible = true;
  } else {
    hudElements.invincGraphics.visible = false;
  }

  // Low health red vignette
  hudElements.vignetteGraphics.clear();
  if (hpRatio < 0.3) {
    for (let i = 0; i < 10; i++) {
      const radius = H * 0.3 + (H * 0.4) * (i / 10);
      const alpha = (i / 10) * (1 - hpRatio / 0.3) * 0.4;
      hudElements.vignetteGraphics.alpha = alpha;
      hudElements.vignetteGraphics.beginFill(0xb40000);
      hudElements.vignetteGraphics.drawCircle(W / 2, H / 2, radius);
      hudElements.vignetteGraphics.endFill();
    }
    hudElements.vignetteGraphics.visible = true;
  } else {
    hudElements.vignetteGraphics.visible = false;
  }

  // Shield break blue vignette
  hudElements.shieldVignetteGraphics.clear();
  if (player && player.shield <= 0 && shieldRegenTimer < 0.5) {
    for (let i = 0; i < 10; i++) {
      const radius = H * 0.35 + (H * 0.35) * (i / 10);
      const alpha = (i / 10) * (1 - shieldRegenTimer / 0.5) * 0.2;
      hudElements.shieldVignetteGraphics.alpha = alpha;
      hudElements.shieldVignetteGraphics.beginFill(0x3250c8);
      hudElements.shieldVignetteGraphics.drawCircle(W / 2, H / 2, radius);
      hudElements.shieldVignetteGraphics.endFill();
    }
    hudElements.shieldVignetteGraphics.visible = true;
  } else {
    hudElements.shieldVignetteGraphics.visible = false;
  }
}

/**
 * Pause overlay - shown when game is paused with P key
 */
function renderPauseOverlay() {
  if (!renderPauseOverlay._bg) {
    renderPauseOverlay._bg = new PIXI.Graphics();
    renderPauseOverlay._bg.zIndex = 9000;
    uiContainer.addChild(renderPauseOverlay._bg);

    const style = { fontFamily: 'Courier New, monospace', fontWeight: 'bold', fill: 0xffffff };
    renderPauseOverlay._title = new PIXI.Text({ text: 'PAUSED', style: { ...style, fontSize: 64 } });
    renderPauseOverlay._title.anchor.set(0.5);
    renderPauseOverlay._title.zIndex = 9001;
    uiContainer.addChild(renderPauseOverlay._title);

    renderPauseOverlay._hint = new PIXI.Text({ text: 'Press P to resume', style: { ...style, fontSize: 22, fill: 0xaaaaaa } });
    renderPauseOverlay._hint.anchor.set(0.5);
    renderPauseOverlay._hint.zIndex = 9001;
    uiContainer.addChild(renderPauseOverlay._hint);
  }

  const visible = (typeof paused !== 'undefined') && paused;
  renderPauseOverlay._bg.visible = visible;
  renderPauseOverlay._title.visible = visible;
  renderPauseOverlay._hint.visible = visible;

  if (visible) {
    renderPauseOverlay._bg.clear();
    renderPauseOverlay._bg.beginFill(0x000000, 0.55);
    renderPauseOverlay._bg.drawRect(0, 0, W, H);
    renderPauseOverlay._bg.endFill();

    renderPauseOverlay._title.x = W / 2;
    renderPauseOverlay._title.y = H / 2 - 40;
    renderPauseOverlay._hint.x = W / 2;
    renderPauseOverlay._hint.y = H / 2 + 30;
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
