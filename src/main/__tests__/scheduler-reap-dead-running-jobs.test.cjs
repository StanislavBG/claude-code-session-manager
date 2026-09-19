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
const { auditLogPath } = require('../lib/auditLog.cjs');
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

  const auditSizeBefore = fs.existsSync(auditLogPath()) ? fs.statSync(auditLogPath()).size : 0;

  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'failed', 'an empty run dir must never be reaped as completed');
  assert.match(jobs[0].error, /no runtime\.pid recorded/);
  assert.equal(jobs[0].runtime, undefined);
  assert.equal(jobs[0].gateOutcome, 'never_ran', 'a pidless reap means the gate never had a chance to run');

  const auditText = fs.readFileSync(auditLogPath(), 'utf8').slice(auditSizeBefore);
  const auditLines = auditText.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const pidlessEvent = auditLines.find((e) => e.kind === 'job_reaped_pidless' && e.slug === 'pidless-zombie');
  assert.ok(pidlessEvent, 'reaping a pidless row must leave an audit trace');
});

test('reapDeadRunningJobs: a pidless row past grace with a landedCommit already recorded is routed to needs_review, not failed, naming the commit sha (PRD 1173)', async () => {
  const projectCwd = path.join(tmpHome, 'c3-project-pidless-with-landed-commit');
  fs.mkdirSync(projectCwd, { recursive: true });
  registerActiveProject(projectCwd);

  const staleStartedAt = new Date(Date.now() - PIDLESS_SPAWN_GRACE_MS - 60_000).toISOString();
  const landedSha = 'f3e35a7f9e49f13a9eb8c338b0d086160e32a87f';
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: 'shipped-but-pidless',
      status: 'running',
      cwd: projectCwd,
      runId: 'run-shipped-but-pidless',
      startedAt: staleStartedAt,
      landedCommit: landedSha,
      // no runtime key at all — the spawn never got far enough to record one
    },
  ]);
  // Empty run dir, same shape as the sibling 'failed' test below — the
  // landedCommit evidence must be what changes the outcome, not the log.
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', 'run-shipped-but-pidless'), { recursive: true });

  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  const row = jobs.find((j) => j.slug === 'shipped-but-pidless');
  assert.equal(row.status, 'needs_review', 'a row with proof of landed work must never be transitioned to failed by the pidless branch');
  assert.equal(row.landedCommit, landedSha, 'the pre-existing landedCommit must be preserved on the row');
  assert.match(row.error, new RegExp(landedSha), 'the reason must name the recorded commit sha');
  assert.equal(row.verifierVerdict, 'pidless_reap_with_landed_commit');

  // Scan the whole audit log for THIS slug's event rather than slicing by a
  // byte offset from statSync — a prior test's audit entries can contain
  // multi-byte characters (e.g. an em dash in a reaper reason string), and
  // slicing a utf8-decoded JS string (UTF-16 code units) at a byte offset
  // then silently corrupts the boundary. The slug is unique to this test.
  const auditLines = fs.readFileSync(auditLogPath(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const pidlessEvent = auditLines.find((e) => e.kind === 'job_reaped_pidless' && e.slug === 'shipped-but-pidless');
  assert.ok(pidlessEvent, 'reaping this row must still leave an audit trace');
  assert.equal(pidlessEvent.landedCommit, landedSha, 'the audit event must carry the landed-commit evidence so the decision is reconstructable from the audit log alone');
});

