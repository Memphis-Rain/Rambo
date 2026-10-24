import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { ROOT, gameHtmlScripts, loadGame } from '../helpers/load-game.js';

const hasRetro = fs.existsSync(path.join(ROOT, 'js/retro.js'));

describe('Q3 scripts', () => {
  test('Q3: every script game.html loads exists', () => {
    const scripts = gameHtmlScripts();
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) expect(fs.existsSync(path.join(ROOT, src)), src).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'lib/pixi.min.js'))).toBe(true);
  });

  // Catches cross-file problems node --check can't: duplicate top-level
  // let/const across files, and code that runs at load time and throws.
  test('Q3: all game.html scripts evaluate together in one global scope', () => {
    const { g } = loadGame({ files: gameHtmlScripts() });
    expect(typeof g.startGame).toBe('function');
    expect(typeof g.update).toBe('function');
    expect(typeof g.createPlayer).toBe('function');
  });
});

describe('T3 retro (M1)', () => {
  test.skipIf(!hasRetro)('R1: RETRO defaults', () => {
    const { g } = loadGame({ files: gameHtmlScripts() });
    expect(g.RETRO).toMatchObject({ PIXEL_SCALE: 3, DITHER: true, CRT: true, LEVELS: 6 });
  });

  test.skipIf(!hasRetro)('R1: retro.js loads right after state.js', () => {
    const scripts = gameHtmlScripts();
    expect(scripts.indexOf('js/retro.js')).toBe(scripts.indexOf('js/state.js') + 1);
  });

  // Needs the snap helper's name from Josh once M1 lands.
  test.todo('R2: pixel-grid camera snaps the world offset to whole low-res pixels');
});
