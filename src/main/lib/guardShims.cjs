/**
 * guardShims.cjs — stable, app-upgrade-proof indirection for the three
 * PreToolUse guard hooks that delegationReadiness.cjs installs into an
 * adopting project's `.claude/settings.json`.
 *
 * Why this exists: those installers used to bake
 * `path.resolve(__dirname, '../../../scripts/hooks/guard-*.cjs')` — THIS
 * app's own copy of the script — directly into the hook command. Run via
 * `npx claude-code-session-manager@latest` (the normal install path), that
 * resolves under `~/.npm/_npx/<hash>/node_modules/claude-code-session-manager/`
 * — a directory scoped to ONE npx resolution. The next `npx ...@latest` (a
 * new release) or an npm cache prune creates/removes a different hash dir, so
 * every previously-installed hook decays into a dead path. A PreToolUse
 * command pointing at a missing script exits non-zero WITHOUT exit code 2 (a
 * non-blocking error to the harness), so it silently guards nothing — while
 * checkPrdWriteGuard correctly flips the readiness banner back to red. That
 * decay is why "Delegation not ready" reappears across projects even after a
 * successful install.
 *
 * Fix: install a STABLE shim under the user's home
 * (`~/.claude/session-manager/hooks/guard-<name>.cjs`) that never moves
 * across app upgrades. The shim contains no guard logic of its own — CLAUDE.md's
 * "adopt by REFERENCE, never vendor" law — it reads a pointer file
 * (`app-root.json`, rewritten on every app boot with the CURRENTLY running
 * app's root) and `require()`s the real `scripts/hooks/guard-<name>.cjs` from
 * there. An app upgrade (a new npx hash dir) just rewrites the pointer on the
 * next boot; every already-installed project hook keeps resolving through
 * the same shim path with no re-install.
 *
 * The guard scripts run their logic as a require-time side effect (stdin ->
 * decision -> process.exit, not gated on `require.main === module`), so a
 * plain `require()` from the shim is enough to invoke them.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeJson, writeTextAtomic, addAllowedRoot } = require('../config.cjs');

// src/main/lib -> app root (three levels up) — the same resolution
// delegationReadiness.cjs's *_GUARD_SCRIPT constants use.
const APP_ROOT = path.resolve(__dirname, '..', '..', '..');

const GUARD_NAMES = ['guard-prd-writes.cjs', 'guard-destructive-git.cjs', 'guard-inline-implementation.cjs'];

function hooksDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'session-manager', 'hooks');
}

function pointerPath(homeDir = os.homedir()) {
  return path.join(hooksDir(homeDir), 'app-root.json');
}

function shimPath(guardName, homeDir = os.homedir()) {
  return path.join(hooksDir(homeDir), guardName);
}

function shimBody(guardName) {
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ptr = JSON.parse(fs.readFileSync(path.join(__dirname, 'app-root.json'), 'utf8'));
require(path.join(ptr.appRoot, 'scripts', 'hooks', '${guardName}'));
`;
}

/**
 * Write the pointer file + all three shims under `homeDir`. Idempotent: a
 * re-run with the same `appRoot` produces byte-identical files; a re-run with
 * a DIFFERENT `appRoot` (an app upgrade) rewrites only the pointer, which is
 * exactly what lets already-installed project hooks follow the upgrade with
 * no re-install. Never throws — returns `{ ok, error }` so a boot-time caller
 * can fire-and-forget and an installer can refuse cleanly rather than writing
 * a hook command that points at a shim that doesn't exist.
 */
async function writeGuardShims({ homeDir = os.homedir(), appRoot = APP_ROOT } = {}) {
  try {
    addAllowedRoot(homeDir);
    await writeJson(pointerPath(homeDir), { appRoot });
    for (const name of GUARD_NAMES) {
      await writeTextAtomic(shimPath(name, homeDir), shimBody(name));
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** True when every shim + the pointer file already exist on disk under `homeDir`. */
function guardShimsExist(homeDir = os.homedir()) {
  return fs.existsSync(pointerPath(homeDir)) && GUARD_NAMES.every((name) => fs.existsSync(shimPath(name, homeDir)));
}

/**
 * Given an absolute script path a hook command resolved to, determine
 * whether it's actually a guard SHIM (its directory carries a sibling
 * `app-root.json`) rather than a direct app-root script. A direct script has
 * no pointer and is trivially "real" once `fs.existsSync` is true — the
 * caller doesn't need this function for that case.
 *
 * For a shim, existence of the shim FILE is not enough: the shim's own
 * require() target is `ptr.appRoot/scripts/hooks/<name>.cjs`, resolved only
 * at hook-invocation time. If the pointer is missing, unparseable, or now
 * names a script that's gone, the shim silently guards nothing the next time
 * a hook actually fires — decay one hop downstream of the hook command
 * itself. Returns `null` when `scriptAbsPath` is not a shim (no sibling
 * pointer) — the caller's plain existence check already covers that case.
 * Throws when it IS a shim and the pointer has decayed.
 */
function resolveShimTarget(scriptAbsPath) {
  const dir = path.dirname(scriptAbsPath);
  const ptrFile = path.join(dir, 'app-root.json');
  if (!fs.existsSync(ptrFile)) return null;

  const guardName = path.basename(scriptAbsPath);
  let appRoot;
  try {
    appRoot = JSON.parse(fs.readFileSync(ptrFile, 'utf8'))?.appRoot;
  } catch (err) {
    throw new Error(`guard shim pointer ${ptrFile} is unparseable: ${err?.message ?? err}`);
  }
  if (typeof appRoot !== 'string' || !appRoot) {
    throw new Error(`guard shim pointer ${ptrFile} has no appRoot`);
  }
  const real = path.join(appRoot, 'scripts', 'hooks', guardName);
  if (!fs.existsSync(real)) {
    throw new Error(`guard shim pointer ${ptrFile} resolves to a script that no longer exists: ${real}`);
  }
  return real;
}

/**
 * `writeGuardShims({ homeDir })`, but returns `null` on success and an
 * install-function-shaped error object (`{ ok:false, action:'error', error }`)
 * on failure — the one call every `install*Guard` in delegationReadiness.cjs
 * needs before it can safely write a hook command pointing at the shim.
 */
async function ensureGuardShimsOrError(homeDir) {
  const result = await writeGuardShims({ homeDir });
  if (result.ok) return null;
  return { ok: false, action: 'error', error: `could not write the stable guard shim under ${hooksDir(homeDir)}: ${result.error}` };
}

module.exports = {
  APP_ROOT,
  GUARD_NAMES,
  hooksDir,
  pointerPath,
  shimPath,
  shimBody,
  writeGuardShims,
  guardShimsExist,
  resolveShimTarget,
  ensureGuardShimsOrError,
};
