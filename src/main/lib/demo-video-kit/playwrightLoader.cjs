'use strict';
// Demo-video kit Playwright loader, shared by capture.cjs and frames.cjs. Copied standalone into
// ~/.claude/session-manager/demo-video-kit/, so Node builtins only. Resolution order: cwd, the
// global npm root, then every <home>/.npm/_npx/<hash>/node_modules/playwright (newest
// package.json mtime first). Never installs, never throws; returns the module or null.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const NAMES = ['playwright', 'playwright-core'];
const MAX_NPX_ENTRIES = 50;

function tryRequire(name, paths) {
  try { return require(require.resolve(name, { paths })); } catch { return null; }
}

function globalNpmRoot() {
  try {
    const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 15000 });
    return r.status === 0 ? String(r.stdout).trim() : '';
  } catch { return ''; }
}

function fromRoot(root) {
  if (!root) return null;
  for (const name of NAMES) {
    const m = tryRequire(name, [root]);
    if (m) return m;
  }
  return null;
}

/** npx cache playwright dirs, newest package.json mtime first. */
function npxCandidates(home) {
  if (!home) return [];
  const npxDir = path.join(home, '.npm', '_npx');
  let entries;
  try { entries = fs.readdirSync(npxDir).slice(0, MAX_NPX_ENTRIES); } catch { return []; }
  const found = [];
  for (const hash of entries) {
    for (const name of NAMES) {
      const dir = path.join(npxDir, hash, 'node_modules', name);
      try {
        found.push({ dir, mtime: fs.statSync(path.join(dir, 'package.json')).mtimeMs });
      } catch { /* not here */ }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((c) => c.dir);
}

function loadPlaywright({ home, cwd, npmRoot } = {}) {
  try {
    const m = fromRoot(cwd || process.cwd());
    if (m) return m;
    const g = fromRoot(npmRoot === undefined ? globalNpmRoot() : npmRoot);
    if (g) return g;
    let h = home;
    if (h === undefined) { try { h = os.homedir(); } catch { h = ''; } }
    for (const dir of npxCandidates(h)) {
      try { return require(dir); } catch { /* broken copy; try the next */ }
    }
  } catch { /* never throw */ }
  return null;
}

module.exports = { loadPlaywright };
