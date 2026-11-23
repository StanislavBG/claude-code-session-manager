'use strict';

/**
 * taskSwitch.cjs — the per-project human switch 'Scripts may run Tasks'.
 *
 * One MACHINE-LEVEL file (schedulerPaths.taskSwitchesPath(), beside the slot
 * config) keyed by absolute project cwd (normalized with path.resolve):
 *   { "v": 1, "projects": { "/abs/cwd": { "enabled": true, "changedAt": "ISO", "by": {...} } } }
 * `by` records WHO made the last change: { via: 'ui' } or
 * { via: 'agent', claudeSessionId, quote, promptAt }. An entry without a
 * well-formed `by` (one written before attribution, or by hand) reads as
 * { via: 'unknown' }; reads never rewrite the file.
 * It lives outside every project ops root, so opsOwnership does not govern it.
 *
 * Readers: the Task admin route (refuses with 403 while a project is off), the
 * history surface (finds projects with Task ledgers from listTaskProjects()
 * instead of scanning ~/.claude/projects), and the held interactive slot (on
 * only while anyTaskSwitchOn()).
 *
 * EXACTLY TWO WRITERS: the switch is a human decision, recorded with who made it.
 *   - tasks/taskIpc.cjs (tasks:set-switch) is a human click: by.via 'ui'.
 *   - The agent route POST /admin/tasks/switch (lib/tasks/taskSwitchRoute.cjs)
 *     writes by.via 'agent', and only on a verified human quote.
 * Any other write (a direct module call, a hand edit) is outside the law and
 * reads as by.via 'unknown'. The switch is a consent gate, not a sandbox.
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

/** @type {{ file: string, mtimeMs: number, data: Record<string, { enabled: boolean, changedAt: string, by: object | null }> } | null} */
let cache = null;

function normalizeCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  return path.resolve(cwd);
}

const BY_ERROR = "setTaskSwitch: by must be {via:'ui'} or {via:'agent', claudeSessionId, quote, promptAt}";
const UNKNOWN_BY = Object.freeze({ via: 'unknown' });

function boundedString(v, max) {
  return typeof v === 'string' && v.length >= 1 && v.length <= max;
}

/**
 * Normalized copy of a well-formed attribution, or null.
 * { via:'ui' } exactly; agent keeps exactly claudeSessionId (1-128),
 * quote (1-2000), promptAt (parseable ISO string).
 */
function validBy(by) {
  if (!by || typeof by !== 'object' || Array.isArray(by)) return null;
  if (by.via === 'ui') {
    return Object.keys(by).length === 1 ? { via: 'ui' } : null;
  }
  if (by.via === 'agent') {
    const { claudeSessionId, quote, promptAt } = by;
    if (!boundedString(claudeSessionId, 128)) return null;
    if (!boundedString(quote, 2000)) return null;
    if (typeof promptAt !== 'string' || promptAt.trim() === '' || Number.isNaN(Date.parse(promptAt))) return null;
    return { via: 'agent', claudeSessionId, quote, promptAt };
  }
  return null;
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
      by: validBy(entry.by),
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
 * One of the two sanctioned writers only (see header): taskIpc.cjs with
 * { via: 'ui' }, the agent route with { via: 'agent', ... }. Records
 * { enabled, changedAt, by }; switching off keeps the entry. An invalid `by`
 * throws before any fs call.
 */
function setTaskSwitch(cwd, on, by) {
  const attribution = validBy(by);
  if (!attribution) throw new Error(BY_ERROR);
  const key = normalizeCwd(cwd);
  if (!key) throw new Error('setTaskSwitch: cwd must be a non-empty string');
  const projects = { ...readAll() };
  projects[key] = { enabled: on === true, changedAt: new Date().toISOString(), by: attribution };
  const file = taskSwitchesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicFs.writeJsonAtomicSync(file, { v: VERSION, projects });
  cache = null;
  return { cwd: key, enabled: projects[key].enabled, changedAt: projects[key].changedAt, by: { ...attribution } };
}

/**
 * One project's entry with attribution. changedAt/by null when there is no
 * entry; by { via:'unknown' } for an entry without a well-formed by; null for
 * a non-string or empty cwd. Never throws.
 */
function getTaskSwitch(cwd) {
  try {
    const key = normalizeCwd(cwd);
    if (!key) return null;
    const entry = readAll()[key];
    if (!entry) return { cwd: key, enabled: false, changedAt: null, by: null };
    return { cwd: key, enabled: entry.enabled, changedAt: entry.changedAt, by: entry.by ? { ...entry.by } : { ...UNKNOWN_BY } };
  } catch {
    return null;
  }
}

/** Every project that ever had the switch set, on or off. */
function listTaskProjects() {
  return Object.entries(readAll()).map(([cwd, e]) => ({
    cwd, enabled: e.enabled, changedAt: e.changedAt, by: e.by ? { ...e.by } : { ...UNKNOWN_BY },
  }));
}

/** True while at least one project has the switch on. */
function anyTaskSwitchOn() {
  return Object.values(readAll()).some((e) => e.enabled);
}

/**
 * The one shared way to keep the held interactive slot in step with the file:
 * setInteractiveReserve(anyTaskSwitchOn()). sessionSlots is required lazily so
 * this module stays requirable without loading the slot pool. Never throws.
 */
function syncInteractiveReserve() {
  try {
    const sessionSlots = require('../scheduler/sessionSlots.cjs');
    return sessionSlots.setInteractiveReserve(anyTaskSwitchOn()) === true;
  } catch {
    return false;
  }
}

function _resetForTests() {
  cache = null;
}

module.exports = {
  isTaskSwitchOn,
  setTaskSwitch,
  getTaskSwitch,
  listTaskProjects,
  anyTaskSwitchOn,
  syncInteractiveReserve,
  _resetForTests,
};
