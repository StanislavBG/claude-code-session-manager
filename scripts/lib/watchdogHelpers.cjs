'use strict';

// watchdogHelpers.cjs — pure helpers for scheduler-watchdog.cjs (no side effects).
// Testable without spawning the watchdog entry script.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { activeProjectCwds } = require('./activeSessions.cjs');

// Relative path into src/main/lib/ — the watchdog is external to the app, so
// we re-use the helpers without importing any Electron code.
// (Same claudePidAlive + classifyRunOutcome used by scheduler.cjs boot reconciliation.)
const { claudePidAlive, classifyRunOutcome, ORPHAN_REQUEUE_CAP } = require('../../src/main/lib/reaperHelpers.cjs');

// Mirrors scheduler.cjs:215 (single source of truth there; kept in sync here).
const DEFAULT_HEARTBEAT_PATH = path.join(
  os.homedir(), '.claude', 'session-manager', 'scheduler-heartbeat.log',
);

// The in-app heartbeat ticks every 60 s; 3 missed ticks = stale.
const DEFAULT_MAX_AGE_MS = 180_000;

// Tail bytes to read — enough to hold several JSON heartbeat lines without
// loading a potentially 1 MB file. O(1) in file size.
const TAIL_BYTES = 4096;

/**
 * readLastHeartbeat(heartbeatPath?) → object | null
 *
 * Reads the last ~4 KB of the heartbeat log, reverse-scans for the last
 * non-empty line, and returns the full parsed JSON object.
 * Returns null on missing / empty / unparseable file.
 *
 * Single source of truth for the file-read + reverse-scan logic; used by
 * readLastHeartbeatTs(), heartbeatFresh(), and reconcileQueueOffline().
 */
