/**
 * scheduler-transcript-commit-heal.test.cjs — a needs_review pass_no_commit row
 * whose run log names its own commit (on HEAD, inside the run window) heals;
 * a commit outside the window does not. Unit cases for ownTranscriptCommitOnHead.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-transcript-commit-heal.test.cjs
 */

'use strict';

import { test, expect, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const originalHome = process.env.HOME;
const originalAutofix = process.env.SM_AUTOFIX_DISABLE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-commit-heal-test-'));
process.env.HOME = tmpHome;
process.env.SM_AUTOFIX_DISABLE = '1';

const { registerActiveProject, writeProjectQueue, writeRunLog } = require('./_helpers/schedulerHarness.cjs');
const { ownTranscriptCommitOnHead, reverifyNeedsReview } = require('../scheduler.cjs');
const { resolvePrdWriteDir } = require('../lib/prd/prdLocations.cjs');

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalAutofix === undefined) delete process.env.SM_AUTOFIX_DISABLE;
  else process.env.SM_AUTOFIX_DISABLE = originalAutofix;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function gitIn(dir, args, env) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

/** Repo with a backdated initial commit plus one own commit dated `ownAt`. */
function makeRepo(name, ownAt) {
  const dir = path.join(tmpHome, `proj-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  gitIn(dir, ['init', '-q']);
  gitIn(dir, ['config', 'user.email', 'test@example.com']);
  gitIn(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'session-manager-operations/\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  gitIn(dir, ['add', '-A']);
  const past = new Date(Date.now() - 7200 * 1000).toISOString();
  gitIn(dir, ['commit', '-q', '-m', 'initial'], { GIT_AUTHOR_DATE: past, GIT_COMMITTER_DATE: past });
  fs.writeFileSync(path.join(dir, 'feature.txt'), 'work\n', 'utf8');
  gitIn(dir, ['add', 'feature.txt']);
  const at = ownAt.toISOString();
  gitIn(dir, ['commit', '-q', '-m', 'feat: own work for the prd'], { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
  return { dir, sha: gitIn(dir, ['rev-parse', 'HEAD']) };
}

function commitLog(runId, slug, sha, shape = 'summary') {
  const short = sha.slice(0, 7);
  const oneline = shape === 'oneline';
  const cmd = oneline
    ? 'git add feature.txt && git commit -q -m "feat: own work for the prd" -m "Co-Authored-By: Test <t@t>" && git log --oneline -1'
    : 'git add feature.txt && git commit -m "feat: own work for the prd"';
  const out = oneline ? `${short} feat: own work for the prd` : `[main ${short}] feat: own work for the prd\n 1 file changed`;
  writeRunLog(runId, slug, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: cmd } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: out }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done\nSCHEDULER_VERDICT: PASS' }),
  ]);
  return path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId, `${slug}.log`);
}

const startedAt = new Date(Date.now() - 600 * 1000);
const finishedAt = new Date(Date.now() - 300 * 1000);

test('ownTranscriptCommitOnHead returns the full sha for an in-window ancestor commit', async () => {
  const { dir, sha } = makeRepo('unit-ok', new Date(startedAt.getTime() + 60_000));
  const logPath = commitLog('run-unit-ok', 's-unit-ok', sha);
  expect(await ownTranscriptCommitOnHead({ cwd: dir, logPath, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString() })).toBe(sha);
});

test('ownTranscriptCommitOnHead is null outside the window, for a non-ancestor, and on junk', async () => {
  const { dir, sha } = makeRepo('unit-out', new Date(Date.now() - 3600 * 1000));
  const logPath = commitLog('run-unit-out', 's-unit-out', sha);
  const win = { startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString() };
  expect(await ownTranscriptCommitOnHead({ cwd: dir, logPath, ...win })).toBeNull();

  // A commit on another branch is not an ancestor of HEAD.
  const inWin = makeRepo('unit-anc', new Date(startedAt.getTime() + 60_000));
  gitIn(inWin.dir, ['checkout', '-q', '-b', 'other', 'HEAD~1']);
  const logPath2 = commitLog('run-unit-anc', 's-unit-anc', inWin.sha);
  expect(await ownTranscriptCommitOnHead({ cwd: inWin.dir, logPath: logPath2, ...win })).toBeNull();

  expect(await ownTranscriptCommitOnHead({ cwd: dir, logPath: path.join(tmpHome, 'missing.log'), ...win })).toBeNull();
  expect(await ownTranscriptCommitOnHead({ cwd: path.join(tmpHome, 'not-a-repo'), logPath, ...win })).toBeNull();
  expect(await ownTranscriptCommitOnHead(undefined)).toBeNull();
});

async function reverifyCase(name, ownAt, shape = 'summary') {
  const { dir, sha } = makeRepo(name, ownAt);
  registerActiveProject(dir, `proj-${name}-slug`);
  const slug = `4908-transcript-heal-${name}`;
  const prdDir = resolvePrdWriteDir(dir);
  fs.mkdirSync(prdDir, { recursive: true });
  fs.writeFileSync(path.join(prdDir, `${slug}.md`), `---\ntitle: t\ncwd: ${dir}\n---\n\n# Goal\n\nship it\n`);
  const runId = `run-${name}`;
  commitLog(runId, slug, sha, shape);
  const queuePath = writeProjectQueue(dir, [{
    slug, status: 'needs_review', cwd: dir, runId,
    startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
    exitCode: 0, verifierVerdict: 'pass_no_commit',
  }]);
  await reverifyNeedsReview();
  return { row: JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs.find((j) => j.slug === slug), sha };
}

test('reverifyNeedsReview completes a pass_no_commit row from its own transcript commit', async () => {
  const { row, sha } = await reverifyCase('heal', new Date(startedAt.getTime() + 60_000));
  expect(row.status).toBe('completed');
  expect(row.landedCommit).toBe(sha);
  expect(row.landedCommitSource).toBe('transcript-output');
}, 60_000);

test('reverifyNeedsReview completes a row whose log is the 1458 git log --oneline shape', async () => {
  const { row, sha } = await reverifyCase('oneline', new Date(startedAt.getTime() + 60_000), 'oneline');
  expect(row.status).toBe('completed');
  expect(row.landedCommit).toBe(sha);
  expect(row.landedCommitSource).toBe('transcript-output');
}, 60_000);

test('reverifyNeedsReview leaves the row when the commit is outside the run window', async () => {
  const { row } = await reverifyCase('outside', new Date(Date.now() - 3600 * 1000));
  expect(row.status).toBe('needs_review');
  expect(row.landedCommit).toBeUndefined();
}, 60_000);
