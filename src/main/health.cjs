/**
 * health.cjs — health check for session-manager Electron app.
 * Verifies: app startup, IPC responsiveness, scheduler health, watchers active.
 * Exported as check() for /local-project-health skill.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { POLL_INTERVAL_MS, loadGateThreshold } = require('./lib/schedulerConfig.cjs');
const { checkPersonaImports } = require('./lib/personaImportHealth.cjs');
const { checkDelegationReadiness } = require('./lib/delegationReadiness.cjs');
const { resolvePrdsDirs } = require('./lib/prdLocations.cjs');
const { migratePrds } = require('./lib/prdMigration.cjs');
const queueStore = require('./lib/queueStore.cjs');
const { computeStallSummary } = require('./scheduler.cjs');
const { DEFAULT_RUNS_DIR, computeReport, isRetentionEnabled, liveKeysFromJobs } = require('./lib/runLogRetention.cjs');
const { allProjectCwds } = require('../../scripts/lib/activeSessions.cjs');

const MAX_LOG_AGE_MS = 5 * 60_000; // 5 min — warn if no logs this old
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// tickQueue() only fires (and updates lastRunAt) when a batch is actually
// spawned — it does not tick on a fixed cadence — but the poll loop that
// *invokes* tickQueue backs off starting from POLL_INTERVAL_MS (scheduler.cjs
// pollLoop). 3x gives the poll loop three chances to notice free capacity +
// pending work before we call it a stall, absorbing normal jitter (backoff,
// memory-gate deferrals, boot warmup) without waiting so long that a real
// outage goes unnoticed for hours (the 2026-07-14 incident sat stalled for
// 16.5h before anything asserted on it).
const TICK_STALL_MULTIPLIER = 3;
const TICK_STALL_THRESHOLD_MS = TICK_STALL_MULTIPLIER * POLL_INTERVAL_MS;
// A heartbeat line older than this is treated as "the app isn't running /
// we can't observe live utilization" rather than "utilization is low" —
// scheduler-heartbeat.log is only appended to while Electron is running, so
// a stale line here is silent-on-purpose, not evidence of anything.
const HEARTBEAT_STALE_MS = 5 * 60_000;

function runCheck(cmd, cwd = PROJECT_ROOT) {
  try {
    execFileSync('bash', ['-c', cmd], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

// Reads the last line of scheduler-heartbeat.log, if fresh enough to trust.
// Returns null when the file is missing, empty, unparseable, or stale — all
// of which mean "can't observe live utilization right now", not "utilization
// is low".
function readFreshHeartbeat(heartbeatPath) {
  let lines;
  try {
    lines = fs.readFileSync(heartbeatPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return null;
  }
  if (lines.length === 0) return null;
  let entry;
  try {
    entry = JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
  if (typeof entry.ts !== 'number' || Date.now() - entry.ts > HEARTBEAT_STALE_MS) return null;
  return entry;
}

// Evaluates whether the scheduler tick looks stalled: pending work exists,
// there's free capacity to run it, and nothing about the queue's own state
// explains why it hasn't. Kept as a pure function of (queueState, heartbeat,
// now) so it's testable without touching the filesystem.
function evaluateTickLiveness(queueState, heartbeat, now, runningCount) {
  const jobs = queueState.jobs || [];
  const pending = jobs.filter((j) => j.status === 'pending');
  const running = runningCount ?? jobs.filter((j) => j.status === 'running').length;
  const config = queueState.config || {};
  // The scheduler's private concurrencyCap is retired — the machine-wide
  // sessionSlots pool is the only limit. Read it lazily so this stays a pure
  // function of its args when a caller supplies slotCap explicitly.
  const concurrencyCap = queueState.slotCap
    ?? (() => { try { return require('./lib/sessionSlots.cjs').totalSlots(); } catch { return Infinity; } })();

  if (pending.length === 0) return { stalled: false, reason: 'no-pending-jobs' };
  if (queueState.paused) return { stalled: false, reason: 'paused' };
  if (config.enabled === false) return { stalled: false, reason: 'disabled' };
  if (running >= concurrencyCap) return { stalled: false, reason: 'at-capacity' };
  // 'manual' means the operator fires batches by hand — the scheduler is not
  // supposed to pick these up on its own, so pending work sitting with free
  // capacity is the configured behaviour, not a stall. Without this, any queue
  // under a manual policy reported RED forever and drowned out real stalls.
  if (config.firePolicy === 'manual') return { stalled: false, reason: 'manual-fire-policy' };

  const lastRunAt = queueState.lastRunAt ? Date.parse(queueState.lastRunAt) : null;
  // No lastRunAt at all (fresh install, never ticked) — nothing to measure
  // staleness against yet; don't manufacture a false positive.
  if (lastRunAt == null || Number.isNaN(lastRunAt)) {
    return { stalled: false, reason: 'no-lastRunAt', caveat: true };
  }
  const tickAgeMs = now - lastRunAt;
  if (tickAgeMs <= TICK_STALL_THRESHOLD_MS) return { stalled: false, reason: 'recent-tick' };

  // Candidate stall. The 'when-available' firePolicy legitimately holds
  // pending jobs when billing utilization is at/above utilizationThreshold —
  // rule that out before calling it a stall.
  if (config.firePolicy === 'when-available' && typeof config.utilizationThreshold === 'number') {
    if (!heartbeat) {
      return {
        stalled: false,
        caveat: true,
        reason: 'cannot-verify-utilization',
        tickAgeMs,
        oldestPendingSlug: pending[0]?.slug,
      };
    }
    if (typeof heartbeat.utilization === 'number' && heartbeat.utilization >= config.utilizationThreshold) {
      return { stalled: false, reason: 'utilization-at-threshold', utilization: heartbeat.utilization };
    }
  }

  return {
    stalled: true,
    reason: 'stalled',
    tickAgeMs,
    oldestPendingSlug: pending[0]?.slug,
    pendingCount: pending.length,
  };
}

// computeProjectProblemCounts(jobs) → { [cwd]: { failed, needs_review, quarantined } }
//
// health.cjs's machine-wide `failed` count answered "is the machine stuck",
// never "is any ONE project stuck" — a single project with 4 quarantined
// PRDs and nothing else running was invisible in a rollup dominated by other
// projects' healthy jobs. Breaks down every non-terminal-problem status
// (failed/needs_review/quarantined — deliberately NOT 'completed'/'running'/
// 'pending'/'investigating', which are not problems) by project cwd.
function computeProjectProblemCounts(jobs) {
  const byProject = {};
  for (const j of jobs || []) {
    if (j.status !== 'failed' && j.status !== 'needs_review' && j.status !== 'quarantined') continue;
    const cwd = j.cwd || '(unknown)';
    byProject[cwd] = byProject[cwd] || { failed: 0, needs_review: 0, quarantined: 0 };
    byProject[cwd][j.status] += 1;
  }
  return byProject;
}

// evaluatePerProjectStall(stallSummary, lastRunAtIso, now, thresholdMs) →
// { [cwd]: { stalled, pastThreshold?, ageMs?, caveat? } }
//
// computeStallSummary's per-project `stalled` flag (scheduler.cjs) is a
// point-in-time verdict with no duration attached — a project can flip
// stalled/unstalled within a single tick as work completes, so flagging RED
// the instant it's true would false-trip on ordinary queue churn. There is
// no per-project lastRunAt persisted (only a machine-wide one), so this
// reuses that machine-wide timestamp as the best available "has the
// scheduler ticked recently at all" signal, gated per-project by whether
// THAT project currently holds stalled work.
function evaluatePerProjectStall(stallSummary, lastRunAtIso, now, thresholdMs) {
  const lastRunAt = lastRunAtIso ? Date.parse(lastRunAtIso) : null;
  const results = {};
  for (const cwd of Object.keys(stallSummary?.byProject || {})) {
    const counts = stallSummary.byProject[cwd];
    if (!counts.stalled) {
      results[cwd] = { stalled: false };
      continue;
    }
    if (lastRunAt == null || Number.isNaN(lastRunAt)) {
      results[cwd] = { stalled: true, pastThreshold: false, caveat: 'no-lastRunAt' };
      continue;
    }
    const ageMs = now - lastRunAt;
    results[cwd] = { stalled: true, pastThreshold: ageMs >= thresholdMs, ageMs };
  }
  return results;
}

// Parses the "SIZE BUDGET — 12,000 chars" header line out of a project's
// CLAUDE.md text. Tolerant of the em-dash, bold markers, the leading
// blockquote '>', and the thousands comma. Returns null (not a throw, not a
// default) when the line is absent or unparseable — a CLAUDE.md that
// predates this convention has nothing to enforce, and that must stay a
// silent skip rather than a manufactured RED.
function parseClaudeMdBudget(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/SIZE BUDGET\s*[—-]+\s*([\d,]+)\s*chars/i);
  if (!match) return null;
  const n = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Pure comparison of CLAUDE.md's actual byte size against its self-declared
// budget (see parseClaudeMdBudget). budget === null means "no budget
// declared" — skip silently rather than treating it as 0 or infinite.
function evaluateClaudeMdBudget(chars, budget) {
  if (budget == null) return { ok: true, applicable: false };
  const overage = chars - budget;
  if (overage <= 0) return { ok: true, applicable: true, chars, budget };
  return {
    ok: false,
    applicable: true,
    chars,
    budget,
    overage,
    message: `CLAUDE.md is ${chars} chars, over its ${budget}-char budget by ${overage} (see the SIZE BUDGET note in CLAUDE.md)`,
  };
}

// Pure evaluator over migratePrds()'s { moved, skipped, unresolved } result —
// kept separate from the fs-touching check() call site so it's directly
// unit-testable, matching evaluateTickLiveness's pattern.
function evaluatePrdMigrationHealth(migrationResult, legacyPrdsDir) {
  const strandedCount = migrationResult.unresolved.length;
  return {
    ok: strandedCount === 0,
    legacyDir: legacyPrdsDir,
    strandedCount,
    ...(strandedCount > 0 ? { unresolved: migrationResult.unresolved } : {}),
  };
}

// Pure shaping of checkDelegationReadiness()'s result (delegationReadiness.cjs)
// into a health component + issue lines — kept separate from the fs-touching
// check() call site so it's directly unit-testable, matching
// evaluatePrdMigrationHealth's pattern. delegationReadiness.cjs already wraps
// every filesystem read (readJsonSafe / try-catch), so a missing/unreadable
// config surfaces here as one of `checks` with ok:false, never a throw.
function evaluateDelegationChainHealth(delegationResult) {
  const component = { ok: delegationResult.ok, checks: delegationResult.checks };
  const issues = delegationResult.checks
    .filter((c) => !c.ok)
    .map((c) => `Delegation readiness: ${c.label} failed — ${c.detail}${c.fix ? ` (fix: ${c.fix})` : ''}`);
  return { component, issues };
}

// computeEpicIndexDrift(cwd) → { orphan_rows, orphan_files, unmirrored,
//   orphanRowIds, orphanFileIds, unmirroredFiles }
//
// One project's drift between active-index.json (the index) and prompt-
// sessions/<id>.json (the status mirror epicStatusMirror.cjs writes on every
// status-changing write path). Pure filesystem read, never throws — an
// unreadable index or prompt-sessions dir degrades to empty rather than
// aborting the whole health check (matches evaluatePrdMigrationHealth's
// fail-open-on-read spirit).
function computeEpicIndexDrift(cwd) {
  const dir = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  const indexPath = path.join(dir, 'active-index.json');
  let sessions = {};
  let tombstones = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    sessions = parsed && typeof parsed.sessions === 'object' && parsed.sessions ? parsed.sessions : {};
    tombstones = parsed && typeof parsed.tombstones === 'object' && parsed.tombstones ? parsed.tombstones : {};
  } catch { /* missing/unreadable index — treat as empty, not a throw */ }

  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'active-index.json');
  } catch { /* prompt-sessions/ doesn't exist yet — nothing to compare */ }

  const fileIds = new Set(files.map((f) => f.slice(0, -'.json'.length)));
  const orphanRowIds = Object.keys(sessions).filter((id) => !fileIds.has(id));

  const orphanFileIds = [];
  const unmirroredFiles = [];
  for (const file of files) {
    const id = file.slice(0, -'.json'.length);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue; // unreadable file — neither orphan nor unmirrored classification applies
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.status) {
      unmirroredFiles.push(file);
      continue;
    }
    const looksLive = (parsed.status === 'proposed' || parsed.status === 'active') && !parsed.archivedAt;
    const hasRow = Object.prototype.hasOwnProperty.call(sessions, id);
    const isTombstoned = Object.prototype.hasOwnProperty.call(tombstones, id);
    if (looksLive && !hasRow && !isTombstoned) orphanFileIds.push(file);
  }

  return {
    orphan_rows: orphanRowIds.length,
    orphan_files: orphanFileIds.length,
    unmirrored: unmirroredFiles.length,
    orphanRowIds,
    orphanFileIds,
    unmirroredFiles,
  };
}