test('reapDeadRunningJobs clears runId on a pidless reap whose run dir holds only a sibling slug\'s files', async () => {
  const projectCwd = path.join(tmpHome, 'c2-project-batch-sibling');
  fs.mkdirSync(projectCwd, { recursive: true });
  registerActiveProject(projectCwd);

  const staleStartedAt = new Date(Date.now() - PIDLESS_SPAWN_GRACE_MS - 60_000).toISOString();
  // Both jobs were dispatched into the SAME batch runId dir (pickRunDir's
  // header: "tickQueue hands ONE shared batch dir to every spawnJob in the
  // batch"). 'sibling-that-ran' actually spawned and wrote its own log;
  // 'never-spawned' never got a pid and never wrote anything of its own.
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: 'zzq8712-pidless-batch-row',
      status: 'running',
      cwd: projectCwd,
      runId: 'run-shared-batch',
      startedAt: staleStartedAt,
      // no runtime key at all — the spawn never got far enough to record one
    },
  ]);
  // Only the sibling's log exists in the shared batch dir.
  writeRunLog('run-shared-batch', 'zzq8712-sibling-that-ran', [
    '{"type":"result","subtype":"success","result":"done","is_error":false}',
  ]);

  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  const row = jobs.find((j) => j.slug === 'zzq8712-pidless-batch-row');
  assert.equal(row.status, 'failed');
  assert.equal(row.runId, null, 'a runId whose dir holds no artifact for this slug must not survive the reap');
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
      // Includes the untracked session-manager-operations/ dir itself (git
      // status --porcelain reports an untracked DIRECTORY, not the file
      // inside it) — writeProjectQueue below writes queue.json INSIDE this
      // same git repo, so it's part of the true pre-run baseline exactly
      // like human-wip.txt.
      guardBaseline: ['human-wip.txt', 'session-manager-operations/'],
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
  // PRD 1133: a successful-looking reap that left everything uncommitted
  // (no branch, HEAD never moved) must never read as 'completed' — this is
  // exactly the dangerous shape the reaper now proves against.
  assert.equal(row.status, 'needs_review');
  assert.equal(row.verifierVerdict, 'reaped_without_integration');
  assert.ok(row.salvagePatch, 'a salvage patch must be recorded on the row');
  assert.ok(fs.existsSync(row.salvagePatch));
  const patch = fs.readFileSync(row.salvagePatch, 'utf8');
  assert.match(patch, /README\.md/);
  assert.match(patch, /edited by job/);
  assert.match(patch, /job-output\.txt/);
  assert.doesNotMatch(patch, /human wip/, 'baseline WIP must never leak into the salvaged patch');
  assert.equal(row.leftoverCount, 2, 'the reaper must attribute the job\'s own delta (README.md + job-output.txt), never the baseline WIP');
  assert.deepEqual(new Set(row.leftoverPaths), new Set(['README.md', 'job-output.txt']));
});

test('reapDeadRunningJobs: a failed reap with a persisted guardBaseline names the leftover count in its transition reason and error', async () => {
  const projectCwd = path.join(tmpHome, 'g-project');
  initRepo(projectCwd);
  registerActiveProject(projectCwd);

  const runId = 'run-vanished-failed';
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: 'vanished-failed',
      status: 'running',
      cwd: projectCwd,
      runId,
      runtime: { pid: 999999 },
      // Includes the untracked session-manager-operations/ dir itself — see
      // the comment on the salvage test above for why.
      guardBaseline: ['session-manager-operations/'],
    },
  ]);
  // Empty run dir → classifyRunOutcome finds no result event → 'no_result' → failed.
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId), { recursive: true });

  fs.writeFileSync(path.join(projectCwd, 'partial-work.txt'), 'unfinished\n', 'utf8');

  bustCwdCache();
  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  const row = jobs.find((j) => j.slug === 'vanished-failed');
  assert.equal(row.status, 'failed');
  assert.equal(row.leftoverCount, 1);
  assert.deepEqual(row.leftoverPaths, ['partial-work.txt']);
  assert.match(row.error, /left 1 files uncommitted/, 'the leftover count must be visible in the error string, not just a separate field');
  const lastTransition = row.statusHistory[row.statusHistory.length - 1];
  assert.match(lastTransition.reason, /left 1 files uncommitted/);
});

