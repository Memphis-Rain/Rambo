import { describe, test, expect } from 'vitest';
import { loadGame } from '../helpers/load-game.js';

const { g } = loadGame({ files: ['js/config.js', 'js/utils.js'] });

describe('T3 utils.js', () => {
  test('T3: toScreen/toWorld round-trip', () => {
    const rand = g.seededRand(42);
    for (let i = 0; i < 500; i++) {
      const wx = (rand() - 0.5) * 20000;
      const wy = (rand() - 0.5) * 20000;
      const s = g.toScreen(wx, wy);
      const w = g.toWorld(s.x, s.y);
      expect(w.x).toBeCloseTo(wx, 6);
      expect(w.y).toBeCloseTo(wy, 6);
    }
  });

  test('T3: toScreen is the isometric projection (x = wx-wy, y = (wx+wy)*ISO_SCALE)', () => {
    expect(g.toScreen(0, 0)).toEqual({ x: 0, y: 0 });
    const s = g.toScreen(100, 40);
    expect(s.x).toBeCloseTo(60);
    expect(s.y).toBeCloseTo(140 * g.CFG.ISO_SCALE);
  });

  test('T3: clamp', () => {
    expect(g.clamp(5, 0, 10)).toBe(5);
    expect(g.clamp(-1, 0, 10)).toBe(0);
    expect(g.clamp(11, 0, 10)).toBe(10);
    expect(g.clamp(0, 0, 10)).toBe(0);
    expect(g.clamp(10, 0, 10)).toBe(10);
  });

  test('T3: lerp', () => {
    expect(g.lerp(0, 10, 0)).toBe(0);
    expect(g.lerp(0, 10, 1)).toBe(10);
    expect(g.lerp(0, 10, 0.5)).toBe(5);
    expect(g.lerp(-4, 4, 0.25)).toBe(-2);
  });

  test('T3: dist and angle', () => {
    expect(g.dist(0, 0, 3, 4)).toBe(5);
    expect(g.angle(0, 0, 0, 1)).toBeCloseTo(Math.PI / 2);
    expect(g.angle(0, 0, -1, 0)).toBeCloseTo(Math.PI);
  });

  test('T3: randInt stays within inclusive bounds and hits both ends', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const v = g.randInt(2, 5);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(5);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([2, 3, 4, 5]);
  });

  test('T3: seededRand is deterministic per seed and in [0, 1)', () => {
    const a = g.seededRand(1234);
    const b = g.seededRand(1234);
    const c = g.seededRand(4321);
    const seqA = Array.from({ length: 100 }, a);
    const seqB = Array.from({ length: 100 }, b);
    const seqC = Array.from({ length: 100 }, c);
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test('T3: noise2D is deterministic within a session', () => {
    for (let i = 0; i < 50; i++) {
      const x = i * 0.37 - 5, y = i * 0.91 + 3;
      expect(g.noise2D(x, y)).toBe(g.noise2D(x, y));
    }
  });

  test('T3: noise2D is reproducible for the same Math.random seed', () => {
    // The permutation table is shuffled with Math.random at load time.
    const a = loadGame({ files: ['js/config.js', 'js/utils.js'], seed: 7 }).g;
    const b = loadGame({ files: ['js/config.js', 'js/utils.js'], seed: 7 }).g;
    const c = loadGame({ files: ['js/config.js', 'js/utils.js'], seed: 8 }).g;
    const pts = Array.from({ length: 40 }, (_, i) => [i * 1.3 + 0.2, i * 0.7 + 0.5]);
    const na = pts.map(([x, y]) => a.noise2D(x, y));
    expect(pts.map(([x, y]) => b.noise2D(x, y))).toEqual(na);
    expect(pts.map(([x, y]) => c.noise2D(x, y))).not.toEqual(na);
  });

  test('T3: noise2D range is bounded and zero on lattice points', () => {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < 20000; i++) {
      const n = g.noise2D(i * 0.173, i * 0.0619);
      min = Math.min(min, n);
      max = Math.max(max, n);
    }
    expect(min).toBeGreaterThanOrEqual(-1);
    expect(max).toBeLessThanOrEqual(1);
    expect(max - min).toBeGreaterThan(0.5); // not degenerate
    expect(g.noise2D(3, 7)).toBe(0);
  });

  test('T3: fbm is deterministic and bounded', () => {
    expect(g.fbm(1.5, 2.5, 3)).toBe(g.fbm(1.5, 2.5, 3));
    for (let i = 0; i < 2000; i++) {
      expect(Math.abs(g.fbm(i * 0.11, i * 0.07, 4))).toBeLessThanOrEqual(1);
    }
  });

  test('T3: darkenColor scales #rgb shorthand', () => {
    expect(g.darkenColor('#fff', 0.5)).toBe('rgb(127,127,127)');
    expect(g.darkenColor('#f00', 1)).toBe('rgb(255,0,0)');
    expect(g.darkenColor('red', 0.5)).toBe('red');
  });
});
