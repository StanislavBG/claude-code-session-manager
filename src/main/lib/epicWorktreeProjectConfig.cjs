'use strict';

/**
 * epicWorktreeProjectConfig.cjs — per-project UI toggle for Epic worktree
 * isolation (PRD 1035, final link of the epic-worktree-isolation chain).
 *
 * `SM_EPIC_WORKTREE_DISABLE` (gitWorktree.cjs) is an env var, checked once at
 * process start — there was previously no way to turn the feature off for
 * one project from the app itself. This module is that per-project knob:
 * a single JSON file mapping project cwd -> disabled, read by
 * gitWorktree.cjs's `isWorktreeDisabled('epic', cwd)` on every worktree
 * creation attempt, and read/written by Settings.tsx's per-project toggle
 * over the two IPC handlers registered below.
 *
 * Lives under `~/.claude/session-manager/` — machine-runtime bookkeeping,
 * the same tier as scheduler-machine.json (see queueStore.cjs's header
 * comment) — NOT under any project's `session-manager-operations/`, so the
 * single-writer OWNERS law (opsOwnership.cjs) doesn't apply here; this file
 * only ever has one writer (this module) by construction.
 *
 * Plain Node (no Electron deps in the read/write helpers) so gitWorktree.cjs
 * — itself Electron-free — can require this lazily without pulling Electron
 * into contexts (tests, watchdog scripts) that don't have it.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'epic-worktree-project-config.json');

// Resolved per-call (not a frozen const) so tests can point this at a
// throwaway tmpdir file via SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH instead of
// mutating the real machine-level file at DEFAULT_CONFIG_PATH.
function configPath() {
  return process.env.SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH || DEFAULT_CONFIG_PATH;
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeConfig(config) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, file);
}

/** True when the project at `cwd` has explicitly turned Epic worktree isolation off. */
function isEpicWorktreeDisabledForProject(cwd) {
  if (!cwd || typeof cwd !== 'string') return false;
  return readConfig()[cwd] === true;
}

/** Persists (or clears, when `disabled` is false) the per-project toggle. */
function setEpicWorktreeDisabledForProject(cwd, disabled) {
  if (!cwd || typeof cwd !== 'string') throw new Error('setEpicWorktreeDisabledForProject: cwd is required');
  const config = readConfig();
  if (disabled) {
    config[cwd] = true;
  } else {
    delete config[cwd];
  }
  writeConfig(config);
  return disabled;
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
  DEFAULT_CONFIG_PATH,
  configPath,
  isEpicWorktreeDisabledForProject,
  setEpicWorktreeDisabledForProject,
  registerEpicWorktreeProjectConfigHandlers,
};
