'use strict';

/**
 * schedulerPaths.cjs — single resolver for every machine-wide, home-rooted
 * scheduler path. Plain Node (no electron) so queueStore.cjs and the watchdog
 * can load it.
 *
 * Every export is a LAZY function: the root is read from the environment at
 * point of use, never at require time, so a test (or a second instance) that
 * sets SM_SCHEDULER_HOME redirects ALL scheduler state — queue shards, machine
 * state, runs, PRDs, heartbeat, slot config, admin token — with no
 * half-redirect. SM_SCHEDULER_HOME set on the app propagates to spawned
 * executor jobs BY DESIGN (children inherit env), so a redirected app runs
 * redirected jobs.
 *
 * Worktree roots are NOT under schedulerHome (they live in a per-user state dir)
 * but are resolved here all the same, via SM_WORKTREE_ROOT (else persistentWorktreeBase()),
 * so the job and epic roots always move together under one override.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function isUnder(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Test-time fail-closed guard (same shape as opsOwnership.assertOpsWrite): under
 * vitest (process.env.VITEST) a resolved path must sit under SM_SCHEDULER_HOME,
 * SM_WORKTREE_ROOT, or os.tmpdir() — anything else is a LIVE root (real ~/.claude,
 * real home) that a unit test must never touch. Returns `resolved` so resolvers
 * can `return assertNotLiveRoot(...)`. O(#roots) per call.
 */
function assertNotLiveRoot(resolved, resolverName) {
  if (!process.env.VITEST) return resolved;
  // Narrow, per-test opt-in for a READ-ONLY probe of this machine's real user config
  // (health-delegation-chain.test.cjs). Never set it around anything that writes or sweeps.
  if (process.env.SM_ALLOW_LIVE_ROOT_READS === '1') return resolved;
  // HOLE CLOSED (2026-09-18 defaultCwd leak): the allow-list below is env-derived, and so was
  // the notion of "live" — both follow process.env.HOME / SM_SCHEDULER_HOME, which a test (or an
  // env inherited from the live app) freely reassigns. A live SM_SCHEDULER_HOME therefore
  // ALLOW-LISTED the very root the guard exists to refuse, and a HOME swapped mid-test moved
  // "live" out from under it. The passwd-database home (os.userInfo(), immune to $HOME) is the
  // one anchor a test cannot rewrite: nothing under its ~/.claude may be touched, whatever the
  // allow-list says.
  if (isLivePasswdRoot(resolved)) throw liveRootError(resolved, resolverName);
  const roots = [process.env.SM_SCHEDULER_HOME, process.env.SM_WORKTREE_ROOT, os.tmpdir()].filter(Boolean);
  if (roots.some((r) => isUnder(resolved, r))) return resolved;
  throw liveRootError(resolved, resolverName);
}

function liveRootError(resolved, resolverName) {
  return new Error(
    `schedulerPaths.${resolverName}() resolved to live root ${resolved} under vitest — ` +
    'set SM_SCHEDULER_HOME / SM_WORKTREE_ROOT / HOME to a temp dir (tests/setup/schedulerSandbox.cjs does this per run)',
  );
}

/** True when `resolved` sits under the passwd-home's ~/.claude (HOME-env independent). */
function isLivePasswdRoot(resolved) {
  let home;
  try { home = os.userInfo().homedir; } catch { return false; }
  if (!home) return false;
  // A sandbox that genuinely lives under the passwd home's tmp is not live; only ~/.claude is.
  return isUnder(resolved, path.join(home, '.claude'));
}

/** SM_SCHEDULER_HOME, else ~/.claude/session-manager. */
function schedulerHome() {
  return assertNotLiveRoot(
    process.env.SM_SCHEDULER_HOME || path.join(os.homedir(), '.claude', 'session-manager'),
    'schedulerHome',
  );
}

/** ~/.claude — Claude Code's own config dir (NOT redirected by SM_SCHEDULER_HOME). */
function claudeHome() { return assertNotLiveRoot(path.join(os.homedir(), '.claude'), 'claudeHome'); }
function claudeProjectsDir() { return assertNotLiveRoot(path.join(claudeHome(), 'projects'), 'claudeProjectsDir'); }

