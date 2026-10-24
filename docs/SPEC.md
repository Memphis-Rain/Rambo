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
  - **Q2a. Definition (Ralph, after Anna's perf pass).** "CPU frame time" means **all main-thread JS per displayed frame**: update, sprite/HUD build, the retro RT pass and `app.render`/submit. `perfLog.totalCpuMs` and F4 must measure exactly that.
  - Budget on the reference machine (RTX 5090, 1920×1080, DPR 1):
    - 40 enemies + continuous gore: median ≤ 8 ms, p99 ≤ 16.7 ms.
    - 80 enemies + gore: p99 ≤ 16.7 ms.
  - **Sustained:** over a 5-minute gore session, the median at minute 5 is within 15% of the median at minute 0.5, and fps never sits below 60 for more than 1 s.
  - CI (SwiftShader) checks only the relative sustained criterion. The absolute budget is checked on real-GPU runs.
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
- **R4a. Dither tuning (review of the first build).**
  - At the current strength, flat terrain reads as grainy noise. Add `RETRO.DITHER_STRENGTH` (0..1, default **0.5**), which scales the Bayer offset.
  - Dither should show mainly in gradients (water, shading, smoke, explosions), not as salt-and-pepper on flat grass and sand.
  - Ralph judges the default visually.
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
  - The bomber blinks red, faster the closer it gets to the player. **Decision (Ralph):** this is visual only. The bomber still explodes only when it dies, and no fuse or self-detonation is added (Q4).
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
  - **Amended (Ralph, after review):** baked decal chunks are allowed. The draw count must stay **bounded at ≤ 16** at `MAX_BLOOD_POOLS`. Josh's raise to 2000 is accepted on that bound, and on Q2 holding.
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
  - **Amended (Ralph, after review):** a single stop is at most **0.06 s**, and that includes bosses. A hit-stop can only start at least **0.3 s** after the previous one ended.
  - Triggers are limited to **boss kills and explosions with radius ≥ 100**. Ordinary overkill and gib deaths do NOT hit-stop.
  - Without these limits, fast weapons stalled the simulation to about half speed at 10 kills/s.
  - Acceptance: over 10 s of 10 kills/s with the Minigun, the total simulated time is ≥ 90% of wall time.
- **G2a. Knockback cap (decision, Ralph).** The push stops scaling at 140 damage today, because it's `clamp(50 + dmg*2.5, 60, 400)`. Raise the cap to **900**, and keep the resist factors for Heavy, Tank, Juggernaut and bosses plus the /size divisor. Acceptance: environment collision still resolves after a push, so no enemy ends up inside a tree or rock.
- **G12. Swept bullet hits (bug fix, decision, Ralph).**
  - Since the initial commit, bullets hit by a point test. Fast rounds (Railgun at 4000 moves about 67 units per frame) tunnel through enemies; the Railgun misses about 19 of 20 aimed shots.
  - Fix: use a **swept segment-vs-circle test from the previous to the current position for ALL bullets** (player and enemy).
  - Pierce semantics stay the same: each bullet damages a given enemy at most once, and a non-piercing bullet hits the **nearest** enemy along the segment.
  - Q4 exception: this restores the intended weapon stats and doesn't change them. Unit-test the Railgun hit rate (≥ 95% of aimed shots on a stationary target at 300 units), plus the non-pierce "nearest first" rule.
  - **G12a. Pierce damage preserves the 60 fps balance (decision, Ralph, after review).**
    - The old code had no pierce bookkeeping. A piercing round damaged an enemy on **every 60 Hz frame** it overlapped it.
    - Big targets therefore took several hits, e.g. Plasma did 9 hits to a Juggernaut boss and 3 to a Tank. That was effectively the weapon balance, but it depended on frame rate.
    - "Once per enemy" alone would nerf Plasma, Disintegrator and Railgun against big targets by up to 9×, which breaks Q4.
    - Rule: a piercing bullet hits each enemy once per pass, dealing `dmg × max(1, round(chord / (speed / 60)))`, where `chord` is the length of the bullet's path inside the enemy's hit circle.
    - That reproduces the old 60 fps damage at **any** frame rate.
    - Show one merged damage number per pass (G8).
    - Acceptance (unit): for Plasma, Disintegrator and Railgun against a Tank and against a Juggernaut boss, the new damage per pass is within ±1 hit of the old 60 fps simulation, and identical at 30, 60 and 144 fps.
  - **G12b.** Explosive barrels use the same swept test, so rounds no longer tunnel through barrels. On a non-piercing bullet's path, the nearest of enemy or barrel takes the hit.
- **G11. Bomber chain carry-over (bug fix, found by Anna in T3).**
  - Today `processPendingDamage()` runs at most 3 rounds per frame, then `_pendingDamage.length = 0` throws away the damage still queued. A long bomber chain dies out after about 6 links.
  - Keep the 3-rounds-per-frame anti-recursion cap, but **carry the leftover queue to the next frame** instead of discarding it.
  - Long chains then ripple across frames as a cascade of explosions, which is intentional and fun. Every bomber in a connected chain ends up dead.
  - Q4 exception: the chain still applies the same per-explosion damage. It just no longer drops queued damage.
- **G10. Player damage feedback**: a red flash plus blood drops at the screen edges, with intensity driven by HP lost.

## M4: Explosions & juice (Josh)

- **J1. Pixel fireballs**: frame-stepped colour bands (white → yellow → orange → red → dark smoke), with no smooth alpha fade. The fireball expands in rings.
- **J2. Scorch decals** stay on the ground after an explosion, via the decal path from G4.
- **J3. Debris shower**: dirt chunks plus tumbling shrapnel that settles.
- **J4. Muzzle flashes**: two or three pixel-sprite flash shapes, picked at random per shot, with a size that depends on the weapon.
- **J5. Screen shake tuning**: shake proportional to the event, with a cap so it stays playable.
- **J5a. Shake cap & decay (decision, Ralph, B7).**
  - `CFG.SHAKE_MAX = 20` screen px. That's the shockwave value, the largest legitimate source today, and every `addShake` clamps to it.
  - Decay is frame-rate independent: `shakeMag *= Math.pow(0.85, dt * 60)`, which matches today's feel at 60 fps.
  - Acceptance: the remaining shake 0.3 s after a hit is within 20% at 30 fps and at 60 fps.
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

## M7: Performance hardening (Josh) *(from Anna's perf pass on release point 1)*

- **P1. No frame-time step-up over time (high).**
  - About 60 s after load, frame time steps up permanently (CPU median 2.9 → 4.5–6.4 ms, fps 135 → 60–85) while entity and draw counts stay flat.
  - The prime suspect is the water overlay, which rebuilds ~3000 Graphics instructions every frame (`renderPixiWaterOverlay` 2.1 → 3.0 ms per call).
  - **Find the root cause first, with evidence:** a profile or a bisect showing what grows. Then fix it.
  - Prefer an approach that doesn't rebuild geometry every frame: bake the water mask once per chunk and animate it through a shader, a uniform, or a tiling offset.
  - Acceptance: Q2a's sustained criterion.
  - **P1 root cause (Josh, with evidence in `worktrees/josh/.scratch/p1-investigation/`):**
    - Nothing in the game grows. The ~60 s step is the OS moving the renderer onto the busier CCD of the 2-CCD Ryzen 9950X3D, which makes the same JS ~1.6× slower.
    - Flipping CPU affinity mid-run recovers it, and steps it again, instantly. A run pinned to CCD0 doesn't step (ratio ~1.09).
  - **P1 decision (Ralph):**
    - (a) **Fix the biggest real cost anyway.** `renderPixiWaterOverlay` rebuilds ~3300 rects every frame (~3.7 ms of the 5.0 ms late-state total). Bake the camo per chunk once, and animate the drift with a stepped tiling or texture offset (≤ 10 Hz).
      - Target: water overlay ≤ 0.3 ms per frame, and totalCpuMs (40 + gore) median ≤ 3 ms **unpinned** at minute 2.
      - That makes the scheduler's slow-CCD penalty irrelevant on real machines.
    - (b) **Measurement protocol (Q2a):**
      - Sustained-ratio runs on the reference machine pin the browser to CCD0 (`ProcessorAffinity = 0xFFFF` after launch). They also record an unpinned run, which is informational.
      - The CI relative check runs as-is: GitHub runners have no CCD split.
- **W1. Water camo translucency (bug found in P1, decision Ralph).**
  - `g.alpha` was set per block, but only the final `g.alpha = 1` applied, so the camo has always drawn opaque instead of the intended 0.15–0.37.
  - Restore the intended translucency through per-fill alpha. Expose it as `CFG.WATER_CAMO_ALPHA_SCALE` (1 = as designed, and a higher value moves it back toward opaque).
  - Josh supplies before/after screenshots at x3 with dither on. Ralph picks the shipped value from them.
- **P2. Honest instrumentation.** `perfLog` and F4 include the retro pass and `app.render` (Q2a), and report them as separate lines too.
- **P3. Chunk-generation budget.** At most ~4 ms of chunk baking per frame. Queue the rest and bake nearest-first over the following frames; chunks just off-screen are pre-baked.
  - Acceptance: walking continuously for 30 s produces no frame over 16.7 ms that is caused by terrain.
- **P4. Decal draws under continuous gore.**
  - Growing pools must not block chunk merging. Keep growing decals in a small dynamic layer, and bake only settled decals into 256-chunks.
  - Acceptance: ≤ 16 decal draw calls **during** continuous gore (10 kills/s plus explosions) at `MAX_BLOOD_POOLS`, not just after a static fill.

## M6: Attract mode / CPU demo (Josh) *(user request 2026-10-24)*

Classic 90s arcade behaviour: if nobody touches the game on the title screen for 5 s, a CPU-controlled demo starts and shows how the game is played.

- **D1. Idle trigger.**
  - On the title screen, an idle timer resets on any `keydown`, `mousedown`, `wheel`, or mouse movement of more than 8 px.
  - After `CFG.DEMO_IDLE_SECONDS` (default **5**) with no input, the demo starts.
  - The demo never triggers during real play or while paused.
- **D2. Same input path as a human.**
  - The bot drives the player only through the same inputs a human uses: the `keys` map, the mouse world position, `mouseDown`, right-click, R, Space and the weapon keys. It writes these virtual inputs every frame.
  - No teleporting, and no direct edits to player or enemy state. The demo must show real gameplay.
- **D3. Bot behaviour**, which should look skilled and readable rather than perfect:
  - Target selection: the nearest threat, weighted by danger (bombers and berserkers first).
  - Aim leads the target by its velocity, plus slight human-like jitter.
  - Kiting: keeps a preferred distance and strafes around enemies.
  - Avoids water and obstacles, and stays out of the corners.
  - Reloads when the magazine is low and no enemy is close. Dodge-rolls when an enemy is inside its melee range, or a projectile is about to hit.
  - Uses the shockwave when charged and 5+ enemies are within `CFG.SPECIAL_RADIUS`.
  - Detours for health pickups when HP < 40%.
- **D3a. Readable movement (decision, Ralph, after Anna's B6 metric).**
  - The demo exists to show a human how the game is played, so movement must read as deliberate kiting, not twitching.
  - The bot changes strafe direction about every 0.2–0.25 s in fights (1.5 reversals/s), which looks jittery even when it is real evasion.
  - Rule: hold a chosen strafe direction for **≥ 0.4 s** unless a dodge roll triggers or an obstacle blocks the path.
  - Acceptance, over 3 × 30 s at wave 10:
    - ≤ **0.8 reversals/s** on average.
    - ≤ **3** jitter-in-place windows per 90 s (≥ 3 reversals within 1 s, with net/path displacement < 0.3 and no dodge in the window).
    - Kills stay ≥ 90% of the current rate (58–73 per 60 s).
    - **Kill-rate check (decision, Ralph):** kills are Poisson-noisy (~±10% per 90 s sample).
      - CI fails only when the rate is *significantly* low: `killRate + 2·sqrt(kills)/gameSecs < 0.9·baseline`.
      - The manual demo/perf script runs 5 × 60 s and applies the plain ≥ 90% bar.
  - Priority: after M7 P1. It doesn't block a push.
- **D4. Showcase script.**
  - The demo starts with all weapons unlocked and cycles to the next weapon every ~8 s, so viewers see the whole arsenal: explosions, Tesla chains, railgun beams, gore.
  - Waves ramp faster than in real play so the screen gets busy quickly. **Decision (Ralph, after the first build):** the demo starts at **wave 10**, so Berserkers, Bombers and Commandos are in play and the dodges, shockwave and bomber chains all get shown. Wave 4 was too calm.
  - The demo player takes 25% damage so it survives for a decent run.
- **D5. Demo overlay.**
  - A blinking pixel-font `DEMO` banner at the top, plus `PRESS ANY KEY OR CLICK TO PLAY` at the bottom.
  - Score and HUD are visible as normal.
  - There's no audio (browsers block it before a user gesture anyway); it must not throw when audio is unavailable.
- **D6. Exit & isolation.**
  - Any real input (as in D1) ends the demo immediately and returns to the title screen. That input must not also start a game; the next click on START does that.
  - The demo ends on its own after 60 s, or when the demo player dies. Then it returns to the title and the idle timer restarts, so title → demo → title → demo loops forever.
  - The demo must leave no trace in real-game state: score, kills, unlocks and any best-score storage all reset. Starting a real game afterwards must be identical to starting one from a fresh page load.
- **D7. Code layout.**
  - New file `js/demo.js`, holding the bot plus the demo controller, loaded after `combat.js`.
  - Changes to `main.js` are minimal hooks: the idle timer, the demo entry and exit, and applying the virtual input before `updatePlayer`.
- **D8. Test hooks.**
  - `startDemo()` and `stopDemo()`.
  - `demoState()` returns `{ active, elapsed, weaponIndex, targetId, idleTimer }`.
  - `CFG.DEMO_IDLE_SECONDS` is writable at runtime, so tests can shorten it.
  - `CFG.DEMO_MAX_SECONDS` (default 60) replaces the hard-coded 60 s from D6 and is writable at runtime too.
  - The aim-lead math is a pure function, `demoAimLead(sx, sy, tx, ty, tvx, tvy, bulletSpeed)`, which returns `{ x, y }`. Unit tests call it directly.
  - `demoState().idleTimer` counts **up** from 0 in seconds.

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
- **T11. Attract-mode e2e (M6).**
  - With `CFG.DEMO_IDLE_SECONDS = 1`, the title starts the demo (D1). The demo kills enemies within 20 s, and `gameTime`, kills and weapon index all advance (D3, D4).
  - A keypress exits to the title without starting a game (D6). A subsequent real game starts with score 0, kills 0 and `unlockedWeapons = 1` (D6 isolation).
  - Mouse movement under 8 px doesn't reset the idle timer.
  - There are no console errors throughout (Q1).
  - A unit test for the bot's aim-lead math, if the math is exposed as a pure function.

## Milestone flow

1. Josh finishes a milestone and messages Ralph and Anna with the IDs, files and hooks.
2. Anna runs the full suite plus manual exploratory play on that milestone. She reports pass/fail per ID to Ralph and sends bugs to Josh with repro steps.
3. Ralph reviews the diff against the spec and decides whether to accept or rework. Ralph commits when the user approves.

Order: **M2 (in progress) → M1 → M6 → M3 → M4 → M5**. T runs in parallel throughout. M6 is mostly a new file (`js/demo.js`), so Josh may give it to a subagent in parallel with M1, as long as he integrates the `main.js` hooks himself to avoid edit collisions.
