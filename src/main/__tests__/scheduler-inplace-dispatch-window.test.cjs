/**
 * scheduler-inplace-dispatch-window.test.cjs — spawnJob's post-dispatch reads
 * (computeCommittedDuringRun, in-place siblingOverlap myStart,
 * resolveLandedCommitEvidence) must use the dispatch-stamped start, not the
 * pre-dispatch job.startedAt (null). With null, myStart is 0 and any same-cwd
 * row that ever ran counts as an overlapping sibling.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-inplace-dispatch-window.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');
const { execFileSync } = require('node:child_process');

const MARKER = 'INPLACE-WINDOW-MARKER-5b2e81';
let tmpHome;
let originalHome;
let originalDisable;
let spawnJob;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'session-manager-operations/\n', 'utf8');
  git(['add', '-A'], dir);
  // Backdate: a same-second fixture commit would fall inside the run window.
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: past, GIT_COMMITTER_DATE: past } });
}

function registerActiveProject(cwd) {
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

function writeStub(projectCwd) {
  return claudeStub.writeClaudeStub({ allowCommitUnder: projectCwd, body: `
    const fs = require('fs');
    const path = require('path');
    if (readPrompt().includes(${JSON.stringify(MARKER)})) {
      fs.writeFileSync(path.join(process.cwd(), 'README.md'), 'changed by run\\n', 'utf8');
      runGit(['add', 'README.md']);
      runGit(['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'run work']);
    }
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done\\nSCHEDULER_VERDICT: PASS' }) + '\\n');
    process.exit(0);
  ` });
}

async function runCase(siblingStatus) {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-inplwin-project-'));
  initRepo(projectCwd);
  registerActiveProject(projectCwd);
  const slug = `2599-inplwin-${siblingStatus}-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(
    path.join(prdsDir, `${slug}.md`),
    `---\ntitle: inplace window\n---\n\n# Goal\n\n${MARKER}\n`,
    'utf8',
  );
  const past = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const sibling = siblingStatus === 'running'
    ? { slug: `${slug}-sibling`, status: 'running', cwd: projectCwd, startedAt: past }
    : { slug: `${slug}-sibling`, status: 'completed', cwd: projectCwd, startedAt: past, finishedAt: past };
  fs.writeFileSync(
    path.join(prdsDir, `${slug}-sibling.md`),
    '---\ntitle: sibling\n---\n\n# Goal\n\nsibling\n',
    'utf8',
  );
  const stateDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const queuePath = path.join(stateDir, 'queue.json');
  fs.writeFileSync(queuePath, JSON.stringify({ jobs: [{ slug, status: 'pending', cwd: projectCwd }, sibling] }, null, 2));
  process.env.SM_CLAUDE_BIN = writeStub(projectCwd);
  const runId = `run-${slug}`;
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  try {
    await spawnJob({ slug, cwd: projectCwd }, runId, runDir, projectCwd);
    const newHead = git(['rev-parse', 'HEAD'], projectCwd);
    let row = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs.find((j) => j.slug === slug);
    if (!row) {
      const hist = path.join(stateDir, 'history.jsonl');
      row = fs.readFileSync(hist, 'utf8').split('\n').filter(Boolean)
        .map((l) => JSON.parse(l)).reverse().find((j) => j.slug === slug);
    }
    return { row, newHead };
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-inplwin-'));
  process.env.HOME = tmpHome;
  originalDisable = process.env.SM_JOB_WORKTREE_DISABLE;
  process.env.SM_JOB_WORKTREE_DISABLE = '1';
  ({ spawnJob } = require('../scheduler.cjs'));
});

afterAll(() => {
  claudeStub.reapClaudeStubs();
  process.env.HOME = originalHome;
  if (originalDisable === undefined) delete process.env.SM_JOB_WORKTREE_DISABLE;
  else process.env.SM_JOB_WORKTREE_DISABLE = originalDisable;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
});

const hasNeedsReview = (row) => (row.statusHistory || []).some((h) => (h.status ?? h.to ?? h) === 'needs_review');

test('a sibling that finished before this dispatch does not block credit', async () => {
  const { row, newHead } = await runCase('completed');
  expect(row.status).toBe('completed');
  expect(row.landedCommit).toBe(newHead);
}, 60_000);

test('an overlapping sibling still requires transcript proof', async () => {
  const { row, newHead } = await runCase('running');
  expect(row.landedCommit).not.toBe(newHead);
  expect(hasNeedsReview(row)).toBe(true);
}, 60_000);
