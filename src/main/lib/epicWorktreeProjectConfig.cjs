'use strict';

/**
 * epicWorktreeProjectConfig.cjs — per-project UI toggle for Epic worktree
 * isolation (PRD 1035, final link of the epic-worktree-isolation chain;
 * moved off the machine-wide global map onto the per-project ops root by
 * PRD 1390).
 *
 * `SM_EPIC_WORKTREE_DISABLE` (gitWorktree.cjs) is an env var, checked once at
 * process start — there was previously no way to turn the feature off for
 * one project from the app itself. This module is that per-project knob:
 * `<cwd>/session-manager-operations/prompt-sessions/epic-worktree-config.json`
 * holding `{ disabled: boolean }` for that one project, read by
 * gitWorktree.cjs's `isWorktreeDisabled('epic', cwd)` on every worktree
 * creation attempt, and read/written by Settings.tsx's per-project toggle
 * over the two IPC handlers registered below.
 *
 * By shape the old single global file (`{ "<project-cwd>": true|false }` under
 * `~/.claude/session-manager/`) was per-project config keyed by project path —
 * the wrong tier. It now lives in the `prompt-sessions` ops namespace, already
 * owned by writer 'epics' (opsOwnership.cjs), the same as every other Epic
 * record. Migration is lossless and one-shot: on first read for a cwd whose
 * new per-project file doesn't exist yet, the legacy global map is checked for
 * that cwd's key; if present (the map only ever stores `true` — `false` is
 * represented by key absence), the new file is seeded with it. The legacy file
 * itself is left in place — untouched, never deleted — so any OTHER project's
 * still-unmigrated key keeps resolving correctly until that project is itself
 * touched.
 *
 * Plain Node (no Electron deps in the read/write helpers) so gitWorktree.cjs
 * — itself Electron-free — can require this lazily without pulling Electron
 * into contexts (tests, watchdog scripts) that don't have it.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { assertOpsWrite, opsPath } = require('./opsOwnership.cjs');

// The old machine-wide map. Read-only from here on (migration source only) —
// never written again, and deliberately never deleted so unmigrated projects
// keep working. Resolved per-call (not a frozen const) so tests can point
// this at a throwaway tmpdir file via SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH
// instead of touching the real machine-level file.
const DEFAULT_LEGACY_CONFIG_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'epic-worktree-project-config.json');

function legacyConfigPath() {
  return process.env.SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH || DEFAULT_LEGACY_CONFIG_PATH;
}

function readLegacyConfig() {
  try {
    const raw = fs.readFileSync(legacyConfigPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** `<cwd>/session-manager-operations/prompt-sessions/epic-worktree-config.json` */
function perProjectConfigPath(cwd) {
  return opsPath(cwd, 'prompt-sessions', 'epic-worktree-config.json');
}

function readPerProjectConfigFile(cwd) {
  try {
    const raw = fs.readFileSync(perProjectConfigPath(cwd), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writePerProjectConfig(cwd, config, writer = 'epics') {
  const file = perProjectConfigPath(cwd);
  assertOpsWrite(file, writer);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * One-shot migration: when the per-project file doesn't exist yet, seed it
 * from the legacy global map's entry for this cwd (present only when it was
 * explicitly disabled — the legacy map deletes the key on re-enable). Never
 * touches the legacy file itself.
 */
function readOrMigratePerProjectConfig(cwd) {
  const existing = readPerProjectConfigFile(cwd);
  if (existing) return existing;
  const legacyValue = readLegacyConfig()[cwd];
  if (legacyValue !== true) return { disabled: false };
  const seeded = { disabled: true };
  writePerProjectConfig(cwd, seeded);
  return seeded;
}

/** True when the project at `cwd` has explicitly turned Epic worktree isolation off. */
function isEpicWorktreeDisabledForProject(cwd) {
  if (!cwd || typeof cwd !== 'string') return false;
  try {
    return readOrMigratePerProjectConfig(cwd).disabled === true;
  } catch {
    return false;
  }
}

/** Persists the per-project toggle. */
function setEpicWorktreeDisabledForProject(cwd, disabled, writer = 'epics') {
  if (!cwd || typeof cwd !== 'string') throw new Error('setEpicWorktreeDisabledForProject: cwd is required');
  const value = !!disabled;
  writePerProjectConfig(cwd, { disabled: value }, writer);
  return value;
}

function registerEpicWorktreeProjectConfigHandlers() {
  const { ipcMain } = require('electron');
  const { schemas: s, validated: v } = require('../ipcSchemas.cjs');
  const { validatePath } = require('../config.cjs');
  ipcMain.handle(
    'promptSessions:get-worktree-disabled',
    v(s.promptSessionsGetWorktreeDisabled, ({ cwd }) => {
      validatePath(cwd);
      return { disabled: isEpicWorktreeDisabledForProject(cwd) };
    }),
  );
  ipcMain.handle(
    'promptSessions:set-worktree-disabled',
    v(s.promptSessionsSetWorktreeDisabled, ({ cwd, disabled }) => {
      validatePath(cwd);
      return { disabled: setEpicWorktreeDisabledForProject(cwd, disabled) };
    }),
  );
}

module.exports = {
  DEFAULT_LEGACY_CONFIG_PATH,
  legacyConfigPath,
  perProjectConfigPath,
  isEpicWorktreeDisabledForProject,
  setEpicWorktreeDisabledForProject,
  registerEpicWorktreeProjectConfigHandlers,
};
