'use strict';

/**
 * videoScriptPress.cjs — the per-project human switch 'Scripts may run Demo
 * Video' and the small ledger of scripted Demo Video presses.
 *
 * Two MACHINE-LEVEL files beside task-switches.json (schedulerPaths):
 *   videoScriptSwitchesPath() — keyed by absolute project cwd (path.resolve):
 *     { "v": 1, "projects": { "/abs/cwd": { "enabled": true, "changedAt": "ISO", "by": {...} } } }
 *     `by` records WHO made the last change: { via: 'ui' } or
 *     { via: 'agent', claudeSessionId, quote, promptAt }. An entry without a
 *     well-formed `by` reads as { via: 'unknown' }; reads never rewrite the file.
 *   videoScriptRunsPath() — the scripted-press ledger, newest last, at most
 *     MAX_RUNS_PER_PROJECT runs per project (oldest dropped):
 *     { "v": 1, "projects": { "/abs/cwd": [ { entryId, epicId, slug, externalRef?, kind, at } ] } }
 * Both live outside every project ops root, so opsOwnership does not govern
 * them (same reason as tasks/taskSwitch.cjs).
 *
 * EXACTLY TWO WRITERS of the switch: it is a human decision, recorded with who made it.
 *   - The UI IPC is a human click: by.via 'ui'.
 *   - The agent route POST /admin/project-home/videos/script-switch writes
 *     by.via 'agent', and only on a verified human quote.
 *   (Both land in later PRDs.) Any other write is outside the law and reads as
 *   by.via 'unknown'. The switch is a consent gate, not a sandbox.
 * The ledger's ONLY writer is the scripted-press route
 * POST /admin/project-home/videos/run; it refuses presses while the switch is
 * off and reads the ledger to answer a run's status by entry id.
 *
 * Switching off keeps the entry (enabled:false + changedAt). Switch reads are
 * cached by file mtime; a missing or corrupt file reads as all-off / empty
 * and never throws.
 */

const fs = require('node:fs');
const path = require('node:path');
const { videoScriptSwitchesPath, videoScriptRunsPath } = require('../scheduler/schedulerPaths.cjs');
const atomicFs = require('../util/atomicFs.cjs');

const VERSION = 1;
const MAX_RUNS_PER_PROJECT = 200;

/** @type {{ file: string, mtimeMs: number, data: Record<string, { enabled: boolean, changedAt: string, by: object | null }> } | null} */
let cache = null;

function normalizeCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  return path.resolve(cwd);
}

const BY_ERROR = "setVideoScriptSwitch: by must be {via:'ui'} or {via:'agent', claudeSessionId, quote, promptAt}";
const UNKNOWN_BY = Object.freeze({ via: 'unknown' });

function boundedString(v, max) {
  return typeof v === 'string' && v.length >= 1 && v.length <= max;
}

function isIsoish(v) {
  return typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Date.parse(v));
}

/** Normalized copy of a well-formed attribution, or null (same rules as taskSwitch). */
function validBy(by) {
  if (!by || typeof by !== 'object' || Array.isArray(by)) return null;
  if (by.via === 'ui') {
    return Object.keys(by).length === 1 ? { via: 'ui' } : null;
  }
  if (by.via === 'agent') {
    const { claudeSessionId, quote, promptAt } = by;
    if (!boundedString(claudeSessionId, 128)) return null;
    if (!boundedString(quote, 2000)) return null;
    if (!isIsoish(promptAt)) return null;
    return { via: 'agent', claudeSessionId, quote, promptAt };
  }
  return null;
}

function projectsOf(parsed) {
  const projects = parsed && typeof parsed === 'object' ? parsed.projects : null;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return null;
  return projects;
}

/* ── switch ─────────────────────────────────────────────────────────────── */

