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

/** SM_SCHEDULER_HOME, else ~/.claude/session-manager. */
function schedulerHome() {
  return process.env.SM_SCHEDULER_HOME || path.join(os.homedir(), '.claude', 'session-manager');
}

/** ~/.claude — Claude Code's own config dir (NOT redirected by SM_SCHEDULER_HOME). */
function claudeHome() { return path.join(os.homedir(), '.claude'); }
function claudeProjectsDir() { return path.join(claudeHome(), 'projects'); }

function scheduledPlansRoot() { return path.join(schedulerHome(), 'scheduled-plans'); }
function runsDir() { return path.join(scheduledPlansRoot(), 'runs'); }
function prdsRoot() { return path.join(scheduledPlansRoot(), 'prds'); }
function machineStatePath() { return path.join(schedulerHome(), 'scheduler-machine.json'); }
function legacyQueuePath() { return path.join(scheduledPlansRoot(), 'queue.json'); }
function schedulerStatePath() { return path.join(schedulerHome(), 'scheduler-state.json'); }
function heartbeatPath() { return path.join(schedulerHome(), 'scheduler-heartbeat.log'); }
function sessionSlotsConfigPath() { return path.join(schedulerHome(), 'session-slots-config.json'); }
function watchdogLogsDir() { return path.join(schedulerHome(), 'logs'); }
function watchdogRelaunchStatePath() { return path.join(schedulerHome(), 'watchdog-relaunch-state.json'); }
// Sibling of schedulerHome() (i.e. ~/.claude/logs by default), not inside it.
function watchdogRelaunchLogPath() {
  return path.join(path.dirname(schedulerHome()), 'logs', 'scheduler-watchdog-relaunch.log');
}
function historyRollupStampPath() { return path.join(schedulerHome(), 'history-rollup.stamp'); }
function historyRollupLockPath() { return path.join(schedulerHome(), 'history-rollup.lock'); }

/** SM_WORKTREE_ROOT, else os.tmpdir() — the parent of every managed worktree root. */
function worktreeBase() { return process.env.SM_WORKTREE_ROOT || os.tmpdir(); }

/** Managed worktree root for `kind` ('job' | 'epic'), resolved fresh on every call. */
function worktreeRoot(kind) { return path.join(worktreeBase(), `session-manager-${kind}-worktrees`); }

/**
 * Mode-aware admin token path, resolved fresh on every call. Precedence:
 * SM_ADMIN_TOKEN_PATH (explicit override) > SM_DEV > SM_E2E > production file.
 * index.cjs treats SM_DEV and SM_E2E as one OR'd boolean; if both are set the
 * SM_DEV path wins (arbitrary but harmless — real launches set one).
 */
function adminTokenPath() {
  if (process.env.SM_ADMIN_TOKEN_PATH) return process.env.SM_ADMIN_TOKEN_PATH;
  if (process.env.SM_DEV === '1') return path.join(schedulerHome(), 'admin-api.dev.json');
  if (process.env.SM_E2E === '1') return path.join(schedulerHome(), 'admin-api.e2e.json');
  return path.join(schedulerHome(), 'admin-api.json');
}

/**
 * cwd that machine-level scheduler errors are attributed to (they have no
 * owning project). SM_SCHEDULER_LOG_CWD, else the literal
 * ~/Projects/session-manager — deliberately NOT inferred from process.cwd().
 */
function machineStateLogCwd() {
  return process.env.SM_SCHEDULER_LOG_CWD || path.join(os.homedir(), 'Projects', 'session-manager');
}

module.exports = {
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
  watchdogRelaunchStatePath,
  watchdogRelaunchLogPath,
  historyRollupStampPath,
  historyRollupLockPath,
};
