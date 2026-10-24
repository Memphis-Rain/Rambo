import { describe, test, expect } from 'vitest';
import { loadGame } from '../helpers/load-game.js';
import { LANDED } from '../milestones.js';

// M6 / D8: demoAimLead(sx, sy, tx, ty, tvx, tvy, bulletSpeed) -> {x, y}, the world aim point.
// Skipped until M6 is marked landed in tests/milestones.js.
const todo = !LANDED.M6;
const { g } = loadGame();

// Where the target is when a bullet fired now at the aim point would reach it.
function missDistance(s, t, v, speed, aim) {
  const dx = aim.x - s.x, dy = aim.y - s.y;
  const len = Math.hypot(dx, dy);
  const bvx = (dx / len) * speed, bvy = (dy / len) * speed;
  // Closest approach between bullet and target over time.
  const rx = t.x - s.x, ry = t.y - s.y, wx = v.x - bvx, wy = v.y - bvy;
  const tt = Math.max(0, -(rx * wx + ry * wy) / (wx * wx + wy * wy || 1));
  return Math.hypot(rx + wx * tt, ry + wy * tt);
}

describe('T11 demo aim lead (D3/D8)', () => {
  test.skipIf(todo)('D8: a stationary target is aimed at directly', () => {
    const a = g.demoAimLead(0, 0, 300, 120, 0, 0, 900);
    expect(a.x).toBeCloseTo(300, 6);
    expect(a.y).toBeCloseTo(120, 6);
  });

  test.skipIf(todo)('D3: the aim point leads a moving target so the bullet intercepts it', () => {
    const rand = g.seededRand(5);
    for (let i = 0; i < 200; i++) {
      const s = { x: (rand() - 0.5) * 400, y: (rand() - 0.5) * 400 };
      const t = { x: s.x + (rand() - 0.5) * 1200, y: s.y + (rand() - 0.5) * 1200 };
      const v = { x: (rand() - 0.5) * 260, y: (rand() - 0.5) * 260 }; // up to Runner speed
      const speed = 650 + rand() * 1000; // Shotgun to Plasma
      const aim = g.demoAimLead(s.x, s.y, t.x, t.y, v.x, v.y, speed);
      expect(Number.isFinite(aim.x) && Number.isFinite(aim.y)).toBe(true);
      expect(missDistance(s, t, v, speed, aim)).toBeLessThan(1);
    }
  });

  test.skipIf(todo)('D3: the lead is ahead of the target along its velocity', () => {
    const a = g.demoAimLead(0, 0, 400, 0, 0, 100, 800);
    expect(a.y).toBeGreaterThan(0);
    expect(a.x).toBeGreaterThan(390);
  });

  test.skipIf(todo)('D8: with no intercept solution it returns the target position', () => {
    // Target running straight away faster than the bullet.
    const a = g.demoAimLead(0, 0, 100, 0, 500, 0, 300);
    expect(a.x).toBeCloseTo(100, 6);
    expect(a.y).toBeCloseTo(0, 6);
  });

  test.skipIf(todo)('D8: demoAimLead is pure (same inputs, same output, no state touched)', () => {
    const before = JSON.stringify({ x: g.player && g.player.x, rnd: g.seededRand(1)() });
    const a = g.demoAimLead(10, 20, 300, 400, -50, 30, 900);
    const b = g.demoAimLead(10, 20, 300, 400, -50, 30, 900);
    expect(a).toEqual(b);
    expect(JSON.stringify({ x: g.player && g.player.x, rnd: g.seededRand(1)() })).toBe(before);
  });

  test.skipIf(todo)('D8: demo CFG knobs have their specced defaults', () => {
    expect(g.CFG.DEMO_IDLE_SECONDS).toBe(5);
    expect(g.CFG.DEMO_MAX_SECONDS).toBe(60);
  });
});
