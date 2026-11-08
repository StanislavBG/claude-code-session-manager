/**
 * scheduler-reap-worktree-commit-guard.test.cjs — PRD 2892.
 *
 * reapDeadRunningJobs is the only finalizer for a run adopted at boot. For a
 * worktree run whose sm-job branch never left its base, isBranchAlreadyIntegrated
 * reads true — Bilko job 1685 (exit 0, 19 uncommitted files, zero commits) went
 * straight to completed. The reaper now applies spawnJob's commit guard on
 * that path: no commit of its own → needs_review, with the work salvaged and
 * snapshotted on the row.
 *
 * HOME is a tmp dir BEFORE requiring scheduler.cjs (paths are baked at require).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-reap-worktree-commit-guard.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { git, initRepo, writeRunLog } = require('./_helpers/schedulerHarness.cjs');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-worktree-commit-guard-test-'));
process.env.HOME = tmpHome;

const { reapDeadRunningJobs } = require('../scheduler.cjs');
const { bustCwdCache } = require('../lib/scheduler/queueStore.cjs');

function registerActiveProject(cwd) {
  const slugDir = path.join(tmpHome, '.claude', 'projects', 'fake-project-slug');
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
  require('../lib/activeSessions.cjs').__resetProjectCwdCacheForTests();
}

function writeProjectQueue(cwd, jobs) {
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs }, null, 2));
  for (const job of jobs) {
    const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds');
    fs.mkdirSync(prdsDir, { recursive: true });
    fs.writeFileSync(path.join(prdsDir, `${job.slug}.md`), 'Test fixture PRD.', 'utf8');
  }
  return path.join(stateDir, 'queue.json');
}

/**
 * A project repo + an sm-job/<slug> worktree checkout, an adoptedAtBoot row
 * with a dead pid and a success result log. `prepare(wtDir, projectCwd)` shapes
 * the checkout before the reap.
 */
async function reapScenario(name, { slug = `${name}-job`, row = {}, prepare = () => {} } = {}) {
  const projectCwd = path.join(tmpHome, `${name}-project`);
  initRepo(projectCwd);
  fs.writeFileSync(path.join(projectCwd, 'a.txt'), 'a\n', 'utf8');
  fs.writeFileSync(path.join(projectCwd, 'b.txt'), 'b\n', 'utf8');
  git(['add', '-A'], projectCwd);
  git(['commit', '-q', '-m', 'base files'], projectCwd);
  registerActiveProject(projectCwd);
  const headBefore = git(['rev-parse', 'HEAD'], projectCwd).trim();
  const branch = `sm-job/${slug}`;
  const wtDir = path.join(tmpHome, `${name}-wt`);
  git(['worktree', 'add', '-q', '-b', branch, wtDir], projectCwd);
  await prepare(wtDir, projectCwd, branch);
  const runId = `run-${slug}`;
  const queuePath = writeProjectQueue(projectCwd, [{
    slug,
    status: 'running',
    cwd: projectCwd,
    runId,
    adoptedAtBoot: true,
    runtime: { pid: 999999, cwd: wtDir },
    guardHeadBefore: headBefore,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    ...row,
  }]);
  writeRunLog(runId, slug, ['{"type":"result","subtype":"success","result":"done","is_error":false}']);
  bustCwdCache();
  await reapDeadRunningJobs();
  const reaped = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs.find((j) => j.slug === slug);
  return { row: reaped, projectCwd, headBefore, runId, slug, wtDir };
}

test('zero-commit sm-job branch with 2 modified + 1 untracked file parks needs_review / uncommitted_changes, snapshotted and salvaged', async () => {
  const { row, projectCwd, headBefore, runId, slug } = await reapScenario('dirty', {
    prepare: (wt) => {
      fs.writeFileSync(path.join(wt, 'a.txt'), 'a changed\n', 'utf8');
      fs.writeFileSync(path.join(wt, 'b.txt'), 'b changed\n', 'utf8');
      fs.writeFileSync(path.join(wt, 'new.txt'), 'new\n', 'utf8');
    },
  });
  assert.equal(row.status, 'needs_review');
  assert.equal(row.verifierVerdict, 'uncommitted_changes');
  assert.match(row.error, /3 uncommitted file/);
  assert.ok(row.uncommittedSnapshot && row.uncommittedSnapshot.sha && row.uncommittedSnapshot.ref);
  assert.equal(git(['rev-parse', '--verify', `${row.uncommittedSnapshot.sha}^{commit}`], projectCwd).trim(), row.uncommittedSnapshot.sha);
  assert.equal(git(['rev-parse', row.uncommittedSnapshot.ref], projectCwd).trim(), row.uncommittedSnapshot.sha);
  const files = git(['show', '--name-only', '--format=', row.uncommittedSnapshot.sha], projectCwd).trim().split('\n').sort();
  assert.deepEqual(files, ['a.txt', 'b.txt', 'new.txt']);
  const patch = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId, `${slug}.uncommitted.patch`);
  assert.equal(row.salvagePatch, patch);
  assert.ok(fs.existsSync(patch));
  assert.equal(row.leftoverCount, 3);
  assert.deepEqual([...row.leftoverPaths].sort(), ['a.txt', 'b.txt', 'new.txt']);
  assert.equal(row.landedCommit, undefined);
  assert.equal(git(['rev-parse', 'HEAD'], projectCwd).trim(), headBefore, 'the reaper only parks, never lands');
});

test('zero-commit sm-job branch with a clean checkout parks needs_review / silent_no_op', async () => {
  const { row } = await reapScenario('clean');
  assert.equal(row.status, 'needs_review');
  assert.equal(row.verifierVerdict, 'silent_no_op');
  assert.equal(row.uncommittedSnapshot, undefined);
  assert.equal(row.salvagePatch, undefined);
});

test('a branch with its own commit already merged into HEAD still reaps to completed', async () => {
  const { row } = await reapScenario('merged', {
    prepare: (wt, projectCwd, branch) => {
      fs.writeFileSync(path.join(wt, 'feature.txt'), 'shipped\n', 'utf8');
      git(['add', '-A'], wt);
      git(['commit', '-q', '-m', 'ship feature'], wt);
      git(['merge', '-q', '--ff-only', branch], projectCwd);
    },
  });
  assert.equal(row.status, 'completed');
  assert.equal(row.verifierVerdict, undefined);
  assert.ok(row.landedCommit);
});

test('a zero-commit artifact-only row still reaps to completed', async () => {
  const { row } = await reapScenario('artifact', {
    row: { deliverable: 'artifact', artifactPaths: ['out/report.md'] },
  });
  assert.equal(row.status, 'completed');
  assert.equal(row.verifierVerdict, undefined);
});

test('a zero-edit fix-plan row still reaps to completed', async () => {
  const { row } = await reapScenario('fixplan', { slug: '4242-fix-something' });
  assert.equal(row.status, 'completed');
  assert.equal(row.verifierVerdict, undefined);
});
