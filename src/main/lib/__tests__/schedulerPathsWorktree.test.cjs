/**
 * schedulerPathsWorktree.test.cjs — SM_WORKTREE_ROOT moves the job + epic
 * worktree roots (and isEphemeralCwd) as a unit; the real os.tmpdir() roots are
 * never touched.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerPathsWorktree.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gitWorktree = require('../gitWorktree.cjs');
const schedulerPaths = require('../schedulerPaths.cjs');
const { isEphemeralCwd } = require('../ephemeralCwd.cjs');

let scratch;
let override;
let repo;
let prevRoot;
let prevDisable;

function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }
// Probe checkouts (keys starting wtroot-probe) found anywhere under a root. Other
// suites in the same worker pool share the real root, so a whole-listing
// comparison would be flaky; the probe key is unique to this file.
function probesUnder(root) {
  const found = [];
  let hashes = [];
  try { hashes = fs.readdirSync(root); } catch { return found; }
  for (const h of hashes) {
    try {
      for (const k of fs.readdirSync(path.join(root, h))) if (k.startsWith('wtroot-probe')) found.push(`${h}/${k}`);
    } catch { /* not a dir */ }
  }
  return found;
}

beforeEach(() => {
  prevRoot = process.env.SM_WORKTREE_ROOT;
  prevDisable = process.env.SM_JOB_WORKTREE_DISABLE;
  delete process.env.SM_JOB_WORKTREE_DISABLE;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-wtroot-test-'));
  override = path.join(scratch, 'override');
  repo = path.join(scratch, 'repo');
  fs.mkdirSync(override, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'T'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  process.env.SM_WORKTREE_ROOT = override;
});

afterEach(() => {
  if (prevRoot === undefined) delete process.env.SM_WORKTREE_ROOT; else process.env.SM_WORKTREE_ROOT = prevRoot;
  if (prevDisable === undefined) delete process.env.SM_JOB_WORKTREE_DISABLE; else process.env.SM_JOB_WORKTREE_DISABLE = prevDisable;
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('resolver and KIND_CONFIG roots follow SM_WORKTREE_ROOT together', () => {
  expect(schedulerPaths.worktreeRoot('job')).toBe(path.join(override, 'session-manager-job-worktrees'));
  expect(schedulerPaths.worktreeRoot('epic')).toBe(path.join(override, 'session-manager-epic-worktrees'));
  expect(gitWorktree.KIND_CONFIG.job.root).toBe(schedulerPaths.worktreeRoot('job'));
  expect(gitWorktree.KIND_CONFIG.epic.root).toBe(schedulerPaths.worktreeRoot('epic'));
});

test('unset SM_WORKTREE_ROOT resolves the persistent per-user dir (0700, created), never os.tmpdir()', () => {
  const state = path.join(scratch, 'state');
  const prevXdg = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  delete process.env.SM_WORKTREE_ROOT;
  try {
    // scratch lives under os.tmpdir(), so the state dir passes the (unchanged) guard as a tmp child.
    const base = schedulerPaths.worktreeBase();
    expect(base).toBe(path.join(state, 'session-manager'));
    expect(base).not.toBe(os.tmpdir());
    expect(fs.statSync(base).mode & 0o777).toBe(0o700);
    expect(schedulerPaths.worktreeRoot('epic')).toBe(path.join(base, 'session-manager-epic-worktrees'));
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevXdg;
  }
});

test('the vitest guard still throws for a live default (no SM_WORKTREE_ROOT, real ~/.local/state) and creates nothing', () => {
  const prevXdg = process.env.XDG_STATE_HOME;
  delete process.env.XDG_STATE_HOME;
  delete process.env.SM_WORKTREE_ROOT;
  const prevHome = process.env.HOME;
  const fakeHome = path.join(scratch, 'nohome');
  process.env.HOME = '/nonexistent-live-home-for-guard-test';
  try {
    expect(() => schedulerPaths.worktreeBase()).toThrow(/live root/);
    expect(fs.existsSync(path.join(fakeHome, '.local'))).toBe(false);
  } finally {
    process.env.HOME = prevHome;
    if (prevXdg !== undefined) process.env.XDG_STATE_HOME = prevXdg;
  }
});

test('SM_WORKTREE_ROOT set wins over the persistent default', () => {
  process.env.XDG_STATE_HOME = path.join(scratch, 'ignored');
  try {
    expect(schedulerPaths.worktreeBase()).toBe(override);
    expect(fs.existsSync(path.join(scratch, 'ignored'))).toBe(false);
  } finally { delete process.env.XDG_STATE_HOME; }
});

test('create / sweep / isEphemeralCwd operate under the override, never the real root', async () => {
  const realJobRoot = path.join(os.tmpdir(), 'session-manager-job-worktrees');
  expect(probesUnder(realJobRoot)).toEqual([]);

  const res = await gitWorktree.createJobWorktree({ cwd: repo, slug: 'wtroot-probe' });
  expect(res.ok).toBe(true);
  expect(res.dir.startsWith(path.join(override, 'session-manager-job-worktrees') + path.sep)).toBe(true);
  expect(isEphemeralCwd(res.dir)).toBe(true);

  const sweep = await gitWorktree.sweepStaleWorktreeCheckouts('job', { staleAgeMs: 0, holders: new Set() });
  expect(sweep.checkoutsRemoved).toBeGreaterThanOrEqual(1);
  expect(fs.existsSync(res.dir)).toBe(false);

  const again = await gitWorktree.createJobWorktree({ cwd: repo, slug: 'wtroot-probe-2' });
  expect(again.ok).toBe(true);
  await gitWorktree.cleanupJobWorktree({ cwd: repo, dir: again.dir, branch: again.branch });
  expect(fs.existsSync(override)).toBe(true); // the guard never rmdir's the base

  expect(probesUnder(realJobRoot)).toEqual([]);
});
