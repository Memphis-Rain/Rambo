import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { ROOT, gameHtmlScripts, loadGame } from '../helpers/load-game.js';
import { LANDED } from '../milestones.js';


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

describe('H1 font assets', () => {
  test.skipIf(!LANDED.M5)('H1: Press Start 2P and its OFL license are bundled under assets/fonts', () => {
    const dir = path.join(ROOT, 'assets/fonts');
    const files = fs.readdirSync(dir);
    expect(files.some((f) => /^PressStart2P.*\.(ttf|woff2?|otf)$/i.test(f))).toBe(true);
    const license = files.find((f) => /^OFL/i.test(f));
    expect(license).toBeTruthy();
    expect(fs.readFileSync(path.join(dir, license), 'utf8')).toMatch(/SIL OPEN FONT LICENSE/i);
  });

  test.skipIf(!LANDED.M5)('H1: game.html references no CDN', () => {
    const html = fs.readFileSync(path.join(ROOT, 'game.html'), 'utf8');
    expect(html).not.toMatch(/(src|href)=["']https?:\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?https?:\/\//i);
  });
});

describe('W1 water camo', () => {
  test.skipIf(!LANDED.P1)('W1: CFG.WATER_CAMO_ALPHA_SCALE is a positive number and the water overlay uses it', () => {
    const { g } = loadGame({ files: ['js/config.js'] });
    expect(Number.isFinite(g.CFG.WATER_CAMO_ALPHA_SCALE)).toBe(true);
    expect(g.CFG.WATER_CAMO_ALPHA_SCALE).toBeGreaterThan(0);
    const users = fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js') && f !== 'config.js')
      .filter((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8').includes('CFG.WATER_CAMO_ALPHA_SCALE'));
    expect(users.length, 'referenced outside config.js').toBeGreaterThan(0);
  });
});
