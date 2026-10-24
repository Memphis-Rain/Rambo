import { describe, test, expect, beforeEach } from 'vitest';
import { newRound } from '../helpers/load-game.js';
import { LANDED } from '../milestones.js';

// G7 footprints (regression: the user likes them) and W3 "wading washes the feet".
const DT = 1 / 60;
let g;

/** Rendered terrain at a world point (tiles are drawn from their corner sample). */
const renderedType = (x, y) => {
  const ts = g.CFG.TILE_SIZE;
  return g.getTerrainTypeAt(Math.floor(x / ts) * ts, Math.floor(y / ts) * ts);
};

/** World direction the player walks while holding `key` (measured, not assumed). */
function walkDir(key) {
  const p = g.player, x0 = p.x, y0 = p.y;
  g.keys[key] = true;
  for (let i = 0; i < 5; i++) g.updatePlayer(DT);
  g.keys[key] = false;
  const dx = p.x - x0, dy = p.y - y0, l = Math.hypot(dx, dy);
  p.x = x0; p.y = y0;
  return { x: dx / l, y: dy / l };
}

/** Find a spot with `n` world units of the given terrain kind ahead along `dir`. */
function findStrip(pred, dir, len) {
  for (let r = 0; r < 60000; r += 40) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      let ok = true;
      for (let s = 0; s <= len && ok; s += 10) ok = pred(x + dir.x * s, y + dir.y * s);
      if (ok) return { x, y };
    }
  }
  return null;
}

function stepPlayer(seconds) {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    g.gameTime += DT;
    g.updatePlayer(DT);
  }
}

const footprints = () => g.bloodPools.filter((d) => d.kind === g.DECAL_FOOT);

beforeEach(() => {
  g = newRound().g;
  g.waveActive = false;
  g.waveTimer = 1e9;
  g.envObjects.length = 0;
  g.player.invincible = 1e9;
});

describe('G7 bloody footprints on land (regression)', () => {
  test.skipIf(!LANDED.M3)('G7: walking through a blood pool on land leaves footprints for ~3 s, then they stop', () => {
    const p = g.player;
    const dir = walkDir('d');
    const land = (x, y) => renderedType(x, y) !== 'water';
    const start = findStrip(land, dir, 900);
    expect(start, 'a long land strip').not.toBeNull();
    p.x = start.x; p.y = start.y;
    g.addDecal(g.DECAL_POOL, p.x, p.y, 24, g.BLOOD_COLORS[3], 0, 30);
    expect(g.isBloodAt(p.x, p.y), 'standing in the pool').toBe(true);
    const t0 = g.gameTime;
    g.keys.d = true;
    stepPlayer(5);
    g.keys.d = false;
    const prints = footprints();
    expect(prints.length, 'footprints printed').toBeGreaterThan(3);
    const ages = prints.map((d) => d.createdAt - t0);
    expect(Math.max(...ages), 'footprints stop after ~3 s off the pool').toBeLessThanOrEqual(3.5);
    expect(Math.min(...ages), 'they start right away').toBeLessThan(0.5);
  });
});

describe('W3 wading washes the feet', () => {
  test.skipIf(!LANDED.W3)('W3: footprints never print on water, and leaving water resets bloodyFeet', () => {
    const p = g.player;
    const dir = walkDir('d');
    // land (blood) -> water -> land
    const strip = (x, y) => renderedType(x, y) !== 'water';
    let start = null;
    for (let r = 0; r < 60000 && !start; r += 40) {
      for (let k = 0; k < 16 && !start; k++) {
        const a = (k / 16) * Math.PI * 2, x = Math.cos(a) * r, y = Math.sin(a) * r;
        // 60u of land, then >= 80u of water within the next 300u, then land again
        if (!strip(x, y) || !strip(x + dir.x * 60, y + dir.y * 60)) continue;
        let inWater = 0, back = false;
        for (let s = 70; s < 600; s += 10) {
          const w = !strip(x + dir.x * s, y + dir.y * s);
          if (w) inWater += 10; else if (inWater >= 80) { back = true; break; }
        }
        if (back) start = { x, y };
      }
    }
    expect(start, 'a land -> water -> land path').not.toBeNull();
    p.x = start.x; p.y = start.y;
    g.addDecal(g.DECAL_POOL, p.x, p.y, 24, g.BLOOD_COLORS[3], 0, 30);
    g.keys.d = true;
    let sawWater = false, leftWater = false, feetAfter = null;
    for (let i = 0; i < Math.round(8 / DT) && !leftWater; i++) {
      g.gameTime += DT;
      g.updatePlayer(DT);
      const wet = renderedType(p.x, p.y) === 'water';
      if (wet) sawWater = true;
      else if (sawWater) { leftWater = true; feetAfter = p.bloodyFeet; }
    }
    g.keys.d = false;
    expect(sawWater && leftWater, 'walked through the water').toBe(true);
    expect(feetAfter, 'feet washed on leaving the water').toBeLessThanOrEqual(0);
    const wetPrints = footprints().filter((d) => renderedType(d.x, d.y) === 'water');
    expect(wetPrints, 'no footprints on water tiles').toEqual([]);
  });
});