function sanitizeSwitches(parsed) {
  const out = {};
  const projects = projectsOf(parsed);
  if (!projects) return out;
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

function readSwitches() {
  let file;
  try {
    file = videoScriptSwitchesPath();
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
  const data = sanitizeSwitches(atomicFs.readJsonOrSync(file, null));
  cache = { file, mtimeMs, data };
  return data;
}

/** True only when `cwd`'s switch is explicitly on. Never throws. */
function isVideoScriptSwitchOn(cwd) {
  try {
    const key = normalizeCwd(cwd);
    if (!key) return false;
    const entry = readSwitches()[key];
    return !!(entry && entry.enabled);
  } catch {
    return false;
  }
}

/**
 * One of the two sanctioned writers only (see header). Records
 * { enabled, changedAt, by }; switching off keeps the entry. An invalid `by`
 * throws before any fs call.
 */
function setVideoScriptSwitch(cwd, enabled, by) {
  const attribution = validBy(by);
  if (!attribution) throw new Error(BY_ERROR);
  const key = normalizeCwd(cwd);
  if (!key) throw new Error('setVideoScriptSwitch: cwd must be a non-empty string');
  const projects = { ...readSwitches() };
  projects[key] = { enabled: enabled === true, changedAt: new Date().toISOString(), by: attribution };
  const file = videoScriptSwitchesPath();
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
function getVideoScriptSwitch(cwd) {
  try {
    const key = normalizeCwd(cwd);
    if (!key) return null;
    const entry = readSwitches()[key];
    if (!entry) return { cwd: key, enabled: false, changedAt: null, by: null };
    return { cwd: key, enabled: entry.enabled, changedAt: entry.changedAt, by: entry.by ? { ...entry.by } : { ...UNKNOWN_BY } };
  } catch {
    return null;
  }
}

/* ── ledger ─────────────────────────────────────────────────────────────── */

/** Normalized run record, or null when malformed. */
function validRun(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return null;
  const { entryId, epicId, slug, externalRef, kind, at } = run;
  if (!boundedString(entryId, 200)) return null;
  if (!boundedString(epicId, 200)) return null;
  if (!boundedString(slug, 200)) return null;
  if (!boundedString(kind, 100)) return null;
  if (!isIsoish(at)) return null;
  if (externalRef !== undefined && externalRef !== null && !boundedString(externalRef, 500)) return null;
  const out = { entryId, epicId, slug, kind, at };
  if (typeof externalRef === 'string') out.externalRef = externalRef;
  if (run.caller !== undefined) {
    const { CallerSchema } = require('../epic/scriptStartedBy.cjs');
    const c = CallerSchema.safeParse(run.caller);
    if (c.success) out.caller = c.data;
  }
  if (boundedString(run.fromEpicId, 200)) out.fromEpicId = run.fromEpicId;
  return out;
}

function readRuns() {
  let file;
  try {
    file = videoScriptRunsPath();
  } catch {
    return {};
  }
  const projects = projectsOf(atomicFs.readJsonOrSync(file, null));
  const out = {};
  if (!projects) return out;
  for (const [cwd, list] of Object.entries(projects)) {
    if (!Array.isArray(list)) continue;
    const runs = list.map(validRun).filter(Boolean);
    if (runs.length) out[path.resolve(cwd)] = runs;
  }
  return out;
}

/**
 * The scripted-press route's write (see header). Appends the run (an earlier
 * run with the same entryId is replaced), keeps the newest
 * MAX_RUNS_PER_PROJECT for the project, and returns the stored record.
 * Throws on a malformed cwd or run before any write.
 */
function recordScriptRun(cwd, run) {
  const key = normalizeCwd(cwd);
  if (!key) throw new Error('recordScriptRun: cwd must be a non-empty string');
  const record = validRun(run);
  if (!record) throw new Error('recordScriptRun: run must be {entryId, epicId, slug, externalRef?, kind, at(ISO)}');
  const projects = readRuns();
  const list = (projects[key] || []).filter((r) => r.entryId !== record.entryId);
  list.push(record);
  projects[key] = list.length > MAX_RUNS_PER_PROJECT ? list.slice(list.length - MAX_RUNS_PER_PROJECT) : list;
  const file = videoScriptRunsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicFs.writeJsonAtomicSync(file, { v: VERSION, projects });
  return { ...record };
}

/**
 * A project's run by entryId (preferred) or by externalRef (newest match), or
 * null. Never throws.
 */
function findScriptRun(cwd, query) {
  try {
    const key = normalizeCwd(cwd);
    if (!key || !query || typeof query !== 'object') return null;
    const list = readRuns()[key];
    if (!list) return null;
    let hit;
    if (typeof query.entryId === 'string' && query.entryId) {
      hit = list.find((r) => r.entryId === query.entryId);
    } else if (typeof query.externalRef === 'string' && query.externalRef) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].externalRef === query.externalRef) { hit = list[i]; break; }
      }
    }
    return hit ? { ...hit } : null;
  } catch {
    return null;
  }
}

function _resetForTests() {
  cache = null;
}

module.exports = {
  MAX_RUNS_PER_PROJECT,
  getVideoScriptSwitch,
  setVideoScriptSwitch,
  isVideoScriptSwitchOn,
  recordScriptRun,
  findScriptRun,
  _resetForTests,
};
