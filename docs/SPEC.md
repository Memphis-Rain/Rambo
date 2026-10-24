# RAMBO: Endless Assault: Retro Overhaul Spec

**Owner:** Ralph (manager) · **Developer:** Josh · **Tester:** Anna · **Date:** 2026-10-24 · **Status:** Active

This spec is the source of truth for the overhaul. Every item has an ID. Josh references the IDs in his progress reports, and Anna references them in test names (e.g. `test('R2: camera snaps to pixel grid')`). If an item is ambiguous, ask Ralph before inventing behaviour.

## 0. Goal

Our user asked for two things: a proper game-dev environment with correct testing, and a much better visual side. The game should look like an old-school 1990s pixel-art game and feel more animated, bloodier and more fun. **The isometric view stays.**

Non-goals for this round:
- Migrating to ES modules. The game stays as classic `<script>` files that share one global scope.
- New weapons, enemies or game modes.
- Mobile support.

## 1. Roles & rules of engagement

| Role | Who | Owns |
|---|---|---|
| Manager | Ralph | `docs/SPEC.md`, task assignment, review, git commits |
| Developer | Josh | All game code: `js/**`, `game.html`, `assets/**` |
| Tester | Anna | `package.json`, `tests/**`, test/lint configs, `.github/workflows/**`, `.gitignore`, the README "Development" section |

- Anna never edits `js/` or `game.html`. If a test needs a hook, she asks Josh with the exact name and semantics.
- Josh reports each milestone to Ralph and Anna with: the IDs done, the commit SHA, any new globals or hooks, and the known issues.

### Worktrees & branches (race-free file access)

| Who | Worktree | Branch | Dev server |
|---|---|---|---|
| Ralph | `C:\work\Rambo` | `main` (integration) | `:8765` |
| Josh | `C:\work\Rambo\worktrees\josh` | `dev/josh` | `:8766`, or via Ralph's `:8765/worktrees/josh/game.html` |
| Anna | `C:\work\Rambo\worktrees\anna` | `test/anna` | `:5173` (Vite), Playwright as she configures it |

- Each person edits **only inside their own worktree**. Nobody edits `C:\work\Rambo` outside `worktrees/` except Ralph.
- **Everything stays inside `C:\work\Rambo`.** Nothing is created elsewhere on disk; temp files go in your own worktree, under a git-ignored dir.
- `worktrees/` is excluded locally via `.git/info/exclude`. Every tool config (ESLint, Vitest, Vite, Playwright) must ignore `worktrees/**`.
- Josh and Anna commit to their own branches. Use small commits with spec IDs in the message, e.g. `M1 R1-R3: low-res world target`. Never push, never commit to `main`, and never rewrite history that has already been reported.
- Ralph reviews each reported commit range against the spec and merges it into `main` with `--no-ff`. Pushing to a remote happens only with the user's approval.
- Anna tests a milestone by merging `main`, or Josh's reported SHA, into `test/anna` (`git merge dev/josh`) and running the full suite there.
- Josh may `git merge test/anna` to pick up the tooling (lint and tests) and run it locally before reporting.

### Context hygiene: delegate to subagents

The primary sessions keep their context for coordination and decisions:
- Split each milestone into independent subtasks, for example one per spec ID or file group, and hand them to subagents with a precise brief: the spec IDs, the files, the acceptance criteria, and what not to touch.
- Subagents that edit code run sequentially, or on disjoint files, so they don't collide inside one worktree. Use parallel subagents for read-only work: research, review and exploratory testing.
- The primary session reviews each subagent's diff summary, runs the checks (`node --check`, lint and tests), and commits.

## 2. Global acceptance bar (applies to every milestone)

- **Q1.** No uncaught errors or `console.error` from boot through 60 s of play. Allowed noise: the `favicon.ico` 404 and `[RAMBO PERF]` warnings during the first second.
- **Q2.** Performance: with 40+ enemies on screen and heavy gore, the F4 dump shows a CPU frame time under 12 ms on the dev machine, and the game holds 60 fps.
- **Q3.** `node --check` passes on every `js/*.js` file, and `npm run lint` reports 0 errors.
- **Q4.** Gameplay is unchanged unless the spec says otherwise. That covers damage numbers, weapon stats, unlock scores and wave scaling, which the unit tests lock down.
- **Q5.** Mouse aim stays exact after the pixel pipeline lands. The cursor must map to the correct world point.

---

## M1: Retro render pipeline (Josh) *(highest priority, after the current animation chunk)*

The world is rendered at low resolution and upscaled with nearest-neighbour, so everything becomes chunky pixels automatically.

