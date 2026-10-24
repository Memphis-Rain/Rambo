import fs from 'node:fs';
import path from 'node:path';
import js from '@eslint/js';
import globals from 'globals';
import * as espree from 'espree';

// The game is classic <script> files sharing one global scope. Each file's
// top-level declarations are globals for every *other* file. They're derived
// from the source, so new globals need no config change.
// Resolved from this file so lint works from any working directory.
const ROOT = import.meta.dirname;
const GAME_DIR = 'js';
// Legacy Canvas2D renderer: game.html doesn't load it.
const UNLOADED = ['js/renderer.js'];

const gameFiles = fs.readdirSync(path.join(ROOT, GAME_DIR))
  .filter((f) => f.endsWith('.js'))
  .map((f) => `${GAME_DIR}/${f}`)
  .filter((f) => !UNLOADED.includes(f));

function topLevelDeclarations(file) {
  const ast = espree.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'), {
    ecmaVersion: 'latest',
    sourceType: 'script',
  });
  const decls = {};
  for (const node of ast.body) {
    if (node.type === 'VariableDeclaration') {
      // const bindings can't be reassigned from other files; let/var can.
      const access = node.kind === 'const' ? 'readonly' : 'writable';
      for (const d of node.declarations) {
        if (d.id.type === 'Identifier') decls[d.id.name] = access;
      }
    } else if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) {
      decls[node.id.name] = 'readonly';
    }
  }
  return decls;
}

const declsByFile = Object.fromEntries(gameFiles.map((f) => [f, topLevelDeclarations(f)]));

function globalsFromOtherFiles(file) {
  const out = {};
  for (const [other, decls] of Object.entries(declsByFile)) {
    if (other !== file) Object.assign(out, decls);
  }
  // Don't redeclare the file's own bindings as globals.
  for (const name of Object.keys(declsByFile[file])) delete out[name];
  return out;
}

// Lint for real bugs only; style is not enforced.
const bugRules = {
  'no-unused-vars': ['warn', { vars: 'local', args: 'none', caughtErrors: 'none' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
};

// basePath anchors every files/ignores pattern to this directory, even when
// ESLint runs from elsewhere with -c.
export default [
  {
    ignores: ['worktrees/**', '.scratch/**', 'node_modules/', 'lib/', 'test-results/', 'playwright-report/', 'dist/', ...UNLOADED],
  },
  js.configs.recommended,
  ...gameFiles.map((file) => ({
    files: [file],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.browser,
        PIXI: 'readonly',
        ...globalsFromOtherFiles(file),
      },
    },
    rules: bugRules,
  })),
  {
    files: ['tests/**/*.{js,mjs}', '*.config.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: bugRules,
  },
  {
    // page.evaluate() callbacks run in the browser against the game's globals.
    files: ['tests/e2e/**/*.js', 'tests/perf/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.browser,
        PIXI: 'readonly',
        ...Object.assign({}, ...Object.values(declsByFile)),
        // Test hooks promised by the spec and Josh (R2, R7, G4, G5, G8, G9, D8).
        // Tests skip until they exist; drop entries once the game defines them.
        ...Object.fromEntries([
          'RETRO', 'retroState', 'snapToPixel',
          'gibs', 'SRC_EXPLOSIVE', 'SRC_BFG', 'SRC_RAIL',
          'decalVersion', 'DECAL_POOL', 'DECAL_SPLAT', 'DECAL_SCORCH', 'DECAL_FOOT', 'DECAL_SMEAR', 'DECAL_GIB', 'DECAL_ASH',
          'dmgNumbers', 'DMG_NORMAL', 'DMG_CRIT', 'DMG_SHIELD',
          'hitStopTimer', 'addHitStop',
          'startDemo', 'stopDemo', 'demoState', 'demoAimLead', 'decalStats',
        ].map((name) => [name, 'readonly'])),
      },
    },
    rules: {
      // Playwright fixtures that use no other fixtures must be written `async ({}, use)`.
      'no-empty-pattern': 'off',
    },
  },
].map((config) => ({ basePath: ROOT, ...config }));
