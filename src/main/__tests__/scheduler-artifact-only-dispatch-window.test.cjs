/**
 * scheduler-artifact-only-dispatch-window.test.cjs — spawnJob must verify with
 * the START stamped by the dispatch mutate, not tickQueue's pre-dispatch
 * snapshot (startedAt null), or artifactsCheck fails on a NaN window and every
 * `deliverable: artifact` PRD lands in needs_review. Goes through the real
 * spawnJob -> verifyRun seam.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-artifact-only-dispatch-window.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');
const { execFileSync } = require('node:child_process');

const MARKER = 'ARTIFACT-WINDOW-MARKER-7f3a9c';
let tmpHome;
let originalHome;
let originalDisable;
let spawnJob;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'out/\nsession-manager-operations/\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
}

function registerActiveProject(cwd) {
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

function writeProjectQueue(cwd, jobs) {
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs }, null, 2));
  return path.join(stateDir, 'queue.json');
}

// mode: 'ok' | 'none' | 'empty' | 'old'
function writeStub(mode) {
  return claudeStub.writeClaudeStub({ body: `
    const fs = require('fs');
    const path = require('path');
    const mode = ${JSON.stringify(mode)};
    if (readPrompt().includes(${JSON.stringify(MARKER)}) && mode !== 'none') {
      const dir = path.join(process.cwd(), 'out');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, 'report.html');
      fs.writeFileSync(f, mode === 'empty' ? '' : '<html>report</html>\\n', 'utf8');
      if (mode === 'old') {
        const t = new Date(Date.now() - 2 * 3600 * 1000);
        fs.utimesSync(f, t, t);
      }
    }
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done\\nSCHEDULER_VERDICT: PASS' }) + '\\n');
    process.exit(0);
  ` });
}

async function runCase(mode) {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-artwin-project-'));
  initRepo(projectCwd);
  registerActiveProject(projectCwd);
  const slug = `2598-artwin-${mode}-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(
    path.join(prdsDir, `${slug}.md`),
    `---\ntitle: artifact window\ndeliverable: artifact\nartifactPaths: [out/report.html]\n---\n\n# Goal\n\n${MARKER}\n`,
    'utf8',
  );
  const queuePath = writeProjectQueue(projectCwd, [{ slug, status: 'pending', cwd: projectCwd }]);
  process.env.SM_CLAUDE_BIN = writeStub(mode);
  const runId = `run-${slug}`;
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  try {
    await spawnJob({ slug, cwd: projectCwd }, runId, runDir, projectCwd);
    // A completed row is archived out of queue.json into history.jsonl by the
    // reconcile pass that runs at finalize — read whichever holds it.
    let row = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs.find((j) => j.slug === slug);
    if (!row) {
      const hist = path.join(path.dirname(queuePath), 'history.jsonl');
      row = fs.readFileSync(hist, 'utf8').split('\n').filter(Boolean)
        .map((l) => JSON.parse(l)).reverse().find((j) => j.slug === slug);
    }
    const investigationLogExists = fs.existsSync(path.join(runDir, `${slug}.investigation.log`));
    return { row, investigationLogExists };
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-artwin-'));
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

test('artifact written in the run window completes', async () => {
  const { row, investigationLogExists } = await runCase('ok');
  expect(row.status).toBe('completed');
  expect(row.verifierVerdict).toBe('pass_no_commit_artifact_verified');
  expect(hasNeedsReview(row)).toBe(false);
  expect(investigationLogExists).toBe(false);
}, 60_000);

for (const [mode, label] of [
  ['none', 'artifact never written'],
  ['empty', 'artifact written with 0 bytes'],
  ['old', 'artifact non-empty but mtime 2 hours before the run'],
]) {
  test(`${label} is not completed`, async () => {
    const { row } = await runCase(mode);
    expect(row.status).not.toBe('completed');
    expect(row.verifierVerdict).not.toBe('pass_no_commit_artifact_verified');
    expect(hasNeedsReview(row)).toBe(true);
  }, 60_000);
}
