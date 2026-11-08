/**
 * scheduler-reap-lands-pass-run.test.cjs — PRD 2905.
 *
 * reapDeadRunningJobs finalizes every run adopted across an app restart. Bilko
 * PRD 1716 committed, printed SCHEDULER_VERDICT: PASS under an adopting
 * scheduler, and was parked reaped_without_integration because the reaper
 * never landed a branch. It now integrates the sm-job branch (fork-bounded)
 * when — and only when — the run printed its own PASS line.
 *
 * The base is rewritten after the fork (local main rebased mid-run), so the
 * fork bound is what keeps the replay to the job's own commit.
 *
 * HOME is a tmp dir BEFORE requiring scheduler.cjs (paths are baked at require).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-reap-lands-pass-run.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { git, initRepo, writeRunLog } = require('./_helpers/schedulerHarness.cjs');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-lands-pass-run-test-'));
process.env.HOME = tmpHome;

const { reapDeadRunningJobs } = require('../scheduler.cjs');
const { bustCwdCache } = require('../lib/scheduler/queueStore.cjs');

const PASS_RESULT = '{"type":"result","subtype":"success","result":"done\\nSCHEDULER_VERDICT: PASS","is_error":false}';
const PLAIN_RESULT = '{"type":"result","subtype":"success","result":"done","is_error":false}';

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

function sLines(line5) {
  const lines = [];
  for (let i = 1; i <= 10; i++) lines.push(i === 5 ? line5 : `l${i}`);
  return lines.join('\n') + '\n';
}

function commitS(cwd, line5, msg) {
  fs.writeFileSync(path.join(cwd, 's.txt'), sLines(line5), 'utf8');
  git(['add', 's.txt'], cwd);
  git(['commit', '-q', '-m', msg], cwd);
}

/**
 * Base B (s.txt l1..l10), commit P (line 5 -> P), job worktree at P with the
 * job commit, then main reset to B, commit U (line 5 -> U), commit P2
 * (line 5 -> U+P): the base was rewritten after the job forked.
 */
async function rewrittenBaseScenario(name, { jobCommit, resultLine = PASS_RESULT }) {
  const slug = `${name}-job`;
  const projectCwd = path.join(tmpHome, `${name}-project`);
  initRepo(projectCwd);
  fs.writeFileSync(path.join(projectCwd, '.gitignore'), 'session-manager-operations/\n', 'utf8');
  git(['add', '.gitignore'], projectCwd);
  git(['commit', '-q', '-m', 'ignore ops root'], projectCwd);
  commitS(projectCwd, 'l5', 'base B');
  const baseB = git(['rev-parse', 'HEAD'], projectCwd).trim();
  commitS(projectCwd, 'P', 'commit P');
  const forkSha = git(['rev-parse', 'HEAD'], projectCwd).trim();
  registerActiveProject(projectCwd);

  const branch = `sm-job/${slug}`;
  const wtDir = path.join(tmpHome, `${name}-wt`);
  git(['worktree', 'add', '-q', '-b', branch, wtDir, forkSha], projectCwd);
  jobCommit(wtDir);
  const jobSubject = git(['log', '-1', '--format=%s'], wtDir).trim();

  git(['reset', '-q', '--hard', baseB], projectCwd);
  commitS(projectCwd, 'U', 'commit U');
  commitS(projectCwd, 'U+P', 'commit P2');
  const headBeforeReap = git(['rev-parse', 'HEAD'], projectCwd).trim();

  const runId = `run-${slug}`;
  const queuePath = writeProjectQueue(projectCwd, [{
    slug,
    status: 'running',
    cwd: projectCwd,
    runId,
    adoptedAtBoot: true,
    runtime: { pid: 999999, cwd: wtDir },
    guardHeadBefore: forkSha,
    worktreeForkSha: forkSha,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  }]);
  writeRunLog(runId, slug, [resultLine]);
  bustCwdCache();
  await reapDeadRunningJobs();
  const row = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs.find((j) => j.slug === slug);
  return { row, projectCwd, wtDir, branch, jobSubject, headBeforeReap };
}

test('(a) adopted PASS run with a job commit on a rewritten base lands the job commit and completes', async () => {
  const { row, projectCwd, jobSubject, headBeforeReap, branch } = await rewrittenBaseScenario('lands', {
    jobCommit: (wt) => {
      fs.writeFileSync(path.join(wt, 'j.txt'), 'job\n', 'utf8');
      git(['add', 'j.txt'], wt);
      git(['commit', '-q', '-m', 'job commit J'], wt);
    },
  });
  assert.equal(row.status, 'completed', `expected completed, got ${row.status} (${row.verifierVerdict}: ${row.error})`);
  assert.equal(row.verifierVerdict, undefined);
  assert.equal(git(['log', '-1', '--format=%s', 'HEAD'], projectCwd).trim(), jobSubject);
  assert.equal(git(['rev-parse', 'HEAD~1'], projectCwd).trim(), headBeforeReap, 'only the job commit replays onto the rewritten base');
  assert.equal(fs.readFileSync(path.join(projectCwd, 's.txt'), 'utf8'), sLines('U+P'));
  assert.equal(fs.readFileSync(path.join(projectCwd, 'j.txt'), 'utf8'), 'job\n');
  assert.equal(row.landedCommit, git(['rev-parse', 'HEAD'], projectCwd).trim());
  assert.equal(git(['branch', '--list', branch], projectCwd).trim(), '', 'the landed sm-job branch is cleaned up');
});

test('(b) adopted PASS run whose job commit conflicts parks worktree_integration_failed naming s.txt', async () => {
  const { row, projectCwd, headBeforeReap } = await rewrittenBaseScenario('conflict', {
    jobCommit: (wt) => commitS(wt, 'J', 'job commit J conflicts'),
  });
  assert.equal(row.status, 'needs_review');
  assert.equal(row.verifierVerdict, 'worktree_integration_failed');
  assert.match(row.error, /s\.txt/);
  assert.equal(row.integrationFailureKind, 'content_conflict');
  assert.equal(git(['rev-parse', 'HEAD'], projectCwd).trim(), headBeforeReap, 'a failed integration leaves HEAD untouched');
});

test('(c) adopted success run without a PASS line keeps the reaped_without_integration park', async () => {
  const { row, projectCwd, headBeforeReap } = await rewrittenBaseScenario('nopass', {
    resultLine: PLAIN_RESULT,
    jobCommit: (wt) => {
      fs.writeFileSync(path.join(wt, 'j.txt'), 'job\n', 'utf8');
      git(['add', 'j.txt'], wt);
      git(['commit', '-q', '-m', 'job commit J'], wt);
    },
  });
  assert.equal(row.status, 'needs_review');
  assert.equal(row.verifierVerdict, 'reaped_without_integration');
  assert.equal(git(['rev-parse', 'HEAD'], projectCwd).trim(), headBeforeReap, 'no PASS line, no landing');
});