// evaluateEpicIndexHealth(cwds) → { component, issues }
//
// Shapes computeEpicIndexDrift's per-project result into a health component +
// issue lines, matching evaluateDelegationChainHealth's pattern. Only
// orphan_rows (an index row whose Epic file is gone — the actual data-loss
// signal) is an issue; orphan_files and unmirrored are informational drift,
// not failures — a fresh install or an Epic mid-migration legitimately has
// unmirrored files.
function evaluateEpicIndexHealth(cwds) {
  const byProject = {};
  const issues = [];
  let anyOrphanRows = false;
  for (const cwd of cwds) {
    const drift = computeEpicIndexDrift(cwd);
    byProject[cwd] = {
      orphan_rows: drift.orphan_rows,
      orphan_files: drift.orphan_files,
      unmirrored: drift.unmirrored,
    };
    if (drift.orphan_rows > 0) {
      anyOrphanRows = true;
      issues.push(
        `Epic index drift: ${cwd} has ${drift.orphan_rows} active-index.json row(s) with no matching `
        + `prompt-sessions/<id>.json file (${drift.orphanRowIds.join(', ')})`
      );
    }
  }
  return { component: { ok: !anyOrphanRows, byProject }, issues };
}

async function check() {
  const start = Date.now();
  const status = {
    ok: true,
    timestamp: new Date().toISOString(),
    components: {},
    issues: [],
  };

  // 1. Check Node.js and key dependencies exist.
  try {
    const nodeVer = execFileSync('node', ['--version'], { encoding: 'utf8' }).trim();
    status.components.nodejs = { ok: true, version: nodeVer };
  } catch (e) {
    status.components.nodejs = { ok: false, error: e.message };
    status.issues.push('Node.js not available');
    status.ok = false;
  }

  // 1.5. Check TypeScript compilation (no errors).
  const typesOk = runCheck('npm run typecheck 2>&1 | grep -q "error" && exit 1 || exit 0');
  status.components.typescript = { ok: typesOk };
  if (!typesOk) {
    status.issues.push('TypeScript compilation has errors');
    status.ok = false;
  }

  // 1.6. Check build artifact exists.
  const distExists = fs.existsSync(path.join(PROJECT_ROOT, 'dist/index.html'));
  status.components.build_artifact = { ok: distExists, path: 'dist/index.html' };
  if (!distExists) {
    status.issues.push('Build artifact missing (run: npm run build)');
    status.ok = false;
  }

  // 1.7. Check test infrastructure exists.
  const hasPlaywright = fs.existsSync(path.join(PROJECT_ROOT, 'playwright.config.ts'));
  const hasE2E = fs.existsSync(path.join(PROJECT_ROOT, 'e2e'));
  status.components.test_infrastructure = {
    ok: hasPlaywright && hasE2E,
    playwright: hasPlaywright,
    e2e_dir: hasE2E,
  };

  // 2. Check config directory exists and is writable.
  const configDir = path.join(os.homedir(), '.claude');
  try {
    await fsp.access(configDir, fs.constants.R_OK | fs.constants.W_OK);
    const stat = await fsp.stat(configDir);
    status.components.config_dir = {
      ok: true,
      path: configDir,
      writable: true,
    };
  } catch (e) {
    status.components.config_dir = {
      ok: false,
      error: e.message,
      path: configDir,
    };
    status.issues.push(`Config dir not accessible: ${e.message}`);
    status.ok = false;
  }

  // 3. Check scheduler state (federated, 2026-07-31): machine runtime file +
  // per-project job shards merged via queueStore — the retired global
  // queue.json is no longer consulted.
  const queuePath = queueStore.MACHINE_STATE_PATH;
  let queueState = null;
  try {
    queueState = queueStore.readMergedSync();
    if (queueState.unreadable) throw new Error(queueState.unreadable);
    const runningCount = Object.values(queueState.jobs || {}).filter(
      (j) => j.status === 'running'
    ).length;
    const failedCount = Object.values(queueState.jobs || {}).filter(
      (j) => j.status === 'failed'
    ).length;
    const needsReviewCount = Object.values(queueState.jobs || {}).filter(
      (j) => j.status === 'needs_review'
    ).length;
    const quarantinedCount = Object.values(queueState.jobs || {}).filter(
      (j) => j.status === 'quarantined'
    ).length;
    const heartbeatPath = path.join(
      os.homedir(),
      '.claude/session-manager/scheduler-heartbeat.log'
    );
    const heartbeat = readFreshHeartbeat(heartbeatPath);
    const liveness = evaluateTickLiveness(queueState, heartbeat, Date.now(), runningCount);

    // Per-project rollup (PRD: monitoring must not collapse per-project
    // reality into one machine-wide boolean — see computeStallSummary /
    // computeProjectProblemCounts headers). A project holding ONLY
    // failed/needs_review/quarantined rows (0 running, 0 pending) never
    // trips evaluateTickLiveness above, since that check requires actual
    // pending work — this is what let the burrow project go dark.
    const stallSummary = computeStallSummary(queueState);
    const now = Date.now();
    const perProjectStall = evaluatePerProjectStall(stallSummary, queueState.lastRunAt, now, TICK_STALL_THRESHOLD_MS);
    const projectsPastThreshold = Object.entries(perProjectStall)
      .filter(([, v]) => v.pastThreshold)
      .map(([cwd]) => cwd);

    status.components.scheduler_queue = {
      ok: !liveness.stalled && projectsPastThreshold.length === 0,
      path: queuePath,
      jobs: Object.keys(queueState.jobs || {}).length,
      running: runningCount,
      failed: failedCount,
      needsReview: needsReviewCount,
      quarantined: quarantinedCount,
      byProject: computeProjectProblemCounts(queueState.jobs),
      perProjectStall,
      tickLiveness: liveness.reason,
      // Informational only (PRD 1085): current 1-min loadavg per core vs the
      // launch-gate threshold, so a "nothing is launching" report can be
      // read next to the reason without opening the app.
      loadRatio: (() => {
        const cores = (os.cpus() || []).length;
        const l1 = os.loadavg()[0];
        return cores > 0 && Number.isFinite(l1) ? Number((l1 / cores).toFixed(3)) : null;
      })(),
      loadGateThreshold: loadGateThreshold(),
    };
    if (liveness.stalled) {
      const ageMin = Math.round(liveness.tickAgeMs / 60_000);
      status.components.scheduler_queue.stalledJob = liveness.oldestPendingSlug;
      status.components.scheduler_queue.tickAgeMs = liveness.tickAgeMs;
      status.issues.push(
        `Scheduler tick appears stalled: "${liveness.oldestPendingSlug}" (and ${liveness.pendingCount - 1} other pending job(s)) has been waiting ~${ageMin}m with free capacity and no tick progress`
      );
    } else if (liveness.caveat) {
      status.components.scheduler_queue.caveat =
        liveness.reason === 'cannot-verify-utilization'
          ? `Tick hasn't advanced in a while but scheduler-heartbeat.log is missing/stale, so current billing utilization can't be checked — cannot rule out a legitimate when-available hold`
          : 'No lastRunAt recorded yet — cannot assess tick liveness';
    }
    if (projectsPastThreshold.length > 0) {
      status.components.scheduler_queue.stalledProjects = projectsPastThreshold;
      for (const cwd of projectsPastThreshold) {
        const ageMin = Math.round(perProjectStall[cwd].ageMs / 60_000);
        const counts = status.components.scheduler_queue.byProject[cwd] || {};
        status.issues.push(
          `Project fully stalled: ${cwd} — 0 running, 0 pending, only problem jobs `
          + `(failed=${counts.failed ?? 0} needs_review=${counts.needs_review ?? 0} quarantined=${counts.quarantined ?? 0}), `
          + `no scheduler tick in ~${ageMin}m (threshold ${Math.round(TICK_STALL_THRESHOLD_MS / 60_000)}m)`
        );
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      status.issues.push(`Scheduler queue unreadable: ${e.message}`);
    }
    status.components.scheduler_queue = {
      ok: e.code === 'ENOENT', // ok if queue doesn't exist yet
      path: queuePath,
      exists: false,
      error: e.code === 'ENOENT' ? 'not yet created' : e.message,
    };
  }

  // 4. Check PRDs directories — one per active project
  // (session-manager-operations/scheduler/prds/), summed. PRD 809.
  const prdsDirs = resolvePrdsDirs();
  let totalPrdCount = 0;
  let anyPrdsDirAccessible = false;
  const prdsDirErrors = [];
  for (const dir of prdsDirs) {
    try {
      await fsp.access(dir, fs.constants.R_OK);
      const files = await fsp.readdir(dir);
      totalPrdCount += files.filter((f) => f.endsWith('.md')).length;
      anyPrdsDirAccessible = true;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        prdsDirErrors.push(`${dir}: ${e.message}`);
      }
    }
  }
  if (prdsDirErrors.length > 0) {
    status.issues.push(`PRDs directory not accessible: ${prdsDirErrors.join('; ')}`);
  }
  status.components.scheduler_prds = {
    ok: prdsDirErrors.length === 0,
    dirs: prdsDirs,
    count: totalPrdCount,
    ...(prdsDirs.length === 0 || anyPrdsDirAccessible ? {} : { exists: false }),
  };

  // 4.5. Check for stranded legacy-dir PRDs left behind by runPrdMigration()
  // (scheduler.cjs). A stranded PRD is the cheapest generic leading indicator
  // of a stale installed build vs. the git repo — it fires regardless of
  // *why* the build is stale (the 2026-07-31 burrow-project ENOENT + the
  // 223-file/189-resurrected-job incident both trace back to this).
  const legacyPrdsDir = path.join(
    os.homedir(),
    '.claude/session-manager/scheduled-plans/prds'
  );
  try {
    const migrationResult = await migratePrds(legacyPrdsDir);
    status.components.prd_migration = evaluatePrdMigrationHealth(migrationResult, legacyPrdsDir);
  } catch (e) {
    status.components.prd_migration = { ok: false, legacyDir: legacyPrdsDir, error: e.message };
  }
  if (!status.components.prd_migration.ok) {
    status.issues.push(
      status.components.prd_migration.error
        ? `PRD migration check failed: ${status.components.prd_migration.error}`
        : `PRD migration: ${status.components.prd_migration.strandedCount} file(s) stranded in legacy dir ${legacyPrdsDir} — could not be resolved into a per-project dir`
    );
  }

  // 5. Check transcripts directory (where live session logs are tailed).
  const projectsDir = path.join(os.homedir(), '.claude/projects');
  try {
    await fsp.access(projectsDir, fs.constants.R_OK);
    status.components.transcripts_dir = {
      ok: true,
      path: projectsDir,
    };
  } catch (e) {
    // Not fatal — transcripts dir may not exist until first session.
    status.components.transcripts_dir = {
      ok: true,
      path: projectsDir,
      note: 'not yet created (normal for fresh install)',
    };
  }

  // 6. Check session-manager's own logs (informational, not blocking).
  const smLogsDir = path.join(
    os.homedir(),
    '.claude/session-manager/logs'
  );
  let logAge = null;
  try {
    const files = await fsp.readdir(smLogsDir);
    if (files.length > 0) {
      const latestLog = files.sort().pop();
      const logPath = path.join(smLogsDir, latestLog);
      const stat = await fsp.stat(logPath);
      logAge = Date.now() - stat.mtimeMs;
    }
    status.components.app_logs = {
      ok: true,
      path: smLogsDir,
      latestLogAgeMs: logAge,
      note: logAge ? `Last log ${Math.round(logAge / 60_000)}m ago` : 'app not yet run',
    };
  } catch (e) {
    status.components.app_logs = {
      ok: true,
      path: smLogsDir,
      note: 'logs directory not yet created (normal for fresh installs)',
    };
  }

  // 6.4. Check project CLAUDE.md against its own self-declared SIZE BUDGET
  // header (see the CLAUDE.md size-budget note). Skips silently when no
  // budget line is present — this is not required for every project.
  try {
    const claudeMdPath = path.join(PROJECT_ROOT, 'CLAUDE.md');
    const claudeMdText = fs.readFileSync(claudeMdPath, 'utf8');
    const chars = Buffer.byteLength(claudeMdText, 'utf8');
    const budget = parseClaudeMdBudget(claudeMdText);
    const budgetResult = evaluateClaudeMdBudget(chars, budget);
    status.components.claude_md_budget = budgetResult;
    if (!budgetResult.ok) {
      status.issues.push(budgetResult.message);
    }
  } catch (e) {
    status.components.claude_md_budget = { ok: true, applicable: false };
  }

  // 6.5. Check ~/.claude/CLAUDE.md's @import chain resolves cleanly.
  // Informational only — a broken/stale persona import degrades instruction
  // fidelity, not app health, so it never flips status.ok to false. See
  // personaImportHealth.cjs.
  const personaImports = checkPersonaImports();
  status.components.persona_imports = personaImports;
  if (!personaImports.ok) {
    for (const broken of personaImports.brokenImports) {
      status.issues.push(
        `Persona import broken: "${broken.importPath}" ${broken.exists ? 'is empty' : 'does not exist'}`
      );
    }
  }

  // 6.55. Delegation-chain readiness — answers "can this machine actually
  // delegate work to the scheduler?" (see delegationReadiness.cjs's header:
  // when the scheduler MCP isn't registered, scheduler_create_prd is simply
  // absent from the agent's tool list — no error to catch, so an agent asked
  // to delegate just implements inline instead). Critical: a failing check
  // here means Epics silently stop queueing PRDs on this machine.
  try {
    const delegation = await checkDelegationReadiness({ cwd: PROJECT_ROOT });
    const { component, issues: delegationIssues } = evaluateDelegationChainHealth(delegation);
    status.components.delegation_chain = component;
    status.issues.push(...delegationIssues);
  } catch (e) {
    status.components.delegation_chain = { ok: false, error: e.message };
    status.issues.push(`Delegation readiness check failed: ${e.message}`);
  }

  // 6.6. Run-log retention report (informational only — never blocks health).
  // Read-only against the REAL scheduled-plans/runs/ dir: reports current
  // usage + what the configured policy (if any) would remove. Nothing is
  // ever deleted here; see runLogRetention.cjs's header for the safety
  // model. schedulerRunLogRetention lives in scheduler-machine.json's
  // `config`, same home as every other scheduler machine setting.
  try {
    const retentionCfg = queueState?.config?.schedulerRunLogRetention;
    const liveKeys = liveKeysFromJobs(queueState?.jobs || [], { runsDir: DEFAULT_RUNS_DIR });
    const report = computeReport(
      DEFAULT_RUNS_DIR,
      retentionCfg?.policy || {},
      { liveKeys }
    );
    status.components.run_log_retention = {
      ok: true,
      path: DEFAULT_RUNS_DIR,
      totalBytes: report.usage.totalBytes,
      dirCount: report.usage.dirCount,
      runCount: report.usage.runCount,
      oldestRunAt: report.usage.oldestRunAt,
      policyConfigured: !!retentionCfg?.policy,
      retentionEnabled: isRetentionEnabled(queueState?.config || {}),
      wouldRemoveCount: report.eligibleSummary.count,
      wouldRemoveBytes: report.eligibleSummary.bytes,
      wouldRemoveDirs: report.removableDirs.length,
    };
  } catch (e) {
    status.components.run_log_retention = { ok: true, error: e.message };
  }

  // 6.65. Epic index drift — orphan_rows/orphan_files/unmirrored across every
  // project this machine has ever opened (allProjectCwds, no recency filter
  // — a quiet project still owns its Epics). See computeEpicIndexDrift's
  // header.
  try {
    const { component, issues: epicIndexIssues } = evaluateEpicIndexHealth(allProjectCwds());
    status.components.epic_index = component;
    status.issues.push(...epicIndexIssues);
  } catch (e) {
    status.components.epic_index = { ok: false, error: e.message };
    status.issues.push(`Epic index health check failed: ${e.message}`);
  }

  // 7. Summary scoring: ok if all critical components pass.
  // Critical: nodejs, config dir, typescript, build artifact, test infrastructure.
  // Non-fatal: scheduler/transcripts dirs may not exist on fresh install.
  // Informational: app log age (shows if app is running, but not blocking).
  const criticalComponents = ['nodejs', 'config_dir', 'typescript', 'build_artifact', 'test_infrastructure', 'scheduler_queue', 'prd_migration', 'claude_md_budget', 'delegation_chain'];
  status.ok = criticalComponents.every((c) => status.components[c]?.ok !== false);

  status.elapsedMs = Date.now() - start;
  return status;
}

// CLI entry point: `node src/main/health.cjs`
if (require.main === module) {
  (async () => {
    const result = await check();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  })();
}

module.exports = {
  check,
  evaluateTickLiveness,
  readFreshHeartbeat,
  evaluatePrdMigrationHealth,
  evaluateDelegationChainHealth,
  computeEpicIndexDrift,
  evaluateEpicIndexHealth,
  computeProjectProblemCounts,
  evaluatePerProjectStall,
  parseClaudeMdBudget,
  evaluateClaudeMdBudget,
  TICK_STALL_THRESHOLD_MS,
  HEARTBEAT_STALE_MS,
};
