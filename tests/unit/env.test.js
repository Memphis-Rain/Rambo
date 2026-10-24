import { describe, test, expect } from 'vitest';
import { loadGame } from '../helpers/load-game.js';
import { LANDED } from '../milestones.js';

// T12 / M8 physical environment (spec 2a33306). Skipped until M8 is marked landed.
const todo = !LANDED.M8;

const TRUNKED = new Set(['tree', 'pine', 'deadtree', 'bush', 'boulder']);

/** Load the game and generate `n` chunks headless (render calls hit the PIXI stub). */
function generateWorld({ seed = 1, n = 200 } = {}) {
  const game = loadGame({ seed });
  const { g } = game;
  // Rendering targets are unset without initPixiApp(); point them at the PIXI stub.
  for (const k of ['app', 'renderer', 'stage', 'worldContainer', 'terrainContainer', 'effectsContainer', 'uiContainer']) g[k] = g.PIXI;
  g.W = 1280; g.H = 720;
  g.player = g.createPlayer();
  const side = Math.ceil(Math.sqrt(n));
  const chunks = [];
  for (let i = 0; i < n; i++) chunks.push([(i % side) - (side >> 1), Math.floor(i / side) - (side >> 1)]);
  for (const [cx, cy] of chunks) g.generatePixiChunk(cx, cy);
  return game;
}

/** Terrain type as rendered: each tile is drawn from the sample at its corner. */
function renderedType(g, x, y) {
  const ts = g.CFG.TILE_SIZE;
  return g.getTerrainTypeAt(Math.floor(x / ts) * ts, Math.floor(y / ts) * ts);
}

describe('E0 no trees in water', () => {
  test.skipIf(todo)('E0: no tree, pine, dead tree, bush or boulder stands on a rendered water tile (200 chunks)', () => {
    const { g } = generateWorld({ n: 200 });
    const objs = g.envObjects.filter((o) => TRUNKED.has(o.type));
    expect(objs.length, 'objects generated').toBeGreaterThan(1000);
    // The world must actually contain water for the check to mean anything.
    let waterTiles = 0;
    const ts = g.CFG.TILE_SIZE, sz = g.CFG.CHUNK_SIZE;
    for (let x = -8 * sz; x < 8 * sz; x++) for (let y = -8 * sz; y < 8 * sz; y++) if (g.getTerrainTypeAt(x * ts, y * ts) === 'water') waterTiles++;
    expect(waterTiles, 'water tiles in the sampled world').toBeGreaterThan(50);
    const wet = objs.filter((o) => renderedType(g, o.x, o.y) === 'water')
      .map((o) => ({ type: o.type, x: Math.round(o.x), y: Math.round(o.y), unsnapped: g.getTerrainTypeAt(o.x, o.y) }));
    expect(wet, `${wet.length} of ${objs.length} trunks on rendered water`).toEqual([]);
  });
});
