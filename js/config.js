// =====================================================================
// RAMBO: ENDLESS ASSAULT - Configuration & Data
// =====================================================================

const CFG = {
  ISO_SCALE: 0.55,
  PLAYER_SPEED: 200,
  SPRINT_MULT: 1.6,
  PLAYER_MAX_HP: 800,
  PLAYER_REGEN: 5,
  PLAYER_MAX_SHIELD: 300,
  SHIELD_REGEN: 40,
  SHIELD_REGEN_DELAY: 3.0,
  SPECIAL_MAX_CHARGE: 15,
  SPECIAL_RADIUS: 220,
  SPECIAL_DAMAGE: 150,
  CAMERA_SMOOTH: 0.07,
  MAX_PARTICLES: 3000,
  MAX_BLOOD_POOLS: 800,
  MAX_BODIES: 200,
  MAX_BULLETS: 400,
  MAX_ENEMIES: 80,
  TILE_SIZE: 80,
  CHUNK_SIZE: 8,
  VIEW_RANGE: 900,
  DODGE_SPEED: 500,
  DODGE_DURATION: 0.25,
  DODGE_COOLDOWN: 0.8,
  COMBO_TIMEOUT: 2.0,
  BODY_FADE_START: 15,
  BODY_FADE_END: 25,
  UNCAPPED_FPS: true, // Disable vsync for raw performance testing
};

// =====================================================================
// WEAPON DEFINITIONS (11 weapons - escalating badassery)
// =====================================================================
const WEAPONS = [
  { name:'Pistol', rate:0.28, dmg:30, spread:0.04, count:1, speed:900, color:'#ff0', auto:false, ammo:Infinity, mag:15, reload:1.0, unlock:0, kickback:3, trail:false, shellSize:0.5 },
  { name:'Uzi', rate:0.07, dmg:14, spread:0.13, count:1, speed:800, color:'#ff0', auto:true, ammo:Infinity, mag:32, reload:1.2, unlock:400, kickback:2, trail:false, shellSize:0.4 },
  { name:'Shotgun', rate:0.55, dmg:18, spread:0.25, count:7, speed:650, color:'#fa0', auto:false, ammo:Infinity, mag:6, reload:1.8, unlock:1200, kickback:8, trail:false, shellSize:0.8 },
  { name:'M16', rate:0.09, dmg:22, spread:0.06, count:1, speed:1000, color:'#ff0', auto:true, ammo:Infinity, mag:30, reload:1.5, unlock:2500, kickback:3, trail:true, shellSize:0.5 },
  { name:'Minigun', rate:0.035, dmg:11, spread:0.18, count:1, speed:900, color:'#ff4', auto:true, ammo:Infinity, mag:200, reload:3.0, unlock:5000, kickback:1.5, trail:true, shellSize:0.3, spinUp:true },
  { name:'RPG', rate:0.9, dmg:250, spread:0.02, count:1, speed:450, color:'#f80', auto:false, ammo:Infinity, mag:1, reload:2.0, unlock:9000, kickback:12, trail:true, explosive:true, radius:130, shellSize:0 },
  { name:'Plasma', rate:0.12, dmg:55, spread:0.04, count:1, speed:1100, color:'#0ff', auto:true, ammo:Infinity, mag:40, reload:1.8, unlock:16000, kickback:4, trail:true, pierce:true, shellSize:0, glow:true },
  // === NEW WEAPONS - Sick badass killing machines ===
  { name:'Tesla', rate:0.14, dmg:45, spread:0.08, count:1, speed:1200, color:'#88f', auto:true, ammo:Infinity, mag:50, reload:2.0, unlock:25000, kickback:3, trail:true, pierce:false, shellSize:0, glow:true, chain:3, chainRange:150 },
  { name:'Railgun', rate:1.4, dmg:600, spread:0, count:1, speed:4000, color:'#f0f', auto:false, ammo:Infinity, mag:3, reload:2.5, unlock:40000, kickback:18, trail:true, pierce:true, shellSize:0, glow:true, beam:true },
  { name:'BFG', rate:2.0, dmg:800, spread:0.02, count:1, speed:350, color:'#0f0', auto:false, ammo:Infinity, mag:1, reload:3.0, unlock:60000, kickback:22, trail:true, explosive:true, radius:280, shellSize:0, glow:true },
  { name:'Disintegrator', rate:0.04, dmg:38, spread:0.03, count:2, speed:1600, color:'#f4f', auto:true, ammo:Infinity, mag:120, reload:2.5, unlock:85000, kickback:1, trail:true, pierce:true, shellSize:0, glow:true, disintegrate:true },
];

// =====================================================================
// ENEMY TYPES (12 types)
// =====================================================================
const ENEMY_TYPES = [
  { name:'Militia', hp:45, speed:55, dmg:6, range:28, color:'#5a4', size:1, score:10, wave:1 },
  { name:'Runner', hp:25, speed:130, dmg:4, range:22, color:'#6b5', size:0.85, score:15, wave:3 },
  { name:'Heavy', hp:180, speed:30, dmg:14, range:32, color:'#556', size:1.35, score:30, wave:5 },
  { name:'Officer', hp:65, speed:45, dmg:10, range:280, color:'#654', size:1, score:25, wave:7, shoots:true, fireRate:1.4, bulletSpeed:400 },
  { name:'Berserker', hp:130, speed:115, dmg:16, range:30, color:'#a33', size:1.15, score:45, wave:8 },
  { name:'Bomber', hp:40, speed:90, dmg:60, range:28, color:'#a60', size:0.9, score:35, wave:9, explodeOnDeath:true, explodeRadius:100 },
  { name:'Commando', hp:90, speed:80, dmg:8, range:200, color:'#464', size:1.05, score:35, wave:10, shoots:true, fireRate:0.8, bulletSpeed:500 },
  { name:'Medic', hp:55, speed:42, dmg:5, range:180, color:'#3a8', size:0.95, score:50, wave:11, shoots:true, fireRate:2.0, bulletSpeed:350, healer:true },
  { name:'Sniper', hp:35, speed:20, dmg:35, range:550, color:'#445', size:0.9, score:40, wave:13, shoots:true, fireRate:2.8, bulletSpeed:800 },
  { name:'Shielded', hp:100, speed:38, dmg:12, range:250, color:'#68a', size:1.2, score:55, wave:14, shoots:true, fireRate:1.2, bulletSpeed:450, hasShield:true, shieldHp:80 },
  { name:'Tank', hp:600, speed:18, dmg:45, range:250, color:'#666', size:1.8, score:100, wave:16, shoots:true, fireRate:3, bulletSpeed:350, explosive:true },
  { name:'Juggernaut', hp:1200, speed:12, dmg:60, range:280, color:'#555', size:2.2, score:200, wave:20, shoots:true, fireRate:2.0, bulletSpeed:300, explosive:true },
];

// Boss names for each weapon unlock (index 0 = boss before weapon index 1, etc.)
const BOSS_NAMES = [
  'Warlord', 'Demolisher', 'Iron Bear', 'General Fury', 'Titan',
  'Overlord', 'Storm Lord', 'Shadow King', 'Annihilator', 'Omega Prime'
];
