import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const ROOT = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
// Other agents' git worktrees can live under <root>/worktrees/. Anchor the path:
// this checkout may itself sit inside another repo's worktrees/ folder.
const NESTED_WORKTREES = `${ROOT}/worktrees/`;

// The game is plain <script> files sharing one global scope, so Vite's module
// graph never sees js/*.js. This plugin forces a full page reload when they change.
function classicScriptReload() {
  return {
    name: 'classic-script-reload',
    configureServer(server) {
      server.watcher.on('change', (file) => {
        const f = file.replace(/\\/g, '/');
        if (!f.startsWith(NESTED_WORKTREES) && /\/(js|lib)\/[^/]+\.js$/.test(f)) {
          server.ws.send({ type: 'full-reload', path: '*' });
        }
      });
    },
  };
}

// lib/pixi.min.js references a source map that isn't vendored. Drop the comment
// so the dev server doesn't log ENOENT on every page load.
function vendoredWithoutSourcemap() {
  return {
    name: 'vendored-without-sourcemap',
    load(id) {
      const file = id.split('?')[0];
      if (!/[\\/]lib[\\/][^\\/]+\.js$/.test(file)) return null;
      return fs.readFileSync(file, 'utf8').replace(/^\/\/# sourceMappingURL=.*$/m, '');
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: false,
  plugins: [classicScriptReload(), vendoredWithoutSourcemap()],
  server: {
    port: 5173,
    strictPort: true,
    open: process.env.CI ? false : '/game.html',
    watch: { ignored: [`${NESTED_WORKTREES}**`] },
  },
});
