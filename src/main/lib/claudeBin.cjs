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
  const candidates = [
    path.join(os.homedir(), '.claude', 'local', 'claude'),
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
