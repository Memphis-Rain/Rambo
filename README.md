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

## Development

Requires Node.js 22.13+ or 24+ (CI uses 24); Vitest 5 and ESLint 10 set that floor, and odd-numbered Node releases (23, 25) are not supported. The game itself stays plain `<script>` files with no build step; npm is only for tooling.

```bash
npm install                      # dev tooling: Vite, Vitest, Playwright, ESLint
npx playwright install chromium  # once, for the e2e tests
```

| Command | What it does |
|---|---|
| `npm run dev` | Dev server at http://localhost:5173/game.html. Reloads the page when `js/` changes. |
| `npm test` | Unit tests (Vitest). `tests/helpers/load-game.js` evaluates the game scripts in `node:vm` with PIXI/DOM stubs, so game logic runs without a browser. |
| `npm run test:watch` | Unit tests in watch mode |
| `npm run test:e2e` | Browser tests (Playwright, Chromium). Starts its own dev server on port 5173 (override with `PW_PORT=5174`; it never reuses a server that's already running) and fails on any console error. Screenshots go to `playwright-report/`; view them with `npx playwright show-report`. |
| `npm run perf:sustained -- --gpu` | Manual Q2a check on a real GPU: 5 minutes of heavy gore at 1920x1080, then a JSON report in `test-results/` (sustained median, time below 60 fps, CPU budget). Without `--gpu` it uses software WebGL, which gives relative numbers only. |
| `npm run perf:demo` | Manual D3a check: demo kill rate over 5 x 60 s against the baseline (needs ≥ 90%), with a JSON report in `test-results/`. |
| `npm run lint` | ESLint. Catches undefined and unused variables, not style. Cross-file globals are read from each `js/*.js` file's top-level declarations, so new globals need no config change. |

Test names start with their ID from `docs/SPEC.md` (e.g. `T3: ...`, `R6/R7: ...`). Tests for features that haven't landed yet are skipped until their hooks exist. In e2e, `PERF_MIN_FPS` (default 50) sets the fps bar for the T6 perf test; it is only enforced on a hardware GPU.

CI (`.github/workflows/ci.yml`) runs a syntax check, lint, unit tests and e2e tests on every push and pull request.

### Showcase keys

| Key | Action |
|---|---|
| **F3** | Debug overlay |
| **F4** | Dump performance stats to the console |
| **F6** | Cycle pixel scale x1 → x2 → x3 → x4 (once M1 lands) |
| **F7** | Toggle palette dither (once M1 lands) |
| **F8** | Toggle CRT scanlines (once M1 lands) |
