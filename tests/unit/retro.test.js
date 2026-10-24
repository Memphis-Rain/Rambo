import { describe, test, expect } from 'vitest';
import { gameHtmlScripts, loadGame } from '../helpers/load-game.js';
import { LANDED } from '../milestones.js';

// M1 hooks (js/retro.js). Skipped until M1 is marked landed in tests/milestones.js.
const { g } = loadGame();
const todo = !LANDED.M1;

describe('T3 retro (M1)', () => {
  test.skipIf(todo)('R1: RETRO defaults', () => {
    expect(g.RETRO).toMatchObject({ PIXEL_SCALE: 3, DITHER: true, CRT: true, LEVELS: 6 });
  });

  test.skipIf(todo)('R1: retro.js loads right after state.js', () => {
    const scripts = gameHtmlScripts();
    expect(scripts.indexOf('js/retro.js')).toBe(scripts.indexOf('js/state.js') + 1);
  });

  test.skipIf(todo)('R3: CFG.UNCAPPED_FPS is off', () => {
    expect(g.CFG.UNCAPPED_FPS).toBe(false);
  });

  test.skipIf(todo)('R2: snapToPixel rounds to the nearest multiple of scale', () => {
    expect(g.snapToPixel(0, 3)).toBe(0);
    expect(g.snapToPixel(4, 3)).toBe(3);
    expect(g.snapToPixel(5, 3)).toBe(6);
    expect(g.snapToPixel(-4, 3)).toBe(-3);
    expect(g.snapToPixel(640.4, 1)).toBe(640);
    expect(g.snapToPixel(7.9, 4)).toBe(8);
  });

  test.skipIf(todo)('R2: snapToPixel is idempotent and within half a low-res pixel', () => {
    const rand = g.seededRand(99);
    for (const scale of [1, 2, 3, 4]) {
      for (let i = 0; i < 200; i++) {
        const v = (rand() - 0.5) * 5000;
        const s = g.snapToPixel(v, scale);
        expect(Math.abs(Math.round(s / scale) - s / scale)).toBeLessThan(1e-9);
        expect(Math.abs(s - v)).toBeLessThanOrEqual(scale / 2 + 1e-9);
        expect(g.snapToPixel(s, scale)).toBeCloseTo(s, 9);
      }
    }
  });
});
