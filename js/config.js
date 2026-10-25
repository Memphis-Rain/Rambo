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
  MAX_BLOOD_POOLS: 2000,
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
  MAX_SHELLS: 150,
  MAX_GIBS: 160,
  MAX_DMG_NUMBERS: 60,
  SHAKE_MAX: 20, // J5a: screen px; addShake clamps to this
  // M10: Xbox / standard gamepad
  PAD_DEADZONE: 0.20,          // radial, both sticks; rescaled to 0..1 beyond it
  PAD_TRIGGER: 0.3,            // RT fires / LT shockwave past this
  PAD_AIM_MIN: 180,            // aim point = player + dir x (MIN + stick x RANGE)
  PAD_AIM_RANGE: 240,
  PAD_AIM_SETTLE: 0.04,        // right stick: a magnitude falling by more than this per poll is a release (keep the direction)
  PAD_AIM_ASSIST: true,        // C3: pad-only assist (not the demo bot)
  PAD_ASSIST_DEG: 5,
  PAD_ASSIST_RANGE: 420,
  PAD_RUMBLE: true,
  PAD_RUMBLE_GAP_MS: 50,       // at most one new effect per 50 ms
  // M11 K3: co-op camera zoom (world scale inside the low-res RT) and leash
  COOP_ZOOM_MIN: 0.6,          // widest view (1.67x)
  COOP_ZOOM_MARGIN: 64,        // low-res px every counted player stays inside the view edges
  COOP_ZOOM_OUT_RATE: 3,       // zoom units / s (linear)
  COOP_ZOOM_IN_RATE: 1,        // zoom units / s (linear), after the deadband
  COOP_ZOOM_DEADBAND: 0.05,    // zoom in only once the target is >= 5% above the zoom
  COOP_LEASH_PX: 48,           // K3b: at COOP_ZOOM_MIN, low-res px from the view edge
  // M11 K5: down / revive (2P)
  COOP_DOWN_TIME: 8,           // s a downed player waits for a revive before dying
  COOP_REVIVE_RANGE: 50,       // u: the partner stands this close...
  COOP_REVIVE_TIME: 1.5,       // ...for this long
  COOP_REVIVE_HP: 0.5,         // x maxHp on revive
  COOP_REVIVE_INVULN: 1,       // s invulnerable after a revive / wave respawn
  // M11 K6: rules in 2P
  COOP_RETARGET: 1,            // s: an enemy re-picks its target at most this often
  COOP_SWITCH: 0.25,           // ...and switches only to a player >= 25% closer
  COOP_ENEMY_MULT: 1.5,        // wave enemy count x (rounded up)
  COOP_BOSS_HP_MULT: 1.5,
  COOP_FRIENDLY_FIRE: false,   // partner takes damage from your explosions
  // M9 F1-F3: flamethrower, burning enemies, burning trees
  FLAME_RANGE: 260,            // F1: a flame slows to a stop at about this distance
  FLAME_LIFE: 0.45,            // s (+-10%)
  MAX_FLAMES: 120,
  GROUND_FIRE_MAX: 40,
  BURN_TIME: 4,                // F2: s of burn, refreshed by further flame hits
  BURN_TICK: 0.25,             // s per DoT tick
  BURN_DPS: 25,
  BURN_MAX: 30,                // at most this many enemies burn at once
  PANIC_MIN: 0.3,              // s between panic direction changes
  PANIC_MAX: 0.7,
  PANIC_SPEED: 1.25,           // x the enemy's speed while running in panic
  CONTACT_IGNITE_T: 0.3,       // s of touching a burning enemy per ignition roll
  CONTACT_IGNITE_P: 0.5,
  TREE_IGNITE_S: 0.8,          // F3: s of stream until a tree ignites (heat 0 -> 1)
  TREE_BURN_S: 6,              // s a tree burns (+-10%)
  TREE_SPREAD_R: 90,           // fire spreads to trees within this
  TREE_SPREAD_P: 0.35,         // per second, per neighbour
  TREE_BURN_MAX: 24,
  CANOPY_FIRE_DPS: 10,         // to enemies under a burning canopy (and they ignite)
  // M9 W2: wading
  WADE_RAMP: 0.25,             // s for the waterline to rise/fall fully
  // M9 W3-W5: blood in water
  BLOOD_CLOUD_LIFE: 8,         // s; expands to 2x over 4 s, fades in steps
  BODY_FLOAT_S: 0.5,           // W4: a corpse in water floats, sinks, dissolves
  BODY_SINK_S: 2.5,
  BODY_DISSOLVE_S: 1.5,
  GIB_SINK_S: 0.9,
  W5_HIT: 0.02,                // per-tile blood concentration added (within 1 / 2 / 3 tiles)
  W5_GIB: 0.05,
  W5_KILL: 0.15,
  W5_TICK: 0.25,               // s between diffusion/decay ticks (<= 4 Hz)
  W5_HALF_LIFE: 180,           // s
  W5_DIFFUSE: 0.3,             // /s exchange rate with each 4-neighbour water tile
  W5_STORE_MIN: 0.004,         // below this a tile's trace is dropped (below 0.02 it reads/draws as 0)
  // M9 N1: grenades (F)
  GRENADE_DMG: 200,            // RPG path: splash 0.7 x dmg x (1 - d/R), no direct hit
  GRENADE_RADIUS: 140,
  GRENADE_GEYSER_SCALE: 0.7,   // in water: geyser radius = R x this
  GRENADE_FUSE: 1.8,           // s from the throw
  GRENADE_RANGE: 420,
  GRENADE_COOLDOWN: 0.5,
  GRENADE_AMMO_START: 3,
  GRENADE_AMMO_MAX: 6,
  GRENADE_DROP_CHANCE: 0.06,
  // Physical environment (M8)
  ENV_TREE_DENSITY: 1.26, // E1: x original tree counts (= ~+30% placed trees)
  // E2-E8 blast response; f = 1 - d/R for an object at distance d from a blast of radius R
  MAX_DEBRIS: 300,             // E8: flying debris pieces (oldest settle + bake first)
  ENV_ACTIVE_MAX: 64,          // E8: objects simulated at once (the rest sleep / queue)
  ENV_SCORCH_F: 0.35,          // f above which a canopy scorches one step (max 3)
  ENV_TOPPLE_F: 0.6,           // f above which a tree/pine topples
  ENV_DEADTREE_TOPPLE_F: 0.4,  // dead trees snap more easily
  ENV_BREAK_F: 0.3,            // crates/sandbags break above this f
  ENV_CRACK_F: 0.6,            // boulders/ruins crack above this f
  ENV_SHATTER_F: 0.3,          // ...and shatter into rubble above this f under a BFG
  ENV_BFG_RADIUS: 250,         // blasts this big count as BFG (shatter rock)
  ENV_BLAST_DMG: 100,          // hp an object loses per blast = f * this (cumulative topple)
  ENV_TREE_HP: 100,
  ENV_DEADTREE_HP: 60,
  ENV_BUSH_HP: 60,
  ENV_CRATE_HP: 60,            // also takes bullet damage
  ENV_SANDBAG_HP: 150,
  ENV_FALL_ENEMY_DMG: 120,     // E6: once, when the trunk lands
  ENV_FALL_PLAYER_DMG: 40,
  ENV_FALL_MIN: 0.6,           // topple duration range (s)
  ENV_FALL_MAX: 0.9,
  ENV_FALL_SHAKE: 6,           // landing shake (J5a cap still applies)
  ENV_LOG_LEN: 0.8,            // E5: log length = tree height x this (world units)
  ENV_LOG_R: 7,                // log capsule radius (blocks movement, not bullets)
  ENV_STUMP_R: 5,              // stump circle (blocks movement and bullets)
  ENV_DEADTREE_R: 5,           // dead-tree trunk circle
  ENV_CRATE_R: 10,             // crate circle (until destroyed)
  ENV_SANDBAG_RF: 0.4,         // sandbag circle = width x this
  ENV_SWAY_IMPULSE: 3,         // rad/s of lean velocity at f = 1
  ENV_BULLET_SWAY: 0.3,        // rad/s per bullet hit on a trunk
  ENV_SWAY_K: 56,              // sway spring stiffness (~1.2 Hz)
  ENV_SWAY_DAMP: 5.2,          // sway damping (settles in ~1.5 s)
  ENV_LEAF_BURST: 16,          // leaves at f = 1
  ENV_SHOCK_SPEED: 1500,       // topple start delay = distance / this (s)
  ENV_TOPPLE_STAGGER: 0.035,   // E8: extra delay per topple started in the same frame (s)
  ENV_LAND_PER_FRAME: 3,       // E8: trunk landings processed per frame
  ENV_BAKE_DELAY: 0.25,        // landed log rests this long before baking (s)
  ENV_STORE_SWEEP: 1,          // E7: s between persistence-store sweeps (detach unloaded objects, forget sway-only records)
  ENV_LOG_CLIMB: 0.35,         // E11: speed factor while climbing over a log (logs are hurdles, not walls)
  ENV_LOG_SPLINTER_F: 0.5,     // E11: an explosion with f above this splinters a log (capsule gone, stump stays)
  ENV_LOG_END_DETOUR: 1.5,     // E11: enemies go round a log's end when it is closer than this x log width (2 logR) to their crossing point
  ENV_LOG_AVOID_NEAR: 18,      // E11: ...deciding within this of the log's surface (world units)
  ENV_LOG_AVOID_LOOK: 320,     // E11: max length of the enemy's line-to-target test against a log
  ENV_CROWN_R: 0.75,           // E10: fallen crown radius = canopy radius x this
  ENV_CROWN_PUSH: 0.35,        // E10: crown centre = log end + fallDir x crownR x this
  ENV_CROWN_DARK: 0.6,         // E10: fallen crown colour = leaf green x this (x (1 - 0.18 scorch))
  // M9 E13: sustained fire fells trees (trunk HP, separate from the E2 blast hp)
  ENV_TRUNK_HP_TREE: 900,
  ENV_TRUNK_HP_PINE: 750,
  ENV_TRUNK_HP_DEAD: 300,
  ENV_TRUNK_NOTCH: 0.5,        // notch shows at trunkHp <= this x trunkMax
  ENV_TRUNK_PIERCE: 0.5,       // a pierce pass applies dmg x this to a trunk
  ENV_SHOT_TAU: 2,             // s: decay of the dominant recent shot direction
  WATER_CAMO_ALPHA_SCALE: 3.0, // W1 (Ralph: 3.0): water camo block alpha (1 = as designed; higher -> opaque). Baked: call rebakeWaterCamo()
  // Attract-mode demo (M6)
  DEMO_IDLE_SECONDS: 5,
  DEMO_MAX_SECONDS: 60,
  DEMO_WEAPON_CYCLE: 8,
  DEMO_DAMAGE_MULT: 0.25,
  UNCAPPED_FPS: false, // R3: one update + render per display frame
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
  // F1: the Flamethrower replaces Tesla (slot 7, same unlock); speed = initial flame speed (js/fire.js)
  { name:'Flamethrower', rate:0.05, dmg:10, spread:0.12, count:1, speed:1156, color:'#f80', auto:true, ammo:Infinity, mag:100, reload:2.0, unlock:25000, kickback:1, trail:false, pierce:false, shellSize:0, glow:true, flame:true },
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
