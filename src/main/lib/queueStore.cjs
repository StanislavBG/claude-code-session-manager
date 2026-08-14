/**
 * queueStore.cjs — federated scheduler state (2026-07-31 domain-model
 * decision: "retire the global-aware scheduler").
 *
 * The old system of record was one global
 * `~/.claude/session-manager/scheduled-plans/queue.json`. It is retired.
 * State now lives where it belongs in the TAB → EPIC → PRD hierarchy:
 *
 *   - Per-project job rows:   `<cwd>/session-manager-operations/scheduler/state/queue.json`
 *     ({ jobs: [...] } — only that project's jobs)
 *   - Per-project history:    `<cwd>/session-manager-operations/scheduler/state/history.jsonl`
 *     (owned by queueHistory.cjs, path resolved here)
 *   - Machine runtime state:  `~/.claude/session-manager/scheduler-machine.json`
 *     (config, paused/rate-limit, scheduledFor, lastRunAt — these are
 *     Session-Manager runtime concerns, like the sessionSlots pool, not any
 *     one project's data. Run logs under scheduled-plans/runs/ stay
 *     machine-local for the same reason: they're execution artifacts of this
 *     machine's runner.)
 *
 * scheduler.cjs's 4k lines keep operating on ONE merged in-memory state
 * object (jobs across all projects + machine fields); this module is the
 * read-merge / write-split shim underneath readQueue/writeQueue. Jobs are
 * split by `job.cwd` (fallback: the provided defaultCwd).
 *
 * Plain Node (no Electron deps) so watchdog scripts can require it; atomic
 * writes are tmp+rename here rather than config.cjs's writeJson because
 * config.cjs requires electron/chokidar and this must load outside the app.
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { allProjectCwds, activeProjectCwds } = require('../../../scripts/lib/activeSessions.cjs');
const { assertOpsWrite } = require('./opsOwnership.cjs');
const { ScheduleJobSchema } = require('./scheduleJobSchema.cjs');

const MACHINE_STATE_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'scheduler-machine.json');
const LEGACY_QUEUE_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'scheduled-plans', 'queue.json');
const STATE_SUBPATH = ['session-manager-operations', 'scheduler', 'state'];

/**
 * A project's `session-manager-operations/scheduler/state/` directory.
 *
 * The cwd MUST be absolute. `path.join()` happily accepts a relative one and
 * silently resolves it against `process.cwd()`, which turns a bad caller into
 * a whole ops root materialized in the wrong place — observed live on
 * 2026-08-13 as five stray `session-manager-operations/scheduler/state/
 * queue.json` trees under source directories (`src/main/lib/`,
 * `src/renderer/state/`, …), each created by a caller that passed a
 * repo-relative path like `src/main/lib`. That is the same ops-root hazard
 * gitWorktree.cjs's header comment describes, reached from the other end: not
 * a worktree dir substituted for a project cwd, but a relative fragment
 * accepted as one. Fail closed — a caller that cannot name an absolute
 * project cwd has no business writing that project's queue.
 */
function projectStateDir(cwd) {
  if (!cwd || typeof cwd !== 'string') throw new Error('projectStateDir: cwd is required');
  if (!path.isAbsolute(cwd)) {
    throw new Error(`projectStateDir: cwd must be an absolute path, got "${cwd}"`);
  }
  return path.join(cwd, ...STATE_SUBPATH);
}

function projectQueuePath(cwd) {
  return path.join(projectStateDir(cwd), 'queue.json');
}

function projectHistoryPath(cwd) {
  return path.join(projectStateDir(cwd), 'history.jsonl');
}

function writeJsonAtomicSync(file, value) {
  assertOpsWrite(file, 'scheduler');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

async function writeJsonAtomic(file, value) {
  assertOpsWrite(file, 'scheduler');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, file);
}

// ---------- project-cwd enumeration (cached) ----------

// allProjectCwds scans ~/.claude/projects; on the readQueue hot path (every
// IPC status call) that's too much stat traffic, so cache the resolved cwd
// list briefly. Correctness fallback: a brand-new project appears at worst
// CACHE_MS late, and its first write goes through writeSplit which busts the
// cache.
const CACHE_MS = 30_000;
let cwdCache = { at: 0, cwds: [] };

function stateCwds(opts) {
  const now = Date.now();
  if (!opts && now - cwdCache.at < CACHE_MS) return cwdCache.cwds;
  const seen = new Set();
  const cwds = [];
  const add = (cwd) => { if (cwd && !seen.has(cwd)) { seen.add(cwd); cwds.push(cwd); } };
  // Projects that already have a state file are authoritative sources...
  for (const cwd of allProjectCwds(opts)) {
    try { if (fs.existsSync(projectQueuePath(cwd))) add(cwd); } catch { /* skip */ }
  }
  // ...and active projects are included even before their first write.
  for (const cwd of activeProjectCwds(undefined, opts)) add(cwd);
  if (!opts) cwdCache = { at: now, cwds };
  return cwds;
}

