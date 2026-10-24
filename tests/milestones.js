// Which spec milestones have landed in the code under test (docs/SPEC.md).
// Tests for a milestone skip while it's false. Flip it to true when Josh reports
// the milestone: from then on a missing or renamed hook FAILS instead of skipping.
export const LANDED = {
  M1: true, // retro pipeline: RETRO, retroState(), snapToPixel(), F6/F7/F8
  M3: true, // gore: gibs[], SRC_*, DECAL_*, decalVersion, dmgNumbers, addHitStop()
  M6: true, // attract mode: startDemo(), stopDemo(), demoState(), demoAimLead(), CFG.DEMO_*
  G11: true, // bomber chain: leftover pending damage carries over to the next frame
};
