/**
 * The Node.js floor this package runs on, read from package.json `engines.node` so there is
 * one source of truth.
 *
 * bin/cli.cjs uses it to tell an old Node apart from a failed Electron download. Electron 42
 * downloads its binary lazily on the first `require('electron')`, through `@electron/get` 5,
 * which is an ES module. Below Node 22.12 that `require()` dies with ERR_REQUIRE_ESM, and the
 * launcher would otherwise blame the network.
 *
 * Plain ES2015 syntax on purpose: this has to parse on the old Node it is diagnosing.
 */
'use strict';

/** `">=22.12.0"` / `">= 22.12"` -> `[22, 12, 0]`; anything else -> null (no diagnosis). */
function parseFloor(range) {
  const m = /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(String(range == null ? '' : range));
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}

/** True when `version` (e.g. process.versions.node, `"18.20.4"`) is older than `floor`. */
function isBelow(version, floor) {
  const parts = String(version).replace(/^v/, '').split('.');
  for (let i = 0; i < 3; i++) {
    const n = parseInt(parts[i], 10) || 0;
    if (n !== floor[i]) return n < floor[i];
  }
  return false;
}

/** This package's own floor, or null if package.json can't be read or the range isn't `>=x.y.z`. */
function nodeFloor() {
  try {
    const engines = require('../package.json').engines;
    return parseFloor(engines && engines.node);
  } catch (_err) {
    return null;
  }
}

module.exports = { parseFloor, isBelow, nodeFloor };
