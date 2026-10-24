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
  - Budget on the reference machine (RTX 5090, 1920×1080, DPR 1), **measured pinned to CCD0** per the P1(b) protocol. Unpinned numbers are recorded as informational.
  - The remaining render cost is Pixi per-object work for ~2,400 visible objects. A particle/puppet atlas pass is deferred as **P5 (future)** and is out of scope now.
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
- **G13. Head-to-toe hits (bug, user report 2026-10-24: "shooting works only when aiming at their legs, headshots are impossible").**
  - Cause, to be confirmed with evidence: aim maps the cursor to the **ground plane**. Aiming at a head maps to a ground point *behind* the enemy (screen-up = world (−1, −1) in iso), so the bullet path passes it by. The hit circle sits at the feet.
  - Fix, both parts:
    - **(a) Aim picking.** If the cursor is over an enemy's drawn body (sprite bounds, topmost by depth), the aim point becomes that enemy's ground position, i.e. the centre of its hit circle, plus the existing spread. Otherwise the ground-plane mapping stays. The cursor itself is not moved, and Q5 stays exact for ground aiming.
    - **(b) Body-column hitbox.** Each enemy's hit region is its foot circle **extended along the iso screen-up direction** by its drawn body height, converted to world units: a capsule from the feet to "head height behind". That way a shot whose path crosses the visible body counts even without picking (e.g. with spread).
    - The same applies to the player's hitbox against enemy bullets, for symmetry.
  - Q4 note: this makes hits match what you see; it's a bug fix.
  - Acceptance:
    - With a zero-spread weapon (e.g. Railgun), aiming at the **head, torso and legs** of each of the 12 enemy types and a boss, from 4 iso directions, at x1 and x3, gives ≥ 95% hits each.
    - Aiming 1 body-width beside the drawn sprite misses.
    - An enemy standing behind another doesn't steal a shot aimed at the front enemy's head (picking takes the topmost).
  - **G13c. Explosives that hit a body detonate at the target's feet.** Ruling, 2026-10-24, on Anna's finding:
    - On 96168fd, a rocket detonates where it enters the column. For a target screen-below the shooter that entry is the column top, up to 135u from the feet (Juggernaut). The splash then misses the target it hit and can land on enemies behind it.
    - Rule: when a contact-detonating projectile (RPG, and any other contact explosive) hits an enemy's body region, foot circle or column, the explosion point is that **enemy's ground position** (e.x, e.y). The splash centre, scorch decal (J2), debris (J3), and blast forces on the environment (E-series) all use that point.
    - Ground hits, barrels and trunks don't change.
    - Why: the splash has to land on the enemy it hit and on its world neighbours. A world point 135u off is wrong in world terms, even if it's drawn over the head.
    - Q4: the direct-hit damage and the splash radius and falloff don't change. Only the centre moves to where the target stands.
    - Acceptance: an RPG aimed at the head, torso and legs of each enemy type and a boss, from 4 directions including screen-below, detonates within 3u of the target's ground position, and the target takes full splash damage (f = 1 at d ≈ 0).
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
      - **Corrected (Ralph):** the 3 ms figure came from pre-P2 accounting, which excluded the render pass. It now applies to `buildMs` only (which includes update), and is met at ~2.0 ms. Render-inclusive cost is governed by Q2a.
      - **Result:** the overlay costs 0.01 ms per frame.
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

## M8: Physical environment (Josh) *(user request 2026-10-24)*

User: "when something blows up it does not affect the trees… make the env react to physics as in real life… consider baked textures when removing debris… add a little more trees… some trees grow from water."

Principles:
- Reactions are **impulse-driven and local**. Only objects near an event get simulated, in a small active set that sleeps again when they come to rest, so idle cost stays ~0.
- Anything that has finished moving gets **baked**: debris, stumps, logs, rubble and scorch go into the terrain-chunk decal layer, the same path as G4, so a destroyed forest costs no more per frame than an intact one.
- All of this is a deliberate gameplay change, requested by the user. Q4 is waived for M8 items only.