test('reapDeadRunningJobs: a rate-limited death (api_error_status:429) is reset to pending, not stamped failed, and the reason names the rate limit (PRD 1117)', async () => {
  const projectCwd = path.join(tmpHome, 'h-project');
  fs.mkdirSync(projectCwd, { recursive: true });
  registerActiveProject(projectCwd);

  const runId = 'run-rate-limited';
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: 'rate-limited-job',
      status: 'running',
      cwd: projectCwd,
      runId,
      runtime: { pid: 999999 }, // guaranteed-dead pid — the reaper won the race
    },
  ]);
  // Real-shape tail: a 429 result event, the exact signal the reaper
  // previously had no branch for and stamped terminal 'failed'.
  writeRunLog(runId, 'rate-limited-job', [
    '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"rateLimitType":"seven_day","result":"You\'ve reached your Fable limit.","uuid":"x"}',
  ]);

  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  const row = jobs.find((j) => j.slug === 'rate-limited-job');
  assert.equal(row.status, 'pending', 'a rate-limited reap must be retryable, never terminal failed');
  assert.match(row.error, /rate limit/i, 'the reset reason must name the rate limit, not read as a generic reap failure');
  assert.equal(row.runtime, undefined);
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
      // No guardBaseline field — simulates a row whose owning process
      // vanished before spawnJob's dispatch-time persist-mutate ever ran, so
      // there's no safe way to distinguish this job's own dirt from the
      // human's pre-existing WIP above.
    },
  ]);
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'vanished-no-baseline.log'), '{"type":"result","subtype":"success","result":"done","is_error":false}\n');

  bustCwdCache();
  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  const row = jobs.find((j) => j.slug === 'vanished-no-baseline');
  // PRD 1133: no commit landed (HEAD never moved) — must not read as 'completed'
  // just because the log's own result event looked clean.
  assert.equal(row.status, 'needs_review');
  assert.equal(row.verifierVerdict, 'reaped_without_integration');
  assert.equal(row.salvagePatch, undefined, 'must skip salvage entirely rather than ever dumping the whole tree');
  assert.equal(row.leftoverPaths, undefined, 'no baseline means no safe attribution — must not guess');
  assert.equal(row.leftoverCount, undefined);
});

// ---------- PRD 1133: reaper must prove integration before 'completed' ----------

test('reapDeadRunningJobs: a worktree job shaped like PRD 1118 (branch un-integrated, landedCommit absent) comes out needs_review, naming the branch, and never merges it', async () => {
  const projectCwd = path.join(tmpHome, 'i-project-1118-shape');
  initRepo(projectCwd);
  registerActiveProject(projectCwd);

  const headBefore = git(['rev-parse', 'HEAD'], projectCwd).trim();
  const slug = '1118-pause-until-the-binding-rate-limit-window';
  const branch = `sm-job/${slug}`;
  // Simulate the job's own worktree branch: one real commit, never merged
  // back into the main tree (exactly the live 1118 shape — "one real commit,
  // +301", stranded on sm-job/1118-... with landedCommit undefined).
  git(['checkout', '-b', branch], projectCwd);
  fs.writeFileSync(path.join(projectCwd, 'rateLimitWindow.cjs'), 'module.exports = {};\n', 'utf8');
  git(['add', '-A'], projectCwd);
  git(['commit', '-q', '-m', 'add rateLimitWindow.cjs'], projectCwd);
  // Back to the original tip (detached is fine — reap only reads guardCwd's
  // current HEAD, it never needs a named branch checked out).
  git(['checkout', headBefore], projectCwd);

  const runId = `run-${slug}`;
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug,
      status: 'running',
      cwd: projectCwd,
      runId,
      runtime: { pid: 999999 }, // guaranteed-dead pid
      guardHeadBefore: headBefore,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    },
  ]);
  writeRunLog(runId, slug, ['{"type":"result","subtype":"success","result":"done","is_error":false}']);

  bustCwdCache();
  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  const row = jobs.find((j) => j.slug === slug);
  assert.equal(row.status, 'needs_review', 'a successful-looking result event must not be enough on its own');
  assert.equal(row.verifierVerdict, 'reaped_without_integration');
  assert.match(row.error, new RegExp(branch.replace('/', '\\/')), 'the parked reason must name the branch that still holds the work');
  assert.equal(row.landedCommit, undefined, 'nothing was actually merged, so landedCommit must stay unset');

  // The branch itself must survive untouched — this reap must never attempt
  // (let alone perform) the merge.
  const branchStillExists = git(['rev-parse', '--verify', branch], projectCwd).trim();
  assert.ok(branchStillExists, 'the un-integrated branch must be preserved, not merged or deleted, by a mere reap');
  assert.equal(git(['rev-parse', 'HEAD'], projectCwd).trim(), headBefore, 'guardCwd HEAD must not have moved — no merge was performed');
});

