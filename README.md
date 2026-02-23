# RAMBO: Endless Assault

A top-down isometric shoot-em-up built entirely in the browser with PixiJS. Survive endless waves of increasingly dangerous enemies, unlock 11 devastating weapons, and defeat bosses to expand your arsenal.

## How to Play

Open `game.html` in a modern browser and click **START MISSION**.

### Controls

| Key | Action |
|-----|--------|
| **WASD** | Move |
| **Mouse** | Aim |
| **Left Click** | Shoot |
| **Right Click** | Shockwave (when charged) |
| **R** | Reload |
| **Space** | Dodge Roll |
| **Shift** | Sprint |
| **1-0, -** | Switch Weapon |
| **Q / E** | Previous / Next Weapon |
| **P** | Pause |
| **F3** | Debug Overlay |
| **F4** | Dump Performance to Console |

## Features

### Weapons (11 total, unlocked by score)
Pistol, Uzi, Shotgun, M16, Minigun, RPG, Plasma Rifle, Tesla Gun, Railgun, BFG, Disintegrator

Each weapon has unique behavior - chain lightning, piercing beams, explosive rockets, disintegration effects, and more.

### Enemies (12 types)
Militia, Runner, Heavy, Officer, Berserker, Bomber, Commando, Medic, Sniper, Shielded, Tank, Juggernaut

Enemies spawn in waves with increasing difficulty. Medics heal allies, Bombers explode on death, Snipers engage from distance, and Shielded troops require breaking their barrier first.

### Boss Fights
Reaching a weapon's unlock score triggers a boss battle. Defeat the boss to unlock the new weapon.

### Combat Systems
- **Shield** - Auto-regenerates after a delay, absorbs damage before HP
- **Shockwave** - Charges on kills, unleash a devastating area-of-effect blast
- **Dodge Roll** - Brief invincibility window with a short cooldown
- **Combo System** - Chain kills for score multipliers (Killing Spree, Rampage, Unstoppable, Godlike, Legendary)
- **Health & Shield Pickups** - Dropped by defeated enemies

### World
- Procedurally generated isometric terrain with grass, dirt, sand, water, hills, and dark forest
- 3D-projected trees, boulders, ruins, explosive barrels, sandbags, and crates
- Animated water with digital camo overlay
- Environmental collision for trees, rocks, and boulders
- Water slows movement and creates splash effects

### Technical
- **Rendering** - PixiJS v8 with WebGL
- **Audio** - Procedural Web Audio API (no audio files needed)
- **Particles** - Blood sprays, explosions, muzzle flashes, shell casings, smoke, fireflies, water sparkles
- **Performance** - Sprite pooling, chunk-based terrain, batched blood pool rendering, frame budget monitoring

## Project Structure

```
game.html              - Entry point
js/
  config.js            - Game constants, weapon & enemy definitions
  utils.js             - Math helpers, noise, isometric transforms
  audio.js             - Procedural sound engine
  state.js             - Global state & PixiJS app initialization
  particles.js         - Particle system (blood, explosions, effects)
  world.js             - Terrain generation & environment objects
  combat.js            - Player, enemies, bullets, waves, bosses
  pixi-terrain.js      - WebGL terrain rendering & water overlay
  procedural-tree3d.js - 3D tree geometry with baked lighting
  pixi-sprites.js      - Entity rendering (player, enemies, pickups)
  pixi-hud.js          - UI overlay (health, score, minimap, crosshair)
  renderer.js          - Legacy Canvas2D renderer (unused, kept for reference)
  main.js              - Game loop, input, camera
lib/
  pixi.min.js          - PixiJS v8 (local copy)
```

## License

This project is licensed under the [MIT License](LICENSE).
