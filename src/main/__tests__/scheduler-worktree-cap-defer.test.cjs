/**
 * scheduler-worktree-cap-defer.test.cjs — PRD 1112: a job that cannot get
 * worktree isolation because the concurrency cap is currently exhausted must
 * be DEFERRED (left 'pending', retried on the next dispatch pass), never
 * spawned in a shared working tree the way every OTHER worktree.ok===false
 * reason (e.g. "not a git repository") still falls back to running in place.
 *
 * Drives spawnJob end-to-end against a real git fixture repo, forcing the
 * cap via SM_JOB_WORKTREE_MAX=1 plus a real occupying worktree (so the cap
 * check itself, not a mock, is what defers the job).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-worktree-cap-defer.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let tmpHome;
let originalHome;
let originalMax;
let spawnJob;
let gitWorktree;

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

// See scheduler-quiet-machine-lease.test.cjs's identical helper: readQueue()'s
// per-project discovery walks ~/.claude/projects/*/*.jsonl transcripts for a
// `cwd` field to find known project queue.json shards.
function registerActiveProject(cwd) {
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  const slugDir = path.join(projectsDir, `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

function writeProjectQueue(cwd, jobs) {
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs }, null, 2));
  return path.join(stateDir, 'queue.json');
}

// Stub `claude` binary: writes a marker file into its OWN process.cwd() so a
// test can prove whether — and where — it was actually spawned, then emits a
// clean stream-json success result.
function writeClaudeStub() {
  const stubPath = path.join(os.tmpdir(), `sm-claude-stub-capdefer-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');
    fs.writeFileSync(path.join(process.cwd(), 'ran-here.marker'), 'yes', 'utf8');
    // Land a real commit + finish-protocol sentinel when possible, so a run
    // that actually reaches the finish protocol lands 'completed' — a
    // best-effort no-op when the cwd isn't a git repo (e.g. the non-git
    // fallback case), where the run parks in needs_review instead, which is
    // fine — this test only cares whether it ran in place, not its verdict.
    try {
      execFileSync('git', ['add', '-A'], { cwd: process.cwd() });
      execFileSync('git', ['commit', '-q', '-m', 'stub commit'], { cwd: process.cwd() });
    } catch { /* not a git repo — best-effort only */ }
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok\\nSCHEDULER_VERDICT: PASS' }) + '\\n');
    process.exit(0);
  `;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return stubPath;
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-worktree-cap-defer-'));
  process.env.HOME = tmpHome;
  originalMax = process.env.SM_JOB_WORKTREE_MAX;
  ({ spawnJob } = require('../scheduler.cjs'));
  gitWorktree = require('../lib/gitWorktree.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalMax === undefined) delete process.env.SM_JOB_WORKTREE_MAX;
  else process.env.SM_JOB_WORKTREE_MAX = originalMax;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
  delete process.env.SM_JOB_WORKTREE_MAX;
  gitWorktree._resetActiveWorktreeCountForTests('job', 0);
});

test('a job held behind the worktree cap stays pending with a heldReason, is never spawned in place, and dispatches once the cap frees up', async () => {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-worktree-cap-defer-project-'));
  initRepo(projectCwd);
  registerActiveProject(projectCwd);

  const slug = `1112-test-held-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Held behind the worktree cap.', 'utf8');
  const queuePath = writeProjectQueue(projectCwd, [{ slug, status: 'pending', cwd: projectCwd }]);

  process.env.SM_JOB_WORKTREE_MAX = '1';
  process.env.SM_CLAUDE_BIN = writeClaudeStub();

  // Occupy the single worktree slot with a REAL checkout, so the cap check
  // spawnJob relies on is exercising the actual gitWorktree plumbing, not a
  // mock.
  const occupier = await gitWorktree.createJobWorktree({ cwd: projectCwd, slug: 'occupier' });
  expect(occupier.ok).toBe(true);

  const runId = `run-${slug}`;
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });

  try {
    await spawnJob({ slug, cwd: projectCwd }, runId, runDir, projectCwd);

    // Held: still pending, never spawned, heldReason visible on the row.
    let jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
    let row = jobs.find((j) => j.slug === slug);
    expect(row.status).toBe('pending');
    expect(row.heldReason).toMatch(/worktree cap reached/);
    expect(fs.existsSync(path.join(projectCwd, 'ran-here.marker'))).toBe(false);
    expect(fs.existsSync(path.join(occupier.dir, 'ran-here.marker'))).toBe(false);

    // Free the cap (mirrors cleanupJobWorktree releasing the counter), then
    // retry — the held job dispatches on this next pass, exactly like a
    // sessionSlots-blocked job retries once a slot frees up.
    await gitWorktree.cleanupJobWorktree({ cwd: projectCwd, dir: occupier.dir, branch: occupier.branch });

    await spawnJob({ slug, cwd: projectCwd }, `${runId}-2`, runDir, projectCwd);

    jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
    row = jobs.find((j) => j.slug === slug);
    expect(row.status).toBe('completed');
    expect(row.heldReason).toBeUndefined();
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}, 30_000);

test('a non-git cwd still falls back to running in place (unchanged behaviour — only cap-reached is a deferral)', async () => {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-worktree-cap-defer-nongit-'));
  fs.mkdirSync(projectCwd, { recursive: true }); // deliberately NOT a git repo
  registerActiveProject(projectCwd);

  const slug = `1112-test-nongit-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Non-git cwd, must run in place.', 'utf8');
  const queuePath = writeProjectQueue(projectCwd, [{ slug, status: 'pending', cwd: projectCwd }]);

  process.env.SM_CLAUDE_BIN = writeClaudeStub();

  const runId = `run-${slug}`;
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });

  try {
    await spawnJob({ slug, cwd: projectCwd }, runId, runDir, projectCwd);

    const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
    const row = jobs.find((j) => j.slug === slug);
    // Not held/deferred — it actually ran (a non-git cwd can't commit, so it
    // parks in needs_review rather than completed; this test only cares that
    // it was dispatched in place, not its exact verdict).
    expect(row.status).not.toBe('pending');
    expect(row.heldReason).toBeUndefined();
    expect(row.worktreeFallbackReason).toMatch(/not a git repository/);
    // Ran IN PLACE — the marker landed directly in projectCwd, not a worktree.
    expect(fs.existsSync(path.join(projectCwd, 'ran-here.marker'))).toBe(true);
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}, 30_000);
