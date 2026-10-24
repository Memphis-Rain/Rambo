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
  B6M: false, // B6 edge-oscillation metric thresholds: pending Ralph's decision (combat strafing trips the strict bar)
  G2A: true, // knockback cap 900, env collision still resolves after a push (spec 545f085)
  BATCH2: true, // fixes for exploratory bugs B1-B7 on release point 1 (HiDPI, dither, decal cap/growth, shake)
  FU1: true, // follow-ups after the first build (spec 1c81384): R4a DITHER_STRENGTH, D4 wave 10, D5 overlay visible
};