- **R1. Low-res world target.**
  - Add `js/retro.js` (loaded right after `state.js`) containing `const RETRO = { PIXEL_SCALE: 3, DITHER: true, CRT: true, LEVELS: 6 }`.
  - The world (`worldContainer`, including terrain, entities and effects) renders into a `RenderTexture` sized `ceil(W/PIXEL_SCALE) × ceil(H/PIXEL_SCALE)` with `scaleMode: 'nearest'`.
  - A full-screen `Sprite` displays it scaled by `PIXEL_SCALE`. `uiContainer` stays at full resolution, on top.
  - The render target is rebuilt on window resize.
- **R2. Pixel-grid camera.** Snap the world offset to whole low-res pixels so terrain doesn't shimmer while the camera moves. Screen shake moves in whole low-res pixels too.
- **R3. Render once per display frame.**
  - Render the RT from an `app.ticker` callback that runs before the app's own stage render: a higher priority than `PIXI.UPDATE_PRIORITY.LOW`.
  - Set `CFG.UNCAPPED_FPS = false`. Today the `setTimeout(0)` loop rebuilds all Graphics several times per display frame, wasting CPU. The game loop must use `requestAnimationFrame`.
- **R4. Palette dither filter.**
  - A custom Pixi v8 `Filter` on the low-res pass posterizes each RGB channel to `RETRO.LEVELS` levels.
  - It applies a 4×4 Bayer ordered dither before quantizing, plus a small contrast and saturation boost, for a VGA/SNES-era look.
  - The filter runs at low resolution, so the dither pattern is chunky. Toggle with `RETRO.DITHER`.
- **R5. CRT overlay.**
  - Full-resolution scanlines: darken the last screen row of every `PIXEL_SCALE` rows by about 25%, using a tiling texture, not a per-pixel shader.
  - Add a subtle vignette. Toggle with `RETRO.CRT`.
  - Do **not** add screen curvature, because it breaks aim mapping (Q5).
- **R6. Showcase toggles.** **F6** cycles `PIXEL_SCALE` through 1 → 2 → 3 → 4, where 1 is the original look, for before/after demos. **F7** toggles DITHER. **F8** toggles CRT. Each change shows a notification such as `PIXEL x3`.
- **R7. Test hooks.** Expose `window.RETRO` (the config object) and a `retroState()` function that returns `{ scale, rtWidth, rtHeight, dither, crt }`.

## M2: Animation (Josh)

Because of M1, art must read at 1/3 resolution:
- No 1 px hairlines.
- Flat colours with hard 2–3-tone shading.
- A strong dark outline around characters.
- Alpha only where it adds something.
- Colour and alpha changes step in frames rather than tweening smoothly.

- **A1. Walk cycles** for the player and all 12 enemy types: leg and arm swing, plus body bob, with the phase driven by distance travelled, so the feet don't slide.
- **A2. Idle**: a breathing bob, and occasional weapon fidgets for the player.
- **A3. Firing**: a recoil pose (arms and weapon pulled back for about 2 frames) on every shot, with the size scaled by `weapon.kickback`.
- **A4. Dodge roll**: a visible roll or tumble animation, not just a slide.
- **A5. Enemy telegraphs**:
  - The bomber blinks red at a speed that increases near detonation.
  - The sniper shows a laser sight, plus a glint before it fires.
  - The berserker shakes when it charges.
  - The Medic shows a heal pulse.
- **A6. Animated world bits**: tree sway (optional, if cheap), water already animated, and pickups that bob and blink.

## M3: Gore & hit feedback (Josh)

- **G1. Hit flash**: an enemy turns solid white for 2 frames when hit (60 Hz frames).
- **G2. Knockback**: a hit pushes the enemy along the bullet angle. The push scales with weapon damage and is reduced for Heavy, Tank, Juggernaut and bosses.
- **G3. Blood spray v2**:
  - Bigger, arcing sprays with z-gravity. Particles land and become ground splats; they don't just fade out.
  - Each hit sprays in a cone along the bullet direction.
- **G4. Persistent splatter decals**:
  - Ground splats stay for the session, up to `CFG.MAX_BLOOD_POOLS` (oldest recycled first).
  - Render them through the existing batched blood-pool path. Draw-call count must not grow with the number of splats.
- **G5. Gibs**:
  - Explosive, BFG, Railgun and overkill deaths (damage ≥ 2× remaining HP) burst into 5–8 chunks: head, limbs and torso bits.
  - Chunks bounce with z-gravity, leave smear trails and settle as decals.
  - Normal deaths play a fall animation and leave a corpse.
- **G6. Arterial spurts**: a fresh corpse pumps 3–5 pulses of blood over about 1.5 s.
- **G7. Wound drips**: an enemy below 50% HP drips a blood trail. The player leaves bloody footprints for about 3 s after stepping through a pool.
- **G8. Damage numbers**: chunky pixel numbers that pop up, overshoot and fall. Crits and overkill are bigger and red.
- **G9. Hit-stop**:
  - Josh adds `let hitStopTimer = 0` in `combat.js`. It is set to 0.03–0.06 s on big kills or explosions.
  - The main loop skips `update()` while it's above 0, but still renders.
  - It never stacks above 0.1 s.
