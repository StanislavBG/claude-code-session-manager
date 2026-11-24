/**
 * scheduler-artifact-only-worktree-teardown.test.cjs — a declared artifact-only
 * PRD whose git-ignored artifact lives only in its job WORKTREE must complete on
 * its PASS: spawnJob captures artifact evidence (captureArtifactEvidence) before
 * finalizeJobWorktree deletes the worktree and hands it to verifyRun. An
 * undeclared no-commit PASS must still park needs_review. Real spawnJob, job
 * worktrees ENABLED (SM_JOB_WORKTREE_DISABLE unset).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-artifact-only-worktree-teardown.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');
const { execFileSync } = require('node:child_process');

const MARKER = 'ARTIFACT-WORKTREE-TEARDOWN-MARKER-4292';
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
  // Backdate: a same-second fixture commit would fall inside the run window.
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: past, GIT_COMMITTER_DATE: past } });
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

// Writes out/report.txt in its OWN cwd and records that cwd outside the repo.
function writeStub(cwdRecordPath) {
  return claudeStub.writeClaudeStub({ body: `
    const fs = require('fs');
    const path = require('path');
    if (readPrompt().includes(${JSON.stringify(MARKER)})) {
      fs.writeFileSync(${JSON.stringify(cwdRecordPath)}, process.cwd(), 'utf8');
      const dir = path.join(process.cwd(), 'out');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'report.txt'), 'report\\n', 'utf8');
    }
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done\\nSCHEDULER_VERDICT: PASS' }) + '\\n');
    process.exit(0);
  ` });
}

async function runCase(declared) {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-artwt-project-'));
  initRepo(projectCwd);
  registerActiveProject(projectCwd);
  const slug = `4292-artwt-${declared ? 'decl' : 'undecl'}-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  const fm = declared
    ? '---\ntitle: t\ndeliverable: artifact\nartifactPaths: [out/report.txt]\n---'
    : '---\ntitle: t\n---';
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), `${fm}\n\n# Goal\n\n${MARKER}\n`, 'utf8');
  const queuePath = writeProjectQueue(projectCwd, [{ slug, status: 'pending', cwd: projectCwd }]);
  const cwdRecordPath = path.join(tmpHome, `cwd-${slug}.txt`);
  process.env.SM_CLAUDE_BIN = writeStub(cwdRecordPath);
  const runId = `run-${slug}`;
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  try {
    await spawnJob({ slug, cwd: projectCwd }, runId, runDir, projectCwd);
    let row = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs.find((j) => j.slug === slug);
    if (!row) {
      const hist = path.join(path.dirname(queuePath), 'history.jsonl');
      row = fs.readFileSync(hist, 'utf8').split('\n').filter(Boolean)
        .map((l) => JSON.parse(l)).reverse().find((j) => j.slug === slug);
    }
    const investigationLogExists = fs.existsSync(path.join(runDir, `${slug}.investigation.log`));
    const jobCwd = fs.existsSync(cwdRecordPath) ? fs.readFileSync(cwdRecordPath, 'utf8') : null;
    const jobCwdExists = jobCwd ? fs.existsSync(jobCwd) : null;
    return { row, runId, investigationLogExists, projectCwd: fs.realpathSync(projectCwd), jobCwd, jobCwdExists };
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

function expectRanInWorktree({ projectCwd, jobCwd, jobCwdExists }) {
  expect(jobCwd).toBeTruthy();
  expect(jobCwd).not.toBe(projectCwd);
  expect(path.resolve(jobCwd).startsWith(projectCwd + path.sep)).toBe(false);
  expect(jobCwdExists).toBe(false);
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-artwt-'));
  process.env.HOME = tmpHome;
  originalDisable = process.env.SM_JOB_WORKTREE_DISABLE;
  delete process.env.SM_JOB_WORKTREE_DISABLE;
  ({ spawnJob } = require('../scheduler.cjs'));
});

afterAll(() => {
  claudeStub.reapClaudeStubs();
  process.env.HOME = originalHome;
  if (originalDisable !== undefined) process.env.SM_JOB_WORKTREE_DISABLE = originalDisable;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
});

const hasNeedsReview = (row) => (row.statusHistory || []).some((h) => (h.status ?? h.to ?? h) === 'needs_review');

test('(a) declared artifact-only PASS with the artifact only in the worktree completes', async () => {
  const r = await runCase(true);
  expectRanInWorktree(r);
  expect(r.row.status).toBe('completed');
  expect(r.row.verifierVerdict).toBe('pass_no_commit_artifact_verified');
  expect(hasNeedsReview(r.row)).toBe(false);
  expect(r.investigationLogExists).toBe(false);
  expect(r.row.artifactEvidence?.ok).toBe(true);
  expect(r.row.artifactEvidence?.runId).toBe(r.runId);
}, 90_000);

test('(b) undeclared no-commit PASS in a worktree still parks needs_review', async () => {
  const r = await runCase(false);
  expectRanInWorktree(r);
  expect(hasNeedsReview(r.row)).toBe(true);
  expect(r.row.verifierVerdict).not.toBe('pass_no_commit_artifact_verified');
  expect(r.row.artifactEvidence).toBeUndefined();
}, 90_000);

test('(c) dispatch clears a stale artifactEvidence from another run before the job runs', async () => {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-artwt-project-'));
  initRepo(projectCwd);
  registerActiveProject(projectCwd);
  const slug = `4379-artwt-stale-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`),
    `---\ntitle: t\ndeliverable: artifact\nartifactPaths: [out/report.txt]\n---\n\n# Goal\n\n${MARKER}\n`, 'utf8');
  const queuePath = writeProjectQueue(projectCwd, [{
    slug,
    status: 'pending',
    cwd: projectCwd,
    artifactEvidence: { runId: 'old-run', ok: true, verified: [], paths: ['out/report.txt'], capturedAt: new Date().toISOString() },
  }]);
  const recordPath = path.join(tmpHome, `evidence-${slug}.json`);
  process.env.SM_CLAUDE_BIN = claudeStub.writeClaudeStub({ body: `
    const fs = require('fs');
    const q = JSON.parse(fs.readFileSync(${JSON.stringify(queuePath)}, 'utf8'));
    const row = (q.jobs || []).find((j) => j.slug === ${JSON.stringify(slug)});
    fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ found: !!row, status: row && row.status, hasEvidence: !!(row && row.artifactEvidence) }), 'utf8');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done\\nSCHEDULER_VERDICT: PASS' }) + '\\n');
    process.exit(0);
  ` });
  const runId = `run-${slug}`;
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  try {
    await spawnJob({ slug, cwd: projectCwd }, runId, runDir, projectCwd);
    const seen = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    expect(seen.found).toBe(true);
    expect(seen.status).toBe('running');
    expect(seen.hasEvidence).toBe(false);
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}, 90_000);
