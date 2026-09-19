'use strict';

/**
 * jobSupervisorRecord.cjs — the one authoritative, SYNCHRONOUS record of a
 * dispatch, written at the same point scheduler.cjs logs `[scheduler] spawned
 * pid=`.
 *
 * Before this, the only durable trace of a dispatch was runtime={pid,...},
 * written asynchronously by a mutate() inside the onPid callback, and the run
 * dir held only the log until an exit path wrote meta.json. A booting process
 * therefore had nothing to tell "my run, still alive" from "dead" and fell
 * back to a ladder of inferences. `<runDir>/<slug>.supervisor.json` is that
 * missing fact.
 *
 * Plain Node, no electron. The run dir is machine-wide scheduler state (not
 * an ops namespace), so queueStore's writeJsonAtomicSync is the right writer.
 * This module never signals a process and adds no cap accounting.
 */

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomicSync } = require('./queueStore.cjs');
const { isDifferentProcess } = require('./procIdentity.cjs');

const SUFFIX = '.supervisor.json';
const META_SUFFIX = '.meta.json';
const INVESTIGATION_EXIT_RE = /\[scheduler\] investigation exit code=/;
const EXIT_TAIL_BYTES = 8 * 1024;

function recordPath(runDir, slug) {
  return path.join(runDir, `${slug}${SUFFIX}`);
}

/**
 * Writes `<runDir>/<slug>.supervisor.json` atomically. Throws on failure —
 * the caller owns the "never fail the dispatch" try/catch. `kind` defaults to
 * "job"; an investigation probe passes kind: "investigation" (and a slug of
 * `<failedSlug>.investigation`, so it never overwrites the failed job's own
 * record in the shared run dir).
 */
function writeSupervisorRecord({
  runDir, slug, cwd, runId, pid, pgid, identity, execCwd, worktreeDir, worktreeBranch,
  sessionId, startedAt, budgetMs, maxDurationMs, idleKillMs, schedulerPid, codeSha, kind,
}) {
  if (!runDir || !slug) throw new Error('writeSupervisorRecord: runDir and slug are required');
  const record = {
    kind: kind || 'job',
    slug, cwd: cwd ?? null, runId: runId ?? null,
    pid: pid ?? null, pgid: pgid ?? null, identity: identity ?? null,
    execCwd: execCwd ?? null, worktreeDir: worktreeDir ?? null, worktreeBranch: worktreeBranch ?? null,
    sessionId: sessionId ?? null, startedAt: startedAt ?? null,
    budgetMs: budgetMs ?? null, maxDurationMs: maxDurationMs ?? null, idleKillMs: idleKillMs ?? null,
    schedulerPid: schedulerPid ?? null, codeSha: codeSha ?? null,
  };
  writeJsonAtomicSync(recordPath(runDir, slug), record);
  return record;
}

/** Returns the parsed record, or null when absent/unparseable. Never throws. */
function readSupervisorRecord(runDir, slug) {
  try {
    const rec = JSON.parse(fs.readFileSync(recordPath(runDir, slug), 'utf8'));
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

/**
 * True when the run has a durable exit marker: `<slug>.meta.json` for a job,
 * the `investigation exit code=` log line for a probe. This is what separates
 * "exited" from "dead" — a dead pid with no marker never got to write one.
 */
function hasExitMarker(runDir, record) {
  try {
    if (record.kind === 'investigation') {
      const failedSlug = String(record.slug).replace(/\.investigation$/, '');
      const logPath = path.join(runDir, `${failedSlug}.investigation.log`);
      const { size } = fs.statSync(logPath);
      const fd = fs.openSync(logPath, 'r');
      try {
        const len = Math.min(size, EXIT_TAIL_BYTES);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        return INVESTIGATION_EXIT_RE.test(buf.toString('utf8'));
      } finally {
        fs.closeSync(fd);
      }
    }
    return fs.existsSync(path.join(runDir, `${record.slug}${META_SUFFIX}`));
  } catch {
    return false;
  }
}

/**
 * Every record under `runsDir/<runId>/` whose file was written within
 * maxAgeMs and which has no exit marker yet. Each entry is the record plus
 * `runDir`. Never throws; an unreadable dir yields [].
 * Complexity: O(run dirs + files in recent dirs).
 */
function listLiveSupervisorRecords(runsDir, { maxAgeMs, now = Date.now() } = {}) {
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const runDir = path.join(runsDir, d.name);
    let files;
    try { files = fs.readdirSync(runDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(SUFFIX)) continue;
      try {
        if (Number.isFinite(maxAgeMs) && now - fs.statSync(path.join(runDir, f)).mtimeMs > maxAgeMs) continue;
        const record = readSupervisorRecord(runDir, f.slice(0, -SUFFIX.length));
        if (!record || hasExitMarker(runDir, record)) continue;
        out.push({ ...record, runDir });
      } catch { /* raced with a delete — skip */ }
    }
  }
  return out;
}

/**
 * Pure. What should a booting process do with this record?
 *   - not alive + exit marker   → 'exited'   (finished; outcome is on disk)
 *   - not alive, no marker      → 'dead'     (died without writing an outcome)
 *   - alive, different process  → 'foreign-pid' (pid recycled; never ours)
 *   - alive, ours, past budget or log stalled past idleKillMs → 'over-budget'
 *   - alive, ours               → 'adopt'
 * `identity` is the live probe of record.pid; isDifferentProcess is
 * fail-closed, so an incomplete identity on either side reads as "same".
 */
function classifyAdoption(record, { identity, pidAlive, logMtimeMs, exitMarker, now = Date.now() } = {}) {
  if (!pidAlive) return exitMarker ? 'exited' : 'dead';
  if (exitMarker) return 'exited';
  if (isDifferentProcess(record.identity, identity)) return 'foreign-pid';
  const ceiling = record.budgetMs > 0 ? record.budgetMs : (record.maxDurationMs > 0 ? record.maxDurationMs : 0);
  if (ceiling > 0 && Number.isFinite(record.startedAt) && now - record.startedAt > ceiling) return 'over-budget';
  if (record.idleKillMs > 0 && Number.isFinite(logMtimeMs) && now - logMtimeMs > record.idleKillMs) return 'over-budget';
  return 'adopt';
}

module.exports = {
  writeSupervisorRecord, readSupervisorRecord, listLiveSupervisorRecords, classifyAdoption, hasExitMarker,
  SUFFIX,
};