- **G10. Player damage feedback**: a red flash plus blood drops at the screen edges, with intensity driven by HP lost.

## M4: Explosions & juice (Josh)

- **J1. Pixel fireballs**: frame-stepped colour bands (white → yellow → orange → red → dark smoke), with no smooth alpha fade. The fireball expands in rings.
- **J2. Scorch decals** stay on the ground after an explosion, via the decal path from G4.
- **J3. Debris shower**: dirt chunks plus tumbling shrapnel that settles.
- **J4. Muzzle flashes**: two or three pixel-sprite flash shapes, picked at random per shot, with a size that depends on the weapon.
- **J5. Screen shake tuning**: shake proportional to the event, with a cap so it stays playable.
- **J6. Shell casings**: they bounce once and settle on the ground. This already partly exists; make it read at pixel scale.

## M5: Retro HUD & title (Josh)

- **H1. Pixel font**:
  - Bundle **Press Start 2P** (SIL OFL 1.1) locally under `assets/fonts/`, with its license file. No runtime fetch from a CDN.
  - All HUD and pause text uses it, and text is rendered without smoothing.
  - The game must wait for `document.fonts.load(...)` before it creates the HUD Text objects.
- **H2. HUD restyle**:
  - Hard-edged panels with bevelled borders (light top-left, dark bottom-right), as in 90s arcade and DOS games.
  - Segmented HP and shield bars.
  - Layout and information stay the same as today.
- **H3. Kill-streak banners**: `KILLING SPREE!` etc. use the pixel font with a bounce-in and a colour cycle, replacing the plain DOM notification styling.
- **H4. Title screen**:
  - Retro title with the pixel font, a blinking `PRESS START`, and scanlines.
  - Show the controls, including the F6/F7/F8 showcase toggles.
  - The `#start-btn` id and the `startGame()` entry point must keep working for the tests.

---

## T: Dev environment & testing (Anna)

- **T1.** `npm install` works on a clean clone. `node_modules/`, `test-results/` and `playwright-report/` are git-ignored.
- **T2.** `npm run dev` starts a static dev server with live reload on port 5173 and loads the game with no errors.
- **T3. Unit tests (Vitest), `npm test`.** A loader runs the classic scripts in `node:vm` with minimal PIXI/DOM stubs. Coverage:
  - `utils.js`: the iso transform round-trip, `clamp`/`lerp`, `seededRand` determinism, and `noise2D` range and determinism.
  - `config.js`: required fields on every weapon and enemy; unlock scores strictly ascending; `BOSS_NAMES` count consistent with the weapons.
  - Combat logic that can run headless: damage application, shield before HP, combo and score multipliers, wave composition and scaling.
  - Once M1 lands: `RETRO` defaults, and the pixel-snap math (R2).
- **T4. E2E (Playwright, Chromium), `npm run test:e2e`.** These all run with the Q1 console-error guard.
  - Boot.
  - START MISSION: the loop advances and `gameTime` increases.
  - WASD movement.
  - Shooting spawns bullets.
  - A forced kill produces blood (G3/G4), and an explosive kill produces gibs (G5).
  - The F6/F7/F8 toggles change `retroState()` (R6/R7).
  - Pause with P.
- **T5.** Mouse-aim correctness (Q5): with the player at a known position, move the mouse to a known screen point. The aim angle and the world point must match within 1 low-res pixel at `PIXEL_SCALE` 1 and 3.
- **T6.** Perf smoke: spawn 40 enemies via `page.evaluate`, run 5 s, then read `perfLog`. Assert `fps >= 50` (soft threshold for CI; log the numbers).
- **T7.** Screenshots of the title screen, gameplay at x1 and x3, a gore scene, and the pause screen, saved as test artifacts. No strict pixel diffs while visuals are changing.
- **T8.** `npm run lint`: ESLint flat config with the cross-file globals declared. It catches undefined and unused variables, not style.
- **T9.** GitHub Actions `ci.yml` runs lint, unit and e2e (installing Chromium) on push and PR.
- **T10.** A README "Development" section covering install, dev, test, e2e, lint and the showcase keys.

## Milestone flow

1. Josh finishes a milestone and messages Ralph and Anna with the IDs, files and hooks.
2. Anna runs the full suite plus manual exploratory play on that milestone. She reports pass/fail per ID to Ralph and sends bugs to Josh with repro steps.
3. Ralph reviews the diff against the spec and decides whether to accept or rework. Ralph commits when the user approves.

Order: **M2 (in progress) → M1 → M3 → M4 → M5**. T runs in parallel throughout.