- **E0. Root-cause and fix "trees growing from water" (bug).**
  - `world.js` already rejects water at the centre and 8 points at r=40, yet trees appear in water.
  - Find out WHY before fixing. Candidates: `getTerrainTypeAt` disagrees with the rendered tiles (sampling vs tile quantization), the trunk is drawn offset from (x, y), the canopy radius (up to 60) is bigger than the check radius, or chunk-border sampling. Report the evidence.
  - Acceptance: no tree, pine, dead tree, bush or boulder has its drawn trunk or base on a rendered water tile, checked over 200 generated chunks. A canopy may overhang water; a trunk may not.
- **E1. More trees.**
  - Raise tree density by **~30%** (forest and open ground alike), keeping the clear spawn area and the E0 rule.
  - Perf must stay within Q2a; trees are already baked sprites.
- **E2. Blast response for trees.** For each tree within an explosion's radius R, with `f = 1 − d/R`:
  - `f > 0`: a sway impulse away from the blast, on a damped spring (~1.5 s to settle), plus a leaf burst scaled by f.
  - `f > 0.35`: also **scorch**. The canopy darkens in steps and smokes briefly. Persistent.
  - `f > 0.6`, or a cumulative damage threshold from repeated blasts: the tree **topples**. The trunk snaps at its base and the tree falls away from the blast over ~0.6–0.9 s, rotating about the base in iso, foreshortened along the fall direction.
    - Impact: a dust and leaf burst plus shake (J5a cap).
    - Then the log settles, and the stump and log get **baked** into the chunk.
  - BFG and RPG explosions can fell several trees at once.
- **E3. Small-arms response.** Bullets hitting a tree (trunk circle) emit bark and leaf chips, and give a tiny sway.
  - Bullets are stopped by trunks as today. Pierce rounds pass through and still emit chips.
  - Small arms never fell trees.
- **E4. Other environment objects.**
  - Crates splinter, and sandbags burst with a sand puff, under explosions (f > 0.3) or after enough bullet damage.
  - Boulders and ruins crack under f > 0.6, and shatter into rubble chunks under BFG.
  - Dead trees snap more easily (threshold f > 0.4).
  - Debris pieces use simple z-gravity, bounce and friction (like the G5 gibs), then settle and **bake**.
- **E5. Collision follows state.**
  - A standing tree is a circle obstacle (as today). A felled tree's stump becomes a small circle.
  - The fallen log becomes a **capsule obstacle**: it blocks movement, but bullets fly over it as low cover.
  - Destroyed crates and sandbags lose their collision. Rubble has none.
  - Enemy and demo-bot pathing (D3) must handle new and removed obstacles.
- **E6. Falling-tree damage.** Enemies under a falling trunk take **120** damage, and the player takes **40**, applied once when the trunk lands. A kill credits the player (score, combo) when the player's explosion caused the fall.
- **E7. Persistence.**
  - Destruction state persists for the whole session, even when a chunk unloads and regenerates: store it per stable object id (chunk + index).
  - A new round (`resetRound`, including the demo, D6) restores an intact world.
- **E8. Budget & caps.**
  - The active physics set is ≤ 64 objects, and debris pieces ≤ `CFG.MAX_DEBRIS` (default 300; oldest settle-and-bake first).
  - Baked environment debris shares the chunk decal draws; G4's ≤ 16 decal draws still holds.
  - Q2a still holds: a BFG felling 10+ trees must not cause a frame over 16.7 ms (spread baking over frames, as in P3).
