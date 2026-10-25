/**
 * scheduler-deferral-worktree-cleanup.test.cjs — spawnJob creates the job
 * worktree BEFORE the launch gate and the sidecar-reconcile skip. Both early
 * returns must remove it (and release its cap count) instead of leaking it.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-deferral-worktree-cleanup.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');

let tmpHome;
let originalHome;
let spawnJob;
let jobWorktree;
let queueStore;
let schedulerPaths;

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
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

function mkProject(slug) {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-deferral-cleanup-'));
  initRepo(projectCwd);
  registerActiveProject(projectCwd);
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Deferred before launch.', 'utf8');
  const stateDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs: [{ slug, status: 'pending', cwd: projectCwd, agentType: 'dev-lead' }] }, null, 2));
  return projectCwd;
}

// Any directory under the job-worktree root whose name carries the slug.
function worktreeDirsFor(slug) {
  const out = [];
  const root = jobWorktree.WORKTREE_ROOT;
  if (!fs.existsSync(root)) return out;
  for (const h of fs.readdirSync(root)) {
    const sub = path.join(root, h);
    let names = [];
    try { names = fs.readdirSync(sub); } catch { continue; }
    for (const n of names) if (n.includes(slug)) out.push(path.join(sub, n));
  }
  return out;
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-deferral-cleanup-home-'));
  process.env.HOME = tmpHome;
  ({ spawnJob } = require('../scheduler.cjs'));
  jobWorktree = require('../lib/git/jobWorktree.cjs');
  queueStore = require('../lib/scheduler/queueStore.cjs');
  schedulerPaths = require('../lib/scheduler/schedulerPaths.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
  jobWorktree._resetActiveWorktreeCountForTests?.(0);
});

function runDirFor(runId) {
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

test('a dispatch held by a launch block removes its preflight worktree and releases the cap count', async () => {
  const slug = `2247-test-blocked-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const projectCwd = mkProject(slug);
  process.env.SM_CLAUDE_BIN = claudeStub.writeClaudeStub({ allowCommitUnder: os.tmpdir(), body: 'process.exit(0);' });

  const machinePath = queueStore.MACHINE_STATE_PATH;
  fs.mkdirSync(path.dirname(machinePath), { recursive: true });
  let machine = {};
  try { machine = JSON.parse(fs.readFileSync(machinePath, 'utf8')); } catch { /* none yet */ }
  machine.launchBlocks = {
    'dev-lead': { kind: 'auth_failed', attempts: 1, hint: 'run claude login', until: null, firstAt: new Date().toISOString(), lastAt: new Date().toISOString() },
  };
  fs.writeFileSync(machinePath, JSON.stringify(machine));

  const runId = `run-${slug}`;
  const runDir = runDirFor(runId);
  const before = jobWorktree._getActiveWorktreeCountForTests();
  try {
    await spawnJob({ slug, cwd: projectCwd, agentType: 'dev-lead' }, runId, runDir, projectCwd);

    const rows = JSON.parse(fs.readFileSync(path.join(projectCwd, 'session-manager-operations', 'scheduler', 'state', 'queue.json'), 'utf8')).jobs;
    const row = rows.find((j) => j.slug === slug);
    expect(row.status).toBe('pending');
    expect(row.heldReason).toMatch(/launch blocked/);
    expect(worktreeDirsFor(slug)).toEqual([]);
    expect(jobWorktree._getActiveWorktreeCountForTests()).toBe(before);
  } finally {
    machine = JSON.parse(fs.readFileSync(machinePath, 'utf8'));
    delete machine.launchBlocks;
    fs.writeFileSync(machinePath, JSON.stringify(machine));
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}, 30_000);

test('a dispatch skipped as sidecar-reconciled removes its preflight worktree and releases the cap count', async () => {
  const slug = `2247-test-reconciled-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const projectCwd = mkProject(slug);
  process.env.SM_CLAUDE_BIN = claudeStub.writeClaudeStub({ allowCommitUnder: os.tmpdir(), body: 'process.exit(0);' });

  // A prior completed run's sidecars for this slug.
  const priorRunId = '2026-01-01T00-00-00-000Z';
  const priorDir = path.join(schedulerPaths.runsDir(), priorRunId);
  fs.mkdirSync(priorDir, { recursive: true });
  fs.writeFileSync(path.join(priorDir, `${slug}.meta.json`), JSON.stringify({ exitCode: 0, finishedAt: Date.now() }));
  fs.writeFileSync(path.join(priorDir, `${slug}.verdicts.json`), JSON.stringify({ verdict: 'clean' }));

  const runId = `run-${slug}`;
  const runDir = runDirFor(runId);
  const before = jobWorktree._getActiveWorktreeCountForTests();
  try {
    await spawnJob({ slug, cwd: projectCwd, agentType: 'dev-lead' }, runId, runDir, projectCwd);

    expect(fs.existsSync(path.join(projectCwd, 'ran-here.marker'))).toBe(false);
    expect(worktreeDirsFor(slug)).toEqual([]);
    expect(jobWorktree._getActiveWorktreeCountForTests()).toBe(before);
  } finally {
    fs.rmSync(priorDir, { recursive: true, force: true });
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}, 30_000);
