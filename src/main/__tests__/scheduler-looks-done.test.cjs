/**
 * scheduler-looks-done.test.cjs — PRD 1102.
 *
 * reverifyNeedsReview() used to have two hard limits that left real, finished
 * work parked red forever: (1) isRescanCandidate required status ===
 * 'needs_review' — a `failed` row was never revisited at all; (2)
 * committedInWindow only looked inside [startedAt, finishedAt+60s], missing a
 * commit that landed later (a retry, a sibling run, a human). This tests the
 * widened pass: a `failed` row whose failure is unverified-shaped (no result
 * event at all — classifyRunOutcome === 'no_result') is now a rescan
 * candidate, and any candidate with a POST-window commit touching its own
 * declared paths gets annotated `looksDone` for a human — never auto-
 * completed. A `failed` row with a genuine result event (a real red gate) must
 * stay excluded, and the pre-existing needs_review heal path must be
 * unaffected.
 *
 * HOME is overridden to a tmp dir BEFORE requiring scheduler.cjs — see
 * scheduler-reap-dead-running-jobs.test.cjs's comment for why (every path
 * this code touches is baked into a top-level const from os.homedir() at
 * require time).
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/scheduler-looks-done.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'looks-done-test-'));
process.env.HOME = tmpHome;

const { reverifyNeedsReview, computeLooksDone } = require('../scheduler.cjs');
const { resolvePrdWriteDir } = require('../lib/prdLocations.cjs');
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

function commitFile(dir, relPath, content, message) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  git(['add', relPath], dir);
  git(['commit', '-q', '-m', message], dir);
}

function registerActiveProject(cwd, slug) {
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  const slugDir = path.join(projectsDir, slug);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
  bustCwdCache();
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

function writePrd(cwd, slug, body) {
  const dir = resolvePrdWriteDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const text = `---\ntitle: Test PRD\ncwd: ${cwd}\nestimateMinutes: 30\n---\n${body}\n`;
  fs.writeFileSync(path.join(dir, `${slug}.md`), text);
}

async function wait(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

test('failed + no result event (unverified-shaped) + later commit touching declared path → looksDone, transitions to needs_review', async () => {
  const projectCwd = path.join(tmpHome, 'proj-171');
  initRepo(projectCwd);
  registerActiveProject(projectCwd, 'proj-171-slug');
  writePrd(projectCwd, '171-example', [
    '# Implementation notes',
    'Edit `src/foo.js`.',
  ].join('\n'));

  const startedAt = new Date().toISOString();
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: '171-example',
      status: 'failed',
      cwd: projectCwd,
      runId: 'run-171',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: 'reaped: process gone (outcome=no_result) (outcome=no_result)',
    },
  ]);
  writeRunLog('run-171', '171-example', ['[scheduler] starting 171-example']); // no result event

  await wait(1100); // git --since has 1s resolution
  commitFile(projectCwd, 'src/foo.js', 'hello', 'fix 171');

  await reverifyNeedsReview();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'needs_review', 'looksDone never auto-completes — only surfaces for a human');
  assert.ok(jobs[0].looksDone, 'expected a looksDone annotation');
  assert.equal(jobs[0].looksDone.commits.length, 1);
  assert.deepEqual(jobs[0].looksDone.paths, ['src/foo.js']);
  assert.match(jobs[0].error, /looks done — 1 commit/);
});

test('failed + a real result event (genuine gate failure) → not a candidate, stays failed untouched', async () => {
  const projectCwd = path.join(tmpHome, 'proj-real-fail');
  initRepo(projectCwd);
  registerActiveProject(projectCwd, 'proj-real-fail-slug');
  writePrd(projectCwd, '05-real-fail', [
    '# Implementation notes',
    'Edit `src/bar.js`.',
  ].join('\n'));

  const startedAt = new Date().toISOString();
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: '05-real-fail',
      status: 'failed',
      cwd: projectCwd,
      runId: 'run-real-fail',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: 'AC gate red: tests failed',
    },
  ]);
  writeRunLog('run-real-fail', '05-real-fail', [
    '[scheduler] starting 05-real-fail',
    JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'tests failed' }),
  ]);

  await wait(1100);
  commitFile(projectCwd, 'src/bar.js', 'hello', 'unrelated later commit touching the declared path');

  await reverifyNeedsReview();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'failed', 'a genuine red gate must never become a heal candidate');
  assert.equal(jobs[0].looksDone, undefined);
  assert.equal(jobs[0].error, 'AC gate red: tests failed');
});

test('needs_review with an in-window commit heals exactly as today (regression — unchanged heal semantics)', async () => {
  const projectCwd = path.join(tmpHome, 'proj-heals-today');
  initRepo(projectCwd);
  registerActiveProject(projectCwd, 'proj-heals-today-slug');
  writePrd(projectCwd, '20-clean-feature', [
    '# Acceptance criteria',
    '- [ ] `npm test` passes',
  ].join('\n'));

  const startedAt = new Date().toISOString();
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: '20-clean-feature',
      status: 'needs_review',
      cwd: projectCwd,
      runId: 'run-clean',
      startedAt,
      finishedAt: new Date().toISOString(),
      verifierVerdict: 'transcript_errors',
      error: 'transcript_errors: stale verdict',
    },
  ]);
  writeRunLog('run-clean', '20-clean-feature', [
    '[scheduler] starting 20-clean-feature',
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] },
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'all tests passed' }] },
    }),
    'SCHEDULER_VERDICT: PASS',
    '[scheduler] exit code=0 (raw code=0 signal=null) duration=10s',
  ]);

  await reverifyNeedsReview();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'completed', 'a clean re-verify on a RESCANNABLE verdict must still heal');
  assert.equal(jobs[0].verifierVerdict, undefined);
  assert.equal(jobs[0].error, null);
});

test('computeLooksDone: no declared paths on the PRD → null, never fabricates evidence', async () => {
  const projectCwd = path.join(tmpHome, 'proj-no-paths');
  initRepo(projectCwd);
  writePrd(projectCwd, '09-no-paths', [
    '# Implementation notes',
    'Just prose here, no backticked file paths.',
  ].join('\n'));

  const startedAt = new Date().toISOString();
  await wait(1100);
  commitFile(projectCwd, 'src/whatever.js', 'x', 'some later commit');

  const job = { slug: '09-no-paths', cwd: projectCwd, startedAt };
  const looksDone = await computeLooksDone(job);
  assert.equal(looksDone, null);
});

test('computeLooksDone: non-git cwd → null without throwing (git-unavailable)', async () => {
  const notARepo = fs.mkdtempSync(path.join(tmpHome, 'not-a-repo-'));
  writePrd(notARepo, '11-no-repo', [
    '# Implementation notes',
    'Edit `src/thing.js`.',
  ].join('\n'));

  const job = { slug: '11-no-repo', cwd: notARepo, startedAt: new Date().toISOString() };
  const looksDone = await computeLooksDone(job);
  assert.equal(looksDone, null);
});