- **E10. Rulings on the E2–E9 core (Ralph, after Josh's 5446b82 report).**
  - **(a) Trunks stop bullets: KEEP** ("as in real life"). Before this, bullets were never stopped by trunks; only barrels were checked.
    - Non-piercing rounds stop at trunks, stumps, crates and sandbags. RPG, BFG and tank shells explode on impact, which feeds E2.
    - **Piercing rounds (Plasma, Railgun, Disintegrator) pass through trunks**, emitting chips, per E3.
    - Enemy bullets are blocked the same way, so trees become cover for both sides.
  - **(b) New small collisions** for dead trees, crates and sandbags: **KEEP**.
  - **(c) Demo bot line of fire (D3b).** The bot must not waste fire into trunks. Before firing a non-piercing weapon, it checks the swept line to its target. If an obstacle blocks it, it strafes to clear the line, or retargets. Acceptance: < 15% of demo shots end on environment objects at wave 10 in forest-heavy areas.
  - **(d) Credit** as Josh implemented it: a fall the player didn't cause still damages, but gives no score or combo. Bushes are destroyed, not toppled.
  - **(e) Decal budget split.**
    - **Structural remains** (stump, log, rubble footprint) are **world state, not decals**. Render them from the E7 persistence store, baked into the chunk's environment layer at chunk bake and rebuilt from the store when a chunk regenerates.
    - They are **never recycled by gore**: a log that still has collision must always be visible.
    - Cosmetic splinters, sand and leaves share the gore decal pool, as now (leaves at 1 in 8).
    - The environment layer may add **≤ 4 draws per visible chunk ring** on top of G4's ≤ 16.
- **E11. Rulings on Anna's M8 exploratory findings (Ralph).**
  - **(a) Logs are hurdles, not walls. This fixes the closed pen (#4).**
    - Anyone (player, enemies, demo bot) may **climb over a log at ×0.35 speed** while their body overlaps the capsule.
    - Explosions with **f > 0.5 splinter a log** into debris: the capsule is removed and the remains update. For a log, `d` is the distance from the blast centre to the **nearest point on the log's axis segment**.
    - Steering along the log toward its nearer end (review item 1) stays: enemies take the end when it's closer than ~1.5× the log's width, otherwise they climb.
    - The player can never be fully enclosed.
  - **(b) Depth-sorting logs against standing entities (#7): DEFERRED** as a known visual issue. Logs are low and ground-level.
  - **(c) D3b measures only what the bot controls:** shots stopped by an environment object **before reaching the target's distance**. Misses that fly on past the target into trees behind it don't count. The bar stays < 15%.
  - **(d) The D3a kill-rate bar applies in normal terrain.** Forest-heavy runs are recorded as informational.
  - **(e) Canopy fade (#10): YES.** Tree sprites whose bounds cover the **player** fade to ~40%, using an ordered-dither (retro) or a stepped alpha, over 0.15 s, and restore when the player leaves. Sprite alpha only, no rebake.
- **E12. Remains must not grow per-frame cost (Ralph, after Anna's c8b2144 baseline).**
  - On the real GPU, pinned to CCD0, a 5-minute gore session slowed from 4.0 → 6.0 ms (ratio **1.50**, bar 1.15). Unpinned it was 1.78.
  - The cause is accumulated M8 state: each stop adds a remains Graphics (2 → 17 with only 3 loaded chunks), there's per-log rect geometry, and envLogs is scanned in full every frame.
  - Required:
    - The remains of a chunk are **baked to a RenderTexture once per settle-batch** and drawn as **one sprite per chunk**, so render cost is constant in the number of felled trees.
    - Log collision is queried through a per-chunk spatial bucket.
  - Acceptance: perf:sustained, 5 min, pinned: ratio ≤ 1.15 **with remains persisting**, and the 40+gore budget holds.
- **E8 clarification.** "A BFG felling 10+ trees" means **any single frame's explosion(s) that fell 10+ trees in total**, whether from one BFG or several. Over the following 3 s, no frame may exceed 16.7 ms (pinned). Anna's perf:bfg showed 2 frames at 17.4 ms, which is a FAIL that the E12 coalescing must fix.
- **P1(a) reminder.** The 3 ms target is **`buildMs` ≤ 3 ms**, not totalCpuMs. `buildMs` already includes update plus sprite/HUD build; earlier wording that said "buildMs + updateMs" double-counted.
- **E9. Test hooks.**
  - `envState(id)` returns `{ state: 'standing'|'scorched'|'falling'|'fallen'|'destroyed', hp, sway }`.
  - `envStats()` returns `{ active, debris, felled }`.
  - `CFG.MAX_DEBRIS`.
  - Thresholds live in `CFG.ENV_*`, so tests can read them.

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

## M9: Water, fire & grenades (Josh) *(user request 2026-10-24)*

User: "when enemy or player enters water, only half the body should be visible (legs in water); blood over the water and dead bodies should sink and dissolve, and the water should turn progressively red as more blood mixes in… I like the bloody footprints… add grenades on F… intensive shooting into trees should cut the tree down… replace the electric gun with a flamethrower (burning trees, and burning enemies running in panic)."

- Q4 is waived for M9 items only.
- Q2a, P1(a) (buildMs ≤ 3) and the sustained ratio ≤ 1.15 still apply.
- Every M9 item gets its own LANDED flag.
- Keep the 90s look: colour changes are **stepped and dithered**, with no smooth alpha gradients. Same rule as J1.

### Water

- **W2. Wading.**
  - An entity whose ground position is on a rendered water tile (the same tile test as the water slowdown in combat.js) is drawn **submerged**: the lower 45% of its drawn body is hidden below a waterline. Entities are the player, all 12 enemy types and bosses.
  - At the waterline: a 1–2 px light ripple ellipse that animates (2–3 frames). Moving entities also leave a V-shaped wake of fading ripple pixels.
  - Depth ramps over ~0.25 s on entering and leaving, so the waterline never pops. The ground shadow is hidden while submerged.
  - Implementation: crop the sprite or texture frame, or split by draw order. **No per-entity masks or filters**, because of the P-series budget.
  - Gameplay: movement and collision don't change.
    - G13 aim picking uses the **visible** bounds only.
    - The G13 body column is shortened to match: hits below the waterline go into the water and make a splash, not a hit.
    - The foot circle shrinks to keep things fair: hits register if the path crosses the visible column or the foot circle's waterline ring at r × 0.6. Josh proposes the exact geometry; Anna verifies "aim at the visible torso/head → hit".
    - **W2 geometry, accepted (Josh 53d5967):**
      - Visible body: the G13 capsule from the waterline to the head, radius r × (1 − 0.4·submerge). A path crossing it hits.
      - Wet zone: the submerged column only. A path that only crosses it gives a splash, no damage, and flies on.
      - Contact explosives keep the whole body region (G13c).
      - Enemy rounds against a wading player follow the same rules.
      - Picking uses the visible bounds only. Picks, enemy fire and the demo bot aim at `aimPointOf()` on the visible column.
- **W3. Blood in water.**
  - Blood particles, drips and gibs that land on a water tile make **no ground decal**. Each one makes a **blood cloud** instead: a dithered red blob that expands to ~2× over 4 s and fades in steps over ~8 s, drifting slightly.
  - G7 bloody footprints are **kept unchanged on land** (the user likes them).
  - Footprints never print on water, and wading **washes the feet**: leaving water resets the footprint timer.
- **W4. Bodies sink and dissolve.**
  - A corpse whose ground position is in water floats for ~0.5 s, then sinks over ~2.5 s (its waterline rises to cover it), then dissolves in a dither-fade over ~1.5 s, releasing a big blood cloud and a few bubbles.
  - Gibs in water sink over ~1 s.
  - Corpses in water are **never baked** into the chunk.
  - Corpse-count limits still apply.
- **W5. Water reddens with blood.**
  - Each water tile has a blood concentration c ∈ [0, 1]. Events add to the tiles nearby, with linear falloff:
    - hit: +0.02 within 1 tile;
    - gib: +0.05 within 2 tiles;
    - corpse dissolve or kill: +0.15 within 3 tiles.
  - Concentration slowly diffuses into connected neighbouring water tiles and decays with a **half-life of 180 s**.
  - Rendering:
    - A tint overlay from water colour towards dark blood red, drawn in **4 discrete bands**, dithered, up to ~75% coverage at c = 1.
    - A pond after a big fight should read as clearly red.
  - Performance:
    - Updates run at ≤ 4 Hz and only for dirty tiles.
    - The baked water camo (P-series) must **not** be rebaked per frame; use an overlay layer.
    - Tiles with c < 0.02 are pruned.
  - State is per tile key for the session; `resetRound` clears it.

### Grenades

- **N1. Grenades on F (new; none exist today).**
  - Press F to throw a grenade toward the cursor's ground point (Q5 mapping, so G13 picking is irrelevant here). Max range is 420u; farther targets clamp.
  - Flight:
    - A visible arc with a z-height of ~0.3 × distance and a flight time of 0.6–0.9 s, with a spinning 2–3 frame pixel sprite and a shadow.
    - On landing it bounces once or twice with friction, and trunks, crates and obstacles bounce it.
  - The fuse is **1.8 s from the throw**, and a blinking red pixel shows in the last 0.6 s.
  - Explosion:
    - Damage 200, radius 140, through the same explosion path as the RPG: splash falloff, J1 fireball, J2 scorch, J3 debris, envBlast (trees react, E2), and the same self-damage rule as the RPG.
    - In water it sinks and blows a **water geyser** (a white and blue column, a ring of ripples and spray) with radius × 0.7, no scorch, and W5 is unaffected.
  - Ammo:
    - 3 at round start, max 6, plus 1 at each wave start.
    - Enemies drop a grenade pickup with 6% chance.
    - Throw cooldown 0.5 s.
  - HUD: grenade icons next to the ammo (H-series style).
  - Demo bot: throws when ≥ 4 enemies are within 140u of a point inside the throw range and the player is outside that radius; at most once per 4 s.
  - **N1 rulings** (Ralph, on Josh's question):
    - Damage uses literal RPG-path reuse: a pseudo-round with dmg 200 and R 140 goes through the same explode code, with no direct hit. So splash = 0.7 × 200 × (1 − d/R), which is 140 at the centre.
    - Geyser: same dmg, R 98.
    - No self-damage (as RPG). Kill source SRC_EXPLOSIVE.
    - A pickup gives +1, capped at 6, and bosses drop at 6% too. The wave +1 is capped at 6 and applies **from wave 2 onward**, not wave 1. The demo, which starts at wave 10, gets 3 at its start and +1 per later wave.
    - F throws on key-down, once per press. The target is the raw ground point, before the G13 pick.
  - Audio: a pin/throw click, bounce ticks, the boom (reuse the RPG boom pitched up), and a muffled boom for the geyser.

### Trees

- **E13. Sustained fire cuts trees down.** This supersedes the E3 line "small arms never fell trees".
  - Each tree has trunk HP: tree 900, pine 750, dead tree 300.
  - A non-pierce bullet stopped by a trunk applies its dmg. A pierce round passing through applies dmg × 0.5. Explosions add their damage too, with the E2 thresholds still on top.
  - Visuals:
    - Bark chips (E3) grow denser as HP drops.
    - At ≤ 50% HP a pixel **notch** appears on the trunk side facing the dominant shot direction.
  - At 0 HP the tree **topples away from the dominant recent shot direction**, using the E2 topple, E6 falling damage and kill credit, E10 remains and E7 persistence.
  - Rough timings, for reference only: a minigun fells a tree in ~3–5 s of sustained fire, an M16 in ~4 s, and a pistol needs ~9 s.
  - Trunk HP persists with E7.
  - **E13 rulings** (Ralph):
    - E2 doesn't change. Each blast also subtracts **f × the explosion's own damage** from trunk HP: RPG 250, grenade 200, BFG 800. Sources without a round (barrels, bombers, enemy shells) default to ENV_BLAST_DMG 100.
    - **Enemy rounds damage trunks too**, so cover erodes, which is intended. Only falls the player caused credit the player (E6).

### Flamethrower

- **F1. Flamethrower replaces Tesla.**
  - Slot 7 and unlock 25000 don't change. Tesla chain lightning is removed, along with its sound and HUD icon.
  - Stats, which Josh may tune ±20% with evidence:
    - rate 0.05, contact dmg 10 per tick, fuel mag 100, reload 2.0, infinite ammo, range ~260u.
  - The stream:
    - A cone of pixel flame particles (white → yellow → orange → red → smoke bands, J1 palette) with ±0.12 rad spread, that roll and lick and slow down at the end of their range.
    - It doesn't pierce. A trunk stops the stream, and the trunk catches fire (F3).
    - It lights a short-lived ground-fire decal where it lands (scorch afterwards, J2).
  - Heat haze or glow is allowed only if it stays inside the P budget.
- **F2. Burning enemies panic.**
  - A flame hit ignites the enemy: **burn DoT 25 dmg/s for 4 s**, refreshed by further hits. Bosses take the DoT but **don't panic**.
  - Panicking enemies:
    - stop attacking;
    - run erratically, changing direction every 0.3–0.7 s and biased away from the player;
    - flail (a dedicated 2–4 frame animation, with arms up);
    - trail flames and smoke;
    - scream (audio, rate-limited).
  - Touching another enemy for ≥ 0.3 s ignites it with 50% chance (cap: 30 burning at once).
  - Running into water **extinguishes** the burn instantly, with a steam puff.
  - Burn death leaves a **charred black corpse** with smoking pixels and an ash puff, plus less blood (stylistic). The G-series gore stays for other deaths.
  - The player is never ignited in M9.
- **F3. Burning trees.**
  - Flame on a trunk or canopy builds heat. At the threshold (~0.8 s of stream) the tree ignites:
    - canopy flames, embers and smoke for ~6 s;
    - fire spreads to trees within 90u with 35% chance per second (cap: 24 burning trees);
    - when it burns out, it leaves a **charred bare tree** (it becomes a dead-tree type with 300 HP, E13, and can fall).
  - Burning trees damage enemies under the canopy at 10 dmg/s and ignite them (F2).
  - Burnt state persists (E7) and is baked once static.
  - Rain and other weather are out of scope.
- **F4.** Demo bot (D-series): replace the Tesla entry in its weapon table with the flamethrower (preferred range ~180u).
  - D3a still applies, so Anna re-baselines kills only if the weapon pick changes the mean, with evidence.

### Order and acceptance

- Suggested landing order: N1 → E13 → W2 → W3/W4/W5 → F1–F4. Each step is a separate reviewable SHA, or squashed per sub-milestone.
- Acceptance (Anna proposes the exact tests; these are the minimum):
  - **W2:** player and every enemy type in water show ≤ 55% of their drawn body height, and aim at the visible head or torso hits (≥ 95%).
  - **W3/W5:** blood in water creates no decals; after 20 kills in a pond its tiles reach the ≥ 2nd tint band, and after 180 s idle c has halved (±10%).
  - **W4:** a corpse in water is fully gone within 5 s, with no baked remains.
  - **N1:**
    - F throws; ammo 3/6/+1 per wave.
    - The fuse is 1.8 s ± 1 frame at 30, 60 and 144 fps.
    - Damage and falloff match the RPG path.
    - In water: the geyser and radius × 0.7.
  - **E13:**
    - A tree under sustained fire falls within 3–5 s: minigun at ≤ 60u, M16 at ≤ 150u. Longer ranges are recorded, not asserted (spread misses the 16u trunk, which is physically right).
    - It falls away from the shooter (±45°).
    - The notch shows at ≤ 50% HP.
    - Persistence survives a chunk reload.
  - **F1–F3:**
    - Tesla is gone; slot 7 = Flamethrower.
    - Ignite → DoT 25/s; non-boss enemies panic; water extinguishes.
    - A tree ignites after ~0.8 s of stream, spreads, ends charred.
    - The caps hold.
  - **Perf:** a sustained fight with 20 burning enemies, 10 burning trees and a red pond stays within Q2a, with buildMs ≤ 3 and a sustained ratio ≤ 1.15.

---

## M10: Xbox controller support (Josh) *(user request 2026-10-25)*

User: "you can also add xbox joystick controller support".

- Uses the browser **Gamepad API**, `standard` mapping. Xbox One/Series pads are the target, and any pad that reports the standard mapping works the same way.
- Keyboard and mouse stay fully supported. **The last-used device wins.** Moving the mouse past 8 px or pressing a key switches back to mouse aim; a stick or button switches to pad.
- One controller only: the first one connected.
- Gameplay values don't change (Q4), with one exception: the C3 aim assist, which applies only while using the pad.

- **C1. Polling.**
  - Poll `navigator.getGamepads()` once per display frame, before the game update, in the same place keyboard and mouse state is consumed.
  - No per-frame allocations beyond what the browser returns.
  - "Just pressed" is edge-detected per button, so it works the same as `mouseRightJustPressed` and key-down.
- **C2. Mapping (Xbox labels).** All pad indices follow the standard mapping.

  | Input | Action |
  |---|---|
  | Left stick | Move |
  | Right stick | Aim (twin-stick) |
  | RT (analog > 0.3) | Fire |
  | LT (analog > 0.3) | Shockwave (= right click) |
  | LB / RB | Previous / next weapon |
  | D-pad left / right | Previous / next weapon |
  | A | Dodge roll |
  | B | Grenade |
  | X | Reload |
  | Y | Next weapon |
  | L3 (left stick click) | Sprint (toggle while moving, cancelled on stop) |
  | Menu / Start | Pause |

  - Deadzones are radial, 0.20 on both sticks, rescaled to 0..1 beyond the deadzone, so the pad doesn't drift.
  - Analog movement: speed scales with stick magnitude, at full speed from 0.9 upward.
- **C3. Aim.**
  - The right stick sets the aim direction relative to the player. The aim **point** = player + direction × (180u + magnitude × 240u), i.e. 180–420u. Grenades (N1) land there.
  - Releasing the stick (under the deadzone) keeps the last aim direction.
  - With no right-stick input yet, the aim follows the left-stick movement direction.
  - A pixel-art **reticle** (the H-series look) is drawn at the aim point while pad-aiming. The OS cursor is hidden then, and both switch back on a mouse move.
  - G13 picking uses the reticle's screen position the same way it uses the cursor's, so headshots work with a pad.
  - **Aim assist (pad only):**
    - If an enemy's body lies within **±5°** of the aim ray and within 420u, the shot goes at that enemy (G13 aim point).
    - Nearest along the ray wins. Bosses are included.
    - Switchable with `CFG.PAD_AIM_ASSIST` (default on). Off for the demo bot.
- **C4. Rumble.**
  - Uses `vibrationActuator.playEffect('dual-rumble')` where it's supported, and fails silently elsewhere.
  - Effects:
    - each shot: weak motor ∝ weapon kickback, ≤ 60 ms;
    - explosions: strong motor ∝ f for a near blast (J5a-style cap);
    - taking damage: a short strong pulse;
    - a tree falling nearby: a soft rumble.
  - At most one new effect per 50 ms, so it doesn't saturate.
  - `CFG.PAD_RUMBLE` (default on).
- **C5. Menus and attract mode.**
  - Any pad button, or a stick past the deadzone, counts as input for D-series demo stop and idle reset (`demoNoteInput`).
  - A or Start on the title starts the game. Start pauses and resumes.
  - Every menu or overlay that takes a click (game over/restart, pause) is reachable with A, B and Start.
- **C6. Hot-plug.**
  - On connect, show a toast "CONTROLLER CONNECTED" in the H-series pixel font, 2 s.
  - If the pad in use disconnects mid-game, **auto-pause**, showing "CONTROLLER DISCONNECTED – PRESS START OR ANY KEY".
- **C7. Legend.** While a pad is connected, the title screen shows a pad legend using the C2 labels instead of, or next to, the keyboard legend. It must fit at 800×600, like the N1 legend.
- **Acceptance (Anna).**
  - Tests use a **mocked `navigator.getGamepads`** with standard-mapping fake pads: the unit tests drive the mapping, and the e2e tests inject one into the page.
  - Unit:
    - Deadzone and rescale: 0.19 → 0, 0.2 + ε → ~0, 1 → 1, radial not per-axis.
    - Every C2 button produces its action exactly once per press (edge detection).
    - Aim point distance is 180–420u.
    - The aim assist picks the nearest enemy in the ±5° cone and none outside it, and is off for the demo.
    - Device switching (last used wins).
  - e2e:
    - A mocked pad moves the player, aims, fires and kills.
    - B throws a grenade at the reticle.
    - A dodges. Start pauses.
    - A pad button stops the demo.
    - Disconnect auto-pauses.
    - Rumble is called (spy) with capped values, and an absent `vibrationActuator` raises no error.
  - Manual: the user tests with a real Xbox pad. Josh and Anna verify with a real pad if one is available, and say so if not.
- **Order:** after W2. It's independent of W3–W5 and F1–F4, so Josh may interleave it.

## B: Build hygiene

- **B1. Cache busting** (found by Anna, 2026-10-25).
  - game.html's script and style tags carry no version, so a browser can run a **stale mix** of JS files after an update.
    - Python http.server and GitHub Pages (max-age=600) both send cacheable responses.
    - Anna reproduced it: a stale `config.js` meant `CFG.DEMO_IDLE_SECONDS` was undefined, so the demo never started.
  - Fix:
    - Every local `<script src>` and `<link href>` in game.html gets `?v=<BUILD>`.
    - `BUILD` is one constant, bumped by a tiny npm script (`npm run stamp`, which writes the short git SHA or a timestamp into game.html) that runs before a release.
    - Anna's vm loader and the e2e tests must strip the query.
  - Acceptance:
    - After a stamp, every local asset URL in game.html carries the same `?v=`.
    - The unit loader still loads all scripts.
    - A CI check fails if any local script tag lacks `?v=`.

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
- **T12. Environment physics tests (M8).**
  - **Unit:**
    - E0: no trunk on a water tile over 200 seeded chunks.
    - E1: density is +30% ±5% against the old generator for the same seeds.
    - E2 thresholds by distance, via `envState`.
    - E5: a log capsule blocks a moving entity, but not a bullet.
    - E6: enemy 120 / player 40, applied once.
    - E7: destruction survives a chunk unload/reload, and `resetRound` restores it.
    - E8 caps.
  - **E2e:**
    - An RPG next to a tree makes it topple and bake.
    - A BFG in a forest fells multiple trees with no frame over 16.7 ms (soft on SwiftShader).
    - No console errors.
    - G4 decal draws stay ≤ 16 after a forest is destroyed.
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

Order (current): **M7 P1 + W1 → M8 (E0 first, since it's a bug; then E1, E2, E5, E6, E3, E4, E7, E8)**. Earlier milestones are done.
Previous order: **M2 (in progress) → M1 → M6 → M3 → M4 → M5**. T runs in parallel throughout. M6 is mostly a new file (`js/demo.js`), so Josh may give it to a subagent in parallel with M1, as long as he integrates the `main.js` hooks himself to avoid edit collisions.
