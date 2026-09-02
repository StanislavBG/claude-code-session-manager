/**
 * scheduler-reap-dead-running-jobs.test.cjs — regression cover for PRD 935
 * (reapDeadRunningJobs runningSet desync).
 *
 * spawnJob()'s completion path can write terminal run artifacts to disk and
 * have its child process fully exit, yet still throw between executeJob()
 * resolving and the completion mutate() finishing (e.g. writeQueue's
 * unreadable guard). That throw is swallowed by spawnJob()'s catch, but its
 * `finally` unconditionally deletes the job's slug from the in-memory
 * runningSet — leaving queue.json stuck at status:"running" with a dead pid
 * while runningSet no longer names it. reapDeadRunningJobs() used to gate its
 * entire body on `runningSet.size === 0`, so this exact state made it return
 * before ever reading queue.json — permanently invisible to reconciliation.
 *
 * This test reproduces that desync directly: a project queue.json job row
 * with status:"running" and a dead pid, while runningSet (freshly loaded,
 * never populated) does not contain its slug. It asserts the job still gets
 * reconciled to a terminal status.
 *
 * HOME is overridden to a tmp dir BEFORE requiring scheduler.cjs, since every
 * path this code touches (queueStore's MACHINE_STATE_PATH, activeSessions'
 * project scan root, scheduler.cjs's ROOT/RUNS_DIR, schedulerBatch's
 * DEFAULT_PROJECT_CWD) is baked into a top-level const from os.homedir() at
 * require time — this test must never be able to read or write real state.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-reap-dead-running-jobs.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-dead-running-jobs-test-'));
process.env.HOME = tmpHome;

const { reapDeadRunningJobs, PIDLESS_SPAWN_GRACE_MS } = require('../scheduler.cjs');
const { AUDIT_LOG_PATH } = require('../lib/auditLog.cjs');
// queueStore's cwd discovery is cached for 30s (queueStore.cjs's CACHE_MS) —
// a project registered by THIS test after an earlier test already populated
// that cache (and didn't itself bust it, e.g. because it found nothing
// reapable and returned before ever calling writeQueue) would otherwise be
// invisible to readQueue() for the rest of that window. Bust explicitly
// after registering a new project so each test sees its own fixture.
const { bustCwdCache } = require('../lib/queueStore.cjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
}

function registerActiveProject(cwd) {
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  const slugDir = path.join(projectsDir, 'fake-project-slug');
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

function writeProjectQueue(cwd, jobs) {
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs }, null, 2));
  return path.join(stateDir, 'queue.json');
}

function writeRunLog(runId, slug, lines) {
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, `${slug}.log`), lines.join('\n') + '\n');
}

test('reapDeadRunningJobs reconciles a queue.json row stuck at status:running with a dead pid, even when runningSet does not name its slug (desync repro)', async () => {
  const projectCwd = path.join(tmpHome, 'a-project');
  fs.mkdirSync(projectCwd, { recursive: true });
  registerActiveProject(projectCwd);

  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: 'desynced-job',
      status: 'running',
      cwd: projectCwd,
      runId: 'run-desynced',
      runtime: { pid: 999999 }, // guaranteed-dead pid (see reaperHelpers tests)
    },
  ]);
  writeRunLog('run-desynced', 'desynced-job', [
    '{"type":"result","subtype":"success","result":"done","is_error":false}',
  ]);

  // runningSet is a fresh module-level Set with nothing in it — this is the
  // exact desynced state spawnJob()'s finally block can leave behind.
  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'completed', 'job must be reconciled from disk state, not skipped via the runningSet gate');
  assert.equal(jobs[0].exitCode, 0);
  assert.equal(jobs[0].runtime, undefined);
  assert.equal(jobs[0].gateOutcome, 'passed', 'a success result event maps to gateOutcome:passed');
});

test('reapDeadRunningJobs reaps a pidless row older than PIDLESS_SPAWN_GRACE_MS with an empty run dir as failed, not completed, and audits it', async () => {
  const projectCwd = path.join(tmpHome, 'c-project');
  fs.mkdirSync(projectCwd, { recursive: true });
  registerActiveProject(projectCwd);

  const staleStartedAt = new Date(Date.now() - PIDLESS_SPAWN_GRACE_MS - 60_000).toISOString();
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: 'pidless-zombie',
      status: 'running',
      cwd: projectCwd,
      runId: 'run-pidless-zombie',
      startedAt: staleStartedAt,
      estimateMinutes: 24,
      // no runtime key at all — the spawn never got far enough to record one
    },
  ]);
  // Empty run dir: created, but never written to (the exact 2026-09-01 repro).
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', 'run-pidless-zombie'), { recursive: true });

  const auditSizeBefore = fs.existsSync(AUDIT_LOG_PATH) ? fs.statSync(AUDIT_LOG_PATH).size : 0;

  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'failed', 'an empty run dir must never be reaped as completed');
  assert.match(jobs[0].error, /no runtime\.pid recorded/);
  assert.equal(jobs[0].runtime, undefined);
  assert.equal(jobs[0].gateOutcome, 'never_ran', 'a pidless reap means the gate never had a chance to run');

  const auditText = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').slice(auditSizeBefore);
  const auditLines = auditText.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const pidlessEvent = auditLines.find((e) => e.kind === 'job_reaped_pidless' && e.slug === 'pidless-zombie');
  assert.ok(pidlessEvent, 'reaping a pidless row must leave an audit trace');
});

test('reapDeadRunningJobs leaves a pidless row alone while it is still within the grace window', async () => {
  const projectCwd = path.join(tmpHome, 'd-project');
  fs.mkdirSync(projectCwd, { recursive: true });
  registerActiveProject(projectCwd);

  const freshStartedAt = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: 'mid-flight-spawn',
      status: 'running',
      cwd: projectCwd,
      runId: 'run-mid-flight',
      startedAt: freshStartedAt,
    },
  ]);

  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  assert.equal(jobs[0].status, 'running', 'a genuinely mid-flight spawn must not be reaped');
});

test('reapDeadRunningJobs is a no-op when no job is actually running in queue.json', async () => {
  const projectCwd = path.join(tmpHome, 'b-project');
  fs.mkdirSync(projectCwd, { recursive: true });
  registerActiveProject(projectCwd);
  const queuePath = writeProjectQueue(projectCwd, [
    { slug: 'already-done', status: 'completed', cwd: projectCwd, exitCode: 0 },
  ]);

  await assert.doesNotReject(() => reapDeadRunningJobs());

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'completed');
});

test('reapDeadRunningJobs salvages a delta-scoped in-place patch (PRD 1098) when the row carries a persisted guardBaseline', async () => {
  const projectCwd = path.join(tmpHome, 'e-project');
  initRepo(projectCwd);
  registerActiveProject(projectCwd);

  // Pre-existing WIP present at the recorded pre-run baseline — must never
  // appear in the salvaged patch.
  fs.writeFileSync(path.join(projectCwd, 'human-wip.txt'), 'human wip\n', 'utf8');

  const runId = 'run-vanished-inplace';
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: 'vanished-inplace',
      status: 'running',
      cwd: projectCwd,
      runId,
      runtime: { pid: 999999 }, // guaranteed-dead pid
      guardBaseline: ['human-wip.txt'],
    },
  ]);
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'vanished-inplace.log'), '{"type":"result","subtype":"success","result":"done","is_error":false}\n');

  // The job's own delta, dirtied before its process vanished.
  fs.writeFileSync(path.join(projectCwd, 'README.md'), 'hello\nedited by job\n', 'utf8');
  fs.writeFileSync(path.join(projectCwd, 'job-output.txt'), 'job work\n', 'utf8');

  bustCwdCache();
  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  const row = jobs.find((j) => j.slug === 'vanished-inplace');
  assert.equal(row.status, 'completed');
  assert.ok(row.salvagePatch, 'a salvage patch must be recorded on the row');
  assert.ok(fs.existsSync(row.salvagePatch));
  const patch = fs.readFileSync(row.salvagePatch, 'utf8');
  assert.match(patch, /README\.md/);
  assert.match(patch, /edited by job/);
  assert.match(patch, /job-output\.txt/);
  assert.doesNotMatch(patch, /human wip/, 'baseline WIP must never leak into the salvaged patch');
});

test('reapDeadRunningJobs skips in-place salvage (no whole-tree dump) when the row has no persisted guardBaseline', async () => {
  const projectCwd = path.join(tmpHome, 'f-project');
  initRepo(projectCwd);
  registerActiveProject(projectCwd);

  fs.writeFileSync(path.join(projectCwd, 'human-wip.txt'), 'human wip\n', 'utf8');
  fs.writeFileSync(path.join(projectCwd, 'README.md'), 'hello\nedited by job\n', 'utf8');

  const runId = 'run-vanished-no-baseline';
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: 'vanished-no-baseline',
      status: 'running',
      cwd: projectCwd,
      runId,
      runtime: { pid: 999999 },
      // No guardBaseline field — this PRD's sibling hasn't landed persistence
      // yet, so there's no safe way to distinguish this job's own dirt from
      // the human's pre-existing WIP above.
    },
  ]);
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'vanished-no-baseline.log'), '{"type":"result","subtype":"success","result":"done","is_error":false}\n');

  bustCwdCache();
  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  const row = jobs.find((j) => j.slug === 'vanished-no-baseline');
  assert.equal(row.status, 'completed');
  assert.equal(row.salvagePatch, undefined, 'must skip salvage entirely rather than ever dumping the whole tree');
});