test('reapDeadRunningJobs: a worktree job whose branch is already fully integrated into HEAD comes out completed, with landedCommit stamped', async () => {
  const projectCwd = path.join(tmpHome, 'j-project-real-success');
  initRepo(projectCwd);
  registerActiveProject(projectCwd);

  const headBefore = git(['rev-parse', 'HEAD'], projectCwd).trim();
  const slug = 'real-successful-worktree-run';
  const branch = `sm-job/${slug}`;
  git(['checkout', '-b', branch], projectCwd);
  fs.writeFileSync(path.join(projectCwd, 'feature.txt'), 'shipped\n', 'utf8');
  git(['add', '-A'], projectCwd);
  git(['commit', '-q', '-m', 'ship feature'], projectCwd);
  git(['checkout', headBefore], projectCwd); // back to the pre-branch tip (detached)
  // Simulate a normal completion pass having already integrated the branch
  // (integrateJobBranch's own fast-forward path) BEFORE the process vanished
  // between that merge and the queue write landing.
  git(['merge', '--ff-only', branch], projectCwd);
  const headAfterMerge = git(['rev-parse', 'HEAD'], projectCwd).trim();

  const runId = `run-${slug}`;
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug,
      status: 'running',
      cwd: projectCwd,
      runId,
      runtime: { pid: 999999 },
      guardHeadBefore: headBefore,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    },
  ]);
  writeRunLog(runId, slug, ['{"type":"result","subtype":"success","result":"done","is_error":false}']);

  bustCwdCache();
  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  const row = jobs.find((j) => j.slug === slug);
  assert.equal(row.status, 'completed', 'the branch is already an ancestor of HEAD — the work genuinely landed');
  assert.equal(row.verifierVerdict, undefined);
  assert.equal(row.landedCommit, headAfterMerge, 'HEAD advanced during the run window — landedCommit must be stamped');
});

test('reapDeadRunningJobs: a worktree job whose branch never diverged from its base (legitimate no-op) still completes, not punished', async () => {
  const projectCwd = path.join(tmpHome, 'k-project-noop-worktree');
  initRepo(projectCwd);
  registerActiveProject(projectCwd);

  const headBefore = git(['rev-parse', 'HEAD'], projectCwd).trim();
  const slug = 'noop-worktree-job';
  const branch = `sm-job/${slug}`;
  // Branch created but nothing ever committed on it — a genuine no-op run.
  git(['branch', branch], projectCwd);

  const runId = `run-${slug}`;
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug,
      status: 'running',
      cwd: projectCwd,
      runId,
      runtime: { pid: 999999 },
      guardHeadBefore: headBefore,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    },
  ]);
  writeRunLog(runId, slug, ['{"type":"result","subtype":"success","result":"done","is_error":false}']);

  bustCwdCache();
  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  const row = jobs.find((j) => j.slug === slug);
  assert.equal(row.status, 'completed', 'a branch with no new commits is a legitimate no-op, not a finish-protocol violation');
  assert.equal(row.verifierVerdict, undefined);
  assert.equal(row.landedCommit, undefined, 'HEAD never moved — nothing to stamp');
});

