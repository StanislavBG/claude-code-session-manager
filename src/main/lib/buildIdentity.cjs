'use strict';

/**
 * buildIdentity.cjs — answers "which code produced this run" for both a
 * published npx install (no .git shipped) and a dev checkout / job worktree
 * (a real .git, but never the source of truth once a build has been baked).
 *
 * Resolution order, memoized after first call:
 *   1. src/main/build-info.json (written by scripts/write-build-info.cjs at
 *      `prepack`/`prepublishOnly` time, from the PUBLISHING checkout) — the
 *      only artifact that is honest in production, since the npx cache the
 *      app actually runs from ships no .git directory at all.
 *   2. `git rev-parse` against the package root, but ONLY when a .git
 *      directory exists AT that exact root — never git's own upward walk.
 *      Without this guard, a relocated/nested install whose npm cache
 *      happens to sit under an ancestor .git would silently stamp a FOREIGN
 *      sha (git -C only sets the starting point; it still searches upward
 *      for the nearest .git by default). Checking existence at the package
 *      root ourselves, and only then invoking git, means the first (and
 *      only) .git git can find IS the one we already verified.
 *   3. null.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveInstallChannel } = require('./machineProfile.cjs');

// src/main/lib -> src/main -> src -> package root (repo root in dev, or the
// npx-cached package dir in production).
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');

function loadBuildInfoJson(packageRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(packageRoot, 'src', 'main', 'build-info.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function resolvePackageVersion(packageRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function resolveGitCodeSha(packageRoot) {
  if (!fs.existsSync(path.join(packageRoot, '.git'))) return null;
  try {
    return execFileSync('git', ['-C', packageRoot, 'rev-parse', '--short', 'HEAD'], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function computeBuildIdentity(packageRoot) {
  const buildInfo = loadBuildInfoJson(packageRoot);
  const version = (buildInfo && typeof buildInfo.version === 'string') ? buildInfo.version : resolvePackageVersion(packageRoot);
  const codeSha = buildInfo
    ? ((typeof buildInfo.gitShortSha === 'string') ? buildInfo.gitShortSha : null)
    : resolveGitCodeSha(packageRoot);
  const builtAt = (buildInfo && typeof buildInfo.builtAt === 'string') ? buildInfo.builtAt : null;
  return {
    version,
    codeSha,
    builtAt,
    appPath: packageRoot,
    installChannel: resolveInstallChannel({ appPath: packageRoot, devFlag: !!process.env.SM_DEV }),
  };
}

// Keyed by resolved root: a real process only ever resolves ONE root (this
// module's own package root), so in production/dev this behaves as a plain
// singleton memo — the Map only grows past size 1 under test, where each
// case injects a distinct fixture packageRoot.
const identityCache = new Map();

/**
 * @param {object} [opts]
 * @param {string|null} [opts.bootedAt] - the caller's OWN already-captured
 *   process-boot timestamp (e.g. scheduler.cjs's SCHEDULER_BOOTED_AT). Never
 *   re-captured here — a memoized resolver that stamped its own "now" would
 *   drift from what SCHEDULER_BOOTED_AT was introduced to expose (PRD 812:
 *   process staleness relative to on-disk source).
 * @param {string} [opts.packageRoot] - test-only override; production/dev
 *   callers never pass this, so it always resolves to this module's own
 *   package root.
 */
function resolveBuildIdentity(opts = {}) {
  const packageRoot = opts.packageRoot || PACKAGE_ROOT;
  if (!identityCache.has(packageRoot)) identityCache.set(packageRoot, computeBuildIdentity(packageRoot));
  return { ...identityCache.get(packageRoot), bootedAt: opts.bootedAt ?? null };
}

/**
 * readInstalledBuildInfo() → the build-info.json currently ON DISK at this
 * package root (fresh read, never the boot-time memo), or null. Compared with
 * the running identity's codeSha to detect that an install/update already
 * replaced the files under a live process.
 */
function readInstalledBuildInfo(packageRoot = PACKAGE_ROOT) {
  return loadBuildInfoJson(packageRoot);
}

module.exports = { resolveBuildIdentity, readInstalledBuildInfo };
