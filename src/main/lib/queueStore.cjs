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
const crypto = require('node:crypto');
const { allProjectCwds, activeProjectCwds, bustProjectCwdCache } = require('./activeSessions.cjs');
const { assertOpsWrite, resolveOpsRoot, OPS_ROOT_DIR } = require('./opsOwnership.cjs');
const { ScheduleJobSchema } = require('./scheduleJobSchema.cjs');

const MACHINE_STATE_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'scheduler-machine.json');
const LEGACY_QUEUE_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'scheduled-plans', 'queue.json');
const OPS_DIRNAME = OPS_ROOT_DIR;
const STATE_SUBPATH = ['scheduler', 'state'];

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
  // ...and it must not itself sit INSIDE an ops root. Absolute-and-existing
  // was not enough: a transcript records an agent's `cd` into a PRD folder,
  // activeSessions hands that subdirectory over as a project, and this join
  // materializes a second ops root under the first — the doubled
  // `.../prds/session-manager-operations/scheduler/state/queue.json` stubs
  // found in starry-night-ships on 2026-08-30 (14 of them, 8 days' worth).
  // activeSessions.projectRootOf normalizes such a cwd away upstream; this is
  // the fail-closed backstop for every other caller. A queue file below an
  // ops root is always a bug, never a project.
  if (cwd.split(path.sep).includes(OPS_DIRNAME)) {
    throw new Error(
      `projectStateDir: cwd must be a project root, not a path inside ${OPS_DIRNAME}/, got "${cwd}"`,
    );
  }
  // ...and it must not be an EPHEMERAL cwd (inside os.tmpdir(), or a linked
  // git worktree root) — a worktree is torn down when its Epic/job ends, so
  // any state written there is silently destroyed (verified live 2026-09-01
  // as a scheduler shard rewritten every reconcile pass inside a since-deleted
  // epic worktree). That check, and the worktree → main-tree normalization,
  // live in opsOwnership.resolveOpsRoot (PRD 1082) — the one resolver every
  // ops-root reader/writer goes through. `opsInternal: 'refuse'` keeps this
  // WRITER fail-closed on an ops-internal cwd (the guard above shapes the
  // message; the resolver is the backstop).
  let opsRoot;
  try {
    opsRoot = resolveOpsRoot(cwd, { opsInternal: 'refuse' });
  } catch (e) {
    if (e?.ephemeral) {
      const err = new Error(
        `projectStateDir: refusing ephemeral cwd (tmpdir or linked git worktree), got "${cwd}"`,
      );
      err.ephemeral = true;
      throw err;
    }
    throw e;
  }
  return path.join(opsRoot, ...STATE_SUBPATH);
}

function projectQueuePath(cwd) {
  return path.join(projectStateDir(cwd), 'queue.json');
}

function projectHistoryPath(cwd) {
  return path.join(projectStateDir(cwd), 'history.jsonl');
}

/**
 * queuePathOrSkip(cwd, context) → the shard path, or null when `cwd` is not a
 * usable project root. projectStateDir fails closed on a relative or
 * ops-internal cwd; a single such job row (or a stale cached cwd) must not
 * abort a whole read or write of every OTHER project's queue, so callers that
 * loop over many cwds log-and-skip instead of throwing.
 */
function queuePathOrSkip(cwd, context) {
  try {
    return projectQueuePath(cwd);
  } catch (e) {
    if (e?.ephemeral) {
      console.warn(`[queueStore] ${context}: refusing ephemeral cwd "${cwd}" — ${e.message}`);
    } else {
      console.error(`[queueStore] ${context}: skipping invalid project cwd — ${e?.message}`);
    }
    return null;
  }
}

/**
 * Unique tmp path PER CALL, not per process — matches the pid-ts-rand house
 * style seen elsewhere in this tree (e.g. `admin-api.json.tmp-1065370-
 * 1784409837234-vbz3fd`). A pid-only tmp name lets two overlapping writes in
 * the SAME process share one tmp path: write A (long doc) is mid-flight when
 * write B (short doc) opens the same tmp with O_TRUNC and completes first —
 * A's still-buffered remainder then lands past B's EOF at its own advanced fd
 * offset, and the rename publishes the interleaved bytes (rename is atomic;
 * the shared tmp file never was). This is the exact shape of the
 * `scheduler-machine.json.corrupt-*` tears observed 2026-09-07/10/11: a
 * complete valid object followed by the orphaned tail of a longer one.
 */