function bustCwdCache() {
  cwdCache = { at: 0, cwds: [] };
}

// ---------- merged read ----------

function shapeMachine(raw) {
  const data = raw ? JSON.parse(raw) : {};
  return {
    config: data.config || {},
    scheduledFor: data.scheduledFor ?? null,
    lastRunAt: data.lastRunAt ?? null,
    paused: data.paused ?? null,
  };
}

/**
 * shapeJobs(raw, file) → { jobs, invalid }.
 *
 * Every row is validated against ScheduleJobSchema (see that module's header
 * for why: a row with e.g. `status: 'queued'` — a value outside
 * `ScheduleJobStatus` — silently vanished from every picker, which is the
 * exact 2026-08-07 incident this validation exists to catch). A row that
 * fails is quarantined into `invalid` (never dropped silently, never passed
 * through as-is) and logged once per slug at error level naming the file,
 * the slug, and the failing field. One bad row must not affect the others —
 * this never throws.
 */
function shapeJobs(raw, file) {
  const data = JSON.parse(raw);
  const rows = Array.isArray(data.jobs) ? data.jobs : [];
  const jobs = [];
  const invalid = [];
  for (const row of rows) {
    const result = ScheduleJobSchema.safeParse(row);
    if (result.success) {
      jobs.push(result.data);
      continue;
    }
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    const slug = typeof row?.slug === 'string' ? row.slug : '(unknown slug)';
    console.error(`[queueStore] quarantined invalid job row (file=${file || '(unknown)'}, slug=${slug}): ${issues}`);
    invalid.push({ slug, file: file || null, issues, row });
  }
  return { jobs, invalid };
}

/**
 * readMergedSync(opts?) → { config, jobs, scheduledFor, lastRunAt, paused,
 * unreadable?, unreadablePath?, sourceCwds }.
 *
 * `unreadable` mirrors the old single-file semantics: ANY source file that
 * exists but fails to parse halts scheduling (never treat a project's queue
 * as empty because it read corrupt). `sourceCwds` records every project file
 * consulted so writeSplit can persist "this project now has zero jobs".
 */
function readMergedSync(opts) {
  const out = { config: {}, jobs: [], scheduledFor: null, lastRunAt: null, paused: null, invalidJobs: [] };
  const sourceCwds = [];
  try {
    Object.assign(out, shapeMachine(fs.readFileSync(MACHINE_STATE_PATH, 'utf8')));
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      out.unreadable = `machine state unreadable: ${e?.message}`;
      out.unreadablePath = MACHINE_STATE_PATH;
    }
  }
  for (const cwd of stateCwds(opts)) {
    const file = projectQueuePath(cwd);
    try {
      const { jobs, invalid } = shapeJobs(fs.readFileSync(file, 'utf8'), file);
      out.jobs.push(...jobs);
      out.invalidJobs.push(...invalid);
      sourceCwds.push(cwd);
    } catch (e) {
      if (e?.code === 'ENOENT') { sourceCwds.push(cwd); continue; }
      out.unreadable = out.unreadable || `project queue unreadable (${file}): ${e?.message}`;
      out.unreadablePath = out.unreadablePath || file;
    }
  }
  defineSources(out, sourceCwds);
  return out;
}

/** Async twin of readMergedSync for IPC hot paths. */
async function readMerged(opts) {
  const out = { config: {}, jobs: [], scheduledFor: null, lastRunAt: null, paused: null, invalidJobs: [] };
  const sourceCwds = [];
  try {
    Object.assign(out, shapeMachine(await fsp.readFile(MACHINE_STATE_PATH, 'utf8')));
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      out.unreadable = `machine state unreadable: ${e?.message}`;
      out.unreadablePath = MACHINE_STATE_PATH;
    }
  }
  for (const cwd of stateCwds(opts)) {
    const file = projectQueuePath(cwd);
    try {
      const { jobs, invalid } = shapeJobs(await fsp.readFile(file, 'utf8'), file);
      out.jobs.push(...jobs);
      out.invalidJobs.push(...invalid);
      sourceCwds.push(cwd);
    } catch (e) {
      if (e?.code === 'ENOENT') { sourceCwds.push(cwd); continue; }
      out.unreadable = out.unreadable || `project queue unreadable (${file}): ${e?.message}`;
      out.unreadablePath = out.unreadablePath || file;
    }
  }
  defineSources(out, sourceCwds);
  return out;
}

