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
const { POLL_INTERVAL_MS } = require('./lib/schedulerConfig.cjs');
const { checkPersonaImports } = require('./lib/personaImportHealth.cjs');
const { resolvePrdsDirs } = require('./lib/prdLocations.cjs');
const { migratePrds } = require('./lib/prdMigration.cjs');
const queueStore = require('./lib/queueStore.cjs');
const { DEFAULT_RUNS_DIR, computeReport, isRetentionEnabled, liveKeysFromJobs } = require('./lib/runLogRetention.cjs');

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
    const heartbeatPath = path.join(
      os.homedir(),
      '.claude/session-manager/scheduler-heartbeat.log'
    );
    const heartbeat = readFreshHeartbeat(heartbeatPath);
    const liveness = evaluateTickLiveness(queueState, heartbeat, Date.now(), runningCount);
    status.components.scheduler_queue = {
      ok: !liveness.stalled,
      path: queuePath,
      jobs: Object.keys(queueState.jobs || {}).length,
      running: runningCount,
      failed: failedCount,
      tickLiveness: liveness.reason,
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

  // 6.6. Run-log retention report (informational only — never blocks health).
  // Read-only against the REAL scheduled-plans/runs/ dir: reports current
  // usage + what the configured policy (if any) would remove. Nothing is
  // ever deleted here; see runLogRetention.cjs's header for the safety
  // model. schedulerRunLogRetention lives in scheduler-machine.json's
  // `config`, same home as every other scheduler machine setting.
  try {
    const retentionCfg = queueState?.config?.schedulerRunLogRetention;
    const liveKeys = liveKeysFromJobs(queueState?.jobs || []);
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

  // 7. Summary scoring: ok if all critical components pass.
  // Critical: nodejs, config dir, typescript, build artifact, test infrastructure.
  // Non-fatal: scheduler/transcripts dirs may not exist on fresh install.
  // Informational: app log age (shows if app is running, but not blocking).
  const criticalComponents = ['nodejs', 'config_dir', 'typescript', 'build_artifact', 'test_infrastructure', 'scheduler_queue', 'prd_migration'];
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

module.exports = { check, evaluateTickLiveness, readFreshHeartbeat, evaluatePrdMigrationHealth, TICK_STALL_THRESHOLD_MS, HEARTBEAT_STALE_MS };