function uniqueTmpPath(file) {
  return `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function writeJsonAtomicSync(file, value) {
  assertOpsWrite(file, 'scheduler');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTmpPath(file);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(value, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* tmp may not exist, or rename already consumed it */ }
    throw e;
  }
}

async function writeJsonAtomic(file, value) {
  assertOpsWrite(file, 'scheduler');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = uniqueTmpPath(file);
  try {
    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(value, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {}); // tmp may not exist, or rename already consumed it
    throw e;
  }
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
  // Without this chain, activeSessions' own scan cache hands stateCwds a
  // stale list even after this bust — turning a caller's "I just wrote a
  // brand-new project's first state file, make it visible now" into a
  // no-op until activeSessions' independent TTL expires.
  bustProjectCwdCache();
}

// ---------- merged read ----------

function shapeMachine(data) {
  return {
    config: data.config || {},
    scheduledFor: data.scheduledFor ?? null,
    lastRunAt: data.lastRunAt ?? null,
    // Distinct from lastRunAt (stamped only when tickQueue actually launches a
    // job): this is stamped every time tickQueue gets far enough to evaluate
    // the queue at all, whether or not that evaluation ends in a launch. See
    // classifyQueueStarvation's header for why the two must never merge.
    lastDispatchAttemptAt: data.lastDispatchAttemptAt ?? null,
    paused: data.paused ?? null,
    // Launch circuit breaker (lib/launchFailure.cjs): per-persona blocks and
    // the degraded-mode env a persona is currently launching with. Machine
    // state, not per-project: the broken thing is the installed CLI.
    launchBlocks: data.launchBlocks && typeof data.launchBlocks === 'object' ? data.launchBlocks : {},
    launchMitigations: data.launchMitigations && typeof data.launchMitigations === 'object' ? data.launchMitigations : {},
  };
}

// ---------- torn machine-state recovery ----------
//
// scheduler-machine.json has torn 4 times (Sep 7/10/11 `.corrupt-*`, plus a
// `.bak-*`) from the pid-only tmp-path bug fixed above. A pre-existing tear
// (from before this fix, or from any other future writer bug) must not keep
// poisoning every read with `unreadable` — readMergedSync/readMerged recover
// what they can and keep the engine dispatching instead.

/**
 * findLongestValidJsonPrefix(raw) → { value, prefixLength } for the LONGEST
 * leading substring of `raw` that is itself a complete, valid JSON document,
 * or null if none exists. Scans char-by-char tracking object/array nesting
 * depth (skipping over string contents and escapes so a brace inside a
 * string value never miscounts) and attempts JSON.parse every time depth
 * returns to zero. This is exactly the shape of the observed corruption: a
 * complete, valid object followed by the orphaned tail of a longer one — the
 * tail never balances back to depth 0, so it can never win over the real
 * prefix. O(n) in the length of raw.
 */
function findLongestValidJsonPrefix(raw) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let best = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') { depth++; continue; }
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          best = { value: JSON.parse(raw.slice(0, i + 1)), prefixLength: i + 1 };
        } catch { /* balanced at this boundary but not valid JSON — keep scanning */ }
      }
    }
  }
  return best;
}

// Machine state (config/paused/lastRunAt/...) has no owning project cwd of
// its own — it's a Session-Manager runtime concern (see this file's header).
// opsErrorLog.appendError requires a cwd to attribute the line to; this
// project's own ops root is the natural home for a machine-level log entry,
// mirroring scheduler.cjs's own `job.cwd || DEFAULT_PROJECT_CWD` fallback for
// cwd-less machine errors (schedulerBatch.cjs's DEFAULT_PROJECT_CWD).
const MACHINE_STATE_LOG_CWD = path.join(os.homedir(), 'Projects', 'session-manager');

// The truncated tail in the real 2026-09-11 tear contained an orphaned
// `resumeAt` fragment with no way to reconstruct the `paused` object it
// belonged to (the fragment starts mid-string, missing its own `"paused":`
// key and opening brace). That data is genuinely unrecoverable — but silently
// dropping it is what makes recovery unsafe (an active pause could vanish).
// This can't rebuild the lost value, so instead it makes the loss loud: any
// discarded tail that still mentions paused/resumeAt gets called out in the
// log line so a human verifies pause status instead of trusting recovery blindly.
const PAUSED_HINT_RE = /"paused"|resumeAt/;

function logMachineStateRecovery({ level, message, meta }) {
  try {
    const { appendError } = require('./opsErrorLog.cjs');
    appendError({ cwd: MACHINE_STATE_LOG_CWD, scope: 'scheduler', level, message, meta });
  } catch { /* durable logging must never block recovery */ }
  console.error(`[queueStore] ${message}`);
}

/**
 * buildMachineStateRecovery(raw, parseError) → the recovered plain object
 * (never shaped yet) plus what to log. Pure — callers persist it and log it.
 */
function buildMachineStateRecovery(raw, parseError) {
  const prefix = findLongestValidJsonPrefix(raw);
  if (prefix) {
    const trailing = raw.slice(prefix.prefixLength).trim();
    const pausedHint = Boolean(trailing) && PAUSED_HINT_RE.test(trailing);
    return {
      value: prefix.value,
      mode: 'prefix',
      level: 'warn',
      message:
        `scheduler-machine.json was torn (${parseError?.message}) — recovered the longest valid `
        + `JSON prefix (${prefix.prefixLength}/${raw.length} bytes)`
        + (pausedHint
          ? '; the discarded tail looks like it contained paused/resumeAt data that could not '
            + 'be reconstructed — verify pause status manually'
          : ''),
      meta: { path: MACHINE_STATE_PATH, prefixLength: prefix.prefixLength, totalLength: raw.length, pausedHint },
    };
  }
  // No valid JSON prefix at all: fall back to defaults (shapeMachine({}) —
  // callers merge DEFAULT_CONFIG on top) rather than marking `unreadable`,
  // which would halt tickQueue/runDueJobs machine-wide until a human notices.
  return {
    value: {},
    mode: 'default',
    level: 'error',
    message:
      `scheduler-machine.json unrecoverable (${parseError?.message}) — falling back to defaults `
      + 'so dispatch does not silently halt',
    meta: { path: MACHINE_STATE_PATH, totalLength: raw.length },
  };
}

function recoverTornMachineStateSync(raw, parseError) {
  const recovery = buildMachineStateRecovery(raw, parseError);
  logMachineStateRecovery(recovery);
  try {
    writeJsonAtomicSync(MACHINE_STATE_PATH, recovery.value);
  } catch (e) {
    console.error(`[queueStore] failed to persist recovered machine state: ${e?.message}`);
  }
  return recovery;
}

async function recoverTornMachineState(raw, parseError) {
  const recovery = buildMachineStateRecovery(raw, parseError);
  logMachineStateRecovery(recovery);
  try {
    await writeJsonAtomic(MACHINE_STATE_PATH, recovery.value);
  } catch (e) {
    console.error(`[queueStore] failed to persist recovered machine state: ${e?.message}`);
  }
  return recovery;
}

/**
 * loadMachineStateSync/loadMachineState → { shaped, recovered?, recoveryMode? }
 * or { unreadable, unreadablePath } (ENOENT is neither — first-boot empty).
 * A parse failure recovers instead of poisoning the whole merged read.
 */
function loadMachineStateSync() {
  let raw;
  try {
    raw = fs.readFileSync(MACHINE_STATE_PATH, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return {};
    return { unreadable: `machine state unreadable: ${e?.message}`, unreadablePath: MACHINE_STATE_PATH };
  }
  try {
    return { shaped: shapeMachine(JSON.parse(raw)) };
  } catch (parseErr) {
    const recovery = recoverTornMachineStateSync(raw, parseErr);
    return { shaped: shapeMachine(recovery.value), recovered: true, recoveryMode: recovery.mode };
  }
}

async function loadMachineState() {
  let raw;
  try {
    raw = await fsp.readFile(MACHINE_STATE_PATH, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return {};
    return { unreadable: `machine state unreadable: ${e?.message}`, unreadablePath: MACHINE_STATE_PATH };
  }
  try {
    return { shaped: shapeMachine(JSON.parse(raw)) };
  } catch (parseErr) {
    const recovery = await recoverTornMachineState(raw, parseErr);
    return { shaped: shapeMachine(recovery.value), recovered: true, recoveryMode: recovery.mode };
  }
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
  const out = { config: {}, jobs: [], scheduledFor: null, lastRunAt: null, lastDispatchAttemptAt: null, paused: null, launchBlocks: {}, launchMitigations: {}, invalidJobs: [] };
  const sourceCwds = [];
  const machine = loadMachineStateSync();
  if (machine.shaped) {
    Object.assign(out, machine.shaped);
    if (machine.recovered) {
      out.machineStateRecovered = true;
      out.machineStateRecoveryMode = machine.recoveryMode;
    }
  } else if (machine.unreadable) {
    out.unreadable = machine.unreadable;
    out.unreadablePath = machine.unreadablePath;
  }
  for (const cwd of stateCwds(opts)) {
    const file = queuePathOrSkip(cwd, 'read');
    if (!file) continue;
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
  const out = { config: {}, jobs: [], scheduledFor: null, lastRunAt: null, lastDispatchAttemptAt: null, paused: null, launchBlocks: {}, launchMitigations: {}, invalidJobs: [] };
  const sourceCwds = [];
  const machine = await loadMachineState();
  if (machine.shaped) {
    Object.assign(out, machine.shaped);
    if (machine.recovered) {
      out.machineStateRecovered = true;
      out.machineStateRecoveryMode = machine.recoveryMode;
    }
  } else if (machine.unreadable) {
    out.unreadable = machine.unreadable;
    out.unreadablePath = machine.unreadablePath;
  }
  for (const cwd of stateCwds(opts)) {
    const file = queuePathOrSkip(cwd, 'read');
    if (!file) continue;
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
    lastDispatchAttemptAt: state.lastDispatchAttemptAt ?? null,
    paused: state.paused ?? null,
    launchBlocks: state.launchBlocks ?? {},
    launchMitigations: state.launchMitigations ?? {},
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
    const file = queuePathOrSkip(cwd, 'writeSplit');
    if (!file) continue;
    try {
      await writeJsonAtomic(file, { jobs });
    } catch (e) {
      // A single unwritable project (deleted repo dir, permissions) must not
      // lose every other project's write.
      console.error(`[queueStore] failed to write ${file}: ${e?.message}`);
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
    const file = queuePathOrSkip(cwd, 'legacy split');
    if (!file) continue;
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
  findLongestValidJsonPrefix,
};
