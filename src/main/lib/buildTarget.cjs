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
 *
 * This resolver is deliberately DUMB, and must stay that way: it answers
 * "does a build target config exist for this project?" and nothing else. It
 * does not sniff `pyproject.toml` / `Cargo.toml` / `go.mod` / `Dockerfile`,
 * because (a) that hardcodes an ecosystem list into the main process that will
 * always lag reality, (b) knowing a file exists still yields no publish
 * commands — plenty of local-first projects have a pyproject.toml and never
 * touch PyPI — and (c) it cannot reach the right answer for e.g. a cron-driven
 * daemon whose "release" is bump VERSION, write the changelog, tag, and flag
 * that the live server needs a restart. That requires reading CLAUDE.md and
 * git history and exercising judgment, so discovery lives in the agent: a
 * `null` here means **not configured yet**, and the UI turns it into a
 * "Set Up Build" bootstrap session (`src/renderer/lib/buildAction.ts`) that
 * probes the project and writes the config, rather than a disabled button.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BUILD_TARGET_SUBPATH = ['architecture', 'build-target.json']; // joined under opsOwnership.opsPath

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
 * `null` means "not configured yet", never "this project cannot be built".
 */
function resolveBuildTarget(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;

  const { opsPath } = require('./opsOwnership.cjs');
  const configPath = opsPath(cwd, ...BUILD_TARGET_SUBPATH);
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