test('reapDeadRunningJobs: an in-place run in a git repo whose HEAD genuinely advanced during the run window completes, with landedCommit stamped', async () => {
  const projectCwd = path.join(tmpHome, 'l-project-inplace-success');
  initRepo(projectCwd);
  registerActiveProject(projectCwd);

  const headBefore = git(['rev-parse', 'HEAD'], projectCwd).trim();
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(path.join(projectCwd, 'shipped.txt'), 'done\n', 'utf8');
  git(['add', '-A'], projectCwd);
  git(['commit', '-q', '-m', 'in-place job commit'], projectCwd);
  const headAfter = git(['rev-parse', 'HEAD'], projectCwd).trim();

  const slug = 'inplace-job-real-commit';
  const runId = `run-${slug}`;
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug,
      status: 'running',
      cwd: projectCwd,
      runId,
      runtime: { pid: 999999 },
      guardHeadBefore: headBefore,
      startedAt,
    },
  ]);
  writeRunLog(runId, slug, ['{"type":"result","subtype":"success","result":"done","is_error":false}']);

  bustCwdCache();
  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  const row = jobs.find((j) => j.slug === slug);
  assert.equal(row.status, 'completed');
  assert.equal(row.verifierVerdict, undefined);
  assert.equal(row.landedCommit, headAfter);
});

test('reapDeadRunningJobs: a non-git cwd skips the integration check entirely, preserving today\'s behaviour', async () => {
  const projectCwd = path.join(tmpHome, 'm-project-non-git');
  fs.mkdirSync(projectCwd, { recursive: true });
  registerActiveProject(projectCwd);

  const slug = 'non-git-cwd-job';
  const runId = `run-${slug}`;
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug,
      status: 'running',
      cwd: projectCwd,
      runId,
      runtime: { pid: 999999 },
      // No git repo at all — the integration/HEAD-advance check must be
      // skipped, never treated as a failure to prove landing.
    },
  ]);
  writeRunLog(runId, slug, ['{"type":"result","subtype":"success","result":"done","is_error":false}']);

  bustCwdCache();
  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  const row = jobs.find((j) => j.slug === slug);
  assert.equal(row.status, 'completed', 'a non-git cwd must keep today\'s behaviour — the check is meaningless there');
  assert.equal(row.verifierVerdict, undefined);
});

// ---------- Reaper landed-commit evidence gate (job 1192 incident) ----------
//
// job 1192 shipped a real 3-file commit (7bf5fa3f...) and was still
// stamped 'failed' by reapDeadRunningJobs because a `landedCommit` field
// being present was never actually verified against the repo. These cover
// the dead-pid branch specifically (runtime.pid recorded, process
// confirmed dead) rather than the pidless branch: a pidless row with a
// non-empty landedCommit is already fully owned by PRD 1173's
// resolvePidlessFailureOverride (routes to needs_review, tested above) —
// this PRD's gate exists for the shape 1173 doesn't cover, where the
// reaper would otherwise fall straight through to 'failed' with no
// evidence check of any kind.