// Non-enumerable so broadcast/JSON payloads of the state never carry it.
function defineSources(state, sourceCwds) {
  Object.defineProperty(state, 'sourceCwds', {
    value: sourceCwds, enumerable: false, configurable: true, writable: true,
  });
}

// ---------- split write ----------

/**
 * writeSplit(state, defaultCwd) — persist a merged state back to its shards:
 * machine fields → MACHINE_STATE_PATH; jobs grouped by job.cwd (fallback
 * defaultCwd) → each project's state/queue.json. Every cwd the read consulted
 * (state.sourceCwds) is written even when it now holds zero jobs, so
 * deletions stick.
 */
async function writeSplit(state, defaultCwd) {
  await writeJsonAtomic(MACHINE_STATE_PATH, {
    config: state.config,
    scheduledFor: state.scheduledFor ?? null,
    lastRunAt: state.lastRunAt ?? null,
    paused: state.paused ?? null,
  });

  const byCwd = new Map();
  for (const cwd of state.sourceCwds ?? []) byCwd.set(cwd, []);
  for (const job of state.jobs ?? []) {
    const cwd = job.cwd || defaultCwd;
    if (!cwd) continue; // nowhere to put it; job is dropped from persistence rather than crashing
    if (!byCwd.has(cwd)) byCwd.set(cwd, []);
    byCwd.get(cwd).push(job);
  }
  for (const [cwd, jobs] of byCwd) {
    try {
      await writeJsonAtomic(projectQueuePath(cwd), { jobs });
    } catch (e) {
      // A single unwritable project (deleted repo dir, permissions) must not
      // lose every other project's write.
      console.error(`[queueStore] failed to write ${projectQueuePath(cwd)}: ${e?.message}`);
    }
  }
  bustCwdCache();
}

// ---------- legacy migration ----------

/**
 * migrateLegacyGlobalQueue(defaultCwd) — one-time boot split of the retired
 * global queue.json into per-project shards. Shard rows win over legacy rows
 * with the same slug (the shard is newer by construction). The legacy file is
 * renamed to `queue.json.retired-<epoch>` so a rollback can recover it but no
 * reader ever consults it again. Machine fields (config/paused/...) migrate
 * only when no machine file exists yet. Idempotent: no legacy file → no-op.
 */
async function migrateLegacyGlobalQueue(defaultCwd) {
  let raw;
  try {
    raw = await fsp.readFile(LEGACY_QUEUE_PATH, 'utf8');
  } catch {
    return { migrated: false };
  }
  let legacy;
  try {
    legacy = JSON.parse(raw);
  } catch (e) {
    console.error(`[queueStore] legacy queue.json unparseable — leaving in place: ${e?.message}`);
    return { migrated: false, error: e?.message };
  }

  if (!fs.existsSync(MACHINE_STATE_PATH)) {
    await writeJsonAtomic(MACHINE_STATE_PATH, {
      config: legacy.config || {},
      scheduledFor: legacy.scheduledFor ?? null,
      lastRunAt: legacy.lastRunAt ?? null,
      paused: legacy.paused ?? null,
    });
  }

  const legacyJobs = Array.isArray(legacy.jobs) ? legacy.jobs : [];
  const byCwd = new Map();
  for (const job of legacyJobs) {
    const cwd = job.cwd || defaultCwd;
    if (!cwd) continue;
    if (!byCwd.has(cwd)) byCwd.set(cwd, []);
    byCwd.get(cwd).push(job);
  }
  let moved = 0;
  for (const [cwd, jobs] of byCwd) {
    const file = projectQueuePath(cwd);
    let existing = [];
    try { existing = shapeJobs(await fsp.readFile(file, 'utf8'), file).jobs; } catch { /* fresh shard */ }
    const have = new Set(existing.map((j) => j.slug));
    const merged = [...existing, ...jobs.filter((j) => !have.has(j.slug))];
    try {
      await writeJsonAtomic(file, { jobs: merged });
      moved += merged.length - existing.length;
    } catch (e) {
      console.error(`[queueStore] legacy split: failed to write ${file}: ${e?.message}`);
      return { migrated: false, error: e?.message };
    }
  }

  await fsp.rename(LEGACY_QUEUE_PATH, `${LEGACY_QUEUE_PATH}.retired-${Date.now()}`);
  bustCwdCache();
  return { migrated: true, moved, projects: byCwd.size };
}

module.exports = {
  MACHINE_STATE_PATH,
  LEGACY_QUEUE_PATH,
  STATE_SUBPATH,
  projectStateDir,
  projectQueuePath,
  projectHistoryPath,
  stateCwds,
  bustCwdCache,
  shapeJobs,
  readMerged,
  readMergedSync,
  writeSplit,
  migrateLegacyGlobalQueue,
  writeJsonAtomic,
  writeJsonAtomicSync,
};
