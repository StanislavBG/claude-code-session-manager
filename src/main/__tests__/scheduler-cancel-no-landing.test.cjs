/**
 * scheduler-cancel-no-landing.test.cjs — 2026-10-19 git-viewer incident: a
 * RUNNING job cancelled via remote.cancelJob still had its commit integrated
 * into main by finalizeJobWorktree. A cancelled run keeps its commit on the
 * job branch only.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-cancel-no-landing.test.cjs
 */

'use strict';

import { test, beforeAll, afterAll } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let tmpHome;
let originalHome;
let scheduler;
let jobWorktree;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cancel-no-landing-'));
  process.env.HOME = tmpHome;
  scheduler = require('../scheduler.cjs');
  jobWorktree = require('../lib/git/jobWorktree.cjs');
  const config = require('../config.cjs');
  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${scheduler.PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
  }
  config.addAllowedRoot(path.join(tmpHome, 'repo-cancel'));
  config.addAllowedRoot(path.join(tmpHome, 'repo-control'));
  for (const name of ['repo-cancel', 'repo-control']) {
    const projDir = path.join(tmpHome, '.claude', 'projects', `fake-${name}`);
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'session.jsonl'), `${JSON.stringify({ cwd: path.join(tmpHome, name) })}\n`, 'utf8');
  }
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function setup(name, slug) {
  const cwd = path.join(tmpHome, name);
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 't@example.com');
  git(cwd, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(cwd, 'doomed.txt'), 'x\n');
  fs.writeFileSync(path.join(cwd, 'keep.txt'), 'y\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'init');
  const worktree = await jobWorktree.createJobWorktree({ cwd, slug });
  assert.ok(worktree.ok, JSON.stringify(worktree));
  git(worktree.dir, 'config', 'user.email', 't@example.com');
  git(worktree.dir, 'config', 'user.name', 't');
  git(worktree.dir, 'rm', '-q', 'doomed.txt');
  git(worktree.dir, 'commit', '-q', '-m', 'remove doomed');
  const runDir = path.join(tmpHome, `run-${slug}`);
  fs.mkdirSync(runDir, { recursive: true });
  return { cwd, worktree, runDir, wtSha: git(worktree.dir, 'rev-parse', 'HEAD') };
}

async function runningRow(slug, cwd, runId) {
  // Reconcile drops rows whose PRD file is gone — give the row a real PRD.
  const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'e1', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), `---\ntitle: t\ncwd: ${cwd}\nestimateMinutes: 10\n---\n\n# Goal\n\nx\n`, 'utf8');
  await scheduler.writeQueue({
    jobs: [{ slug, cwd, status: 'running', runId, startedAt: new Date(Date.now() - 60000).toISOString() }],
    config: {},
    paused: null,
  });
}

test('cancelled running job: commit stays on job branch, main untouched', async () => {
  const slug = 'cancel-no-landing-a';
  const { cwd, worktree, runDir, wtSha } = await setup('repo-cancel', slug);
  const mainBefore = git(cwd, 'rev-parse', 'refs/heads/main');
  try {
    await runningRow(slug, cwd, 'run-cancel-1');
    const res = await scheduler.remote.cancelJob(slug, { cwd });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.landed, false);
    assert.equal(res.jobBranch, worktree.branch);
    assert.equal(res.jobBranchSha, wtSha);
    const fin = await scheduler.finalizeJobWorktree({ job: { slug, cwd }, runId: 'run-cancel-1', runDir, worktree, guardCwd: cwd, carriedPaths: [] });
    assert.equal(fin.cancelled, true);
    assert.equal(fin.integratedSha, null);
    assert.equal(git(cwd, 'rev-parse', 'refs/heads/main'), mainBefore);
    assert.ok(fs.existsSync(path.join(cwd, 'doomed.txt')));
    assert.equal(git(cwd, 'rev-parse', `refs/heads/${worktree.branch}`), wtSha);
  } finally {
    await scheduler.writeQueue({ jobs: [], config: {}, paused: null });
  }
});

test('control: non-cancelled running job still fast-forwards main', async () => {
  const slug = 'cancel-no-landing-b';
  const { cwd, worktree, runDir, wtSha } = await setup('repo-control', slug);
  try {
    await runningRow(slug, cwd, 'run-control-1');
    const fin = await scheduler.finalizeJobWorktree({ job: { slug, cwd }, runId: 'run-control-1', runDir, worktree, guardCwd: cwd, carriedPaths: [] });
    assert.equal(fin.cancelled, false);
    assert.equal(git(cwd, 'rev-parse', 'refs/heads/main'), wtSha);
  } finally {
    await scheduler.writeQueue({ jobs: [], config: {}, paused: null });
  }
});

test('cancelling a pending row reports no job-branch keys', async () => {
  const slug = 'cancel-no-landing-c';
  const cwd = path.join(tmpHome, 'repo-cancel');
  try {
    const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'e1', 'prds');
    fs.mkdirSync(prdsDir, { recursive: true });
    fs.writeFileSync(path.join(prdsDir, `${slug}.md`), `---\ntitle: t\ncwd: ${cwd}\nestimateMinutes: 10\n---\n\n# Goal\n\nx\n`, 'utf8');
    await scheduler.writeQueue({ jobs: [{ slug, cwd, status: 'pending' }], config: {}, paused: null });
    const res = await scheduler.remote.cancelJob(slug, { cwd });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal('jobBranchSha' in res, false);
  } finally {
    await scheduler.writeQueue({ jobs: [], config: {}, paused: null });
  }
});

test('cancelled detached run: commit ends on the job branch, off main', async () => {
  const slug = 'cancel-no-landing-d';
  const cwd = path.join(tmpHome, 'repo-cancel');
  const runDir = path.join(tmpHome, `run-${slug}`);
  fs.mkdirSync(runDir, { recursive: true });
  const worktree = await jobWorktree.createJobWorktree({ cwd, slug });
  assert.ok(worktree.ok, JSON.stringify(worktree));
  git(worktree.dir, 'config', 'user.email', 't@example.com');
  git(worktree.dir, 'config', 'user.name', 't');
  git(worktree.dir, 'checkout', '-q', '--detach');
  fs.writeFileSync(path.join(worktree.dir, 'detached.txt'), 'd\n');
  git(worktree.dir, 'add', '-A');
  git(worktree.dir, 'commit', '-q', '-m', 'detached work');
  const sha = git(worktree.dir, 'rev-parse', 'HEAD');
  const mainBefore = git(cwd, 'rev-parse', 'refs/heads/main');
  try {
    await runningRow(slug, cwd, 'run-cancel-d');
    await scheduler.remote.cancelJob(slug, { cwd });
    const fin = await scheduler.finalizeJobWorktree({ job: { slug, cwd }, runId: 'run-cancel-d', runDir, worktree, guardCwd: cwd, carriedPaths: [] });
    assert.equal(fin.cancelled, true);
    assert.equal(fin.worktreeHead.action, 'fast-forwarded');
    assert.equal(git(cwd, 'rev-parse', `refs/heads/${worktree.branch}`), sha);
    assert.equal(git(cwd, 'rev-parse', 'refs/heads/main'), mainBefore);
  } finally {
    await scheduler.writeQueue({ jobs: [], config: {}, paused: null });
  }
});
