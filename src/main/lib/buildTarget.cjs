/**
 * buildTarget.cjs — resolves a project's publish destination for
 * 'build'-tagged Epics.
 *
 * Reads `<cwd>/session-manager-operations/architecture/build-target.json`
 * when present (a skill-authored doc, not an OWNERS-governed runtime-write
 * namespace — see this repo's CLAUDE.md). Falls back to auto-discovery from
 * `<cwd>/package.json` when no explicit config exists. Pure local-file read;
 * no npm-registry network call here. `cwd` is not validated against
 * `config.cjs`'s `validatePath` allowedRoots — callers must pass a trusted
 * TAB cwd (the same invariant `prdLocations.cjs` relies on), not a raw
 * renderer-supplied string.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BUILD_TARGET_SUBPATH = ['session-manager-operations', 'architecture', 'build-target.json'];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * resolveBuildTarget(cwd) → the project's build target config, or null if
 * neither an explicit config nor an auto-discoverable package.json exists.
 */
function resolveBuildTarget(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;

  const configPath = path.join(cwd, ...BUILD_TARGET_SUBPATH);
  const explicit = readJson(configPath);
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit) && typeof explicit.packageName === 'string') {
    return explicit;
  }

  const pkg = readJson(path.join(cwd, 'package.json'));
  if (pkg && typeof pkg.name === 'string' && pkg.name.length > 0 && pkg.private !== true) {
    return {
      registry: 'npm',
      packageName: pkg.name,
      versionBumpPolicy: 'conventional-commits',
      gates: [],
      discovered: true,
    };
  }

  return null;
}

module.exports = { resolveBuildTarget };
