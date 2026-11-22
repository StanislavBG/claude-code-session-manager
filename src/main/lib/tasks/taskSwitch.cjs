'use strict';

/**
 * taskSwitch.cjs — the per-project human switch 'Scripts may run Tasks'.
 *
 * One MACHINE-LEVEL file (schedulerPaths.taskSwitchesPath(), beside the slot
 * config) keyed by absolute project cwd (normalized with path.resolve):
 *   { "v": 1, "projects": { "/abs/cwd": { "enabled": true, "changedAt": "ISO" } } }
 * It lives outside every project ops root, so opsOwnership does not govern it.
 *
 * Readers: the Task admin route (refuses with 403 while a project is off), the
 * history surface (finds projects with Task ledgers from listTaskProjects()
 * instead of scanning ~/.claude/projects), and the held interactive slot (on
 * only while anyTaskSwitchOn()).
 *
 * HUMAN-ONLY WRITER: the switch is a human decision. Only the renderer IPC
 * handler (tasks/taskIpc.cjs) may call setTaskSwitch. No admin route, MCP tool,
 * script or agent-facing surface may write it — a script that could flip its
 * own permission would make the switch meaningless.
 *
 * Switching off keeps the entry (enabled:false + changedAt) so the project
 * stays listed. Reads are cached by file mtime (one statSync per read); a
 * missing or corrupt file reads as all-off and never throws.
 */

const fs = require('node:fs');
const path = require('node:path');
const { taskSwitchesPath } = require('../scheduler/schedulerPaths.cjs');
const atomicFs = require('../util/atomicFs.cjs');

const VERSION = 1;

/** @type {{ file: string, mtimeMs: number, data: Record<string, { enabled: boolean, changedAt: string }> } | null} */
let cache = null;

function normalizeCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  return path.resolve(cwd);
}

/** Keep only well-formed entries; anything else reads as absent (off). */
function sanitize(parsed) {
  const out = {};
  const projects = parsed && typeof parsed === 'object' ? parsed.projects : null;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return out;
  for (const [cwd, entry] of Object.entries(projects)) {
    if (!entry || typeof entry !== 'object') continue;
    out[path.resolve(cwd)] = {
      enabled: entry.enabled === true,
      changedAt: typeof entry.changedAt === 'string' ? entry.changedAt : '',
    };
  }
  return out;
}

function readAll() {
  let file;
  try {
    file = taskSwitchesPath();
  } catch {
    return {};
  }
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    cache = null;
    return {};
  }
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.data;
  const data = sanitize(atomicFs.readJsonOrSync(file, null));
  cache = { file, mtimeMs, data };
  return data;
}

/** True only when `cwd`'s switch is explicitly on. Never throws. */
function isTaskSwitchOn(cwd) {
  const key = normalizeCwd(cwd);
  if (!key) return false;
  const entry = readAll()[key];
  return !!(entry && entry.enabled);
}

/**
 * HUMAN-ONLY: call from the renderer IPC handler (taskIpc.cjs) and nowhere else.
 * Records { enabled, changedAt }; switching off keeps the entry.
 */
function setTaskSwitch(cwd, on) {
  const key = normalizeCwd(cwd);
  if (!key) throw new Error('setTaskSwitch: cwd must be a non-empty string');
  const projects = { ...readAll() };
  projects[key] = { enabled: on === true, changedAt: new Date().toISOString() };
  const file = taskSwitchesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicFs.writeJsonAtomicSync(file, { v: VERSION, projects });
  cache = null;
  return { cwd: key, ...projects[key] };
}

/** Every project that ever had the switch set, on or off. */
function listTaskProjects() {
  return Object.entries(readAll()).map(([cwd, e]) => ({ cwd, enabled: e.enabled, changedAt: e.changedAt }));
}

/** True while at least one project has the switch on. */
function anyTaskSwitchOn() {
  return Object.values(readAll()).some((e) => e.enabled);
}

function _resetForTests() {
  cache = null;
}

module.exports = {
  isTaskSwitchOn,
  setTaskSwitch,
  listTaskProjects,
  anyTaskSwitchOn,
  _resetForTests,
};