function readLastHeartbeat(heartbeatPath = DEFAULT_HEARTBEAT_PATH) {
  let buf;
  try {
    const stat = fs.statSync(heartbeatPath);
    const size = stat.size;
    if (size === 0) return null;

    const readSize = Math.min(TAIL_BYTES, size);
    const fd = fs.openSync(heartbeatPath, 'r');
    try {
      buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, size - readSize);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = buf.toString('utf8').split('\n');
  // Walk lines in reverse to find last non-empty parseable one.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * readLastHeartbeatTs(heartbeatPath?) → number | null
 *
 * Returns the `ts` field (epoch ms) from the last heartbeat entry.
 * Returns null on missing / empty / unparseable file or missing ts field.
 */
function readLastHeartbeatTs(heartbeatPath = DEFAULT_HEARTBEAT_PATH) {
  const entry = readLastHeartbeat(heartbeatPath);
  return (entry !== null && typeof entry.ts === 'number') ? entry.ts : null;
}

/**
 * heartbeatFresh(heartbeatPath?, maxAgeMs?) → boolean
 *
 * Returns true iff the last heartbeat ts is within maxAgeMs of `now`.
 * Missing / empty / unparseable file → false.
 */
function heartbeatFresh(heartbeatPath = DEFAULT_HEARTBEAT_PATH, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const ts = readLastHeartbeatTs(heartbeatPath);
  if (ts === null) return false;
  return (Date.now() - ts) < maxAgeMs;
}

// Default paths — callers can override via opts for testing.
const DEFAULT_QUEUE_PATH = path.join(
  os.homedir(), '.claude', 'session-manager', 'scheduled-plans', 'queue.json',
);
const DEFAULT_RUNS_DIR = path.join(
  os.homedir(), '.claude', 'session-manager', 'scheduled-plans', 'runs',
);
const DEFAULT_PRDS_DIR = path.join(
  os.homedir(), '.claude', 'session-manager', 'scheduled-plans', 'prds',
);
const DEFAULT_SKILL_PATH = path.join(
  os.homedir(), '.claude', 'skills', 'process-feedback', 'SKILL.md',
);
const DEFAULT_STANDARDS_PATH = path.join(
  os.homedir(), '.claude', 'skills', 'develop', 'standards.md',
);

/**
 * reconcileQueueOffline(opts?) → { reconciled: boolean, reapedCount: number, errors: string[] }
 *
 * Safe offline reconciliation of queue.json when the in-app scheduler is down.
 *
 * Guard: re-checks heartbeatFresh() at the top and returns a no-op result if the
 * app is alive — the app owns the mutate lock and concurrent writes corrupt the queue.
 *
 * When stale: for each running job whose PID is dead (or whose app is dead):
 *   success    → completed
 *   failed     → failed
 *   no_result / unknown → re-queue to pending (bounded by ORPHAN_REQUEUE_CAP)
 *
 * If the PID is still alive but the app is dead, SIGTERM it before classifying.
 *
 * Atomic write: queue.json.tmp-<pid>-<ts> → rename (mirrors config.cjs writeJsonSync).
 *
 * O(n) in number of running jobs; classifyRunOutcome tails up to 64 KB per job.
 */
function reconcileQueueOffline({
  heartbeatPath = DEFAULT_HEARTBEAT_PATH,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  queuePath = DEFAULT_QUEUE_PATH,
  runsDir = DEFAULT_RUNS_DIR,
} = {}) {
  // Safety guard: never touch queue.json while the app is alive.
  if (heartbeatFresh(heartbeatPath, maxAgeMs)) {
    return { reconciled: false, reapedCount: 0, errors: [] };
  }

  // Second guard: stale heartbeat may just mean the app is under load.
  // If the heartbeat carries a pid and that process is still alive, the app
  // is running — do not reap. Backward-compat: if no pid field, fall through
  // to the classic age-only behavior so pre-existing orphan cleanup still works.
  const lastHeartbeat = readLastHeartbeat(heartbeatPath);
  if (lastHeartbeat !== null && typeof lastHeartbeat.pid === 'number') {
    try {
      process.kill(lastHeartbeat.pid, 0); // liveness check only — no signal
      // pid is alive → app is running; abort reap.
      return { reconciled: false, reapedCount: 0, errors: [] };
    } catch {
      // ESRCH → process is gone; proceed with reap.
    }
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  } catch (e) {
    return { reconciled: false, reapedCount: 0, errors: [`read queue.json: ${e?.message}`] };
  }

  const errors = [];
  let reapedCount = 0;
  let changed = false;
  // Stamp once so all jobs reapedQueue in the same watchdog run share a finishedAt.
  const reconciledAt = new Date().toISOString();

  for (const j of (state.jobs ?? [])) {
    if (j.status !== 'running') continue;

    const logPath = j.runId ? path.join(runsDir, j.runId, `${j.slug}.log`) : null;
    const pid = j.runtime?.pid;

    // If the orphan is still alive we must NOT classify its log this tick — the
    // process is still running/flushing, so a partial or in-flight log would be
    // misread (e.g. a job about to emit result:success gets read as no_result and
    // re-queued, double-running the same PRD while the original still edits the
    // repo). Instead escalate across ticks (SIGTERM → SIGKILL), matching the
    // scheduler's kill discipline (process group first, then the pid).
    //
    // Bounded so a job can't wedge in 'running' forever: after we've sent BOTH
    // SIGTERM and SIGKILL on prior ticks, the real claude process is gone. A pid
    // still reported "alive" here is an unkillable defunct — or, on macOS (no
    // /proc, so claudePidAlive can't verify identity), a REUSED pid we must stop
    // signalling. Either way we fall through to finalize from the now-settled log.
    if (pid && claudePidAlive(pid)) {
      if (!j.runtime.watchdogSigtermAt) {
        try { process.kill(-pid, 'SIGTERM'); }
        catch { try { process.kill(pid, 'SIGTERM'); } catch { /* ESRCH — died between checks */ } }
        j.runtime.watchdogSigtermAt = reconciledAt;
        changed = true;
        continue; // leave status 'running'; revisit next tick
      }
      if (!j.runtime.watchdogSigkillAt) {
        try { process.kill(-pid, 'SIGKILL'); }
        catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ESRCH */ } }
        j.runtime.watchdogSigkillAt = reconciledAt;
        changed = true;
        continue; // give SIGKILL a tick to land before finalizing
      }
      // SIGTERM + SIGKILL already sent on earlier ticks → stop deferring; the
      // original process is dead. Fall through to classify + finalize.
    }

    const outcome = logPath ? classifyRunOutcome(logPath) : 'unknown';

    if (outcome === 'success') {
      j.status = 'completed';
      j.exitCode = 0;
      j.error = null;
      j.finishedAt = reconciledAt;
      delete j.runtime;
      delete j.verifierVerdict;
    } else if (outcome === 'failed') {
      j.status = 'failed';
      j.exitCode = j.exitCode ?? 1;
      j.error = 'orphaned: watchdog found failed result while app was down';
      j.finishedAt = reconciledAt;
      delete j.runtime;
      delete j.verifierVerdict;
    } else {
      // no_result / unknown: interrupted with no evidence of merit failure — re-queue bounded.
      const tries = j.orphanRetries ?? 0;
      if (tries < ORPHAN_REQUEUE_CAP) {
        j.status = 'pending';
        j.runId = null;
        j.startedAt = null;
        j.finishedAt = null;
        j.exitCode = null;
        j.error = `orphaned: watchdog re-queued (attempt ${tries + 1}/${ORPHAN_REQUEUE_CAP})`;
        j.orphanRetries = tries + 1;
        delete j.runtime;
        delete j.verifierVerdict;
      } else {
        j.status = 'failed';
        j.exitCode = j.exitCode ?? 1;
        j.error = `orphaned: watchdog exhausted ${ORPHAN_REQUEUE_CAP} re-queue attempts`;
        j.finishedAt = reconciledAt;
        delete j.runtime;
        delete j.verifierVerdict;
      }
    }

    reapedCount++;
    changed = true;
  }

  if (!changed) {
    return { reconciled: false, reapedCount: 0, errors };
  }

  // Atomic write: tmp-<pid>-<ts> → rename (mirrors config.cjs writeJsonSync).
  const tmpPath = `${queuePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, queuePath);
  } catch (e) {
    errors.push(`write queue.json: ${e?.message}`);
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    return { reconciled: false, reapedCount: 0, errors };
  }

  return { reconciled: true, reapedCount, errors };
}

// ── slugify ──────────────────────────────────────────────────────────────────

/** Lowercase, non-alphanumeric runs → single `-`, strip leading/trailing `-`. */
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ── YAML frontmatter stripper ─────────────────────────────────────────────────

/**
 * Strip leading YAML frontmatter block (---\n…\n---) from skill/standards files
 * so they can be inlined cleanly into a PRD body.
 */
function stripFrontmatter(content) {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content;
  return content.slice(end + 4).replace(/^\n/, '');
}

/**
 * Strip a leading H1 line (`# …\n`) — used to drop the `# Engineering standards`
 * heading from standards.md before adding our own `## Engineering standards` heading.
 */
function stripLeadingH1(content) {
  return content.replace(/^# [^\n]*\n/, '');
}

// ── hasOpenFeedback ───────────────────────────────────────────────────────────

/**
 * hasOpenFeedback(cwd) → boolean
 *
 * Returns true iff `<cwd>/feedback/` or `<cwd>/external-feedback/` exists AND
 * contains at least one *.md file directly in its root (i.e. NOT inside
 * `processed/` or any subdirectory). Pure filesystem check — no LLM call.
 *
 * Mirrors process-feedback skill step 0 (cheap quick-exit signal).
 * Complexity: O(F) where F ≤ entries in the feedback folder root.
 */
function hasOpenFeedback(cwd) {
  for (const folderName of ['feedback', 'external-feedback']) {
    const folderPath = path.join(cwd, folderName);
    let entries;
    try {
      entries = fs.readdirSync(folderPath);
    } catch {
      continue; // folder does not exist
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      // README.md is the folder's convention doc, not an open feedback item —
      // counting it makes a folder with only a README look perpetually "pending".
      if (entry.toLowerCase() === 'readme.md') continue;
      try {
        const st = fs.statSync(path.join(folderPath, entry));
        if (st.isFile()) return true;
      } catch { continue; }
    }
  }
  return false;
}

// ── emitFeedbackPRD ──────────────────────────────────────────────────────────

/**
 * emitFeedbackPRD(cwd, opts?) → { emitted: boolean, slug?: string, prdPath?: string, reason?: string }
 *
 * De-dups against queue.json (pending/running jobs whose slug matches
 * `^\d+-feedback-<project>$`). If a match exists, returns { emitted: false, reason: 'duplicate' }.
 *
 * Otherwise picks the next free NN by scanning prdsDir, writes a self-contained
 * PRD file with the inlined process-feedback procedure + engineering standards,
 * and returns { emitted: true, slug, prdPath }.
 *
 * Never writes to queue.json — the app's reconcile picks up new PRD files.
 * Atomic write: tmp → rename (mirrors config.cjs writeJsonSync pattern).
 *
 * Complexity: O(P) over PRD files in prdsDir + O(J) over queue jobs.
 */
function emitFeedbackPRD(cwd, {
  prdsDir = DEFAULT_PRDS_DIR,
  queuePath = DEFAULT_QUEUE_PATH,
  skillPath = DEFAULT_SKILL_PATH,
  standardsPath = DEFAULT_STANDARDS_PATH,
} = {}) {
  const project = slugify(path.basename(cwd));

  // De-dup: check queue.json for pending/running feedback job for this project.
  let queueState = { jobs: [] };
  try {
    queueState = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  } catch { /* queue.json may not exist */ }

  // project only contains [a-z0-9-] after slugify — no regex metachar escaping needed.
  const dupRe = new RegExp(`^\\d+-feedback-${project}$`);
  const isDuplicate = (queueState.jobs ?? []).some(
    (j) => (j.status === 'pending' || j.status === 'running') && dupRe.test(j.slug),
  );
  if (isDuplicate) {
    return { emitted: false, reason: 'duplicate' };
  }

  // Pick next NN: max existing NN prefix + 1. O(P) scan.
  // We ALSO dedup against the prds dir here: while the app is down it never
  // ingests new PRD files into queue.json, so the queue check above can't see a
  // feedback PRD we already wrote on a previous tick. Without this, every stale
  // watchdog tick emits a fresh NN-feedback-<project>.md, unbounded.
  const prdDupRe = new RegExp(`^\\d+-feedback-${project}\\.md$`);
  let maxNN = 0;
  let prdFiles = [];
  try {
    prdFiles = fs.readdirSync(prdsDir);
  } catch { /* prdsDir may not exist yet */ }
  for (const f of prdFiles) {
    if (prdDupRe.test(f)) {
      return { emitted: false, reason: 'duplicate' };
    }
    const m = f.match(/^(\d+)-/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxNN) maxNN = n;
    }
  }
  const nn = String(maxNN + 1).padStart(2, '0');
  const slug = `${nn}-feedback-${project}`;
  const prdPath = path.join(prdsDir, `${slug}.md`);

  // Read and inline skill content.
  let rawSkill = '';
  try {
    rawSkill = fs.readFileSync(skillPath, 'utf8');
  } catch {
    process.stderr.write(`[emitFeedbackPRD] warning: skill file not readable: ${skillPath}\n`);
  }
  const skillBody = stripFrontmatter(rawSkill).trim();

  // Read and inline standards — strip H1 so our ## heading is the section anchor.
  let rawStandards = '';
  try {
    rawStandards = fs.readFileSync(standardsPath, 'utf8');
  } catch {
    process.stderr.write(`[emitFeedbackPRD] warning: standards file not readable: ${standardsPath}\n`);
  }
  const standardsBody = stripLeadingH1(stripFrontmatter(rawStandards)).trim();

  const projectName = path.basename(cwd);
  const body = [
    '---',
    `title: Process feedback for ${projectName}`,
    `cwd: ${cwd}`,
    'estimateMinutes: 15',
    '---',
    '',
    '# Goal',
    '',
    `Process the inbound feedback folder for ${projectName}. The quick-exit (step 0 below)`,
    'means this run bails in milliseconds if no open items exist — safe to execute even if',
    'feedback was already cleared between scheduling and execution.',
    '',
    '# Acceptance criteria',
    '',
    '- [ ] All open feedback items evaluated and either queued via /develop, declined with RESOLUTION, or forwarded upstream.',
    '- [ ] Processed items archived to feedback/processed/ (or external-feedback/processed/) with RESOLUTION notes.',
    '- [ ] feedback/README.md self-improved with lessons from this pass.',
    '- [ ] timeout 60 git diff --exit-code runs clean (no uncommitted inline work).',
    '',
    '# Implementation notes',
    '',
    'Follow the inlined process-feedback procedure below exactly. No skills are loaded in',
    'headless execution — the procedure is fully self-contained. Use /develop for any work',
    'that belongs to this project; never implement feedback inline.',
    '',
    '# Out of scope',
    '',
    '- Implementing feedback items directly (that is /develop → scheduler).',
    '- Cross-project feedback beyond filing upstream items.',
    '',
    skillBody,
    '',
    '## Engineering standards',
    '',
    standardsBody,
  ].join('\n');

  // Atomic write: tmp-<pid>-<ts> → rename (mirrors config.cjs writeJsonSync).
  const tmpPath = `${prdPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(prdsDir, { recursive: true });
    fs.writeFileSync(tmpPath, body + '\n', 'utf8');
    fs.renameSync(tmpPath, prdPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw e;
  }

  return { emitted: true, slug, prdPath };
}

// ── sweep ─────────────────────────────────────────────────────────────────────

/**
 * sweep(opts?) → { scanned: number, emitted: number, skipped: number }
 *
 * For each active-session cwd (from activeProjectCwds), cheaply checks for open
 * feedback. Projects without open feedback cost a readdir per folder name — no LLM.
 * Projects with open feedback get a PRD emitted into prdsDir (de-duped against queue).
 *
 * Never mutates queue.json — only adds PRD files, so it is safe to run while the
 * in-app scheduler is alive.
 *
 * Complexity: O(C × F) where C = active cwds (≤50) and F = root entries per
 * feedback folder (typically small).
 *
 * opts:
 *   projectsDir  — forwarded to activeProjectCwds for testing
 *   prdsDir, queuePath, skillPath, standardsPath — forwarded to emitFeedbackPRD
 */
function sweep({
  projectsDir,
  prdsDir = DEFAULT_PRDS_DIR,
  queuePath = DEFAULT_QUEUE_PATH,
  skillPath = DEFAULT_SKILL_PATH,
  standardsPath = DEFAULT_STANDARDS_PATH,
} = {}) {
  const activeOpts = {};
  if (projectsDir !== undefined) activeOpts.projectsDir = projectsDir;

  const cwds = activeProjectCwds(90, activeOpts);

  let scanned = 0;
  let emitted = 0;
  let skipped = 0;

  for (const cwd of cwds) {
    scanned++;
    if (!hasOpenFeedback(cwd)) continue;

    let result;
    try {
      result = emitFeedbackPRD(cwd, { prdsDir, queuePath, skillPath, standardsPath });
    } catch (e) {
      process.stderr.write(`[sweep] error emitting PRD for ${cwd}: ${e?.message}\n`);
      continue;
    }

    if (result.emitted) {
      emitted++;
      process.stderr.write(`[sweep] emitted ${result.slug} for ${cwd}\n`);
    } else {
      skipped++;
      process.stderr.write(`[sweep] skipped ${cwd} (${result.reason})\n`);
    }
  }

  process.stderr.write(`[sweep] scanned=${scanned} emitted=${emitted} skipped=${skipped}\n`);
  return { scanned, emitted, skipped };
}

module.exports = {
  readLastHeartbeat,
  readLastHeartbeatTs,
  heartbeatFresh,
  reconcileQueueOffline,
  hasOpenFeedback,
  emitFeedbackPRD,
  sweep,
  DEFAULT_HEARTBEAT_PATH,
  DEFAULT_MAX_AGE_MS,
};