function scheduledPlansRoot() { return assertNotLiveRoot(path.join(schedulerHome(), 'scheduled-plans'), 'scheduledPlansRoot'); }
function runsDir() { return assertNotLiveRoot(path.join(scheduledPlansRoot(), 'runs'), 'runsDir'); }
function prdsRoot() { return assertNotLiveRoot(path.join(scheduledPlansRoot(), 'prds'), 'prdsRoot'); }
function machineStatePath() { return assertNotLiveRoot(path.join(schedulerHome(), 'scheduler-machine.json'), 'machineStatePath'); }
function legacyQueuePath() { return assertNotLiveRoot(path.join(scheduledPlansRoot(), 'queue.json'), 'legacyQueuePath'); }
function schedulerStatePath() { return assertNotLiveRoot(path.join(schedulerHome(), 'scheduler-state.json'), 'schedulerStatePath'); }
function heartbeatPath() { return assertNotLiveRoot(path.join(schedulerHome(), 'scheduler-heartbeat.log'), 'heartbeatPath'); }
function sessionSlotsConfigPath() { return assertNotLiveRoot(path.join(schedulerHome(), 'session-slots-config.json'), 'sessionSlotsConfigPath'); }
function watchdogLogsDir() { return assertNotLiveRoot(path.join(schedulerHome(), 'logs'), 'watchdogLogsDir'); }
function restartRequestPath() { return assertNotLiveRoot(path.join(schedulerHome(), 'restart-request.json'), 'restartRequestPath'); }
function restartingMarkerPath() { return assertNotLiveRoot(path.join(schedulerHome(), 'restarting.json'), 'restartingMarkerPath'); }
function watchdogRelaunchStatePath() { return assertNotLiveRoot(path.join(schedulerHome(), 'watchdog-relaunch-state.json'), 'watchdogRelaunchStatePath'); }
// Sibling of schedulerHome() (i.e. ~/.claude/logs by default), not inside it.
function watchdogRelaunchLogPath() {
  return assertNotLiveRoot(
    path.join(path.dirname(schedulerHome()), 'logs', 'scheduler-watchdog-relaunch.log'),
    'watchdogRelaunchLogPath',
  );
}
function historyRollupStampPath() { return assertNotLiveRoot(path.join(schedulerHome(), 'history-rollup.stamp'), 'historyRollupStampPath'); }
function historyRollupLockPath() { return assertNotLiveRoot(path.join(schedulerHome(), 'history-rollup.lock'), 'historyRollupLockPath'); }
function historyRollupPath() { return path.join(schedulerHome(), 'history-rollup.jsonl'); }
function auditLogPath() { return path.join(schedulerHome(), 'audit-log.jsonl'); }
function procnamesRoot() { return path.join(schedulerHome(), 'procnames'); }
/** Legacy global history sidecar (read-only; new appends go to per-project shards). */
function queueHistoryPath() { return path.join(scheduledPlansRoot(), 'history.jsonl'); }
function instanceLockPath() { return path.join(schedulerHome(), 'scheduler-owner.lock'); }
/** Where heap snapshots are written — the scheduler home itself. */
function heapSnapshotDir() { return schedulerHome(); }

/**
 * Persistent per-user default for worktrees: $XDG_STATE_HOME/session-manager (absolute values only,
 * per the XDG spec) else ~/.local/state/session-manager. NOT os.tmpdir(): a systemd tmp.conf `D /tmp`
 * empties /tmp at boot, and the Claude CLI keys an Epic's transcript to its SPAWN cwd (the worktree),
 * so a tmp-resident worktree took the transcript's directory with it ("lost sessions").
 * It is also deliberately outside every project repo and outside ~/.claude/projects: what /tmp bought
 * (a checkout never nested in the repo, so the repo's globs, `git status` and packaging never see it)
 * is kept by living in a per-user state dir instead of beside the project.
 */
function persistentWorktreeBase() {
  const xdg = process.env.XDG_STATE_HOME;
  const stateHome = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'session-manager');
}

/** SM_WORKTREE_ROOT, else persistentWorktreeBase() (created 0700 on demand) — parent of every managed worktree root. */
function worktreeBase() {
  if (process.env.SM_WORKTREE_ROOT) return assertNotLiveRoot(process.env.SM_WORKTREE_ROOT, 'worktreeBase');
  // Guard BEFORE mkdir: under vitest an unset SM_WORKTREE_ROOT must throw, never create a live dir.
  const base = assertNotLiveRoot(persistentWorktreeBase(), 'worktreeBase');
  try { fs.mkdirSync(base, { recursive: true, mode: 0o700 }); } catch { /* best-effort; createWorktree surfaces a real failure */ }
  return base;
}

/** Managed worktree root for `kind` ('job' | 'epic'), resolved fresh on every call. */
function worktreeRoot(kind) {
  return assertNotLiveRoot(path.join(worktreeBase(), `session-manager-${kind}-worktrees`), 'worktreeRoot');
}

/**
 * Mode-aware admin token path, resolved fresh on every call. Precedence:
 * SM_ADMIN_TOKEN_PATH (explicit override) > SM_DEV > SM_E2E > production file.
 * index.cjs treats SM_DEV and SM_E2E as one OR'd boolean; if both are set the
 * SM_DEV path wins (arbitrary but harmless — real launches set one).
 */
function adminTokenPath() {
  if (process.env.SM_ADMIN_TOKEN_PATH) return assertNotLiveRoot(process.env.SM_ADMIN_TOKEN_PATH, 'adminTokenPath');
  if (process.env.SM_DEV === '1') return assertNotLiveRoot(path.join(schedulerHome(), 'admin-api.dev.json'), 'adminTokenPath');
  if (process.env.SM_E2E === '1') return assertNotLiveRoot(path.join(schedulerHome(), 'admin-api.e2e.json'), 'adminTokenPath');
  return assertNotLiveRoot(path.join(schedulerHome(), 'admin-api.json'), 'adminTokenPath');
}

/**
 * cwd that machine-level scheduler errors are attributed to (they have no
 * owning project). SM_SCHEDULER_LOG_CWD, else the literal
 * ~/Projects/session-manager — deliberately NOT inferred from process.cwd().
 */
function machineStateLogCwd() {
  return assertNotLiveRoot(
    process.env.SM_SCHEDULER_LOG_CWD || path.join(os.homedir(), 'Projects', 'session-manager'),
    'machineStateLogCwd',
  );
}

module.exports = {
  assertNotLiveRoot,
  claudeHome,
  claudeProjectsDir,
  schedulerHome,
  scheduledPlansRoot,
  runsDir,
  prdsRoot,
  machineStatePath,
  legacyQueuePath,
  schedulerStatePath,
  heartbeatPath,
  sessionSlotsConfigPath,
  adminTokenPath,
  machineStateLogCwd,
  worktreeBase,
  persistentWorktreeBase,
  worktreeRoot,
  watchdogLogsDir,
  restartRequestPath,
  restartingMarkerPath,
  watchdogRelaunchStatePath,
  watchdogRelaunchLogPath,
  historyRollupStampPath,
  historyRollupLockPath,
  historyRollupPath,
  auditLogPath,
  procnamesRoot,
  queueHistoryPath,
  instanceLockPath,
  heapSnapshotDir,
};