test('reapDeadRunningJobs: a dead-pid reap with a git-resolvable landedCommit transitions to completed, naming the reap cause and the evidence, source reapDeadRunningJobs:landed', async () => {
  const projectCwd = path.join(tmpHome, 'n-project-landed-commit-evidence');
  initRepo(projectCwd);
  registerActiveProject(projectCwd);

  fs.writeFileSync(path.join(projectCwd, 'shipped.txt'), 'done\n', 'utf8');
  git(['add', '-A'], projectCwd);
  git(['commit', '-q', '-m', 'ship the PRD work'], projectCwd);
  const landedSha = git(['rev-parse', 'HEAD'], projectCwd).trim();

  const runId = 'run-landed-commit-evidence';
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: 'landed-but-reaped',
      status: 'running',
      cwd: projectCwd,
      runId,
      runtime: { pid: 999999 }, // guaranteed-dead pid
      landedCommit: landedSha,
    },
  ]);
  // Empty run dir → classifyRunOutcome finds no result event → 'no_result'
  // → without this PRD's gate this would stamp 'failed' despite the real
  // commit already sitting on HEAD.
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId), { recursive: true });

  bustCwdCache();
  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  const row = jobs.find((j) => j.slug === 'landed-but-reaped');
  assert.equal(row.status, 'completed', 'a resolvable landedCommit must promote the reap to completed, not failed');
  assert.equal(row.landedCommit, landedSha);
  assert.equal(row.exitCode, 0);
  assert.equal(row.error, null);
  const lastTransition = row.statusHistory[row.statusHistory.length - 1];
  assert.equal(lastTransition.source, 'reapDeadRunningJobs:landed');
  assert.match(lastTransition.reason, /process gone/, 'the reap cause must still be named');
  assert.match(lastTransition.reason, new RegExp(landedSha), 'the evidence sha must be named');
  assert.match(lastTransition.reason, /resolves/);
});

test('reapDeadRunningJobs: a dead-pid reap with an unresolvable (stale) landedCommit keeps today\'s behaviour exactly — failed, same reason shape, same source', async () => {
  const projectCwd = path.join(tmpHome, 'o-project-stale-landed-commit');
  initRepo(projectCwd);
  registerActiveProject(projectCwd);

  const staleSha = '0123456789abcdef0123456789abcdef01234567'; // well-formed sha, never committed anywhere
  const runId = 'run-stale-landed-commit';
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: 'stale-landed-commit',
      status: 'running',
      cwd: projectCwd,
      runId,
      runtime: { pid: 999999 },
      landedCommit: staleSha,
    },
  ]);
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId), { recursive: true });

  bustCwdCache();
  await reapDeadRunningJobs();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  const row = jobs.find((j) => j.slug === 'stale-landed-commit');
  assert.equal(row.status, 'failed', 'a landedCommit that does not resolve in the repo must never be trusted as evidence');
  assert.equal(row.landedCommit, staleSha, 'the stale field is left on the row untouched, never cleared');
  assert.match(row.error, /reaped: process gone \(outcome=no_result\)/);
  assert.doesNotMatch(row.error, /resolves/);
  const lastTransition = row.statusHistory[row.statusHistory.length - 1];
  assert.equal(lastTransition.source, 'reapDeadRunningJobs', 'no evidence found — source must stay the plain reaper source, not :landed');
});

test('reapDeadRunningJobs: a landedCommit that cannot be git-resolved because the row cwd is not a usable git repo falls back to failed without throwing out of the reaper', async () => {
  const projectCwd = path.join(tmpHome, 'p-project-unresolvable-cwd');
  // Deliberately NOT initRepo(projectCwd) — no `.git` at all, the same
  // "cwd git resolution cannot possibly succeed" shape a deleted/torn-down
  // worktree checkout would produce (git itself errors identically for
  // "not a git repository" and "no such directory" — both must be caught
  // and treated as no-evidence, never thrown out of the reaper).
  fs.mkdirSync(projectCwd, { recursive: true });
  registerActiveProject(projectCwd);

  const runId = 'run-unresolvable-cwd';
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: 'unresolvable-cwd-job',
      status: 'running',
      cwd: projectCwd,
      runId,
      runtime: { pid: 999999 },
      landedCommit: '89abcdef89abcdef89abcdef89abcdef89abcdef',
    },
  ]);
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId), { recursive: true });

  bustCwdCache();
  await assert.doesNotReject(() => reapDeadRunningJobs(), 'a bounded git spawn failure/timeout must never escape the reaper as an unhandled rejection');

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  const row = jobs.find((j) => j.slug === 'unresolvable-cwd-job');
  assert.equal(row.status, 'failed', 'an unresolvable cwd must fall back to failed, exactly like no evidence at all');
});
