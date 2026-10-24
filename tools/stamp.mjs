// B1 cache busting: stamp every local asset URL in game.html with ?v=<BUILD>.
//
//   node tools/stamp.mjs            BUILD = short git SHA (timestamp if no git)
//   node tools/stamp.mjs <build>    explicit BUILD
//   node tools/stamp.mjs --check    exit 1 unless every local <script src>,
//                                   <link href> and CSS url() carries exactly
//                                   one v= equal to <meta name="build"> (CI)
//
// Local = not http(s):, protocol-relative, data: or #. The meta tag is the
// one BUILD constant; the page can read it at runtime.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'game.html');
// <script ... src="..."> / <link ... href="..."> (not data-src/data-href) and url( '...' )
const ASSET = /(<script\b[^>]*[\s"']src=|<link\b[^>]*[\s"']href=)(["'])([^"']+)\2|(url\(\s*)(['"]?)([^'")\s]+)\5(\s*\))/g;
const META = /<meta name="build" content="([^"]*)">/;

const isLocal = (u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u);
const out = (s) => process.stdout.write(s + '\n');

// Drop any v= query param and append v=<build>, keeping other params and
// putting the query before the #fragment
function withBuild(u, build) {
  const h = u.indexOf('#');
  const hash = h >= 0 ? u.slice(h) : '';
  const rest = h >= 0 ? u.slice(0, h) : u;
  const q = rest.indexOf('?');
  const base = q >= 0 ? rest.slice(0, q) : rest;
  const params = q >= 0 ? rest.slice(q + 1).split(/[?&]/).filter((kv) => kv && !/^v(=|$)/.test(kv)) : [];
  params.push(`v=${build}`);
  return `${base}?${params.join('&')}${hash}`;
}

function localAssets(html) {
  const list = [];
  for (const m of html.matchAll(ASSET)) {
    const url = m[3] !== undefined ? m[3] : m[6];
    if (isLocal(url)) list.push(url);
  }
  return list;
}

const html = fs.readFileSync(FILE, 'utf8');

if (process.argv[2] === '--check') {
  const meta = html.match(META);
  const build = meta ? meta[1] : null;
  const assets = localAssets(html);
  const bad = assets.filter((u) => !build || u !== withBuild(u, build));
  if (!build) out('game.html: no <meta name="build" content="..."> constant');
  for (const u of bad) out(`game.html: ${u} is not stamped ?v=${build}`);
  const ok = build && !bad.length;
  out(ok ? `stamp check ok: ${assets.length} assets at ?v=${build}` : 'stamp check FAILED');
  process.exit(ok ? 0 : 1);
}

let build = process.argv[2];
if (!build) {
  try { build = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); }
  catch { build = Date.now().toString(36); }
}
if (!/^[\w.-]+$/.test(build)) { out(`bad build id: ${build}`); process.exit(1); }

let next = html.replace(ASSET, (all, tag, q, url, fn, q2, curl, close) => {
  if (tag) return isLocal(url) ? `${tag}${q}${withBuild(url, build)}${q}` : all;
  return isLocal(curl) ? `${fn}${q2}${withBuild(curl, build)}${q2}${close}` : all;
});
const eol = /\r\n/.test(html) ? '\r\n' : '\n'; // keep the file's line endings
next = META.test(next)
  ? next.replace(META, `<meta name="build" content="${build}">`)
  : next.replace(/<meta charset="[^"]*">/i, (m) => `${m}${eol}<meta name="build" content="${build}">`);
if (!META.test(next)) { out('game.html: could not place <meta name="build">'); process.exit(1); }
fs.writeFileSync(FILE, next);
out(`stamped ${localAssets(next).length} assets in game.html with ?v=${build}`);
