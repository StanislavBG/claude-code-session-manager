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
 * Worktree roots are NOT under schedulerHome (they live on the tmp filesystem)
 * but are resolved here all the same, via SM_WORKTREE_ROOT (else os.tmpdir()),
 * so the job and epic roots always move together under one override.
 */

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
  const roots = [process.env.SM_SCHEDULER_HOME, process.env.SM_WORKTREE_ROOT, os.tmpdir()].filter(Boolean);
  if (roots.some((r) => isUnder(resolved, r))) return resolved;
  throw new Error(
    `schedulerPaths.${resolverName}() resolved to live root ${resolved} under vitest — ` +
    'set SM_SCHEDULER_HOME / SM_WORKTREE_ROOT / HOME to a temp dir (tests/setup/schedulerSandbox.cjs does this per run)',
  );
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

/** SM_WORKTREE_ROOT, else os.tmpdir() — the parent of every managed worktree root. */
function worktreeBase() { return assertNotLiveRoot(process.env.SM_WORKTREE_ROOT || os.tmpdir(), 'worktreeBase'); }

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
