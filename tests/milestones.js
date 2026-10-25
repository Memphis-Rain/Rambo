// Which spec milestones have landed in the code under test (docs/SPEC.md).
// Tests for a milestone skip while it's false. Flip it to true when Josh reports
// the milestone: from then on a missing or renamed hook FAILS instead of skipping.
export const LANDED = {
  M1: true, // retro pipeline: RETRO, retroState(), snapToPixel(), F6/F7/F8
  M3: true, // gore: gibs[], SRC_*, DECAL_*, decalVersion, dmgNumbers, addHitStop()
  M6: true, // attract mode: startDemo(), stopDemo(), demoState(), demoAimLead(), CFG.DEMO_*
  G11: true, // bomber chain: leftover pending damage carries over to the next frame
  M5: true, // retro HUD & title: pixel font from assets/fonts, PRESS START gated until ready
  REVIEW1: true, // review must-fixes (spec dfe6194): G9 rate/limits, D6 decal + HUD isolation, G4 draw bound
  G12: true, // swept segment-vs-circle bullet hits for all bullets (spec 545f085)
  G12A: true, // pierce damage per pass = dmg*max(1,round(chord/(speed/60))); G12b barrels on the path; B6 edge oscillation (spec 49f3e2a)
  D3A: true, // demo bot holds strafe >= 0.4 s unless dodging/blocked (spec D3a): reversal metric bar
  P1: true, // M7 P1: no frame-time step-up over time (root cause pending)
  M7: true, // perf hardening P1-P4 (Q2a): sustained frame time, honest perfLog, chunk budget, decal draws in gore
  G2A: true, // knockback cap 900, env collision still resolves after a push (spec 545f085)
  BATCH2: true, // fixes for exploratory bugs B1-B7 on release point 1 (HiDPI, dither, decal cap/growth, shake)
  M8: true, // physical environment E0-E9 (spec 2a33306): no trees in water, blast response, persistence
  E11: true, // rulings on the M8 exploratory findings (spec E11): logs are hurdles, splintering, canopy fade
  M8R: true, // M8 review fixes (enemy log pathing, remains memory, topple starvation, bomber credit)
  G13: true, // head-to-toe hits: aim picking on drawn bodies + body-column hitbox (spec G13)
  // M9 water, fire & grenades (spec c172772): one flag per item.
  N1: true, // grenades on F
  E13: true, // sustained fire cuts trees down (trunk HP)
  W2: true, // wading: submerged sprites, visible-only aim
  W3: true, // blood in water: clouds, no decals; footprints washed by wading
  W4: true, // corpses sink and dissolve in water
  W5: true, // water reddens with blood (waterBloodAt)
  F1: false, // flamethrower replaces Tesla
  F2: false, // burning enemies panic
  F3: false, // burning trees
  F4: false, // demo bot uses the flamethrower
  M9PERF: false,
  M10: true, // Xbox controller (spec a53b301): gamepad polling, aim, assist, rumble, hot-plug
  CACHEBUST: true, // spec B1: ?v=<BUILD> on every local asset in game.html (npm run stamp) // M9 perf scenario (burning enemies/trees + red pond)
  FU1: true, // follow-ups after the first build (spec 1c81384): R4a DITHER_STRENGTH, D4 wave 10, D5 overlay visible
};
