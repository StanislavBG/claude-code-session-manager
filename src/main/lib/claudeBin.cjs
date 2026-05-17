/**
 * claudeBin.cjs — shared resolver for the `claude` executable.
 *
 * Both scheduler.cjs and supervisor.cjs need to spawn `claude -p` jobs.
 * Both used to duplicate this list. Single source of truth here.
 *
 * Returns the first executable candidate found, falling back to bare
 * "claude" so spawn() can still try PATH lookup.
 *
 * Cached after first successful resolution. Process-lifetime.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let cached = null;

function resolveClaudeBin() {
  if (cached) return cached;
  // Merged candidate list — was forked in scheduler vs pluginInstall before.
  const home = os.homedir();
  const candidates = [
    path.join(home, '.claude', 'local', 'claude'),    // Claude Code bundled install
    path.join(home, '.local', 'bin', 'claude'),       // user pip-style install
    path.join(home, '.npm-global', 'bin', 'claude'),  // user npm-global
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); cached = c; return c; } catch { /* */ }
  }
  cached = 'claude';
  return cached;
}

module.exports = { resolveClaudeBin };
